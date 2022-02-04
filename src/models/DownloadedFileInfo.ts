export default interface DownloadedFileInfo {
  title: string
  ext?: string
  entries?: { ext: string }[]
  thumbnails?: {
    url: string
    height?: number
    width?: number
    format?: string
  }[]
}
