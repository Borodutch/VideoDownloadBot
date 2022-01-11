enum DownloadJobStatus {
  created = 'created',
  downloading = 'downloading',
  uploading = 'uploading',
  finished = 'finished',
  failedDownload = 'failedDownload',
  failedUpload = 'failedUpload',
  unsupportedUrl = 'unsupportedUrl',
  noSuitableVideoSize = 'noSuitableVideoSize',
}

export default DownloadJobStatus
