import { InlineKeyboard } from 'grammy'
import { ShortUrlModel } from '@/models/ShortUrl'
import { findOrCreateShortFormat } from '@/models/ShortFormat'
import Context from '@/models/Context'
import report from '@/helpers/report'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const youtubedl = require('youtube-dl-exec')

interface Format {
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
    const videoInfo = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificate: true,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true,
      skipDownload: true,
      allFormats: true,
    })
    // Turn off typing on cooldown
    clearInterval(typingInterval)
    // Construct and return the formats keyboard
    const mb = ctx.i18n.t('megabytes')
    const availableFormats: Format[] = videoInfo.formats.map((v) => ({
      name: `${v.format.split(' - ')[1]}, ${v.ext}${
        v.filesize ? `, ${(v.filesize / 1024 / 1024).toFixed(2)}${mb}` : ''
      }`,
      id: v.format_id,
    }))
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

async function keyboard(formats: Format[], url: string) {
  const result = new InlineKeyboard()
  const shortUrl = await ShortUrlModel.create({ url })
  let i = 0
  for (const format of formats) {
    if (format.id.length > 9) {
      format.id = (await findOrCreateShortFormat(format.id)).doc.shortId
    }
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

function deduplicateFormats(formats: Format[]) {
  const seenFormats: { [name: string]: Format } = {}
  for (const format of formats) {
    seenFormats[format.name] = format
  }
  return Object.values(seenFormats).sort((a, b) => a.name.localeCompare(b.name))
}
