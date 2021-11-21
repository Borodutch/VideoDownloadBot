import { I18nContext, TemplateData } from '@grammyjs/i18n/dist/source'
import { InputFile } from 'grammy'
import {
  deleteDownloadJob,
  findOrCreateDownloadJob,
} from '@/models/DownloadJob'
import { findOrCreateUrl, findUrl } from '@/models/Url'
import Context from '@/models/Context'
import bot from '@/helpers/bot'
import i18n from '@/helpers/i18n'
import report from '@/helpers/report'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const youtubedl = require('youtube-dl-exec')

function t(
  resourceKey: string,
  templateData?: TemplateData,
  i18nContext?: I18nContext,
  language?: string
) {
  if (i18nContext) {
    return i18nContext.t(resourceKey, templateData)
  }
  return i18n.t(language, resourceKey, templateData)
}

export default async function downloadAndSendFileToUser({
  i18nContext,
  language,
  url,
  formatId,
  chatId,
  messageId,
  formatName,
  ctx,
}: {
  i18nContext?: I18nContext
  language?: string
  url: string
  formatId: string
  chatId: number
  messageId: number
  formatName: string
  ctx?: Context
}) {
  // Let users know not to panic after a minute of downloading
  const stillDownloadingTimeout = setTimeout(
    () =>
      bot.api.editMessageText(
        chatId,
        messageId,
        t('still_downloading', undefined, i18nContext, language)
      ),
    1000 * 60 // 1 minute
  )
  let created = false
  let errorEncountered = false
  try {
    // Create caption
    const caption = t(
      'video_caption',
      {
        bot: bot.botInfo.username,
      },
      i18nContext,
      language
    )
    // Find url in cache, if it exists, send it instead
    const cachedUrl = await findUrl(url, formatId)
    if (cachedUrl) {
      await bot.api.editMessageText(
        chatId,
        messageId,
        t('download_complete', undefined, i18nContext, language)
      )
      const config = {
        reply_to_message_id: messageId,
        caption,
        parse_mode: 'HTML' as const,
      }
      return formatName.includes('audio')
        ? bot.api.sendAudio(chatId, cachedUrl.fileId, config)
        : bot.api.sendVideo(chatId, cachedUrl.fileId, config)
    }
    const findOrCreateResult = await findOrCreateDownloadJob(
      chatId,
      messageId,
      url,
      formatId
    )
    created = findOrCreateResult.created
    const downloadJob = findOrCreateResult.doc
    if (!created) {
      if (downloadJob.messageId === messageId) {
        return
      }
      return bot.api.editMessageText(
        chatId,
        messageId,
        t('error_already_in_progress', undefined, i18nContext, language)
      )
    }
    console.log(`format_id=${formatId}`)
    // Get the video info again
    const videoInfo = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificate: true,
      youtubeSkipDashManifest: true,
      skipDownload: true,
      format: `format_id=${formatId}`,
    })
    const chosenFormat = videoInfo.formats.find(
      (format) => format.format_id === formatId
    )
    if (!chosenFormat) {
      throw new Error(`Chosen format ${formatId} does not exist at url ${url}`)
    }
    const inputFile = new InputFile({ url: chosenFormat.url })
    const config = {
      reply_to_message_id: messageId,
      caption,
      parse_mode: 'HTML' as const,
    }
    const sentMessage = formatName.includes('audio')
      ? await bot.api.sendAudio(chatId, inputFile, config)
      : await bot.api.sendVideo(chatId, inputFile, config)
    const fileId =
      ('video' in sentMessage && sentMessage.video.file_id) ||
      ('audio' in sentMessage && sentMessage.audio?.file_id)
    // Cache the url and file id
    await findOrCreateUrl(url, fileId, formatId, formatName)
    // Edit the "downloading" message
    await bot.api.editMessageText(
      chatId,
      messageId,
      t('download_complete', undefined, i18nContext, language)
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
        location: 'showing error to user at downloadAndSendFileToUser',
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
