import { findAllDownloadJobs } from '@/models/DownloadJob'
import { findOrCreateChat } from '@/models/Chat'
import bot from '@/helpers/bot'
import i18n from '@/helpers/i18n'
import report from '@/helpers/report'

export default async function cleanupDownloadJobs() {
  const downloadJobs = await findAllDownloadJobs()
  for (const downloadJob of downloadJobs) {
    try {
      await downloadJob.remove()
      const chat = await findOrCreateChat(downloadJob.chatId)
      await bot.api.editMessageText(
        downloadJob.chatId,
        downloadJob.messageId,
        i18n.t(chat.doc.language, 'error_reboot')
      )
    } catch (error) {
      report(error, { location: 'cleanupDownloadJobs' })
    }
  }
}
