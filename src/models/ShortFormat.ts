import * as findorcreate from 'mongoose-findorcreate'
import * as randomToken from 'random-token'
import { FindOrCreate } from '@typegoose/typegoose/lib/defaultClasses'
import { getModelForClass, plugin, prop } from '@typegoose/typegoose'

@plugin(findorcreate)
export class ShortFormat extends FindOrCreate {
  @prop({ required: true, index: true, default: () => randomToken(10) })
  shortId: string
  @prop({ required: true, index: true })
  formatId: string
  @prop({ required: true })
  formatName: string
}

export const ShortFormatModel = getModelForClass(ShortFormat, {
  schemaOptions: { timestamps: true },
})

export function findOrCreateShortFormat(formatId: string, formatName: string) {
  return ShortFormatModel.findOrCreate({ formatId }, { formatName })
}
