import { findOrCreateDownloadJob } from '@/models/DownloadJob'
import Context from '@/models/Context'
import bot from '@/helpers/bot'

export default async function checkDownloadJobAndSendError(
  ctx: Context,
  messageId: number,
  url: string,
  formatId: string
) {
  const findOrCreateResult = await findOrCreateDownloadJob(
    ctx.dbchat.telegramId,
    messageId,
    url,
    formatId
  )
  const created = findOrCreateResult.created
  const downloadJob = findOrCreateResult.doc
  if (!created) {
    if (downloadJob.messageId === messageId) {
      return false
    }
    await bot.api.editMessageText(
      ctx.dbchat.telegramId,
      messageId,
      ctx.i18n.t('error_already_in_progress')
    )
  }
  return created
}
