import { Database } from 'bun:sqlite'
import { type Api, Bot, type Context, GrammyError, InputFile, type Transformer } from 'grammy'
import type { ApiResponse, InputMediaVideo, Message } from 'grammy/types'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { egressProxy, proxyFreeEnv } from './egress'
import { pollWithHandover } from './handover'
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
const MAX_DOWNLOADS = Number(env.MAX_DOWNLOADS || 3)
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
]

type Kind = 'video' | 'animation' | 'audio' | 'document'
type File = { kind: Kind; file_id: string; title: string; url: string }
type Opts = Parameters<Context['api']['sendVideo']>[2] &
  Parameters<Context['api']['sendAudio']>[2]
// Where a file goes: a chat, replying to a message there, with a promo line
// or button if the user's experiment arm has one (promo.ts); sent = the id
// of the message that carried it; stale = a cached video that went out
// without a size, being downloaded again to replace it
type Dest = { chat: number | string; reply?: number; sent?: number; promo?: Promo; stale?: number }
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

// A tweet with only text or pictures: shared everywhere, never worth an answer
const TWEET_NO_VIDEO = /\[twitter\].*no video could be found/i

// What to tell the chat about a failed link, null = nothing. "Not a video"
// only gets an answer from whoever asked the bot itself.
export const answer = (key: Key | null, chat: string, called: boolean, why = '') =>
  TWEET_NO_VIDEO.test(why) ? null : key ?? (chat === 'private' || called ? 'failed' : null)

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

// Called on: by an @mention, or in a guest message
export const summoned = (msg: Message, username: string, guest = false) =>
  guest || new RegExp(`@${username}\\b`, 'i').test(msg.text ?? msg.caption ?? '')

// Also the links in the message replied to when the bot is summoned
export function links(msg: Message, username: string, guest = false) {
  const reply = summoned(msg, username, guest) ? msg.reply_to_message : undefined
  return [...new Set([...urls(msg), ...(reply ? urls(reply) : [])])]
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
  const { out } = await check(() => ytdlp(['--list-extractors', '--', ...urls]))
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
// only links to a site yt-dlp knows count.
export async function requested(
  msg: Message,
  username: string,
  chat: string,
  video = videos,
) {
  const found = links(msg, username)
  return chat === 'private' || summoned(msg, username) || !found.length
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
// ponytail: in-process daily self-update; pin a version if nightly ever breaks
// The update swaps the binary out, so a run started meanwhile waits for it
// (else spawn fails with "Executable not found")
let updating: Promise<unknown> = Promise.resolve()
const update = () =>
  (updating = Bun.spawn(['yt-dlp', '--update-to', 'nightly'], {
    env: { ...process.env, ...SCRATCH.env },
    stdout: 'inherit',
  }).exited)

async function ytdlp(args: string[]) {
  // a failed listen isn't kept: the next download tries again
  proxy ??= egressProxy().catch((e) => {
    proxy = undefined
    throw e
  })
  await updating
  const p = Bun.spawn(['yt-dlp', '--proxy', await proxy, ...args], {
    env: { ...proxyFreeEnv(), ...SCRATCH.env },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30 * 60_000,
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  if (code) throw new Error(err.trim().split('\n').pop() || `yt-dlp ${code}`)
  return { out, err }
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

// A new file rather than a cached file_id (a local file:// path is new too)
export const fresh = (f: string | InputFile) =>
  typeof f !== 'string' || f.startsWith('file:')

// Runs at most max fns at once, the rest wait their turn
function limit(max: number) {
  let running = 0
  const queue: (() => void)[] = []
  return async <T>(fn: () => Promise<T>) => {
    if (running < max) running++
    else await new Promise<void>((r) => queue.push(r))
    try {
      return await fn()
    } finally {
      const next = queue.shift()
      if (next) next()
      else running--
    }
  }
}
const slot = limit(MAX_DOWNLOADS)
// group links are checked one yt-dlp run per message: a flood of them
// queues instead of forking a process each
const check = limit(2)

// The signal of a progress message, which isn't worth a flood wait. grammY's
// Node typings have an AbortSignal of their own, which a real one fits.
type Signal = NonNullable<Parameters<Api['sendMessage']>[3]>
export const PROGRESS = new AbortController().signal as unknown as Signal

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

// Sends a file to dest.chat as kind; returns the kind it went as, its file_id
// and the message
export const sender = (api: Api) =>
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
    const media = m.video ?? m.animation ?? m.audio ?? m.document
    dest.sent = m.message_id
    if (!media) throw new Error('no file in sent message')
    const sent = m.video
      ? 'video'
      : m.animation
        ? 'animation'
        : m.audio
          ? 'audio'
          : 'document'
    return [sent, media.file_id, m]
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

function main() {
  const db = new Database(join(DATA, 'bot.sqlite'), { create: true })
  db.run(
    'CREATE TABLE IF NOT EXISTS files (key TEXT PRIMARY KEY, kind TEXT NOT NULL, file_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL)',
  )
  const get = db.query<File, [string]>('SELECT * FROM files WHERE key = ?')
  const put = (key: string, f: File) =>
    db
      .query('INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?)')
      .run(key, f.kind, f.file_id, f.title, f.url)
  // file_ids uploaded with the file's own size (#281), or whose one refresh
  // was tried; older videos may have gone out without a size. A table of its
  // own: a container still running the old code keeps writing files.
  db.run('CREATE TABLE IF NOT EXISTS sized (file_id TEXT PRIMARY KEY)')
  // true the first time only
  const settle = (fileId: string) =>
    db.query('INSERT OR IGNORE INTO sized VALUES (?)').run(fileId).changes > 0
  // every link cached with the old file gets the new one
  const swap = (old: string, f: File) =>
    db.query('UPDATE files SET kind = ?, file_id = ? WHERE file_id = ?').run(f.kind, f.file_id, old)
  const forget = (f: File) =>
    db.query('DELETE FROM files WHERE file_id = ?').run(f.file_id)
  const people = census(db)
  Bun.serve({
    port: Number(env.STATS_PORT || 8080),
    fetch: (req) =>
      new URL(req.url).pathname === '/stats'
        ? Response.json(people.stats())
        : new Response('Not found', { status: 404 }),
  })

  const promo = promos(db)
  const bot = new Bot(env.TOKEN!, {
    client: { apiRoot: API, timeoutSeconds: 3600 },
  })
  // every request, ctx.api's too (grammY copies the bot's transformers)
  const flood = floodWait()
  bot.api.config.use(flood)
  const jobs = new Map<string, Promise<File>>()
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

  const send = sender(bot.api)

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
      if (!(e instanceof GrammyError && e.error_code === 400 && /file/i.test(e.description)))
        throw e
      console.error('resend', f.url, e.description)
      forget(f)
      return false
    }
  }

  async function download(
    dest: Dest,
    url: string,
    status: (key: Key) => Promise<void>,
  ): Promise<File> {
    if (dest.reply)
      void bot.api.sendChatAction(dest.chat, 'upload_video').catch(() => {})
    // the whole job holds a slot: a link flood can't fork unbounded yt-dlp
    // runs or pile finished files up in TMP while uploads crawl
    return slot(() => job(dest, url, status))
  }

  async function job(
    dest: Dest,
    url: string,
    status: (key: Key) => Promise<void>,
  ): Promise<File> {
    const dir = await mkdtemp(join(TMP, 'job-'))
    try {
      await SCRATCH.open(dir)
      const args = [...YTDLP, ...(await jar(dir))]
      let json: string
      try {
        json = (await ytdlp([...args, '-J', url])).out
      } catch (e) {
        const why = String((e as Error).message)
        const soon = unstarted(why)
        if (soon) throw new Fail(soon, why)
        // an untagged error needs the extractors that claim the link
        const ies = /^(ERROR: )?\[/.test(why)
          ? []
          : ((await claims([url]).catch(() => undefined))?.get(url) ?? [])
        throw new Fail(notVideo(why, ies) ? null : 'failed', why)
      }
      const v = picked(JSON.parse(json))
      const stream = unready(v)
      if (stream) throw new Fail(stream, `${stream} stream`)
      const id = `${v.extractor_key}:${v.id}`
      const hit = get.get(id)
      // a refresh wants a new upload, not another cached copy
      if (hit && !dest.stale && (await resend(dest, hit))) {
        put(url, hit)
        return hit
      }
      const formats: { filesize?: number; filesize_approx?: number }[] =
        v.requested_formats ?? [v]
      const size = formats.reduce(
        (s, f) => s + (f.filesize ?? f.filesize_approx ?? 0),
        0,
      )
      if (size > LIMIT) throw new Fail('tooBig')

      await status('downloading')
      await Bun.write(join(dir, 'info.json'), json)
      const { out, err } = await ytdlp([
        ...args,
        '--load-info-json', join(dir, 'info.json'),
        '-o', join(dir, 'v.%(ext)s'),
        '--max-filesize', String(LIMIT),
        '--print', 'after_move:filepath',
      ])
      const path = out.trim().split('\n').pop()
      // --print implies --quiet, so a file over --max-filesize is skipped
      // with exit 0 and no output at all
      if (!path || !existsSync(path))
        throw new Fail(err.trim() ? 'failed' : 'tooBig', err)
      if ((await stat(path)).size > LIMIT) throw new Fail('tooBig')

      await status('uploading')
      await SCRATCH.open(path, true)
      const audio = v.vcodec === 'none'
      const thumb = join(dir, 'thumb.jpg')
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
      const f = { title: v.title || 'Video', url: v.webpage_url || url }
      const [kind, file_id] = await send(
        dest,
        audio ? 'audio' : 'video',
        () => SCRATCH.local(path) ?? new InputFile(path),
        {
          ...options(dest, f),
          width: box?.width ?? v.width ?? undefined,
          height: box?.height ?? v.height ?? undefined,
          duration: v.duration ? Math.round(v.duration) : undefined,
          thumbnail: existsSync(thumb) ? new InputFile(thumb) : undefined,
          title: audio ? f.title : undefined,
          performer: audio ? v.uploader : undefined,
        },
      )
      const file = { ...f, kind, file_id }
      settle(file_id)
      put(id, file)
      put(url, file)
      return file
    } finally {
      await saveJar(dir).catch(console.error)
      await rm(dir, { recursive: true, force: true })
    }
  }

  // Puts the file into dest.chat: from the cache, from a running job for the
  // same link, or downloaded now
  async function deliver(
    dest: Dest,
    url: string,
    status: (key: Key) => Promise<void>,
  ): Promise<File> {
    const cached = get.get(url)
    if (cached && (await resend(dest, cached, (id) => (dest.stale = id))))
      return dest.stale ? refresh(dest, url, cached) : cached
    const job = jobs.get(url)
    if (job) {
      const f = await job
      if (!(await resend(dest, f))) throw new Fail('failed')
      return f
    }
    const fresh = download(dest, url, status).finally(() => jobs.delete(url))
    jobs.set(url, fresh)
    return fresh
  }

  // The unsized video already went out: a fresh download replaces it, and if
  // that fails the old one stays, cached as before (and not tried again)
  async function refresh(dest: Dest, url: string, old: File) {
    console.error('refresh unsized', url)
    try {
      const f = await download(dest, url, async () => {})
      swap(old.file_id, f)
      await bot.api.deleteMessage(dest.chat, dest.stale!).catch(() => {})
      return f
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
    const show = async (key: Key, signal?: Signal) => {
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
    // progress isn't worth a flood wait; the answer to a failure still waits
    // its turn
    const status = (key: Key) =>
      progress(flood.flooded(ctx.chat!.id), (signal) => show(key, signal))
    const d = ctx.from
      ? promo.decide(ctx.from.id, ctx.chat!.type, lang)
      : null
    try {
      await deliver(
        { chat: ctx.chat!.id, reply: ctx.msg!.message_id, promo: d?.promo },
        url,
        status,
      )
      promo.record(d)
      if (ctx.from && ctx.chat!.type === 'private') promo.used(ctx.from.id)
      if (statusId)
        await ctx.api.deleteMessage(ctx.chat!.id, statusId).catch(() => {})
    } catch (e) {
      console.error('failed', url, (e as Error).message)
      const key = answer(
        e instanceof Fail ? e.key : 'failed',
        ctx.chat!.type,
        summoned(ctx.msg!, ctx.me.username),
        (e as Error).message,
      )
      if (key) await show(key).catch(() => {})
    }
  }

  // Guest mode: the bot gets one reply in a chat it isn't in. It answers with
  // a status text at once and edits the video into it when it's ready.
  async function guest(ctx: Context) {
    const msg = ctx.guestMessage!
    const lang = ctx.from?.language_code
    const url = links(msg, ctx.me.username, true)[0]
    const { inline_message_id: id } = await ctx.answerGuestQuery({
      type: 'article',
      id: 'status',
      title: ctx.me.first_name,
      input_message_content: {
        message_text: t(lang, url ? 'downloading' : 'help'),
      },
    })
    if (!url) return
    const status = (key: Key, signal?: Signal) =>
      ctx.api
        .editMessageTextInline(id, t(lang, key), undefined, signal)
        .then(() => {}, () => {})
    if (!STORAGE) return status('failed')
    const dest: Dest = { chat: STORAGE }
    try {
      // progress isn't worth a flood wait, as in handle()
      const f = await deliver(dest, url, (key) => status(key, PROGRESS))
      const { caption, parse_mode } = options(dest, f)!
      await ctx.api.editMessageMediaInline(id, {
        type: f.kind,
        media: f.file_id,
        caption,
        parse_mode,
      } as InputMediaVideo)
    } catch (e) {
      console.error('guest failed', url, (e as Error).message)
      await status((e instanceof Fail && e.key) || 'failed')
    } finally {
      if (dest.sent)
        await bot.api.deleteMessage(dest.chat, dest.sent).catch(() => {})
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
    // a /start from another bot's campaign link (promo.ts); the census above has just added a new chat
    if (ctx.chat.type === 'private' && ctx.from && ctx.match)
      promo.arrived(ctx.from.id, ctx.match, Date.now() / 1000 - (created.get(ctx.chat.id)?.created ?? 0) < 600)
    help(ctx)
  })
  bot.on('message', (ctx) => {
    const found = links(ctx.msg, ctx.me.username)
    // handlers run detached so one long download doesn't block the next update
    void track(
      requested(ctx.msg, ctx.me.username, ctx.chat.type)
        .then((wanted) => wanted.forEach((url) => void track(handle(ctx, url))))
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

  setInterval(update, 24 * 3600_000)
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
  // holding the polling lock; bot.stop() confirms the fetched updates
  return update().then(() =>
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
        while (running) await Bun.sleep(100)
        await promo.flush()
      },
    ),
  )
}

if (import.meta.main) {
  if (!env.EGRESS_DENY?.trim())
    console.warn("EGRESS_DENY is empty: the host's own public addresses are reachable")
  await SCRATCH.start()
  await mkdir(DATA, { recursive: true })
  await seedJar()
  await main()
}
