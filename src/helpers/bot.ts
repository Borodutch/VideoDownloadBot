import { Agent } from 'http'
import { Bot } from 'grammy'
import Context from '@/models/Context'

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
