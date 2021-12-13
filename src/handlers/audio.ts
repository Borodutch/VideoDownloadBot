import Context from '@/models/Context'

export default async function handleAudio(ctx: Context) {
  ctx.dbchat.audio = !ctx.dbchat.audio
  await ctx.dbchat.save()
  return ctx.replyWithLocalization(ctx.dbchat.audio ? 'audio_on' : 'audio_off')
}
