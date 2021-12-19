enum DownloadJobStatus {
  created = 'created',
  downloading = 'downloading',
  uploading = 'uploading',
  finished = 'finished',
  failedDownload = 'failedDownload',
  failedUpload = 'failedUpload',
  unsupportedUrl = 'unsupportedUrl',
}

export default DownloadJobStatus
