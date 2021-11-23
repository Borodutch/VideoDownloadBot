import { findOrCreateDownloadRequest } from '@/models/DownloadRequest'
import Context from '@/models/Context'
import MessageEditor from '@/helpers/MessageEditor'
import augmentError from '@/helpers/augmentError'
import checkForCachedUrlAndSendFile from '@/helpers/checkForCachedUrlAndSendFile'
import createDownloadJobAndStartDownload from '@/helpers/createDownloadJobAndStartDownload'
import report from '@/helpers/report'

export default async function downloadAndSendFileToUser(
  ctx: Context,
  url: string
) {
  const { message_id } = await ctx.reply(ctx.i18n.t('download_started'), {
    reply_to_message_id: ctx.message?.message_id,
  })
  // Create message editor
  const downloadMessageEditor = new MessageEditor(ctx, message_id)
  try {
    // Check cache
    try {
      await ctx.replyWithChatAction('typing')
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
    const downloadJob = await createDownloadJobAndStartDownload(
      url,
      ctx.dbchat.audio
    )
    // Create download request
    await findOrCreateDownloadRequest(
      ctx.dbchat.telegramId,
      message_id,
      downloadJob
    )
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
