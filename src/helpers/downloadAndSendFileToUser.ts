import { InputFile } from 'grammy'
import { deleteDownloadJob } from '@/models/DownloadJob'
import { findOrCreateUrl } from '@/models/Url'
import Context from '@/models/Context'
import bot from '@/helpers/bot'
import checkDownloadJobAndSendError from '@/helpers/checkDownloadJobAndSendError'
import checkForCachedUrlAndSendFile from '@/helpers/checkForCachedUrlAndSendFile'
import getCaption from '@/helpers/getCaption'
import getDownloadUrl from '@/helpers/getDownloadUrl'
import report from '@/helpers/report'

async function checkCacheAndDownloadJob(
  url: string,
  formatId: string,
  formatName: string,
  ctx: Context,
  messageId: number,
  caption: string
) {
  // Check cache
  const cached = await checkForCachedUrlAndSendFile(
    url,
    formatId,
    formatName,
    ctx,
    messageId,
    caption
  )
  if (cached) {
    return true
  }
  // Check if already downloading
  const created = await checkDownloadJobAndSendError(
    ctx,
    messageId,
    url,
    formatId
  )
  return !created
}

export default async function downloadAndSendFileToUser({
  ctx,
  url,
  messageId,
  formatId,
  formatName,
}: {
  ctx: Context
  url: string
  messageId: number
  formatId?: string
  formatName?: string
}) {
  // Let users know not to panic after a minute of downloading
  const stillDownloadingTimeout = setTimeout(
    () =>
      bot.api.editMessageText(
        ctx.dbchat.telegramId,
        messageId,
        ctx.i18n.t('still_downloading')
      ),
    1000 * 60 // 1 minute
  )
  let needsToDeleteDownloadJob = true
  let errorEncountered = false
  try {
    // Create caption
    const caption = getCaption(ctx)
    // In case format id is known, check for cache and download job
    if (formatId) {
      const needsToReturn = await checkCacheAndDownloadJob(
        url,
        formatId,
        formatName,
        ctx,
        messageId,
        caption
      )
      if (needsToReturn) {
        needsToDeleteDownloadJob = false
        return
      }
    }
    // Get the video info
    const downloadInfo = await getDownloadUrl(url, ctx, formatId)
    if (!formatId) {
      // Set default values
      formatId = downloadInfo.formatId
      formatName = downloadInfo.formatName
      // Check cache and running download job with the default values
      const needsToReturn = await checkCacheAndDownloadJob(
        url,
        formatId,
        formatName,
        ctx,
        messageId,
        caption
      )
      if (needsToReturn) {
        needsToDeleteDownloadJob = false
        return
      }
    }
    const inputFile = new InputFile({ url: downloadInfo.downloadUrl })
    const config = {
      reply_to_message_id: messageId,
      caption,
      parse_mode: 'HTML' as const,
    }
    const sentMessage = formatName.includes('audio')
      ? await bot.api.sendAudio(ctx.dbchat.telegramId, inputFile, config)
      : await bot.api.sendVideo(ctx.dbchat.telegramId, inputFile, config)
    const fileId =
      ('video' in sentMessage && sentMessage.video.file_id) ||
      ('audio' in sentMessage && sentMessage.audio?.file_id)
    // Cache the url and file id
    await findOrCreateUrl(url, fileId, formatId, formatName)
    // Edit the "downloading" message
    await bot.api.editMessageText(
      ctx.dbchat.telegramId,
      messageId,
      ctx.i18n.t('download_complete')
    )
  } catch (error) {
    errorEncountered = true
    // Report the error to the admin
    report(error, {
      ctx,
      location: 'downloadAndSendFileToUser',
      meta: JSON.stringify({
        formatId,
        url,
        needsToDeleteDownloadJob,
        errorEncountered,
      }),
    })
    try {
      // Report the error to the user
      await bot.api.editMessageText(
        ctx.dbchat.telegramId,
        messageId,
        ctx.i18n.t('error')
      )
      await ctx.reply(ctx.i18n.t('error_message'), {
        reply_to_message_id: messageId,
      })
    } catch (error) {
      report(error, {
        ctx,
        location: 'showing error to user at downloadAndSendFileToUser',
      })
    }
  } finally {
    // No need to change the message so that user wouldn't panic anymore
    clearTimeout(stillDownloadingTimeout)
    // Remove the download job
    if ((needsToDeleteDownloadJob || errorEncountered) && url && formatId) {
      await deleteDownloadJob(ctx.dbchat.telegramId, url, formatId)
    }
  }
}
