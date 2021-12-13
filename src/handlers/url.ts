import Context from '@/models/Context'
import createDownloadJobAndRequest from '@/helpers/createDownloadJobAndRequest'
import report from '@/helpers/report'

export default function handleUrl(ctx: Context) {
  try {
    const match = ctx.message?.text?.match(
      /[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)?/i
    )
    if (!match || !match[0]) {
      return ctx.replyWithLocalization('error_invalid_url')
    }
    const url = match[0]
    return createDownloadJobAndRequest(ctx, url)
  } catch (error) {
    report(error, { ctx, location: 'handleUrl' })
    return ctx.replyWithLocalization('error_cannot_start_download')
  }
}
