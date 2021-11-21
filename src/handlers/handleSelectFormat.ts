import { InputFile } from 'grammy'
import { ShortFormatModel } from '@/models/ShortFormat'
import { ShortUrlModel } from '@/models/ShortUrl'
import { findOrCreateUrl, findUrl } from '@/models/Url'
import Context from '@/models/Context'
import bot from '@/helpers/bot'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const youtubedl = require('youtube-dl-exec')

export default async function handleSelectFormat(ctx: Context) {
  // Todo: add a message to the video pointing at @AnyVideoDownloadBot
  // Todo: add error handler that asks to try a different format

  // Answer the query to remove the waiting ui on Telegram
  await ctx.answerCallbackQuery()
  // Make user know that the file is being downloaded
  await ctx.editMessageText(ctx.i18n.t('downloading'))
  // Let users know not to panic after a minute of downloading
  const stillDownloadingTimeout = setTimeout(
    () => ctx.editMessageText(ctx.i18n.t('still_downloading')),
    1000 * 60 // 1 minute
  )
  let [formatId, url] = ctx.callbackQuery.data.split('~')
  url = (await ShortUrlModel.findOne({ shortId: url })).url
  if (formatId.length > 9) {
    formatId = (await ShortFormatModel.findOne({ shortId: formatId })).formatId
  }
  // Create caption
  const caption = ctx.i18n.t('video_caption', {
    bot: bot.botInfo.username,
  })
  // Find url in cache, if it exists, send it instead
  const cachedUrl = await findUrl(url, formatId)
  if (cachedUrl) {
    await ctx.editMessageText(ctx.i18n.t('download_complete'))
    return ctx.replyWithVideo(cachedUrl.fileId, {
      reply_to_message_id: ctx.callbackQuery.message.message_id,
      caption,
      parse_mode: 'HTML',
    })
  }
  // TODO: add check to not download multiple times if already being downloaded
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
    // TODO: throw an error
    return
  }
  const inputFile = new InputFile({ url: chosenFormat.url })
  const file = await ctx.replyWithVideo(inputFile, {
    reply_to_message_id: ctx.callbackQuery.message.message_id,
    caption,
    parse_mode: 'HTML',
  })
  // No need to change the message so that user wouldn't panic anymoru
  clearTimeout(stillDownloadingTimeout)
  // Cache the url and file id
  await findOrCreateUrl(url, file.video, formatId)
  // Edit the "downloading" message
  await ctx.editMessageText(ctx.i18n.t('download_complete'))
}
