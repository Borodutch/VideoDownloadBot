import { findOrCreateDownloadJob } from '@/models/downloadJobFunctions'
import { findOrCreateDownloadRequest } from '@/models/downloadRequestFunctions'
import Context from '@/models/Context'
import MessageEditor from '@/helpers/MessageEditor'
import augmentError from '@/helpers/augmentError'
import checkForCachedUrlAndSendFile from '@/helpers/checkForCachedUrlAndSendFile'
import downloadUrl from '@/helpers/downloadUrl'
import report from '@/helpers/report'

export default async function createDownloadJobAndRequest(
  ctx: Context,
  url: string
) {
  const { message_id } = await ctx.reply(ctx.i18n.t('download_started'), {
    reply_to_message_id: ctx.message?.message_id,
  })
  // Create message editor
  const downloadMessageEditor = new MessageEditor(message_id, ctx)
  try {
    await ctx.replyWithChatAction('typing')
    // Check cache
    try {
      // Check if the url is already in the database
      const cached = await checkForCachedUrlAndSendFile(
        url,
        ctx,
        downloadMessageEditor
      )
      if (cached) {
        return
      }
    } catch (error) {
      throw augmentError(error, 'check cache and send file')
    }
    // Create download job
    const { doc, created } = await findOrCreateDownloadJob(
      url,
      ctx.dbchat.audio,
      ctx.dbchat.telegramId,
      message_id
    )
    // Create download request
    await findOrCreateDownloadRequest(ctx.dbchat.telegramId, message_id, doc)
    // Start the download
    if (created) {
      return downloadUrl(doc)
    }
  } catch (error) {
    // Report the error to the admin
    report(error, {
      ctx,
      location: 'downloadAndSendFileToUser',
      meta: JSON.stringify({
        url,
      }),
    })
    try {
      await downloadMessageEditor.editMessageAndStopTimer(
        'error_cache_or_download_job'
      )
    } catch (error) {
      report(error, {
        ctx,
        location: 'showing error to user at downloadAndSendFileToUser',
      })
    }
  }
}
