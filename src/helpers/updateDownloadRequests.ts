import { Chat, findOrCreateChat } from '@/models/Chat'
import { DocumentType } from '@typegoose/typegoose'
import { findDownloadRequestsForDownloadJob } from '@/models/downloadRequestFunctions'
import { findUrl } from '@/models/Url'
import DownloadJob from '@/models/DownloadJob'
import DownloadJobStatus from '@/models/DownloadJobStatus'
import MessageEditor from '@/helpers/MessageEditor'
import bot from '@/helpers/bot'
import i18n from '@/helpers/i18n'

export default async function updateDownloadRequests(
  downloadJob: DocumentType<DownloadJob>
) {
  // Todo: handle errors here in try/catch
  // Todo: add messages updates for download jobs
  // Todo: handle error DownloadJobStatus
  if (downloadJob.status === DownloadJobStatus.downloading) {
    return
  }
  const requests = await findDownloadRequestsForDownloadJob(downloadJob)
  const chats: { [chatId: number]: Chat } = {}
  const editors = requests.map(
    (request) => new MessageEditor(request.messageId, undefined, request.chatId)
  )
  for (const editor of editors) {
    if (editor.chatId && !chats[editor.chatId]) {
      const { doc } = await findOrCreateChat(editor.chatId)
      chats[editor.chatId] = doc
    }
  }
  if (downloadJob.status === DownloadJobStatus.uploading) {
    for (const editor of editors) {
      if (editor.chatId && chats[editor.chatId]) {
        await editor.editMessageAndStopTimer(
          i18n.t(chats[editor.chatId].language, 'uploading_started')
        )
      }
    }
  } else if (downloadJob.status === DownloadJobStatus.finished) {
    for (const editor of editors) {
      if (editor.chatId && chats[editor.chatId]) {
        await editor.editMessageAndStopTimer(
          i18n.t(chats[editor.chatId].language, 'download_complete')
        )
      }
    }
    const otherRequests = requests.filter(
      (request) =>
        request.chatId !== downloadJob.originalChatId &&
        request.messageId !== downloadJob.originalMessageId
    )
    if (otherRequests.length) {
      const cachedUrl = await findUrl(downloadJob.url, downloadJob.audio)
      if (cachedUrl) {
        for (const request of otherRequests) {
          if (chats[request.chatId]) {
            const config = {
              reply_to_message_id: request.messageId,
              caption: i18n.t(chats[request.chatId].language, 'video_caption', {
                bot: bot.botInfo.username,
                title: cachedUrl.title,
              }),
              parse_mode: 'HTML' as const,
            }
            downloadJob.audio
              ? await bot.api.sendAudio(
                  request.chatId,
                  cachedUrl.fileId,
                  config
                )
              : await bot.api.sendVideo(
                  request.chatId,
                  cachedUrl.fileId,
                  config
                )
          }
        }
      }
    }
    // Cleanup
    await Promise.all(requests.map((request) => request.delete()))
    await downloadJob.delete()
  }
}
