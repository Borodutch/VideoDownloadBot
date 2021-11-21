import { NextFunction } from 'grammy'
import { findOrCreateChat } from '@/models/Chat'
import Context from '@/models/Context'

export default async function attachChat(ctx: Context, next: NextFunction) {
  const { doc } = await findOrCreateChat(ctx.from.id)
  ctx.dbchat = doc
  return next()
}
