import { InputFile } from 'grammy'
import { findOrCreateUrl, findUrl } from '@/models/Url'
import Context from '@/models/Context'
import bot from '@/helpers/bot'
import report from '@/helpers/report'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const youtubedl = require('youtube-dl-exec')

export default async function handleUrl(ctx: Context) {
  await ctx.replyWithChatAction('typing')
  const match = ctx.message.text.match(
    /[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)?/i
  )
  if (!match || !match[0]) {
    return ctx.reply(ctx.i18n.t('invalid_url'))
  }
  const url = match[0]
  try {
    // const cachedFile = await findUrl(url)
    // if (cachedFile) {
    //   return ctx.replyWithVideo(cachedFile.video.file_id, {
    //     reply_to_message_id: ctx.message.message_id,
    //   })
    // }
    const videoInfo = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificate: true,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true,
      skipDownload: true,
      allFormats: true,
    })
    const availableFormats = videoInfo.formats.map((v) => [
      `${v.format.split(' - ')[1]}, ${v.ext}${
        v.filesize ? `, ${(v.filesize / 1024 / 1024).toFixed(2)}Mb` : ''
      }`,
      v.format_id,
    ])
    return
    if (!videoInfo.requested_formats[0]) {
      throw new Error('No video formats found')
    }
    const message = await ctx.replyWithVideo(
      new InputFile({
        url: videoInfo.requested_formats[0].url as string,
      })
    )
    await findOrCreateUrl(url, message.video)
  } catch (error) {
    report(error as Error, { ctx })
    return ctx.reply(ctx.i18n.t('video_download_error'))
  }
}
