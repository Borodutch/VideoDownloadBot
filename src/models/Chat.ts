import * as findorcreate from 'mongoose-findorcreate'
import { FindOrCreate } from '@typegoose/typegoose/lib/defaultClasses'
import { getModelForClass, plugin, prop } from '@typegoose/typegoose'

@plugin(findorcreate)
export class Chat extends FindOrCreate {
  @prop({ required: true, index: true, unique: true })
  telegramId!: number
  @prop({ required: true, default: 'en' })
  language!: string
  @prop({ required: true, default: false })
  audio!: boolean
  @prop({ required: true, default: false })
  autoMaxQuality!: boolean
}

const ChatModel = getModelForClass(Chat, {
  schemaOptions: { timestamps: true },
})

export function findOrCreateChat(telegramId: number) {
  return ChatModel.findOrCreate({ telegramId })
}
