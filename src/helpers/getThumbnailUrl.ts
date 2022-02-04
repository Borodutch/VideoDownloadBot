import * as sharp from 'sharp'
import { cwd } from 'process'
import { resolve } from 'path'
import DownloadedFileInfo from '@/models/DownloadedFileInfo'
import TurboDownloader from 'turbo-downloader'
import env from '@/helpers/env'

const tempDir = env.isDevelopment
  ? resolve(cwd(), 'output')
  : '/var/tmp/video-download-bot'

export default async function getThumbnailUrl(
  downloadedFileInfo: DownloadedFileInfo
) {
  let thumbUrl = ''
  for (const thumbnail of downloadedFileInfo.thumbnails?.reverse() || []) {
    if (thumbnail.height && thumbnail.width) {
      thumbUrl = thumbnail.url
      break
    }
  }
  const thumbPath = await downloadThumb(thumbUrl)
  const outputPath = `${tempDir}/${
    thumbPath.split('/')[thumbPath.split('/').length - 1]
  }.jpeg`
  sharp(thumbPath)
    .resize(320, 320)
    .toFormat('jpeg')
    .toFile(outputPath)
    .catch((err) => {
      console.log(err)
    })
  return outputPath
}

async function downloadThumb(url: string): Promise<string> {
  const id = url.split('/')[url.split('/').length - 2]
  const path = `${tempDir}/${id}`
  const downloader = new TurboDownloader({
    url,
    destFile: path,
  })
  await downloader.download().catch((err) => {
    console.log(err)
  })
  return path
}
