import Context from '@/models/Context'

export default async function handleMaxQuality(ctx: Context) {
  ctx.dbchat.autoMaxQuality = !ctx.dbchat.autoMaxQuality
  await ctx.dbchat.save()
  return ctx.reply(
    ctx.i18n.t(
      ctx.dbchat.autoMaxQuality ? 'max_quality_on' : 'max_quality_off'
    ),
    {
      reply_to_message_id: ctx.message?.message_id,
    }
  )
}
