import * as findorcreate from 'mongoose-findorcreate'
import { FindOrCreate } from '@typegoose/typegoose/lib/defaultClasses'
import { getModelForClass, plugin, prop } from '@typegoose/typegoose'

@plugin(findorcreate)
export class DownloadJob extends FindOrCreate {
  @prop({ required: true, index: true })
  chatId: number
  @prop({ required: true, index: true })
  messageId: number
  @prop({ required: true, index: true })
  url: string
  @prop({ required: true, index: true })
  format: string
}

const DownloadJobModel = getModelForClass(DownloadJob, {
  schemaOptions: { timestamps: true },
})

export function findOrCreateDownloadJob(
  chatId: number,
  messageId: number,
  url: string,
  format: string
) {
  return DownloadJobModel.findOrCreate({ chatId, url, format }, { messageId })
}

export function deleteDownloadJob(chatId: number, url: string, format: string) {
  return DownloadJobModel.deleteMany({ chatId, url, format })
}

export function findAllDownloadJobs() {
  return DownloadJobModel.find()
}
