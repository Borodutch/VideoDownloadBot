import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proxyFreeEnv } from './egress'
import { t } from './i18n'
import { arm, type Campaign } from './promo'

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
  query?: string
  file?: Uint8Array
  caption?: string
  title?: string
  performer?: string
  duration?: number
  unique?: string
  // when the fake Bot API got it (Date.now())
  at: number
}
// The video every fake download copies (FAKE_MP4), made once: an ffmpeg run
// per test, in spawnSync, would hold up all the concurrent ones (0.4 s each).
// It lasts 2 s because the bot takes its thumbnail 1 s into a video whose -J
// gives its length (test/yt-dlp's last 30 s or more): a 1 s file has no frame
// there, and each such video sent would fail its thumbnail and fill the bot's
// stderr with ffmpeg's errors
const fixture = mkdtempSync(join(tmpdir(), 'bot-e2e-mp4-'))
const mp4 = join(fixture, 'v.mp4')
if (Bun.which('ffmpeg'))
  Bun.spawnSync(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=2', '-pix_fmt', 'yuv420p', mp4])
afterAll(() => rmSync(fixture, { recursive: true, force: true }))

function start(env: Record<string, string> = {}, delay: (call: Call) => number | Promise<unknown> = () => 0) {
  const work = mkdtempSync(join(tmpdir(), 'bot-e2e-'))
  const gates = join(work, 'gates')
  mkdirSync(gates)
  // upload = a file sent, not a file_id
  const calls: Call[] = []
  const updates: { update_id: number }[] = []
  // when each guest message (by its query) was sent, in s
  const dates = new Map<string, number>()
  let id = 0
  // the offset of the bot's last getUpdates (taken()), and when it asked for
  // updates first (until())
  let offset = 0
  let up: number | undefined
  const me = { id: 1, is_bot: true, first_name: 'Vid', username: 'VidBot' }
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
      if (method === 'getMe') return ok(me)
      if (method === 'getUpdates') {
        up ??= performance.now()
        offset = Math.max(offset, body.offset ?? 0)
        const next = updates.filter((u) => u.update_id >= (body.offset ?? 0))
        if (!next.length) await Bun.sleep(100)
        return ok(next)
      }
      // inline = the guest reply an edit is to, query = the guest message an
      // answer is to (text = the answer's), file = the bytes uploaded
      // (grammY sends a file as attach://<the field it's in>), title,
      // performer and duration as a video or audio file was sent with
      const media = [body.video, body.audio]
        .map((x) => (typeof x === 'string' && x.startsWith('attach://') ? body[x.slice(9)] : x))
        .find((x) => x instanceof Blob)
      const call: Call = {
        method,
        chat: chat.id,
        text: body.text ?? body.result?.input_message_content?.message_text,
        upload: type.includes('multipart'),
        inline: body.inline_message_id,
        query: body.guest_query_id,
        file: media && new Uint8Array(await media.arrayBuffer()),
        caption: body.caption,
        title: body.title,
        performer: body.performer,
        duration: body.duration === undefined ? undefined : Number(body.duration),
        at: Date.now(),
      }
      calls.push(call)
      const ms = delay(call)
      if (typeof ms !== 'number') await ms
      else if (ms) await Bun.sleep(ms)
      // Telegram stops taking an answer to a guest message after a while it
      // doesn't say: here once it was sent over a minute ago
      const asked = dates.get(body.guest_query_id)
      if (method === 'answerGuestQuery' && asked !== undefined && Date.now() / 1000 - asked > 60)
        return Response.json({
          ok: false,
          error_code: 400,
          description: 'Bad Request: query is too old and response timeout expired or query ID is invalid',
        })
      // an answer's inline is the reply it posts
      if (method === 'answerGuestQuery') return ok({ inline_message_id: (call.inline = `g${++id}`) })
      if (method === 'sendMessage') return ok({ message_id: ++id, date: 0, chat, text: body.text })
      // cached file_ids "unsized…" went out without a size, as before #281,
      // and "dead…" ones are gone from Telegram's servers; unique = the
      // file_unique_id the video went out with
      if (method === 'sendVideo') {
        if (String(body.video).startsWith('dead'))
          return Response.json({ ok: false, error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' })
        call.unique = `u${++id}`
        return ok({
          message_id: id,
          date: 0,
          chat,
          video: {
            file_id: `v${id}`,
            file_unique_id: call.unique,
            ...(String(body.video).startsWith('unsized') ? {} : { width: 320, height: 240 }),
            duration: 1,
          },
        })
      }
      if (method === 'sendAudio')
        return ok({ message_id: ++id, date: 0, chat, audio: { file_id: `a${id}`, file_unique_id: `u${id}`, duration: 1 } })
      return ok(true)
    },
  })
  // The bot talks to the fake Bot API at 127.0.0.1 directly: a proxy in the
  // test's environment (an HTTP_PROXY without a NO_PROXY, which Bun's fetch
  // follows) would carry each call, and a busy one fails some with a 502
  const bot = Bun.spawn([process.execPath, 'bot.ts'], {
    cwd: import.meta.dir,
    env: {
      ...proxyFreeEnv(),
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
      // a guest message's answer waits for the test's timeUp(), not for
      // GUEST_WAIT_MS ('' gives the bot its timer back)
      GUEST_GATES: gates,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // the bot's stdout and stderr lines so far (stderr has its console.error
  // lines and its ffmpeg runs' errors)
  const lines: string[] = []
  const errors: string[] = []
  // termed: term() has sent the SIGTERM; failed: an until() ran out
  let termed = false
  let failed = false
  const read = async (stream: typeof bot.stdout, into: string[]) => {
    let rest = ''
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
      const parts = (rest + chunk).split('\n')
      rest = parts.pop()!
      into.push(...parts)
    }
    if (rest) into.push(rest)
  }
  const reading = Promise.all([read(bot.stdout, lines), read(bot.stderr, errors)])
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
  // the bot's own video of v, as it went out (the title linked to the link,
  // then the mention)
  const sent = (v: string) => ({
    message_id: ++id,
    date: 0,
    video: { file_id: `f${id}`, file_unique_id: `f${id}`, width: 320, height: 240, duration: 1 },
    caption: `${v}\n@${me.username}`,
    caption_entities: [{ type: 'text_link', offset: 0, length: v.length, url: `https://www.youtube.com/watch?v=${v}` }],
  })
  const forwarded = { forward_origin: { type: 'user', date: 0, sender_user: me } }
  // that video posted by user 9 into chat (a group when it's negative, else
  // that user's chat with the bot) with extra on top; returns the message
  const post = (chat: number, v: string, extra: object) => {
    const user = chat < 0 ? 9 : chat
    const message = {
      ...sent(v),
      chat: chat < 0 ? { id: chat, type: 'supergroup', title: 'g' } : { id: chat, type: 'private', first_name: 'u' },
      from: { id: user, is_bot: false, first_name: 'u', language_code: 'en' },
      ...extra,
    }
    updates.push({ update_id: updates.length + 1, message } as { update_id: number })
    return message
  }
  return {
    calls,
    // FAKE_MP4's bytes, which a download copies
    mp4: readFileSync(mp4),
    // in a private chat
    link(user: number, v: string) {
      updates.push({ update_id: updates.length + 1, message: message(user, v) } as { update_id: number })
    },
    // the bot's own video of v forwarded by user 9 into chat (post)
    forward(chat: number, v: string) {
      post(chat, v, forwarded)
    },
    // a copy of it (forwarded with the sender hidden, or by a client), with
    // nothing of the bot's but the file, unique (its file_unique_id); returns
    // the message
    copy: (chat: number, v: string, unique: string) =>
      post(chat, v, { video: { file_id: 'c', file_unique_id: unique, width: 320, height: 240, duration: 1 } }),
    // user 9 mentioning the bot in group chat, in reply to message to
    mention(chat: number, to: object) {
      updates.push({
        update_id: updates.length + 1,
        message: {
          message_id: ++id,
          date: 0,
          chat: { id: chat, type: 'supergroup', title: 'g' },
          from: { id: 9, is_bot: false, first_name: 'u', language_code: 'en' },
          text: `@${me.username}`,
          entities: [{ type: 'mention', offset: 0, length: me.username.length + 1 }],
          reply_to_message: to,
        },
      } as { update_id: number })
    },
    // as a guest message (query q<user>) in user's private chat with someone
    // else: the bot mentioned with the link to v (Telegram doesn't call it on
    // a link alone), or about its own video of v: 'forward' is that video
    // forwarded, 'reply' a plain reply to it ("lol"), which Telegram calls
    // the bot on as well, 'mention' the bot mentioned in reply to it. With
    // link, the reply carries that link of its own after its words. It's
    // sent now, or at date (in s): a plain reply's answer waits for the
    // test's timeUp() at the latest (or GUEST_WAIT_MS after date, with
    // GUEST_GATES '').
    guest(
      user: number,
      v: string,
      about?: 'forward' | 'reply' | 'mention',
      link?: string,
      date = Math.floor(Date.now() / 1000),
    ) {
      dates.set(`q${user}`, date)
      const { text, entities, ...m } = message(user, v)
      // words, then a url entity for url
      const say = (words: string, url?: string) => {
        const all = url ? `${words} ${url}` : words
        return { text: all, entities: url ? [{ type: 'url', offset: all.length - url.length, length: url.length }] : [] }
      }
      const reply = (words: string) => ({ ...say(words, link), reply_to_message: { ...sent(v), chat: m.chat, from: me } })
      updates.push({
        update_id: updates.length + 1,
        guest_message: {
          ...m,
          date,
          ...(about === 'forward'
            ? { ...sent(v), ...forwarded }
            : about === 'reply'
              ? reply('lol')
              : about === 'mention'
                ? reply(`@${me.username}`)
                : say(`@${me.username}`, text)),
          guest_query_id: `q${user}`,
        },
      } as { update_id: number })
    },
    // as a guest message (query q<user>) in a chat the bot isn't in: a copy
    // of its video of v, whose caption mentions it, file = the copy's
    // file_unique_id (copy); with mention, the bot mentioned in reply to
    // such a copy instead
    guestCopy(user: number, v: string, file: string, mention = false) {
      const { text, entities, ...m } = message(user, v)
      const copy = { ...sent(v), video: { file_id: 'c', file_unique_id: file, width: 320, height: 240, duration: 1 } }
      updates.push({
        update_id: updates.length + 1,
        guest_message: {
          ...m,
          ...(mention
            ? { text: `@${me.username}`, entities: [], reply_to_message: { ...copy, chat: m.chat, from: m.from } }
            : copy),
          guest_query_id: `q${user}`,
        },
      } as { update_id: number })
    },
    // what the reply to user's guest message (query q<user>) showed, in order:
    // the answer's text, then each edit's, 'video' for the video edited in;
    // nothing without an answer
    reply(user: number) {
      const answer = calls.find((c) => c.query === `q${user}` && c.inline)
      return answer
        ? calls
            .filter((c) => c.inline === answer.inline)
            .map((c) => (c.method === 'editMessageMedia' ? 'video' : c.text!))
        : []
    },
    // a command ("/start <payload>") from user in a private chat
    command(user: number, text: string) {
      updates.push({
        update_id: updates.length + 1,
        message: {
          message_id: ++id,
          date: 0,
          text,
          entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }],
          chat: { id: user, type: 'private', first_name: 'u' },
          from: { id: user, is_bot: false, first_name: 'u', language_code: 'en' },
        },
      } as { update_id: number })
    },
    // Waits for done() to hold, ms of wall-clock time at most, counted from
    // the bot's first getUpdates at the earliest: on a busy runner its start
    // alone (Bun's, the fake yt-dlp's self-update, getMe) has taken over 15
    // s, which is no wait's. Whatever the start took, though, a wait is over
    // 25 s in at most (or ms, when that's longer), so that it fails before
    // its test's 30 s run out and loses this report. One that runs out fails
    // with where it was (its lines in this file, the test's last), what it
    // waited for, the bot's last stderr and stdout lines and its last Bot API
    // calls (getMe and getUpdates aside)
    async until(done: () => boolean, ms = 15_000) {
      // the callers' frames, taken before an await drops them
      const at = (new Error().stack ?? '')
        .split('\n')
        .slice(2)
        .map((l) => /bot\.e2e\.test\.ts:(\d+)/.exec(l)?.[1])
        .filter(Boolean)
      const begun = performance.now()
      while (!done()) {
        const now = performance.now()
        const waited = now - begun
        if ((up !== undefined && now - Math.max(begun, up) >= ms) || waited >= Math.max(ms, 25_000)) {
          const tail = (what: string, of: string[]) =>
            `${what}, last ${Math.min(of.length, 30)} of ${of.length}:\n${of.slice(-30).join('\n') || '(none)'}`
          // (a call with no chat_id, as deleteWebhook, has chat NaN)
          const made = calls.map(
            (c) => `${c.method} ${Number.isNaN(c.chat) ? '-' : c.chat}${c.text ? ` ${JSON.stringify(c.text.slice(0, 60))}` : ''}`,
          )
          // (a bot that came up only during the wait: when)
          const late =
            up === undefined ? ', the bot not up yet' : up > begun ? `, the bot up ${((up - begun) / 1000).toFixed(1)} s in` : ''
          failed = true
          throw new Error(
            [
              `until() at bot.e2e.test.ts:${at.join(' < ') || '?'} not done after ${(waited / 1000).toFixed(1)} s${late}: ${done}`,
              tail('bot stderr lines', errors),
              tail('bot stdout lines', lines),
              tail('Bot API calls', made),
            ].join('\n'),
          )
        }
        await Bun.sleep(50)
      }
    },
    videos: () => calls.filter((c) => c.method === 'sendVideo'),
    // the status texts a chat got, sent or edited
    statuses: (chat: number) =>
      calls.filter((c) => c.chat === chat && /^(sendMessage|editMessageText)$/.test(c.method)).map((c) => c.text!),
    // whether a "jhold" link's -J, a "dhold" link's download or an "lhold"
    // link's check (--list-extractors) is held, and lets it go on (test/yt-dlp)
    held: (v: string, what: 'J' | 'dl' | 'L') => existsSync(join(gates, `${v}.${what}.held`)),
    release(v: string, what: 'J' | 'dl' | 'L') {
      writeFileSync(join(gates, `${v}.${what}`), '')
    },
    // whether the bot has taken every update so far: grammY asks for the ones
    // after a batch only once it has handled it, and by then a link in a
    // private chat is in deliver() (requested() has nothing to check there,
    // so handle() starts before grammY goes on)
    taken: () => offset > updates.length,
    // whether the answer to user's guest message (query q<user>) waits for
    // the test (GUEST_GATES), and its time being up, which ends that wait as
    // GUEST_WAIT_MS would (the bot stops waiting once it sees it: waits() is
    // false then)
    waits: (user: number) => existsSync(join(gates, `q${user}.held`)),
    timeUp(user: number) {
      writeFileSync(join(gates, `q${user}`), '')
    },
    // the bot's job log lines so far
    jobs: () => lines.filter((l) => l.startsWith('job ')),
    // a deploy's SIGTERM; resolves once the drain has begun, and with
    // CUT_MS=0 (DEPLOY) once it has cut
    async term() {
      termed = true
      bot.kill('SIGTERM')
      const said = (word: string) => lines.some((l) => l.startsWith(word))
      await this.until(() => said('draining ') && (env.CUT_MS !== '0' || said('cut ')))
    },
    // whether the bot's process is still running
    running: () => bot.exitCode === null && bot.signalCode === null,
    // the exit, when nothing that's still running may finish
    kill() {
      bot.kill('SIGKILL')
    },
    // SIGTERM, as on a deploy (unless term() has sent it: a second one
    // kills), then the bot's end; resolves to its job log lines. After an
    // until() that ran out it's SIGKILL: the test never let go of what it
    // holds (a download, a gate), and a drain waiting on that would outlast
    // the test's own timeout, which would hide the until()'s failure
    async stop() {
      if (failed) bot.kill('SIGKILL')
      else if (!termed) bot.kill('SIGTERM')
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
      // one user's two long links go one at a time: the first one downloads
      // (its ⏬ is up and its -J turn over) and holds the long slot until the
      // test lets it go on...
      bot.link(1, 'dholdlong1')
      await bot.until(() => bot.held('dholdlong1', 'dl'))
      // ...so the second one, its -J turn free, is in line for that slot
      bot.link(1, 'long2')
      await bot.until(() => bot.statuses(1).some((s) => s.startsWith('⏳')))
      // ...and another user's short link doesn't wait for them
      bot.link(2, 'short1')
      await bot.until(() => bot.videos().length === 1)
      // a third user asks for the queued video (long2) too: the bot has that
      // request, following the job, while the job is still in line
      bot.link(3, 'long2')
      await bot.until(() => bot.taken())
      // the second long one waits 2 s at least; then the first one's
      // download goes on, and the second one's after it
      await Bun.sleep(2000)
      bot.release('dholdlong1', 'dl')
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
  // its five waits and its 2 s pause come one after another, and under load
  // the last wait has begun almost 15 s in: a timeout of it must still end,
  // with its report, before the test's own timeout does
  45_000,
)

test.skipIf(skip)(
  "bot: an Instagram reel, which doesn't say how long it is, goes out while three long videos download; a stream that doesn't waits",
  async () => {
    // four slots, three for long videos
    const bot = start({ MAX_DOWNLOADS: '4' })
    let jobs: string[] = []
    const long = ['dholdlong1', 'dholdlong2', 'dholdlong3']
    try {
      // two users' long links take the three long slots (one user's take two
      // at most) and download until the test lets them go...
      bot.link(1, 'dholdlong1')
      bot.link(1, 'dholdlong2')
      bot.link(2, 'dholdlong3')
      await bot.until(() => long.every((v) => bot.held(v, 'dl')))
      // ...a reel takes the fourth at once and goes out, and a stream of
      // unknown length waits for a long one, 2 s at least
      bot.link(3, 'reel1')
      bot.link(4, 'stream1')
      await bot.until(() => bot.videos().length === 1 && bot.statuses(4).some((s) => s.startsWith('⏳')))
      await Bun.sleep(2000)
      for (const v of long) bot.release(v, 'dl')
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
  // its three waits and its 2 s pause come one after another, 57 s at most
  // by their budgets (the first wait's is 25 s: until() counts its 15 s
  // from when the bot is up): a timeout of the last must still end, with
  // its report, before the test's own timeout does
  60_000,
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
    const downloading = (chat: number) => bot.statuses(chat).some((s) => s.startsWith('⏬'))
    try {
      // one user's two long links keep the long lane busy, one downloading
      // and one in line (a ⏳ alone may be one link's wait for a -J turn
      // while the other's -J still runs, the lane still free)...
      bot.link(1, 'dholdlong1')
      bot.link(1, 'dholdlong2')
      await bot.until(() => queued(1) && downloading(1))
      // ...another user's long link is being described...
      bot.link(2, 'jholddholdlong3')
      await bot.until(() => bot.held('jholddholdlong3', 'J'))
      // ...and a third user asks for it meanwhile: the bot has that request,
      // following the job, before the -J goes on; then the job waits for a
      // slot, and both hear so
      bot.link(3, 'jholddholdlong3')
      await bot.until(() => bot.taken())
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
      // the first request's download goes on only once the test lets it, by
      // when the second one follows the job and has heard it's downloading
      bot.link(1, 'dholdlong1')
      await bot.until(() => bot.held('dholdlong1', 'dl'))
      bot.link(3, 'dholdlong1')
      await bot.until(() => bot.statuses(3).length > 0)
      bot.release('dholdlong1', 'dl')
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
  "bot: its own video forwarded into a group it's in, or to itself, gets no answer",
  async () => {
    const bot = start()
    let jobs: string[] = []
    try {
      bot.forward(-100, 'short1')
      bot.forward(2, 'short2')
      // a link sent after them: once its video is out, they've been handled
      bot.link(3, 'short3')
      await bot.until(() => bot.videos().some((v) => v.chat === 3))
    } finally {
      jobs = await bot.stop()
    }
    // no download, status or help text for the forwards (methods only: a
    // failing toEqual on the calls would print an upload's every byte)
    expect(bot.calls.filter((c) => c.chat === -100 || c.chat === 2).map((c) => [c.chat, c.method])).toEqual([])
    expect(bot.videos().map((v) => v.chat)).toEqual([3])
    expect(jobs.length).toBe(1)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: in a chat it isn't in, a plain reply to its video or the video forwarded gets no answer, a mention in reply the help; without a storage chat, a plain reply with a video's link gets none either, a mention with one the failure",
  async () => {
    // (no STORAGE_CHAT or ADMIN_ID: guest downloads fail)
    const bot = start()
    let jobs: string[] = []
    try {
      // (users other than 1, the bot's own id) The plain reply was sent 40 s
      // ago, its time up: one that asked for something would be answered at
      // once, so only its asking for nothing keeps it unanswered
      bot.guest(2, 'short2', 'reply', undefined, Math.floor(Date.now() / 1000) - 40)
      bot.guest(3, 'short3', 'forward')
      bot.guest(5, 'short5', 'reply', 'https://www.youtube.com/watch?v=video5')
      // once the mentions' answers are out, the others have been handled
      // (the drain lets every handler finish, so whatever the plain reply
      // with a link was going to say is in by then too)
      bot.guest(4, 'short4', 'mention')
      bot.guest(6, 'video6')
      await bot.until(() => bot.reply(4).length > 0 && bot.reply(6).includes(t('en', 'failed')))
    } finally {
      jobs = await bot.stop()
    }
    // no answer, edit or message for the plain replies and the forward
    // (methods and texts only: a failing toEqual on the calls would print an
    // upload's every byte)
    expect(bot.calls.filter((c) => c.query).map((c) => c.query).sort()).toEqual(['q4', 'q6'])
    expect(bot.calls.filter((c) => [2, 3, 4, 5, 6].includes(c.chat)).map((c) => [c.chat, c.method])).toEqual([])
    expect(bot.reply(4)).toEqual([t('en', 'help')])
    expect(bot.reply(6)).toEqual([t('en', 'downloading'), t('en', 'failed')])
    expect(bot.videos()).toHaveLength(0)
    expect(jobs).toHaveLength(0)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: in a chat it isn't in, a plain reply to its video is only answered once its own link has a video, a mention at once",
  async () => {
    const bot = start({ STORAGE_CHAT: '9' })
    let jobs: string[] = []
    const [downloading, uploading, failed] = (['downloading', 'uploading', 'failed'] as const).map((k) => t('en', k))
    // a page no site's extractor claims, and where -J finds no video (test/yt-dlp)
    const article = 'https://example.com/article'
    // a page YouTube's extractor claims where -J finds no video either, as on
    // a tweet without one (test/yt-dlp)
    const tweet = 'https://www.youtube.com/watch?v=tweet5'
    // a YouTube video that's unavailable: a real failure (test/yt-dlp)
    const unavailable = 'https://www.youtube.com/watch?v=fail7'
    // a page YouTube's extractor claims where -J finds a news article without
    // media, an empty playlist (test/yt-dlp): no video, as on a BBC or CNN
    // article, and no tweet, whose failure is never told anyway
    const news = 'https://www.youtube.com/watch?v=news11'
    try {
      // (these come from private chats, see guest(): a guest message is
      // checked there as in a group all the same)
      // The mentions first, a -J turn each (MAX_DOWNLOADS=2, so the third
      // mention comes once the others are over): with the plain replies'
      // jobs below they might wait for one, and show "In the queue". The
      // plain replies with the tweet and the news article below then get a
      // -J of their own rather than those mentions'.
      bot.guest(6, 'short6', 'mention', tweet)
      bot.guest(4, 'short4', 'mention', article)
      await bot.until(() => bot.reply(6).includes(failed) && bot.reply(4).includes(failed))
      bot.guest(10, 'short10', 'mention', news)
      await bot.until(() => bot.reply(10).includes(failed))
      bot.guest(2, 'short2', 'reply', article)
      bot.guest(5, 'short5', 'reply', tweet)
      bot.guest(11, 'short11', 'reply', news)
      bot.guest(3, 'short3', 'reply', 'https://www.youtube.com/watch?v=video3')
      bot.guest(7, 'short7', 'reply', unavailable)
      // the YouTube video is edited in, the unavailable video's plain reply
      // hears it's unavailable, and the -J of the tweet's and the news
      // article's plain replies has found no video (their job lines, after
      // the mentions' two)
      await bot.until(
        () =>
          bot.reply(3).includes('video') &&
          bot.reply(7).includes(failed) &&
          bot.jobs().filter((l) => l.startsWith('job fail:quiet host=www.youtube.com ')).length === 4,
      )
      // Another link to the video that went out (the stand-in's id is v=):
      // its -J finds that video, whose copy cached under its id goes out with
      // no status from the job
      bot.guest(8, 'short8', 'reply', 'https://www.youtube.com/watch?v=video3&t=1')
      await bot.until(() => bot.reply(8).includes('video'))
    } finally {
      // the drain lets every handler finish, so whatever the plain replies
      // without a video were going to say is in by then
      jobs = await bot.stop()
    }
    // The mentions are answered at once, then hear the page has no video. The
    // YouTube video's plain reply is answered once -J has found it, which is
    // then edited in, and the other plain replies get no answer: the
    // article's link isn't checked, the tweet's page and the news article
    // have no video. (Texts only: a failing toEqual on the calls would print
    // an upload's every byte.)
    expect(bot.reply(6)).toEqual([downloading, failed])
    expect(bot.reply(4)).toEqual([downloading, failed])
    expect(bot.reply(10)).toEqual([downloading, failed])
    expect(bot.reply(3)).toEqual([downloading, uploading, 'video'])
    // The unavailable video's plain reply is answered with the failure, as a
    // group hears it; the other link to the cached video is answered once
    // that copy has gone out, which is then edited in
    expect(bot.reply(7)).toEqual([failed])
    expect(bot.reply(8)).toEqual([downloading, 'video'])
    expect(bot.calls.filter((c) => c.query).map((c) => c.query).sort()).toEqual(['q10', 'q3', 'q4', 'q6', 'q7', 'q8'])
    // the YouTube link's video went out (through the storage chat), then its
    // cached copy for the other link; the article's one job, the tweet's two
    // and the news article's two found nothing
    expect(bot.videos().map((v) => v.chat)).toEqual([9, 9])
    expect(bot.calls.filter((c) => c.method === 'editMessageMedia')).toHaveLength(2)
    expect(jobs.map((l) => l.split(' ').slice(1, 3).join(' ')).sort()).toEqual([
      'cached host=www.youtube.com',
      'fail:failed host=www.youtube.com',
      'fail:quiet host=example.com',
      'fail:quiet host=www.youtube.com',
      'fail:quiet host=www.youtube.com',
      'fail:quiet host=www.youtube.com',
      'fail:quiet host=www.youtube.com',
      'ok host=www.youtube.com',
    ])
  },
  // four until()s: the first 25 s at most (it may count the bot's start),
  // the others 15 s each
  80_000,
)

test.skipIf(skip)(
  "bot: in a chat it isn't in, a plain reply whose link still waits for -J when the answer can't wait any longer is answered then",
  async () => {
    // (each plain reply's answer waits until the test says its time is up:
    // timeUp(), GUEST_GATES)
    const bot = start({ STORAGE_CHAT: '9' })
    let jobs: string[] = []
    const [downloading, queued, uploading, failed] = (['downloading', 'queued', 'uploading', 'failed'] as const).map(
      (k) => t('en', k),
    )
    const link = (v: string) => `https://www.youtube.com/watch?v=${v}`
    try {
      // both -J turns (MAX_DOWNLOADS=2) held: a page without a video's and a
      // video's
      bot.guest(10, 'short10', 'reply', link('jholdtweet10'))
      bot.guest(11, 'short11', 'reply', link('jholdvideo11'))
      await bot.until(
        () => bot.held('jholdtweet10', 'J') && bot.held('jholdvideo11', 'J') && bot.waits(10) && bot.waits(11),
      )
      // A mention of a third video, whose download is held too, waits for a
      // turn: it's answered at once, then hears it's queued
      bot.guest(14, 'jholddholdvideo12')
      await bot.until(() => bot.reply(14).includes(queued))
      // Plain replies with that link follow the mention's job, which tells
      // each it's queued as it's handled (a job of its own would only tell it
      // after a step the test can't see)
      bot.guest(12, 'short12', 'reply', link('jholddholdvideo12'))
      bot.guest(15, 'short15', 'reply', link('jholddholdvideo12'))
      await bot.until(() => bot.waits(12) && bot.waits(15))
      // nothing is answered before its time is up
      expect([10, 11, 12, 15].map((user) => bot.reply(user))).toEqual([[], [], [], []])
      // then each is answered with where its job is
      for (const user of [10, 11, 12]) bot.timeUp(user)
      await bot.until(() => [10, 11, 12].every((user) => bot.reply(user).length > 0))
      bot.release('jholdtweet10', 'J')
      bot.release('jholdvideo11', 'J')
      // a freed turn goes to the third link, whose download begins: that
      // answers the reply whose time isn't up yet
      await bot.until(() => bot.held('jholddholdvideo12', 'J'))
      bot.release('jholddholdvideo12', 'J')
      await bot.until(() => bot.held('jholddholdvideo12', 'dl') && bot.reply(15).length > 0)
      // its time being up now changes nothing: it has its answer
      bot.timeUp(15)
      await bot.until(() => !bot.waits(15))
      bot.release('jholddholdvideo12', 'dl')
      await bot.until(
        () => bot.reply(10).includes(failed) && [11, 12, 14, 15].every((user) => bot.reply(user).includes('video')),
      )
      // a plain reply whose link's video is cached gets it at once, no -J needed
      bot.guest(13, 'short13', 'reply', link('jholdvideo11'))
      await bot.until(() => bot.reply(13).includes('video'))
    } finally {
      jobs = await bot.stop()
    }
    // The page without a video hears so, as after a mention; the videos go on
    // as after one (the job's own "Downloading…" leaves the answer's be), and
    // the mention shows the wait for a turn
    expect(bot.reply(10)).toEqual([downloading, failed])
    expect(bot.reply(11)).toEqual([downloading, uploading, 'video'])
    expect(bot.reply(14)).toEqual([downloading, queued, downloading, uploading, 'video'])
    expect(bot.reply(12)).toEqual([queued, downloading, uploading, 'video'])
    // answered by the download, then its time up: no "In the queue" after
    expect(bot.reply(15)).toEqual([downloading, uploading, 'video'])
    expect(bot.reply(13)).toEqual([downloading, 'video'])
    // the two videos uploaded to the storage chat, and the copies sent there:
    // the second one's for each reply following its job, the cached one's
    expect(bot.videos().map((v) => [v.chat, v.upload]).sort()).toEqual([
      [9, false],
      [9, false],
      [9, false],
      [9, true],
      [9, true],
    ])
    expect(jobs.map((l) => l.split(' ').slice(1, 3).join(' ')).sort()).toEqual([
      'fail:quiet host=www.youtube.com',
      'ok host=www.youtube.com',
      'ok host=www.youtube.com',
    ])
  },
  30_000,
)

test.skipIf(skip)(
  "bot: in a chat it isn't in, a plain reply whose page has no video stays unanswered past the time its answer could wait",
  async () => {
    const bot = start({ STORAGE_CHAT: '9' })
    let jobs: string[] = []
    const link = (v: string) => `https://www.youtube.com/watch?v=${v}`
    try {
      // A tweet without a video, whose -J fails at once, and a video whose -J
      // is held (a -J turn each): the tweet's job is over, the video's waits
      bot.guest(5, 'short5', 'reply', link('tweet5'))
      bot.guest(6, 'short6', 'reply', link('jholdvideo6'))
      await bot.until(() => bot.jobs().length === 1 && bot.held('jholdvideo6', 'J') && bot.waits(6))
      // then both their times are up: once the bot has stopped waiting for
      // both, the video's reply is answered, the tweet's isn't
      bot.timeUp(5)
      bot.timeUp(6)
      await bot.until(() => !bot.waits(5) && bot.reply(6).length > 0)
      bot.release('jholdvideo6', 'J')
      await bot.until(() => bot.reply(6).includes('video'))
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.calls.filter((c) => c.query).map((c) => c.query)).toEqual(['q6'])
    expect(bot.reply(6)).toEqual([t('en', 'downloading'), t('en', 'uploading'), 'video'])
    expect(jobs.map((l) => l.split(' ').slice(1, 3).join(' ')).sort()).toEqual([
      'fail:quiet host=www.youtube.com',
      'ok host=www.youtube.com',
    ])
  },
  30_000,
)

test.skipIf(skip)(
  "bot: in a chat it isn't in, a plain reply is answered at once when the bot has its video or its time is up already, and gets no job when that answer comes too late",
  async () => {
    // old20 has a copy cached under its link and id from before videos went
    // out with their size (#281), which the fake Bot API resends without
    // one: it's downloaded again to replace that copy
    const data = mkdtempSync(join(tmpdir(), 'bot-e2e-data-'))
    const link = (v: string) => `https://www.youtube.com/watch?v=${v}`
    const db = new Database(join(data, 'bot.sqlite'))
    db.run('CREATE TABLE files (key TEXT PRIMARY KEY, kind TEXT NOT NULL, file_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL)')
    for (const key of [link('jholdold20'), 'Youtube:jholdold20'])
      db.run("INSERT INTO files VALUES (?, 'video', 'unsized20', 'Video', ?)", [key, link('jholdold20')])
    db.close()
    const bot = start({ STORAGE_CHAT: '9', DATA_DIR: data })
    let jobs: string[] = []
    const [downloading, uploading] = (['downloading', 'uploading'] as const).map((k) => t('en', k))
    const now = Math.floor(Date.now() / 1000)
    try {
      // The cached video, whose download again holds its -J; a video sent
      // 40 s ago, past the 30 s its answer may wait, whose -J is held too;
      // and one sent 10 minutes ago, too long for Telegram to take its answer
      bot.guest(20, 'short20', 'reply', link('jholdold20'))
      bot.guest(21, 'short21', 'reply', link('jholdvideo21'), now - 40)
      bot.guest(22, 'short22', 'reply', link('video22'), now - 600)
      // the first two are answered while their -J runs, and the third tried
      await bot.until(
        () =>
          bot.held('jholdold20', 'J') &&
          bot.held('jholdvideo21', 'J') &&
          [20, 21].every((user) => bot.reply(user).length > 0) &&
          bot.calls.some((c) => c.query === 'q22'),
      )
      bot.release('jholdold20', 'J')
      bot.release('jholdvideo21', 'J')
      await bot.until(() => [20, 21].every((user) => bot.reply(user).includes('video')))
    } finally {
      jobs = await bot.stop()
      rmSync(data, { recursive: true, force: true })
    }
    // The download again shows nothing until its video is edited in, the
    // other video goes on as after a mention
    expect(bot.reply(20)).toEqual([downloading, 'video'])
    expect(bot.reply(21)).toEqual([downloading, uploading, 'video'])
    // The late one's answer was refused, and no job ran for it: the two are
    // the cached video's and the other one's
    expect(bot.calls.filter((c) => c.query === 'q22').map((c) => [c.method, c.inline])).toEqual([
      ['answerGuestQuery', undefined],
    ])
    expect(jobs.map((l) => l.split(' ').slice(1, 3).join(' '))).toEqual(['ok host=www.youtube.com', 'ok host=www.youtube.com'])
  },
  30_000,
)

test.skipIf(skip)(
  "bot: on a deploy, a guest reply that doesn't mention the bot and has no answer yet gets none when its time runs out in the drain",
  async () => {
    // The drain alone, not DEPLOY's cut at once: the cut is 598 s away, so
    // it's the drain having begun that keeps the reply unanswered, as in the
    // 13 s between the two in production
    const bot = start({ DRAIN_MS: '600000', STORAGE_CHAT: '9' })
    let jobs: string[] = []
    try {
      // a page without a video, whose -J is held through the drain's start
      // and until the bot has stopped waiting for the reply's answer, its
      // time up
      bot.guest(30, 'short30', 'reply', 'https://www.youtube.com/watch?v=jholdtweet30')
      await bot.until(() => bot.held('jholdtweet30', 'J') && bot.waits(30))
      await bot.term()
      bot.timeUp(30)
      await bot.until(() => !bot.waits(30))
      bot.release('jholdtweet30', 'J')
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.calls.filter((c) => c.query || c.inline).map((c) => c.method)).toEqual([])
    expect(jobs.map((l) => l.split(' ').slice(1, 3).join(' '))).toEqual(['fail:quiet host=www.youtube.com'])
  },
  30_000,
)

test.skipIf(skip)(
  "bot: on a deploy, a guest reply that doesn't mention the bot and whose time ran out while its link was checked isn't answered at once once the drain has begun",
  async () => {
    // the drain alone, as above
    const bot = start({ DRAIN_MS: '600000', STORAGE_CHAT: '9' })
    const v = 'lholdjholdtweet31'
    let jobs: string[] = []
    try {
      // Sent 40 s ago, so its time is up; its link's check (--list-extractors)
      // is held until the drain has begun, then its -J, of a page without a
      // video, until its time being up has been dealt with
      bot.guest(31, 'short31', 'reply', `https://www.youtube.com/watch?v=${v}`, Math.floor(Date.now() / 1000) - 40)
      await bot.until(() => bot.held(v, 'L'))
      await bot.term()
      bot.release(v, 'L')
      // It waits for -J as one with time left does, and its time being up
      // (the timer fires at once in production) answers nothing either
      await bot.until(() => bot.held(v, 'J'))
      expect(bot.waits(31)).toBe(true)
      bot.timeUp(31)
      await bot.until(() => !bot.waits(31))
      bot.release(v, 'J')
    } finally {
      // a failed check above mustn't keep the drain waiting for its handler
      bot.release(v, 'L')
      bot.release(v, 'J')
      jobs = await bot.stop()
    }
    expect(bot.calls.filter((c) => c.query || c.inline).map((c) => c.method)).toEqual([])
    expect(jobs.map((l) => l.split(' ').slice(1, 3).join(' '))).toEqual(['fail:quiet host=www.youtube.com'])
  },
  30_000,
)

test.skipIf(skip)(
  "bot: on a deploy, a guest reply that doesn't mention the bot and has no answer yet gets none when its -J finds a video after the cut",
  async () => {
    const bot = start({ ...DEPLOY, STORAGE_CHAT: '9' })
    let jobs: string[] = []
    try {
      // a short video, whose -J is held until the cut has come
      bot.guest(40, 'short40', 'reply', 'https://www.youtube.com/watch?v=jholdvideo40')
      await bot.until(() => bot.held('jholdvideo40', 'J') && bot.waits(40))
      await bot.term()
      bot.release('jholdvideo40', 'J')
      // a free slot still takes it, and it downloads; past the cut no upload
      // begins, so its job ends there
      await bot.until(() => bot.jobs().length === 1)
    } finally {
      bot.release('jholdvideo40', 'J')
      jobs = await bot.stop()
    }
    // no "Downloading…" that could only lead to "send the link again", as a
    // group message that didn't mention the bot gets none
    expect(bot.calls.filter((c) => c.query || c.inline).map((c) => c.method)).toEqual([])
    expect(bot.videos()).toHaveLength(0)
    expect(jobs.filter((l) => /^job fail:restarting .* dl=/.test(l))).toHaveLength(1)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: on a deploy, before the cut, a guest reply that doesn't mention the bot is answered once its -J finds a short video, and gets it",
  async () => {
    // The drain alone: the cut is 598 s away, so the download can still be
    // uploaded, and the reply shows its progress as before the drain
    const bot = start({ DRAIN_MS: '600000', STORAGE_CHAT: '9' })
    try {
      bot.guest(41, 'short41', 'reply', 'https://www.youtube.com/watch?v=jholdvideo41')
      await bot.until(() => bot.held('jholdvideo41', 'J') && bot.waits(41))
      await bot.term()
      bot.release('jholdvideo41', 'J')
      await bot.until(() => bot.reply(41).includes('video'))
    } finally {
      bot.release('jholdvideo41', 'J')
      await bot.stop()
    }
    expect(bot.reply(41)).toEqual([t('en', 'downloading'), t('en', 'uploading'), 'video'])
  },
  30_000,
)

test.skipIf(skip)(
  "bot: on a deploy, past the cut, a guest reply that doesn't mention the bot whose -J finds a video cached under its id is answered and gets it",
  async () => {
    const bot = start({ ...DEPLOY, STORAGE_CHAT: '9' })
    let jobs: string[] = []
    try {
      // the video goes out first, so it's cached under its id
      bot.guest(42, 'short42', 'reply', 'https://www.youtube.com/watch?v=video42')
      await bot.until(() => bot.reply(42).includes('video'))
      // another link to it (the stand-in's id is v=), whose -J is held until
      // the cut has come; its copy still goes out, so it's answered
      bot.guest(43, 'short43', 'reply', 'https://www.youtube.com/watch?v=video42&t=jhold')
      await bot.until(() => bot.held('video42', 'J') && bot.waits(43))
      await bot.term()
      bot.release('video42', 'J')
      await bot.until(() => bot.reply(43).includes('video'))
    } finally {
      bot.release('video42', 'J')
      jobs = await bot.stop()
    }
    expect(bot.reply(43)).toEqual([t('en', 'downloading'), 'video'])
    expect(jobs.map((l) => l.split(' ').slice(1, 3).join(' '))).toEqual([
      'ok host=www.youtube.com',
      'cached host=www.youtube.com',
    ])
  },
  30_000,
)

test.skipIf(skip)(
  "bot: in a chat it isn't in, the time a plain reply's answer may wait counts from when it was sent",
  async () => {
    // the bot's own timer, GUEST_WAIT_MS's default of 30 s
    const bot = start({ STORAGE_CHAT: '9', GUEST_GATES: '' })
    let jobs: string[] = []
    let date = 0
    try {
      // The bot is up first (a private link has gone out), so the time its
      // start takes can't pass for the reply's wait
      bot.link(1, 'short1')
      await bot.until(() => bot.calls.some((c) => c.chat === 1 && c.method === 'deleteMessage'))
      // sent 25 s ago (in whole seconds), its -J held: its answer can wait
      // 4-5 s more, not 30
      date = Math.floor(Date.now() / 1000) - 25
      bot.guest(23, 'short23', 'reply', 'https://www.youtube.com/watch?v=jholdvideo23', date)
      await bot.until(() => bot.reply(23).length > 0)
      bot.release('jholdvideo23', 'J')
      await bot.until(() => bot.reply(23).includes('video'))
    } finally {
      jobs = await bot.stop()
    }
    // answered once its 30 s since it was sent were up: not at once on
    // handling (as with a shorter wait), nor a whole GUEST_WAIT_MS after it
    // (counted from handling, not from its date). A timer may fire a ms early.
    const late = bot.calls.find((c) => c.query === 'q23')!.at - (date * 1000 + 30_000)
    expect(late).toBeGreaterThanOrEqual(-10)
    expect(late).toBeLessThan(10_000)
    expect(bot.reply(23)).toEqual([t('en', 'downloading'), t('en', 'uploading'), 'video'])
    expect(jobs.map((l) => l.split(' ').slice(1, 3).join(' '))).toEqual([
      'ok host=www.youtube.com',
      'ok host=www.youtube.com',
    ])
  },
  30_000,
)

test.skipIf(skip)(
  "bot: in a chat it isn't in, a plain reply whose answer Telegram no longer takes when the download begins still gets its job done, and the bot goes on",
  async () => {
    // Sent 62 s ago, while its answer may still wait (GUEST_WAIT_MS): the
    // fake Bot API takes no answer to a guest message sent over a minute ago.
    // Its time never runs out here (GUEST_GATES), so the answer it first gets
    // is its job's "Downloading…".
    const bot = start({ STORAGE_CHAT: '9', GUEST_WAIT_MS: '120000' })
    let jobs: string[] = []
    try {
      bot.guest(24, 'short24', 'reply', 'https://www.youtube.com/watch?v=video24', Math.floor(Date.now() / 1000) - 62)
      // the video goes up to the storage chat all the same, then is deleted there
      await bot.until(() => bot.calls.some((c) => c.method === 'deleteMessage' && c.chat === 9))
      expect(bot.running()).toBe(true)
    } finally {
      jobs = await bot.stop()
    }
    // the answer was refused, so there's no reply to edit
    expect(bot.calls.filter((c) => c.query || c.inline).map((c) => [c.method, c.inline])).toEqual([
      ['answerGuestQuery', undefined],
    ])
    expect(bot.videos().map((v) => [v.chat, v.upload])).toEqual([[9, true]])
    expect(jobs.map((l) => l.split(' ').slice(1, 3).join(' '))).toEqual(['ok host=www.youtube.com'])
  },
  30_000,
)

test.skipIf(skip)(
  "bot: in a chat it isn't in, a plain reply's job goes on to its upload while its answer is still on its way, as in a flood wait",
  async () => {
    // the answer waits until the test lets it go
    const answer = gate()
    const bot = start({ STORAGE_CHAT: '9' }, (c) => (c.method === 'answerGuestQuery' ? answer : 0))
    try {
      bot.guest(26, 'short26', 'reply', 'https://www.youtube.com/watch?v=video26')
      // the job doesn't wait for it (nor hold its slot meanwhile): the video
      // goes up to the storage chat
      await bot.until(() => bot.calls.some((c) => c.query === 'q26') && bot.videos().some((v) => v.chat === 9))
      answer.open()
      await bot.until(() => bot.reply(26).includes('video'))
    } finally {
      answer.open()
      await bot.stop()
    }
    // the edits waited for the answer
    expect(bot.reply(26)).toEqual([t('en', 'downloading'), t('en', 'uploading'), 'video'])
  },
  30_000,
)

test.skipIf(skip)(
  "bot: in a chat it isn't in, a plain reply that comes while another process holds the database's lock is answered once its video is found, as any other",
  async () => {
    const data = mkdtempSync(join(tmpdir(), 'bot-e2e-data-'))
    const db = new Database(join(data, 'bot.sqlite'))
    const bot = start({ STORAGE_CHAT: '9', DATA_DIR: data })
    try {
      // up, past the tables set up at start, and done writing: its first
      // link's video is out and cached
      bot.link(1, 'short1')
      await bot.until(() => bot.calls.some((c) => c.chat === 1 && c.method === 'deleteMessage'))
      // The lock another process's commit holds, which fails the bot's reads
      // too: each of the cache's that the reply's link meets (whether the bot
      // has a copy, before it's answered, and the job's) counts as a miss
      db.run('BEGIN EXCLUSIVE')
      bot.guest(25, 'short25', 'reply', 'https://www.youtube.com/watch?v=video25')
      await bot.until(() => bot.reply(25).length > 0)
      db.run('ROLLBACK')
      await bot.until(() => bot.reply(25).includes('video'))
      expect(bot.running()).toBe(true)
    } finally {
      if (db.inTransaction) db.run('ROLLBACK')
      db.close()
      await bot.stop()
      rmSync(data, { recursive: true, force: true })
    }
    expect(bot.reply(25)).toEqual([t('en', 'downloading'), t('en', 'uploading'), 'video'])
  },
  30_000,
)

test.skipIf(skip)(
  'bot: a copy of its own video (forwarded with the sender hidden) gets no answer in a group, in private or where it is a guest, nor does a mention in reply to it take its link',
  async () => {
    // short7 was cached before the bot kept the files it sends: its file
    // becomes the bot's own when it goes out again, from the cache
    const data = mkdtempSync(join(tmpdir(), 'bot-e2e-data-'))
    const link = (v: string) => `https://www.youtube.com/watch?v=${v}`
    const db = new Database(join(data, 'bot.sqlite'))
    db.run('CREATE TABLE files (key TEXT PRIMARY KEY, kind TEXT NOT NULL, file_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL)')
    db.run("INSERT INTO files VALUES (?, 'video', 'old7', 'Video', ?)", [link('short7'), link('short7')])
    db.close()
    const bot = start({ DATA_DIR: data })
    let jobs: string[] = []
    try {
      bot.link(2, 'short1')
      bot.link(6, 'short7')
      await bot.until(() => bot.videos().length === 2)
      const unique = (chat: number) => bot.videos().find((v) => v.chat === chat)!.unique!
      // copies of both in a group, with a mention in reply to one, and in a
      // private chat
      bot.mention(-100, bot.copy(-100, 'short1', unique(2)))
      bot.copy(-100, 'short7', unique(6))
      bot.copy(4, 'short1', unique(2))
      bot.copy(4, 'short7', unique(6))
      // in chats it isn't in: a copy, and a mention in reply to one
      bot.guestCopy(7, 'short1', unique(2))
      bot.guestCopy(8, 'short7', unique(6), true)
      // the same message with a file the bot hasn't sent (user 5's own
      // upload) is a request like any other
      bot.copy(5, 'short5', 'theirs')
      // a link sent after them: once its video is out, they've been handled
      bot.link(3, 'short3')
      await bot.until(() => bot.videos().length === 4 && bot.calls.some((c) => c.query === 'q8'))
    } finally {
      jobs = await bot.stop()
      rmSync(data, { recursive: true, force: true })
    }
    // no download, status or help text for the copies or the mention
    // (methods only: a failing toEqual on the calls would print an upload's
    // every byte)
    expect(bot.calls.filter((c) => c.chat === -100 || c.chat === 4).map((c) => [c.chat, c.method])).toEqual([])
    // where it's a guest, the copy gets no answer, and the mention the help
    // rather than the copy's video again
    expect(bot.calls.filter((c) => c.query || c.inline).map((c) => [c.query, c.method, c.text])).toEqual([
      ['q8', 'answerGuestQuery', t('en', 'help')],
    ])
    expect(bot.videos().map((v) => [v.chat, v.upload]).sort()).toEqual([
      [2, true],
      [3, true],
      [5, true],
      [6, false],
    ])
    expect(jobs.length).toBe(3)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: a sent table that fails every write and read lets a copy of its video through as a request, and serves links and users' own uploads as usual",
  async () => {
    // sent as a view without a file column: the bot's CREATE TABLE IF NOT
    // EXISTS leaves it, and every write to it (keep, as a file goes out) and
    // read of it (mine, whether a message's file is the bot's) fails. A
    // failed write costs the chat nothing, and a failed read only makes the
    // file anyone's.
    const data = mkdtempSync(join(tmpdir(), 'bot-e2e-data-'))
    const db = new Database(join(data, 'bot.sqlite'))
    db.run('CREATE VIEW sent AS SELECT 1 AS other')
    db.close()
    const bot = start({ DATA_DIR: data })
    // a request is over once its status is gone, or says it failed
    const over = (chat: number) =>
      bot.calls.some((c) => c.chat === chat && c.method === 'deleteMessage') ||
      bot.statuses(chat).includes(t('en', 'failed'))
    let jobs: string[] = []
    try {
      bot.link(2, 'short1')
      // its video is cached by then
      await bot.until(() => over(2))
      // a copy of that video, then user 5's own upload with a link
      bot.copy(4, 'short1', bot.videos()[0]!.unique!)
      bot.copy(5, 'short5', 'theirs')
      await bot.until(() => bot.videos().length === 3 && over(5))
    } finally {
      jobs = await bot.stop()
      rmSync(data, { recursive: true, force: true })
    }
    // the copy got short1 from the cache, the others were downloaded
    // (chats and flags only: a failing toEqual on the calls would print an
    // upload's every byte)
    expect(bot.videos().map((v) => [v.chat, v.upload]).sort()).toEqual([
      [2, true],
      [4, false],
      [5, true],
    ])
    // and none heard it failed
    expect(bot.statuses(2).map((s) => s[0])).toEqual(['⏬', '⏫'])
    expect(bot.statuses(4)).toEqual([])
    expect(bot.statuses(5).map((s) => s[0])).toEqual(['⏬', '⏫'])
    expect(jobs.map((l) => l.split(' ', 2)[1])).toEqual(['ok', 'ok'])
  },
  30_000,
)

test.skipIf(skip)(
  "bot: a deploy's handover holding the database's write lock holds up its start rather than ending it",
  async () => {
    // the old container, still polling, has the write lock as the new one
    // starts, on a database with the tables the bot had before sent (files,
    // sized): creating sent waits for it
    const data = mkdtempSync(join(tmpdir(), 'bot-e2e-data-'))
    const db = new Database(join(data, 'bot.sqlite'))
    // The COMMIT that lets the bot go needs the lock that shuts out readers
    // (EXCLUSIVE), and with each try for the write lock the bot holds a
    // reader's lock for a moment: the COMMIT waits that out rather than fail
    // at once (bun:sqlite's busy_timeout is 0). They can't wait on each
    // other: the bot lets go of it before each sleep, and the waiting COMMIT
    // keeps it from taking it again.
    db.run('PRAGMA busy_timeout = 10000')
    db.run('CREATE TABLE files (key TEXT PRIMARY KEY, kind TEXT NOT NULL, file_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL)')
    db.run('CREATE TABLE sized (file_id TEXT PRIMARY KEY)')
    db.run('BEGIN IMMEDIATE')
    const bot = start({ DATA_DIR: data })
    let jobs: string[] = []
    try {
      // without the wait it would have stopped at once
      await Bun.sleep(2000)
      expect(bot.running()).toBe(true)
      db.run('COMMIT')
      bot.link(1, 'short1')
      await bot.until(() => bot.videos().length === 1)
    } finally {
      db.close()
      jobs = await bot.stop()
      rmSync(data, { recursive: true, force: true })
    }
    expect(jobs.length).toBe(1)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: once it's up, another process holding the database's write lock holds up none of its answers",
  async () => {
    // Past the tables set up at start, a statement that meets the lock fails
    // at once rather than wait for it: bun:sqlite is synchronous, so a wait
    // would hold the whole bot still, 10 s for each update's census write
    // alone. The links' downloads wait for the test, so the jobs' own writes
    // (the cache) come once the lock is let go.
    const data = mkdtempSync(join(tmpdir(), 'bot-e2e-data-'))
    const db = new Database(join(data, 'bot.sqlite'))
    const bot = start({ DATA_DIR: data })
    // the chat shows the bot at work on its link (download())
    const busy = (chat: number) => bot.calls.some((c) => c.chat === chat && c.method === 'sendChatAction')
    let jobs: string[] = []
    let chats: number[] = []
    let took = 0
    try {
      // up, past those tables, and done writing: its first link's video is
      // out and cached
      bot.link(1, 'short1')
      await bot.until(() => bot.calls.some((c) => c.chat === 1 && c.method === 'deleteMessage'))
      db.run('BEGIN IMMEDIATE')
      const at = Date.now()
      bot.link(2, 'dhold2')
      bot.link(3, 'dhold3')
      // both are taken up before a single wait would be over: the wait is
      // main()'s busy_timeout for the tables at start (10000 ms; the bound
      // needs it to stay over 5 s), so the two would hold the bot 20 s.
      // Timed on the clock: a busy runner slows the test's polling too.
      await bot.until(() => busy(2) && busy(3))
      took = Date.now() - at
      // and their downloads begin with the lock still held
      await bot.until(() => bot.held('dhold2', 'dl') && bot.held('dhold3', 'dl'))
      // their census writes met the lock: dropped, as a failed stats write
      // is (only logged)
      chats = db.query<{ id: number }, []>('SELECT id FROM chats').all().map((r) => r.id)
      db.run('ROLLBACK')
      for (const v of ['dhold2', 'dhold3']) bot.release(v, 'dl')
      await bot.until(() => bot.videos().length === 3)
    } finally {
      if (db.inTransaction) db.run('ROLLBACK')
      db.close()
      for (const v of ['dhold2', 'dhold3']) bot.release(v, 'dl')
      jobs = await bot.stop()
      rmSync(data, { recursive: true, force: true })
    }
    expect(took).toBeLessThan(10_000)
    expect(chats).toEqual([1])
    // and both went out as usual, neither hearing it failed (chats and
    // flags only: a failing toEqual on the calls would print an upload's
    // every byte)
    expect(bot.videos().map((v) => [v.chat, v.upload]).sort()).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ])
    for (const chat of [2, 3]) expect(bot.statuses(chat).map((s) => s[0])).toEqual(['⏬', '⏫'])
    expect(jobs.map((l) => l.split(' ', 2)[1])).toEqual(['ok', 'ok', 'ok'])
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
      // the first link's download goes on only once the test lets it
      bot.link(1, 'dholdlong1')
      await bot.until(() => bot.held('dholdlong1', 'dl'))
      // the same video under another link (a share link has its own query):
      // not cached yet, it waits for the long slot, 2 s at least
      bot.link(2, 'dholdlong1&si=share')
      await bot.until(() => bot.statuses(2).some((s) => s.startsWith('⏳')))
      await Bun.sleep(2000)
      bot.release('dholdlong1', 'dl')
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
    let others: string[][] = []
    const held = ['jholdshort1', 'jholdshort3']
    try {
      // two users' links take both -J turns, held until the test lets them go...
      bot.link(1, 'jholdshort1')
      bot.link(3, 'jholdshort3')
      await bot.until(() => held.every((v) => bot.held(v, 'J')))
      // ...and a third user's link waits for one
      bot.link(2, 'short2')
      // it hears so while both -J runs still hold their turns, before any slot is taken
      await bot.until(() => bot.statuses(2).length > 0)
      others = [bot.statuses(1), bot.statuses(3)]
      // it waits 2 s at least, then the -J runs go on
      await Bun.sleep(2000)
      for (const v of held) bot.release(v, 'J')
      await bot.until(() => bot.videos().length === 3)
    } finally {
      jobs = await bot.stop()
    }
    expect(others).toEqual([[], []])
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
    const deleted = (chat: number) => bot.calls.filter((c) => c.chat === chat && c.method === 'deleteMessage')
    const held = ['jholdshort1', 'jholdshort3']
    try {
      // two users' links take both -J turns, held until the test lets them go...
      bot.link(1, 'jholdshort1')
      bot.link(3, 'jholdshort3')
      await bot.until(() => held.every((v) => bot.held(v, 'J')))
      // ...a third user's tweet waits for one, and a fourth user asks for it too
      bot.link(2, 'tweet2')
      await bot.until(() => bot.statuses(2).length > 0)
      bot.link(4, 'tweet2')
      await bot.until(() => bot.statuses(4).length > 0)
      for (const v of held) bot.release(v, 'J')
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
      await bot.until(() => bot.held('dholdshort1', 'dl') && bot.reply(1).length > 0)
      // the cut comes while it downloads, the download ends after it
      await bot.term()
      bot.release('dholdshort1', 'dl')
    } finally {
      jobs = await bot.stop()
    }
    // the cut doesn't tell a guest reply, its job's end does, with nothing
    // uploaded to the storage chat
    expect(bot.reply(1).map((s) => [...s][0])).toEqual(['⏬', '⏫', '🔄'])
    expect(bot.videos()).toHaveLength(0)
    expect(jobs.filter((l) => /^job fail:restarting .* dl=/.test(l))).toHaveLength(1)
  },
  30_000,
)

test.skipIf(skip)(
  'bot: a cached link whose file_id is dead is downloaded again, and the dead file_id is forgotten under every key',
  async () => {
    // short3's copy is gone from Telegram's servers (the fake Bot API answers
    // its file_id with a 400). It's cached as the bot caches a video: under
    // the link it was asked for and its id, and under another link to it that
    // went out from there. That link's row has another url, as a refresh's
    // swap leaves it: forget goes by the file_id alone. Its one try forgets
    // every row with it (forget): the job doesn't try it again under the id,
    // and the other link loses its row.
    // A copy of it that isn't dead, uploaded on its own, stays under a link
    // nobody sends: forget takes the dead file_id's rows alone. The download
    // caches the new copy under the link and the id (put), so their rows
    // alone can't show the forget.
    const data = mkdtempSync(join(tmpdir(), 'bot-e2e-data-'))
    const link = (v: string) => `https://www.youtube.com/watch?v=${v}`
    const db = new Database(join(data, 'bot.sqlite'))
    db.run('CREATE TABLE files (key TEXT PRIMARY KEY, kind TEXT NOT NULL, file_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL)')
    for (const key of [link('short3'), 'Youtube:short3'])
      db.run("INSERT INTO files VALUES (?, 'video', 'dead3', 'Video', ?)", [key, link('short3')])
    db.run("INSERT INTO files VALUES (?, 'video', 'dead3', 'Video', 'https://youtu.be/short3')", [link('short3&t=1')])
    db.run("INSERT INTO files VALUES (?, 'video', 'cached3', 'Video', ?)", [link('short3&t=2'), link('short3')])
    db.close()
    const bot = start({ DATA_DIR: data })
    // a request is over once its status is gone, or says it failed
    const over = (chat: number) =>
      bot.calls.some((c) => c.chat === chat && c.method === 'deleteMessage') ||
      bot.statuses(chat).includes(t('en', 'failed'))
    let jobs: string[] = []
    let cached: Record<string, string> = {}
    try {
      bot.link(3, 'short3')
      await bot.until(() => over(3))
    } finally {
      jobs = await bot.stop()
      const db = new Database(join(data, 'bot.sqlite'))
      const rows = db.query<{ key: string; file_id: string }, []>('SELECT key, file_id FROM files').all()
      cached = Object.fromEntries(rows.map((r) => [r.key, r.file_id]))
      db.close()
      rmSync(data, { recursive: true, force: true })
    }
    // the dead file_id's one try, then the download's upload, and no failure
    // heard (chats and flags only: a failing toEqual on the calls would print
    // an upload's every byte)
    expect(bot.videos().map((v) => [v.chat, v.upload])).toEqual([
      [3, false],
      [3, true],
    ])
    expect(bot.statuses(3).map((s) => [...s][0])).toEqual(['⏬', '⏫'])
    expect(jobs.map((l) => l.split(' ', 2)[1])).toEqual(['ok'])
    // the new copy under the link and the id, the other link's row gone and
    // the live copy's left
    expect(cached['Youtube:short3']).toMatch(/^v\d+$/)
    expect(cached[link('short3')]).toBe(cached['Youtube:short3'])
    expect(cached[link('short3&t=1')]).toBeUndefined()
    expect(cached[link('short3&t=2')]).toBe('cached3')
  },
  30_000,
)

test.skipIf(skip)(
  "bot: on a deploy, the drain waits for a guest reply's notice to send the link again while it's on its way",
  async () => {
    // the notice waits until the test lets it go
    const notice = gate()
    const bot = start({ ...DEPLOY, STORAGE_CHAT: '9' }, (c) => (c.inline && c.text?.startsWith('🔄') ? notice : 0))
    try {
      bot.guest(1, 'dholdshort1')
      await bot.until(() => bot.held('dholdshort1', 'dl') && bot.reply(1).length > 0)
      await bot.term()
      bot.release('dholdshort1', 'dl')
      await bot.until(() => bot.reply(1).some((s) => s.startsWith('🔄')))
      // its handler waits for the notice, and the drain (600 s) for the
      // handler: the bot is still up a second later (one whose handler
      // didn't wait would have exited by then)
      await Bun.sleep(1000)
      expect(bot.running()).toBe(true)
    } finally {
      notice.open()
      await bot.stop()
    }
    expect(bot.reply(1).map((s) => [...s][0])).toEqual(['⏬', '⏫', '🔄'])
  },
  30_000,
)

// The cache's statements meet another process's lock on bot.sqlite (a
// deploy's old container finishing its jobs) and fail at once: past the
// start busy_timeout is 0. The tests below hold the lock from the test
// process, BEGIN IMMEDIATE for the write lock and BEGIN EXCLUSIVE for the one
// a commit takes, which keeps readers out too, and take it once the bot is up
// (its start would wait for it, then stop). Each keeps it while the bot's
// drain lets the handlers finish. locked() opens the database with seed in
// the cache, each row a key, its file_id and the video's link; its own lock
// waits for the bot's writes. It creates both tables the tests read once the
// bot is gone (files, sized): a bot that never came up then fails its test
// with what went wrong, where a read of sized would throw in the cleanup.
function locked(data: string, seed: [key: string, file: string, url: string][] = []) {
  const db = new Database(join(data, 'bot.sqlite'))
  db.run('CREATE TABLE files (key TEXT PRIMARY KEY, kind TEXT NOT NULL, file_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL)')
  db.run('CREATE TABLE sized (file_id TEXT PRIMARY KEY)')
  for (const row of seed) db.run("INSERT INTO files VALUES (?1, 'video', ?2, 'Video', ?3)", row)
  db.run('PRAGMA busy_timeout = 10000')
  return db
}

test.skipIf(skip)(
  "bot: another process holding the database's write lock as a job uploads costs neither its chat nor a request following the job the video",
  async () => {
    // The job's cache writes once its file is out (settle, put) meet the
    // lock: each is logged, and the job still returns its file. Thrown, they
    // failed the job: its chat heard so next to its video, and the request
    // following it got none.
    const data = mkdtempSync(join(tmpdir(), 'bot-e2e-data-'))
    const db = locked(data)
    const bot = start({ DATA_DIR: data })
    // a request is over once its status is gone, or says it failed
    const over = (chat: number) =>
      bot.calls.some((c) => c.chat === chat && c.method === 'deleteMessage') ||
      bot.statuses(chat).includes(t('en', 'failed'))
    let jobs: string[] = []
    let rows = -1
    try {
      // the download is held, and another request follows its job
      bot.link(1, 'dholdshort1')
      await bot.until(() => bot.held('dholdshort1', 'dl'))
      bot.link(2, 'dholdshort1')
      await bot.until(() => bot.statuses(2).length > 0)
      db.run('BEGIN IMMEDIATE')
      bot.release('dholdshort1', 'dl')
      await bot.until(() => over(1) && over(2))
    } finally {
      bot.release('dholdshort1', 'dl')
      jobs = await bot.stop()
      if (db.inTransaction) db.run('ROLLBACK')
      rows = db.query<{ n: number }, []>('SELECT (SELECT count(*) FROM files) + (SELECT count(*) FROM sized) AS n').get()!.n
      db.close()
      rmSync(data, { recursive: true, force: true })
    }
    // the job's upload and the follower's copy of it, and neither chat heard
    // it failed (chats and flags only: a failing toEqual on the calls would
    // print an upload's every byte)
    expect(bot.videos().map((v) => [v.chat, v.upload])).toEqual([
      [1, true],
      [2, false],
    ])
    for (const chat of [1, 2]) expect(bot.statuses(chat).map((s) => [...s][0])).toEqual(['⏬', '⏫'])
    expect(jobs.map((l) => l.split(' ', 2)[1])).toEqual(['ok'])
    // every write met the lock: nothing is cached, nor sized
    expect(rows).toBe(0)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: another process holding the database's write lock costs no cached link its video: one sent without a size, another link to one, one whose file_id is dead",
  async () => {
    // short1's copy went out before videos had their size (#281), and the
    // fake Bot API resends it without one: its one refresh is recorded
    // (settle). short2 is cached under its id alone: a link to it that isn't
    // cached goes out from there, and is cached under that link (put).
    // short3's file_id is gone from Telegram: it's forgotten (forget), and
    // the link downloaded again. Each write meets the lock: it's logged, the
    // refresh waits for another time and the rows stay as they were. Thrown,
    // each failed its request: short1's and short2's next to their video,
    // short3's without one.
    const data = mkdtempSync(join(tmpdir(), 'bot-e2e-data-'))
    const link = (v: string) => `https://www.youtube.com/watch?v=${v}`
    const db = locked(data, [
      [link('short1'), 'unsized1', link('short1')],
      ['Youtube:short2', 'cached2', link('short2')],
      [link('short3'), 'dead3', link('short3')],
    ])
    const bot = start({ DATA_DIR: data })
    const over = (chat: number) =>
      bot.calls.some((c) => c.chat === chat && c.method === 'deleteMessage') ||
      bot.statuses(chat).includes(t('en', 'failed'))
    const sent = (chat: number) => bot.videos().filter((v) => v.chat === chat).map((v) => v.upload)
    let jobs: string[] = []
    let cached: Record<string, string> = {}
    let sized: string[] = []
    try {
      // up, and done writing: a first link's video is out
      bot.link(9, 'short9')
      await bot.until(() => over(9))
      db.run('BEGIN IMMEDIATE')
      bot.link(1, 'short1')
      bot.link(2, 'short2&t=1')
      bot.link(3, 'short3')
      await bot.until(() => sent(1).length === 1 && sent(2).length === 1 && over(3))
    } finally {
      // whatever a request was going to say is in once the drain is over
      jobs = await bot.stop()
      if (db.inTransaction) db.run('ROLLBACK')
      const rows = db.query<{ key: string; file_id: string }, []>('SELECT key, file_id FROM files').all()
      cached = Object.fromEntries(rows.map((r) => [r.key, r.file_id]))
      sized = db.query<{ file_id: string }, []>('SELECT file_id FROM sized').all().map((r) => r.file_id)
      db.close()
      rmSync(data, { recursive: true, force: true })
    }
    // short1 and short2 from the cache, short3 downloaded again after its
    // dead file_id's try, and none heard it failed (the first two show no
    // status at all)
    expect([sent(1), sent(2), sent(3)]).toEqual([[false], [false], [false, true]])
    expect([bot.statuses(1), bot.statuses(2)]).toEqual([[], []])
    expect(bot.statuses(3).map((s) => [...s][0])).toEqual(['⏬', '⏫'])
    // short1 isn't refreshed: the jobs are short9's, short2's (from the
    // cache) and short3's
    expect(jobs.map((l) => l.split(' ', 2)[1]).sort()).toEqual(['cached', 'ok', 'ok'])
    // and the writes met the lock: short1 isn't sized, short2's link isn't
    // cached and short3's dead row is still there
    expect(sized).not.toContain('unsized1')
    expect(cached[link('short2&t=1')]).toBeUndefined()
    expect(cached[link('short3')]).toBe('dead3')
  },
  30_000,
)

test.skipIf(skip)(
  "bot: a refresh of an unsized video that uploads while another process holds the database's write lock still takes the old copy's place",
  async () => {
    // short1's copy went out before videos had their size, and its refresh's
    // download is held until the lock is taken: the writes once the new copy
    // is out (settle, put, then swap) meet the lock and are logged, and the
    // old copy's message goes. Thrown, they failed the refresh: the chat kept
    // both copies.
    const data = mkdtempSync(join(tmpdir(), 'bot-e2e-data-'))
    const link = (v: string) => `https://www.youtube.com/watch?v=${v}`
    const db = locked(data, [
      [link('dholdshort1'), 'unsized1', link('dholdshort1')],
      ['Youtube:dholdshort1', 'unsized1', link('dholdshort1')],
    ])
    const bot = start({ DATA_DIR: data })
    let jobs: string[] = []
    let cached: string[] = []
    try {
      bot.link(1, 'dholdshort1')
      await bot.until(() => bot.held('dholdshort1', 'dl'))
      db.run('BEGIN IMMEDIATE')
      bot.release('dholdshort1', 'dl')
      await bot.until(() => bot.calls.some((c) => c.method === 'deleteMessage'))
    } finally {
      bot.release('dholdshort1', 'dl')
      jobs = await bot.stop()
      if (db.inTransaction) db.run('ROLLBACK')
      cached = db.query<{ file_id: string }, []>('SELECT file_id FROM files').all().map((r) => r.file_id)
      db.close()
      rmSync(data, { recursive: true, force: true })
    }
    // the old copy, then the new one, and the old one's message deleted
    expect(bot.videos().map((v) => [v.chat, v.upload])).toEqual([
      [1, false],
      [1, true],
    ])
    expect(bot.calls.filter((c) => c.method === 'deleteMessage').map((c) => c.chat)).toEqual([1])
    expect(bot.statuses(1)).toEqual([])
    expect(jobs.map((l) => l.split(' ', 2)[1])).toEqual(['ok'])
    // every link keeps the old copy: the new one couldn't be written
    expect(cached).toEqual(['unsized1', 'unsized1'])
  },
  30_000,
)

test.skipIf(skip)(
  "bot: a cached link whose row can't be read while another process commits is downloaded again, not failed",
  async () => {
    // A commit holds the lock that keeps readers out (BEGIN EXCLUSIVE here
    // holds it all along): every read of the cache fails at once, and is a
    // miss. Thrown, the first one failed the request before anything went
    // out, here a guest reply's, whose video is uploaded to the storage chat
    // and edited into the reply.
    const data = mkdtempSync(join(tmpdir(), 'bot-e2e-data-'))
    const link = (v: string) => `https://www.youtube.com/watch?v=${v}`
    const db = locked(data, [
      [link('short1'), 'cached1', link('short1')],
      ['Youtube:short1', 'cached1', link('short1')],
    ])
    const bot = start({ DATA_DIR: data, STORAGE_CHAT: '9' })
    let jobs: string[] = []
    try {
      // up, and done writing: a first link's video is out
      bot.link(8, 'short8')
      await bot.until(() => bot.calls.some((c) => c.chat === 8 && c.method === 'deleteMessage'))
      db.run('BEGIN EXCLUSIVE')
      bot.guest(1, 'short1')
      // its video is edited into the guest reply, or the reply says it failed
      await bot.until(() => bot.reply(1).includes('video') || bot.reply(1).includes(t('en', 'failed')))
    } finally {
      jobs = await bot.stop()
      if (db.inTransaction) db.run('ROLLBACK')
      db.close()
      rmSync(data, { recursive: true, force: true })
    }
    // uploaded to the storage chat again rather than sent from the cache,
    // and edited into the reply after the usual statuses
    expect(bot.videos().map((v) => [v.chat, v.upload])).toEqual([
      [8, true],
      [9, true],
    ])
    expect(bot.calls.filter((c) => c.method === 'editMessageMedia')).toHaveLength(1)
    expect(bot.reply(1)).toEqual([t('en', 'downloading'), t('en', 'uploading'), 'video'])
    expect(jobs.map((l) => l.split(' ', 2)[1])).toEqual(['ok', 'ok'])
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
    // A minute is 1 s, so the files are weighed every 83 ms and a long
    // video's job has 45 s (no time limit to race); test/yt-dlp's waits are
    // halved, and a stopped run gets 10 minutes, so it's over only as its
    // processes end. dholdlong1 holds the long slot until two minutes after
    // endlessstream2 is in line for it, by when endlessstream2's saved info
    // is stale, so a failed download of it would read the page again. Its
    // file passes 2000 MB 0.25 s in at the earliest, and its yt-dlp would go
    // on until the test is over, with a child that holds its output: the
    // stop's SIGTERM ends them. It leaves a process in its group that ignores
    // that SIGTERM (the file passes 2000 MB only once that process is up),
    // doesn't hold its output and lives until the test is over: it gets the
    // SIGKILL as the run ends. parts3 has a merge on disk, each file 2000 MB
    // at most and 4000 MB together, and goes out.
    const dir = mkdtempSync(join(tmpdir(), 'bot-e2e-linger-'))
    const log = () => readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8'))
    const bot = start({ MINUTE_MS: '1000', GRACE_MS: '600000', FAKE_SCALE: '0.5', LINGER: dir })
    let jobs: string[] = []
    let lingered: string[] = []
    let gone = false
    try {
      bot.link(1, 'dholdlong1')
      await bot.until(() => bot.held('dholdlong1', 'dl'))
      bot.link(2, 'endlessstream2')
      bot.link(3, 'parts3')
      await bot.until(() => bot.statuses(2).some((s) => s.startsWith('⏳')))
      await Bun.sleep(2000)
      bot.release('dholdlong1', 'dl')
      await bot.until(() => bot.videos().length === 2 && bot.statuses(2).some((s) => s.startsWith('😱')))
      // the lingering process (its log, there before the stop, is named
      // <link>.<its pid>) is gone within a second of the run's end
      const [name] = readdirSync(dir)
      const pid = name ? Number(name.split('.').pop()) : 0
      for (let i = 0; i < 20 && pid && alive(pid); i++) await Bun.sleep(50)
      gone = pid > 0 && !alive(pid)
      lingered = log()
    } finally {
      jobs = await bot.stop()
      rmSync(dir, { recursive: true, force: true })
    }
    expect(lingered).toEqual(['up\n'])
    expect(gone).toBe(true)
    expect(bot.videos().map((v) => v.chat).sort()).toEqual([1, 3])
    expect(bot.statuses(2).map((s) => [...s][0])).toEqual(['⏳', '⏬', '😱'])
    expect(bot.statuses(2).at(-1)).toBe(t('en', 'tooBig'))
    expect(jobs).toHaveLength(3)
    expect(jobs.filter((l) => l.startsWith('job ok '))).toHaveLength(2)
    const line = jobs.find((l) => l.startsWith('job fail:tooBig '))!
    expect(line).toMatch(/^job fail:tooBig host=www\.youtube\.com .*lane=long ahead=0 own=0 dur=\? wait=\d+\.\d dl=\d+\.\d mb=2001 total=/)
    expect(line).not.toContain('reread=')
    // stopped once the file was too large: over as yt-dlp and its child
    // ended, with no grace time to wait out
    expect(Number(/ dl=([\d.]+)/.exec(line)![1])).toBeGreaterThanOrEqual(0.25)
  },
  // its three waits and its 2 s pause come one after another, 57 s at most
  // by their budgets (the first wait's is 25 s: until() counts its 15 s
  // from when the bot is up): a timeout of the last must still end, with
  // its report, before the test's own timeout does
  60_000,
)

test.skipIf(skip)(
  'bot: the time limit also stops a child of yt-dlp that holds its output, as ffmpeg does, and frees the slot',
  async () => {
    // half time: a short video's job has 3.75 s, and the child would keep
    // yt-dlp's stdout and stderr open until the test is over; the second
    // one's child ignores SIGTERM: its job ends 2.5 s later all the same, and
    // the child must take the SIGKILL then, rather than go on. The two hold
    // both slots, so another link of the first one's user waits for theirs
    // (one user's jobs get one of two slots). The first one's "Downloading…"
    // takes until that link is in line, and its download, with its time
    // limit, begins only after it
    const dir = mkdtempSync(join(tmpdir(), 'bot-e2e-stubborn-'))
    const go = gate()
    const bot = start({ ...HALF, LINGER: dir }, (c) => (c.chat === 1 && c.text?.startsWith('⏬') ? go : 0))
    let jobs: string[] = []
    let stubborn = 0
    let survived = true
    try {
      bot.link(1, 'ffmpeg1')
      bot.link(2, 'stubbornffmpeg1')
      await bot.until(() => [1, 2].every((chat) => bot.statuses(chat).some((s) => s.startsWith('⏬'))))
      bot.link(1, 'next1')
      await bot.until(() => bot.statuses(1).some((s) => s.startsWith('⏳')))
      go.open()
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
    expect(bot.videos().map((v) => v.chat)).toEqual([1])
    expect(bot.statuses(2).map((s) => [...s][0])).toEqual(['⏬', '😱'])
    // the first one's status and then the next one's (queued) in its chat;
    // the first one fails as the next one, which then has its slot, downloads
    const one = bot.statuses(1).map((s) => [...s][0])
    expect(one.slice(0, 2)).toEqual(['⏬', '⏳'])
    expect(one.slice(2, 4).sort()).toEqual(['⏬', '😱'].sort())
    expect(one.slice(4)).toEqual(['⏫'])
    expect(jobs).toHaveLength(3)
    const timeouts = jobs.filter((l) => l.startsWith('job timeout '))
    expect(timeouts).toHaveLength(2)
    for (const line of timeouts)
      expect(line).toMatch(/^job timeout host=www\.youtube\.com .*lane=short .* dl=\d+\.\d mb=2 total=/)
    const [term, kill] = timeouts.map((l) => Number(/ dl=([\d.]+)/.exec(l)![1])).sort((a, b) => a - b)
    // the first at its time limit, the second after the grace too, and no
    // later: neither child ends by itself, so the first job ends at its
    // SIGTERM and the second at the end of its grace, both the bot's own
    // timers (that a run whose processes all end at the SIGTERM is over then,
    // not after the grace, is the next test's, where a stopped run has 10
    // minutes)
    expect(term).toBeGreaterThanOrEqual(3.75)
    expect(kill).toBeGreaterThanOrEqual(6.25)
    expect(kill).toBeLessThan(9)
    // the next one got its user's slot when the first one hit its time
    // limit: it was in line before that one began downloading, waited for
    // all of its download, and then only for the bot's own few steps (not a
    // grace's 2.5 s more)
    const next = jobs.find((l) => l.startsWith('job ok '))!
    expect(next).toMatch(/^job ok host=www\.youtube\.com .*lane=short ahead=0 own=1 /)
    const wait = Number(/ wait=([\d.]+)/.exec(next)![1])
    expect(wait).toBeGreaterThanOrEqual(term)
    expect(wait).toBeLessThan(term + 1.5)
  },
  // its three waits come one after another, 25 s (until() counts the first
  // one's 15 s from when the bot is up), 15 s and then 25 s at most by their
  // budgets: a timeout of the last must still end, with its report, before
  // the test's own timeout does
  70_000,
)

test.skipIf(skip)(
  'bot: a timed-out run is over as yt-dlp and its child end, and leaves nothing in its group',
  async () => {
    // half time: a short video's job has 3.75 s, but a stopped run gets 10
    // minutes, so it's over only as its processes end. ffmpegdeaflinger1's
    // child holds yt-dlp's output and never ends by itself: the time limit's
    // SIGTERM ends it, and yt-dlp. The process it left in yt-dlp's group
    // ignores SIGTERM, doesn't hold the output and never ends by itself
    // either: it gets the SIGKILL as the run ends
    const dir = mkdtempSync(join(tmpdir(), 'bot-e2e-deaf-'))
    const bot = start({ ...HALF, GRACE_MS: '600000', LINGER: dir })
    let jobs: string[] = []
    let log: string[] = []
    let gone = false
    try {
      bot.link(1, 'ffmpegdeaflinger1')
      await bot.until(() => bot.statuses(1).some((s) => s.startsWith('😱')), 25_000)
      // the lingering process (its log is named <link>.<its pid>) is gone
      // within a second of the run's end
      expect(readdirSync(dir)).toHaveLength(1)
      const pid = Number(readdirSync(dir)[0]!.split('.').pop())
      for (let i = 0; i < 20 && alive(pid); i++) await Bun.sleep(50)
      gone = !alive(pid)
      log = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8'))
    } finally {
      jobs = await bot.stop()
      rmSync(dir, { recursive: true, force: true })
    }
    expect(gone).toBe(true)
    expect(log).toEqual(['up\n'])
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatch(/^job timeout host=www\.youtube\.com .*lane=short .* dl=\d+\.\d mb=2 total=/)
    // at the time limit
    expect(Number(/ dl=([\d.]+)/.exec(jobs[0]!)![1])).toBeGreaterThanOrEqual(3.75)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: a pipe holder that left a timed-out run's group doesn't keep the job",
  async () => {
    // half time: a short video's job has 3.75 s, and a stopped run gets 2.5
    // s. escapeffmpeg1's child holds yt-dlp's output from a session of its
    // own, which the signals don't reach, and never ends by itself: its job
    // ends 2.5 s after the SIGTERM all the same
    const bot = start(HALF)
    let jobs: string[] = []
    try {
      bot.link(1, 'escapeffmpeg1')
      await bot.until(() => bot.statuses(1).some((s) => s.startsWith('😱')), 25_000)
    } finally {
      jobs = await bot.stop()
    }
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatch(/^job timeout host=www\.youtube\.com .*lane=short .* dl=\d+\.\d mb=2 total=/)
    // after the time limit and the grace, and no later: both are the bot's
    // own timers
    const dl = Number(/ dl=([\d.]+)/.exec(jobs[0]!)![1])
    expect(dl).toBeGreaterThanOrEqual(6.25)
    expect(dl).toBeLessThan(9)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: a download stopped as too large is over the grace time after the stop, even if a pipe holder left yt-dlp's group",
  async () => {
    // A minute is 1 s, so the files are weighed every 83 ms and a short
    // video's job has 30 s (no time limit to race); test/yt-dlp's waits are
    // halved, and a stopped run gets 2.5 s. escapeendless1's file passes 2000
    // MB 0.25 s in, and its child holds yt-dlp's output from a session of its
    // own and never ends by itself: the job ends 2.5 s after that stop all
    // the same
    const bot = start({ ...HALF, MINUTE_MS: '1000' })
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
    // the stop, then the grace (the pipe holder would keep it until the test is over)
    expect(Number(/ dl=([\d.]+)/.exec(jobs[0]!)![1])).toBeGreaterThanOrEqual(2.75)
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
      // past both signals' times, or 20 s at most, by the clock: a count of
      // sleeps stretches with the load and could run into the test's own
      // timeout, which would hide what the logs say
      const end = performance.now() + 20_000
      while (performance.now() < end && !(logs().length >= 2 && logs().every(([, l]) => /TERM|done/.test(l))))
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
  // its wait may take 25 s (until() counts its 15 s from when the bot is up)
  // and then the loop 20 s, and what the logs say must still come out before
  // the test's own timeout does
  50_000,
)

test.skipIf(skip)(
  "bot: a long video's download goes on past the time a short one gets",
  async () => {
    // half time: 3.75 s for a short video, 5.6 s for a long one. crawl1
    // takes 4.5 s, and dholdlong2 never ends by itself (the test doesn't let
    // it go): each is stopped at its own time limit
    const bot = start(HALF)
    let jobs: string[] = []
    try {
      bot.link(1, 'crawl1')
      bot.link(2, 'dholdlong2')
      await bot.until(() => [1, 2].every((chat) => bot.statuses(chat).some((s) => s.startsWith('😱'))), 25_000)
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.videos()).toHaveLength(0)
    for (const chat of [1, 2]) expect(bot.statuses(chat).map((s) => [...s][0])).toEqual(['⏬', '😱'])
    expect(jobs).toHaveLength(2)
    const dl = (line: string) => Number(/ dl=([\d.]+)/.exec(line)![1])
    // the short one is stopped at its 3.75 s, with the 2 MB it had...
    const short = jobs.find((l) => l.includes(' lane=short '))!
    expect(short).toMatch(/^job timeout host=www\.youtube\.com .* dl=\d+\.\d mb=2 total=/)
    expect(dl(short)).toBeGreaterThanOrEqual(3.75)
    expect(dl(short)).toBeLessThan(5.5)
    // ...while the long one downloads on, until its own 5.6 s
    const long = jobs.find((l) => l.includes(' lane=long '))!
    expect(long).toMatch(/^job timeout host=www\.youtube\.com /)
    expect(dl(long)).toBeGreaterThanOrEqual(5.6)
  },
  40_000,
)

test.skipIf(skip)(
  'bot: a page read again gets only the time the job has left',
  async () => {
    // A minute is 250 ms, so a long video's job has 11.25 s, and
    // "Downloading…" takes 500 ms to show, by when the saved info of
    // slowexpiredreholdlong1 is stale. At half the fake's times, its download
    // from that info fails after 2 s, then the page is read again (1.5 s,
    // "slow") and downloaded from: a download that never ends by itself
    // ("rehold"), so only the job's time limit stops it, however long the
    // yt-dlp runs took to start. Those start-ups only have to leave the page
    // read again time to answer in the 9.25 s left (a minute of 125 ms left
    // 2.1 s, which two start-ups on a loaded machine took up, #458)
    const bot = start({ MINUTE_MS: '250', FAKE_SCALE: '0.5' }, (c) => (c.text?.startsWith('⏬') ? 500 : 0))
    let jobs: string[] = []
    try {
      bot.link(1, 'slowexpiredreholdlong1')
      await bot.until(() => bot.statuses(1).some((s) => s.startsWith('😱')), 30_000)
    } finally {
      jobs = await bot.stop()
    }
    expect(bot.videos()).toHaveLength(0)
    expect(jobs).toHaveLength(1)
    const line = jobs[0]!
    // the same pick, though the try from saved info got nothing
    expect(line).toMatch(/^job timeout host=www\.youtube\.com .*lane=long .* reread=1 kept=0 dl=\d+\.\d mb=0 total=/)
    // the job's 11.25 s in all: not 2 s and then another 11.25 s, nor the
    // read's 1.5 s on top (the download from it given all the time that was
    // left before the read)
    const dl = Number(/ dl=([\d.]+)/.exec(line)![1])
    expect(dl).toBeGreaterThanOrEqual(11.2)
    expect(dl).toBeLessThan(12.75)
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
    // cutswapmulti1's picks another. Each has a slot of its own: in turns of
    // two, the six would take three rounds of runs
    const pages = mkdtempSync(join(tmpdir(), 'bot-e2e-pages-'))
    const bot = start({ MINUTE_MS: '250', PAGES: pages, MAX_DOWNLOADS: '6' }, (c) => (c.text?.startsWith('⏬') ? 500 : 0))
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
    // a video's 5 MB are FAKE_MP4 (so its thumbnail works), then its
    // format's letter: one run of it, with none of another format's
    const sent = (chat: number) => {
      const file = bot.videos().find((c) => c.chat === chat)!.file!
      return [bot.mp4.equals(file.subarray(0, bot.mp4.length)), runs(file.subarray(bot.mp4.length))]
    }
    expect(links.map((_, i) => sent(i + 1))).toEqual(
      ['a', 'b', 'a', 'b', 'a', 'b'].map((x) => [true, [[x, 5 * 2 ** 20 - bot.mp4.length]]]),
    )
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
    // new1's download, not old1's format (5 MB: FAKE_MP4, then "a")
    expect(bot.mp4.equals(sent.file!)).toBe(true)
    expect(jobs).toHaveLength(5)
    expect(jobs.filter((l) => /^job ok host=www\.youtube\.com .*lane=short .* reread=1 dropped=3 other=1 dl=\d+\.\d mb=0 up=/.test(l))).toHaveLength(1)
    expect(jobs.filter((l) => /^job cached host=www\.youtube\.com .*lane=short .* reread=1 dropped=3 other=1 dl=\d+\.\d total=/.test(l))).toHaveLength(1)
    // new1's own link, before any slot
    expect(jobs.filter((l) => /^job cached host=www\.youtube\.com metaq=\S+ meta=\S+ total=/.test(l))).toHaveLength(1)
    expect(jobs.filter((l) => /^job ok host=www\.youtube\.com .*lane=short .* dur=30 wait=\S+ dl=/.test(l))).toHaveLength(2)
  },
  // its four waits come one after another, and under load the last one has
  // begun almost 15 s in: a timeout of it must still end, with its report,
  // before the test's own timeout does
  45_000,
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
    // new1's download, not old1's format (5 MB: FAKE_MP4, then "a")
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
    // for a slot behind the same user's long1, whose download goes on only
    // once the refresh's -J info is stale, so the refresh's download fails 3
    // MB in, and the page read again picks new1. old3's page still shows old3.
    // old3's copy is cached under two other links to it too, which nobody
    // sends: the new copy gets there only by the swap, as the job caches it
    // under the link it was asked for and the id (put). Those two rows have
    // another url: a row keeps the url its copy went out with, and old3's
    // went out when its link read differently, so the swap can't go by the
    // new copy's url.
    const pages = mkdtempSync(join(tmpdir(), 'bot-e2e-pages-'))
    const data = mkdtempSync(join(tmpdir(), 'bot-e2e-data-'))
    const link = (v: string) => `https://www.youtube.com/watch?v=${v}`
    const db = new Database(join(data, 'bot.sqlite'))
    db.run('CREATE TABLE files (key TEXT PRIMARY KEY, kind TEXT NOT NULL, file_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL)')
    for (const [n, v] of [[1, 'old1&cut&next=new1'], [2, 'old2&next=new2'], [3, 'old3']] as const)
      for (const key of [link(v), `Youtube:old${n}`])
        db.run("INSERT INTO files VALUES (?, 'video', ?, 'Video', ?)", [key, `unsized${n}`, link(v)])
    for (const key of [link('old3&t=1'), link('old3&t=2')])
      db.run("INSERT INTO files VALUES (?, 'video', 'unsized3', 'Video', 'https://youtu.be/old3')", [key])
    db.close()
    writeFileSync(join(pages, 'old2'), 'read\n')
    const bot = start({ MINUTE_MS: '250', PAGES: pages, DATA_DIR: data })
    let jobs: string[] = []
    let cached: Record<string, string> = {}
    try {
      bot.link(2, 'old2&next=new2')
      bot.link(3, 'old3')
      bot.link(1, 'dholdlong1')
      await bot.until(() => bot.held('dholdlong1', 'dl'))
      bot.link(1, 'old1&cut&next=new1')
      // Once old1's refresh has read the page, short1's -J runs only after the
      // refresh's (one user gets one of two -J turns), and short1 then waits
      // for the user's slot behind the refresh: by short1's upload the
      // refresh is over. short1's -J is held, so once it runs the refresh's
      // -J is over: two minutes later that info is stale, and long1's
      // download goes on
      await bot.until(() => existsSync(join(pages, 'old1')))
      bot.link(1, 'jholdshort1')
      await bot.until(() => bot.held('jholdshort1', 'J'))
      await Bun.sleep(500)
      bot.release('jholdshort1', 'J')
      bot.release('dholdlong1', 'dl')
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
    for (const key of [link('old3&t=1'), link('old3&t=2')]) expect(cached[key]).toBe(cached['Youtube:old3'])
    expect(jobs).toHaveLength(5)
    expect(jobs.filter((l) => /^job fail:quiet host=www\.youtube\.com .*lane=short .* reread=1 dropped=3 other=1 dl=\d+\.\d mb=0 total=/.test(l))).toHaveLength(1)
    expect(jobs.filter((l) => /^job fail:quiet host=www\.youtube\.com metaq=\S+ meta=\S+ total=/.test(l))).toHaveLength(1)
    expect(jobs.filter((l) => /^job ok host=www\.youtube\.com .*lane=short .* dur=30 wait=\S+ dl=/.test(l))).toHaveLength(2)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: a self-update that fails at start (GitHub's API limit) holds up neither polling nor downloads, and is tried again a minute later",
  async () => {
    // test/yt-dlp fails every self-update try and adds a line to $UPDATES for
    // it. A minute is 1 s, so the retries come 1, 3, 7, 15, 31 and 63 s after
    // the first try.
    const dir = mkdtempSync(join(tmpdir(), 'bot-e2e-updates-'))
    const updates = join(dir, 'tries')
    const tries = () => (existsSync(updates) ? readFileSync(updates, 'utf8').split('\n').filter(Boolean).length : 0)
    const bot = start({ MINUTE_MS: '1000', UPDATES: updates })
    let jobs: string[] = []
    try {
      // the link goes out without waiting for the retries...
      bot.link(1, 'short1')
      await bot.until(() => bot.videos().length === 1)
      // ...and the update is tried again
      await bot.until(() => tries() >= 2)
    } finally {
      jobs = await bot.stop()
      rmSync(dir, { recursive: true, force: true })
    }
    expect(bot.statuses(1).map((s) => s[0])).toEqual(['⏬', '⏫'])
    expect(jobs.filter((l) => l.startsWith('job ok '))).toHaveLength(1)
  },
  30_000,
)

test.skipIf(skip)(
  "bot: with promos on, another process's lock on the database costs neither a link handed a promo its video nor a /start from a campaign its help, and the bot keeps running",
  async () => {
    // Promo's stats (promo.ts) meet the lock. Held for writes (BEGIN
    // IMMEDIATE): the cap of the promo handed to b's link (decide(), before
    // handle()'s try: unhandled, the throw ended the bot), then the day's
    // seen and the arrival's use once that video is out (the chat heard it
    // failed). Held for reads too (BEGIN EXCLUSIVE, as during another
    // process's commit): c's /start, whose new-chat read and arrival failed
    // (the arrival cost the help, the read the start event). The test serves
    // the campaign at PROMO_URL; a, b and c are in its variant.
    const campaign: Campaign = {
      id: 'xp1',
      bot: 'videodownloadbot',
      status: 'running',
      target: 'https://t.me/voicybot',
      chats: ['private'],
      cap_days: 7,
      langs: ['en'],
      text: { en: 'Voice to text' },
      variants: [{ id: 'a', share: 0.9, format: 'caption' }],
    }
    const [a, b, c] = Array.from({ length: 50 }, (_, i) => 10 + i).filter((u) => arm(campaign, u)) as [number, number, number]
    let fetched = false
    const events: { c: string; v: string; k: string }[] = []
    const lumen = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname
        if (path === '/go/events') events.push(...(await req.json()).events)
        if (path !== '/go/campaigns.json') return Response.json({})
        fetched = true
        return Response.json({
          base: 'https://lumen.example/go',
          bots: { videodownloadbot: { enabled: true, code: 'vdb' } },
          campaigns: [campaign],
        })
      },
    })
    const data = mkdtempSync(join(tmpdir(), 'bot-e2e-data-'))
    const db = new Database(join(data, 'bot.sqlite'))
    // the test's own reads and its lock wait for the bot's writes
    db.run('PRAGMA busy_timeout = 10000')
    const bot = start({
      DATA_DIR: data,
      PROMO_TOKEN: 'tok',
      PROMO_URL: `http://127.0.0.1:${lumen.port}/go/campaigns.json`,
    })
    const help = t('en', 'help')
    let jobs: string[] = []
    let up = false
    try {
      await bot.until(() => fetched)
      // a's video goes out with the promo, and is cached
      bot.link(a, 'short1')
      await bot.until(() => bot.calls.some((call) => call.chat === a && call.method === 'deleteMessage'))
      // b comes from another bot's campaign
      bot.command(b, '/start bc1-b-voicy')
      await bot.until(() => bot.statuses(b).includes(help) && !!db.query('SELECT 1 FROM arrival WHERE user = ?').get(b))
      // c comes from it too, the database locked for reads. The lock goes
      // once c's help is in: arrived() runs in the same synchronous handler
      // right after help(ctx) starts that request, so it has nearly always
      // run by then (c's census write met the lock, so c's chat isn't new
      // either way)
      db.run('BEGIN EXCLUSIVE')
      bot.command(c, '/start bc1-b-voicy')
      await bot.until(() => bot.statuses(c).includes(help))
      db.run('ROLLBACK')
      // b's link, from the cache, the database locked for writes
      db.run('BEGIN IMMEDIATE')
      bot.link(b, 'short1')
      await bot.until(() => bot.videos().length === 2)
      up = bot.running()
    } finally {
      // with the lock still held: the drain waits for b's request, then
      // sends the stats
      jobs = await bot.stop()
      if (db.inTransaction) db.run('ROLLBACK')
      db.close()
      lumen.stop(true)
      rmSync(data, { recursive: true, force: true })
    }
    expect(up).toBe(true)
    // a promo whose cap can't be recorded isn't shown, as if capped (chats,
    // flags and whether the caption has it: a failing toEqual on the calls
    // would print an upload's every byte)
    expect(bot.videos().map((v) => [v.chat, v.upload, v.caption!.includes('Voice to text')])).toEqual([
      [a, true, true],
      [b, false, false],
    ])
    // nobody heard it failed, and both /starts got the help
    expect(bot.statuses(a).map((s) => s[0])).toEqual(['⏬', '⏫'])
    expect(bot.statuses(b)).toEqual([help])
    expect(bot.statuses(c)).toEqual([help])
    // the stats went all the same: seen for a and b, shown for a's promo
    // only, b's use, both /starts (and new for b's, whose chat was new; c's
    // new-chat read failed)
    expect(events.map((e) => `${e.c}:${e.v}:${e.k}`).sort()).toEqual([
      'bc1:b:new',
      'bc1:b:start',
      'bc1:b:start',
      'bc1:b:use',
      'xp1:a:seen',
      'xp1:a:seen',
      'xp1:a:shown',
    ])
    expect(jobs.map((l) => l.split(' ', 2)[1])).toEqual(['ok'])
  },
  30_000,
)
