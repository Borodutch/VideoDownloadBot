import * as rimraf from 'rimraf'
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
const youtubedl = require('@borodutch-labs/yt-dlp-exec')

export default async function downloadUrl(
  downloadJob: DocumentType<DownloadJob>
) {
  const fileUuid = uuid()
  const tempDir =
    process.env.ENVIRONMENT === 'development'
      ? `${__dirname}/../../output`
      : '/var/tmp/video-download-bot'
  try {
    console.log(`Downloading url ${downloadJob.url}`)
    // Download
    const config = {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificate: true,
      youtubeSkipDashManifest: true,
      noPlaylist: true,
      format: downloadJob.audio
        ? 'bestaudio[filesize*<=2G]'
        : 'bestvideo[filesize*<=2G]+bestaudio[filesize*<=2G]/bestvideo[filesize*<=2G]/best[filesize*<=2G]/bestaudio[filesize*<=2G]',
      maxFilesize: '2048m',
      noCallHome: true,
      noProgress: true,
      output: `${tempDir}/${fileUuid}.%(ext)s`,
      mergeOutputFormat: 'mkv',
      noCacheDir: true,
      noPart: true,
    }
    const downloadedFileInfo: {
      title: string
      ext?: string
      entries?: { ext: string }[]
    } = await youtubedl(downloadJob.url, config)
    const title = downloadedFileInfo.title
    const ext =
      downloadedFileInfo.ext || downloadedFileInfo.entries?.[0]?.ext || 'mkv'
    const escapedTitle = (title || '').replace('<', '&lt;').replace('>', '&gt;')
    const filePath = `${tempDir}/${fileUuid}.${ext}`
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
    // await findOrCreateUrl(
    //   downloadJob.url,
    //   fileId,
    //   downloadJob.audio,
    //   escapedTitle || 'No title'
    // )
    downloadJob.status = DownloadJobStatus.finished
    await downloadJob.save()
  } catch (error) {
    if (downloadJob.status === DownloadJobStatus.downloading) {
      downloadJob.status = DownloadJobStatus.failedDownload
    } else if (downloadJob.status === DownloadJobStatus.uploading) {
      downloadJob.status = DownloadJobStatus.failedUpload
    }
    await downloadJob.save()
    report(error, { location: 'downloadUrl', meta: downloadJob.url })
  } finally {
    rimraf(`${tempDir}/${fileUuid}*`, (error) => {
      if (error) {
        report(error, { location: 'deleting temp files' })
      }
    })
  }
}
