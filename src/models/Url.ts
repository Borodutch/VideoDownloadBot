import * as findorcreate from 'mongoose-findorcreate'
import { FindOrCreate } from '@typegoose/typegoose/lib/defaultClasses'
import {
  Severity,
  getModelForClass,
  modelOptions,
  plugin,
  prop,
} from '@typegoose/typegoose'
import { Video } from '@grammyjs/types'

@modelOptions({ options: { allowMixed: Severity.ALLOW } })
@plugin(findorcreate)
export class Url extends FindOrCreate {
  @prop({ required: true, index: true, unique: true })
  url: string
  @prop({ required: true, index: true })
  formatId: string
  @prop({ required: true })
  video: Video
}

const UrlModel = getModelForClass(Url, {
  schemaOptions: { timestamps: true },
})

export function findUrl(url: string) {
  return UrlModel.findOne({ url })
}

export function findOrCreateUrl(url: string, video: Video) {
  return UrlModel.findOrCreate({ url }, { video })
}
