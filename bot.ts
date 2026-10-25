import { Database } from 'bun:sqlite'
import { Bot, type Context, GrammyError, InputFile } from 'grammy'
import type { InputMediaVideo, Message } from 'grammy/types'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { egressProxy, proxyFreeEnv } from './egress'
import { type Key, t } from './i18n'

const env = process.env
const API = env.BOT_API_URL || 'https://api.telegram.org'
// A local Bot API server takes uploads up to 2000 MB, the cloud one 50 MB
const LIMIT = (API.includes('api.telegram.org') ? 50 : 2000) * 1024 * 1024
const COOKIES = env.COOKIES || '/cookies.txt'
const DATA = env.DATA_DIR || './data'
const TMP = join(tmpdir(), 'videodownloadbot')
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
// Where a file goes: a chat, replying to a message there; sent = the id of
// the message that carried it
type Dest = { chat: number | string; reply?: number; sent?: number }
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

// What to tell the chat about a failed link, null = nothing. "Not a video"
// only gets an answer from whoever asked the bot itself.
export const answer = (key: Key | null, chat: string, called: boolean) =>
  key ?? (chat === 'private' || called ? 'failed' : null)

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
          const url = new URL(/^\w+:\/\//.test(u) ? u : `https://${u}`)
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
async function ytdlp(args: string[]) {
  // a failed listen isn't kept: the next download tries again
  proxy ??= egressProxy().catch((e) => {
    proxy = undefined
    throw e
  })
  const p = Bun.spawn(['yt-dlp', '--proxy', await proxy, ...args], {
    env: proxyFreeEnv(),
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
  const forget = (f: File) =>
    db.query('DELETE FROM files WHERE file_id = ?').run(f.file_id)

  const bot = new Bot(env.TOKEN!, {
    client: { apiRoot: API, timeoutSeconds: 3600 },
  })
  const jobs = new Map<string, Promise<File>>()

  async function send(
    dest: Dest,
    kind: Kind,
    file: () => string | InputFile,
    opts: Opts,
  ): Promise<[Kind, string]> {
    const { chat } = dest
    const api = bot.api
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
      // a fresh upload Telegram won't take as media still goes as a file
      if (kind === 'document' || typeof file() === 'string') throw e
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
    return [sent, media.file_id]
  }

  const options = (dest: Dest, f: Pick<File, 'title' | 'url'>): Opts => ({
    caption: `<a href="${esc(f.url)}">${esc([...f.title].slice(0, 200).join(''))}</a>\n@${bot.botInfo.username}`,
    parse_mode: 'HTML',
    supports_streaming: true,
    disable_notification: !dest.reply,
    reply_parameters: dest.reply
      ? { message_id: dest.reply, allow_sending_without_reply: true }
      : undefined,
  })

  // false = the cached file_id is dead, download again; other errors (flood
  // wait, blocked bot, no media rights) keep the cache and propagate
  async function resend(dest: Dest, f: File) {
    try {
      await send(dest, f.kind, () => f.file_id, options(dest, f))
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
      const args = [...YTDLP, ...(await jar(dir))]
      let json: string
      try {
        json = (await ytdlp([...args, '-J', url])).out
      } catch (e) {
        const why = String((e as Error).message)
        // an untagged error needs the extractors that claim the link
        const ies = /^(ERROR: )?\[/.test(why)
          ? []
          : ((await claims([url]).catch(() => undefined))?.get(url) ?? [])
        throw new Fail(notVideo(why, ies) ? null : 'failed', why)
      }
      const v = picked(JSON.parse(json))
      if (v.is_live) throw new Fail('failed', 'live stream')
      const id = `${v.extractor_key}:${v.id}`
      const hit = get.get(id)
      if (hit && (await resend(dest, hit))) {
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
      const audio = v.vcodec === 'none'
      const thumb = join(dir, 'thumb.jpg')
      if (!audio)
        await Bun.spawn([
          'ffmpeg', '-v', 'error', '-y',
          '-ss', String(Math.min(1, (v.duration ?? 0) / 2)),
          '-i', path,
          '-frames:v', '1',
          '-vf', 'scale=320:320:force_original_aspect_ratio=decrease',
          thumb,
        ]).exited
      const f = { title: v.title || 'Video', url: v.webpage_url || url }
      const [kind, file_id] = await send(
        dest,
        audio ? 'audio' : 'video',
        () => new InputFile(path),
        {
          ...options(dest, f),
          width: v.width ?? undefined,
          height: v.height ?? undefined,
          duration: v.duration ? Math.round(v.duration) : undefined,
          thumbnail: existsSync(thumb) ? new InputFile(thumb) : undefined,
          title: audio ? f.title : undefined,
          performer: audio ? v.uploader : undefined,
        },
      )
      const file = { ...f, kind, file_id }
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
    if (cached && (await resend(dest, cached))) return cached
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

  async function handle(ctx: Context, url: string) {
    const lang = ctx.from?.language_code
    let statusId: number | undefined
    const status = async (key: Key) => {
      if (statusId)
        await ctx.api
          .editMessageText(ctx.chat!.id, statusId, t(lang, key))
          .catch(() => {})
      else
        statusId = (
          await ctx.reply(t(lang, key), {
            reply_parameters: {
              message_id: ctx.msg!.message_id,
              allow_sending_without_reply: true,
            },
          })
        ).message_id
    }
    try {
      await deliver(
        { chat: ctx.chat!.id, reply: ctx.msg!.message_id },
        url,
        status,
      )
      if (statusId)
        await ctx.api.deleteMessage(ctx.chat!.id, statusId).catch(() => {})
    } catch (e) {
      console.error('failed', url, (e as Error).message)
      const key = answer(
        e instanceof Fail ? e.key : 'failed',
        ctx.chat!.type,
        summoned(ctx.msg!, ctx.me.username),
      )
      if (key) await status(key).catch(() => {})
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
    const status = (key: Key) =>
      ctx.api
        .editMessageTextInline(id, t(lang, key))
        .then(() => {}, () => {})
    if (!STORAGE) return status('failed')
    const dest: Dest = { chat: STORAGE }
    try {
      const f = await deliver(dest, url, status)
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

  bot.command(['start', 'help'], (ctx) =>
    ctx.reply(t(ctx.from?.language_code, 'help')),
  )
  bot.on('message', (ctx) => {
    const found = links(ctx.msg, ctx.me.username)
    // handlers run detached so one long download doesn't block the next update
    void requested(ctx.msg, ctx.me.username, ctx.chat.type)
      .then((wanted) => wanted.forEach((url) => void handle(ctx, url)))
      .catch(console.error)
    if (!found.length && ctx.chat.type === 'private')
      return ctx.reply(t(ctx.from.language_code, 'help'))
  })
  bot.on('guest_message', (ctx) => void guest(ctx).catch(console.error))
  bot.on('my_chat_member', (ctx) => {
    const was = ctx.myChatMember.old_chat_member.status
    const now = ctx.myChatMember.new_chat_member.status
    if (
      ctx.chat.type !== 'private' &&
      (was === 'left' || was === 'kicked') &&
      (now === 'member' || now === 'administrator')
    )
      return ctx.reply(t(ctx.from.language_code, 'help'))
  })
  bot.catch((e) => console.error(e.error))

  // ponytail: in-process daily self-update; pin a version if nightly ever breaks
  const update = () =>
    Bun.spawn(['yt-dlp', '--update-to', 'nightly'], { stdout: 'inherit' })
      .exited
  setInterval(update, 24 * 3600_000)

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
  setInterval(keepalive, 6 * 3600_000)
  void keepalive()
  // exit once polling stops: timers keep Bun alive, and Docker would wait 30 s to kill it
  const stop = () => bot.stop().finally(() => process.exit())
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  return update().then(() =>
    bot.start({
      allowed_updates: ['message', 'guest_message', 'my_chat_member'],
      onStart: (me) => console.log(`@${me.username} up, uploads ≤ ${LIMIT >> 20} MB`),
    }),
  )
}

if (import.meta.main) {
  if (!env.EGRESS_DENY?.trim())
    console.warn("EGRESS_DENY is empty: the host's own public addresses are reachable")
  await rm(TMP, { recursive: true, force: true })
  await mkdir(TMP, { recursive: true })
  await mkdir(DATA, { recursive: true })
  await seedJar()
  await main()
}
