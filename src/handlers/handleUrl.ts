import Context from '@/models/Context'
import createDownloadJobAndRequest from '@/helpers/createDownloadJobAndRequest'
import report from '@/helpers/report'

export default function handleUrl(ctx: Context) {
  try {
    const match = ctx.message?.text?.match(
      /[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)?/i
    )
    if (!match || !match[0]) {
      return ctx.reply(ctx.i18n.t('error_invalid_url'), {
        reply_to_message_id: ctx.message?.message_id,
      })
    }
    const url = match[0]
    return createDownloadJobAndRequest(ctx, url)
  } catch (error) {
    report(error, { ctx, location: 'handleUrl' })
    return ctx.reply(ctx.i18n.t('error_cannot_start_download'), {
      reply_to_message_id: ctx.message?.message_id,
    })
  }
}
