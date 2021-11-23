import { Agent } from 'http'
import { Bot } from 'grammy'
import Context from '@/models/Context'

if (!process.env.TOKEN) {
  throw new Error('Bot token is not defined')
}

const bot = new Bot<Context>(process.env.TOKEN, {
  client: {
    apiRoot: 'http://localhost:8081',
    baseFetchConfig: {
      compress: true,
      agent: new Agent({ keepAlive: true }),
    },
  },
})

export default bot
