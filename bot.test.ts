import { expect, test } from 'bun:test'
import { Api, InputFile, type Transformer } from 'grammy'
import type { Message } from 'grammy/types'
import { Database } from 'bun:sqlite'
import {
  census,
  answer,
  claims,
  Fail,
  floodWait,
  fresh,
  links,
  notVideo,
  picked,
  probe,
  progress,
  PROGRESS,
  requested,
  sender,
  shown,
  THUMB,
  unready,
  unstarted,
  urls,
  videos,
} from './bot'
import { lang, t } from './i18n'

test('urls: entities, text links, bare domains, dedupe, non-http dropped', () => {
  const text = 'look youtu.be/x and https://x.com/a/status/1 youtu.be/x ftp://a.b'
  const at = (s: string) => ({ offset: text.indexOf(s), length: s.length })
  const msg = {
    text,
    entities: [
      { type: 'url', ...at('youtu.be/x') },
      { type: 'url', ...at('https://x.com/a/status/1') },
      { type: 'url', offset: text.lastIndexOf('youtu.be/x'), length: 10 },
      { type: 'url', ...at('ftp://a.b') },
      { type: 'text_link', offset: 0, length: 4, url: 'https://vimeo.com/1' },
    ],
  } as Message
  expect(urls(msg)).toEqual([
    'https://youtu.be/x',
    'https://x.com/a/status/1',
    'https://vimeo.com/1',
  ])
})

test('urls: internal hosts dropped, numeric IPs caught after normalizing', () => {
  const links = [
    'http://127.0.0.1:8081/x.mp4',
    'http://2130706433/x.mp4',
    'http://0x7f.1/x.mp4',
    'http://[::1]/x.mp4',
    'http://videodownloadbot-api:8081/x',
    'http://videodownloadbot-api.:8081/x',
    'localhost.:3000',
    'http://127.0.0.1./x',
    'https://nas.local./x',
    'localhost:3000',
    'https://nas.local/x.mp4',
    'http://metadata.google.internal/x',
    'https://youtube.com/watch?v=1',
  ]
  const msg = {
    text: links.join(' '),
    entities: links.map((u) => ({
      type: 'text_link',
      offset: 0,
      length: 1,
      url: u,
    })),
  } as Message
  expect(urls(msg)).toEqual(['https://youtube.com/watch?v=1'])
})

test('lang: telegram codes map to the right locale', () => {
  expect(lang('pt-br')).toBe('pt-br')
  expect(lang('pt')).toBe('pt')
  expect(lang('PT-PT')).toBe('pt')
  expect(lang('zh-hans')).toBe('zh')
  expect(lang('fa')).toBe('fa')
  expect(lang('de')).toBe('en')
  expect(lang(undefined)).toBe('en')
})

test('links: replied-to links only when summoned', () => {
  const reply_to_message = {
    text: 'youtu.be/a here',
    entities: [{ type: 'url', offset: 0, length: 10 }],
  } as Message
  const ask = (text: string) => ({ text, reply_to_message }) as Message
  expect(links(ask('@VidBot please'), 'vidbot')).toEqual(['https://youtu.be/a'])
  expect(links(ask('nice video'), 'vidbot')).toEqual([])
  expect(links(ask('@vidbotx'), 'vidbot')).toEqual([])
  expect(links(ask('hey'), 'vidbot', true)).toEqual(['https://youtu.be/a'])
})

const said = (text: string) => {
  const found = [...text.matchAll(/\S+\.\S+/g)].filter((m) => !m[0].startsWith('@'))
  return {
    text,
    entities: found.map((m) => ({ type: 'url', offset: m.index, length: m[0].length })),
  } as Message
}
const youtube = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const tiktok = 'https://www.tiktok.com/@scout2015/video/6718335390845095173'
const article = 'https://github.com/yt-dlp/yt-dlp/blob/master/README.md'

test('requested: unless summoned, groups only check links with yt-dlp', async () => {
  const checked: string[][] = []
  const video = async (u: string[]) => (checked.push(u), u.slice(1))
  const msg = said('tugport.com and youtu.be/x')
  expect(await requested(msg, 'vidbot', 'group', video)).toEqual(['https://youtu.be/x'])
  expect(checked).toEqual([['https://tugport.com/', 'https://youtu.be/x']])
  for (const [m, chat] of [
    [msg, 'private'],
    [said('tugport.com @VidBot'), 'supergroup'],
    [said('no links here'), 'group'],
  ] as const)
    expect(await requested(m, 'vidbot', chat, video)).toEqual(links(m, 'vidbot'))
  expect(checked.length).toBe(1)
})

// yt-dlp's last stderr line (and the link's extractors, which only matter
// for untagged errors) for pages that have no video, mostly seen live...
const crash = "ERROR: a: An extractor error has occurred. (caused by KeyError('initialData')); please report this issue"
const empty: [string, string[]?][] = [
  ['ERROR: [generic] Unable to download webpage: <urlopen error [Errno -2] Name or service not known>'],
  ['ERROR: Unsupported URL: https://tugport.com/'],
  ['ERROR: [NYTimesArticle] a: Unable to extract any media blocks from webpage'],
  [crash, ['NYTimesArticle']],
  ['ERROR: [NYTimesArticle] a: Unable to download webpage: HTTP Error 403: Forbidden'],
  ['ERROR: [CNN] 2023/04/14/a: Unable to download webpage: HTTP Error 403: Forbidden'],
  ['ERROR: [Spiegel] 042c: Unable to extract media id; please report this issue'],
  ['ERROR: [VoxMedia] foo: Unable to find provider video id'],
  ['ERROR: [cbsnews] a: No video content was found'],
  ['ERROR: [washingtonpost:article] a: Unable to download webpage: HTTP Error 404: Not Found'],
]
// ...and for videos that failed
const broken: [string, string[]?][] = [
  ['ERROR: [youtube] dQw4w9WgXcQ: Video unavailable. This video is private'],
  ["ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot"],
  ['ERROR: [TikTok] 671: Requested format is not available'],
  ['ERROR: [TikTok] 671: Unable to extract universal data for rehydration'],
  ['ERROR: [TikTok] 671: Unable to download webpage: HTTP Error 403: Forbidden'],
  ['ERROR: [Instagram] C1: Unable to download webpage: HTTP Error 429: Too Many Requests'],
  ['ERROR: [cbsnews:livevideo] a: Unable to download webpage: HTTP Error 403: Forbidden'],
  [crash, ['youtube']],
  [crash, ['FoxNewsVideo']],
  [crash, ['NYTimesArticle', 'youtube']],
  [crash],
]

test('notVideo: no-media pages vs failed videos', () => {
  for (const [why, ies] of empty) expect(notVideo(why, ies)).toBe(true)
  for (const [why, ies] of broken) expect(notVideo(why, ies)).toBe(false)
})

const key = (f: () => unknown) => {
  try {
    f()
  } catch (e) {
    return e instanceof Fail ? e.key : e
  }
  return 'no throw'
}

test('picked: nothing, empty and YouTube playlists are not a video', () => {
  expect(key(() => picked(null))).toBeNull()
  expect(key(() => picked({ _type: 'playlist', extractor_key: 'BBC', entries: [] }))).toBeNull()
  expect(key(() => picked({ _type: 'playlist', extractor_key: 'CNN' }))).toBeNull()
  expect(key(() => picked({ _type: 'playlist', extractor_key: 'YoutubeTab', entries: [{ id: 'a' }] }))).toBeNull()
  expect(picked({ _type: 'playlist', extractor_key: 'BBC', entries: [{ id: 'a' }] })).toEqual({ id: 'a' })
  expect(picked({ id: 'v', extractor_key: 'Youtube' })).toEqual({ id: 'v', extractor_key: 'Youtube' })
})

test('unstarted: streams that have not begun vs other failures', () => {
  for (const why of [
    'ERROR: [youtube] dQw4w9WgXcQ: This live event will begin in 5 hours.',
    'ERROR: [youtube] dQw4w9WgXcQ: This live event will begin in a few moments.',
    'ERROR: [youtube] dQw4w9WgXcQ: Premieres in 3 hours',
    'ERROR: [youtube] dQw4w9WgXcQ: Premiere will begin shortly',
    'ERROR: [youtube] dQw4w9WgXcQ: Premieres 11/3/26, 7:00 PM',
    'ERROR: [rokfin] a: Stream is offline; scheduled for 2026-11-03T19:00:00',
    'ERROR: [youtube] dQw4w9WgXcQ: This live event will begin on November 3, 2026',
    'ERROR: [Rumble] a: This livestream has not yet started',
    'ERROR: [VK] a: Livestream has not yet started',
    'ERROR: [NRKTV] a: Live event has not yet started',
    'ERROR: [twitter:broadcast] a: This live broadcast has not yet started',
    'ERROR: [twitter:spaces] a: Twitter Space not started yet',
    'ERROR: [Bilibili] a: This event will start at 1700000000',
    'ERROR: [NFHSNetwork] a: This live event is scheduled for 2026-11-03',
  ])
    expect(unstarted(why)).toBe('upcoming')
  for (const [why] of [...empty, ...broken]) expect(unstarted(why)).toBeNull()
  expect(unstarted('ERROR: [twitch:stream] foo: The channel is not currently live')).toBeNull()
})

test('unready: live and upcoming streams, not ended ones or videos', () => {
  expect(unready({ is_live: true })).toBe('live')
  expect(unready({ is_live: false, live_status: 'is_live' })).toBe('live')
  expect(unready({ is_live: false, live_status: 'is_upcoming' })).toBe('upcoming')
  expect(unready({ is_live: false, live_status: 'post_live' })).toBeNull()
  expect(unready({ is_live: false, live_status: 'was_live' })).toBeNull()
  expect(unready({ live_status: 'not_live' })).toBeNull()
  expect(unready({ id: 'v' })).toBeNull()
})

test('answer: groups only hear about real failures unless they asked', () => {
  // what job() throws for a no-video page in a group stays unanswered...
  for (const [why, ies] of empty)
    expect(answer(notVideo(why, ies) ? null : 'failed', 'group', false)).toBeNull()
  expect(answer(key(() => picked(null)) as null, 'supergroup', false)).toBeNull()
  // ...but private chats and summons hear it
  expect(answer(null, 'private', false)).toBe('failed')
  expect(answer(null, 'group', true)).toBe('failed')
  // a recognized video that failed is reported everywhere
  for (const [why, ies] of broken)
    expect(answer(notVideo(why, ies) ? null : 'failed', 'group', false)).toBe('failed')
  expect(answer('tooBig', 'supergroup', false)).toBe('tooBig')
  // and so is a stream that can't be downloaded yet
  expect(answer(unready({ is_live: true }), 'group', false)).toBe('live')
  expect(answer(unstarted('ERROR: [youtube] a: Premieres in 3 hours'), 'group', false)).toBe('upcoming')
  // a tweet without a video gets no answer, not even when asked
  const tweet = 'ERROR: [twitter] 2115252259521233154: No video could be found in this tweet'
  expect(answer(notVideo(tweet) ? null : 'failed', 'private', true, tweet)).toBeNull()
})

test('urls: a t.me/s/ channel preview link becomes the post itself', () => {
  const list = ['https://t.me/s/telegram/459', 't.me/s/telegram', 'https://telegram.me/s/durov/1?single']
  const msg = {
    text: list.join(' '),
    entities: list.map((u) => ({ type: 'text_link', offset: 0, length: 1, url: u })),
  } as Message
  expect(urls(msg)).toEqual([
    'https://t.me/telegram/459',
    'https://t.me/s/telegram',
    'https://telegram.me/durov/1?single',
  ])
})

test('i18n: every language has every key', () => {
  for (const code of ['en', 'ru', 'es', 'pt-br', 'pt', 'ja', 'zh', 'ar', 'fa'] as const) {
    expect(lang(code)).toBe(code)
    for (const k of ['failed', 'live', 'upcoming'] as const) expect(t(code, k)).toBeTruthy()
  }
  expect(t('de', 'live')).toBe(t('en', 'live'))
  expect(t('ru', 'upcoming')).not.toBe(t('en', 'upcoming'))
})

// CI installs yt-dlp; elsewhere this only runs where it is
test.skipIf(!Bun.which('yt-dlp') && !process.env.CI)(
  'requested: plain sites stay quiet in groups, video sites and summons do not',
  async () => {
    const group = (text: string) => requested(said(text), 'vidbot', 'group')
    expect(await group('tugport.com запущу скоро')).toEqual([])
    expect(await group(`read ${article}`)).toEqual([])
    expect(await group(`${youtube} lol ${tiktok} tugport.com`)).toEqual([youtube, tiktok])
    // news extractors claim articles: these get a yt-dlp run, and picked(),
    // notVideo() and answer() keep a page without media quiet
    const bbc = 'https://www.bbc.com/news/articles/c123'
    expect(await group(`see ${bbc}`)).toEqual([bbc])
    // what an untagged crash is judged by
    const nyt = 'https://www.nytimes.com/2024/01/01/world/a.html'
    const by = await claims([nyt, youtube, 'https://tugport.com/'])
    expect([...by]).toEqual([[nyt, ['NYTimesArticle']], [youtube, ['youtube']]])
    expect(notVideo(crash, by.get(nyt))).toBe(true)
    expect(notVideo(crash, by.get(youtube))).toBe(false)
    const spotify = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'
    expect(await videos([tiktok, 'https://tugport.com/', spotify, youtube])).toEqual([tiktok, youtube])
    expect(await group('@VidBot tugport.com')).toEqual(['https://tugport.com/'])
    expect(
      await requested(said(`tugport.com ${article}`), 'vidbot', 'private'),
    ).toEqual(['https://tugport.com/', article])
  },
  30_000,
)

test('census: chats and users counted once, by first-seen day', () => {
  const c = census(new Database(':memory:'))
  c.seen(-100, 1)
  c.seen(-100, 2)
  c.seen(1, 1)
  c.seen(undefined, 3)
  const s = c.stats()
  const today = new Date().toISOString().slice(0, 10)
  expect([s.chatCount, s.userCount]).toEqual([2, 3])
  expect(s.chatDaily).toEqual([{ date: today, count: 2 }])
  expect(s.userDaily).toEqual([{ date: today, count: 3 }])
})

test('census: audience by chat type and recency, blocked private chats unreachable', () => {
  const db = new Database(':memory:')
  // a database from before the audience columns
  db.run('CREATE TABLE chats (id INTEGER PRIMARY KEY, created INTEGER NOT NULL)')
  db.run('INSERT INTO chats VALUES (5, unixepoch() - 100 * 86400), (-1001234567890, unixepoch() - 400 * 86400)')
  const c = census(db)
  c.seen(1, 1, 'private')
  c.seen(2, 2, 'private')
  c.member(2, 'kicked')
  c.seen(-42, 3, 'group')
  const a = c.stats().audience
  expect(a.private).toEqual({ ever: 3, unreachable: 1, d7: 1, d30: 1, d90: 1, d180: 2 })
  expect(a.group).toEqual({ ever: 1, unreachable: 0, d7: 1, d30: 1, d90: 1, d180: 1 })
  expect(a.supergroup_or_channel).toEqual({ ever: 1, unreachable: 0, d7: 0, d30: 0, d90: 0, d180: 0 })
  c.member(2, 'member') // unblocked
  c.seen(2, 2, 'private')
  expect(c.stats().audience.private.unreachable).toBe(0)
})

test('only cached file_ids skip the document fallback', () => {
  expect(fresh('BAACAgIAAxkBAAIBY2')).toBe(false)
  expect(fresh('file:///scratch/bot-a/job-1/v.mp4')).toBe(true)
  expect(fresh(new InputFile(new Uint8Array(1)))).toBe(true)
})

// What the Bot API answers when the bot hits flood control
const flood = (after: number) => ({
  ok: false,
  error_code: 429,
  description: `Too Many Requests: retry after ${after}`,
  parameters: { retry_after: after },
})
const sentAs = (kind: 'video' | 'document') => ({
  ok: true,
  result: {
    message_id: 7,
    date: 0,
    chat: { id: -100, type: 'supergroup', title: 'g' },
    [kind]: { file_id: `${kind}-id`, file_unique_id: 'u', width: 1, height: 1, duration: 1 },
  },
})

// A fake Bot API server: answer(method, n) is its n-th answer to method
function fakeApi(answer: (method: string, n: number) => object, wait: Transformer = floodWait()) {
  const calls: { method: string; at: number }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      await req.arrayBuffer()
      const method = new URL(req.url).pathname.split('/').pop()!
      calls.push({ method, at: Date.now() })
      return Response.json(answer(method, calls.filter((c) => c.method === method).length))
    },
  })
  const api = new Api('1:test', { apiRoot: `http://localhost:${server.port}` })
  api.config.use(wait)
  return { api, calls, methods: () => calls.map((c) => c.method), stop: () => server.stop(true) }
}

// A finished download, sent by path as in job()
async function video<T>(fn: (path: string) => Promise<T>) {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'send-'))
  try {
    await Bun.write(join(dir, 'v.mp4'), 'video')
    return await fn(join(dir, 'v.mp4'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('send: a 429 waits retry_after and sends the video again, never as a document', async () => {
  const fake = fakeApi((method, n) => (method === 'sendVideo' && n === 1 ? flood(1) : sentAs('video')))
  try {
    const dest: { chat: number; sent?: number } = { chat: -100 }
    const [kind, id] = await video((path) =>
      sender(fake.api)(dest, 'video', () => new InputFile(path), { caption: 'x' }),
    )
    expect([kind, id, dest.sent]).toEqual(['video', 'video-id', 7])
    expect(fake.methods()).toEqual(['sendVideo', 'sendVideo'])
    expect(fake.calls[1]!.at - fake.calls[0]!.at).toBeGreaterThanOrEqual(990)
  } finally {
    fake.stop()
  }
})

test('send: a 429 that outlasts the retries fails without a document fallback', async () => {
  const fake = fakeApi(() => flood(0.01), floodWait(1))
  try {
    const sent = video((path) =>
      sender(fake.api)({ chat: -100 }, 'video', () => new InputFile(path), { caption: 'x' }),
    )
    await expect(sent).rejects.toMatchObject({ error_code: 429 })
    expect(fake.methods()).toEqual(['sendVideo', 'sendVideo'])
  } finally {
    fake.stop()
  }
})

test('send: a status 429 comes back at once, and the video waits out the flood it started', async () => {
  const fake = fakeApi((method) => (method === 'sendMessage' ? flood(1) : sentAs('video')))
  try {
    await expect(fake.api.sendMessage(-100, '⏫', undefined, PROGRESS)).rejects.toMatchObject({
      error_code: 429,
    })
    const [kind] = await video((path) =>
      sender(fake.api)({ chat: -100 }, 'video', () => new InputFile(path), { caption: 'x' }),
    )
    expect(kind).toBe('video')
    expect(fake.methods()).toEqual(['sendMessage', 'sendVideo'])
    expect(fake.calls[1]!.at - fake.calls[0]!.at).toBeGreaterThanOrEqual(990)
  } finally {
    fake.stop()
  }
})

test('send: a fresh file Telegram refuses as a video still goes as a document', async () => {
  const fake = fakeApi((method) =>
    method === 'sendVideo'
      ? { ok: false, error_code: 400, description: 'Bad Request: VIDEO_CONTENT_TYPE_INVALID' }
      : sentAs('document'),
  )
  try {
    const [kind] = await video((path) =>
      sender(fake.api)({ chat: -100 }, 'video', () => new InputFile(path), { caption: 'x' }),
    )
    expect(kind).toBe('document')
    expect(fake.methods()).toEqual(['sendVideo', 'sendDocument'])
  } finally {
    fake.stop()
  }
})

// floodWait around a fake API call: answer(method, n) is the n-th answer
// overall; calls has each call's method, chat and ms since the start
function flooding(
  answer: (method: string, n: number) => object | Promise<object>,
  retries?: number,
  max?: number,
  gap?: number,
) {
  const start = Date.now()
  const calls: [string, unknown, number][] = []
  const prev = async (method: string, payload?: { chat_id?: unknown }) => {
    calls.push([method, payload?.chat_id, Date.now() - start])
    return answer(method, calls.length)
  }
  const wait = floodWait(retries, max, gap)
  const call = (method: string, payload?: object, signal?: typeof PROGRESS) =>
    wait(prev as never, method as never, payload as never, signal) as Promise<{ ok: boolean }>
  return { call, calls, flooded: wait.flooded }
}

test('floodWait: retries a 429 after retry_after, a bounded number of times', async () => {
  const ok = { ok: true, result: true }
  const once = flooding((_, n) => (n === 1 ? flood(0.2) : ok))
  expect(await once.call('editMessageText', { chat_id: 1 })).toEqual(ok)
  expect(once.calls.length).toBe(2)
  expect(once.calls[1]![2]).toBeGreaterThanOrEqual(190)
  // still flooded after the retries: Telegram's answer goes back as it is
  const always = flooding(() => flood(0.01), 2)
  expect(await always.call('sendMessage', { chat_id: 1 })).toEqual(flood(0.01))
  expect(always.calls.length).toBe(3)
  // a wait longer than max fails at once
  const long = flooding(() => flood(121))
  expect(await long.call('sendVideo', { chat_id: 1 })).toEqual(flood(121))
  expect(long.calls.length).toBe(1)
  // and so does one that would take the waits past max in all: 0.1 + 0.1 s
  // fit in 0.25 s, a third 0.1 s doesn't
  const most = flooding(() => flood(0.1), 5, 0.25)
  expect(await most.call('sendVideo', { chat_id: 1 })).toEqual(flood(0.1))
  expect(most.calls.length).toBe(3)
  // other errors aren't retried
  const bad = { ok: false, error_code: 400, description: 'Bad Request: chat not found' }
  const other = flooding(() => bad)
  expect(await other.call('sendMessage', { chat_id: 1 })).toEqual(bad)
  expect(other.calls.length).toBe(1)
})

test('floodWait: not for getUpdates (grammY waits) or chat actions (stale by then)', async () => {
  for (const method of ['getUpdates', 'sendChatAction']) {
    const f = flooding(() => flood(0.01))
    expect(await f.call(method, { chat_id: 1 })).toEqual(flood(0.01))
    expect(f.calls.length).toBe(1)
  }
})

test("floodWait: a chat's other requests wait out its flood, other chats don't", async () => {
  const f = flooding((_, n) => (n === 1 ? flood(1) : { ok: true, result: true }))
  const sending = f.call('sendVideo', { chat_id: -100 })
  await Bun.sleep(50)
  expect([f.flooded(-100), f.flooded('-100'), f.flooded(-200)]).toEqual([true, true, false])
  const edit = f.call('editMessageText', { chat_id: '-100' }) // the same chat
  const elsewhere = f.call('sendMessage', { chat_id: -200 })
  const inline = f.call('editMessageTextInline', { inline_message_id: 'x' })
  await Promise.all([sending, edit, elsewhere, inline])
  const at = (method: string) => f.calls.filter((c) => c[0] === method).map((c) => c[2])
  expect(at('sendVideo').length).toBe(2)
  expect(at('sendVideo')[1]).toBeGreaterThanOrEqual(990)
  expect(at('editMessageText')[0]).toBeGreaterThanOrEqual(990)
  // at once, with slack for a loaded machine
  expect(at('sendMessage')[0]).toBeLessThan(900)
  expect(at('editMessageTextInline')[0]).toBeLessThan(900)
  // the line is gone with its last request
  expect(f.flooded(-100)).toBe(false)
})

test("floodWait: progress isn't waited out, but the chat's line waits for its flood", async () => {
  const ok = { ok: true, result: true }
  const f = flooding((_, n) => (n === 1 ? flood(0.5) : ok))
  // the status that trips the flood comes back at once
  expect(await f.call('sendMessage', { chat_id: -100 }, PROGRESS)).toEqual(flood(0.5))
  expect(f.flooded(-100)).toBe(true)
  // the video doesn't go into it
  expect(await f.call('sendVideo', { chat_id: -100 })).toEqual(ok)
  expect(f.calls.map((c) => c[0])).toEqual(['sendMessage', 'sendVideo'])
  expect(f.calls[1]![2]).toBeGreaterThanOrEqual(490)
  expect(f.flooded(-100)).toBe(false)
  // with nobody in its line, the flood ends on its own
  const g = flooding(() => flood(0.2))
  await g.call('editMessageText', { chat_id: 1 }, PROGRESS)
  expect(g.flooded(1)).toBe(true)
  await Bun.sleep(600) // slack for a loaded machine
  expect([g.flooded(1), g.calls.length]).toEqual([false, 1])
})

test('floodWait: a burst into a flooded chat goes one at a time, none runs out of retries', async () => {
  // a group's limit, scaled down: one message per 50 ms, and a 429 says how
  // long until the next one (rounded up, as Telegram's whole seconds are)
  let last = -Infinity
  const f = flooding(() => {
    const gap = Date.now() - last
    if (gap < 50) return flood(Math.ceil((50 - gap) / 10) / 100)
    last = Date.now()
    return { ok: true, result: true }
  }, 4)
  // let through together, the last of 8 would need 7 retries
  const sent = await Promise.all([...Array(8)].map(() => f.call('sendVideo', { chat_id: -100 })))
  expect(sent.map((r) => r.ok)).toEqual(Array(8).fill(true))
})

test("floodWait: a slow upload holds the chat's line gap seconds at most", async () => {
  // the video's retry takes 1 s to upload, the line's gap is 0.2 s
  const f = flooding(
    async (method, n) => {
      if (n === 1) return flood(0.1)
      if (method === 'sendVideo') await Bun.sleep(1000)
      return { ok: true, result: true }
    },
    5,
    120,
    0.2,
  )
  const sending = f.call('sendVideo', { chat_id: -100 })
  await Bun.sleep(50)
  expect(f.flooded(-100)).toBe(true)
  await f.call('deleteMessage', { chat_id: -100 })
  // the delete waits out the flood and the gap, not the upload
  const deleted = f.calls.find((c) => c[0] === 'deleteMessage')![2]
  expect(deleted).toBeGreaterThanOrEqual(290)
  expect(deleted).toBeLessThan(900)
  // the flood is over and nobody waits: the chat is back to normal while the
  // upload goes on
  expect(f.flooded(-100)).toBe(false)
  expect((await sending).ok).toBe(true)
})

test('floodWait: a 429 that ends the retries still holds the chat until the flood is over', async () => {
  const ok = { ok: true, result: true }
  const f = flooding((_, n) => (n === 1 ? flood(0.3) : ok), 0)
  expect(await f.call('sendVideo', { chat_id: -100 })).toEqual(flood(0.3))
  expect(f.flooded(-100)).toBe(true)
  // the next request doesn't walk into it
  expect(await f.call('sendMessage', { chat_id: -100 })).toEqual(ok)
  expect(f.calls[1]![2]).toBeGreaterThanOrEqual(290)
  expect(f.flooded(-100)).toBe(false)
})

test("progress: a 429 on it comes back at once and skips the chat's next ones, other errors fail", async () => {
  const wait = floodWait()
  const fake = fakeApi(
    (_, n) => (n === 1 ? flood(0.3) : { ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
    wait,
  )
  try {
    const signals: unknown[] = []
    const show = (signal: typeof PROGRESS) => {
      signals.push(signal)
      return fake.api.sendMessage(-100, '⏬', undefined, signal)
    }
    const start = Date.now()
    await progress(wait.flooded(-100), show)
    expect(Date.now() - start).toBeLessThan(250)
    expect(signals).toHaveLength(1)
    expect(signals[0]).toBe(PROGRESS)
    // skipped while the chat is in the flood it started
    expect(wait.flooded(-100)).toBe(true)
    await progress(wait.flooded(-100), show)
    expect(fake.methods()).toEqual(['sendMessage'])
    // after it, any other error still fails the job
    await Bun.sleep(400)
    expect(wait.flooded(-100)).toBe(false)
    await expect(progress(wait.flooded(-100), show)).rejects.toMatchObject({ error_code: 400 })
    expect(fake.methods()).toEqual(['sendMessage', 'sendMessage'])
  } finally {
    fake.stop()
  }
})

test('shown: sample aspect ratio and rotation', () => {
  // Instagram's progressive mp4 for the reel in #281
  expect(shown({ width: 1280, height: 720, sample_aspect_ratio: '1:1' })).toEqual({ width: 1280, height: 720 })
  // anamorphic: coded 1080x1440, shown 16:9
  expect(shown({ width: 1080, height: 1440, sample_aspect_ratio: '64:27' })).toEqual({ width: 2560, height: 1440 })
  // unknown aspect = square pixels
  expect(shown({ width: 640, height: 480, sample_aspect_ratio: '0:1' })).toEqual({ width: 640, height: 480 })
  expect(shown({ width: 640, height: 480 })).toEqual({ width: 640, height: 480 })
  // rotation side data (any sign), or the old rotate tag
  expect(shown({ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] })).toEqual({ width: 1080, height: 1920 })
  expect(shown({ width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] })).toEqual({ width: 1920, height: 1080 })
  expect(shown({ width: 1920, height: 1080, tags: { rotate: '270' } })).toEqual({ width: 1080, height: 1920 })
  expect(shown({ width: 1080, height: 1440, sample_aspect_ratio: '64:27', side_data_list: [{ rotation: 90 }] })).toEqual({ width: 1440, height: 2560 })
  expect(shown(undefined)).toBeUndefined()
  expect(shown({ width: 0, height: 0 })).toBeUndefined()
})

// What sendVideo and the thumbnail get from a real anamorphic, rotated file
test.skipIf(!(Bun.which('ffmpeg') || process.env.CI))('probe and thumbnail: display size of the file', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'probe-'))
  const run = async (args: string[]) => {
    const p = Bun.spawn(['ffmpeg', '-v', 'error', '-y', ...args], { stderr: 'pipe' })
    if (await p.exited) throw new Error(await new Response(p.stderr).text())
  }
  try {
    const flat = join(dir, 'flat.mp4')
    const rot = join(dir, 'rot.mp4')
    await run(['-f', 'lavfi', '-i', 'testsrc=s=1080x1440:d=1', '-vf', 'setsar=64/27', '-c:v', 'mpeg4', flat])
    // -display_rotation came with ffmpeg 6 (Debian bookworm has 5.1)
    const rotates = Bun.spawnSync(['ffmpeg', '-hide_banner', '-h', 'full']).stdout.toString().includes('display_rotation')
    if (rotates) await run(['-display_rotation', '90', '-i', flat, '-c', 'copy', rot])
    expect(await probe(flat)).toEqual({ width: 2560, height: 1440 })
    if (rotates) expect(await probe(rot)).toEqual({ width: 1440, height: 2560 })
    expect(await probe(join(dir, 'missing.mp4'))).toBeUndefined()
    const cases = [[flat, { width: 320, height: 180 }], [rot, { width: 180, height: 320 }]] as const
    for (const [file, size] of rotates ? cases : cases.slice(0, 1)) {
      const thumb = join(dir, 'thumb.jpg')
      await run(['-i', file, '-frames:v', '1', '-vf', THUMB, thumb])
      expect(await probe(thumb)).toEqual(size)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
