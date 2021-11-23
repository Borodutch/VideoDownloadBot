import { findUrl } from '@/models/Url'
import Context from '@/models/Context'
import MessageEditor from '@/helpers/MessageEditor'
import bot from '@/helpers/bot'
import getCaption from '@/helpers/getCaption'

export default async function checkForCachedUrlAndSendFile(
  url: string,
  ctx: Context,
  editor: MessageEditor
) {
  const cachedUrl = await findUrl(url, ctx.dbchat.audio)
  if (cachedUrl) {
    await editor.editMessageAndStopTimer('download_complete')
    const config = {
      reply_to_message_id: editor.messageId,
      caption: getCaption(ctx),
      parse_mode: 'HTML' as const,
    }
    return ctx.dbchat.audio
      ? bot.api.sendAudio(ctx.dbchat.telegramId, cachedUrl.fileId, config)
      : bot.api.sendVideo(ctx.dbchat.telegramId, cachedUrl.fileId, config)
  }
  return undefined
}
