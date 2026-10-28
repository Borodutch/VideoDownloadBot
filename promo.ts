import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { lang } from './i18n'

// Cross-promotion of the maker's other bots and channel, run as measured A/B
// experiments.
// Campaigns live in one file Prime Radiant edits (go/campaigns.json in
// backmeupplz/prime-radiant), served at PROMO_URL; this bot re-reads it every
// 5 minutes. Each user lands in a fixed arm per campaign (a hash of campaign
// and user id): a variant, or the holdout that never sees a promo. A variant
// shows its line at most once per cap_days, only in the chat types the
// campaign names (private by default), and at most one promo per reply. The
// bot reports seen (an eligible reply, once a day, holdout too) and shown
// events with a salted user hash, never the Telegram id.
// Off when: PROMO=off, no PROMO_TOKEN (nothing would be measured), the config
// says so (bots.videodownloadbot.enabled, a campaign's status), or the config
// couldn't be read for an hour.

export const BOT = 'videodownloadbot'
const STALE = 3600_000

export type Variant = {
  id: string
  share: number
  format: 'caption' | 'button'
  // its own wording (a button needs a short one), else the campaign's
  text?: Record<string, string>
  // its own target (each variant's channel invite link), else the campaign's
  target?: string
}
export type Campaign = {
  id: string
  bot: string
  status: string
  target: string
  chats: string[]
  cap_days: number
  langs: string[]
  text: Record<string, string>
  variants: Variant[]
}
export type Config = {
  base: string
  bots: Record<string, { enabled: boolean; code: string }>
  campaigns: Campaign[]
}
export type Promo = { text: string; url: string; format: Variant['format'] }
export type Decision = { campaign: string; arm: string; unit: string; promo?: Promo }
type Event = { c: string; v: string; k: 'seen' | 'shown' | 'start' | 'new' | 'use'; u: string; t: number }

// /start payload from another bot's campaign link: <campaign>-<variant>-<source bot code>
// (xp1-a-vdb from this bot to Voicy, bc1-a-voicy from Voicy's broadcast to this one)
export const ARRIVAL = /^([a-z0-9]{1,16})-([a-z0-9]{1,8})-([a-z0-9]{1,12})$/
const WEEK = 7 * 86400_000

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

// Where a user falls in [0, 1) for a campaign: the same every time
export const bucket = (campaign: string, user: number) =>
  parseInt(sha(`${campaign}:${user}`).slice(0, 8), 16) / 2 ** 32

// The user's arm: variants take their shares from 0 up, the rest is holdout
export function arm(c: Campaign, user: number) {
  const b = bucket(c.id, user)
  let edge = 0
  for (const v of c.variants) if (b < (edge += v.share)) return v
  return undefined
}

// A bot's own t.me link (bot usernames end in "bot")
const BOT_LINK = /^https:\/\/t\.me\/[A-Za-z0-9_]{2,29}bot$/i
const PAYLOAD = /^[A-Za-z0-9_-]{1,64}$/

// The link a promo carries. Another bot gets a native deep link, so Telegram
// opens it in the app, with t.me/<bot>?start=<campaign>-<variant>-<this bot's
// code> (the promoted bot reports the /start). A channel or invite link goes
// as it is (joins are counted per invite link). Only web pages go through the
// /go redirect, which counts the tap and adds UTM tags. undefined = this
// campaign can't make a valid link.
export function link(cfg: Config, c: Campaign, v: Variant, unit: string) {
  const target = v.target ?? c.target
  if (BOT_LINK.test(target)) {
    const payload = `${c.id}-${v.id}-${cfg.bots[BOT]?.code}`
    return PAYLOAD.test(payload) && /^[a-z0-9]{1,16}$/.test(c.id)
      ? `${target}?start=${payload}`
      : undefined
  }
  if (/^https:\/\/t\.me\//.test(target)) return target
  return `${cfg.base}/${c.id}/${v.id}?u=${unit}`
}

// A campaign this bot may run, or not: its shares must leave a holdout, and
// every variant needs a valid link
const usable = (cfg: Config, c: Campaign) =>
  c.bot === BOT &&
  c.status === 'running' &&
  c.variants.reduce((s, v) => s + v.share, 0) < 1 &&
  c.variants.every((v) => v.share > 0 && link(cfg, c, v, '0') !== undefined)

// What to do for one reply: null = not in any experiment (log nothing)
export function decide(
  cfg: Config | undefined,
  salt: string,
  user: number,
  chat: string,
  code: string | undefined,
  lastShown: (campaign: string, unit: string) => number | undefined,
  now = Date.now(),
): Decision | null {
  if (!cfg || !salt || cfg.bots?.[BOT]?.enabled !== true) return null
  const l = lang(code).split('-')[0]
  const c = cfg.campaigns.find(
    (c) => usable(cfg, c) && c.chats.includes(chat) && c.langs.includes(l) && c.text[l],
  )
  if (!c) return null
  const unit = sha(`${salt}:${c.id}:${user}`).slice(0, 16)
  const v = arm(c, user)
  if (!v) return { campaign: c.id, arm: 'holdout', unit }
  const last = lastShown(c.id, unit)
  const capped = last !== undefined && now - last < c.cap_days * 86400_000
  return {
    campaign: c.id,
    arm: v.id,
    unit,
    promo: capped
      ? undefined
      : { text: v.text?.[l] ?? c.text[l]!, url: link(cfg, c, v, unit)!, format: v.format },
  }
}

export function promos(db: Database, env = process.env) {
  db.run(
    'CREATE TABLE IF NOT EXISTS promo (campaign TEXT NOT NULL, unit TEXT NOT NULL, seen TEXT, shown INTEGER, PRIMARY KEY (campaign, unit))',
  )
  const row = db.query<{ seen: string | null; shown: number | null }, [string, string]>(
    'SELECT seen, shown FROM promo WHERE campaign = ? AND unit = ?',
  )
  // the campaign that first brought each user here, for the 7-day use count
  db.run('CREATE TABLE IF NOT EXISTS arrival (user INTEGER PRIMARY KEY, payload TEXT NOT NULL, at INTEGER NOT NULL, used TEXT)')
  const arrival = db.query<{ payload: string; at: number; used: string | null }, [number]>(
    'SELECT payload, at, used FROM arrival WHERE user = ?',
  )
  const upsert = (col: 'seen' | 'shown', campaign: string, unit: string, value: string | number) =>
    db
      .query(`INSERT INTO promo (campaign, unit, ${col}) VALUES (?, ?, ?) ON CONFLICT (campaign, unit) DO UPDATE SET ${col} = excluded.${col}`)
      .run(campaign, unit, value)

  const off = env.PROMO === 'off'
  const salt = env.PROMO_TOKEN || ''
  const url = env.PROMO_URL || 'https://lumen.borodutch.com/go/campaigns.json'
  // events go next to the config, never to a host the config names: the token is in them
  const events = url.replace(/campaigns\.json$/, 'events')
  let cfg: Config | undefined
  let fetched = 0
  let queue: Event[] = []

  async function refresh() {
    if (off || !salt) return
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`${res.status}`)
      cfg = (await res.json()) as Config
      fetched = Date.now()
    } catch (e) {
      console.error('promo config', (e as Error).message)
    }
  }

  async function flush() {
    if (!queue.length) return
    const batch = queue
    queue = []
    try {
      const res = await fetch(events, {
        method: 'POST',
        headers: { Authorization: `Bearer ${salt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`${res.status}`)
    } catch (e) {
      console.error('promo events', (e as Error).message)
      // kept for the next try, within reason
      queue = [...batch, ...queue].slice(-20_000)
    }
  }

  return {
    refresh,
    flush,
    // The promo for a reply about to go out. A promo counts against the cap
    // as soon as it's handed out, so several links in one message get one.
    // ponytail: a failed download still uses up the user's promo for cap_days
    decide(user: number, chat: string, code: string | undefined) {
      const fresh = Date.now() - fetched < STALE ? cfg : undefined
      const d = decide(fresh, salt, user, chat, code, (c, u) => row.get(c, u)?.shown ?? undefined)
      if (d?.promo) upsert('shown', d.campaign, d.unit, Date.now())
      return d
    },
    // After the reply went out: seen once a day per user, shown each time
    record(d: Decision | null) {
      if (!d) return
      const t = Math.floor(Date.now() / 1000)
      const day = new Date().toISOString().slice(0, 10)
      const base = { c: d.campaign, v: d.arm, u: d.unit, t }
      if (row.get(d.campaign, d.unit)?.seen !== day) {
        upsert('seen', d.campaign, d.unit, day)
        queue.push({ ...base, k: 'seen' })
      }
      if (d.promo) queue.push({ ...base, k: 'shown' })
      if (queue.length >= 500) void flush()
    },
    // Another bot's campaign brought this user (/start <payload>): start each
    // time (the numbers count distinct people), new when the chat is new here.
    // Same salted hash as the other bots, so the experiment can join them.
    arrived(user: number, payload: string | undefined, fresh: boolean) {
      const m = ARRIVAL.exec(payload || '')
      if (!m || !salt) return
      const base = { c: m[1]!, v: m[2]!, u: sha(`${salt}:${m[1]}:${user}`).slice(0, 16), t: Math.floor(Date.now() / 1000) }
      queue.push({ ...base, k: 'start' })
      if (fresh) queue.push({ ...base, k: 'new' })
      db.query('INSERT OR IGNORE INTO arrival VALUES (?, ?, ?, NULL)').run(user, payload!, Date.now())
    },
    // A download in the 7 days after the arrival: use, once a day
    used(user: number) {
      const a = arrival.get(user)
      const day = new Date().toISOString().slice(0, 10)
      if (!a || !salt || Date.now() - a.at > WEEK || a.used === day) return
      db.query('UPDATE arrival SET used = ? WHERE user = ?').run(day, user)
      const [, c, v] = ARRIVAL.exec(a.payload)!
      queue.push({ c: c!, v: v!, k: 'use', u: sha(`${salt}:${c}:${user}`).slice(0, 16), t: Math.floor(Date.now() / 1000) })
    },
  }
}
