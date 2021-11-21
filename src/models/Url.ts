import * as findorcreate from 'mongoose-findorcreate'
import { FindOrCreate } from '@typegoose/typegoose/lib/defaultClasses'
import { getModelForClass, plugin, prop } from '@typegoose/typegoose'

@plugin(findorcreate)
export class Url extends FindOrCreate {
  @prop({ required: true, index: true })
  url: string
  @prop({ required: true, index: true })
  formatId: string
  @prop({ required: true, index: true })
  fileId: string
  @prop({ required: true })
  formatName: string
}

const UrlModel = getModelForClass(Url, {
  schemaOptions: { timestamps: true },
})

export function findUrl(url: string, formatId: string) {
  return UrlModel.findOne({ url, formatId })
}

export function findOrCreateUrl(
  url: string,
  fileId: string,
  formatId: string,
  formatName: string
) {
  return UrlModel.findOrCreate({ url, formatId }, { fileId, formatName })
}
