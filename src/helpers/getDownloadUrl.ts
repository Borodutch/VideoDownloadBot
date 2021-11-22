import Context from '@/models/Context'
import Format from '@/models/Format'
import constructFormatName from './constructFormatName'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const youtubedl = require('youtube-dl-exec')

export default async function getDownloadUrl(
  url: string,
  ctx: Context,
  formatId?: string
) {
  const videoInfo = await youtubedl(url, {
    dumpSingleJson: true,
    noWarnings: true,
    noCheckCertificate: true,
    youtubeSkipDashManifest: true,
    skipDownload: true,
    noPlaylist: true,
    format: !formatId
      ? ctx.dbchat.audio
        ? 'bestaudio[protocol!*=?m3u8_native]'
        : 'bestvideo[protocol!*=?m3u8_native]/bestaudio[protocol!*=?m3u8_native]'
      : undefined,
  })
  const chosenFormat: Format = formatId
    ? videoInfo.formats.find((format) => format.format_id === formatId)
    : videoInfo.requested_formats
    ? videoInfo.requested_formats[0]
    : videoInfo
  if (!chosenFormat) {
    throw new Error(
      `Chosen format ${
        formatId || ctx.dbchat.audio ? 'bestaudio' : 'bestvideo'
      } does not exist at url ${url}`
    )
  }
  return {
    downloadUrl: chosenFormat.url,
    formatId: formatId || chosenFormat.format_id,
    formatName: formatId
      ? undefined
      : constructFormatName(chosenFormat, ctx.i18n.t('megabytes')),
  }
}
