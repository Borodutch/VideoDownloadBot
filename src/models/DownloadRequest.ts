import * as findorcreate from 'mongoose-findorcreate'
import { DownloadJob, DownloadJobStatus } from '@/models/DownloadJob'
import { FindOrCreate } from '@typegoose/typegoose/lib/defaultClasses'
import { Ref, getModelForClass, plugin, prop } from '@typegoose/typegoose'

@plugin(findorcreate)
export class DownloadRequest extends FindOrCreate {
  @prop({ required: true, index: true, ref: () => DownloadJob })
  downloadJob!: Ref<DownloadJob>
  @prop({ required: true, index: true })
  chatId!: number
  @prop({ required: true, index: true })
  messageId!: number
}

const DownloadRequestModel = getModelForClass(DownloadRequest, {
  schemaOptions: { timestamps: true },
})

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
