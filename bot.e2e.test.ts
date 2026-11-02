import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { t } from './i18n'

// The real bot, polling a fake Bot API, with test/yt-dlp standing in for
// yt-dlp: a link with "long" in it is a 50-minute video that downloads in
// 3 s, one with "reel" (an Instagram reel) or "stream" in it says nothing of
// its length, any other is a 30-second one; those download in 0.2 s ("crawl"
// ones take 9 s, "broken" and "huge" ones fail, "endless" ones pass 2000 MB;
// test/yt-dlp has the rest).
// MAX_DOWNLOADS=2: one slot for long videos, the other for short ones. env
// adds to or overrides the bot's environment, delay = how long the fake Bot
// API takes to answer a call, in ms, or what it waits for (a gate()).
type Call = {
  method: string
  chat: number
  text?: string
  upload?: boolean
  inline?: string
  file?: Uint8Array
  caption?: string
  title?: string
  performer?: string
  duration?: number
}
// The video every fake download copies (FAKE_MP4), made once: an ffmpeg run
// per test, in spawnSync, would hold up all the concurrent ones (0.4 s each)
const fixture = mkdtempSync(join(tmpdir(), 'bot-e2e-mp4-'))
const mp4 = join(fixture, 'v.mp4')
if (Bun.which('ffmpeg'))
  Bun.spawnSync(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=1', '-pix_fmt', 'yuv420p', mp4])
afterAll(() => rmSync(fixture, { recursive: true, force: true }))

function start(env: Record<string, string> = {}, delay: (call: Call) => number | Promise<unknown> = () => 0) {
  const work = mkdtempSync(join(tmpdir(), 'bot-e2e-'))
  const gates = join(work, 'gates')
  mkdirSync(gates)
  // upload = a file sent, not a file_id
  const calls: Call[] = []
  const updates: { update_id: number }[] = []
  let id = 0
  const api = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop()!
      const type = req.headers.get('content-type') ?? ''
      const body: Record<string, any> = type.includes('multipart')
        ? Object.fromEntries(await req.formData())
        : type.includes('json')
          ? await req.json()
          : {}
      const ok = (result: unknown) => Response.json({ ok: true, result })
      const chat = { id: Number(body.chat_id), type: 'private' }
      if (method === 'getMe') return ok({ id: 1, is_bot: true, first_name: 'Vid', username: 'VidBot' })
      if (method === 'getUpdates') {
        const next = updates.filter((u) => u.update_id >= (body.offset ?? 0))
        if (!next.length) await Bun.sleep(100)
        return ok(next)
      }
      // inline = the guest reply an edit is to, file = the bytes uploaded
      // (grammY sends a file as attach://<the field it's in>), title,
      // performer and duration as a video or audio file was sent with
      const media = [body.video, body.audio]
        .map((x) => (typeof x === 'string' && x.startsWith('attach://') ? body[x.slice(9)] : x))
        .find((x) => x instanceof Blob)
      const call = {
        method,
        chat: chat.id,
        text: body.text,
        upload: type.includes('multipart'),
        inline: body.inline_message_id,
        file: media && new Uint8Array(await media.arrayBuffer()),
        caption: body.caption,
        title: body.title,
        performer: body.performer,
        duration: body.duration === undefined ? undefined : Number(body.duration),
      }
      calls.push(call)
      const ms = delay(call)
      if (typeof ms !== 'number') await ms
      else if (ms) await Bun.sleep(ms)
      if (method === 'answerGuestQuery') return ok({ inline_message_id: `g${++id}` })
      if (method === 'sendMessage') return ok({ message_id: ++id, date: 0, chat, text: body.text })
      // cached file_ids "unsized…" went out without a size, as before #281
      if (method === 'sendVideo')
        return ok({
          message_id: ++id,
          date: 0,
          chat,
          video: {
            file_id: `v${id}`,
            file_unique_id: `u${id}`,
            ...(String(body.video).startsWith('unsized') ? {} : { width: 320, height: 240 }),
            duration: 1,
          },
        })
      if (method === 'sendAudio')
        return ok({ message_id: ++id, date: 0, chat, audio: { file_id: `a${id}`, file_unique_id: `u${id}`, duration: 1 } })
      return ok(true)
    },
  })
  const bot = Bun.spawn([process.execPath, 'bot.ts'], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      PATH: `${join(import.meta.dir, 'test')}:${process.env.PATH}`,
      TOKEN: '1:test',
      BOT_API_URL: `http://127.0.0.1:${api.port}`,
      DATA_DIR: join(work, 'data'),
      COOKIES: join(work, 'none'),
      TMPDIR: work,
      MAX_DOWNLOADS: '2',
      STATS_PORT: '0',
      SHARED_DIR: '',
      HANDOVER_LOCK: '',
      PROMO_TOKEN: '',
      FAKE_MP4: mp4,
      GATES: gates,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'ignore',
  })
  // the bot's stdout lines so far
  const lines: string[] = []
  let termed = false
  const reading = (async () => {
    let rest = ''
    for await (const chunk of bot.stdout.pipeThrough(new TextDecoderStream())) {
      const parts = (rest + chunk).split('\n')
      rest = parts.pop()!
      lines.push(...parts)
    }
  })()
  // a message from user with a link to video v (and whatever else follows
  // it in the query)
  const message = (user: number, v: string) => {
    const text = `https://www.youtube.com/watch?v=${v}`
    return {
      message_id: ++id,
      date: 0,
      text,
      entities: [{ type: 'url', offset: 0, length: text.length }],
      chat: { id: user, type: 'private', first_name: 'u' },
      from: { id: user, is_bot: false, first_name: 'u', language_code: 'en' },
    }
  }
  return {
    calls,
    // FAKE_MP4's bytes, which a download copies
    mp4: readFileSync(mp4),
    // in a private chat
    link(user: number, v: string) {
      updates.push({ update_id: updates.length + 1, message: message(user, v) } as { update_id: number })
    },
    // as a guest message, the bot summoned in a chat it isn't in
    guest(user: number, v: string) {
      updates.push({
        update_id: updates.length + 1,
        guest_message: { ...message(user, v), guest_query_id: 'q' },
      } as { update_id: number })
    },
    // the status texts the guest replies got
    inline: () => calls.filter((c) => c.inline && c.method === 'editMessageText').map((c) => c.text!),
    async until(done: () => boolean, ms = 15_000) {
      for (let i = 0; i < ms / 50 && !done(); i++) await Bun.sleep(50)
      expect(done()).toBe(true)
    },
    videos: () => calls.filter((c) => c.method === 'sendVideo'),
    // the status texts a chat got, sent or edited
    statuses: (chat: number) =>
      calls.filter((c) => c.chat === chat && /^(sendMessage|editMessageText)$/.test(c.method)).map((c) => c.text!),
    // whether a "jhold" link's -J or a "dhold" link's download is held, and
    // lets it go on (test/yt-dlp)
    held: (v: string, what: 'J' | 'dl') => existsSync(join(gates, `${v}.${what}.held`)),
    release(v: string, what: 'J' | 'dl') {
      writeFileSync(join(gates, `${v}.${what}`), '')
    },
    // a deploy's SIGTERM; resolves once the drain has begun, and with
    // CUT_MS=0 (DEPLOY) once it has cut
    async term() {
      termed = true
      bot.kill('SIGTERM')
      const said = (word: string) => lines.some((l) => l.startsWith(word))
      await this.until(() => said('draining ') && (env.CUT_MS !== '0' || said('cut ')))
    },
    // the exit, when nothing that's still running may finish
    kill() {
      bot.kill('SIGKILL')
    },
    // SIGTERM, as on a deploy (unless term() has sent it: a second one
    // kills), then the bot's end; resolves to its job log lines
    async stop() {
      if (!termed) bot.kill('SIGTERM')
      await bot.exited
      // the answers to calls still on their way
      await Bun.sleep(100)
      api.stop(true)
      await reading
      rmSync(work, { recursive: true, force: true })
      return lines.filter((l) => l.startsWith('job '))
    },
  }
}

const skip = !Bun.which('ffmpeg') && !process.env.CI

// A fake Bot API answer that waits until the test opens it
function gate() {
  let open = () => {}
  const p = new Promise<void>((go) => (open = go))
  return Object.assign(p, { open })
}
// The deploy tests' drain: it cuts at once, and nothing ends it but the
// test, or the handlers all being done (no 15 s timer to race)
const DEPLOY = { DRAIN_MS: '600000', CUT_MS: '0' }
// Half time, for the tests of time limits: a minute is 125 ms, a stopped
// yt-dlp run is over 2.5 s after its SIGTERM, and test/yt-dlp's waits are halved
const HALF = { MINUTE_MS: '125', GRACE_MS: '2500', FAKE_SCALE: '0.5' }
// Whether a process is still running; a zombie counts as gone: a container's
// PID 1 may never reap the orphan
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    const state = existsSync('/proc')
      ? readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop()!
      : Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)]).stdout.toString().trim()
    return state !== '' && !state.startsWith('Z')
  } catch {
    return false
  }
}

test.skipIf(skip)(
  'bot: a short link goes out while long ones download, and a queued one says so',
  async () => {
    const bot = start()
    let jobs: string[] = []
    try {
      // one user's two long links go one at a time...
      bot.link(1, 'long1')
      await bot.until(() => bot.statuses(1).length > 0)
      bot.link(1, 'long2')
      await bot.until(() => bot.statuses(1).some((s) => s.startsWith('⏳')))
      // ...and another user's short link doesn't wait for them
      bot.link(2, 'short1')
      // a third user asks for the queued video (long2) too
      bot.link(3, 'long2')
      await bot.until(() => bot.videos().length === 4)
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.videos().map((v) => v.chat)).toEqual([2, 1, 1, 3])
    expect(bot.statuses(2).map((s) => s[0])).toEqual(['⏬', '⏫'])
    // the first long one downloads, the second is queued until it's done,
    // then gets the usual statuses, and every status is gone in the end
    const one = bot.statuses(1).map((s) => s[0])
    expect(one.slice(0, 2).sort()).toEqual(['⏬', '⏳'].sort())
    expect(one.slice(2)).toEqual(['⏫', '⏬', '⏫'])
    // the third user's request follows the job: queued, then downloading and uploading
    expect(bot.statuses(3).map((s) => s[0])).toEqual(['⏳', '⏬', '⏫'])
    for (const chat of [1, 2, 3]) {
      const n = (m: string) => bot.calls.filter((c) => c.chat === chat && c.method === m).length
      expect(n('deleteMessage')).toBe(n('sendMessage'))
    }
    expect(jobs).toHaveLength(3)
    expect(jobs.filter((l) => /^job ok host=www\.youtube\.com .*lane=long/.test(l))).toHaveLength(2)
    expect(jobs.filter((l) => /^job ok .*lane=short ahead=0 own=0 dur=30 wait=0\.0 /.test(l))).toHaveLength(1)
    // the second long one waited for the first, its user's own
    expect(jobs.some((l) => /lane=long ahead=0 own=1 dur=3000 wait=([2-9]|\d{2,})\./.test(l))).toBe(true)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: an Instagram reel, which doesn't say how long it is, goes out while three long videos download; a stream that doesn't waits",
  async () => {
    // four slots, three for long videos
    const bot = start({ MAX_DOWNLOADS: '4' })
    let jobs: string[] = []
    const downloading = (chat: number) => bot.statuses(chat).filter((s) => s.startsWith('⏬')).length
    try {
      // two users' long links take the three long slots (one user's take two at most)...
      bot.link(1, 'long1')
      bot.link(1, 'long2')
      bot.link(2, 'long3')
      await bot.until(() => downloading(1) === 2 && downloading(2) === 1)
      // ...a reel takes the fourth at once, and a stream of unknown length waits for a long one
      bot.link(3, 'reel1')
      bot.link(4, 'stream1')
      await bot.until(() => bot.videos().length === 5)
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.videos()[0]!.chat).toBe(3)
    expect(bot.statuses(3).map((s) => s[0])).toEqual(['⏬', '⏫'])
    expect(bot.statuses(4).map((s) => s[0])).toEqual(['⏳', '⏬', '⏫'])
    expect(jobs).toHaveLength(5)
    // (user 1's second long one may ask while their first has a slot)
    expect(jobs.filter((l) => /^job ok .*lane=long ahead=0 own=[01] dur=3000 wait=0\.0 /.test(l))).toHaveLength(3)
    expect(jobs.filter((l) => /^job ok .*lane=short ahead=0 own=0 dur=\? wait=0\.0 /.test(l))).toHaveLength(1)
    expect(jobs.filter((l) => /^job ok .*lane=long ahead=0 own=0 dur=\? wait=([2-9]|\d{2,})\./.test(l))).toHaveLength(1)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: by default eight slots, seven for long videos, one user's long ones six; the job line counts the user's own jobs that have a slot or wait for one",
  async () => {
    // An empty MAX_DOWNLOADS is read as unset, so this runs the default;
    // "dhold" downloads go on once the test lets them
    const bot = start({ MAX_DOWNLOADS: '' })
    let jobs: string[] = []
    const downloading = (chat: number) => bot.statuses(chat).filter((s) => s.startsWith('⏬')).length
    const held = [...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `dholdlong1x${i}`), 'dholdlong2', 'dholdlong3']
    try {
      // user 1's six long links download at once...
      for (let i = 1; i <= 6; i++) bot.link(1, `dholdlong1x${i}`)
      await bot.until(() => downloading(1) === 6)
      // ...and their seventh waits for one of them
      bot.link(1, 'dholdlong1x7')
      await bot.until(() => bot.statuses(1).some((s) => s.startsWith('⏳')))
      // user 2's long link takes the seventh long slot
      bot.link(2, 'dholdlong2')
      await bot.until(() => downloading(2) === 1)
      // user 3's waits for a long slot, and a short link takes the eighth slot
      bot.link(3, 'dholdlong3')
      bot.link(4, 'short4')
      await bot.until(() => bot.statuses(3).some((s) => s.startsWith('⏳')))
      // user 1's eighth comes after their seventh, still in line, and user 3's
      bot.link(1, 'dholdlong1x8')
      await bot.until(() => bot.statuses(1).filter((s) => s.startsWith('⏳')).length === 2)
      // the ones in line wait 2 s at least, then everything downloads
      await Bun.sleep(2000)
      for (const v of held) bot.release(v, 'dl')
      await bot.until(() => bot.videos().length === 11)
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.statuses(2).map((s) => s[0])).toEqual(['⏬', '⏫'])
    expect(bot.statuses(3).map((s) => s[0])).toEqual(['⏳', '⏬', '⏫'])
    expect(bot.statuses(4).map((s) => s[0])).toEqual(['⏬', '⏫'])
    expect(jobs).toHaveLength(11)
    expect(jobs.filter((l) => /^job ok .*lane=long ahead=0 own=[0-5] dur=3000 wait=0\.0 /.test(l))).toHaveLength(6)
    // user 1's seventh waited behind their own six and their eighth behind
    // those and the seventh, user 3's behind others' while user 1's seventh
    // was in line, and user 2's didn't wait for that
    expect(jobs.filter((l) => /^job ok .*lane=long ahead=0 own=6 dur=3000 wait=([2-9]|\d{2,})\./.test(l))).toHaveLength(1)
    expect(jobs.filter((l) => /^job ok .*lane=long ahead=2 own=7 dur=3000 wait=([2-9]|\d{2,})\./.test(l))).toHaveLength(1)
    expect(jobs.filter((l) => /^job ok .*lane=long ahead=1 own=0 dur=3000 wait=([2-9]|\d{2,})\./.test(l))).toHaveLength(1)
    expect(jobs.filter((l) => /^job ok .*lane=long ahead=1 own=0 dur=3000 wait=0\.0 /.test(l))).toHaveLength(1)
    expect(jobs.filter((l) => /^job ok .*lane=short ahead=0 own=0 dur=30 wait=0\.0 /.test(l))).toHaveLength(1)
  },
  60_000,
)

test.skipIf(skip)(
  'bot: a request for a link still in yt-dlp -J hears that it is queued when the job is',
  async () => {
    const bot = start()
    let jobs: string[] = []
    const queued = (chat: number) => bot.statuses(chat).some((s) => s.startsWith('⏳'))
    try {
      // one user's two long links keep the long lane busy...
      bot.link(1, 'dholdlong1')
      bot.link(1, 'dholdlong2')
      await bot.until(() => queued(1))
      // ...another user's long link is being described...
      bot.link(2, 'jholddholdlong3')
      await bot.until(() => bot.held('jholddholdlong3', 'J'))
      // ...and a third user asks for it meanwhile; then the job waits for a slot
      bot.link(3, 'jholddholdlong3')
      bot.release('jholddholdlong3', 'J')
      await bot.until(() => queued(2) && queued(3))
      // then the downloads go on, in the order the slots come free
      for (const v of ['dholdlong1', 'dholdlong2', 'jholddholdlong3']) bot.release(v, 'dl')
      await bot.until(() => bot.videos().length === 4)
    } finally {
      jobs = await bot.stop()
    }
    // whichever of user 1's second and user 2's gets the slot first (fair
    // turns), the third user's copy is the job's file, sent after it
    const sent = bot.videos().map((v) => [v.chat, v.upload] as const)
    expect(sent.filter(([, upload]) => upload).map(([chat]) => chat).sort()).toEqual([1, 1, 2])
    const at = (chat: number, upload: boolean) => sent.findIndex(([c, u]) => c === chat && u === upload)
    expect(at(3, false)).toBeGreaterThan(at(2, true))
    for (const chat of [2, 3]) expect(bot.statuses(chat).map((s) => s[0])).toEqual(['⏳', '⏬', '⏫'])
    expect(jobs).toHaveLength(3)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: a request for a link that is already downloading hears so, then that it is uploading',
  async () => {
    const bot = start()
    try {
      bot.link(1, 'long1')
      await bot.until(() => bot.statuses(1).length > 0)
      bot.link(3, 'long1')
      await bot.until(() => bot.videos().length === 2)
    } finally {
      await bot.stop()
    }
    expect(bot.videos().map((v) => [v.chat, v.upload])).toEqual([
      [1, true],
      [3, false],
    ])
    expect(bot.statuses(3).map((s) => s[0])).toEqual(['⏬', '⏫'])
  },
  30_000,
)

test.skipIf(skip)(
  'bot: on a deploy, jobs still running near the exit tell their chats to send the link again',
  async () => {
    const bot = start(DEPLOY)
    let jobs: string[] = []
    const acted = (chat: number) => bot.calls.some((c) => c.chat === chat && c.method === 'sendChatAction')
    try {
      // a download...
      bot.link(1, 'dholdlong1')
      await bot.until(() => bot.statuses(1).length > 0)
      // ...and a link in yt-dlp -J (or waiting for it), neither ending
      bot.link(2, 'jholdshort2')
      await bot.until(() => acted(2))
      // the cut tells both, then the exit
      await bot.term()
      await bot.until(() => bot.statuses(1).length === 2 && bot.statuses(2).length === 1)
      bot.kill()
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.statuses(1).map((s) => [...s][0])).toEqual(['⏬', '🔄'])
    expect(bot.statuses(2).map((s) => [...s][0])).toEqual(['🔄'])
    expect(bot.videos()).toHaveLength(0)
    expect(jobs).toHaveLength(0)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: on a deploy, a short link whose yt-dlp -J ends meanwhile still goes out when a slot is free',
  async () => {
    const bot = start({ DRAIN_MS: '600000' })
    let jobs: string[] = []
    try {
      bot.link(1, 'dholdlong1')
      await bot.until(() => bot.statuses(1).length > 0)
      bot.link(2, 'jholdshort2')
      await bot.until(() => bot.calls.some((c) => c.chat === 2 && c.method === 'sendChatAction'))
      // the deploy begins, then the -J and the download end; the drain
      // waits for both
      await bot.term()
      bot.release('jholdshort2', 'J')
      bot.release('dholdlong1', 'dl')
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.videos().map((v) => v.chat).sort()).toEqual([1, 2])
    expect(bot.statuses(2).map((s) => s[0])).toEqual(['⏬', '⏫'])
    expect(jobs.filter((l) => l.startsWith('job ok '))).toHaveLength(2)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: on a deploy, a link still in the queue hears to send it again; the running one finishes',
  async () => {
    const bot = start({ DRAIN_MS: '600000' })
    let jobs: string[] = []
    try {
      bot.link(1, 'dholdlong1')
      bot.link(1, 'long2')
      // long2's ⏳ may come from its wait for a yt-dlp -J turn, before long1 has its slot
      const has = (icon: string) => bot.statuses(1).some((s) => s.startsWith(icon))
      await bot.until(() => has('⏳') && has('⏬'))
      // the deploy tells the queued one, then the running one ends
      await bot.term()
      await bot.until(() => has('🔄'))
      bot.release('dholdlong1', 'dl')
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.statuses(1).filter((s) => s.startsWith('🔄'))).toHaveLength(1)
    expect(bot.videos()).toHaveLength(1)
    expect(jobs.filter((l) => l.startsWith('job fail:restarting '))).toHaveLength(1)
    expect(jobs.filter((l) => l.startsWith('job ok '))).toHaveLength(1)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: on a deploy, links waiting for or in yt-dlp -J hear to send them again, after the queued status of the waiting one',
  async () => {
    const bot = start({ DRAIN_MS: '600000' })
    let jobs: string[] = []
    try {
      // a long download holds the long lane...
      bot.link(1, 'dholdlong1')
      await bot.until(() => bot.statuses(1).length > 0)
      // ...two long links take both -J turns...
      bot.link(2, 'jholdlong2')
      bot.link(3, 'jholdlong3')
      await bot.until(() => bot.held('jholdlong2', 'J') && bot.held('jholdlong3', 'J'))
      // ...and a third link waits for one
      bot.link(4, 'short4')
      await bot.until(() => bot.statuses(4).length > 0)
      // the deploy tells the waiting one; the two in -J hear once it ends
      // (no slot for a long video), and the download finishes
      await bot.term()
      await bot.until(() => bot.statuses(4).length === 2)
      bot.release('jholdlong2', 'J')
      bot.release('jholdlong3', 'J')
      bot.release('dholdlong1', 'dl')
    } finally {
      jobs = await bot.stop()
    }
    for (const chat of [2, 3]) expect(bot.statuses(chat).map((s) => [...s][0])).toEqual(['🔄'])
    expect(bot.statuses(4).map((s) => [...s][0])).toEqual(['⏳', '🔄'])
    expect(bot.videos().map((v) => v.chat)).toEqual([1])
    expect(jobs.filter((l) => l.startsWith('job fail:restarting '))).toHaveLength(3)
    // the one that waited for a -J turn never ran it
    expect(jobs.filter((l) => l.startsWith('job fail:restarting ') && !l.includes(' meta='))).toHaveLength(1)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: a queued link to a video that another link has sent meanwhile gets the cached file',
  async () => {
    const bot = start()
    let jobs: string[] = []
    try {
      bot.link(1, 'long1')
      await bot.until(() => bot.statuses(1).length > 0)
      // the same video under another link (a share link has its own query)
      bot.link(2, 'long1&si=share')
      await bot.until(() => bot.videos().length === 2)
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.videos().map((v) => [v.chat, v.upload])).toEqual([
      [1, true],
      [2, false],
    ])
    expect(bot.statuses(2).map((s) => s[0])).toEqual(['⏳'])
    expect(jobs.filter((l) => /^job cached .*lane=long .*wait=([2-9]|\d{2,})\./.test(l))).toHaveLength(1)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: a link waiting for a yt-dlp -J turn hears it is queued',
  async () => {
    const bot = start()
    let jobs: string[] = []
    const acted = (chat: number) => bot.calls.some((c) => c.chat === chat && c.method === 'sendChatAction')
    try {
      // two users' links take both -J turns for 3 s...
      bot.link(1, 'slowshort1')
      bot.link(3, 'slowshort3')
      await bot.until(() => acted(1) && acted(3))
      await Bun.sleep(200)
      // ...and a third user's link waits for one
      bot.link(2, 'short2')
      // it hears so while both -J runs still hold their turns, before any slot is taken
      await bot.until(() => bot.statuses(2).length > 0)
      expect([bot.statuses(1), bot.statuses(3)]).toEqual([[], []])
      await bot.until(() => bot.videos().length === 3)
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.statuses(2).map((s) => s[0])).toEqual(['⏳', '⏬', '⏫'])
    // neither waited for a -J turn (checked above); one may wait for the one
    // short download slot when their -J runs end a moment apart (a busy runner)
    for (const chat of [1, 3])
      expect(bot.statuses(chat).map((s) => s[0]).filter((s) => s !== '⏳')).toEqual(['⏬', '⏫'])
    expect(jobs.filter((l) => /^job ok .*metaq=([2-9]|\d{2,})\./.test(l))).toHaveLength(1)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: a tweet without a video that waited for a yt-dlp -J turn has its queued status removed, a second request too',
  async () => {
    const bot = start()
    let jobs: string[] = []
    const acted = (chat: number) => bot.calls.some((c) => c.chat === chat && c.method === 'sendChatAction')
    const deleted = (chat: number) => bot.calls.filter((c) => c.chat === chat && c.method === 'deleteMessage')
    try {
      // two users' links take both -J turns for 3 s...
      bot.link(1, 'slowshort1')
      bot.link(3, 'slowshort3')
      await bot.until(() => acted(1) && acted(3))
      await Bun.sleep(200)
      // ...a third user's tweet waits for one, and a fourth user asks for it too
      bot.link(2, 'tweet2')
      await bot.until(() => bot.statuses(2).length > 0)
      bot.link(4, 'tweet2')
      await bot.until(() => bot.statuses(4).length > 0)
      // its -J finds no video: nothing to say, and the queued statuses go
      await bot.until(() => deleted(2).length > 0 && deleted(4).length > 0)
      await bot.until(() => bot.videos().length === 2)
    } finally {
      jobs = await bot.stop()
    }
    for (const chat of [2, 4]) {
      expect(bot.statuses(chat).map((s) => s[0])).toEqual(['⏳'])
      expect(deleted(chat)).toHaveLength(1)
    }
    expect(jobs.filter((l) => l.startsWith('job fail:quiet '))).toHaveLength(1)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: on a deploy, a failure message still on its way isn't turned into the exit notice",
  async () => {
    // the failure reply is still on its way when the deploy cuts
    const reply = gate()
    const bot = start(DEPLOY, (c) => (c.method === 'sendMessage' && c.text?.startsWith('😱') ? reply : 0))
    try {
      bot.link(1, 'fail1')
      await bot.until(() => bot.calls.some((c) => c.chat === 1 && c.method === 'sendMessage'))
      await bot.term()
      reply.open()
    } finally {
      await bot.stop()
    }
    expect(bot.statuses(1).map((s) => [...s][0])).toEqual(['😱'])
  },
  30_000,
)

test.skipIf(skip)(
  "bot: on a deploy, a cached video on its way doesn't keep the exit notice next to it",
  async () => {
    // the cached resend is on its way when the deploy cuts, and arrives
    // while the exit notice is on its way
    const video = gate()
    const notice = gate()
    const bot = start(DEPLOY, (c) =>
      c.chat === 2 && c.method === 'sendVideo' ? video : c.method === 'sendMessage' && c.text?.startsWith('🔄') ? notice : 0,
    )
    try {
      bot.link(1, 'short1')
      await bot.until(() => bot.calls.some((c) => c.chat === 1 && c.method === 'deleteMessage'))
      // the same link from another user: a cached resend, no status
      bot.link(2, 'short1')
      await bot.until(() => bot.calls.some((c) => c.chat === 2 && c.method === 'sendVideo'))
      await bot.term()
      await bot.until(() => bot.statuses(2).length === 1)
      // the video first, as a rule (the other way ends the same)
      video.open()
      await Bun.sleep(50)
      notice.open()
    } finally {
      await bot.stop()
    }
    const n = (m: string) => bot.calls.filter((c) => c.chat === 2 && c.method === m).length
    expect(n('sendVideo')).toBe(1)
    // the notice went out while the video was on its way, and was deleted after it
    expect(bot.statuses(2).map((s) => [...s][0])).toEqual(['🔄'])
    expect(n('deleteMessage')).toBe(1)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: on a deploy, a job whose upload has begun keeps its status; a request following it hears to send the link again',
  async () => {
    // chat 1's upload doesn't end before the exit
    const bot = start(DEPLOY, (c) => (c.method === 'sendVideo' && c.chat === 1 ? gate() : 0))
    try {
      bot.link(1, 'dholdlong1')
      await bot.until(() => bot.statuses(1).length > 0)
      // another user asks for it while it downloads...
      bot.link(3, 'dholdlong1')
      await bot.until(() => bot.statuses(3).length > 0)
      // ...and the upload has begun (the call is logged when it arrives)
      bot.release('dholdlong1', 'dl')
      await bot.until(() => bot.videos().length === 1 && bot.statuses(3).length === 2)
      await bot.term()
      await bot.until(() => bot.statuses(3).length === 3)
      bot.kill()
    } finally {
      await bot.stop()
    }
    expect(bot.statuses(1).map((s) => [...s][0])).toEqual(['⏬', '⏫'])
    // chat 3's own copy would go out only after the job's upload, past the exit
    expect(bot.statuses(3).map((s) => [...s][0])).toEqual(['⏬', '⏫', '🔄'])
  },
  30_000,
)

test.skipIf(skip)(
  'bot: on a deploy, a download that ends after the cut hears to send the link again and is not uploaded',
  async () => {
    const bot = start(DEPLOY)
    let jobs: string[] = []
    try {
      bot.link(1, 'dholdshort1')
      await bot.until(() => bot.statuses(1).length > 0)
      // the cut comes while it downloads, the download ends after it
      await bot.term()
      await bot.until(() => bot.statuses(1).length === 2)
      bot.release('dholdshort1', 'dl')
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.statuses(1).map((s) => [...s][0])).toEqual(['⏬', '🔄'])
    expect(bot.videos()).toHaveLength(0)
    // it downloaded, then stopped short of the upload
    expect(jobs.filter((l) => /^job fail:restarting .* dl=/.test(l))).toHaveLength(1)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: on a deploy, a job at "⏫" whose upload has not begun by the cut hears to send the link again',
  async () => {
    // the job awaits its ⏫ status before the upload; the cut comes meanwhile
    const uploading = gate()
    const bot = start(DEPLOY, (c) => (c.text?.startsWith('⏫') ? uploading : 0))
    let jobs: string[] = []
    try {
      bot.link(1, 'short1')
      await bot.until(() => bot.statuses(1).length > 1)
      await bot.term()
      uploading.open()
    } finally {
      jobs = await bot.stop()
    }
    // the cut tells it, and the job stops before the upload
    expect(bot.statuses(1).map((s) => [...s][0])).toEqual(['⏬', '⏫', '🔄'])
    expect(bot.videos()).toHaveLength(0)
    expect(jobs.filter((l) => /^job fail:restarting .* dl=/.test(l))).toHaveLength(1)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: on a deploy, a job at "⏫" still probing its file at the exit hears to send the link again',
  async () => {
    // an ffprobe that doesn't end before the exit (nor outlive the test)
    const bin = mkdtempSync(join(tmpdir(), 'bot-e2e-bin-'))
    writeFileSync(join(bin, 'ffprobe'), `#!/bin/sh\nwhile [ -d "${bin}" ]; do sleep 0.1; done\n`)
    chmodSync(join(bin, 'ffprobe'), 0o755)
    const bot = start({ ...DEPLOY, PATH: `${bin}:${join(import.meta.dir, 'test')}:${process.env.PATH}` })
    let jobs: string[] = []
    try {
      bot.link(1, 'short1')
      await bot.until(() => bot.statuses(1).length > 1)
      await bot.term()
      await bot.until(() => bot.statuses(1).length === 3)
      bot.kill()
    } finally {
      jobs = await bot.stop()
      rmSync(bin, { recursive: true, force: true })
    }
    // the cut tells it, though the job never gets to its upload
    expect(bot.statuses(1).map((s) => [...s][0])).toEqual(['⏬', '⏫', '🔄'])
    expect(bot.videos()).toHaveLength(0)
    expect(jobs).toHaveLength(0)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: on a deploy, a guest reply whose download ends after the cut hears to send the link again',
  async () => {
    const bot = start({ ...DEPLOY, STORAGE_CHAT: '9' })
    let jobs: string[] = []
    try {
      bot.guest(1, 'dholdshort1')
      await bot.until(() => bot.inline().length > 0)
      // the cut comes while it downloads, the download ends after it
      await bot.term()
      bot.release('dholdshort1', 'dl')
    } finally {
      jobs = await bot.stop()
    }
    // the cut doesn't tell a guest reply, its job's end does, with nothing
    // uploaded to the storage chat
    expect(bot.inline().map((s) => [...s][0])).toEqual(['⏬', '⏫', '🔄'])
    expect(bot.videos()).toHaveLength(0)
    expect(jobs.filter((l) => /^job fail:restarting .* dl=/.test(l))).toHaveLength(1)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: a failed download logs how long it ran and the MB it got',
  async () => {
    const bot = start()
    let jobs: string[] = []
    try {
      // one fails with an error, the other ends without a file or a word
      bot.link(1, 'broken1')
      bot.link(2, 'huge1')
      await bot.until(() => [1, 2].every((chat) => bot.statuses(chat).some((s) => s.startsWith('😱'))))
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.videos()).toHaveLength(0)
    for (const chat of [1, 2]) expect(bot.statuses(chat).map((s) => [...s][0])).toEqual(['⏬', '😱'])
    expect(jobs).toHaveLength(2)
    const line = (result: string) => jobs.find((l) => l.startsWith(`job ${result} `))
    expect(line('error')).toMatch(/^job error host=www\.youtube\.com .*lane=short ahead=0 own=0 dur=30 wait=0\.0 dl=\d+\.\d mb=3 total=/)
    expect(line('fail:tooBig')).toMatch(/^job fail:tooBig host=www\.youtube\.com .*lane=short ahead=0 own=0 dur=30 wait=0\.0 dl=\d+\.\d mb=3 total=/)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: a download stops once one of its files passes 2000 MB, as too large, without reading the page again',
  async () => {
    // half time: a minute is 125 ms, the files are weighed every 10 ms, and a
    // long video's job has 5.6 s. long1 holds the long slot for 1.5 s, by
    // when endlessstream2's saved info is stale, so a failed download of it
    // would read the page again. Its file passes 2000 MB 0.25 s in, and its
    // yt-dlp would go on for 10 s. It leaves a process in its group that
    // ignores the stop's SIGTERM, doesn't hold its output and would live
    // 3.5 s: it gets the SIGKILL as the run ends. parts3 has a merge on disk,
    // each file 2000 MB at most and 4000 MB together, and goes out.
    const dir = mkdtempSync(join(tmpdir(), 'bot-e2e-linger-'))
    const log = () => readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8'))
    const bot = start({ ...HALF, LINGER: dir })
    let jobs: string[] = []
    let lingered: string[] = []
    let gone = false
    try {
      bot.link(1, 'long1')
      await bot.until(() => bot.statuses(1).length > 0)
      bot.link(2, 'endlessstream2')
      bot.link(3, 'parts3')
      await bot.until(() => bot.videos().length === 2 && bot.statuses(2).some((s) => s.startsWith('😱')))
      // the lingering process (its log is named <link>.<its pid>) is gone
      // within a second of the run's end, short of its "done"
      const pid = Number(readdirSync(dir)[0]!.split('.').pop())
      for (let i = 0; i < 20 && alive(pid); i++) await Bun.sleep(50)
      gone = !alive(pid)
      lingered = log()
    } finally {
      jobs = await bot.stop()
      rmSync(dir, { recursive: true, force: true })
    }
    expect(gone).toBe(true)
    expect(lingered).toEqual(['up\n'])
    expect(bot.videos().map((v) => v.chat).sort()).toEqual([1, 3])
    expect(bot.statuses(2).map((s) => [...s][0])).toEqual(['⏳', '⏬', '😱'])
    expect(bot.statuses(2).at(-1)).toBe(t('en', 'tooBig'))
    expect(jobs).toHaveLength(3)
    expect(jobs.filter((l) => l.startsWith('job ok '))).toHaveLength(2)
    const line = jobs.find((l) => l.startsWith('job fail:tooBig '))!
    expect(line).toMatch(/^job fail:tooBig host=www\.youtube\.com .*lane=long ahead=0 own=0 dur=\? wait=\d+\.\d dl=\d+\.\d mb=2001 total=/)
    expect(line).not.toContain('reread=')
    const dl = Number(/ dl=([\d.]+)/.exec(line)![1])
    expect(dl).toBeGreaterThanOrEqual(0.25)
    expect(dl).toBeLessThan(1.5)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: the time limit also stops a child of yt-dlp that holds its output, as ffmpeg does, and frees the slot',
  async () => {
    // half time: a short video's job has 3.75 s, and the child would keep
    // yt-dlp's stdout and stderr open for 10 s; the second one's child
    // ignores SIGTERM: its job ends 2.5 s later all the same, and the child
    // must take the SIGKILL then, rather than go on to its 10 s. The two hold
    // both slots, so a third link waits for the first one's
    const dir = mkdtempSync(join(tmpdir(), 'bot-e2e-stubborn-'))
    const bot = start({ ...HALF, LINGER: dir })
    let jobs: string[] = []
    let stubborn = 0
    let survived = true
    try {
      bot.link(1, 'ffmpeg1')
      bot.link(2, 'stubbornffmpeg1')
      await bot.until(() => [1, 2].every((chat) => bot.statuses(chat).some((s) => s.startsWith('⏬'))))
      bot.link(3, 'next1')
      await bot.until(
        () => bot.videos().length === 1 && [1, 2].every((chat) => bot.statuses(chat).some((s) => s.startsWith('😱'))),
        25_000,
      )
      stubborn = Number(readFileSync(join(dir, 'stubbornffmpeg1.pid'), 'utf8'))
      // gone within a second of its job's end
      for (let i = 0; i < 20 && alive(stubborn); i++) await Bun.sleep(50)
      survived = alive(stubborn)
    } finally {
      jobs = await bot.stop()
      rmSync(dir, { recursive: true, force: true })
    }
    expect(stubborn).toBeGreaterThan(0)
    expect(survived).toBe(false)
    expect(bot.videos().map((v) => v.chat)).toEqual([3])
    for (const chat of [1, 2]) expect(bot.statuses(chat).map((s) => [...s][0])).toEqual(['⏬', '😱'])
    expect(jobs).toHaveLength(3)
    const timeouts = jobs.filter((l) => l.startsWith('job timeout '))
    expect(timeouts).toHaveLength(2)
    for (const line of timeouts)
      expect(line).toMatch(/^job timeout host=www\.youtube\.com .*lane=short .* dl=\d+\.\d mb=2 total=/)
    const [term, kill] = timeouts.map((l) => Number(/ dl=([\d.]+)/.exec(l)![1])).sort((a, b) => a - b)
    // the first at its time limit, not after the grace too; the second after
    // the grace, not the child's 10 s
    expect(term).toBeGreaterThanOrEqual(3.75)
    expect(term).toBeLessThan(5.5)
    expect(kill).toBeGreaterThanOrEqual(6.25)
    expect(kill).toBeLessThan(9)
    // the third got the first one's slot when that one hit its time limit,
    // 3.75 s after it began downloading, less the moment the third link came in
    const next = jobs.find((l) => l.startsWith('job ok '))!
    expect(next).toMatch(/^job ok host=www\.youtube\.com .*lane=short ahead=0 /)
    const wait = Number(/ wait=([\d.]+)/.exec(next)![1])
    expect(wait).toBeGreaterThan(1)
    expect(wait).toBeLessThan(5.5)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: a timed-out run leaves nothing in its group, and a pipe holder that left the group doesn't keep the job",
  async () => {
    // half time: a short video's job has 3.75 s. ffmpegdeaflinger1's child
    // dies at the SIGTERM and closes yt-dlp's output, but the process it left
    // in yt-dlp's group ignores SIGTERM and would live 5 s. escapeffmpeg1's
    // child holds yt-dlp's output for 10 s from a session of its own, which
    // the signals don't reach: its job ends 2.5 s after the SIGTERM all the same
    const dir = mkdtempSync(join(tmpdir(), 'bot-e2e-deaf-'))
    const bot = start({ ...HALF, LINGER: dir })
    let jobs: string[] = []
    let log: string[] = []
    try {
      bot.link(1, 'ffmpegdeaflinger1')
      bot.link(2, 'escapeffmpeg1')
      // the second ends at 6.25 s, past the 5 s the lingering process would
      // live if nothing stopped it
      await bot.until(() => [1, 2].every((chat) => bot.statuses(chat).some((s) => s.startsWith('😱'))), 25_000)
      log = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8'))
    } finally {
      jobs = await bot.stop()
      rmSync(dir, { recursive: true, force: true })
    }
    // the lingering process got the SIGKILL as its run ended
    expect(log).toEqual(['up\n'])
    expect(jobs).toHaveLength(2)
    for (const line of jobs)
      expect(line).toMatch(/^job timeout host=www\.youtube\.com .*lane=short .* dl=\d+\.\d mb=2 total=/)
    const [deaf, escape] = jobs.map((l) => Number(/ dl=([\d.]+)/.exec(l)![1])).sort((a, b) => a - b)
    // at the time limit, not after the grace too; after the grace, not the
    // child's 10 s
    expect(deaf).toBeGreaterThanOrEqual(3.75)
    expect(deaf).toBeLessThan(5.5)
    expect(escape).toBeGreaterThanOrEqual(6.25)
    expect(escape).toBeLessThan(9)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: a download stopped as too large is over the grace time after the stop, even if a pipe holder left yt-dlp's group",
  async () => {
    // half time: a short video's job has 3.75 s. escapeendless1's file passes
    // 2000 MB 0.25 s in, and its child holds yt-dlp's output for 10 s from a
    // session of its own: the job ends 2.5 s after that stop, before its time
    // limit
    const bot = start(HALF)
    let jobs: string[] = []
    try {
      bot.link(1, 'escapeendless1')
      await bot.until(() => bot.statuses(1).some((s) => s.startsWith('😱')), 25_000)
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.statuses(1).map((s) => [...s][0])).toEqual(['⏬', '😱'])
    expect(bot.statuses(1).at(-1)).toBe(t('en', 'tooBig'))
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatch(/^job fail:tooBig host=www\.youtube\.com .*lane=short .* dl=\d+\.\d mb=2001 total=/)
    const dl = Number(/ dl=([\d.]+)/.exec(jobs[0]!)![1])
    // not the 10 s the pipe holder would keep it
    expect(dl).toBeGreaterThanOrEqual(2.75)
    expect(dl).toBeLessThan(5)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: the time limit's signals end with yt-dlp's run",
  async () => {
    // half time: a short video's job has 3.75 s, and a stopped run gets
    // 2.5 s. linger1's yt-dlp is done in 0.1 s, and lingerbroken1's fails
    // then, but each leaves a process in its group that doesn't hold its
    // output and lives 7.5 s: once a run is over, whichever way it ended,
    // neither the time limit's SIGTERM nor a SIGKILL may reach its group (by
    // then the number could lead another one)
    const dir = mkdtempSync(join(tmpdir(), 'bot-e2e-linger-'))
    // each lingering process's log, by its link (a page read again is
    // another run, with a process of its own)
    const logs = () => readdirSync(dir).map((f) => [f.split('.')[0]!, readFileSync(join(dir, f), 'utf8')] as const)
    const bot = start({ ...HALF, LINGER: dir })
    let jobs: string[] = []
    let seen: ReturnType<typeof logs> = []
    try {
      bot.link(1, 'linger1')
      bot.link(2, 'lingerbroken1')
      await bot.until(() => bot.videos().length === 1 && bot.statuses(2).some((s) => s.startsWith('😱')))
      // past both signals' times
      for (let i = 0; i < 400 && !(logs().length >= 2 && logs().every(([, l]) => /TERM|done/.test(l))); i++)
        await Bun.sleep(50)
      seen = logs()
    } finally {
      jobs = await bot.stop()
      rmSync(dir, { recursive: true, force: true })
    }
    expect(jobs).toHaveLength(2)
    expect(jobs.filter((l) => /^job ok host=www\.youtube\.com .*lane=short /.test(l))).toHaveLength(1)
    expect(jobs.filter((l) => /^job error host=www\.youtube\.com .*lane=short .* mb=3 /.test(l))).toHaveLength(1)
    expect(new Set(seen.map(([v]) => v))).toEqual(new Set(['linger1', 'lingerbroken1']))
    for (const [, log] of seen) expect(log).toBe('up\ndone\n')
  },
  30_000,
)

test.skipIf(skip)(
  "bot: a long video's download goes on past the time a short one gets",
  async () => {
    // half time: 3.75 s for a short video, 5.6 s for a long one, and both of
    // these take 4.5 s
    const bot = start(HALF)
    let jobs: string[] = []
    try {
      bot.link(1, 'crawl1')
      bot.link(2, 'crawllong1')
      await bot.until(() => bot.videos().length === 1 && bot.statuses(1).some((s) => s.startsWith('😱')), 25_000)
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.videos().map((v) => v.chat)).toEqual([2])
    expect(bot.statuses(1).map((s) => [...s][0])).toEqual(['⏬', '😱'])
    expect(jobs).toHaveLength(2)
    const dl = (line: string) => Number(/ dl=([\d.]+)/.exec(line)![1])
    // the short one is stopped at its 3.75 s, with the 2 MB it had...
    const short = jobs.find((l) => l.includes(' lane=short '))!
    expect(short).toMatch(/^job timeout host=www\.youtube\.com .* dl=\d+\.\d mb=2 total=/)
    expect(dl(short)).toBeGreaterThanOrEqual(3.75)
    expect(dl(short)).toBeLessThan(5.5)
    // ...while the long one downloads for longer and goes out
    const long = jobs.find((l) => l.includes(' lane=long '))!
    expect(long).toMatch(/^job ok host=www\.youtube\.com /)
    expect(dl(long)).toBeGreaterThan(3.75)
  },
  40_000,
)

test.skipIf(skip)(
  'bot: a page read again gets only the time the job has left',
  async () => {
    // half time: a long video's job has 5.625 s, and "Downloading…" takes
    // 250 ms to show, by when slowexpiredlong1's saved info is stale. Its
    // download from that info fails after 2 s, then the page is read again
    // (1.5 s, "slow") and downloaded from (4.5 s): in the 2.125 s left that
    // times out, where the 3.625 s left before the read would still end later
    const bot = start(HALF, (c) => (c.text?.startsWith('⏬') ? 250 : 0))
    let jobs: string[] = []
    try {
      bot.link(1, 'slowexpiredlong1')
      await bot.until(() => bot.statuses(1).some((s) => s.startsWith('😱')), 30_000)
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.videos()).toHaveLength(0)
    expect(jobs).toHaveLength(1)
    const line = jobs[0]!
    // the same pick, though the try from saved info got nothing
    expect(line).toMatch(/^job timeout host=www\.youtube\.com .*lane=long .* reread=1 kept=0 dl=\d+\.\d mb=2 total=/)
    // the job's 5.625 s in all, not 2 s and then another 5.625, nor 2 s, the
    // read again and 3.625 s
    const dl = Number(/ dl=([\d.]+)/.exec(line)![1])
    expect(dl).toBeGreaterThanOrEqual(5.6)
    expect(dl).toBeLessThan(7.5)
  },
  45_000,
)

test.skipIf(skip)(
  'bot: a page read again goes on from the failed download only in the format that got it',
  async () => {
    // A minute is 250 ms and "Downloading…" takes 500 ms to show, so the -J
    // info is stale by the download. These links' downloads from it fail 3
    // MB into a 5 MB file (2 MB for the swap ones), and their pages are read
    // again. cut1's picks the same format, its link signed anew in the
    // query, and goes on from those 3 MB; cutswap1's picks another, whose
    // bytes yt-dlp would append to them. cutembed1 and cutswapembed1 are
    // generic pages with a <video>, where only the link tells two clips
    // apart: cutembed1's has the same clip and goes on, cutswapembed1's picks
    // another one by the query. cutflipmulti1 and cutswapmulti1 are posts
    // with several videos, whose -J is a playlist of the first one, and a
    // download from that would read the page again itself: cutflipmulti1's
    // first video is the same when it's read again, and another from the 4th
    // read on, so a download that read it would append that one to the 3 MB;
    // cutswapmulti1's picks another
    const pages = mkdtempSync(join(tmpdir(), 'bot-e2e-pages-'))
    const bot = start({ MINUTE_MS: '250', PAGES: pages }, (c) => (c.text?.startsWith('⏬') ? 500 : 0))
    let jobs: string[] = []
    const links = ['cut1', 'cutswap1', 'cutembed1', 'cutswapembed1', 'cutflipmulti1', 'cutswapmulti1']
    const read: Record<string, string> = {}
    try {
      links.forEach((v, i) => bot.link(i + 1, v))
      await bot.until(() => bot.videos().length === links.length)
      for (const v of links) read[v] = readFileSync(join(pages, v), 'utf8')
    } finally {
      jobs = await bot.stop()
      rmSync(pages, { recursive: true, force: true })
    }
    // what a file is made of: [letter, bytes] for each run of one letter
    const runs = (file: Uint8Array) => {
      const all: [string, number][] = []
      for (const b of file) {
        const last = all.at(-1)
        if (last?.[0] === String.fromCharCode(b)) last[1]++
        else all.push([String.fromCharCode(b), 1])
      }
      return all
    }
    const sent = (chat: number) => runs(bot.videos().find((c) => c.chat === chat)!.file!)
    expect(links.map((_, i) => sent(i + 1))).toEqual(['a', 'b', 'a', 'b', 'a', 'b'].map((x) => [[x, 5 * 2 ** 20]]))
    // the pages read by the -Js alone: the downloads were from what they
    // picked, a post's first video too
    expect(read).toEqual({
      cut1: 'read\nread\nresumed 3145728\n',
      cutswap1: 'read\nread\n',
      cutembed1: 'read\nread\nresumed 3145728\n',
      cutswapembed1: 'read\nread\n',
      cutflipmulti1: 'read\nread\nresumed 3145728\n',
      cutswapmulti1: 'read\nread\n',
    })
    // kept for the links that went on from 3 MB, dropped for the swap ones' 2
    expect(jobs).toHaveLength(6)
    expect(jobs.filter((l) => /^job ok host=www\.youtube\.com .*lane=short .* reread=1 kept=3 dl=\d+\.\d mb=5 /.test(l))).toHaveLength(3)
    expect(jobs.filter((l) => /^job ok host=www\.youtube\.com .*lane=short .* reread=1 dropped=2 dl=\d+\.\d mb=5 /.test(l))).toHaveLength(3)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: a page read again that doesn't answer in the time the job has left stops with it",
  async () => {
    // a minute is 250 ms, so a short video's job has 7.5 s, and
    // "Downloading…" takes 500 ms to show, by when stuckexpired1's saved info
    // is stale. Its download from that info fails after 4 s, then the page is
    // read again, which takes 30 s: that's stopped in the 3.5 s left, rather
    // than hold the slot for as long as yt-dlp takes
    const pages = mkdtempSync(join(tmpdir(), 'bot-e2e-pages-'))
    const bot = start({ MINUTE_MS: '250', PAGES: pages }, (c) => (c.text?.startsWith('⏬') ? 500 : 0))
    let jobs: string[] = []
    try {
      bot.link(1, 'stuckexpired1')
      await bot.until(() => bot.statuses(1).some((s) => s.startsWith('😱')), 20_000)
    } finally {
      jobs = await bot.stop()
      rmSync(pages, { recursive: true, force: true })
    }
    expect(bot.videos()).toHaveLength(0)
    expect(jobs).toHaveLength(1)
    const line = jobs[0]!
    // stopped while reading the page: nothing picked, kept or dropped
    expect(line).toMatch(/^job timeout host=www\.youtube\.com .*lane=short .* reread=1 dl=\d+\.\d mb=0 total=/)
    // the job's 7.5 s in all
    const dl = Number(/ dl=([\d.]+)/.exec(line)![1])
    expect(dl).toBeGreaterThanOrEqual(7.5)
    expect(dl).toBeLessThan(9.25)
  },
  45_000,
)

// The sent videos and audio files
const files = (calls: Call[]) => calls.filter((c) => /^send(Video|Audio)$/.test(c.method))

test.skipIf(skip)(
  "bot: a page read again that picks another video sends that one as itself, cached under its own id, not the first one's",
  async () => {
    // A minute is 250 ms and "Downloading…" takes 500 ms to show, so the -J
    // info is stale by the download. old1's download from it fails 3 MB in,
    // and its page, read again, now shows another video, new1: 40 s of audio
    const pages = mkdtempSync(join(tmpdir(), 'bot-e2e-pages-'))
    const bot = start({ MINUTE_MS: '250', PAGES: pages }, (c) => (c.text?.startsWith('⏬') ? 500 : 0))
    let jobs: string[] = []
    try {
      bot.link(1, 'old1&cut&next=new1')
      // its status goes once the job is over
      await bot.until(() => bot.calls.some((c) => c.chat === 1 && c.method === 'deleteMessage'))
      // new1 by its own link, old1 by another one, and once new1 is cached,
      // old4, whose page read again shows new1 too
      bot.link(2, 'new1')
      bot.link(3, 'old1')
      await bot.until(() => files(bot.calls).some((c) => c.chat === 2))
      bot.link(4, 'old4&cut&next=new1')
      await bot.until(
        () => files(bot.calls).length === 4 && [3, 4].every((chat) => bot.calls.some((c) => c.chat === chat && c.method === 'deleteMessage')),
      )
      // then old4 by another link
      bot.link(5, 'old4')
      await bot.until(() => files(bot.calls).length === 5)
    } finally {
      jobs = await bot.stop()
      rmSync(pages, { recursive: true, force: true })
    }
    // new1's copy went to its own link and to old4's from the cache; old1 and
    // old4 have none cached, so they were downloaded
    expect(files(bot.calls).map((c) => [c.chat, c.method, c.upload]).sort()).toEqual([
      [1, 'sendAudio', true],
      [2, 'sendAudio', false],
      [3, 'sendVideo', true],
      [4, 'sendAudio', false],
      [5, 'sendVideo', true],
    ])
    const sent = files(bot.calls).find((c) => c.chat === 1)!
    expect([sent.title, sent.performer, sent.duration]).toEqual(['Next', 'Someone', 40])
    expect(sent.caption).toStartWith('<a href="https://www.youtube.com/watch?v=new1">Next</a>')
    // new1's download, not old1's format (5 MB of "a")
    expect(bot.mp4.equals(sent.file!)).toBe(true)
    expect(jobs).toHaveLength(5)
    expect(jobs.filter((l) => /^job ok host=www\.youtube\.com .*lane=short .* reread=1 dropped=3 other=1 dl=\d+\.\d mb=0 up=/.test(l))).toHaveLength(1)
    expect(jobs.filter((l) => /^job cached host=www\.youtube\.com .*lane=short .* reread=1 dropped=3 other=1 dl=\d+\.\d total=/.test(l))).toHaveLength(1)
    // new1's own link, before any slot
    expect(jobs.filter((l) => /^job cached host=www\.youtube\.com metaq=\S+ meta=\S+ total=/.test(l))).toHaveLength(1)
    expect(jobs.filter((l) => /^job ok host=www\.youtube\.com .*lane=short .* dur=30 wait=\S+ dl=/.test(l))).toHaveLength(2)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: a post with several videos whose first one has changed when read again sends the new one, downloaded from its own info, not the post's",
  async () => {
    // As above, with old1 a post with several videos, whose -J is a playlist
    // of its first one: read again, that's new1. The download is from new1's
    // own info, not the post's, from which yt-dlp would read the post again
    // itself and download whatever it picks then
    const pages = mkdtempSync(join(tmpdir(), 'bot-e2e-pages-'))
    const bot = start({ MINUTE_MS: '250', PAGES: pages }, (c) => (c.text?.startsWith('⏬') ? 500 : 0))
    let jobs: string[] = []
    let read = ''
    try {
      bot.link(1, 'old1&cut&multi&next=new1')
      await bot.until(() => bot.calls.some((c) => c.chat === 1 && c.method === 'deleteMessage'))
      read = readFileSync(join(pages, 'old1'), 'utf8')
      // new1 by its own link, and the post's old1 by another one
      bot.link(2, 'new1')
      bot.link(3, 'old1&multi')
      await bot.until(() => files(bot.calls).length === 3)
    } finally {
      jobs = await bot.stop()
      rmSync(pages, { recursive: true, force: true })
    }
    // the post read by the two -Js alone: the download didn't read it again
    expect(read).toBe('read\nread\n')
    // new1's copy went to its own link from the cache; old1 has none cached,
    // so it was downloaded
    expect(files(bot.calls).map((c) => [c.chat, c.method, c.upload]).sort()).toEqual([
      [1, 'sendAudio', true],
      [2, 'sendAudio', false],
      [3, 'sendVideo', true],
    ])
    const sent = files(bot.calls).find((c) => c.chat === 1)!
    expect([sent.title, sent.performer, sent.duration]).toEqual(['Next', 'Someone', 40])
    // new1's download, not old1's format (5 MB of "a")
    expect(bot.mp4.equals(sent.file!)).toBe(true)
    expect(jobs).toHaveLength(3)
    expect(jobs.filter((l) => /^job ok host=www\.youtube\.com .*lane=short .* reread=1 dropped=3 other=1 dl=\d+\.\d mb=0 up=/.test(l))).toHaveLength(1)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: a page read again that picks a live stream, or a video too big to send, says so',
  async () => {
    // A minute is 250 ms and "Downloading…" takes 500 ms to show, so the -J
    // info is stale by the download. old1's and old2's downloads from it fail
    // 3 MB in, and their pages, read again, now show another video: live1,
    // live now, and big2, 3000 MB
    const pages = mkdtempSync(join(tmpdir(), 'bot-e2e-pages-'))
    const bot = start({ MINUTE_MS: '250', PAGES: pages }, (c) => (c.text?.startsWith('⏬') ? 500 : 0))
    let jobs: string[] = []
    try {
      bot.link(1, 'old1&cut&next=live1')
      bot.link(2, 'old2&cut&next=big2')
      await bot.until(() => [1, 2].every((chat) => bot.statuses(chat).length === 2))
    } finally {
      jobs = await bot.stop()
      rmSync(pages, { recursive: true, force: true })
    }
    expect(files(bot.calls)).toHaveLength(0)
    expect(bot.statuses(1)).toEqual([t('en', 'downloading'), t('en', 'live')])
    expect(bot.statuses(2)).toEqual([t('en', 'downloading'), t('en', 'tooBig')])
    expect(jobs).toHaveLength(2)
    for (const why of ['live', 'tooBig'])
      expect(jobs.filter((l) => new RegExp(`^job fail:${why} host=www\\.youtube\\.com .* reread=1 dropped=3 other=1 dl=\\d+\\.\\d mb=0 total=`).test(l))).toHaveLength(1)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: a refresh of an unsized video goes on only while the page picks that video, at the first read or when read again',
  async () => {
    // old1, old2 and old3 have copies cached under their links and ids
    // before videos went out with their size (#281), which the fake Bot API
    // resends without one, so each is downloaded again to replace its copy.
    // old2's page shows new2 at the first read already. old1's refresh waits
    // for a slot behind the same user's long1 (3 s), so its -J info is stale
    // by the download, which fails 3 MB in, and the page read again picks
    // new1. old3's page still shows old3.
    const pages = mkdtempSync(join(tmpdir(), 'bot-e2e-pages-'))
    const data = mkdtempSync(join(tmpdir(), 'bot-e2e-data-'))
    const link = (v: string) => `https://www.youtube.com/watch?v=${v}`
    const db = new Database(join(data, 'bot.sqlite'))
    db.run('CREATE TABLE files (key TEXT PRIMARY KEY, kind TEXT NOT NULL, file_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL)')
    for (const [n, v] of [[1, 'old1&cut&next=new1'], [2, 'old2&next=new2'], [3, 'old3']] as const)
      for (const key of [link(v), `Youtube:old${n}`])
        db.run("INSERT INTO files VALUES (?, 'video', ?, 'Video', ?)", [key, `unsized${n}`, link(v)])
    db.close()
    writeFileSync(join(pages, 'old2'), 'read\n')
    const bot = start({ MINUTE_MS: '250', PAGES: pages, DATA_DIR: data })
    let jobs: string[] = []
    let cached: Record<string, string> = {}
    try {
      bot.link(2, 'old2&next=new2')
      bot.link(3, 'old3')
      bot.link(1, 'long1')
      await bot.until(() => bot.statuses(1).some((s) => s.startsWith('⏬')))
      bot.link(1, 'old1&cut&next=new1')
      // once old1's refresh has read the page, short1 waits for the user's
      // slot after it: by short1's upload that refresh is over
      await bot.until(() => existsSync(join(pages, 'old1')))
      bot.link(1, 'short1')
      await bot.until(() => files(bot.calls).length === 6 && bot.calls.some((c) => c.chat === 3 && c.method === 'deleteMessage'))
    } finally {
      jobs = await bot.stop()
      const db = new Database(join(data, 'bot.sqlite'))
      const rows = db.query<{ key: string; file_id: string }, []>('SELECT key, file_id FROM files').all()
      cached = Object.fromEntries(rows.map((r) => [r.key, r.file_id]))
      db.close()
      rmSync(pages, { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    }
    const sent = (chat: number) => files(bot.calls).filter((c) => c.chat === chat).map((c) => [c.method, c.upload])
    // old1 (with long1 and short1) and old2 get their old copies and nothing
    // in their place; old3's is replaced: a new upload, the old message gone
    expect(sent(1).sort()).toEqual([
      ['sendVideo', false],
      ['sendVideo', true],
      ['sendVideo', true],
    ])
    expect(sent(2)).toEqual([['sendVideo', false]])
    expect(sent(3)).toEqual([
      ['sendVideo', false],
      ['sendVideo', true],
    ])
    expect(bot.calls.filter((c) => c.method === 'deleteMessage' && c.chat !== 1).map((c) => c.chat)).toEqual([3])
    for (const n of [1, 2]) {
      expect(cached[`Youtube:old${n}`]).toBe(`unsized${n}`)
      expect(cached[`Youtube:new${n}`]).toBeUndefined()
    }
    expect([cached[link('old1&cut&next=new1')], cached[link('old2&next=new2')]]).toEqual(['unsized1', 'unsized2'])
    expect(cached['Youtube:old3']).toMatch(/^v\d+$/)
    expect(cached[link('old3')]).toBe(cached['Youtube:old3'])
    expect(jobs).toHaveLength(5)
    expect(jobs.filter((l) => /^job fail:quiet host=www\.youtube\.com .*lane=short .* reread=1 dropped=3 other=1 dl=\d+\.\d mb=0 total=/.test(l))).toHaveLength(1)
    expect(jobs.filter((l) => /^job fail:quiet host=www\.youtube\.com metaq=\S+ meta=\S+ total=/.test(l))).toHaveLength(1)
    expect(jobs.filter((l) => /^job ok host=www\.youtube\.com .*lane=short .* dur=30 wait=\S+ dl=/.test(l))).toHaveLength(2)
  },
  30_000,
)
