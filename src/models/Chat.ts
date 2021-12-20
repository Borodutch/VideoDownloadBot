import * as findorcreate from 'mongoose-findorcreate'
import { FindOrCreate } from '@typegoose/typegoose/lib/defaultClasses'
import {
  getModelForClass,
  modelOptions,
  plugin,
  prop,
} from '@typegoose/typegoose'

@plugin(findorcreate)
@modelOptions({ schemaOptions: { timestamps: true } })
export class Chat extends FindOrCreate {
  @prop({ required: true, index: true, unique: true })
  telegramId!: number
  @prop({ required: true, default: 'en' })
  language!: string
  @prop({ required: true, default: false })
  audio!: boolean
}

const ChatModel = getModelForClass(Chat)

export function findOrCreateChat(telegramId: number) {
  return ChatModel.findOrCreate({ telegramId })
}
