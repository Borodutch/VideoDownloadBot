import { findOrCreateDownloadJob } from '@/models/DownloadJob'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const youtubedl = require('youtube-dl-exec')

export default async function createDownloadJobAndStartDownload(
  url: string,
  audio: boolean
) {
  const { doc, created } = await findOrCreateDownloadJob(url, audio)
  if (created) {
    void startDownload(url, audio)
  }
  return doc
}

async function startDownload(url: string, audio: boolean) {
  const videoInfo = await youtubedl(url, {
    dumpSingleJson: true,
    noWarnings: true,
    noCheckCertificate: true,
    youtubeSkipDashManifest: true,
    noPlaylist: true,
    format: audio ? 'bestaudio' : 'bestvideo+bestaudio/bestaudio',
  })
  console.log(`Downloading ${url}, ${audio}`, videoInfo)
}
