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
}

const UrlModel = getModelForClass(Url, {
  schemaOptions: { timestamps: true },
})

export function findUrl(url: string, audio: boolean) {
  return UrlModel.findOne({ url, audio })
}

export async function findOrCreateUrl(
  url: string,
  fileId: string,
  audio: boolean,
  title: string
) {
  const dburl = await UrlModel.findOne({ url, audio })
  if (dburl) {
    return dburl
  }
  return UrlModel.create({
    url,
    fileId,
    audio,
    title,
  })
}
