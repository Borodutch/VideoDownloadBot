import { ShortFormatModel } from '@/models/ShortFormat'
import { ShortUrlModel } from '@/models/ShortUrl'
import Context from '@/models/Context'

export default async function handleSelectFormat(ctx: Context) {
  await ctx.answerCallbackQuery()
  let [format, url] = ctx.callbackQuery.data.split('~')
  url = (await ShortUrlModel.findOne({ shortId: url })).url
  if (format.length > 9) {
    format = (await ShortFormatModel.findOne({ shortId: format })).formatId
  }
  console.log(format, url)
}
