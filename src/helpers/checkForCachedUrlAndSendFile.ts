import { findUrl } from '@/models/Url'
import Context from '@/models/Context'
import MessageEditor from '@/helpers/MessageEditor'
import sendCompletedFile from '@/helpers/sendCompletedFile'

export default async function checkForCachedUrlAndSendFile(
  url: string,
  ctx: Context,
  editor: MessageEditor
) {
  const cachedUrl = await findUrl(url, ctx.dbchat.audio)
  if (cachedUrl) {
    console.log(`Sending cached file for ${url}`)
    await editor.editMessage(ctx.i18n.t('download_complete'))
    return sendCompletedFile(
      ctx.dbchat.telegramId,
      editor.messageId,
      ctx.dbchat.language,
      ctx.dbchat.audio,
      cachedUrl.title,
      cachedUrl.fileId
    )
  }
  return undefined
}
