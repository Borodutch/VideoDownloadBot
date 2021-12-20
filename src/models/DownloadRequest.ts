import * as findorcreate from 'mongoose-findorcreate'
import { FindOrCreate } from '@typegoose/typegoose/lib/defaultClasses'
import { Ref, modelOptions, plugin, prop } from '@typegoose/typegoose'
import DownloadJob from '@/models/DownloadJob'

@plugin(findorcreate)
@modelOptions({ schemaOptions: { timestamps: true } })
export default class DownloadRequest extends FindOrCreate {
  @prop({ required: true, index: true, ref: () => DownloadJob })
  downloadJob!: Ref<DownloadJob>
  @prop({ required: true, index: true })
  chatId!: number
  @prop({ required: true, index: true })
  messageId!: number
}
