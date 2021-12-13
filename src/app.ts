import 'module-alias/register'
import 'reflect-metadata'
import 'source-map-support/register'

import { ignoreOld } from 'grammy-middlewares'
import { run } from '@grammyjs/runner'
import attachUser from '@/middlewares/attachUser'
import bot from '@/helpers/bot'
import cleanupDownloadJobs from '@/helpers/cleanupDownloadJobs'
import configureI18n from '@/middlewares/configureI18n'
import handleAudio from '@/handlers/audio'
import handleHelp from '@/handlers/help'
import handleLanguage from '@/handlers/language'
import handleUrl from '@/handlers/url'
import i18n from '@/helpers/i18n'
import languageMenu from '@/menus/language'
import report from '@/helpers/report'
import startMongo from '@/helpers/startMongo'

async function runApp() {
  console.log('Starting app...')
  // Mongo
  await startMongo()
  console.log('Mongo connected')
  // Cleanup download jobs
  await cleanupDownloadJobs()
  // Middlewares
  bot
    .use(ignoreOld())
    .use(attachUser)
    .use(i18n.middleware())
    .use(configureI18n)
    // Menus
    .use(languageMenu)
  // Commands
  bot.command(['help', 'start'], handleHelp)
  bot.command('language', handleLanguage)
  bot.command('audio', handleAudio)
  // Handlers
  bot.hears(
    /[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)?/i,
    handleUrl
  )
  // Catch all
  bot.use((ctx) => {
    if (ctx.chat?.type === 'private') {
      return handleHelp(ctx)
    }
  })
  // Errors
  bot.catch((botError) => {
    report(botError.error, { ctx: botError.ctx })
  })
  // Start bot
  await bot.init()
  run(bot, Infinity)
  console.info(`Bot ${bot.botInfo.username} is up and running`)
}

void runApp()
