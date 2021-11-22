import { ShortFormatModel } from '@/models/ShortFormat'
import { ShortUrlModel } from '@/models/ShortUrl'
import Context from '@/models/Context'
import downloadAndSendFileToUser from '@/helpers/downloadAndSendFileToUser'

export default async function handleSelectFormat(ctx: Context) {
  // Answer the query to remove the waiting ui on Telegram
  await ctx.answerCallbackQuery()
  // Make user know that the file is being downloaded
  await ctx.editMessageText(ctx.i18n.t('downloading'))
  const data = ctx.callbackQuery.data.split('~')
  const shortFormat = await ShortFormatModel.findOne({
    shortId: data[0],
  })
  const formatId = shortFormat.formatId
  const url = (await ShortUrlModel.findOne({ shortId: data[1] })).url
  const formatName = shortFormat.formatName
  return downloadAndSendFileToUser({
    url,
    formatId,
    messageId: ctx.callbackQuery.message.message_id,
    formatName,
    ctx,
  })
}
