import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { scratch, sweep } from './scratch'

test('sweep removes only the folders of dead containers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scratch-'))
  try {
    const old = new Date(Date.now() - 11 * 60_000)
    const mine = join(root, 'bot-me')
    for (const name of ['bot-me', 'bot-dead', 'bot-alive', 'api-temp'])
      await mkdir(join(root, name, 'job-x'), { recursive: true })
    await writeFile(join(root, 'bot-file'), '')
    await writeFile(join(root, 'bot-dead', 'job-x', 'v.mp4'), 'x')
    for (const name of ['bot-me', 'bot-dead', 'api-temp', 'bot-file'])
      await utimes(join(root, name), old, old)
    expect(await sweep(root, mine)).toEqual(['bot-dead'])
    for (const name of ['bot-me', 'bot-alive', 'api-temp', 'bot-file'])
      expect(existsSync(join(root, name))).toBe(true)
    expect(existsSync(join(root, 'bot-dead'))).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a shared dir sends files by path and opens them to the Bot API server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scratch-'))
  try {
    const s = scratch(`${root}/`)
    expect(s.dir).toBe(join(root, `bot-${hostname()}`))
    expect(s.env).toEqual({ TMPDIR: s.dir })
    expect(s.local('/scratch/bot-a/job-1/v.mp4')).toBe('file:///scratch/bot-a/job-1/v.mp4')
    await mkdir(join(s.dir, 'job-1'), { recursive: true, mode: 0o700 })
    await writeFile(join(s.dir, 'job-1', 'v.mp4'), 'x', { mode: 0o600 })
    await s.open(join(s.dir, 'job-1'))
    await s.open(join(s.dir, 'job-1', 'v.mp4'), true)
    expect((await stat(join(s.dir, 'job-1'))).mode & 0o777).toBe(0o711)
    expect((await stat(join(s.dir, 'job-1', 'v.mp4'))).mode & 0o777).toBe(0o644)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('without a shared dir files upload as before', () => {
  const s = scratch('')
  expect(s.root).toBeUndefined()
  expect(s.dir).toBe(join(tmpdir(), 'videodownloadbot'))
  expect(s.local('/tmp/videodownloadbot/job-1/v.mp4')).toBeUndefined()
  expect(s.env).toEqual({})
})

test('start empties its own folder and sweeps dead ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scratch-'))
  try {
    const s = scratch(root)
    const old = new Date(Date.now() - 11 * 60_000)
    await mkdir(join(s.dir, 'job-left'), { recursive: true })
    await mkdir(join(root, 'bot-dead'))
    await mkdir(join(root, 'bot-alive'))
    await utimes(join(root, 'bot-dead'), old, old)
    await s.start()
    expect(await readdir(s.dir)).toEqual([])
    expect((await stat(s.dir)).mode & 0o777).toBe(0o711)
    expect(Date.now() - (await stat(s.dir)).mtimeMs).toBeLessThan(60_000)
    expect((await readdir(root)).sort()).toEqual(['bot-alive', `bot-${hostname()}`].sort())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
