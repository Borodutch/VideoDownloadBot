import Context from '@/models/Context'
import bot from '@/helpers/bot'

const ignoredMessages = ['bot was blocked by the user', 'is not a valid URL']

interface ExtraErrorInfo {
  ctx?: Context
  location?: string
  meta?: string
}

function constructErrorMessage(
  error: Error,
  { ctx, location, meta }: ExtraErrorInfo
) {
  const { message } = error
  const chatInfo =
    ctx?.chat?.id || ctx?.callbackQuery?.message?.chat.id
      ? [`Chat <b>${ctx.chat?.id || ctx.callbackQuery?.message?.chat.id}</b>`]
      : []
  if (ctx?.chat && 'username' in ctx.chat) {
    chatInfo.push(`@${ctx.chat.username}`)
  }
  const result = `${
    location ? `<b>${escape(location)}</b>${ctx ? '\n' : ''}` : ''
  }${chatInfo.filter((v) => !!v).join(', ')}\n${escape(message)}${
    meta ? `\n<code>${meta}</code>` : ''
  }`
  return result
}

async function sendToTelegramAdmin(error: Error, info: ExtraErrorInfo) {
  if (!process.env.ADMIN_ID) {
    console.log(`ADMIN_ID is not defined`)
    return
  }
  try {
    if (
      process.env.ENVIRONMENT !== 'development' &&
      ignoredMessages.find((m) => error.message.includes(m))
    ) {
      return
    }
    const message = constructErrorMessage(error, info)
    await bot.api.sendMessage(process.env.ADMIN_ID, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
    if (info.ctx) {
      await info.ctx.forwardMessage(process.env.ADMIN_ID)
    }
  } catch (sendError) {
    console.error('Error reporting:', sendError)
  }
}

export default function report(error: unknown, info: ExtraErrorInfo = {}) {
  if (error instanceof Error) {
    void sendToTelegramAdmin(error, info)
  } else if (typeof error === 'string') {
    void sendToTelegramAdmin(new Error(error), info)
  }
}

function escape(s: string) {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;')
}
