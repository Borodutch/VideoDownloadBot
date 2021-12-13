import { findOrCreateDownloadJob } from '@/models/downloadJobFunctions'
import { findOrCreateDownloadRequest } from '@/models/downloadRequestFunctions'
import Context from '@/models/Context'
import DownloadJobStatus from '@/models/DownloadJobStatus'
import MessageEditor from '@/helpers/MessageEditor'
import augmentError from '@/helpers/augmentError'
import checkForCachedUrlAndSendFile from '@/helpers/checkForCachedUrlAndSendFile'
import report from '@/helpers/report'

export default async function createDownloadJobAndRequest(
  ctx: Context,
  url: string
) {
  // Create message editor
  const downloadMessageEditor = new MessageEditor(undefined, ctx)
  try {
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
    // Send downloading message
    const { message_id } = await ctx.replyWithLocalization('download_started')
    downloadMessageEditor.messageId = message_id
    await ctx.replyWithChatAction(
      ctx.dbchat.audio ? 'upload_voice' : 'upload_video'
    )
    // Create download job
    const { doc: downloadJob, created } = await findOrCreateDownloadJob(
      url,
      ctx.dbchat.audio,
      ctx.dbchat.telegramId,
      message_id
    )
    // Create download request
    await findOrCreateDownloadRequest(
      ctx.dbchat.telegramId,
      message_id,
      downloadJob
    )
    // Start the download
    if (created) {
      downloadJob.status = DownloadJobStatus.downloading
      await downloadJob.save()
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
      await downloadMessageEditor.editMessage(
        ctx.i18n.t('error_cache_or_download_job')
      )
    } catch (error) {
      report(error, {
        ctx,
        location: 'showing error to user at downloadAndSendFileToUser',
      })
    }
  }
}
