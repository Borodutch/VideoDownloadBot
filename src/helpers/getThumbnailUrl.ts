import * as pathToFfmpeg from 'ffmpeg-static'
import * as sharp from 'sharp'
import * as uuid from 'uuid'
import { cwd } from 'process'
import { resolve } from 'path'
import { unlinkSync } from 'fs'
import DownloadedFileInfo from '@/models/DownloadedFileInfo'
import SimpleThumbnail from 'simple-thumbnail-ts'
import TurboDownloader from 'turbo-downloader'
import env from '@/helpers/env'
import ffmpeg = require('fluent-ffmpeg')
import Math = require('mathjs')

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
    const videoDuration = await getVideoDuration(videoPath)
    thumbnailPath = `${tempDir}/${thumbnailUuid}.jpeg`
    await new SimpleThumbnail().generate(videoPath, thumbnailPath, '320x320', {
      path: pathToFfmpeg,
      seek: videoDuration,
    })
    return thumbnailPath
  }
  thumbnailPath = await downloadThumbnail(thumbnailUrl, thumbnailUuid)

  const outputPath = `${tempDir}/${thumbnailUuid}.jpeg`
  await sharp(thumbnailPath)
    .resize({ width: 320, height: 320, fit: sharp.fit.contain })
    .toFormat('jpeg')
    .toFile(outputPath)
  unlinkSync(thumbnailPath)
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

async function getVideoDuration(videoPath: string): Promise<string> {
  return await new Promise((res) => {
    ffmpeg.ffprobe(videoPath, function (err, data) {
      if (data.format.duration) {
        const durationVideo = data.format.duration
        const hour = Math.floor(durationVideo / 3600)
        const minutes = Math.floor((durationVideo - hour * 3600) / 60)
        const seconds = Math.floor(durationVideo - hour * 3600 - minutes * 60)
        res(
          `${
            hour / 2 < 10 ? `0${(hour / 2).toFixed(0)}` : (hour / 2).toFixed(0)
          }:${
            minutes / 2 < 10
              ? `0${(minutes / 2).toFixed(0)}`
              : (minutes / 2).toFixed(0)
          }:${
            seconds / 2 < 10
              ? `0${(seconds / 2).toFixed(0)}`
              : (seconds / 2).toFixed(0)
          }`
        )
      }
    })
  })
}
