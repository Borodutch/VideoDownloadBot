import Context from '@/models/Context'

export default async function handleChooseFormats(ctx: Context) {
  ctx.dbchat.chooseFormats = !ctx.dbchat.chooseFormats
  await ctx.dbchat.save()
  return ctx.reply(
    ctx.i18n.t(
      ctx.dbchat.chooseFormats ? 'choose_formats_on' : 'choose_formats_off'
    ),
    {
      reply_to_message_id: ctx.message.message_id,
    }
  )
}
