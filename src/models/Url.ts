import { getModelForClass, prop } from '@typegoose/typegoose'

export class Url {
  @prop({ required: true, index: true })
  url!: string
  @prop({ required: true, index: true })
  fileId!: string
  @prop({ required: true, index: true, default: false })
  audio!: boolean
  @prop({ required: true })
  title!: string
  @prop({ index: true })
  resolution?: number
}

const UrlModel = getModelForClass(Url, {
  schemaOptions: { timestamps: true },
})

export function findUrl(url: string, audio: boolean, resolution?: number) {
  return UrlModel.findOne({ url, audio, resolution })
}

export async function findOrCreateUrl(
  url: string,
  fileId: string,
  audio: boolean,
  title: string,
  resolution?: number
) {
  const dburl = await UrlModel.findOne({ url, audio, resolution })
  if (dburl) {
    return dburl
  }
  return UrlModel.create({
    url,
    fileId,
    audio,
    title,
    resolution,
  })
}
