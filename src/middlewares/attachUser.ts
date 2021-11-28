import { NextFunction } from 'grammy'
import { findOrCreateChat } from '@/models/Chat'
import Context from '@/models/Context'

export default async function attachChat(ctx: Context, next: NextFunction) {
  if (!ctx.chat) {
    throw new Error('ctx.from is not defined')
  }
  const { doc } = await findOrCreateChat(ctx.chat.id)
  ctx.dbchat = doc
  return next()
}
