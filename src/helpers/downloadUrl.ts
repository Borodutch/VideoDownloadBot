import { DocumentType } from '@typegoose/typegoose'
import { InputFile } from 'grammy'
import { findOrCreateChat } from '@/models/Chat'
import { findOrCreateUrl } from '@/models/Url'
import { omit } from 'lodash'
import { unlinkSync } from 'fs'
import { v4 as uuid } from 'uuid'
import DownloadJob from '@/models/DownloadJob'
import DownloadJobStatus from '@/models/DownloadJobStatus'
import report from '@/helpers/report'
import sendCompletedFile from '@/helpers/sendCompletedFile'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const youtubedl = require('youtube-dl-exec')

export default async function downloadUrl(
  downloadJob: DocumentType<DownloadJob>
) {
  try {
    // Download
    const fileUuid = uuid()
    const config = {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificate: true,
      youtubeSkipDashManifest: true,
      noPlaylist: true,
      format: downloadJob.audio ? 'bestaudio' : 'bestvideo+bestaudio/bestaudio',
      maxFilesize: '2048m',
      noCallHome: true,
      noProgress: true,
      output: `/var/tmp/${fileUuid}.%(ext)s`,
      mergeOutputFormat: 'mp4',
      noCacheDir: true,
      rmCacheDir: true,
    }
    const downloadedFileInfo = await youtubedl(downloadJob.url, config)
    const { title, ext }: { title: string; ext: string } = downloadedFileInfo
    const escapedTitle = title.replace('<', '&lt;').replace('>', '&gt;')
    const filePath = `/var/tmp/${fileUuid}.${downloadJob.audio ? ext : 'mp4'}`
    await youtubedl(downloadJob.url, omit(config, 'dumpSingleJson'))
    // Upload
    downloadJob.status = DownloadJobStatus.uploading
    await downloadJob.save()
    const file = new InputFile(filePath)
    const originalChatFindResult = await findOrCreateChat(
      downloadJob.originalChatId
    )
    const originalChat = originalChatFindResult.doc
    const fileId = await sendCompletedFile(
      downloadJob.originalChatId,
      downloadJob.originalMessageId,
      originalChat.language,
      downloadJob.audio,
      escapedTitle,
      file
    )
    // Cleanup
    try {
      await unlinkSync(filePath)
    } catch (error) {
      report(error, { location: 'deleting downloaded file' })
    }
    // Finished
    await findOrCreateUrl(
      downloadJob.url,
      fileId,
      downloadJob.audio,
      escapedTitle
    )
    downloadJob.status = DownloadJobStatus.finished
    await downloadJob.save()
  } catch (error) {
    if (downloadJob.status === DownloadJobStatus.downloading) {
      downloadJob.status = DownloadJobStatus.failedDownload
    } else if (downloadJob.status === DownloadJobStatus.uploading) {
      downloadJob.status = DownloadJobStatus.failedUpload
    }
    await downloadJob.save()
    report(error, { location: 'downloadUrl' })
  }
}
