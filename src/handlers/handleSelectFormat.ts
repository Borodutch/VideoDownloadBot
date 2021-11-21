import { InputFile } from 'grammy'
import { ShortFormatModel } from '@/models/ShortFormat'
import { ShortUrlModel } from '@/models/ShortUrl'
import {
  deleteDownloadJob,
  findOrCreateDownloadJob,
} from '@/models/DownloadJob'
import { findOrCreateUrl, findUrl } from '@/models/Url'
import Context from '@/models/Context'
import bot from '@/helpers/bot'
import report from '@/helpers/report'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const youtubedl = require('youtube-dl-exec')

export default async function handleSelectFormat(ctx: Context) {
  // Let users know not to panic after a minute of downloading
  const stillDownloadingTimeout = setTimeout(
    () => ctx.editMessageText(ctx.i18n.t('still_downloading')),
    1000 * 60 // 1 minute
  )
  let formatId: string
  let url: string
  let created = false
  let errorEncountered = false
  try {
    // Answer the query to remove the waiting ui on Telegram
    await ctx.answerCallbackQuery()
    // Make user know that the file is being downloaded
    await ctx.editMessageText(ctx.i18n.t('downloading'))
    const data = ctx.callbackQuery.data.split('~')
    const shortFormat = await ShortFormatModel.findOne({
      shortId: data[0],
    })
    formatId = shortFormat.formatId
    const formatName = shortFormat.formatName
    url = (await ShortUrlModel.findOne({ shortId: data[1] })).url
    // Create caption
    const caption = ctx.i18n.t('video_caption', {
      bot: bot.botInfo.username,
    })
    // Find url in cache, if it exists, send it instead
    const cachedUrl = await findUrl(url, formatId)
    if (cachedUrl) {
      await ctx.editMessageText(ctx.i18n.t('download_complete'))
      const config = {
        reply_to_message_id: ctx.callbackQuery.message.message_id,
        caption,
        parse_mode: 'HTML' as const,
      }
      return formatName.includes('audio')
        ? ctx.replyWithAudio(cachedUrl.fileId, config)
        : ctx.replyWithVideo(cachedUrl.fileId, config)
    }
    const findOrCreateResult = await findOrCreateDownloadJob(
      ctx.dbchat.telegramId,
      ctx.callbackQuery.message.message_id,
      url,
      formatId
    )
    created = findOrCreateResult.created
    const downloadJob = findOrCreateResult.doc
    if (!created) {
      if (downloadJob.messageId === ctx.callbackQuery.message.message_id) {
        return
      }
      return ctx.editMessageText(ctx.i18n.t('error_already_in_progress'))
    }
    // Get the video info again
    const videoInfo = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificate: true,
      youtubeSkipDashManifest: true,
      skipDownload: true,
      format: formatId,
    })
    const chosenFormat = videoInfo.formats.find(
      (format) => format.format_id === formatId
    )
    if (!chosenFormat) {
      throw new Error(`Chosen format ${formatId} does not exist at url ${url}`)
    }
    const inputFile = new InputFile({ url: chosenFormat.url })
    const config = {
      reply_to_message_id: ctx.callbackQuery.message.message_id,
      caption,
      parse_mode: 'HTML' as const,
    }
    const sentMessage = formatName.includes('audio')
      ? await ctx.replyWithAudio(inputFile, config)
      : await ctx.replyWithVideo(inputFile, config)
    const fileId =
      ('video' in sentMessage && sentMessage.video.file_id) ||
      ('audio' in sentMessage && sentMessage.audio?.file_id)
    // Cache the url and file id
    await findOrCreateUrl(url, fileId, formatId, formatName)
    // Edit the "downloading" message
    await ctx.editMessageText(ctx.i18n.t('download_complete'))
  } catch (error) {
    errorEncountered = true
    // Report the error to the admin
    report(error, {
      ctx,
      location: 'handleSelectFormat',
      meta: JSON.stringify({
        formatId,
        url,
        created,
        errorEncountered,
      }),
    })
    try {
      // Report the error to the user
      await ctx.editMessageText(ctx.i18n.t('error'))
      await ctx.reply(ctx.i18n.t('error_message'), {
        reply_to_message_id: ctx.callbackQuery.message.message_id,
      })
    } catch (error) {
      report(error, {
        ctx,
        location: 'showing error to user at handleSelectFormat',
      })
    }
  } finally {
    // No need to change the message so that user wouldn't panic anymore
    clearTimeout(stillDownloadingTimeout)
    // Remove the download job
    if ((created || errorEncountered) && url && formatId) {
      await deleteDownloadJob(ctx.dbchat.telegramId, url, formatId)
    }
  }
}
