import report from './report'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const youtubedl = require('@borodutch-labs/yt-dlp-exec')

export default async function checkAvailableResolutions(url: string) {
  try {
    const json = await youtubedl(url, { dumpJson: true })

    return Array.from(
      new Set<number>(
        json.formats
          .map((f: any) => f.height)
          .filter((height: any) => height >= 144)
      )
    )
  } catch (error) {
    report(error, { location: 'checkResolutions', meta: url })
  }
}
