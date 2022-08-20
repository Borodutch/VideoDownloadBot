import Context from '@/models/Context'
import bot from '@/helpers/bot'
import env from '@/helpers/env'

const ignoredMessages = [
  'bot was blocked by the user',
  'is not a valid URL',
  'Unsupported URL',
  'ctx.from is not defined',
  '404: Not Found',
  'bot was kicked from the supergroup chat',
  'Bad Gateway',
  'message to edit not found',
  '410: Gone',
  'replied message not found',
  'need administrator rights in the channel chat',
  'Video unavailable',
  'No video formats found',
  'error unknown url type',
]

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
  try {
    if (
      !env.isDevelopment &&
      ignoredMessages.find((m) => error.message.includes(m))
    ) {
      return
    }
    const message = constructErrorMessage(error, info)
    await bot.api.sendMessage(env.ADMIN_ID, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
    if (info.ctx) {
      await info.ctx.forwardMessage(env.ADMIN_ID)
    }
  } catch (sendError) {
    console.error('Error reporting:', sendError)
  }
}

export default function report(error: unknown, info: ExtraErrorInfo = {}) {
  console.error(error, info)
  // if (error instanceof Error) {
  //   void sendToTelegramAdmin(error, info)
  // } else if (typeof error === 'string') {
  //   void sendToTelegramAdmin(new Error(error), info)
  // }
}

function escape(s = '') {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;')
}
