import { DownloadRequestModel } from '@/models'
import { findOrCreateChat } from '@/models/Chat'
import { findUrl } from '@/models/Url'
import DownloadJob from '@/models/DownloadJob'
import DownloadJobStatus from '@/models/DownloadJobStatus'
import MessageEditor from '@/helpers/MessageEditor'
import i18n from '@/helpers/i18n'
import sendCompletedFile from '@/helpers/sendCompletedFile'

export async function findOrCreateDownloadRequest(
  chatId: number,
  messageId: number,
  downloadJob: DownloadJob
) {
  if (downloadJob.status === DownloadJobStatus.downloading) {
    return DownloadRequestModel.findOrCreate({
      chatId,
      messageId,
      downloadJob,
    })
  }
  const editor = new MessageEditor(messageId, undefined, chatId)
  const { doc } = await findOrCreateChat(chatId)
  switch (downloadJob.status) {
    case DownloadJobStatus.uploading:
      await editor.editMessage(i18n.t(doc.language, 'uploading_started'))
      break
    case DownloadJobStatus.failedDownload:
      await editor.editMessage(i18n.t(doc.language, 'error_video_download'))
      break
    case DownloadJobStatus.failedUpload:
      await editor.editMessage(i18n.t(doc.language, 'error_video_upload'))
      break
    case DownloadJobStatus.finished: {
      const url = await findUrl(downloadJob.url, downloadJob.audio)
      if (!url) {
        throw new Error('Cached url not found')
      }
      await editor.editMessage(i18n.t(doc.language, 'download_complete'))
      await sendCompletedFile(
        chatId,
        messageId,
        doc.language,
        url.audio,
        url.title,
        url.fileId
      )
      return
    }
  }
  return DownloadRequestModel.findOrCreate({
    chatId,
    messageId,
    downloadJob,
  })
}

export function findDownloadRequestsForDownloadJob(downloadJob: DownloadJob) {
  return DownloadRequestModel.find({ downloadJob })
}

export function deleteDownloadRequest(chatId: number, messageId: number) {
  return DownloadRequestModel.deleteMany({ chatId, messageId })
}

export function deleteAllDownloadRequests() {
  return DownloadRequestModel.deleteMany({})
}
