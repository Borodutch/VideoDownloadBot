import { expect, test } from 'bun:test'
import type { Message } from 'grammy/types'
import {
  answer,
  claims,
  Fail,
  links,
  notVideo,
  picked,
  requested,
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
