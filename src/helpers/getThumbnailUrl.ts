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
  if (!thumbnailUrl) {
    thumbnailPath = resolve(tempDir, `${thumbnailUuid}.jpeg`)
    await makeThumbnail(videoPath, thumbnailUuid)
    return thumbnailPath
  }
  thumbnailPath = await downloadThumbnail(thumbnailUrl, thumbnailUuid)

  const outputPath = `${tempDir}/${thumbnailUuid}.jpeg`
  await sharp(thumbnailPath)
    .resize({ width: 320, height: 320, fit: sharp.fit.contain })
    .toFormat('jpeg')
    .toFile(outputPath)
  unlincSyncSafe(thumbnailPath)
  return outputPath
}

async function downloadThumbnail(url: string, id: string) {
  const path = `${tempDir}/${id}`
  const downloader = new TurboDownloader({
    url,
    destFile: path,
  })
  await downloader.download()
  return path
}

async function makeThumbnail(videoPath: string, uuid: string) {
  await ffmpeg(videoPath).thumbnail({
    timestamps: ['50%'],
    filename: `${uuid}.jpeg`,
    folder: tempDir,
    size: '320x320',
  })
}
