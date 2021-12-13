import { Agent } from 'http'
import { Bot } from 'grammy'
import Context from '@/models/Context'
import env from '@/helpers/env'

const videoUploadBot = new Bot<Context>(env.TOKEN, {
  ContextConstructor: Context,
  client: {
    apiRoot: 'http://localhost:8081',
    baseFetchConfig: {
      compress: true,
      agent: new Agent({ keepAlive: true }),
    },
  },
})

export default videoUploadBot
