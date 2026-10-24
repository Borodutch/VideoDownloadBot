import { afterAll, expect, test } from 'bun:test'
import { createSocket } from 'node:dgram'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { type AddressInfo, connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { YTDLP } from './bot'
import { connectTarget, denyList, egressProxy, isPublicIp, proxyFreeEnv } from './egress'

test('isPublicIp: only public unicast passes', () => {
  for (const ip of ['1.1.1.1', '142.250.74.46', '2a00:1450:4001:82a::200e', '::ffff:8.8.8.8'])
    expect([ip, isPublicIp(ip)]).toEqual([ip, true])
  for (const ip of [
    '0.0.0.0', '10.0.1.5', '100.100.100.100', '127.0.0.1', '169.254.169.254',
    '172.17.0.1', '172.31.255.255', '192.168.1.1', '198.18.0.1', '224.0.0.1',
    '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    'fe80::1', 'fe80::1%eth0', 'fd00::1', 'fc00::1', 'ff02::1', '64:ff9b::a00:1',
    '2001:db8::1', '2001:0db8::1', '2001::1', '2001:0:4136::1', '2002:a00:1::1', 'localhost', '',
  ])
    expect([ip, isPublicIp(ip)]).toEqual([ip, false])
})

test('EGRESS_DENY: listed public addresses are refused', () => {
  const deny = denyList(' 1.2.3.4/32, 5.6.0.0/16,9.9.9.9 , 2a01:4f8:c0c:1::/64,')
  for (const ip of ['1.2.3.4', '5.6.200.1', '9.9.9.9', '::ffff:1.2.3.4', '2a01:4f8:c0c:1::1', '2A01:4F8:C0C:1:FFFF::2'])
    expect([ip, isPublicIp(ip, deny)]).toEqual([ip, false])
  for (const ip of ['1.2.3.5', '5.7.0.1', '9.9.9.10', '2a01:4f8:c0c:2::1', '1.1.1.1'])
    expect([ip, isPublicIp(ip, deny)]).toEqual([ip, true])
  for (const bad of ['1.2.3.4/33', '2a01::/129', 'example.com', '1.2.3/24', '1.2.3.4/', '1.2.3.4/8/1', '1.2.3.4/x'])
    expect(() => denyList(bad)).toThrow('EGRESS_DENY')
  expect(isPublicIp('1.2.3.4', denyList(''))).toBe(true)
})

test('yt-dlp env: every proxy variable is dropped, the rest kept', () => {
  expect(
    proxyFreeEnv({
      PATH: '/bin', no_proxy: 'a', NO_PROXY: 'a', all_proxy: 'x', HTTP_PROXY: 'x',
      https_proxy: 'x', FTP_PROXY: 'x', MY_PROXY: 'k', proxy: 'k',
    }),
  ).toEqual({ PATH: '/bin', MY_PROXY: 'k', proxy: 'k' })
})

test('CONNECT target: the port as written, 443 only when there is none', () => {
  expect(connectTarget('example.com:80')).toEqual({ host: 'example.com', port: 80 })
  expect(connectTarget('example.com:443')).toEqual({ host: 'example.com', port: 443 })
  expect(connectTarget('Example.COM:8443')).toEqual({ host: 'example.com', port: 8443 })
  expect(connectTarget('example.com')).toEqual({ host: 'example.com', port: 443 })
  expect(connectTarget('[2001:db8::1]:80')).toEqual({ host: '[2001:db8::1]', port: 80 })
  expect(connectTarget('[2001:db8::1]')).toEqual({ host: '[2001:db8::1]', port: 443 })
  for (const bad of ['a.b:99999', 'u@a.b:80', 'a.b:80/x', 'a.b/x:80', 'a.b:80?x', '::1'])
    expect(() => connectTarget(bad)).toThrow()
})

// "Internal" services on loopback: 127.0.0.2 on Linux, ::1 where only
// 127.0.0.1 is configured (macOS)
const hits: string[] = []
const handler = (req: Request) => {
  hits.push(new URL(req.url).pathname)
  return new Response('secret', { headers: { 'content-type': 'video/mp4' } })
}
const internalHost = (() => {
  try {
    Bun.serve({ hostname: '127.0.0.2', port: 0, fetch: () => new Response() }).stop()
    return '127.0.0.2'
  } catch {
    return '::1'
  }
})()
const internal = Bun.serve({ hostname: internalHost, port: 0, fetch: handler })
const inside = `http://${internalHost.includes(':') ? `[${internalHost}]` : internalHost}:${internal.port}`
// The "public" site links and redirects into it
const site = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (req) =>
    new URL(req.url).pathname === '/redirect'
      ? Response.redirect(`${inside}/v.mp4`, 302)
      : new Response(`<html><body><video src="${inside}/v.mp4"></video></body></html>`, {
          headers: { 'content-type': 'text/html' },
        }),
})
afterAll(() => {
  internal.stop(true)
  site.stop(true)
})

const strict = egressProxy()
// what production does for real public hosts, with loopback 127.0.0.1 standing in
const publicOnly = egressProxy((ip) => ip === '127.0.0.1')
const open = egressProxy(() => true)

function raw(proxy: string, request: string) {
  const { hostname, port } = new URL(proxy)
  return new Promise<string>((ok, fail) => {
    let out = ''
    const s = connect({ host: hostname, port: Number(port) }, () => s.write(request))
    s.on('data', (d) => (out += d)).on('end', () => ok(out)).on('error', fail)
  })
}

test('proxy refuses internal addresses, by literal or by name', async () => {
  hits.length = 0
  const p = await strict
  const { port } = internal
  for (const req of [
    `GET ${inside}/x HTTP/1.1\r\nHost: x\r\n\r\n`,
    `GET http://localhost:${port}/x HTTP/1.1\r\nHost: x\r\n\r\n`,
    `CONNECT ${new URL(inside).host} HTTP/1.1\r\n\r\n`,
    `CONNECT localhost:${port} HTTP/1.1\r\n\r\n`,
    `CONNECT 2130706433:${port} HTTP/1.1\r\n\r\n`,
    `GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\n\r\n`,
  ])
    expect(await raw(p, req)).toStartWith('HTTP/1.1 403')
  expect(await raw(p, `GET /x HTTP/1.1\r\n\r\n`)).toStartWith('HTTP/1.1 400')
  expect(await raw(p, `GET ftp://a.b/x HTTP/1.1\r\n\r\n`)).toStartWith('HTTP/1.1 400')
  expect(hits).toEqual([])
})

test('proxy forwards allowed hosts: absolute-form and CONNECT', async () => {
  hits.length = 0
  const p = await open
  const viaGet = await raw(p, `GET ${inside}/a?b=1 HTTP/1.1\r\nHost: x\r\nProxy-Connection: keep-alive\r\n\r\n`)
  expect(viaGet).toStartWith('HTTP/1.1 200')
  expect(viaGet).toEndWith('secret')
  const viaConnect = await raw(
    p,
    `CONNECT ${new URL(inside).host} HTTP/1.1\r\n\r\nGET /c HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
  )
  expect(viaConnect).toStartWith('HTTP/1.1 200 Connection Established\r\n\r\nHTTP/1.1 200')
  expect(hits).toEqual(['/a', '/c'])
})

test('proxy: raw path and sized body go through, nothing after them does', async () => {
  // an upstream that answers without closing and records all it receives
  let seen = ''
  const sticky = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(s, d) {
        seen += d
        if (seen.includes('\r\n\r\nhi')) s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')
      },
    },
  })
  const { hostname, port } = new URL(await open)
  const reused = await new Promise<string>((ok) => {
    let out = ''
    const s = connect({ host: hostname, port: Number(port) }, () =>
      s.write(
        `POST http://127.0.0.1:${sticky.port}/a/%2e%2e/b?s={x} HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\nhi`,
      ),
    )
    s.on('data', (d) => {
      out += d
      // the response came back: now try to reuse the connection for another host
      if (out.endsWith('ok')) s.write('GET http://other.example/x HTTP/1.1\r\nHost: other.example\r\n\r\n')
    })
    s.on('close', () => ok(out))
  })
  sticky.stop(true)
  expect(reused).toStartWith('HTTP/1.1 200 OK')
  expect(seen).toStartWith(
    `POST /a/%2e%2e/b?s={x} HTTP/1.1\r\nHost: 127.0.0.1:${sticky.port}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi`,
  )
  expect(seen).not.toContain('other.example')
  expect(
    await raw(await open, `POST ${inside}/x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n`),
  ).toStartWith('HTTP/1.1 400')
})

test('proxy: an upstream killed by its idle timer closes the client too', async () => {
  // an upstream that takes the request and never answers or closes
  const stalled = createServer((s) => s.on('data', () => {}).on('error', () => {}))
  await new Promise<void>((ok) => stalled.listen(0, '127.0.0.1', ok))
  const { port } = stalled.address() as AddressInfo
  const p = await egressProxy(() => true, 300)
  try {
    for (const req of [
      `GET http://127.0.0.1:${port}/x HTTP/1.1\r\nHost: x\r\n\r\n`,
      `CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\nGET /x HTTP/1.1\r\nHost: x\r\n\r\n`,
    ]) {
      const t = Date.now()
      // the client's own timer is minutes away: only the upstream's can end
      // this (Bun ends a destroyed socket anyway, Node needs the explicit close)
      await raw(p, req)
      expect(Date.now() - t).toBeLessThan(3000)
    }
  } finally {
    stalled.close()
  }
})

test('proxy: a request body waits for a slow upstream instead of piling up', async () => {
  // an upstream that stops reading right away
  const stuck: Socket[] = []
  const slow = createServer((s) => void stuck.push(s.pause().on('error', () => {})))
  await new Promise<void>((ok) => slow.listen(0, '127.0.0.1', ok))
  const { port } = slow.address() as AddressInfo
  const size = 64 * 1024 * 1024
  const { hostname, port: proxyPort } = new URL(await open)
  const s = connect({ host: hostname, port: Number(proxyPort) })
  s.on('error', () => {})
  await new Promise((ok) => s.once('connect', ok))
  s.write(`POST http://127.0.0.1:${port}/x HTTP/1.1\r\nHost: x\r\nContent-Length: ${size}\r\n\r\n`)
  s.write(Buffer.alloc(size))
  await Bun.sleep(1000)
  // the proxy stopped taking the body: most of it is still on the client side
  const pending = s.writableLength
  s.destroy()
  for (const u of stuck) u.destroy()
  slow.close()
  expect(pending).toBeGreaterThan(size / 2)
})

// CI installs yt-dlp; elsewhere these only run where it is
const ytdlp = Bun.which('yt-dlp') || process.env.CI
async function run(proxy: string, ...args: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'egress-'))
  try {
    const p = Bun.spawn(
      ['yt-dlp', '--proxy', proxy, ...YTDLP, '--no-cache-dir', '-o', join(dir, 'v.%(ext)s'), ...args],
      // the same environment the bot gives it
      { env: proxyFreeEnv(), stdout: 'pipe', stderr: 'pipe' },
    )
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
    return { code, err, files: await readdir(dir) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test.skipIf(!ytdlp)('yt-dlp: a public link redirecting inside is not fetched', async () => {
  hits.length = 0
  // control: without the restriction the redirect is followed and downloaded
  const control = await run(await open, `http://127.0.0.1:${site.port}/redirect`)
  expect([control.code, control.files, hits[0]]).toEqual([0, ['v.mp4'], '/v.mp4'])
  hits.length = 0
  const r = await run(await publicOnly, `http://127.0.0.1:${site.port}/redirect`)
  expect(r.code).not.toBe(0)
  expect(r.err).toContain('403')
  expect([r.files, hits]).toEqual([[], []])
}, 60_000)

test.skipIf(!ytdlp)('yt-dlp: a public page embedding an internal video is not fetched', async () => {
  hits.length = 0
  const r = await run(await publicOnly, `http://127.0.0.1:${site.port}/page`)
  expect(r.code).not.toBe(0)
  expect([r.files, hits]).toEqual([[], []])
}, 60_000)

// SAMPLE-AES makes yt-dlp hand the playlist URL to ffmpeg, and ffmpeg (it sends
// Icy-MetaData) gets an SDP pointing at an "internal" UDP service instead
const ffmpeg = Bun.which('ffmpeg') || process.env.CI
test.skipIf(!ytdlp || !ffmpeg)('yt-dlp: ffmpeg is not steered into direct rtp/udp', async () => {
  const got: string[] = []
  const udp = createSocket('udp4').on('message', (m) => got.push(String(m)))
  await new Promise<void>((ok) => udp.bind(0, '127.0.0.1', ok))
  const { port } = udp.address()
  let sdp = 0
  const hls = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) =>
      req.headers.get('icy-metadata') && ++sdp
        ? new Response(
            `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=x\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=video ${port} RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n`,
            { headers: { 'content-type': 'application/sdp' } },
          )
        : new Response(
            '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="http://127.0.0.1/k"\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST\n',
            { headers: { 'content-type': 'application/vnd.apple.mpegurl' } },
          ),
  })
  try {
    const r = await run(await publicOnly, `http://127.0.0.1:${hls.port}/v.m3u8`)
    expect(r.code).not.toBe(0)
    // ffmpeg did get the SDP, and opened nothing it points at
    expect(sdp).toBeGreaterThan(0)
    expect(r.err).not.toMatch(/\[(udp|rtp) @/)
    await Bun.sleep(200)
    expect([r.files, got]).toEqual([[], []])
  } finally {
    hls.stop(true)
    udp.close()
  }
}, 60_000)

// Same handoff, but ffmpeg gets an IMF playlist whose asset is a raw tcp://
// URL (tcp has to stay whitelisted for http). Debian's ffmpeg, which the image
// and CI ship, has the IMF demuxer; Homebrew's doesn't.
const imf =
  process.env.CI ||
  (ffmpeg && / imf /.test(Bun.spawnSync(['ffmpeg', '-hide_banner', '-demuxers']).stdout.toString()))
test.skipIf(!ytdlp || !imf)('yt-dlp: ffmpeg demuxers do not open raw tcp to inside', async () => {
  let reached = 0
  const tcp = createServer((s) => {
    reached++
    s.destroy()
  })
  await new Promise<void>((ok) => tcp.listen(0, '127.0.0.1', ok))
  const { port } = tcp.address() as AddressInfo
  const asked: string[] = []
  const hls = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname
      asked.push(path)
      if (path === '/ASSETMAP.xml')
        return new Response(
          `<AssetMap xmlns="http://www.smpte-ra.org/schemas/429-9/2007/AM"><Id>urn:uuid:68d9f591-8191-46b5-9c49-6d0bd6b5d3b4</Id><AssetList><Asset><Id>urn:uuid:6f768ca4-c89e-4dac-9056-a29425d40ba1</Id><ChunkList><Chunk><Path>tcp://127.0.0.1:${port}/x</Path></Chunk></ChunkList></Asset></AssetList></AssetMap>`,
        )
      return req.headers.get('icy-metadata')
        ? new Response(
            '<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016" xmlns:cc="http://www.smpte-ra.org/schemas/2067-2/2016" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Id>urn:uuid:8713c020-2489-45f5-a9f7-87be539e20b5</Id><ContentTitle>x</ContentTitle><EditRate>24 1</EditRate><SegmentList><Segment><Id>urn:uuid:81fed4e5-9722-400a-b9d1-7f2bd21df4b6</Id><SequenceList><cc:MainImageSequence><Id>urn:uuid:6ae100b0-92d1-41be-9321-85e0933dfc42</Id><TrackId>urn:uuid:e8ef9653-565c-479c-8039-82d4547973c5</TrackId><ResourceList><Resource xsi:type="TrackFileResourceType"><Id>urn:uuid:7d418acb-07a3-4e57-984c-b8ea2f7de4ec</Id><IntrinsicDuration>24</IntrinsicDuration><TrackFileId>urn:uuid:6f768ca4-c89e-4dac-9056-a29425d40ba1</TrackFileId></Resource></ResourceList></cc:MainImageSequence></SequenceList></Segment></SegmentList></CompositionPlaylist>',
          )
        : new Response(
            '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="http://127.0.0.1/k"\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST\n',
            { headers: { 'content-type': 'application/vnd.apple.mpegurl' } },
          )
    },
  })
  try {
    const r = await run(await publicOnly, `http://127.0.0.1:${hls.port}/v.m3u8`)
    expect(r.code).not.toBe(0)
    await Bun.sleep(200)
    // ffmpeg got the playlist but never read it as IMF
    expect([r.files, asked.at(-1), asked.includes('/ASSETMAP.xml'), reached]).toEqual([
      [], '/v.m3u8', false, 0,
    ])
  } finally {
    hls.stop(true)
    tcp.close()
  }
}, 60_000)

// the whitelist still lets ffmpeg download real HLS through the proxy
test.skipIf(!ytdlp || !ffmpeg)('yt-dlp: ffmpeg still downloads HLS through the proxy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'egress-hls-'))
  const made = Bun.spawnSync([
    'ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10',
    '-c:v', 'libx264', '-f', 'mpegts', join(dir, 's.ts'),
  ])
  expect(made.exitCode).toBe(0)
  const seg = Bun.file(join(dir, 's.ts'))
  const hls = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === '/s.ts'
        ? new Response(seg)
        : new Response('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\ns.ts\n#EXT-X-ENDLIST\n', {
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }),
  })
  try {
    const r = await run(await publicOnly, '--downloader', 'm3u8:ffmpeg', `http://127.0.0.1:${hls.port}/v.m3u8`)
    expect(r).toMatchObject({ code: 0, files: ['v.mp4'] })
  } finally {
    hls.stop(true)
    await rm(dir, { recursive: true, force: true })
  }
}, 60_000)

// yt-dlp hands the playlist to ffmpeg, whose own HTTP fetches a segment
// inside. A NO_PROXY for it in the bot's environment must not let ffmpeg go
// there directly (yt-dlp gives it the proxy as http_proxy, no_proxy overrides).
test.skipIf(!ytdlp || !ffmpeg)('yt-dlp: ffmpeg does not fetch an internal segment', async () => {
  const hls = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${inside}/s.ts\n#EXT-X-ENDLIST\n`, {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      }),
  })
  const saved = { no_proxy: process.env.no_proxy, NO_PROXY: process.env.NO_PROXY }
  try {
    const link = `http://127.0.0.1:${hls.port}/v.m3u8`
    // control: unrestricted, ffmpeg does reach the internal segment
    hits.length = 0
    await run(await open, '--downloader', 'm3u8:ffmpeg', link)
    expect(hits).toContain('/s.ts')
    hits.length = 0
    process.env.no_proxy = process.env.NO_PROXY = internalHost
    const r = await run(await publicOnly, '--downloader', 'm3u8:ffmpeg', link)
    expect([r.files, hits]).toEqual([[], []])
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('403')
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    hls.stop(true)
  }
}, 60_000)
