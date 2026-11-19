import { Database } from 'bun:sqlite'
import { type Api, Bot, type Context, GrammyError, HttpError, InputFile, type Transformer } from 'grammy'
import type { ApiResponse, InputMediaVideo, Message } from 'grammy/types'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { egressProxy, proxyFreeEnv } from './egress'
import { DRAIN, pollWithHandover } from './handover'
import { type Key, t } from './i18n'
import { type Promo, promos } from './promo'
import { scratch } from './scratch'

const env = process.env
const API = env.BOT_API_URL || 'https://api.telegram.org'
// A local Bot API server takes uploads up to 2000 MB, the cloud one 50 MB
const LIMIT = (API.includes('api.telegram.org') ? 50 : 2000) * 1024 * 1024
const COOKIES = env.COOKIES || '/cookies.txt'
const DATA = env.DATA_DIR || './data'
// file:// paths only work with a local Bot API server
const SCRATCH = scratch(API.includes('api.telegram.org') ? '' : undefined)
const TMP = SCRATCH.dir
// Videos downloaded and sent at once (slots), long ones in up to 7 of them by
// default. With 4 (3 for long ones), the 3 long slots were all busy for
// 88-96% of a day's busiest 6 hours, and long videos waited up to about 3
// hours for one (#395). The sites that fill them, adult CDNs at 0.1-1.3 MB/s,
// are slow per connection (Eporner kept its speed in 5 downloads at once,
// #298), so more at once get more done.
const MAX_DOWNLOADS = Number(env.MAX_DOWNLOADS || 8)
// A minute, in ms, of the download time limits, of how old saved info may
// get, of how often a download's files are weighed and of the waits between
// self-update tries (bot.e2e.test.ts shortens it)
const MINUTE = Number(env.MINUTE_MS) || 60_000
// how long a stopped yt-dlp run gets before it's over (bot.e2e.test.ts halves it)
const GRACE = Number(env.GRACE_MS) || 5_000
// How long after a guest message was sent the bot may wait for yt-dlp to find
// a video before it answers (guest()). Telegram expires a guest query that
// has no answer ("query is too old") but doesn't say when; a guest-mode bot
// in production answers its long runs at 45 s
// (github.com/aspalagin/openclaw-telegram-guest-mode). In 48 h of job lines,
// 4 of 1,732 pages without a video took over 30 s to get and run their -J.
const GUEST_WAIT = Number(env.GUEST_WAIT_MS) || 30_000
// bot.e2e.test.ts sets GUEST_GATES to a folder: then that wait ends when the
// test lets it, as $GUEST_GATES/<the message's guest_query_id> appears
// (<guest_query_id>.held says it's waiting), instead of after GUEST_WAIT,
// so no test races that timer (deadline())
const GUEST_GATES = env.GUEST_GATES
// Only formats whose every request goes through the proxy: yt-dlp's own HTTP
// (HLS, DASH, websockets) and ffmpeg's http(s), which yt-dlp hands the proxy
// to. rtmp, rtsp and mms would connect directly.
const PROTOCOLS = `[protocol~='^(https?|m3u8(_native)?|http_dash_segments(_generator)?|f4m|ism|websocket_frag)$']`
// ffmpeg's http input lets a response turn into rtp/udp/rtsp (an SDP or a
// playlist pointing there), which would skip the proxy: keep it to these.
// Local files (merger, thumbnail) already default to file,crypto,data.
const FFMPEG_PROTOCOLS = 'http,https,tls,tcp,httpproxy,crypto,data'
// tcp and tls stay listed for http(s), but some demuxers (IMF, from an XML
// response) open such URLs on their own, direct: only HLS and its segments
const FFMPEG_FORMATS = 'hls,mpegts,mov,matroska,aac,mp3,flv,ac3,eac3,webvtt'

export const YTDLP = [
  '--no-playlist',
  '--playlist-items', '1',
  '--no-warnings',
  '--js-runtimes', 'bun',
  '-f', `bv*${PROTOCOLS}+ba${PROTOCOLS}/b${PROTOCOLS}`,
  '--downloader-args',
  `ffmpeg_i:-protocol_whitelist ${FFMPEG_PROTOCOLS} -format_whitelist ${FFMPEG_FORMATS}`,
  // h264/aac plays inline on every Telegram client
  '-S', 'vcodec:h264,res:1080,acodec:m4a',
  '--merge-output-format', 'mp4',
  // An HLS or DASH download gets 4 of its fragments at once, in the one
  // yt-dlp run its slot has: the slow sites are slow per connection
  '--concurrent-fragments', '4',
]

// The most of a post's videos that go out, an album's worth (sendMediaGroup
// takes 2-10)
export const ALBUM = 10
// How a page is read first (later options win over YTDLP's): a post's videos,
// ALBUM at most, and a playlist's links (a channel's, a set's, another site's
// embeds) listed without reading their pages
const ITEMS = ['--flat-playlist', '--playlist-items', `1:${ALBUM}`]
// What a post's videos may weigh together: they all wait on disk for the
// album, so they're held to the biggest file a local Bot API server takes
export const POST_BYTES = 2000 * 1024 * 1024

type Kind = 'video' | 'animation' | 'audio' | 'document'
type File = { kind: Kind; file_id: string; title: string; url: string }
// What a link gets: its video, or a post's videos (an album), and the title
// and link its caption shows
type Got = { files: File[]; title: string; url: string }
type Opts = Parameters<Context['api']['sendVideo']>[2] &
  Parameters<Context['api']['sendAudio']>[2]
// Where a file goes: a chat, replying to a message there, with a promo line
// or button if the user's experiment arm has one (promo.ts); sent = the id
// of the message that carried it (an album's first), more = an album's
// others; stale = a cached video that went out
// without a size, being downloaded again to replace it: that message and
// its file_id; who = the user who asked, whose jobs take turns with everyone
// else's (limit); uploading = its own job has begun the upload; single = it
// shows one file (a guest reply), so a post's cached files go as its first
// one alone
type Dest = {
  chat: number | string
  reply?: number
  sent?: number
  more?: number[]
  promo?: Promo
  stale?: { message: number; file_id: string }
  who?: number
  uploading?: boolean
  single?: boolean
}
// Guest replies can't upload, so their files go through this chat first
// (the message is deleted right after, the file_id stays valid)
const STORAGE = env.STORAGE_CHAT || env.ADMIN_ID

// Thrown with the message to show; null = not a video, stay quiet in groups
export class Fail extends Error {
  constructor(public key: Key | null, why = key ?? 'not a video') {
    super(why)
  }
}

// News sites' extractors, which claim plain article URLs (not their video,
// live and embed pages)
const NEWS = /^(?!.*(video|live|embed)).*(article|news)|^(bbc|cnn|spiegel|voxmedia|lenta)$/i

// Whether a yt-dlp error means the page has no video rather than a video
// that failed: the generic extractor on any page (no such site, 403, nothing
// embedded) or a site saying so. Not getting or not parsing the page only
// counts from a news extractor (NYT, Spiegel, Vox on an article without
// media); on a video site it's a real failure. Crashes carry no [extractor]
// tag, so ies = the extractors that claim the link.
export function notVideo(why: string, ies: string[] = []) {
  if (/unsupported url|no video|no media|media blocks|\[generic\]/i.test(why))
    return true
  if (!/unable to (download webpage|extract|find)|extractor error has occurred/i.test(why))
    return false
  const tag = why.match(/^(?:ERROR: )?\[([^\]]+)\]/)?.[1]
  const by = tag ? [tag] : ies
  return by.length > 0 && by.every((ie) => NEWS.test(ie))
}

// Whether a failed -J's error (why, ies as for notVideo()) is the site's own
// word that its page has nothing for the link now: an extractor's error (its
// name has no space: "[Errno 28]" is the disk, and the one-file build's own
// lines don't start with "ERROR: ") or a page without a video, unless the
// request never got a page (the network, the proxy, TLS, a page cut short),
// the site failed (a 5xx) or yt-dlp did (a bug it asks to have reported). An
// error yt-dlp prints over several lines (a geo block's ends in a tip) is
// judged by its last, untagged one.
export const sitesWord = (why: string, ies: string[] = []) =>
  (/^ERROR: \[[^\]\s]+\] /.test(why) || notVideo(why, ies)) &&
  !/\(caused by (\w*(Transport|Proxy|SSL|CertificateVerify)Error\(|<IncompleteRead|<HTTPError 5\d\d)|please report this issue/i.test(why)

// A stream that hasn't started makes yt-dlp -J fail: YouTube's own reasons
// ("This live event will begin in 5 hours.", "Premieres in 3 hours") and
// other sites' extractor messages ("This livestream has not yet started").
// An offline channel ("The channel is not currently live") stays a failure:
// nothing says a stream is coming.
const UPCOMING = /live event will begin|: premieres?\b|(stream|event|broadcast|space)\b.* not (yet )?started|not started yet|event will start at|scheduled for/i

// 'upcoming' for a yt-dlp error saying the stream hasn't started, else null
export const unstarted = (why: string): Key | null =>
  UPCOMING.test(why) ? 'upcoming' : null

// What to say about a stream yt-dlp can't download yet, or null: live now,
// or announced and not started. A stream that just ended (post_live) is
// tried like a video.
export const unready = (v: any): Key | null =>
  v.is_live || v.live_status === 'is_live'
    ? 'live'
    : v.live_status === 'is_upcoming'
      ? 'upcoming'
      : null

// The video in what yt-dlp -J printed, or Fail(null) when there is none
export function picked(info: any) {
  // yt-dlp prints null when the page had nothing (a t.me text post)
  if (!info) throw new Fail(null, 'nothing extracted')
  // YouTube playlists, channels and feeds (WL, LL, history) would hand out
  // what the logged-in cookies can see; --no-playlist already reduces
  // watch?v=…&list=… to the video. Multi-video posts elsewhere stay.
  if (info._type === 'playlist' && /^youtube/i.test(info.extractor_key))
    throw new Fail(null, 'youtube playlist')
  // an article page without media is an empty playlist (BBC, CNN)
  if (info._type === 'playlist' && !info.entries?.[0])
    throw new Fail(null, 'empty playlist')
  return info.entries?.[0] ?? info
}

// Lists whose videos yt-dlp reads whole rather than as links: a Pinterest
// board, a list of pins (the pin pages it would read). A list isn't a post:
// its first video goes out alone, as a list of links' does.
const LISTS = /^PinterestCollection$/

// The videos to send in what yt-dlp -J printed with ITEMS: the one, or a
// post's (an Instagram carousel, an X post, a page with several <video>s),
// each once, ALBUM at most, or a list's first one (LISTS); null for a
// playlist of links, or a multi_video (one video in parts) whose first part
// --flat-playlist left a link, whose first one is read as before (picked()),
// and Fail(null) for none. An item yt-dlp couldn't read is null in it (a
// picture in a carousel has no video).
export function picks(info: any): any[] | null {
  if (info?._type !== 'playlist') {
    const v = picked(info)
    return isVideo(v) ? [v] : null
  }
  if (/^youtube/i.test(info.extractor_key)) throw new Fail(null, 'youtube playlist')
  const entries: any[] = (info.entries ?? []).filter(Boolean)
  if (!entries.length) throw new Fail(null, 'empty playlist')
  if (!entries.every(isVideo)) return null
  if (LISTS.test(info.extractor_key)) return entries.slice(0, 1)
  return [...new Map(entries.map((v) => [cacheKey(v), v])).values()].slice(0, ALBUM)
}

// Whether what a failed -J printed is a post with a video: yt-dlp goes on
// past an item it can't read (a picture, a multi_video's part), prints the
// rest and exits 1
export function posted(out: string | undefined) {
  try {
    const info = JSON.parse(out ?? '')
    return /^(playlist|multi_video)$/.test(info?._type) && (info.entries ?? []).some((v: any) => v && isVideo(v))
  } catch {
    return false
  }
}

// A tweet with only text or pictures: shared everywhere, never worth an answer
const TWEET_NO_VIDEO = /\[twitter\].*no video could be found/i

// What to tell the chat about a failed link, null = nothing. "Not a video"
// only gets an answer from whoever asked the bot itself.
export const answer = (key: Key | null, chat: string, called: boolean, why = '') =>
  TWEET_NO_VIDEO.test(why) ? null : key ?? (chat === 'private' || called ? 'failed' : null)

// What a guest message that doesn't mention the bot hears about a failed link
// before it has had an answer, null = nothing: what a group message would
// without a status up (guest()). That's not even the restart that dropped the
// link, whose page may have no video.
export const unasked = (key: Key | null, why = '') => {
  const told = answer(key, 'guest', false, why)
  return told === 'restarting' ? null : told
}

// Calls f in ms, when the answer to guest message id can't wait any longer
// (guest()), or with GUEST_GATES once the test lets it: never in the turn
// that sets it, so what that turn's own promises note comes first. Returns
// what calls it off.
export function deadline(id: string, ms: number, f: () => void) {
  if (!GUEST_GATES) {
    const timer = setTimeout(f, Math.max(0, ms))
    return () => clearTimeout(timer)
  }
  const gate = join(GUEST_GATES, id)
  let on = true
  const off = () => {
    on = false
    rmSync(`${gate}.held`, { force: true })
  }
  writeFileSync(`${gate}.held`, '')
  void (async () => {
    do await Bun.sleep(20)
    while (on && !existsSync(gate))
    if (!on) return
    off()
    f()
  })()
  return off
}

// Whether a chat hears that its link waits for a slot, or that a restart
// dropped it. Groups only do when they asked the bot itself: a burst of links
// there would become a burst of replies on top of the videos, and Telegram
// allows a group ~20 messages a minute (a 429 isn't retried).
export const tellQueued = (chat: string, called: boolean) => chat === 'private' || called

// t.me/s/<channel>/<post> is the channel's web preview, which yt-dlp reads
// as a list of the latest posts: the post itself is t.me/<channel>/<post>
const tme = (url: URL) => {
  if (/^(t|telegram)\.me$/i.test(url.hostname))
    url.pathname = url.pathname.replace(/^\/s\/([^/]+\/\d+)/, '/$1')
  return url
}

export function urls(msg: Message) {
  const text = msg.text ?? msg.caption ?? ''
  const found = (msg.entities ?? msg.caption_entities ?? []).flatMap((e) =>
    e.type === 'url'
      ? [text.slice(e.offset, e.offset + e.length)]
      : e.type === 'text_link'
        ? [e.url]
        : [],
  )
  return [
    ...new Set(
      found.flatMap((u) => {
        try {
          const url = tme(new URL(/^\w+:\/\//.test(u) ? u : `https://${u}`))
          return /^https?:$/.test(url.protocol) && isPublic(url.hostname)
            ? [url.href]
            : []
        } catch {
          return []
        }
      }),
    ),
  ]
}

// Called on by an @mention
export const summoned = (msg: Message, username: string) =>
  new RegExp(`@${username}\\b`, 'i').test(msg.text ?? msg.caption ?? '')

// The bot, as getMe has it, and whether a file (its file_unique_id) is the
// bot's: one it has sent
type Me = { id: number; username: string; mine: (file: string) => boolean }

// The bot's own message: a forward of one, one sent through it (inline), or
// one with a file the bot has sent. A forward that hides the sender's name,
// or a copy a client or another bot makes, comes as the sender's own message
// with nothing of the bot's left but the file, whose file_unique_id is the
// same in every chat. Its videos' captions have the link and the @mention
// that ask it for the video, so its video forwarded into another chat it's
// in would go out there twice.
export const own = (msg: Message, me: Me) => {
  const file = msg.video ?? msg.animation ?? msg.audio ?? msg.document
  return (
    msg.via_bot?.id === me.id ||
    (msg.forward_origin?.type === 'user' && msg.forward_origin.sender_user.id === me.id) ||
    (!!file && me.mine(file.file_unique_id))
  )
}

// Also the links in the message replied to when the bot is summoned. The
// bot's own messages ask for nothing, as the message or the one replied to.
export function links(msg: Message, me: Me) {
  if (own(msg, me)) return []
  const reply = summoned(msg, me.username) ? msg.reply_to_message : undefined
  const theirs = reply && reply.from?.id !== me.id && !own(reply, me) ? urls(reply) : []
  return [...new Set([...urls(msg), ...theirs])]
}

// Extractors that claim links without being a site's video extractor: the
// generic one takes any page, the others only refuse (Spotify, Netflix, …)
const NOT_SITES = new Set(['generic', 'DRM', 'Piracy', 'Liability'])

// Each link's own-site yt-dlp extractors. Decided from the URLs alone,
// nothing is fetched: --list-extractors prints each extractor with the URLs
// it matches below it.
export async function claims(urls: string[]) {
  const by = new Map<string, string[]>()
  if (!urls.length) return by
  const { out } = await check.run(() => ytdlp(['--list-extractors', '--', ...urls]))
  let ie = ''
  for (const line of out.split('\n'))
    if (!line.startsWith(' ')) ie = line.replace(/ \(CURRENTLY BROKEN\)$/, '')
    else if (!NOT_SITES.has(ie)) by.set(line.trim(), [...(by.get(line.trim()) ?? []), ie])
  return by
}

// The links a site's own extractor claims
export async function videos(urls: string[]) {
  const by = await claims(urls)
  return urls.filter((u) => by.has(u))
}

// What a message asks to download. In groups a link mentioned in passing
// (a bare domain, an article) isn't a request: unless the bot is summoned,
// only links to a site yt-dlp knows count. The same goes for a guest message
// (chat 'guest') in any chat, a private one too: Telegram calls the bot on a
// plain reply to one of its messages as well, mention or not.
export async function requested(
  msg: Message,
  me: Me,
  chat: string,
  video = videos,
) {
  const found = links(msg, me)
  return chat === 'private' || summoned(msg, me.username) || !found.length
    ? found
    : video(found)
}

// First line against links into the docker network: no IP literals (the URL
// parser normalizes 2130706433 and 0x7f.1 to 127.0.0.1), no dotless service
// names, no local-only TLDs. Redirects and public names that resolve inside
// are stopped by the egress proxy yt-dlp goes through (egress.ts).
function isPublic(host: string) {
  host = host.replace(/\.$/, '') // "name." is the same docker service
  return (
    host.includes('.') &&
    !host.startsWith('[') &&
    !/^[\d.]+$/.test(host) &&
    !/\.(localhost|local|internal|lan|home\.arpa)$/i.test(host)
  )
}

let proxy: Promise<string> | undefined
// YouTube blocks the server's own address (#415), so its hosts go out through
// Cloudflare WARP: WARP_PROXY is the videodownloadbot-warp service's HTTP proxy
// (host:port, wireproxy from the Dockerfile's warp stage)
export const YOUTUBE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com|ytimg\.com)\.?$/i
const warp = (host: string) => (env.WARP_PROXY && YOUTUBE.test(host) ? env.WARP_PROXY : undefined)
// ponytail: in-process daily self-update; pin a version if nightly ever breaks
// The update swaps the binary out, so a run started meanwhile waits for it
// (else spawn fails with "Executable not found"); it takes seconds, and a
// hung one can't hold every download back for long. A run already going may
// still fail on the swap, as the one-file yt-dlp reads its modules from the
// binary's path while it imports them: the daily update swaps it while jobs
// run, and so does a retry after a failed first try (selfUpdate).
let updating: Promise<unknown> = Promise.resolve()
// One try at it: yt-dlp's exit code, or null when the time limit's SIGTERM
// stopped it (PyInstaller's bootloader hands that on to yt-dlp and then dies
// by it too). Another signal (an OOM kill) gives an exit code like any
// failure. cmd and limit differ only in tests.
export const updateOnce = (cmd = ['yt-dlp', '--update-to', 'nightly'], limit = 5 * 60_000) => {
  const p = Bun.spawn(cmd, {
    env: { ...process.env, ...SCRATCH.env },
    stdout: 'inherit',
    timeout: limit,
    killSignal: 'SIGTERM',
  })
  const tried = p.exited.then((code) => (p.signalCode === 'SIGTERM' ? null : code))
  updating = tried
  return tried
}

// The minutes from a failed self-update to its next try. GitHub refuses
// yt-dlp's version check (HTTP 403 "rate limit exceeded") once the address
// the bot shares has used up its hourly API limit, which renews within the
// hour, so the last retry comes just over an hour after the first try (#416).
const UPDATE_RETRIES = [1, 2, 4, 8, 16, 32]

// Updates yt-dlp to the newest nightly: run() is one try, resolving to
// yt-dlp's exit code (null when the time limit stopped it). A failed try goes
// again after each of waits (ms) in turn, until one works, and every failure
// leaves a log line. After one that ran out of time, only the last (longest)
// wait's try is left: a try that's running holds yt-dlp runs back (updating;
// at the start, polling), so that one held them for 5 minutes, and one right
// after might too. yt-dlp gives up on a server that doesn't answer within
// 20 s, so it takes a transfer that trickles or a stuck run. first = the
// first try's result; retries = the whole update, over once a try has worked
// or none is left. pause is Bun.sleep and log console.error but in tests.
export function selfUpdate(
  run: () => Promise<number | null>,
  waits = UPDATE_RETRIES.map((m) => m * MINUTE),
  pause: (ms: number) => Promise<unknown> = Bun.sleep,
  log: (line: string) => void = console.error,
) {
  const first = run()
  const retries = (async () => {
    let code = await first
    for (let i = 0; code !== 0; i++) {
      if (code === null) i = Math.max(i, waits.length - 1)
      const ms = waits[i]
      const next = ms === undefined ? 'next try tomorrow' : `retry ${i + 1}/${waits.length} in ${+(ms / 60_000).toFixed(1)} min`
      log(`yt-dlp update ${code === null ? 'timed out' : `failed (${code})`}, ${next}`)
      if (ms === undefined) return
      await pause(ms)
      code = await run()
    }
  })().catch(console.error)
  return { first, retries }
}

// yt-dlp ran out of time and was stopped
export class Timeout extends Error {}

// yt-dlp failed: its last line, and what it printed all the same (out) and
// said (err)
export class Exited extends Error {
  constructor(why: string, public out: string, public err: string) {
    super(why)
  }
}

// The yt-dlp runs going now, each with a way to end its whole group at once:
// an e2e bot whose test process is gone ends them as it exits (below)
const runs = new Set<() => void>()

// Runs yt-dlp, stopped after timeout ms or once signal aborts: then a Timeout
// or the abort's reason is thrown, unless yt-dlp still exits 0 and its output
// closes within 5 s of the stop
async function ytdlp(args: string[], timeout = 30 * 60_000, signal?: AbortSignal) {
  // a failed listen isn't kept: the next download tries again
  proxy ??= egressProxy(undefined, undefined, warp).catch((e) => {
    proxy = undefined
    throw e
  })
  await updating
  const via = await proxy
  // an abort while it waited (a self-update) won't come again
  signal?.throwIfAborted()
  // In a process group of its own: yt-dlp hands m3u8 and some HLS downloads
  // to ffmpeg, which inherits its pipes and goes on when yt-dlp alone is
  // stopped, so a stop stops the whole group
  const p = Bun.spawn(['yt-dlp', '--proxy', via, ...args], {
    env: { ...proxyFreeEnv(), ...SCRATCH.env },
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  })
  // the group, or yt-dlp alone if there's no group; none once the run is
  // over, whatever timer or abort comes late (its number could lead another
  // group by then)
  let over = false
  const kill = (sig: NodeJS.Signals) => {
    if (over) return
    try {
      process.kill(-p.pid, sig)
    } catch {
      p.kill(sig)
    }
  }
  const end = () => kill('SIGKILL')
  runs.add(end)
  // why the run was stopped, the first time: SIGTERM, and GRACE (5 s) later
  // the run is over, even if something still holds the pipes
  let stopped: Error | undefined
  const cutoff = Promise.withResolvers<void>()
  const timers: ReturnType<typeof setTimeout>[] = []
  const stop = (why: Error) => {
    if (stopped) return
    stopped = why
    kill('SIGTERM')
    timers.push(setTimeout(cutoff.resolve, GRACE))
  }
  timers.push(
    setTimeout(
      () => stop(new Timeout(`yt-dlp timed out after ${+(timeout / 60_000).toFixed(1)} min`)),
      timeout,
    ),
  )
  const abort = () => stop(signal!.reason)
  signal?.addEventListener('abort', abort)
  try {
    const run = await Promise.race([
      Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]),
      cutoff.promise,
    ])
    if (!run || (run[2] && stopped)) throw stopped
    const [out, err, code] = run
    if (code) throw new Exited(err.trim().split('\n').pop() || `yt-dlp ${code}`, out, err)
    return { out, err }
  } finally {
    // Then whatever is left of a stopped run's group gets SIGKILL, whether
    // it holds the pipes or not (a merge's ffmpeg doesn't). While anything is
    // left no other group can have the number, and since pids are handed out
    // in turn, neither can one just after the last of it is gone
    if (stopped) kill('SIGKILL')
    over = true
    runs.delete(end)
    signal?.removeEventListener('abort', abort)
    for (const t of timers) clearTimeout(t)
  }
}

// The page at url read, in timeout ms: -J with ITEMS, which a post's
// pictures fail but whose videos it still prints (posted()), or for a
// playlist of links -J as before, its first one read. json = what the -J
// that picked them printed, picks = the videos (picks()), partial = an item
// of a post failed for another reason than being a picture (yt-dlp found no
// video in it): the post read again may have it, so its link isn't cached.
// A playlist's first one, read alone, is whole whatever its other items did.
async function read(args: string[], url: string, timeout: number) {
  const until = Date.now() + timeout
  let partial = false
  const json = await ytdlp([...args, ...ITEMS, '-J', url], timeout).then(
    (r) => r.out,
    (e) => {
      if (!(e instanceof Exited && posted(e.out))) throw e
      // a multi_video sends its first part alone, whatever its others are,
      // and a list (LISTS) its first video
      const info = JSON.parse(e.out)
      partial =
        info._type === 'playlist' &&
        !LISTS.test(info.extractor_key) &&
        (e.err.match(/^ERROR:.*$/gm) ?? []).some((line) => !/no video formats found/i.test(line))
      return e.out
    },
  )
  const all = picks(JSON.parse(json))
  if (all) return { json, picks: all, partial }
  const first = (await ytdlp([...args, '-J', url], until - Date.now())).out
  return { json: first, picks: [picked(JSON.parse(first))], partial: false }
}

type Size = { width: number; height: number }

// The size a player shows a video stream at (ffprobe's stream entry): the
// coded size stretched by the sample aspect ratio, turned by the rotation
export function shown(s: any): Size | undefined {
  if (!(s?.width > 0 && s?.height > 0)) return
  // "0:1" or "N/A" = unknown, square pixels
  const [n, d] = String(s.sample_aspect_ratio).split(':').map(Number)
  const width = n > 0 && d > 0 ? Math.round((s.width * n) / d) : s.width
  const rotation = Number(
    s.side_data_list?.find((x: any) => x.rotation !== undefined)?.rotation ??
      s.tags?.rotate ??
      0,
  )
  return Math.abs(rotation) % 180 === 90
    ? { width: s.height, height: width }
    : { width, height: s.height }
}

// Telegram draws the player box from sendVideo's width/height and ignores the
// file's pixel aspect: they come from the file itself, since yt-dlp often has
// none (Instagram's progressive mp4s) or another format's
export async function probe(path: string) {
  const p = Bun.spawn(
    [
      'ffprobe', '-v', 'error', '-select_streams', 'V:0',
      '-show_entries', 'stream=width,height,sample_aspect_ratio:stream_side_data=rotation:stream_tags=rotate',
      '-of', 'json', path,
    ],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  if (code) return
  try {
    return shown(JSON.parse(out).streams?.[0])
  } catch {
    return
  }
}

// The thumbnail's filter: square pixels first (ffmpeg has already applied
// the rotation), then within 320x320
export const THUMB = "scale='iw*sar':ih,scale=320:320:force_original_aspect_ratio=decrease"

// What a downloaded file at path goes out with but its caption: the box a
// player shows it in, from the file itself (probe()), its length, a
// thumbnail made into thumb, and an audio file's title and performer
async function looks(path: string, v: any, thumb: string, title: string) {
  const audio = v.vcodec === 'none'
  const box = audio ? undefined : await probe(path)
  if (!audio)
    await Bun.spawn([
      'ffmpeg', '-v', 'error', '-y',
      '-ss', String(Math.min(1, (v.duration ?? 0) / 2)),
      '-i', path,
      '-frames:v', '1',
      '-vf', THUMB,
      thumb,
    ]).exited
  return {
    width: box?.width ?? v.width ?? undefined,
    height: box?.height ?? v.height ?? undefined,
    duration: v.duration ? Math.round(v.duration) : undefined,
    thumbnail: existsSync(thumb) ? new InputFile(thumb) : undefined,
    title: audio ? title : undefined,
    performer: audio ? v.uploader : undefined,
  }
}

// A new file rather than a cached file_id (a local file:// path is new too)
export const fresh = (f: string | InputFile) =>
  typeof f !== 'string' || f.startsWith('file:')

// Runs at most max fns at once, long ones at most maxLong of them, the rest
// wait their turn. who = whose fn (a user): one user's fns get at most
// max - 1 turns, and long ones maxLong - 1 (all of them when there's only
// one), so a burst of one user's links always leaves someone else a turn; a
// free turn goes to the first in line among those with the fewest running
// whose fn fits. Fns without a who share no such limit. A fn in line holds
// nothing. spare() takes a turn only if one is free (a post's other videos,
// postJob()).
export function limit(max: number, maxLong = max) {
  let running = 0
  let long = 0
  // each user's running fns: all of them and the long ones
  const per = new Map<unknown, { all: number; long: number }>()
  const mine = (who: unknown) => per.get(who) ?? { all: 0, long: 0 }
  const add = (who: unknown, isLong: boolean, n: number) => {
    running += n
    if (isLong) long += n
    const m = mine(who)
    const now = { all: m.all + n, long: m.long + (isLong ? n : 0) }
    if (now.all) per.set(who, now)
    else per.delete(who)
  }
  // one user's part of n turns
  const share = (n: number) => Math.max(1, n - 1)
  const fits = (who: unknown, isLong: boolean) => {
    const m = mine(who)
    return (
      running < max &&
      !(isLong && long >= maxLong) &&
      (who === undefined || (m.all < share(max) && !(isLong && m.long >= share(maxLong))))
    )
  }
  // Nothing in line fits: ended turns go to the ones that do (one ending can
  // let in two: one its user's part held back, and one more), so a new fn
  // that fits jumps nobody who could run
  const queue: { who: unknown; long: boolean; go: () => void; stop: (e: Error) => void }[] = []
  let closed: Error | undefined
  // Waits for a turn; the returned fn ends it
  const take = async (who?: unknown, isLong = false) => {
    if (closed && (isLong || !fits(who, isLong))) throw closed
    if (fits(who, isLong)) add(who, isLong, 1)
    else await new Promise<void>((go, stop) => queue.push({ who, long: isLong, go, stop })) // counted in by whoever hands over
    return ender(who, isLong)
  }
  // what ends a turn of who's
  const ender = (who: unknown, isLong: boolean) => {
    let done = false
    return () => {
      if (done) return
      done = true
      add(who, isLong, -1)
      for (;;) {
        let next = -1
        queue.forEach((w, i) => {
          if (fits(w.who, w.long) && (next < 0 || mine(w.who).all < mine(queue[next]!.who).all))
            next = i
        })
        if (next < 0) return
        const w = queue.splice(next, 1)[0]!
        add(w.who, w.long, 1)
        w.go()
      }
    }
  }
  return {
    take,
    // A turn now, if one is free for who's fn (none once closed: a restart
    // starts nothing it needn't), and what ends it; else undefined. Nobody in
    // line could have it: a turn that ends goes to them first.
    spare(who?: unknown, isLong = false) {
      if (closed || !fits(who, isLong)) return
      add(who, isLong, 1)
      return ender(who, isLong)
    },
    async run<T>(fn: () => Promise<T>, who?: unknown) {
      const done = await take(who)
      try {
        return await fn()
      } finally {
        done()
      }
    },
    // whether a new fn of who's would have to wait (once closed, it fails or
    // starts at once)
    busy: (isLong = false, who?: unknown) => !closed && !fits(who, isLong),
    // the fns in line when a new one asks, other users' that wait only for
    // their own part included: long ones only count for a short one while
    // they could have a turn
    waiting: (isLong = false) =>
      queue.filter((w) => isLong || !w.long || long < maxLong).length,
    // How many of who's fns, long or short, have a turn or wait in line for
    // one: with none, a new fn of theirs that has to wait waits for other
    // users' fns alone. Fns without a who share no part and count none.
    own: (who: unknown) =>
      who === undefined ? 0 : mine(who).all + queue.filter((w) => w.who === who).length,
    // Fails the fns still waiting with e, and later ones that would have to
    // wait or are long (a restart has time for a short one); running ones go on
    close(e: Error) {
      closed = e
      for (const w of queue.splice(0)) w.stop(e)
    },
  }
}

// What yt-dlp says the formats it picked weigh (video and audio, or the one),
// undefined for one it doesn't say
type Weighed = { filesize?: number | null; filesize_approx?: number | null }
export const sizes = (v: Weighed & { requested_formats?: Weighed[] }) =>
  (v.requested_formats ?? [v]).map((f) => f.filesize || f.filesize_approx || undefined)
// what of that yt-dlp says
const weight = (v: Parameters<typeof sizes>[0]) => sizes(v).reduce<number>((all, n) => all + (n ?? 0), 0)

// Why a video yt-dlp picked can't be sent, if it can't: it's a stream that
// can't be downloaded yet, or yt-dlp says it's too big
export function unfit(v: any) {
  const stream = unready(v)
  if (stream) return new Fail(stream, `${stream} stream`)
  if (weight(v) > LIMIT) return new Fail('tooBig')
}

// Long videos: over 10 minutes. One that doesn't say how long it is counts as
// long too (an HLS/DASH stream or a file of unknown length can take 20-40
// minutes), unless it's from Instagram or an X post, whose reels and GIFs
// usually don't say and come in seconds, or yt-dlp says what all of it weighs
// and that's 100 MB at most (typically under 2 minutes). X is the Twitter key
// alone: TwitterBroadcast and TwitterSpaces are long HLS replays.
export const LONG = 10 * 60
export const SMALL = 100 * 2 ** 20
const QUICK = /^(Instagram\w*|Twitter)$/
export const isLong = (
  v: Parameters<typeof sizes>[0] & { duration?: number | null; extractor_key?: string },
) => {
  if (v.duration && v.duration > 0) return v.duration > LONG
  if (QUICK.test(v.extractor_key ?? '')) return false
  const s = sizes(v)
  return s.includes(undefined) || s.reduce<number>((all, n) => all + n!, 0) > SMALL
}

// The minutes a job may spend downloading: 45 for a long video, else 30. Some
// sites (adult CDNs) serve one connection at about 1-1.3 MB/s, where the
// biggest file a local Bot API takes (2000 MB) can need about 35 minutes, and
// a flat 30 cut off about 8 downloads a day, mostly from such sites (#298).
// With two or more slots long videos leave short ones a slot, so the longer
// limit mostly holds up other long ones.
export const downloadMinutes = (long: boolean) => (long ? 45 : 30)

// yt-dlp's saved info over a minute old: its media links may have expired
// while the job waited its turn
export const stale = (age: number) => age > MINUTE
// Whether a download from stale saved info that failed gets another try that
// reads the page again, in the time the job has left: when over a minute is
// (none is, after a timeout)
export const reread = (age: number, left: number) => stale(age) && left > MINUTE

// Whether the page read again picks the file(s) the failed try got part of.
// yt-dlp's --continue goes on from whatever file has the name it's about to
// write, a .part by its bytes (an HTTP Range request) and a .ytdl by its
// fragment index, without asking which format that came from, and one
// format's name is the extension alone (v.mp4.part): another format's bytes
// or fragments would be appended to the first one's. The same pick is of the
// same video (a multi-video post's first one may change) and has formats with
// the same ids and encodings: yt-dlp numbers the formats a site gives no id
// of their own (0, 1, … in its order, hls-N), so an id alone could name
// another file. Each format also has the same exact size, or where yt-dlp
// doesn't know it, the same link. On a site yt-dlp has an extractor for,
// that's up to the query, where signatures that change with every read
// usually go: the video's id is the site's, and its format ids and encodings
// tell its files apart. A page it reads with its generic extractor (GENERIC)
// is another matter: the id comes from the page's address, and a <video>
// there has a format with nothing but its index, ext and protocol, so its
// whole link is all that tells another clip apart, the query too (a page may
// pick its clip by it: /stream?clip=…). A link whose host or path changes
// between the reads (a CDN that answers from another server, a signature in
// the path), or on a generic page its query, starts over: safe, but slower.
// A link that stays the same while the file behind it changes can't be told.
const ENCODING = ['format_id', 'ext', 'protocol', 'width', 'height', 'tbr', 'vcodec', 'acodec']
// yt-dlp's generic extractor and the embeds it finds on pages, whose video id
// isn't a site's own: it's the page's (the HTML5 and quoted-HTML ones, by
// _generic_id), the file's name without its extension and query (WordPress
// players, Camtasia) or a page widget's (Elementor), and their formats may
// have nothing but a link (yt-dlp 2026.08.19)
const GENERIC =
  /^(Generic|HTML5MediaEmbed|QuotedHTML|ElementorEmbed|WordpressPlaylistEmbed|WordpressMiniAudioPlayerEmbed|CamtasiaEmbed)$/
// a link without its #fragment, and its query unless whole
const link = (url: unknown, whole: boolean) =>
  typeof url === 'string' ? url.split(whole ? '#' : /[?#]/)[0] : null
const files = (v: any) => {
  const whole = GENERIC.test(v.extractor_key)
  return [
    v.extractor_key,
    v.id,
    (v.requested_formats ?? [v]).map((f: any) => [
      ...ENCODING.map((k) => f[k] ?? null),
      f.filesize || link(f.url, whole),
    ]),
  ]
}
// Whether yt-dlp downloads a pick from its saved info: a video, not a
// playlist (one a multi-video post's -J may have as its first entry)
const isVideo = (v: any) => (v._type ?? 'video') === 'video'
// What a download from saved info gets: the video picked, alone. yt-dlp loads
// saved info without its entries (--clean-info-json), so from a multi-video
// post's -J (a playlist of its first video, --playlist-items 1) it would have
// nothing to download but the page, which it reads again itself and goes on
// in, --continue, from whatever that picks. A pick that's a playlist goes as
// -J printed it (json): its page is read again either way.
export const saved = (v: any, json: string) => (isVideo(v) ? JSON.stringify(v) : json)
// so the same pick is a video, judged as it's downloaded
export const samePick = (a: any, b: any) =>
  isVideo(a) && isVideo(b) && JSON.stringify(files(a)) === JSON.stringify(files(b))

// The key a video's file is cached under, whatever link led to it
const cacheKey = (v: any) => `${v.extractor_key}:${v.id}`

// What a link that gets one video gets
const one = (f: File): Got => ({ files: [f], title: f.title, url: f.url })

// The slots for downloading and sending videos. Long ones (20-40 min each on
// some sites) take at most MAX_DOWNLOADS - 1 of them (with one slot, that
// one), so long downloads never hold every slot; one user's get one fewer
// when there are more (limit), so another user's long video doesn't wait for
// theirs either. The whole download and upload holds a slot:
// a link flood can't fork unbounded yt-dlp runs or pile finished files up in
// TMP while uploads crawl
const slots = limit(MAX_DOWNLOADS, Math.max(1, MAX_DOWNLOADS - 1))
// yt-dlp -J, which tells a job's lane, runs before it takes a slot
const meta = limit(MAX_DOWNLOADS)
// The links of a group or guest message that doesn't mention the bot are
// checked one yt-dlp run per message (requested()), and a job whose -J fails
// without an extractor's tag checks its link (claims()): a flood of them
// queues instead of forking a process each. A guest message's wait here
// counts against the time its answer may wait (GUEST_WAIT).
const check = limit(2)

// The signal of a progress message, which isn't worth a flood wait. grammY's
// Node typings have an AbortSignal of their own, which a real one fits.
type Signal = NonNullable<Parameters<Api['sendMessage']>[3]>
export const PROGRESS = new AbortController().signal as unknown as Signal

// The Bot API client's fetch: grammY's own (its node-fetch is Bun's fetch in
// Bun), made to see a web server's 413 through. The nginx in front of the
// cloud Bot API refuses an album too big for one request with an HTML page,
// which nginx sends as soon as the upload passes its limit, nothing of it
// sent. Bun then stops the upload and would end grammY's form-data stream
// with an error, which grammY takes for the call failing before its answer.
// So Bun gets the stream pulled by hand, and what's left of it closes
// without an error when Bun stops the upload (the connection closed or
// reset, the call timed out), not when the answer's headers come: its body
// may come after them. grammY can't read the page either, so the 413
// reaches it as the Bot API's own JSON one, the upload's rest closed: a
// refusal, and album() sends the files one by one. Any other page still
// fails the call without its status, as a 5xx one should: the request may
// have gone through.
export async function apiFetch(url: string, init: RequestInit) {
  const body: unknown = init.body
  const rest = body instanceof Readable ? body : undefined
  if (rest) {
    const it = rest[Symbol.asyncIterator]()
    init = {
      ...init,
      body: new ReadableStream({
        async pull(c) {
          const r = await it.next()
          if (r.done) c.close()
          else c.enqueue(r.value)
        },
        cancel: () => void rest.destroy(),
      }),
    }
  }
  const res = await fetch(url, init)
  if (res.status !== 413 || res.headers.get('content-type')?.includes('json')) return res
  rest?.destroy()
  return Response.json({ ok: false, error_code: 413, description: 'Request Entity Too Large' })
}

// Telegram's flood control: a 429 says how many seconds until the chat takes
// messages again (parameters.retry_after, 3-40 s in busy groups). The request
// waits that long and goes again, up to retries times and max seconds in all,
// so a burst of links in a group delays the videos instead of losing them.
// Every 429 starts or extends the chat's flood, the one that ends a request's
// retries too. While the chat is in a flood, its requests line up and go one
// at a time: let through together, all but one would hit the limit again and
// use up their retries. Each has the turn through its own retries and passes
// it on when it's done, or once it's been gap seconds in flight: an upload
// can take minutes, and the chat's other requests (and their download slots)
// mustn't wait for it. A PROGRESS request's 429 comes back at once, and the
// chat's line still waits the flood out. getUpdates has grammY's own wait,
// and a chat action would be stale by then. flooded(chat) = whether the chat
// is in a flood or has a line.
export function floodWait(retries = 5, max = 120, gap = 1) {
  // chats in a flood: until when, the end of its line, and the requests in it
  type Flood = { until: number; last: Promise<void>; size: number }
  const floods = new Map<string | symbol, Flood>()
  const over = (f: Flood) => f.until <= Date.now() && !f.size
  const forget = (chat: string | symbol, f: Flood) => {
    if (floods.get(chat) === f && over(f)) floods.delete(chat)
  }
  // the chat's flood lasts s seconds more at least
  const hold = (chat: string | symbol, s: number) => {
    const f = floods.get(chat) ?? { until: 0, last: Promise.resolve(), size: 0 }
    f.until = Math.max(f.until, Date.now() + s * 1000)
    floods.set(chat, f)
    void Bun.sleep(f.until - Date.now()).then(() => forget(chat, f))
  }
  // waits for a turn in the chat's line; returns what passes it on
  const line = async (chat: string | symbol, f: Flood) => {
    const ahead = f.last
    let next = () => {}
    f.last = new Promise<void>((go) => (next = go))
    f.size++
    await ahead
    return () => {
      f.size--
      next()
      forget(chat, f)
    }
  }
  const wait: Transformer = async (prev, method, payload, signal) => {
    if (method === 'getUpdates' || method === 'sendChatAction')
      return prev(method, payload, signal)
    const id = (payload as { chat_id?: number | string } | undefined)?.chat_id
    // a request without a chat (to an inline message) waits on its own
    const chat = id === undefined ? Symbol() : String(id)
    // the seconds a 429 asks to wait, unless it's longer than max
    const after = (res: ApiResponse<unknown>) => {
      const s = res.ok || res.error_code !== 429 ? undefined : res.parameters?.retry_after
      return s === undefined || s > max ? undefined : s
    }
    if (signal === PROGRESS) {
      const res = await prev(method, payload, signal)
      const s = after(res)
      if (s !== undefined) hold(chat, s)
      return res
    }
    let tries = 0
    let waited = 0
    // passes the chat's turn on, while this request has it
    let pass: (() => void) | undefined
    try {
      for (;;) {
        const f = floods.get(chat)
        if (f && !over(f)) {
          pass ??= await line(chat, f)
          // another 429 may push the wait out while this one sleeps
          while (f.until > Date.now()) await Bun.sleep(f.until - Date.now())
        }
        const mine = pass
        const slow = mine
          ? setTimeout(() => {
              if (pass !== mine) return
              pass = undefined
              mine()
            }, gap * 1000)
          : undefined
        const res = await prev(method, payload, signal).finally(() => clearTimeout(slow))
        const s = after(res)
        if (s !== undefined) hold(chat, s)
        if (s === undefined || (waited += s) > max || ++tries > retries) return res
        console.error('flood', method, `retry after ${s}`, `${tries}/${retries}`)
      }
    } finally {
      pass?.()
    }
  }
  return Object.assign(wait, {
    flooded: (chat: number | string) => {
      const f = floods.get(String(chat))
      return !!f && !over(f)
    },
  })
}

// A progress status isn't worth a flood wait: waiting it out would hold the
// job's download slot and use up the chat's messages ahead of the video. It's
// skipped while the chat is in a flood, and a 429 on it only starts one.
// show(signal) shows it.
export async function progress(flooded: boolean, show: (signal: Signal) => Promise<unknown>) {
  if (flooded) return
  await show(PROGRESS).catch((e) => {
    if (!(e instanceof GrammyError && e.error_code === 429)) throw e
  })
}

// Deletes a message the bot sent to STORAGE (a guest upload sits in the
// admin's DM until then): through a flood wait floodWait gives up on (over
// its max) and network or server errors, tries times in all. What it still
// can't delete is logged, not thrown. pause is Bun.sleep but in tests.
export async function unsend(
  del: () => Promise<unknown>,
  tries = 6,
  pause: (ms: number) => Promise<unknown> = Bun.sleep,
) {
  for (let i = 1; ; i++) {
    try {
      return void (await del())
    } catch (e) {
      const g = e instanceof GrammyError ? e : undefined
      if ((g && g.error_code !== 429 && g.error_code < 500) || i >= tries)
        return console.error('delete failed', (e as Error).message)
      console.error('delete retry', i, (e as Error).message)
      await pause((g?.parameters.retry_after ?? 5 * 2 ** i) * 1000)
    }
  }
}

// Sends a file to dest.chat as kind; returns the kind it went as, its file_id
// and the message. kept hears the file_unique_id of every file that goes out.
export const sender = (api: Api, kept: (file: string) => void = () => {}) =>
  async function send(
    dest: Dest,
    kind: Kind,
    file: () => string | InputFile,
    opts: Opts,
  ): Promise<[Kind, string, Message]> {
    const { chat } = dest
    let m: Message
    try {
      m =
        kind === 'video'
          ? await api.sendVideo(chat, file(), opts)
          : kind === 'animation'
            ? await api.sendAnimation(chat, file(), opts)
            : kind === 'audio'
              ? await api.sendAudio(chat, file(), opts)
              : await api.sendDocument(chat, file(), opts)
    } catch (e) {
      // a fresh file Telegram won't take as media still goes as a file; a
      // cached file_id doesn't (a local file:// path is fresh). A 429 is no
      // reason to: it's about the chat, not the file, and floodWait has
      // already waited it out as long as it should.
      if (
        kind === 'document' ||
        !fresh(file()) ||
        (e instanceof GrammyError && e.error_code === 429)
      )
        throw e
      m = await api.sendDocument(chat, file(), opts)
    }
    dest.sent = m.message_id
    return carried(m, kept)
  }

// The kind a sent message has its file as, its file_id and the message; kept
// hears the file's file_unique_id
function carried(m: Message, kept: (file: string) => void): [Kind, string, Message] {
  const media = m.video ?? m.animation ?? m.audio ?? m.document
  if (!media) throw new Error('no file in sent message')
  kept(media.file_unique_id)
  const kind = m.video ? 'video' : m.animation ? 'animation' : m.audio ? 'audio' : 'document'
  return [kind, media.file_id, m]
}

// A cached file_id Telegram no longer has (a 400 about the file)
export const gone = (e: unknown) =>
  e instanceof GrammyError && e.error_code === 400 && /file/i.test(e.description)

// A file of a post, as send() takes one
export type Item = { kind: Kind; file: () => string | InputFile; opts: NonNullable<Opts> }

// An album's file, with the album's caption on the first
const input = ({ kind, file, opts }: Item, first: boolean) => ({
  type: kind,
  media: file(),
  ...(first ? { caption: opts.caption, parse_mode: opts.parse_mode } : {}),
  thumbnail: opts.thumbnail,
  duration: opts.duration,
  ...(kind === 'video'
    ? { width: opts.width, height: opts.height, supports_streaming: opts.supports_streaming }
    : { title: opts.title, performer: opts.performer }),
})

// An album with a cached file_id Telegram no longer has (gone()), refused
// whole, nothing of it sent: which file, Telegram doesn't say
export class Dead extends Error {}

// Sends a post's files to dest.chat; returns each one as send() does, or
// undefined for one left out. 2-10 videos, or audio files, go as one album
// (sendMediaGroup), whose caption is the first one's, as its reply and
// notification are; the others, and an album Telegram refuses (a fresh file
// it won't take as a video, more than the cloud Bot API takes at once), go
// one by one through send(), each with its own caption. Any other failure (a
// 429, a 5xx, a lost connection) fails an album: it may have gone out all the
// same, and file by file it would go out twice. A cached file_id Telegram
// doesn't have (gone(), the caller's to forget) fails an album with Dead, and
// one by one it's left out while the others go on, so none goes out twice
// when the caller sends them again. each hears every file as it goes out (its
// place in items, and what send() returns), the ones before a send that
// fails one by one too.
export const albumSender = (
  api: Api,
  send: ReturnType<typeof sender>,
  kept: (file: string) => void = () => {},
) =>
  async function album(
    dest: Dest,
    items: Item[],
    each: (n: number, sent: [Kind, string, Message]) => void = () => {},
  ): Promise<([Kind, string, Message] | undefined)[]> {
    const { kind, opts } = items[0]!
    if (items.length > 1 && (kind === 'video' || kind === 'audio') && items.every((i) => i.kind === kind)) {
      try {
        const ms = await api.sendMediaGroup(
          dest.chat,
          items.map((i, n) => input(i, !n)) as InputMediaVideo[],
          { reply_parameters: opts.reply_parameters, disable_notification: opts.disable_notification },
        )
        dest.sent = ms[0]!.message_id
        dest.more = ms.slice(1).map((m) => m.message_id)
        const sent = ms.map((m) => carried(m as Message, kept))
        sent.forEach((s, n) => each(n, s))
        return sent
      } catch (e) {
        // refused: a 400, or a 413 (too big for one request)
        if (!(e instanceof GrammyError && (e.error_code === 400 || e.error_code === 413))) throw e
        if (gone(e) && items.some((i) => !fresh(i.file()))) throw new Dead(e.description)
        console.error('album', e.message)
      }
    }
    const sent: ([Kind, string, Message] | undefined)[] = []
    for (const [n, i] of items.entries()) {
      const s = await send(dest, i.kind, i.file, i.opts).catch((e) => {
        if (!gone(e) || fresh(i.file())) throw e
        console.error('resend', (e as GrammyError).description)
        return undefined
      })
      if (s) each(n, s)
      sent.push(s)
      const out = sent.filter((s) => s !== undefined)
      dest.sent = out[0]?.[2].message_id
      dest.more = out.slice(1).map((s) => s[2].message_id)
    }
    return sent
  }

// The live cookie jar sits on the data volume, so the session cookies Google
// rotates survive restarts. COOKIES only seeds it, again whenever it changes.
const JAR = join(DATA, 'cookies.txt')
const SEED = join(DATA, 'cookies.seed.txt')

async function seedJar() {
  if (!existsSync(COOKIES)) return
  const seed = await Bun.file(COOKIES).text()
  if (existsSync(SEED) && (await Bun.file(SEED).text()) === seed) return
  await Bun.write(JAR, seed)
  await Bun.write(SEED, seed)
}

// yt-dlp gets a private copy (parallel runs would clobber one file)...
const taken = new Map<string, number>()
async function jar(dir: string) {
  if (!existsSync(JAR)) return []
  taken.set(dir, (await stat(JAR)).mtimeMs)
  await copyFile(JAR, join(dir, 'cookies.txt'))
  // the job folder may be readable by the Bot API server (scratch.ts), the session isn't
  await chmod(join(dir, 'cookies.txt'), 0o600)
  return ['--cookies', join(dir, 'cookies.txt')]
}

// ...and its refreshed cookies go back, unless YouTube dropped the login or
// another run saved newer ones meanwhile
async function saveJar(dir: string) {
  const since = taken.get(dir)
  taken.delete(dir)
  const copy = join(dir, 'cookies.txt')
  if (!existsSync(copy) || !(await Bun.file(copy).text()).includes('\tLOGIN_INFO\t'))
    return
  if (since !== undefined && (await stat(JAR)).mtimeMs !== since) return
  await copyFile(copy, `${JAR}.new`)
  await rename(`${JAR}.new`, JAR)
}

// args with their cookies (a job's copy, jar()) copied into dir, for one of
// a job's yt-dlp runs that go at once (a post's videos): each run reads its
// file as it starts and writes it back as it ends, so one could read what
// another is halfway through writing. That copy isn't saved back: the job's
// own copy, which its -J refreshed, is (saveJar())
export async function ownJar(args: string[], dir: string) {
  const at = args.indexOf('--cookies')
  if (at < 0) return args
  const copy = join(dir, 'cookies.txt')
  await copyFile(args[at + 1]!, copy)
  await chmod(copy, 0o600)
  return args.map((arg, n) => (n === at + 1 ? copy : arg))
}

// First-seen chat and user ids, for stats.borodutch.com (served on STATS_PORT
// inside the Docker network only, no domain): totals and new ones per UTC day,
// plus the audience: chats by type and by days since their last update, and
// private chats that blocked the bot (counts only, never ids)
export const WINDOWS = [7, 30, 90, 180] as const
export function census(db: Database) {
  const tables = ['chats', 'users'] as const
  for (const t of tables)
    db.run(`CREATE TABLE IF NOT EXISTS ${t} (id INTEGER PRIMARY KEY, created INTEGER NOT NULL)`)
  for (const col of ['seen INTEGER', 'type TEXT', 'gone INTEGER NOT NULL DEFAULT 0'])
    try {
      db.run(`ALTER TABLE chats ADD COLUMN ${col}`)
    } catch {} // already there
  const chat = db.query(
    `INSERT INTO chats (id, created, seen, type) VALUES (?1, unixepoch(), unixepoch(), ?2)
     ON CONFLICT (id) DO UPDATE SET seen = excluded.seen, type = coalesce(excluded.type, type), gone = 0`,
  )
  const user = db.query('INSERT OR IGNORE INTO users VALUES (?, unixepoch())')
  const member = db.query(
    `INSERT INTO chats (id, created, type, gone) VALUES (?1, unixepoch(), 'private', ?2)
     ON CONFLICT (id) DO UPDATE SET gone = excluded.gone`,
  )
  const daily = (t: string) =>
    db
      .query(`SELECT date(created, 'unixepoch') AS date, count(*) AS count FROM ${t} GROUP BY 1 ORDER BY 1`)
      .all() as { date: string; count: number }[]
  const total = (t: string) =>
    (db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n
  const recent = WINDOWS.map(
    (d) => `sum(gone = 0 AND unixepoch() - coalesce(seen, created) < ${d * 86400}) AS d${d}`,
  ).join(', ')
  const audience = () =>
    Object.fromEntries(
      (
        db
          .query(
            `SELECT coalesce(type, CASE WHEN id > 0 THEN 'private' WHEN id < -1000000000000
               THEN 'supergroup_or_channel' ELSE 'group' END) AS kind,
             count(*) AS ever, sum(gone) AS unreachable, ${recent}
             FROM chats GROUP BY 1`,
          )
          .all() as ({ kind: string } & Record<string, number>)[]
      ).map(({ kind, ...n }) => [kind, n]),
    )
  return {
    // a chat's last activity: any update from it except the bot's own membership changes
    seen(chatId?: number, userId?: number, type?: string) {
      if (chatId !== undefined) chat.run(chatId, type ?? null)
      if (userId !== undefined) user.run(userId)
    },
    // a private chat blocked (kicked) or unblocked the bot
    member(chatId: number, status: string) {
      member.run(chatId, status === 'kicked' ? 1 : 0)
    },
    stats: () => ({
      chatCount: total('chats'),
      userCount: total('users'),
      chatDaily: daily('chats'),
      userDaily: daily('users'),
      audience: audience(),
    }),
  }
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Seconds since t, for the job log
const elapsed = (t: number) => ((Date.now() - t) / 1000).toFixed(1)

// The media in a job's dir, downloaded so far or done (yt-dlp names it all
// v.*): each file's name and bytes
async function media(dir: string) {
  const files: { name: string; bytes: number }[] = []
  for (const name of await readdir(dir).catch(() => []))
    if (name.startsWith('v.'))
      files.push({ name, bytes: (await stat(join(dir, name)).catch(() => undefined))?.size ?? 0 })
  return files
}

// MB of media in a job's dir, not counting the v.temp.* a merge or fixup
// writes from the rest
export async function onDisk(dir: string) {
  let bytes = 0
  for (const f of await media(dir)) if (!f.name.startsWith('v.temp.')) bytes += f.bytes
  return Math.round(bytes / 2 ** 20)
}

// Bytes of the biggest media file in a job's dir, a merge's or fixup's
// v.temp.* too (it becomes the video)
export const biggest = async (dir: string) =>
  (await media(dir)).reduce((max, f) => Math.max(max, f.bytes), 0)

// Deletes the media in a job's dir: whatever a failed download left
export async function drop(dir: string) {
  for (const f of await media(dir)) await rm(join(dir, f.name), { recursive: true, force: true })
}

// How a job that threw e ends in the job log: fail:<what the chat was told>,
// timeout (the download ran out of time) or error
export const outcome = (e: unknown) =>
  e instanceof Fail ? `fail:${e.key ?? 'quiet'}` : e instanceof Timeout ? 'timeout' : 'error'

function main() {
  const db = new Database(join(DATA, 'bot.sqlite'), { create: true })
  // During a deploy's handover the old container, still polling, writes to
  // this file on nearly every update (census): the tables set up below wait
  // up to 10 s for its write lock (a new one, like sent, needs it) rather
  // than stop this container's start. After them a lock fails at once, as
  // before.
  db.run('PRAGMA busy_timeout = 10000')
  db.run(
    'CREATE TABLE IF NOT EXISTS files (key TEXT PRIMARY KEY, kind TEXT NOT NULL, file_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL)',
  )
  // The cache's statements, like sent's below: past the start, one that meets
  // another process's lock on the file fails at once (a deploy's old
  // container writes files, sized and sent as its last jobs finish). It's
  // logged and comes to undefined, which costs a request at most a download:
  // a read that fails is a miss, and a write that fails once the file is out
  // leaves the chat its file.
  const cache = <T>(what: string, statement: () => T) => {
    try {
      return statement()
    } catch (e) {
      console.error('cache', what, (e as Error).message)
    }
  }
  const row = db.query<File, [string]>('SELECT * FROM files WHERE key = ?')
  const get = (key: string) => cache('get', () => row.get(key))
  const put = (key: string, f: File) =>
    cache('put', () =>
      db.query('INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?)').run(key, f.kind, f.file_id, f.title, f.url),
    )
  // file_ids uploaded with the file's own size (#281), or whose one refresh
  // was tried; older videos may have gone out without a size. A table of its
  // own: a container still running the old code keeps writing files.
  db.run('CREATE TABLE IF NOT EXISTS sized (file_id TEXT PRIMARY KEY)')
  // true the first time only (not when it can't be written: the refresh
  // waits for another time)
  const settle = (fileId: string) =>
    cache('settle', () => db.query('INSERT OR IGNORE INTO sized VALUES (?)').run(fileId).changes > 0)
  // every link cached with the old file gets the new one
  const swap = (old: string, f: File) =>
    cache('swap', () =>
      db.query('UPDATE files SET kind = ?, file_id = ? WHERE file_id = ?').run(f.kind, f.file_id, old),
    )
  const forget = (f: File) =>
    cache('forget', () => db.query('DELETE FROM files WHERE file_id = ?').run(f.file_id))
  // What each link got: the keys its files are cached under in files (one,
  // or a post's in its order) and the title and link its caption shows. A
  // table of its own: files has links too, from when a post's link got its
  // first video alone. Those rows are read only to answer a guest reply at
  // once (guest()) and when a job for such a link can't get it anything new
  // (job(), or a request following it: deliver()); a single video's link
  // still goes there too, for a container running older code. So such a
  // link has its page read once again, and what it picks may be cached by
  // its key. A link one of whose files is gone (forget) is a miss.
  db.run('CREATE TABLE IF NOT EXISTS links (url TEXT PRIMARY KEY, keys TEXT NOT NULL, title TEXT NOT NULL, link TEXT NOT NULL)')
  const remember = (url: string, keys: string[], got: Pick<Got, 'title' | 'url'>) =>
    cache('remember', () =>
      db.query('INSERT OR REPLACE INTO links VALUES (?, ?, ?, ?)').run(url, JSON.stringify(keys), got.title, got.url),
    )
  // A link cached with its row in files, the link itself (job()'s old
  // copy), unless it has one here already: a post's whose files are gone,
  // which its page read again, once that works, gets whole
  const pin = (url: string, f: File) =>
    cache('pin', () =>
      db.query('INSERT OR IGNORE INTO links VALUES (?, ?, ?, ?)').run(url, JSON.stringify([url]), f.title, f.url),
    )
  const linked = db.query<{ keys: string; title: string; link: string }, [string]>(
    'SELECT keys, title, link FROM links WHERE url = ?',
  )
  const recall = (url: string) =>
    cache('recall', (): Got | undefined => {
      const hit = linked.get(url)
      if (!hit) return
      const files = (JSON.parse(hit.keys) as string[]).map(get)
      if (files.every((f) => f)) return { files: files as File[], title: hit.title, url: hit.link }
    })
  // The files it has sent, by file_unique_id: a copy of one is its own
  // message (own()). A video cached before this table joins it the next time
  // it goes out; until then a copy of it counts as anyone's. A table of its
  // own, as sized. A failed write or read only lets a copy through.
  db.run('CREATE TABLE IF NOT EXISTS sent (file TEXT PRIMARY KEY)')
  const keep = (file: string) => {
    try {
      db.query('INSERT OR IGNORE INTO sent VALUES (?)').run(file)
    } catch (e) {
      console.error(e)
    }
  }
  const mine = (file: string) => {
    try {
      return !!db.query('SELECT 1 FROM sent WHERE file = ?').get(file)
    } catch (e) {
      console.error(e)
      return false
    }
  }
  const people = census(db)
  Bun.serve({
    port: Number(env.STATS_PORT || 8080),
    fetch: (req) =>
      new URL(req.url).pathname === '/stats'
        ? Response.json(people.stats())
        : new Response('Not found', { status: 404 }),
  })

  const promo = promos(db)
  db.run('PRAGMA busy_timeout = 0')
  const bot = new Bot(env.TOKEN!, {
    client: { apiRoot: API, timeoutSeconds: 3600, fetch: apiFetch },
  })
  // every request, ctx.api's too (grammY copies the bot's transformers)
  const flood = floodWait()
  bot.api.config.use(flood)
  // The jobs running for links, each with the chat it sends to
  const jobs = new Map<string, { got: Promise<Got>; chat: Dest['chat'] }>()
  // The other requests for a link whose job runs follow its statuses: tell =
  // each one's, key = the job's last
  const watching = new Map<string, { key?: Key; tell: Set<(key: Key) => void> }>()
  // The requests running now, each with a way to tell its chat that the exit
  // cuts it off
  const open = new Set<() => void>()
  // Set by the exit's cut: from then on no job begins a download or an
  // upload (job(), postJob())
  let exiting = false
  // Set once a deploy's drain has begun: from then on a guest message that
  // doesn't mention the bot isn't answered just because its time is up (guest())
  let draining = false
  // Handlers run detached; counted so a deploy lets the running ones finish
  let running = 0
  const track = (p: Promise<unknown>) => {
    running++
    return p.finally(() => running--)
  }
  // The help text goes out detached too: in a flood wait a reply can take
  // minutes, and updates are handled one at a time
  const help = (ctx: Context) =>
    void track(ctx.reply(t(ctx.from?.language_code, 'help')).catch(console.error))

  const send = sender(bot.api, keep)
  const album = albumSender(bot.api, send, keep)

  const options = (dest: Dest, f: Pick<File, 'title' | 'url'>): Opts => ({
    caption:
      `<a href="${esc(f.url)}">${esc([...f.title].slice(0, 200).join(''))}</a>\n@${bot.botInfo.username}` +
      (dest.promo?.format === 'caption'
        ? `\n\n<a href="${esc(dest.promo.url)}">${esc(dest.promo.text)}</a>`
        : ''),
    reply_markup:
      dest.promo?.format === 'button'
        ? { inline_keyboard: [[{ text: dest.promo.text, url: dest.promo.url }]] }
        : undefined,
    parse_mode: 'HTML',
    supports_streaming: true,
    disable_notification: !dest.reply,
    reply_parameters: dest.reply
      ? { message_id: dest.reply, allow_sending_without_reply: true }
      : undefined,
  })

  // false = the cached file_id is dead, download again; other errors (flood
  // wait, blocked bot, no media rights) keep the cache and propagate. A video
  // cached before #281 that Telegram has without a size (it shows squeezed)
  // goes to unsized with its message, once per file_id.
  async function resend(dest: Dest, f: File, unsized?: (id: number) => void) {
    try {
      const [, , m] = await send(dest, f.kind, () => f.file_id, options(dest, f))
      if (unsized && m.video && !(m.video.width && m.video.height) && settle(f.file_id))
        unsized(m.message_id)
      return true
    } catch (e) {
      if (!gone(e)) throw e
      console.error('resend', f.url, (e as GrammyError).description)
      forget(f)
      return false
    }
  }

  // A post's files: each one's, as an album takes it (albumSender), with the
  // caption and promo on the first. An album takes no promo button: dest
  // loses one, so it doesn't count as shown.
  const post = (dest: Dest, got: Pick<Got, 'title' | 'url'>, files: Omit<Item, 'opts'>[], looks: Partial<Item['opts']>[] = []) => {
    if (dest.promo?.format === 'button') dest.promo = undefined
    return files.map((f, n): Item => ({ ...f, opts: { ...options(n ? { ...dest, promo: undefined } : dest, got), ...looks[n] } }))
  }

  // A post's cached files to dest, as resend() does a video's: what went
  // out, undefined for none. A dead one is forgotten: one by one it's left
  // out, and the link sent again downloads it; an album with one fails whole
  // without saying which (Dead), so they're all forgotten and none goes.
  async function repost(dest: Dest, got: Got): Promise<Got | undefined> {
    try {
      const went = await album(dest, post(dest, got, got.files.map((f) => ({ kind: f.kind, file: () => f.file_id }))))
      for (const [n, f] of got.files.entries()) if (!went[n]) forget(f)
      const files = got.files.filter((_, n) => went[n])
      if (files.length) return { ...got, files }
    } catch (e) {
      if (!(e instanceof Dead)) throw e
      console.error('resend', got.url, e.message)
      for (const f of got.files) forget(f)
    }
  }

  // A link's cached files to dest: what went out, undefined for none (they
  // were dead: download again). A post goes as its first video alone where
  // one file shows (dest.single); then the whole post comes back, its first
  // file having gone. unsized is resend()'s, for a video's.
  async function resent(dest: Dest, got: Got, unsized?: (id: number) => void) {
    if (got.files.length > 1 && !dest.single) return repost(dest, got)
    if (await resend(dest, got.files[0]!, got.files.length > 1 ? undefined : unsized)) return got
  }

  async function download(
    dest: Dest,
    url: string,
    status: (key: Key) => Promise<void>,
  ): Promise<Got> {
    if (dest.reply)
      void bot.api.sendChatAction(dest.chat, 'upload_video').catch(() => {})
    // One line per job, for where the time goes (in seconds): the wait for a
    // yt-dlp -J turn and the run, the wait for a slot, how many jobs were
    // in line and how many of the user's own had a slot or were in line
    // (with none, a wait was behind other people's links alone), the
    // download (a failed one too, with the MB it got), and probe, thumbnail
    // and upload together
    const log: Record<string, string | number> = { host: new URL(url).hostname }
    const start = Date.now()
    let result = 'ok'
    // A status the chat doesn't take (a group that takes the bot's videos
    // but not its texts, a 5xx, a lost connection) isn't the link's failure:
    // it's logged, and the job goes on, as its video may still go out. In a
    // group where the bot may send nothing at all, Telegram says the same
    // about a status, so there each link costs a download. A chat that
    // refuses the bot outright (a 403: blocked, removed) takes no video
    // either: that stops the job.
    const say = (key: Key) =>
      status(key).catch((e) => {
        if (e instanceof GrammyError && e.error_code === 403) throw e
        console.error('status', url, (e as Error).message)
      })
    try {
      const f = await job(dest, url, say, log)
      // only an upload times it
      if (!log.up) result = 'cached'
      return f
    } catch (e) {
      result = outcome(e)
      throw e
    } finally {
      log.total = elapsed(start)
      console.log('job', result, Object.entries(log).map(([k, v]) => `${k}=${v}`).join(' '))
    }
  }

  async function job(
    dest: Dest,
    url: string,
    status: (key: Key) => Promise<void>,
    log: Record<string, string | number>,
  ): Promise<Got> {
    const dir = await mkdtemp(join(TMP, 'job-'))
    let free = () => {}
    // a link that has to wait for a -J turn or a slot would otherwise look
    // ignored: it hears it's queued, once
    let queued = false
    // Whether the page itself has nothing for the link now: its site's
    // extractor failed it (a video gone, a rate limit, a bot check) or it
    // shows no video. Not a time limit, a run that failed here (the disk, the
    // one-file build), a request that never got a page (the network, the
    // proxy), the site's own failure (a 5xx), a bug in yt-dlp, or anything
    // after a read that worked: those say nothing about the page.
    let said = false
    const wait = async (busy: boolean) => {
      if (!busy || queued) return
      queued = true
      await status('queued')
    }
    try {
      await SCRATCH.open(dir)
      let args = [...YTDLP, ...(await jar(dir))]
      let page: Awaited<ReturnType<typeof read>>
      const asked = Date.now()
      await wait(meta.busy(false, dest.who))
      try {
        page = await meta.run(async () => {
          log.metaq = elapsed(asked)
          const t = Date.now()
          try {
            return await read(args, url, 5 * 60_000)
          } finally {
            log.meta = elapsed(t)
          }
        }, dest.who)
      } catch (e) {
        // a restart (meta.close) isn't the link's fault; read()'s own Fail
        // is a page without a video
        if (e instanceof Fail) {
          said = e.key === null
          throw e
        }
        const why = String((e as Error).message)
        const soon = unstarted(why)
        if (soon) throw new Fail(soon, why)
        // an untagged error needs the extractors that claim the link
        const tagged = /^(ERROR: )?\[/.test(why)
        const ies = tagged ? [] : ((await claims([url]).catch(() => undefined))?.get(url) ?? [])
        said = sitesWord(why, ies)
        throw new Fail(notVideo(why, ies) ? null : 'failed', why)
      }
      const extracted = Date.now()
      const { json } = page
      // A post's videos that can't be sent are left out: a stream yt-dlp
      // can't download yet, and one it says is too big. Two or more left go
      // out as an album (postJob()), one as any video, and none fail as the
      // first one would.
      const all = page.picks
      const fit = all.length > 1 ? all.filter((pick) => !unfit(pick)) : all
      // A post that may have more for its link later isn't cached under it:
      // one with a video its -J couldn't read (read()), or with a stream left
      // out, which may be downloaded once it's over
      const partial = page.partial || (all.length > 1 && all.some(unready))
      if (!fit.length) throw unfit(all[0])
      if (fit.length > 1) {
        const info = JSON.parse(json)
        return await postJob(dest, url, status, log, {
          dir,
          args,
          wait,
          hold: (end) => (free = end),
          picks: fit,
          listed: all.length,
          partial,
          caption: { title: info.title || 'Video', url: info.webpage_url || url },
          extracted,
        })
      }
      // The video and the key it's cached under: the page read again may
      // pick another one (again())
      let v = fit[0]
      let id = cacheKey(v)
      // The video may be cached under another link, or get cached by another
      // job while this one waits; a refresh wants a new upload, not another
      // cached copy. A copy that went out without its size is refreshed once
      // the job is over, as a link's own copy is (deliver()), but not for a
      // guest reply: one that doesn't mention the bot may have no answer yet,
      // which would wait for the download (guest())
      const fromCache = async (key: string) => {
        const hit = get(key)
        const unsized = dest.single ? undefined : (message: number) => (dest.stale = { message, file_id: hit!.file_id })
        if (hit && !dest.stale && (await resend(dest, hit, unsized))) {
          put(url, hit)
          if (!partial) remember(url, [key], hit)
          return hit
        }
      }
      // What a video the page picks goes through before it's downloaded: a
      // stream yt-dlp can't download yet fails, a refresh stops quietly
      // unless it's the video it replaces, a copy cached under its key goes
      // out and is returned, and one yt-dlp says is too big fails. A
      // refresh's download takes the old copy's place in the chat and under
      // every key cached with it (swap), so it has to be the video whose key
      // has that copy: the page may lead to another one now, at the first
      // read or when read again (a multi-video post whose first one has
      // changed), and the old copy stays, as it does when the key can't be
      // read.
      const vet = async (pick: any) => {
        const stream = unready(pick)
        if (stream) throw new Fail(stream, `${stream} stream`)
        if (dest.stale && get(cacheKey(pick))?.file_id !== dest.stale.file_id)
          throw new Fail(null, 'another video')
        const hit = await fromCache(cacheKey(pick))
        if (hit) return hit
        if (weight(pick) > LIMIT) throw new Fail('tooBig')
      }
      const hit = await vet(v)
      if (hit) return one(hit)

      const long = isLong(v)
      log.lane = long ? 'long' : 'short'
      log.ahead = slots.waiting(long)
      log.own = slots.own(dest.who)
      log.dur = v.duration ? Math.round(v.duration) : '?'
      await wait(slots.busy(long, dest.who))
      const waited = Date.now()
      free = await slots.take(dest.who, long)
      log.wait = elapsed(waited)
      const sent = await fromCache(id)
      if (sent) return one(sent)
      // another run may have saved newer cookies while this one waited
      if (taken.has(dir) && (await stat(JAR)).mtimeMs !== taken.get(dir))
        args = [...YTDLP, ...(await jar(dir))]

      // past the exit's cut no download begins: its upload couldn't (below)
      if (exiting) throw new Fail('restarting')
      await status('downloading')
      await Bun.write(join(dir, 'info.json'), saved(v, json))
      // yt-dlp holds a download to --max-filesize only by its Content-Length,
      // so an HLS or DASH one of unknown size (a stream recording) would grow
      // until the time limit, many GB into TMP. Every 5 s the job's files are
      // weighed, and once one of them is over LIMIT the download stops: that
      // file alone can't be sent. (Their sum would stop a merge that's fine:
      // the parts and the merged copy are on disk together.) It's the
      // download as it comes that's judged, as by --max-filesize: an MPEG-TS
      // one just over LIMIT, which the remux into MP4 would shrink a few %
      // under it, stops too.
      const big = new AbortController()
      const weigh = setInterval(async () => {
        if ((await biggest(dir)) > LIMIT)
          big.abort(new Fail('tooBig', `a file over ${LIMIT >> 20} MB`))
      }, MINUTE / 12)
      const grab = (source: string[], timeout: number) =>
        ytdlp(
          [
            ...args,
            ...source,
            '-o', join(dir, 'v.%(ext)s'),
            '--max-filesize', String(LIMIT),
            '--print', 'after_move:filepath',
          ],
          timeout,
          big.signal,
        )
      const fetched = Date.now()
      const age = fetched - extracted
      const budget = downloadMinutes(long) * MINUTE
      // The page read again in left ms, then downloaded from like the first
      // time. It's read apart from the download to see what it picks: the
      // failed try's files are left to resume only for the same pick, and
      // deleted first for another (samePick). --no-continue would be no way
      // out: a fragment download (HLS, DASH) starts over then, but appended
      // to a .part with bytes in it, which yt-dlp has opened in append mode.
      // Another video picked this time (a multi-video post whose first one
      // has changed, or a link that leads to another one now) gets the
      // checks the first one got (vet: a cached copy of it goes out instead
      // of a download, and a refresh stops), then becomes the job's video:
      // it goes out with its own title, length and kind, and is cached under
      // its own key, never the first one's.
      const again = async (left: number) => {
        const reading = Date.now()
        const page = await read(args, url, left)
        // the same video, should the page be a post now
        const pick = page.picks.find((p) => cacheKey(p) === id) ?? page.picks[0]
        const same = samePick(v, pick)
        log[same ? 'kept' : 'dropped'] = await onDisk(dir)
        if (!same) await drop(dir)
        if (cacheKey(pick) !== id) {
          log.other = 1
          const hit = await vet(pick)
          if (hit) return hit
          v = pick
          id = cacheKey(pick)
        }
        await Bun.write(join(dir, 'info.json'), saved(pick, page.json))
        return grab(['--load-info-json', join(dir, 'info.json')], left - (Date.now() - reading))
      }
      const got = await grab(
        [
          '--load-info-json', join(dir, 'info.json'),
          // a fragment lost to an expired link fails it (and it reads the page
          // again) rather than leave a gap in the video
          ...(stale(age) ? ['--abort-on-unavailable-fragments'] : []),
        ],
        budget,
      )
        .catch((e) => {
          // too big: the page read again has the same video
          if (big.signal.aborted) throw big.signal.reason
          const left = budget - (Date.now() - fetched)
          // nor past the exit's cut, after which no upload begins
          if (exiting || !reread(age, left)) throw e
          log.reread = 1
          return again(left)
        })
        .catch(async (e) => {
          // how far a failed download got, for the site's speed
          log.dl = elapsed(fetched)
          log.mb = await onDisk(dir)
          throw e
        })
        .finally(() => clearInterval(weigh))
      log.dl = elapsed(fetched)
      // the page read again picked another video, which went out from the cache
      if ('file_id' in got) return one(got)
      const { out, err } = got
      const path = out.trim().split('\n').pop()
      // --print implies --quiet, so a file over --max-filesize is skipped
      // with exit 0 and no output at all
      if (!path || !existsSync(path)) {
        log.mb = await onDisk(dir)
        throw new Fail(err.trim() ? 'failed' : 'tooBig', err)
      }
      const bytes = (await stat(path)).size
      log.mb = Math.round(bytes / 2 ** 20)
      if (bytes > LIMIT) throw new Fail('tooBig')

      const sending = Date.now()
      await status('uploading')
      await SCRATCH.open(path, true)
      const f = { title: v.title || 'Video', url: v.webpage_url || url }
      const look = await looks(path, v, join(dir, 'thumb.jpg'), f.title)
      // Past the exit's cut the job's chats have heard to send the link
      // again, or hear it now (a guest reply, a request that came after the
      // cut): an upload begun now would go out next to that, finished by a
      // local Bot API server after the exit, and a refresh would leave both
      // videos. Once the upload has begun (before the cut), the cut leaves
      // the job's request alone (cutOff).
      if (exiting) throw new Fail('restarting')
      dest.uploading = true
      const [kind, file_id] = await send(
        dest,
        v.vcodec === 'none' ? 'audio' : 'video',
        () => SCRATCH.local(path) ?? new InputFile(path),
        { ...options(dest, f), ...look },
      )
      log.up = elapsed(sending)
      const file = { ...f, kind, file_id }
      settle(file_id)
      put(id, file)
      put(url, file)
      if (!partial) remember(url, [id], file)
      return one(file)
    } catch (e) {
      // A link cached before posts went out whole has its copy in files
      // under the link itself, not in links: that's what it got then (a
      // post's first video alone). When this job can't get it anything new
      // (its page can't be read now or shows no video, or what it shows
      // fails to download, after the exit's cut too), it still gets that
      // copy, old=1 in its job's line. When the page itself has nothing
      // (said), the link is cached with that copy (pin()), so its page isn't
      // read again, as it wasn't before; a download that failed or a read
      // that failed here may work next time. A post that went out as its one
      // video alone since has that row too, and is cached with it the same
      // way: a site's rate limit can't be told from a post that's gone. Not
      // for a job the restart stops (Fail('restarting')), not once something
      // of the job went out (a refresh's old copy too), and not after a
      // file's send failed (an upload's, a cached copy's resend): it may have
      // gone out all the same, or the old copy would meet the same refusal.
      // A status the chat refuses outright (a 403: download()) gets here too,
      // and gets no old copy either: that chat takes nothing from the bot. A
      // cached copy Telegram no longer has fails no send (resend(),
      // repost()): nothing of it reached the chat, so the old copy may still
      // go after it.
      const old =
        dest.sent || e instanceof GrammyError || e instanceof HttpError || (e instanceof Fail && e.key === 'restarting')
          ? undefined
          : get(url)
      if (old && (await resend(dest, old))) {
        log.old = 1
        if (said) pin(url, old)
        return one(old)
      }
      throw e
    } finally {
      await saveJar(dir).catch(console.error)
      // the slot is held until the files are gone; a failed rm is logged, and
      // the job keeps its own result
      await rm(dir, { recursive: true, force: true }).catch(console.error).finally(free)
    }
  }

  // A post's videos (picks of the listed ones, from the page read at
  // extracted) out as one album, the post's caption on it. Every one that's
  // cached goes as it is, and when all are, before any slot, as a cached
  // video does. The others download at once: the job's own slot (a long one
  // if any of them is long) takes them one after another, and every other
  // slot that's free for one of them right away (the user's share and the
  // long lane, as for any job) takes that one till its download is done.
  // Their files wait in the job's dir for the album, POST_BYTES at most
  // together. The downloads all end within the time a job of the post's lane
  // has, each one within its own lane's; one that failed from info over a
  // minute old reads the post again for the same video and goes on as a
  // video's does (again()). A video that fails or won't fit is left out, the
  // post fails as its first one did once none is left, and its link is
  // cached only for the whole post. hold(end) gives the job its slot.
  async function postJob(
    dest: Dest,
    url: string,
    status: (key: Key) => Promise<void>,
    log: Record<string, string | number>,
    job: {
      dir: string
      args: string[]
      wait: (busy: boolean) => Promise<void>
      hold: (end: () => void) => void
      picks: any[]
      listed: number
      partial: boolean
      caption: Pick<Got, 'title' | 'url'>
      extracted: number
    },
  ): Promise<Got> {
    const { dir, picks, caption, extracted } = job
    // a post is cached under its link only whole: every video sent, and none
    // its -J failed to read (read())
    const whole = (sent: number) => sent === picks.length && !job.partial
    let { args } = job
    // a refresh is of one video's cached copy
    if (dest.stale) throw new Fail(null, 'a post')
    const keys = picks.map(cacheKey)
    // the post's cached files, as deliver() sends a link's (resent(): a guest
    // reply's goes as its first alone); left = the ones Telegram no longer
    // had, left out and forgotten (repost()): the link sent again downloads
    // them
    const fromCache = async () => {
      const files = keys.map(get)
      if (!files.every((f) => f)) return
      const got = await resent(dest, { files: files as File[], ...caption })
      if (got) {
        log.items = `${got.files.length}/${job.listed}`
        if (got.files.length < files.length) log.left = files.length - got.files.length
        if (whole(got.files.length)) remember(url, keys, caption)
        return got
      }
    }
    const hit = await fromCache()
    if (hit) return hit

    // The lane of the videos it downloads: a cached one goes as it is.
    // ponytail: the cache is read again once the job has its slot, so a long
    // video whose copy is forgotten meanwhile (another job found it dead, or
    // this one's fromCache() below) downloads in a short slot, with a short
    // job's time and past the long lane's limit (raced=1 in the job line);
    // take a long slot then if raced=1 ever shows up
    const long = picks.some((v, n) => !get(keys[n]!) && isLong(v))
    log.lane = long ? 'long' : 'short'
    log.ahead = slots.waiting(long)
    log.own = slots.own(dest.who)
    log.dur = picks.every((v) => v.duration > 0) ? Math.round(Math.max(...picks.map((v) => v.duration))) : '?'
    await job.wait(slots.busy(long, dest.who))
    const waited = Date.now()
    job.hold(await slots.take(dest.who, long))
    log.wait = elapsed(waited)
    const sent = await fromCache()
    if (sent) return sent
    if (taken.has(dir) && (await stat(JAR)).mtimeMs !== taken.get(dir))
      args = [...YTDLP, ...(await jar(dir))]

    await status('downloading')
    // each video: its own dir, and its cached file, its downloaded one (path,
    // with what it goes out with, and up once it has) or why it failed
    const items = picks.map((v, n) => ({
      v,
      dir: join(dir, String(n + 1)),
      file: get(keys[n]!),
      path: undefined as string | undefined,
      look: {} as Partial<Item['opts']>,
      up: undefined as File | undefined,
      error: undefined as unknown,
    }))
    if (!long && items.some((it) => !it.file && isLong(it.v))) log.raced = 1
    type Video = (typeof items)[number]
    const fetched = Date.now()
    const until = fetched + downloadMinutes(long) * MINUTE
    // bytes of the files kept for the album
    let bytes = 0
    let rereads = 0
    // Downloads a video into its dir, as job() does one: its file's path. Not
    // past the exit's cut, after which no upload begins (job()), nor does a
    // failed download read the page again then
    const pull = async (it: Video) => {
      if (exiting) throw new Fail('restarting')
      await mkdir(it.dir)
      await SCRATCH.open(it.dir)
      // cookies of its own: the others' downloads may run meanwhile
      const mine = await ownJar(args, it.dir)
      const info = join(it.dir, 'info.json')
      await Bun.write(info, JSON.stringify(it.v))
      const start = Date.now()
      const age = start - extracted
      const budget = Math.min(downloadMinutes(isLong(it.v)) * MINUTE, until - start)
      if (budget <= 0) throw new Timeout('the post ran out of time')
      const big = new AbortController()
      const weigh = setInterval(async () => {
        if ((await biggest(it.dir)) > LIMIT)
          big.abort(new Fail('tooBig', `a file over ${LIMIT >> 20} MB`))
      }, MINUTE / 12)
      const grab = (source: string[], timeout: number) =>
        ytdlp(
          [
            ...mine,
            ...source,
            '-o', join(it.dir, 'v.%(ext)s'),
            '--max-filesize', String(LIMIT),
            '--print', 'after_move:filepath',
          ],
          timeout,
          big.signal,
        )
      try {
        const { out, err } = await grab(
          ['--load-info-json', info, ...(stale(age) ? ['--abort-on-unavailable-fragments'] : [])],
          budget,
        ).catch(async (e) => {
          if (big.signal.aborted) throw big.signal.reason
          const left = budget - (Date.now() - start)
          if (exiting || !reread(age, left)) throw e
          rereads++
          const reading = Date.now()
          const pick = (await read(mine, url, left)).picks.find((p) => cacheKey(p) === cacheKey(it.v))
          // gone from the post
          if (!pick) throw e
          if (!samePick(it.v, pick)) await drop(it.dir)
          it.v = pick
          await Bun.write(info, JSON.stringify(pick))
          return grab(['--load-info-json', info], left - (Date.now() - reading))
        })
        const path = out.trim().split('\n').pop()
        if (!path || !existsSync(path)) throw new Fail(err.trim() ? 'failed' : 'tooBig', err)
        const size = (await stat(path)).size
        if (size > LIMIT || bytes + size > POST_BYTES) throw new Fail('tooBig')
        bytes += size
        return path
      } catch (e) {
        // what a failed one got isn't kept
        await drop(it.dir).catch(console.error)
        throw e
      } finally {
        clearInterval(weigh)
      }
    }
    const bring = (it: Video) =>
      pull(it).then(
        (path) => void (it.path = path),
        (e) => void (it.error = e),
      )
    // the videos to download, long ones first: the job's own slot, a long one
    // when any of them is, takes those, and the short ones fit short slots
    const line = items.filter((it) => !it.file).sort((a, b) => Number(isLong(b.v)) - Number(isLong(a.v)))
    // the downloads in slots of their own: each one's end of its turn, and
    // whether it's over or the job's own slot has taken it over
    const going: { it: Video; end: () => void; over: boolean; done: Promise<void> }[] = []
    let spare = 0
    // every video in line that a free slot fits right now goes in it: tried
    // as the job's own slot takes the next one, as another one's download
    // ends, and every 5 s (another job's slot may have come free)
    const share = () => {
      for (const it of [...line]) {
        const end = slots.spare(dest.who, isLong(it.v))
        if (!end) continue
        line.splice(line.indexOf(it), 1)
        spare++
        const g = { it, end, over: false, done: Promise.resolve() }
        g.done = bring(it).finally(() => {
          g.over = true
          end()
          share()
        })
        going.push(g)
      }
    }
    const ticks = setInterval(share, MINUTE / 12)
    try {
      while (line.length) {
        const it = line.shift()!
        share()
        await bring(it)
      }
    } finally {
      clearInterval(ticks)
    }
    // Its line done, the job's own slot takes over a download that has a slot
    // of its own, a long one first, one at a time as it would download them:
    // that slot is free for whoever waits at once (end() ends a turn once)
    for (;;) {
      const g = going.find((g) => !g.over && isLong(g.it.v)) ?? going.find((g) => !g.over)
      if (!g) break
      g.over = true
      g.end()
      await g.done
    }
    for (let i = 0; i < going.length; i++) await going[i]!.done
    log.dl = elapsed(fetched)
    log.mb = Math.round(bytes / 2 ** 20)
    if (spare) log.spare = spare
    if (rereads) log.reread = rereads
    let ready = items.filter((it) => it.file || it.path)
    log.items = `${ready.length}/${job.listed}`
    // none to send: the post fails as its first failed download did
    const failed = () => items.find((it) => it.error)?.error ?? new Fail('failed')
    if (!ready.length) throw failed()

    const sending = Date.now()
    await status('uploading')
    for (const it of ready)
      if (it.path) {
        await SCRATCH.open(it.path, true)
        it.look = await looks(it.path, it.v, join(it.dir, 'thumb.jpg'), it.v.title || 'Video')
      }
    // as a video's upload (job())
    if (exiting) throw new Fail('restarting')
    dest.uploading = true
    const out = (them: Video[]) =>
      album(
        dest,
        post(
          dest,
          caption,
          them.map(({ file: f, path, v }) =>
            f
              ? { kind: f.kind, file: () => f.file_id }
              : { kind: v.vcodec === 'none' ? 'audio' : 'video', file: () => SCRATCH.local(path!) ?? new InputFile(path!) },
          ),
          them.map((it) => it.look),
        ),
        // each download cached as it goes out: should a later one's send
        // fail, the link sent again doesn't download it again
        (n, [kind, file_id]) => {
          const it = them[n]!
          if (it.file) return
          it.up = { kind, file_id, title: it.v.title || 'Video', url: it.v.webpage_url || url }
          settle(file_id)
          put(cacheKey(it.v), it.up)
        },
      )
    let went: Awaited<ReturnType<typeof album>>
    try {
      went = await out(ready)
    } catch (e) {
      if (!(e instanceof Dead)) throw e
      // an album with a cached copy Telegram no longer has, nothing of it
      // sent, which one Telegram doesn't say: the cached ones are forgotten
      // and left out (the link sent again downloads them), and the
      // downloaded ones go
      console.error('resend', url, e.message)
      const cached = ready.filter((it) => it.file)
      for (const it of cached) forget(it.file!)
      log.left = cached.length
      ready = ready.filter((it) => !it.file)
      if (!ready.length) throw failed()
      went = await out(ready)
    }
    log.up = elapsed(sending)
    // a dead cached copy album() left out is forgotten, as above
    const files: File[] = []
    for (const [n, it] of ready.entries()) {
      if (went[n]) files.push(it.file ?? it.up!)
      else {
        forget(it.file!)
        log.left = Number(log.left ?? 0) + 1
      }
    }
    if (!files.length) throw failed()
    log.items = `${files.length}/${job.listed}`
    if (whole(files.length)) remember(url, keys, caption)
    return { files, ...caption }
  }

  // Puts the link's file, or a post's files, into dest.chat: from the cache,
  // from a running job for the same link, or downloaded now. status(key,
  // true) is that running job's status: shown only where a queued one would
  // be. A post's cached files aren't refreshed.
  async function deliver(
    dest: Dest,
    url: string,
    status: (key: Key, follow?: boolean) => Promise<void>,
  ): Promise<Got> {
    const cached = recall(url)
    const sent =
      cached && (await resent(dest, cached, (message) => (dest.stale = { message, file_id: cached.files[0]!.file_id })))
    if (sent) return dest.stale ? refresh(dest, url, sent) : sent
    const job = jobs.get(url)
    if (job) {
      // A job that failed may have failed a send in its own chat, which a
      // request from another chat hasn't tried: unless the restart stopped
      // it, the link's old copy goes there as the job would have sent it
      // (job()). In the job's chat that send may have gone out all the same.
      const got = await resent(
        dest,
        await follow(url, job.got, status).catch((e) => {
          // (a guest reply's chat is the storage chat, every guest reply's,
          // whose id comes from the env, a string)
          const mine = !dest.single && String(job.chat) === String(dest.chat)
          const old = mine || (e instanceof Fail && e.key === 'restarting') ? undefined : get(url)
          if (!old) throw e
          return one(old)
        }),
      )
      if (!got) throw new Fail('failed')
      return got
    }
    const watch = { key: undefined as Key | undefined, tell: new Set<(key: Key) => void>() }
    watching.set(url, watch)
    const fresh = download(dest, url, (key) => {
      watch.key = key
      for (const tell of watch.tell) tell(key)
      return status(key)
    }).finally(() => {
      jobs.delete(url)
      watching.delete(url)
    })
    jobs.set(url, { got: fresh, chat: dest.chat })
    const got = await fresh
    // the job sent a cached copy that went out without its size (job())
    return dest.stale ? refresh(dest, url, got) : got
  }

  // Waits for the job of another request for the link, this one's status
  // following the job's: the job's status so far at once, then each new one
  async function follow(
    url: string,
    job: Promise<Got>,
    status: (key: Key, follow?: boolean) => Promise<void>,
  ) {
    const watch = watching.get(url)
    let told = Promise.resolve()
    const tell = (key: Key) => {
      told = told.then(() => status(key, true)).catch(() => {})
    }
    if (watch?.key) tell(watch.key)
    watch?.tell.add(tell)
    try {
      return await job
    } finally {
      watch?.tell.delete(tell)
      // the status is up before the caller edits or deletes it
      await told
    }
  }

  // The unsized video already went out: a fresh download replaces it, and if
  // that fails the old one stays, cached as before (and not tried again)
  async function refresh(dest: Dest, url: string, old: Got) {
    console.error('refresh unsized', url)
    try {
      const got = await download(dest, url, async () => {})
      swap(old.files[0]!.file_id, got.files[0]!)
      const stale = dest.stale!.message
      void unsend(() => bot.api.deleteMessage(dest.chat, stale))
      return got
    } catch (e) {
      console.error('refresh failed', url, (e as Error).message)
      return old
    } finally {
      dest.stale = undefined
    }
  }

  async function handle(ctx: Context, url: string) {
    const lang = ctx.from?.language_code
    let statusId: number | undefined
    const show = async (key: Key, follow = false, signal?: Signal) => {
      if (
        !statusId &&
        (follow || key === 'queued' || key === 'restarting') &&
        !tellQueued(ctx.chat!.type, summoned(ctx.msg!, ctx.me.username))
      )
        return
      if (statusId)
        await ctx.api
          .editMessageText(ctx.chat!.id, statusId, t(lang, key), undefined, signal)
          .catch(() => {})
      else
        statusId = (
          await ctx.reply(
            t(lang, key),
            {
              reply_parameters: {
                message_id: ctx.msg!.message_id,
                allow_sending_without_reply: true,
              },
            },
            signal,
          )
        ).message_id
    }
    // Status calls go one at a time, each after the one before it (the exit's
    // notice too); once the exit cuts the request off, the chat keeps that
    let shown = Promise.resolve()
    const then = <T>(call: () => Promise<T>) => {
      const p = shown.then(call)
      shown = p.then(() => {}, () => {})
      return p
    }
    let cut = false
    // progress isn't worth a flood wait; the answer to a failure still waits
    // its turn
    const status = (key: Key, follow = false) =>
      then(() =>
        cut ? Promise.resolve() : progress(flood.flooded(ctx.chat!.id), (signal) => show(key, follow, signal)),
      )
    const d = ctx.from
      ? promo.decide(ctx.from.id, ctx.chat!.type, lang)
      : null
    const dest: Dest = {
      chat: ctx.chat!.id,
      reply: ctx.msg!.message_id,
      promo: d?.promo,
      // anonymous admins and channel posts all come from one bot user
      who: ctx.msg!.sender_chat?.id ?? ctx.from?.id,
    }
    // The exit cuts off a request whose job hasn't begun its upload (past
    // the cut none begins one: job()), "⏫" or not. A request that has ended
    // (its final status or delete on its way), whose chat has its file (a
    // refresh may still run) or whose own job has begun the upload (a local
    // Bot API server finishes one by path after the exit) is left alone. One
    // following another request's job is cut: its own copy goes out only
    // after that job's.
    let ended = false
    const cutOff = () => {
      if (ended || dest.sent || dest.uploading) return
      cut = true
      void then(() =>
        progress(flood.flooded(ctx.chat!.id), (signal) => show('restarting', false, signal)),
      ).catch(() => {})
    }
    open.add(cutOff)
    try {
      await deliver(dest, url, status)
      ended = true
      // as shown: a post's album can't take a promo button (post())
      promo.record(d && { ...d, promo: dest.promo })
      if (ctx.from && ctx.chat!.type === 'private') promo.used(ctx.from.id)
      // a status still on its way is up before it goes, the exit's notice too
      await shown
      if (statusId)
        await ctx.api.deleteMessage(ctx.chat!.id, statusId).catch(() => {})
    } catch (e) {
      ended = true
      console.error('failed', url, (e as Error).message)
      const key = answer(
        e instanceof Fail ? e.key : 'failed',
        ctx.chat!.type,
        summoned(ctx.msg!, ctx.me.username),
        (e as Error).message,
      )
      if (key) await then(() => (cut ? Promise.resolve() : show(key))).catch(() => {})
      // nothing to say (a tweet without a video), but a status may be up (it
      // waited for a -J turn): it goes, as on success
      else
        await then(async () => {
          if (!cut && statusId) await ctx.api.deleteMessage(ctx.chat!.id, statusId)
        }).catch(() => {})
    } finally {
      open.delete(cutOff)
    }
  }

  // Guest mode: the bot gets one reply in a chat it isn't in, the answer to
  // the guest message. It goes out with a status text, which is edited as the
  // job goes on and into the video when it's ready.
  async function guest(ctx: Context) {
    const msg = ctx.guestMessage!
    const lang = ctx.from?.language_code
    const me = { ...ctx.me, mine }
    const called = summoned(msg, me.username)
    // Telegram calls it on a plain reply to one of its messages too, so as
    // in a group a link in one that doesn't mention the bot only counts on a
    // site yt-dlp knows (and gets its answer once -J has found a video
    // there, below). One that asks for nothing ("thanks") gets the help only
    // if it mentions the bot; its own message forwarded or copied here,
    // mention and all, gets nothing either.
    const url = (await requested(msg, me, 'guest'))[0]
    if (!url && (own(msg, me) || !called)) return
    // Shows key in the reply after the texts before it: the first one posts
    // the reply (the answer), the others edit it, unless key is the one asked
    // for last (Telegram refuses an edit that changes nothing; a progress
    // edit a flood dropped counts too, harmless as statuses only move on).
    // Resolves to the reply's id, undefined when the answer failed.
    let reply: Promise<string | undefined> | undefined
    let shown: Key | undefined
    const say = (key: Key, signal?: Signal) => {
      if (reply && key === shown) return reply
      shown = key
      return (reply = reply
        ? reply.then(async (id) => {
            if (id) await ctx.api.editMessageTextInline(id, t(lang, key), undefined, signal).catch(() => {})
            return id
          })
        : ctx
            .answerGuestQuery({
              type: 'article',
              id: 'status',
              title: ctx.me.first_name,
              input_message_content: { message_text: t(lang, key) },
            })
            .then(
              (m) => m.inline_message_id,
              (e) => void console.error('guest answer failed', url, (e as Error).message),
            ))
    }
    // How much longer the answer to one that doesn't mention the bot may wait
    // for -J, in ms (below)
    const left = () => msg.date * 1000 + GUEST_WAIT - Date.now()
    // Answered at once: a mention; one with no time left to wait (handled
    // late, as after an outage), unless a deploy's drain has begun (then its
    // time being up doesn't answer it, below); one whose link the bot has a
    // copy of, so a video's (deliver() sends that copy, or downloads the
    // video again first when the copy went out without its size; should the
    // copy be gone and the page have no video any more, it hears the
    // failure). A link cached before posts went out whole counts too: its
    // page is read first, and that copy goes out if nothing new can be had
    // (job()). A
    // copy whose row another process's lock keeps from being read counts as
    // none (get()). When that answer fails (the query is too old by now),
    // nobody would see the video: there's no job.
    if ((called || (left() <= 0 && !draining) || (url && (recall(url) || get(url)))) && !(await say(url ? 'downloading' : 'help'))) return
    if (!url) return
    if (!STORAGE) {
      if (reply) await say('failed')
      return
    }
    // the reply shows one file: a post's first
    const dest: Dest = { chat: STORAGE, who: ctx.from?.id, single: true }
    // Otherwise it has no answer while its link waits for a -J turn or a
    // slot, as in a group: it's answered "Downloading…" once -J has found a
    // video and the download begins. A page without one gets no answer at
    // all, nor does a tweet without a video; a link that fails for real
    // hears what a group would (unasked()).
    // The answer can't wait for -J longer than Telegram keeps the query,
    // though: GUEST_WAIT after the message was sent it goes out with where
    // the job is ("In the queue" once it has had to wait for a -J turn or a
    // slot, even while it then reads the page, as a mention shows it;
    // "Downloading…" otherwise), and then a page without a video hears so,
    // as a mention would. Not once a deploy's drain has begun: the exit
    // could leave a page without a video showing "Downloading…" for good.
    let last: Key = 'downloading'
    const late = reply
      ? undefined
      : deadline(msg.guest_query_id!, left(), () => {
          if (!reply && !draining) void say(last)
        })
    // The job doesn't wait for the reply: the answer goes through a flood
    // wait (it's the one chance to post), which mustn't hold a slot, and an
    // edit after it waits for it. Progress isn't worth a flood wait, as in
    // handle(). Past the exit's cut no job begins a download or an upload
    // (job()), so one with no answer yet stays without, as a group's request
    // the cut found: its "Downloading…" (a post's job still shows one) could
    // only lead to "send the link again", or stay up for good.
    const status = async (key: Key) => {
      if (!reply && key === 'queued') last = key
      else if (reply || !exiting) void say(key, PROGRESS)
    }
    try {
      // a reply holds one file: a post's first, with the post's caption
      const got = await deliver(dest, url, status)
      const f = got.files[0]!
      late?.()
      const id = await (reply ?? say('downloading'))
      if (!id) return
      const { caption, parse_mode } = options(dest, got)!
      await ctx.api.editMessageMediaInline(id, {
        type: f.kind,
        media: f.file_id,
        caption,
        parse_mode,
      } as InputMediaVideo)
    } catch (e) {
      late?.()
      console.error('guest failed', url, (e as Error).message)
      const key = e instanceof Fail ? e.key : 'failed'
      // once answered it hears what went wrong, as a mention does
      const told = reply ? key || 'failed' : unasked(key, (e as Error).message)
      if (told) await say(told)
    } finally {
      // detached: a long flood wait mustn't hold the handler (and a deploy's
      // drain); a post's album is all deleted
      for (const sent of [dest.sent, ...(dest.more ?? [])])
        if (sent) void unsend(() => bot.api.deleteMessage(dest.chat, sent))
    }
  }

  bot.use((ctx, next) => {
    try {
      const m = ctx.myChatMember
      if (m && m.chat.type === 'private') people.member(m.chat.id, m.new_chat_member.status)
      else if (!m) people.seen(ctx.chat?.id, ctx.from?.id, ctx.chat?.type)
    } catch (e) {
      console.error(e) // a stats write never blocks a download
    }
    return next()
  })
  const created = db.query<{ created: number }, [number]>('SELECT created FROM chats WHERE id = ?')
  bot.command(['start', 'help'], (ctx) => {
    // first: nothing the stats below run into can cost the help
    help(ctx)
    // a /start from another bot's campaign link (promo.ts); the census above has just added a new chat
    if (ctx.chat.type === 'private' && ctx.from && ctx.match)
      promo.arrived(ctx.from.id, ctx.match, () => Date.now() / 1000 - (created.get(ctx.chat.id)?.created ?? 0) < 600)
  })
  bot.on('message', (ctx) => {
    const me = { ...ctx.me, mine }
    // its own videos forwarded or copied to it get no answer, not even the help
    if (own(ctx.msg, me)) return
    const found = links(ctx.msg, me)
    // handlers run detached so one long download doesn't block the next update;
    // a throw that gets past handle()'s own catch is logged, as unhandled it
    // would end the bot
    void track(
      requested(ctx.msg, me, ctx.chat.type)
        .then((wanted) => wanted.forEach((url) => void track(handle(ctx, url).catch(console.error))))
        .catch(console.error),
    )
    if (!found.length && ctx.chat.type === 'private') help(ctx)
  })
  bot.on('guest_message', (ctx) => void track(guest(ctx).catch(console.error)))
  bot.on('my_chat_member', (ctx) => {
    const was = ctx.myChatMember.old_chat_member.status
    const now = ctx.myChatMember.new_chat_member.status
    if (ctx.chat.type === 'private' && now === 'kicked') promo.blocked(ctx.from.id)
    if (
      ctx.chat.type !== 'private' &&
      (was === 'left' || was === 'kicked') &&
      (now === 'member' || now === 'administrator')
    )
      help(ctx)
  })
  bot.catch((e) => console.error(e.error))

  setInterval(() => selfUpdate(updateOnce), 24 * 3600_000)
  void promo.refresh()
  setInterval(promo.refresh, 5 * 60_000)
  setInterval(promo.flush, 60_000)

  // Keeps the YouTube session in use so it doesn't go stale; Watch Later only
  // opens when logged in. If Google kills the session anyway, tell ADMIN_ID.
  async function keepalive() {
    if (!existsSync(JAR)) return
    const dir = await mkdtemp(join(TMP, 'keepalive-'))
    try {
      await ytdlp([
        ...(await jar(dir)),
        '--js-runtimes', 'bun', '--flat-playlist', '-I', '1', '-J',
        'https://www.youtube.com/playlist?list=WL',
      ])
      await saveJar(dir)
    } catch (e) {
      const why = `YouTube cookies look logged out, refresh COOKIES: ${(e as Error).message}`
      console.error(why)
      if (env.ADMIN_ID)
        await bot.api.sendMessage(env.ADMIN_ID, `⚠️ ${why}`).catch(console.error)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  // Polling and the shared cookie jar's keepalive run only on the container
  // holding the polling lock; bot.stop() confirms the fetched updates. They
  // begin once the first self-update try is over, while a failed one's
  // retries go on (yt-dlp runs wait for a try, not for the pauses between).
  return selfUpdate(updateOnce).first.then(() =>
    pollWithHandover(
      () => {
        setInterval(keepalive, 6 * 3600_000)
        void keepalive()
        return bot.start({
          allowed_updates: ['message', 'guest_message', 'my_chat_member'],
          onStart: (me) => console.log(`@${me.username} up, uploads ≤ ${LIMIT >> 20} MB`),
        })
      },
      () => bot.stop(),
      async () => {
        // the links still waiting for a yt-dlp -J turn or a slot won't get
        // one here (the new container polls by now), nor will a long video
        // (it couldn't finish before the exit): they hear so rather than stay
        // "in the queue". A short one that finds a free turn still goes.
        console.log(`draining ${running}`)
        draining = true
        meta.close(new Fail('restarting'))
        slots.close(new Fail('restarting'))
        // the jobs still running 2 s before the exit won't finish: their
        // chats hear so the same way, rather than keep "Downloading…", and
        // from then on no download or upload begins
        // (CUT_MS moves the cut: bot.e2e.test.ts cuts at once, reading the
        // "cut" line, and ends the drain itself)
        const exit = setTimeout(
          () => {
            exiting = true
            console.log(`cut ${open.size}`)
            open.forEach((cut) => cut())
          },
          Number(env.CUT_MS ?? DRAIN - 2_000),
        )
        while (running) await Bun.sleep(100)
        clearTimeout(exit)
        await promo.flush()
      },
    ),
  )
}

if (import.meta.main) {
  // An e2e bot exits once its test process is gone, and its yt-dlp runs'
  // groups go with it: a test run killed outright (a SIGKILL, a worker's time
  // limit) can't stop its bots, and one left behind would poll its fake Bot
  // API's port for good, which a later test's fake may get (#460).
  // E2E_PARENT_PID is that process's pid (bot.e2e.test.ts); once it's gone,
  // the bot is another process's child (launchd's, init's or a subreaper's).
  // Production sets no E2E_PARENT_PID, and nothing watches (nor for 1 or less:
  // a container's PID 1 bot has the parent 0)
  const parent = Number(env.E2E_PARENT_PID)
  if (parent > 1)
    setInterval(() => {
      if (process.ppid === parent) return
      runs.forEach((end) => end())
      console.error(`E2E_PARENT_PID ${parent} is gone (the parent is ${process.ppid} now), exiting`)
      process.exit(1)
    }, 1000).unref()
  if (!env.EGRESS_DENY?.trim())
    console.warn("EGRESS_DENY is empty: the host's own public addresses are reachable")
  await SCRATCH.start()
  await mkdir(DATA, { recursive: true })
  await seedJar()
  await main()
}
