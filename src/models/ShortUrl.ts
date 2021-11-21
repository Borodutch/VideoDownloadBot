import * as randomToken from 'random-token'
import { getModelForClass, index, prop } from '@typegoose/typegoose'

@index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 }) // expire after 7 days
export class ShortUrl {
  @prop({ required: true, index: true, default: () => randomToken(16) })
  shortId: string
  @prop({ required: true })
  url: string
}

export const ShortUrlModel = getModelForClass(ShortUrl, {
  schemaOptions: { timestamps: true },
})
