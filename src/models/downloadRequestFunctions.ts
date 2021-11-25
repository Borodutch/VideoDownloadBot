import { DownloadRequestModel } from '@/models'
import DownloadJob from '@/models/DownloadJob'
import DownloadJobStatus from '@/models/DownloadJobStatus'

export function findOrCreateDownloadRequest(
  chatId: number,
  messageId: number,
  downloadJob: DownloadJob
) {
  if (downloadJob.status === DownloadJobStatus.finished) {
    // TODO: handle finished
  }
  if (downloadJob.status === DownloadJobStatus.failedUpload) {
    // TODO: handle failed
  }
  if (downloadJob.status === DownloadJobStatus.failedDownload) {
    // TODO: handle failed
  }
  return DownloadRequestModel.findOrCreate({ chatId, messageId, downloadJob })
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
