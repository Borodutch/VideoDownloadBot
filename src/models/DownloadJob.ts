import * as findorcreate from 'mongoose-findorcreate'
import { FindOrCreate } from '@typegoose/typegoose/lib/defaultClasses'
import { isDocument, plugin, post, prop } from '@typegoose/typegoose'
import DownloadJobStatus from '@/models/DownloadJobStatus'
import report from '@/helpers/report'
import updateDownloadRequests from '@/helpers/updateDownloadRequests'

@plugin(findorcreate)
@post<DownloadJob>('save', async function (downloadJob) {
  if (!isDocument(downloadJob)) {
    return
  }
  try {
    await updateDownloadRequests(downloadJob)
  } catch (error) {
    report(error, { location: 'DownloadJob.save hook' })
  }
})
export default class DownloadJob extends FindOrCreate {
  @prop({ required: true, index: true })
  url!: string
  @prop({ required: true, index: true, default: false })
  audio!: boolean
  @prop({
    required: true,
    index: true,
    enum: DownloadJobStatus,
    default: DownloadJobStatus.created,
  })
  status!: DownloadJobStatus
  @prop({ required: true, index: true })
  originalChatId!: number
  @prop({ required: true, index: true })
  originalMessageId!: number
}
