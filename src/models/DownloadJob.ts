import * as findorcreate from 'mongoose-findorcreate'
import { FindOrCreate } from '@typegoose/typegoose/lib/defaultClasses'
import { getModelForClass, plugin, post, prop } from '@typegoose/typegoose'
import updateDownloadRequests from '@/helpers/updateDownloadRequests'

export enum DownloadJobStatus {
  start = 'start',
  downloading = 'downloading',
  uploading = 'uploading',
  finished = 'finished',
  failedDownload = 'failedDownload',
  failedUpload = 'failedUpload',
}

@plugin(findorcreate)
@post<DownloadJob>('update', function (downloadJobs) {
  downloadJobs.forEach((downloadJob) => updateDownloadRequests(downloadJob))
})
export class DownloadJob extends FindOrCreate {
  @prop({ required: true, index: true })
  url!: string
  @prop({ required: true, index: true, default: false })
  audio!: boolean
  @prop({
    required: true,
    index: true,
    enum: DownloadJobStatus,
    default: DownloadJobStatus.start,
  })
  status!: DownloadJobStatus
}

const DownloadJobModel = getModelForClass(DownloadJob, {
  schemaOptions: { timestamps: true },
})

export function findOrCreateDownloadJob(url: string, audio: boolean) {
  return DownloadJobModel.findOrCreate({ url, audio })
}

export function deleteDownloadJob(url: string, audio: boolean) {
  return DownloadJobModel.deleteMany({ url, audio })
}

export function findAllDownloadJobs() {
  return DownloadJobModel.find({})
}

export function deleteAllDownloadJobs() {
  return DownloadJobModel.deleteMany({})
}
