import * as sharp from 'sharp'
import * as uuid from 'uuid'
import { cwd } from 'process'
import { resolve } from 'path'
import DownloadedFileInfo from '@/models/DownloadedFileInfo'
import TurboDownloader from 'turbo-downloader'
import env from '@/helpers/env'
import unlincSyncSafe from '@/helpers/unlincSyncSafe'
import ffmpeg = require('fluent-ffmpeg')

const tempDir = env.isDevelopment
  ? resolve(cwd(), 'output')
  : '/var/tmp/video-download-bot'

export default async function getThumbnailUrl(
  downloadedFileInfo: DownloadedFileInfo,
  videoPath: string
) {
  let thumbnailUrl = ''
  const thumbnailUuid = uuid.v4()
  for (const thumbnail of downloadedFileInfo.thumbnails?.reverse() || []) {
    if (thumbnail.height && thumbnail.width) {
      thumbnailUrl = thumbnail.url
      break
    }
  }
  let thumbnailPath = ''
  thumbnailUrl = ''
  if (!thumbnailUrl) {
    const thumbName = `${thumbnailUuid}.jpeg`
    thumbnailPath = resolve(tempDir, thumbName)
    await makeThumbnail(videoPath, thumbName)
    return thumbnailPath
  }

  const outputPath = resolve(tempDir, `${thumbnailUuid}-done.jpeg`)
  thumbnailPath = await downloadThumbnail(thumbnailUrl, thumbnailUuid)
  const thumbPathDone = await resizeThumb(thumbnailPath, outputPath)
  unlincSyncSafe(thumbnailPath)
  return thumbPathDone
}

async function downloadThumbnail(url: string, id: string) {
  const path = resolve(tempDir, `${id}-downloadUrl`)
  const downloader = new TurboDownloader({
    url,
    destFile: path,
  })
  await downloader.download()
  return path
}

async function makeThumbnail(videoPath: string, filename: string) {
  await ffmpeg(videoPath).thumbnail({
    timestamps: ['50%'],
    filename,
    folder: tempDir,
  })
}

async function resizeThumb(inputPath: string, outputPath: string) {
  await sharp(inputPath)
    .resize({ width: 320, height: 320, fit: sharp.fit.contain })
    .toFormat('jpeg')
    .toFile(outputPath)
  return outputPath
}
