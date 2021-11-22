import Context from '@/models/Context'
import bot from '@/helpers/bot'

export default function getCaption(ctx: Context) {
  return ctx.i18n.t('video_caption', {
    bot: bot.botInfo.username,
  })
}
