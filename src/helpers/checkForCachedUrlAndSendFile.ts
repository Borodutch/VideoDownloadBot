import { findUrl } from '@/models/Url'
import Context from '@/models/Context'
import MessageEditor from '@/helpers/MessageEditor'
import bot from '@/helpers/bot'

export default async function checkForCachedUrlAndSendFile(
  url: string,
  ctx: Context,
  editor: MessageEditor
) {
  const cachedUrl = await findUrl(url, ctx.dbchat.audio)
  if (cachedUrl) {
    await editor.editMessageAndStopTimer(ctx.i18n.t('download_complete'))
    const config = {
      reply_to_message_id: editor.messageId,
      caption: ctx.i18n.t('video_caption', {
        bot: bot.botInfo.username,
        title: cachedUrl.title,
      }),
      parse_mode: 'HTML' as const,
    }
    return ctx.dbchat.audio
      ? bot.api.sendAudio(ctx.dbchat.telegramId, cachedUrl.fileId, config)
      : bot.api.sendVideo(ctx.dbchat.telegramId, cachedUrl.fileId, config)
  }
  return undefined
}
