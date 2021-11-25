import * as findorcreate from 'mongoose-findorcreate'
import { FindOrCreate } from '@typegoose/typegoose/lib/defaultClasses'
import { getModelForClass, plugin, prop } from '@typegoose/typegoose'

@plugin(findorcreate)
export class Url extends FindOrCreate {
  @prop({ required: true, index: true })
  url!: string
  @prop({ required: true, index: true })
  fileId!: string
  @prop({ required: true, index: true, default: false })
  audio!: boolean
  @prop({ required: true })
  title!: string
}

const UrlModel = getModelForClass(Url, {
  schemaOptions: { timestamps: true },
})

export function findUrl(url: string, audio: boolean) {
  return UrlModel.findOne({ url, audio })
}

export function findOrCreateUrl(
  url: string,
  fileId: string,
  audio: boolean,
  title: string
) {
  return UrlModel.findOrCreate({ url, audio }, { fileId, title })
}
