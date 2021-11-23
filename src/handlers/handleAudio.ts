import Context from '@/models/Context'

export default async function handleAudio(ctx: Context) {
  ctx.dbchat.audio = !ctx.dbchat.audio
  await ctx.dbchat.save()
  return ctx.reply(ctx.i18n.t(ctx.dbchat.audio ? 'audio_on' : 'audio_off'), {
    reply_to_message_id: ctx.message?.message_id,
  })
}
