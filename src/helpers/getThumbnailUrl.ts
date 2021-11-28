import DownloadedFileInfo from '@/models/DownloadedFileInfo'

export default function getThumbnailUrl(
  downloadedFileInfo: DownloadedFileInfo
) {
  for (const thumbnail of downloadedFileInfo.thumbnails?.reverse() || []) {
    if (
      thumbnail.height &&
      thumbnail.width &&
      thumbnail.height <= 320 &&
      thumbnail.width <= 320
    ) {
      return thumbnail.url
    }
  }
}
