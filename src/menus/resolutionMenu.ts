import createDownloadJobAndRequest from '@/helpers/createDownloadJobAndRequest'
import Context from '@/models/Context'
import { findShortUrl } from '@/models/ShortUrl'
import { Menu } from '@grammyjs/menu'

export const resolutionMenu = new Menu<Context>('resolution-menu').dynamic(
  async (ctx, range) => {
    const shortUrl = await findShortUrl(
      ctx.shortUrlId || ctx.match?.toString()!
    )

    if (!shortUrl) {
      ctx.reply(ctx.i18n.t('error_outdated_menu'))
      return
    }

    for (const resolution of shortUrl.availableResolutions) {
      range
        .text({ text: `${resolution}p`, payload: shortUrl.shortId }, (ctx) => {
          createDownloadJobAndRequest(ctx, shortUrl.url, resolution)
          return ctx.deleteMessage()
        })
        .row()
    }
    range.text({ text: `Cancel`, payload: shortUrl.shortId }, (ctx) =>
      ctx.deleteMessage()
    )
  }
)
