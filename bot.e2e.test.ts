import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The real bot, polling a fake Bot API, with test/yt-dlp standing in for
// yt-dlp: a link with "long" in it is a 50-minute video that downloads in
// 3 s, one with "reel" (an Instagram reel) or "stream" in it says nothing of
// its length, any other is a 30-second one; those download in 0.2 s ("crawl"
// ones take 9 s, "broken" and "huge" ones fail; test/yt-dlp has the rest).
// MAX_DOWNLOADS=2: one slot for long videos, the other for short ones. env
// adds to or overrides the bot's environment, delay = how long the fake Bot
// API takes to answer a call, in ms.
type Call = { method: string; chat: number; text?: string; upload?: boolean; inline?: string }
function start(env: Record<string, string> = {}, delay: (call: Call) => number = () => 0) {
  const work = mkdtempSync(join(tmpdir(), 'bot-e2e-'))
  const mp4 = join(work, 'v.mp4')
  Bun.spawnSync(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=1', '-pix_fmt', 'yuv420p', mp4])
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
      // inline = the guest reply an edit is to
      const call = {
        method,
        chat: chat.id,
        text: body.text,
        upload: type.includes('multipart'),
        inline: body.inline_message_id,
      }
      calls.push(call)
      const ms = delay(call)
      if (ms) await Bun.sleep(ms)
      if (method === 'answerGuestQuery') return ok({ inline_message_id: `g${++id}` })
      if (method === 'sendMessage') return ok({ message_id: ++id, date: 0, chat, text: body.text })
      if (method === 'sendVideo')
        return ok({
          message_id: ++id,
          date: 0,
          chat,
          video: { file_id: `v${id}`, file_unique_id: `u${id}`, width: 320, height: 240, duration: 1 },
        })
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
      ...env,
    },
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const out = new Response(bot.stdout).text()
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
    // SIGTERM, as on a deploy; resolves to the bot's job log lines
    async stop() {
      bot.kill('SIGTERM')
      await bot.exited
      // the answers to calls still on their way
      await Bun.sleep(100)
      api.stop(true)
      rmSync(work, { recursive: true, force: true })
      return (await out).split('\n').filter((l) => l.startsWith('job '))
    },
  }
}

const skip = !Bun.which('ffmpeg') && !process.env.CI

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
    expect(jobs.filter((l) => /^job ok .*lane=short ahead=0 dur=30 wait=0\.0 /.test(l))).toHaveLength(1)
    // the second long one waited for the first
    expect(jobs.some((l) => /lane=long ahead=0 dur=3000 wait=([2-9]|\d{2,})\./.test(l))).toBe(true)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: an Instagram reel, which doesn't say how long it is, goes out while three long videos download; a stream that doesn't waits",
  async () => {
    // the default four slots, three for long videos
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
    expect(jobs.filter((l) => /^job ok .*lane=long ahead=0 dur=3000 wait=0\.0 /.test(l))).toHaveLength(3)
    expect(jobs.filter((l) => /^job ok .*lane=short ahead=0 dur=\? wait=0\.0 /.test(l))).toHaveLength(1)
    expect(jobs.filter((l) => /^job ok .*lane=long ahead=0 dur=\? wait=([2-9]|\d{2,})\./.test(l))).toHaveLength(1)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: a request for a link still in yt-dlp -J hears that it is queued when the job is',
  async () => {
    const bot = start()
    let jobs: string[] = []
    const acted = (chat: number) => bot.calls.some((c) => c.chat === chat && c.method === 'sendChatAction')
    try {
      // one user's two long links keep the long lane busy for 6 s...
      bot.link(1, 'long1')
      bot.link(1, 'long2')
      await bot.until(() => bot.statuses(1).some((s) => s.startsWith('⏳')))
      // ...another user's long link takes 3 s to describe, then waits...
      bot.link(2, 'slowlong3')
      await bot.until(() => acted(2))
      await Bun.sleep(300)
      // ...and a third user asks for it while it's being described
      bot.link(3, 'slowlong3')
      await bot.until(() => bot.videos().length === 4)
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.videos().map((v) => [v.chat, v.upload])).toEqual([
      [1, true],
      [1, true],
      [2, true],
      [3, false],
    ])
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
    // the exit comes 1 s after the drain starts, the notice at once
    const bot = start({ DRAIN_MS: '1000' })
    let jobs: string[] = []
    const acted = (chat: number) => bot.calls.some((c) => c.chat === chat && c.method === 'sendChatAction')
    try {
      // a 3 s download...
      bot.link(1, 'long1')
      await bot.until(() => bot.statuses(1).length > 0)
      // ...and a link still in its 3 s yt-dlp -J
      bot.link(2, 'slowshort2')
      await bot.until(() => acted(2))
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
    const bot = start()
    let jobs: string[] = []
    try {
      bot.link(1, 'long1')
      await bot.until(() => bot.statuses(1).length > 0)
      bot.link(2, 'slowshort2')
      await bot.until(() => bot.calls.some((c) => c.chat === 2 && c.method === 'sendChatAction'))
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
    const bot = start()
    let jobs: string[] = []
    try {
      bot.link(1, 'long1')
      bot.link(1, 'long2')
      await bot.until(() => bot.statuses(1).some((s) => s.startsWith('⏳')))
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
    const bot = start()
    let jobs: string[] = []
    const acted = (chat: number) => bot.calls.some((c) => c.chat === chat && c.method === 'sendChatAction')
    try {
      // a long download holds the long lane...
      bot.link(1, 'long1')
      await bot.until(() => bot.statuses(1).length > 0)
      // ...two long links take both -J turns for 3 s...
      bot.link(2, 'slowlong2')
      bot.link(3, 'slowlong3')
      await bot.until(() => acted(2) && acted(3))
      await Bun.sleep(200)
      // ...and a third link waits for a -J turn
      bot.link(4, 'short4')
      await bot.until(() => acted(4))
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
    for (const chat of [1, 3]) expect(bot.statuses(chat).map((s) => s[0])).toEqual(['⏬', '⏫'])
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
    // the failure reply takes 700 ms; the exit notice would come at once
    const bot = start({ DRAIN_MS: '1500' }, (c) => (c.method === 'sendMessage' && c.text?.startsWith('😱') ? 700 : 0))
    try {
      bot.link(1, 'fail1')
      await bot.until(() => bot.calls.some((c) => c.chat === 1 && c.method === 'sendMessage'))
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
    // the cached resend takes 500 ms, the exit notice 900 ms
    const bot = start({ DRAIN_MS: '1500' }, (c) =>
      c.chat === 2 && c.method === 'sendVideo' ? 500 : c.method === 'sendMessage' && c.text?.startsWith('🔄') ? 900 : 0,
    )
    try {
      bot.link(1, 'short1')
      await bot.until(() => bot.calls.some((c) => c.chat === 1 && c.method === 'deleteMessage'))
      // the same link from another user: a cached resend, no status
      bot.link(2, 'short1')
      await bot.until(() => bot.calls.some((c) => c.chat === 2 && c.method === 'sendVideo'))
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
    // chat 1's upload takes 1.5 s, past the exit
    const bot = start({ DRAIN_MS: '1000' }, (c) => (c.method === 'sendVideo' && c.chat === 1 ? 1500 : 0))
    try {
      bot.link(1, 'long1')
      await bot.until(() => bot.statuses(1).length > 0)
      // another user asks for it while it downloads...
      bot.link(3, 'long1')
      await bot.until(() => bot.statuses(3).length > 0)
      // ...and the upload has begun (the call is logged when it arrives)
      await bot.until(() => bot.videos().length === 1 && bot.statuses(3).length === 2)
    } finally {
      await bot.stop()
    }
    expect(bot.statuses(1).map((s) => [...s][0])).toEqual(['⏬', '⏫'])
    // chat 3's own copy would go out only after the job's upload, past the exit
    expect(bot.statuses(3).map((s) => [...s][0])).toEqual(['⏬', '⏫', '🔄'])
  },
  30_000,
)

// The drain below takes 3 s: the cut comes 1 s in, the exit 3 s in. The
// status the job awaits takes 1.8 s to answer, so the job gets through its
// download and up to its upload between the two.
const slow = (status: string) => (c: Call) => (c.text?.startsWith(status) ? 1800 : 0)

test.skipIf(skip)(
  'bot: on a deploy, a download that ends after the cut hears to send the link again and is not uploaded',
  async () => {
    const bot = start({ DRAIN_MS: '3000' }, slow('⏬'))
    let jobs: string[] = []
    try {
      bot.link(1, 'short1')
      await bot.until(() => bot.statuses(1).length > 0)
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
    const bot = start({ DRAIN_MS: '3000' }, slow('⏫'))
    let jobs: string[] = []
    try {
      bot.link(1, 'short1')
      await bot.until(() => bot.statuses(1).length > 1)
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
    // an ffprobe that takes 4 s, past the exit
    const bin = mkdtempSync(join(tmpdir(), 'bot-e2e-bin-'))
    writeFileSync(join(bin, 'ffprobe'), `#!/bin/sh\nsleep 4\nexec ${Bun.which('ffprobe')} "$@"\n`)
    chmodSync(join(bin, 'ffprobe'), 0o755)
    const bot = start({ DRAIN_MS: '3000', PATH: `${bin}:${join(import.meta.dir, 'test')}:${process.env.PATH}` })
    let jobs: string[] = []
    try {
      bot.link(1, 'short1')
      await bot.until(() => bot.statuses(1).length > 1)
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
    const bot = start({ DRAIN_MS: '3000', STORAGE_CHAT: '9' }, slow('⏬'))
    let jobs: string[] = []
    try {
      bot.guest(1, 'short1')
      await bot.until(() => bot.inline().length > 0)
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
    expect(line('error')).toMatch(/^job error host=www\.youtube\.com .*lane=short ahead=0 dur=30 wait=0\.0 dl=\d+\.\d mb=3 total=/)
    expect(line('fail:tooBig')).toMatch(/^job fail:tooBig host=www\.youtube\.com .*lane=short ahead=0 dur=30 wait=0\.0 dl=\d+\.\d mb=3 total=/)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: the time limit also stops a child of yt-dlp that holds its output, as ffmpeg does',
  async () => {
    // a minute is 250 ms, so a short video's job has 7.5 s, and the child
    // would keep yt-dlp's stdout and stderr open for 20 s; the second one's
    // child ignores SIGTERM, so it takes the SIGKILL 5 s later
    const bot = start({ MINUTE_MS: '250' })
    let jobs: string[] = []
    try {
      bot.link(1, 'ffmpeg1')
      bot.link(2, 'stubbornffmpeg1')
      await bot.until(() => [1, 2].every((chat) => bot.statuses(chat).some((s) => s.startsWith('😱'))), 25_000)
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.videos()).toHaveLength(0)
    for (const chat of [1, 2]) expect(bot.statuses(chat).map((s) => [...s][0])).toEqual(['⏬', '😱'])
    expect(jobs).toHaveLength(2)
    for (const line of jobs)
      expect(line).toMatch(/^job timeout host=www\.youtube\.com .*lane=short .* dl=\d+\.\d mb=2 total=/)
    const [term, kill] = jobs.map((l) => Number(/ dl=([\d.]+)/.exec(l)![1])).sort((a, b) => a - b)
    expect(term).toBeGreaterThanOrEqual(7.5)
    expect(term).toBeLessThan(9)
    expect(kill).toBeGreaterThanOrEqual(12.5)
    expect(kill).toBeLessThan(14)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: the time limit's signals end with yt-dlp's run",
  async () => {
    // a minute is 250 ms, so a short video's job has 7.5 s, and the SIGKILL
    // would come 5 s later. linger1's yt-dlp is done in 0.2 s, and
    // lingerbroken1's fails then, but each leaves a process in its group that
    // doesn't hold its output and lives 15 s: once a run is over, whichever
    // way it ended, neither signal may reach its group (by then the number
    // could lead another one)
    const dir = mkdtempSync(join(tmpdir(), 'bot-e2e-linger-'))
    // each lingering process's log, by its link (a page read again is
    // another run, with a process of its own)
    const logs = () => readdirSync(dir).map((f) => [f.split('.')[0]!, readFileSync(join(dir, f), 'utf8')] as const)
    const bot = start({ MINUTE_MS: '250', LINGER: dir })
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
    // a minute of download time is 250 ms: 7.5 s for a short video, 11.25 s
    // for a long one, and both of these take 9 s
    const bot = start({ MINUTE_MS: '250' })
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
    // the short one is stopped at its 7.5 s, with the 2 MB it had...
    const short = jobs.find((l) => l.includes(' lane=short '))!
    expect(short).toMatch(/^job timeout host=www\.youtube\.com .* dl=\d+\.\d mb=2 total=/)
    expect(dl(short)).toBeGreaterThanOrEqual(7.5)
    expect(dl(short)).toBeLessThan(9)
    // ...while the long one downloads for longer and goes out
    const long = jobs.find((l) => l.includes(' lane=long '))!
    expect(long).toMatch(/^job ok host=www\.youtube\.com /)
    expect(dl(long)).toBeGreaterThan(7.5)
  },
  40_000,
)

test.skipIf(skip)(
  'bot: a page read again gets only the time the job has left',
  async () => {
    // a minute is 250 ms, so a long video's job has 11.25 s. long1 holds the
    // long slot for about 3 s, by when expiredlong1's saved info is stale. Its
    // download from that info fails after 4 s, and the page read again takes
    // 9 s: in the 7.25 s left that times out, where 11.25 s more would finish
    const bot = start({ MINUTE_MS: '250' })
    let jobs: string[] = []
    try {
      bot.link(1, 'long1')
      await bot.until(() => bot.statuses(1).length > 0)
      bot.link(2, 'expiredlong1')
      await bot.until(() => bot.statuses(2).some((s) => s.startsWith('😱')), 30_000)
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.videos().map((v) => v.chat)).toEqual([1])
    const line = jobs.find((l) => l.includes(' reread=1'))!
    expect(line).toMatch(/^job timeout host=www\.youtube\.com .*lane=long .* mb=2 total=/)
    // the job's 11.25 s in all, not 4 s and then another 11.25
    const dl = Number(/ dl=([\d.]+)/.exec(line)![1])
    expect(dl).toBeGreaterThanOrEqual(11.25)
    expect(dl).toBeLessThan(13)
  },
  45_000,
)
