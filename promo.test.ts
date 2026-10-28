import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { arm, bucket, type Config, decide, promos } from './promo'

const cfg = (over: Partial<Config['campaigns'][0]> = {}, enabled = true): Config => ({
  base: 'https://lumen.borodutch.com/go',
  bots: { videodownloadbot: { enabled } },
  campaigns: [
    {
      id: 'vdb-voicy-1',
      bot: 'videodownloadbot',
      status: 'running',
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
// users in each arm of vdb-voicy-1
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
    url: `https://lumen.borodutch.com/go/vdb-voicy-1/a?u=${a.unit}`,
    format: 'caption',
  })
  // pt-br reads the pt text; a button variant has its own wording
  expect(decide(cfg(), 's', inArm('b'), 'private', 'pt-br', never)!.promo).toMatchObject({ text: 'Bt', format: 'button' })
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
