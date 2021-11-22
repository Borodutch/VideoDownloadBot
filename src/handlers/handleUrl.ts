import { InlineKeyboard } from 'grammy'
import { ShortUrlModel } from '@/models/ShortUrl'
import { findOrCreateShortFormat } from '@/models/ShortFormat'
import Context from '@/models/Context'
import Format from '@/models/Format'
import constructFormatName from '@/helpers/constructFormatName'
import downloadAndSendFileToUser from '@/helpers/downloadAndSendFileToUser'
import report from '@/helpers/report'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const youtubedl = require('youtube-dl-exec')

interface ConstructedFormat {
  name: string
  id: string
}

export default async function handleUrl(ctx: Context) {
  // Make sure the bot is typing until it gets the info
  await ctx.replyWithChatAction('typing')
  const typingInterval = setInterval(async () => {
    try {
      await ctx.replyWithChatAction('typing')
    } catch (error) {
      report(error, { ctx, location: 'typing timeout' })
    }
  }, 1000 * 5)
  // Find url
  const match = ctx.message.text.match(
    /[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)?/i
  )
  if (!match || !match[0]) {
    // Turn off typing on cooldown
    clearInterval(typingInterval)
    return ctx.reply(ctx.i18n.t('invalid_url'), {
      reply_to_message_id: ctx.message.message_id,
    })
  }
  const url = match[0]
  // Get the info
  try {
    // No need for keyboard if users doesn't want to choose a format
    if (!ctx.dbchat.chooseFormats) {
      // Turn off typing on cooldown
      clearInterval(typingInterval)
      const sentMessage = await ctx.reply(ctx.i18n.t('downloading'))
      return downloadAndSendFileToUser({
        ctx,
        messageId: sentMessage.message_id,
        url,
      })
    }
    const videoInfo = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificate: true,
      youtubeSkipDashManifest: true,
      skipDownload: true,
      allFormats: true,
    })
    // Turn off typing on cooldown
    clearInterval(typingInterval)
    // Construct and return the formats keyboard
    const mb = ctx.i18n.t('megabytes')
    const availableFormats: ConstructedFormat[] = videoInfo.formats.map(
      (v: Format) => ({
        name: constructFormatName(v, mb),
        id: v.format_id,
      })
    )
    return ctx.reply(ctx.i18n.t('select_format'), {
      reply_to_message_id: ctx.message.message_id,
      reply_markup: await keyboard(deduplicateFormats(availableFormats), url),
    })
  } catch (error) {
    // Turn off typing on cooldown
    clearInterval(typingInterval)
    report(error, { ctx })
    return ctx.reply(ctx.i18n.t('video_download_error'), {
      reply_to_message_id: ctx.message.message_id,
    })
  }
}

async function keyboard(formats: ConstructedFormat[], url: string) {
  const result = new InlineKeyboard()
  const shortUrl = await ShortUrlModel.create({ url })
  let i = 0
  for (const format of formats) {
    format.id = (
      await findOrCreateShortFormat(format.id, format.name)
    ).doc.shortId
    result.add({
      callback_data: `${format.id}~${shortUrl.shortId}`,
      text: format.name,
    })
    if (i % 2 === 1) {
      result.row()
    }
    i++
  }
  return result
}

function deduplicateFormats(formats: ConstructedFormat[]) {
  const seenFormats: { [name: string]: ConstructedFormat } = {}
  for (const format of formats) {
    seenFormats[format.name] = format
  }
  return Object.values(seenFormats).sort((a, b) => a.name.localeCompare(b.name))
}
