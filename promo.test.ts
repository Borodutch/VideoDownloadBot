import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { arm, bucket, type Config, decide, promos } from './promo'

const cfg = (over: Partial<Config['campaigns'][0]> = {}, enabled = true): Config => ({
  base: 'https://lumen.borodutch.com/go',
  bots: { videodownloadbot: { enabled, code: 'vdb' } },
  campaigns: [
    {
      id: 'xp1',
      bot: 'videodownloadbot',
      status: 'running',
      target: 'https://t.me/voicybot',
      chats: ['private'],
      cap_days: 7,
      langs: ['en', 'ru', 'pt'],
      text: { en: 'Voice to text', ru: 'Голос в текст', pt: 'Voz em texto' },
      variants: [
        { id: 'a', share: 0.1, format: 'caption' },
        { id: 'b', share: 0.1, format: 'button', text: { en: 'Btn', ru: 'Кн', pt: 'Bt' } },
      ],
      ...over,
    },
  ],
})
const never = () => undefined
// users in each arm of xp1
const users = Array.from({ length: 20_000 }, (_, i) => 1000 + i)
const inArm = (id: string | undefined) => users.find((u) => arm(cfg().campaigns[0]!, u)?.id === id)!

test('arms: fixed per user, shares hold, the rest is holdout', () => {
  expect(bucket('c', 42)).toBe(bucket('c', 42))
  expect(bucket('c', 42)).not.toBe(bucket('d', 42))
  const c = cfg().campaigns[0]!
  const n = { a: 0, b: 0, holdout: 0 }
  for (const u of users) n[(arm(c, u)?.id ?? 'holdout') as keyof typeof n]++
  expect(n.a / users.length).toBeCloseTo(0.1, 1)
  expect(n.b / users.length).toBeCloseTo(0.1, 1)
  expect(n.holdout / users.length).toBeCloseTo(0.8, 1)
})

test('decide: arms, texts, links, caps', () => {
  const a = decide(cfg(), 's', inArm('a'), 'private', 'en', never)!
  expect(a.arm).toBe('a')
  expect(a.unit).toMatch(/^[0-9a-f]{16}$/)
  expect(a.promo).toEqual({
    text: 'Voice to text',
    // a native deep link, not a redirect: Telegram opens the bot in the app
    url: 'https://t.me/voicybot?start=xp1-a-vdb',
    format: 'caption',
  })
  // pt-br reads the pt text; a button variant has its own wording
  expect(decide(cfg(), 's', inArm('b'), 'private', 'pt-br', never)!.promo).toMatchObject({
    text: 'Bt',
    format: 'button',
    url: 'https://t.me/voicybot?start=xp1-b-vdb',
  })
  // a channel invite link per variant goes as it is; a web page through /go
  const variants = [
    { id: 'a', share: 0.1, format: 'caption' as const, target: 'https://t.me/+AAA' },
    { id: 'b', share: 0.1, format: 'button' as const, target: 'https://t.me/+BBB' },
  ]
  expect(decide(cfg({ variants }), 's', inArm('b'), 'private', 'en', never)!.promo!.url).toBe('https://t.me/+BBB')
  const web = decide(cfg({ target: 'https://todorant.com' }), 's', inArm('a'), 'private', 'en', never)!
  expect(web.promo!.url).toBe(`https://lumen.borodutch.com/go/xp1/a?u=${web.unit}`)
  const h = decide(cfg(), 's', inArm(undefined), 'private', 'ru', never)!
  expect(h).toMatchObject({ arm: 'holdout' })
  expect(h.promo).toBeUndefined()
  // shown 6 days ago: capped but still in the experiment; 8 days ago: shown again
  const now = Date.now()
  const capped = decide(cfg(), 's', inArm('a'), 'private', 'en', () => now - 6 * 86400_000, now)!
  expect(capped.arm).toBe('a')
  expect(capped.promo).toBeUndefined()
  expect(decide(cfg(), 's', inArm('a'), 'private', 'en', () => now - 8 * 86400_000, now)!.promo).toBeDefined()
})

test('decide: out of every experiment when switched off or not covered', () => {
  const u = inArm('a')
  expect(decide(undefined, 's', u, 'private', 'en', never)).toBeNull()
  expect(decide(cfg(), '', u, 'private', 'en', never)).toBeNull()
  expect(decide(cfg({}, false), 's', u, 'private', 'en', never)).toBeNull()
  expect(decide(cfg({ status: 'paused' }), 's', u, 'private', 'en', never)).toBeNull()
  expect(decide(cfg({ bot: 'voicy' }), 's', u, 'private', 'en', never)).toBeNull()
  // an id that can't be a deep-link payload (the first campaign's) is skipped
  expect(decide(cfg({ id: 'vdb-voicy-1' }), 's', u, 'private', 'en', never)).toBeNull()
  expect(decide(cfg(), 's', u, 'group', 'en', never)).toBeNull()
  expect(decide(cfg(), 's', u, 'private', 'ja', never)).toBeNull()
  // no holdout left: refused
  const all = [{ id: 'a', share: 0.5, format: 'caption' as const }, { id: 'b', share: 0.5, format: 'caption' as const }]
  expect(decide(cfg({ variants: all }), 's', u, 'private', 'en', never)).toBeNull()
})

test('promos: one promo per cap even for several links, seen once a day, events reach the server', async () => {
  const got: any[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/go/campaigns.json') return Response.json({ ...cfg(), base: 'https://elsewhere.example/go' })
      if (path === '/go/events' && req.headers.get('authorization') === 'Bearer tok') {
        got.push(...(await req.json()).events)
        return Response.json({ stored: 1 })
      }
      return new Response('no', { status: 401 })
    },
  })
  try {
    const p = promos(new Database(':memory:'), {
      PROMO_TOKEN: 'tok',
      PROMO_URL: `http://localhost:${server.port}/go/campaigns.json`,
    })
    expect(p.decide(inArm('a'), 'private', 'en')).toBeNull() // not fetched yet
    await p.refresh()
    const first = p.decide(inArm('a'), 'private', 'en')!
    const second = p.decide(inArm('a'), 'private', 'en')!
    expect(first.promo).toBeDefined()
    expect(second.promo).toBeUndefined()
    p.record(first)
    p.record(second)
    p.record(p.decide(inArm(undefined), 'private', 'en'))
    await p.flush()
    // the token goes next to PROMO_URL, not to the config's base
    expect(got.map((e) => `${e.v}:${e.k}`)).toEqual(['a:seen', 'a:shown', 'holdout:seen'])
    expect(promos(new Database(':memory:'), { PROMO: 'off', PROMO_TOKEN: 'tok' }).decide(inArm('a'), 'private', 'en')).toBeNull()
  } finally {
    server.stop(true)
  }
})

test('arrivals: /start from another bot\'s campaign reports start, new and use once a day for 7 days', async () => {
  const got: any[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === '/go/events') got.push(...(await req.json()).events)
      return Response.json({})
    },
  })
  try {
    const db = new Database(':memory:')
    const p = promos(db, { PROMO_TOKEN: 'tok', PROMO_URL: `http://localhost:${server.port}/go/campaigns.json` })
    p.arrived(42, 'bc1-a-voicy', true)
    p.arrived(42, 'bc1-a-voicy', false) // an existing chat sends it again: start only
    p.arrived(42, 'hello', true) // not a campaign
    p.used(42)
    p.used(42) // once a day
    p.used(7) // never arrived
    await p.flush()
    const unit = createHash('sha256').update('tok:bc1:42').digest('hex').slice(0, 16)
    expect(got.map((e) => `${e.c}:${e.v}:${e.k}`)).toEqual(['bc1:a:start', 'bc1:a:new', 'bc1:a:start', 'bc1:a:use'])
    expect(got.every((e) => e.u === unit)).toBe(true)
    db.run('UPDATE arrival SET at = 0, used = NULL')
    p.used(42) // more than 7 days later
    await p.flush()
    expect(got.length).toBe(4)
  } finally {
    server.stop(true)
  }
})
