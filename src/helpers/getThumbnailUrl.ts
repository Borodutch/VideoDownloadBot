import * as pathToFfmpeg from 'ffmpeg-static'
import * as sharp from 'sharp'
import * as uuid from 'uuid'
import { cwd } from 'process'
import { resolve } from 'path'
import DownloadedFileInfo from '@/models/DownloadedFileInfo'
import SimpleThumbnail from 'simple-thumbnail-ts'
import TurboDownloader from 'turbo-downloader'
import env from '@/helpers/env'

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
  if (thumbnailUrl == '') {
    thumbnailPath = `${tempDir}/${thumbnailUuid}.jpeg`
    await new SimpleThumbnail().generate(videoPath, thumbnailPath, '320x3220', {
      path: pathToFfmpeg,
      seek: '00:04:01',
    })
    return thumbnailPath
  }
  thumbnailPath = await downloadThumbnail(thumbnailUrl, thumbnailUuid)

  const outputPath = `${tempDir}/${thumbnailUuid}.jpeg`
  await sharp(thumbnailPath)
    .resize(320, 320)
    .toFormat('jpeg')
    .toFile(outputPath)
  return outputPath
}

async function downloadThumbnail(url: string, id?: string) {
  const path = `${tempDir}/${id}`
  const downloader = new TurboDownloader({
    url,
    destFile: path,
  })
  await downloader.download()
  return path
}
