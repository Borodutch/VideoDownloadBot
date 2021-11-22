import { findUrl } from '@/models/Url'
import Context from '@/models/Context'
import bot from '@/helpers/bot'

export default async function checkForCachedUrlAndSendFile(
  url: string,
  formatId: string,
  formatName: string,
  ctx: Context,
  messageId: number,
  caption: string
) {
  const cachedUrl = await findUrl(url, formatId)
  if (cachedUrl) {
    await bot.api.editMessageText(
      ctx.dbchat.telegramId,
      messageId,
      ctx.i18n.t('download_complete')
    )
    const config = {
      reply_to_message_id: messageId,
      caption,
      parse_mode: 'HTML' as const,
    }
    if (formatName.includes('audio')) {
      await bot.api.sendAudio(ctx.dbchat.telegramId, cachedUrl.fileId, config)
    } else {
      await bot.api.sendVideo(ctx.dbchat.telegramId, cachedUrl.fileId, config)
    }
    return true
  }
  return false
}
