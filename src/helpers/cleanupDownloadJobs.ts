import {
  deleteAllDownloadJobs,
  findAllDownloadJobs,
} from '@/models/downloadJobFunctions'
import {
  deleteAllDownloadRequests,
  findDownloadRequestsForDownloadJob,
} from '@/models/downloadRequestFunctions'
import { findOrCreateChat } from '@/models/Chat'
import bot from '@/helpers/bot'
import i18n from '@/helpers/i18n'
import report from '@/helpers/report'

export default async function cleanupDownloadJobs() {
  const downloadJobs = await findAllDownloadJobs()
  for (const downloadJob of downloadJobs) {
    const downloadRequests = await findDownloadRequestsForDownloadJob(
      downloadJob
    )
    for (const downloadRequest of downloadRequests) {
      const { doc: chat } = await findOrCreateChat(downloadRequest.chatId)
      try {
        await bot.api.editMessageText(
          chat.telegramId,
          downloadRequest.messageId,
          i18n.t(chat.language, 'error_reboot')
        )
      } catch (error) {
        report(error, { location: 'cleanupDownloadJobs' })
      }
    }
  }
  await deleteAllDownloadJobs()
  await deleteAllDownloadRequests()
}
