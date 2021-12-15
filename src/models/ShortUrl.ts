import { FindOrCreate } from '@typegoose/typegoose/lib/defaultClasses'
import { getModelForClass, prop } from '@typegoose/typegoose'
import randomToken = require('random-token')
import checkAvailableResolutions from '@/helpers/checkAvailableResolutions'

export class ShortUrl extends FindOrCreate {
  @prop({
    required: true,
    index: true,
    unique: true,
    default: () => randomToken(16),
  })
  shortId!: string
  @prop({ required: true })
  url!: string
  @prop({ required: true, type: () => [Number] })
  availableResolutions!: number[]
}

const ShortUrlModel = getModelForClass(ShortUrl, {
  schemaOptions: { timestamps: true },
})

export async function findOrCreateShortUrl(url: string) {
  const shortUrl = await ShortUrlModel.findOne({ url })
  if (shortUrl) {
    return shortUrl
  }

  const availableResolutions = await checkAvailableResolutions(url)

  return new ShortUrlModel({ url, availableResolutions }).save()
}

export async function findShortUrl(shortId: string) {
  return ShortUrlModel.findOne({ shortId })
}
