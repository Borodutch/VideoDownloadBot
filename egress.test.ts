import { afterAll, expect, test } from 'bun:test'
import { createSocket } from 'node:dgram'
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { type AddressInfo, connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { YTDLP } from './bot'
import { closing, connectTarget, denyList, egressProxy, isPublicIp, proxyFreeEnv, readHead } from './egress'

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
const internalHost = (() => {
  try {
    Bun.serve({ hostname: '127.0.0.2', port: 0, fetch: () => new Response() }).stop()
    return '127.0.0.2'
  } catch {
    return '::1'
  }
})()
const servers: { stop: (now: boolean) => unknown }[] = []
afterAll(() => servers.forEach((s) => s.stop(true)))
// An internal service, and a "public" site that links and redirects into it:
// each test has its own (they run at once). hits = the paths the service served
function inner() {
  const hits: string[] = []
  const internal = Bun.serve({
    hostname: internalHost,
    port: 0,
    fetch: (req) => {
      hits.push(new URL(req.url).pathname)
      return new Response('secret', { headers: { 'content-type': 'video/mp4' } })
    },
  })
  const inside = `http://${internalHost.includes(':') ? `[${internalHost}]` : internalHost}:${internal.port}`
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
  servers.push(internal, site)
  return { hits, internal, inside, site }
}

const strict = egressProxy()
// what production does for real public hosts, with loopback 127.0.0.1 standing in
const publicOnly = egressProxy((ip) => ip === '127.0.0.1')
const open = egressProxy(() => true)

function raw(proxy: string, request: string) {
  const { hostname, port } = new URL(proxy)
  return new Promise<string>((ok, fail) => {
    let out = ''
    const s = connect({ host: hostname, port: Number(port) }, () => s.write(request))
    s.on('data', (d: Buffer) => (out += d.toString('latin1'))).on('end', () => ok(out)).on('error', fail)
  })
}

test('proxy refuses internal addresses, by literal or by name', async () => {
  const { hits, internal, inside } = inner()
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
  const { hits, inside } = inner()
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
  const { inside } = inner()
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

// What the client gets through the proxy from an upstream that writes these
// pieces, 30 ms apart, then closes
async function answered(...pieces: string[]) {
  const upstream = createServer((s) =>
    s
      .once('data', async () => {
        for (const [i, piece] of pieces.entries()) {
          if (i) await Bun.sleep(30)
          s.write(piece, 'latin1')
        }
        s.end()
      })
      .on('error', () => {}),
  )
  await new Promise<void>((ok) => upstream.listen(0, '127.0.0.1', ok))
  try {
    const { port } = upstream.address() as AddressInfo
    return await raw(await open, `GET http://127.0.0.1:${port}/x HTTP/1.1\r\nHost: x\r\n\r\n`)
  } finally {
    upstream.close()
  }
}

const closes = 'HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok'
const keeps = 'HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nContent-Length: 2\r\n\r\nok'

test('proxy: an answer says the connection closes after it, whatever the upstream said', async () => {
  // upstreams that close after answering: one says nothing about the
  // connection (as Bun's server), the other that it keeps it
  expect(await answered('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')).toBe(closes)
  expect(await answered(keeps)).toBe(closes)
})

// #462's cases, one test each: every one of them fails on #458's egress.ts

test("proxy: an answer's folded line is unfolded, so what continues a dropped field doesn't join the field before it", async () => {
  expect(
    await answered('HTTP/1.1 200 OK\r\nX: a,\r\n\tb\r\nConnection: keep-alive,\r\n Upgrade\r\nContent-Length: 2\r\n\r\nok'),
  ).toBe('HTTP/1.1 200 OK\r\nConnection: close\r\nX: a, b\r\nContent-Length: 2\r\n\r\nok')
  // and lines with blanks before them right after the status line, which
  // continue no field, are dropped rather than joining the close
  expect(await answered('HTTP/1.1 200 OK\r\n X: a\r\n\tb\r\nContent-Length: 2\r\n\r\nok')).toBe(closes)
})

const early = 'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: </a>; rel=preload\r\n\r\n'

test('proxy: informational answers go as they came, and the final one says the connection closes', async () => {
  const all = early + keeps
  // in one write, or in pieces that split the heads
  expect(await answered(all)).toBe(early + closes)
  const at = [9, 40, early.length + 30, all.length - 3]
  expect(await answered(...[0, ...at].map((a, i) => all.slice(a, at[i])))).toBe(early + closes)
})

// Python's http.client (yt-dlp's) takes the close for the head's end, so a
// redirect that ends so is followed, as it was before #458
test('proxy: an answer whose head the upstream ends by closing goes as it came', async () => {
  for (const answer of [
    'HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/v.mp4\r\nContent-Length: 0\r\n',
    'HTTP/1.1 200 OK\r\nContent-Le',
    // after informational heads too
    `${early}HTTP/1.1 200 OK\r\nContent-Le`,
  ])
    expect(await answered(answer)).toBe(answer)
})

// Python's http.client (yt-dlp's) splits a status line at any blank, takes
// any HTTP/1.x version and a code int() reads, so all of these keep the
// connection for it; a head whose status line it can't read is a final one too
test('proxy: a final answer says the connection closes, whatever its status line looks like', async () => {
  for (const status of [
    'HTTP/1.1  200 OK',
    'HTTP/1.1\t200 OK',
    'HTTP/1.2 200 OK',
    'HTTP/1.1 0200 OK',
    ' HTTP/1.1 200 OK',
    'HTTP/1.1\v200 OK',
    'HTTP/1.1\x85200 OK',
    'HTTP/1.1 +200 OK',
    'HTTP/1.1 2_00 OK',
    'ICY 200 OK',
  ])
    expect(await answered(`${status}\r\nConnection: keep-alive\r\nContent-Length: 2\r\n\r\nok`)).toBe(
      `${status}\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok`,
    )
  // and informational heads that it reads as such go as they came
  for (const status of ['HTTP/1.1  100 Continue', 'HTTP/1.1\x1c100 Continue', 'HTTP/1.1 +1_00 Continue'])
    expect(await answered(`${status}\r\n\r\n${keeps}`)).toBe(`${status}\r\n\r\n${closes}`)
})

// Python's header parser takes no field after a line without a colon, with a
// blank before it or with a byte past ASCII in its name
test('proxy: the close comes right after the status line, before a field line yt-dlp stops at', async () => {
  for (const junk of ['X-Junk value', 'Content-Type : text/plain', 'X-\xe9: a'])
    expect(
      await answered(`HTTP/1.1 302 Found\r\nLocation: /v\r\nContent-Length: 0\r\n${junk}\r\nConnection: keep-alive\r\n\r\n`),
    ).toBe(`HTTP/1.1 302 Found\r\nConnection: close\r\nLocation: /v\r\nContent-Length: 0\r\n${junk}\r\n\r\n`)
})

test('proxy: a head that ends in "LF CRLF" ends there, as clients end it, and goes as it came', async () => {
  // not at the body's CRLF CRLF (whose lines aren't fields), nor at the close
  for (const answer of [
    'HTTP/1.1 200 OK\r\nContent-Length: 29\r\nX: a\n\r\nline1\r\nConnection: x\r\n\r\nline2',
    'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nX: a\n\r\nok',
  ])
    expect(await answered(answer)).toBe(answer)
})

// Python's header parser splits lines at a bare CR, and ffmpeg doesn't: a
// line with one goes as it came, after the close, which comes before the
// Connection field Python finds past the CR
test('proxy: a head with a bare CR gets the close right after its status line, and its lines with a bare CR as they came', async () => {
  for (const rest of [
    'X: a\rConnection: keep-alive\r\nContent-Length: 2\r\n\r\nok',
    // whatever field the line starts with
    'Keep-Alive: 5\rX-Y: z\r\nContent-Length: 2\r\n\r\nok',
  ])
    expect(await answered(`HTTP/1.1 200 OK\r\n${rest}`)).toBe(`HTTP/1.1 200 OK\r\nConnection: close\r\n${rest}`)
  // its other Connection, Keep-Alive and Proxy-Connection fields go, with the
  // lines that continue them: for HTTP/1.0, Python keeps a connection with a
  // Keep-Alive or Proxy-Connection field, whatever Connection says
  expect(
    await answered(
      'HTTP/1.0 200 OK\r\nX: a\rY: b\r\nKeep-Alive: timeout=5\r\nConnection: keep-alive,\r\n Upgrade\r\nProxy-Connection: keep-alive\r\nContent-Length: 2\r\n\r\nok',
    ),
  ).toBe('HTTP/1.0 200 OK\r\nConnection: close\r\nX: a\rY: b\r\nContent-Length: 2\r\n\r\nok')
})

test('proxy: an answer whose head the client may read otherwise goes as it came', async () => {
  for (const answer of [
    // lines that end in a bare LF; the head's end is seen, and a CRLF CRLF in
    // the body isn't taken for it
    'HTTP/1.1 200 OK\nContent-Length: 2\n\nok',
    'HTTP/1.1 200 OK\nContent-Length: 6\n\nok\r\n\r\n',
    // past a 101 the connection is another protocol's: nothing in it is a head
    'HTTP/1.1 101 Switching Protocols\r\nConnection: upgrade\r\nUpgrade: x\r\n\r\nHTTP/1.1 200 OK\r\nConnection: keep-alive\r\n\r\n',
    // past 64 KB of 1xx heads, as from an upstream that never ends them,
    // nothing is a head either: they'd go to the client without waiting for it
    `${'HTTP/1.1 100 Continue\r\n\r\n'.repeat(3000)}HTTP/1.1 200 OK\r\nConnection: keep-alive\r\n\r\n`,
    // nor is 64 KB with no end
    `HTTP/1.1 200 OK\r\nConnection: keep-alive\r\n${'X: a\r\n'.repeat(12_000)}`,
  ])
    expect(await answered(answer)).toBe(answer)
})

// The CPU time f takes, in ms: unlike the clock's, it doesn't grow while a
// busy machine (CI runs every test file at once) runs something else
function cpu(f: () => void) {
  const was = process.cpuUsage()
  f()
  const { user, system } = process.cpuUsage(was)
  return (user + system) / 1000
}

// An upstream's head can be 64 KB of blanks, and the bot waits while a head
// is rewritten: an unfolding pattern that backtracked over them took 1-2 s
test('closing: long runs of blanks take linear time', () => {
  const head = `HTTP/1.1 200 OK\r\nX: a${' \t'.repeat(30_000)}\r\nY: b\r\n\r\n`
  let out = ''
  expect(cpu(() => (out = closing(Buffer.from(head, 'latin1')).toString('latin1')))).toBeLessThan(250)
  expect(out).toBe(`HTTP/1.1 200 OK\r\nConnection: close\r\n${head.slice(17)}`)
})

// An upstream can send its head a few bytes at a time, and each chunk is
// looked at on the bot's thread: looking at each chunk once and putting the
// head together once keeps that linear, where looking from the head's start
// on every chunk took over a second
test('readHead: a head that trickles in takes linear time', async () => {
  const s = Object.assign(new EventEmitter(), { destroyed: false, pause() {}, resume() {} })
  const read = readHead(s as unknown as Socket)
  // 64 KB of short lines, then the empty one, 16 bytes per chunk
  const head = Buffer.from(`HTTP/1.1 200 OK\r\n${'a\n'.repeat(32_000)}\n`, 'latin1')
  const trickle = () => {
    for (let at = 0; at < head.length; at += 16) s.emit('data', head.subarray(at, at + 16))
  }
  expect(cpu(trickle)).toBeLessThan(250)
  const { got, closed } = await read
  expect([got.equals(head), closed]).toEqual([true, false])
})

test('proxy: a request head with a bare CR or LF is refused', async () => {
  const { hits, inside } = inner()
  for (const head of ['HTTP/1.1\nHost: x\n\n', 'HTTP/1.1\r\nHost: x\n\r\n', 'HTTP/1.1\r\nX: a\rHost: x\r\n\r\n'])
    expect(await raw(await open, `GET ${inside}/x ${head}`)).toStartWith('HTTP/1.1 400')
  expect(hits).toEqual([])
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
// env: the bot's environment, which the bot clears of proxy variables
async function run(proxy: string, args: string[], env: Record<string, string | undefined> = process.env) {
  const dir = await mkdtemp(join(tmpdir(), 'egress-'))
  try {
    const p = Bun.spawn(
      ['yt-dlp', '--proxy', proxy, ...YTDLP, '--no-cache-dir', '-o', join(dir, 'v.%(ext)s'), ...args],
      // the same environment the bot gives it
      { env: proxyFreeEnv(env), stdout: 'pipe', stderr: 'pipe' },
    )
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
    return { code, err, files: await readdir(dir) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
// The failure report of a run that should get the file: what yt-dlp said,
// which tells why it didn't
const said = (r: { code: number; err: string }) => `yt-dlp exited ${r.code}, its stderr:\n${r.err || '(none)'}`

test.skipIf(!ytdlp)('yt-dlp: a public link redirecting inside is not fetched', async () => {
  const { hits, site } = inner()
  // control: without the restriction the redirect is followed and downloaded
  const control = await run(await open, [`http://127.0.0.1:${site.port}/redirect`])
  expect([control.code, control.files, hits[0]], said(control)).toEqual([0, ['v.mp4'], '/v.mp4'])
  hits.length = 0
  const r = await run(await publicOnly, [`http://127.0.0.1:${site.port}/redirect`])
  expect(r.code).not.toBe(0)
  expect(r.err).toContain('403')
  expect([r.files, hits]).toEqual([[], []])
}, 60_000)

// The proxy takes one request per connection, so yt-dlp, whose connection
// pool would keep one for its next request, must learn from the answer that it
// closes: a redirect's request sent on it gets no answer. The close alone
// tells yt-dlp only if it comes first, and a busy bot (or test) may send it
// late (#458). Here a relay to the proxy passes the close on only once yt-dlp
// has sent more on the connection, as late as it can come.
test.skipIf(!ytdlp)("yt-dlp: a redirect's request goes on a new connection to the proxy", async () => {
  const { hits, site } = inner()
  const proxy = new URL(await open)
  const relay = createServer((c) => {
    const p = connect({ host: proxy.hostname, port: Number(proxy.port), allowHalfOpen: true })
    let closed = false
    p.on('data', (d) => c.write(d)).on('end', () => (closed = true)).on('error', () => {}).on('close', () => c.destroy())
    c.on('data', (d) => (closed ? c.end() : p.write(d))).on('error', () => {}).on('close', () => p.destroy())
  })
  await new Promise<void>((ok) => relay.listen(0, '127.0.0.1', ok))
  try {
    const at = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
    const r = await run(at, [`http://127.0.0.1:${site.port}/redirect`])
    expect([r.code, r.files, hits[0]], said(r)).toEqual([0, ['v.mp4'], '/v.mp4'])
  } finally {
    relay.close()
  }
}, 60_000)

test.skipIf(!ytdlp)('yt-dlp: a public page embedding an internal video is not fetched', async () => {
  const { hits, site } = inner()
  const r = await run(await publicOnly, [`http://127.0.0.1:${site.port}/page`])
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
    const r = await run(await publicOnly, [`http://127.0.0.1:${hls.port}/v.m3u8`])
    expect(r.code).not.toBe(0)
    // ffmpeg did get the SDP, and opened nothing it points at
    expect(sdp, said(r)).toBeGreaterThan(0)
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
    const r = await run(await publicOnly, [`http://127.0.0.1:${hls.port}/v.m3u8`])
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
    const r = await run(await publicOnly, ['--downloader', 'm3u8:ffmpeg', `http://127.0.0.1:${hls.port}/v.m3u8`])
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
  const { hits, inside } = inner()
  const hls = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${inside}/s.ts\n#EXT-X-ENDLIST\n`, {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      }),
  })
  try {
    const link = `http://127.0.0.1:${hls.port}/v.m3u8`
    // control: unrestricted, ffmpeg does reach the internal segment
    const control = await run(await open, ['--downloader', 'm3u8:ffmpeg', link])
    expect(hits, said(control)).toContain('/s.ts')
    hits.length = 0
    const env = { ...process.env, no_proxy: internalHost, NO_PROXY: internalHost }
    const r = await run(await publicOnly, ['--downloader', 'm3u8:ffmpeg', link], env)
    expect([r.files, hits]).toEqual([[], []])
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('403')
  } finally {
    hls.stop(true)
  }
}, 60_000)

test('proxy: via hosts go through the upstream proxy, to the checked address only', async () => {
  const { hits, inside } = inner()
  const asked: string[] = []
  // a CONNECT proxy like wireproxy's; refuse=true answers 403 instead
  const upstream = (refuse: boolean) =>
    createServer((s) => {
      s.once('data', (d) => {
        const target = d.toString().split(' ')[1]!
        asked.push(target)
        if (refuse) return s.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        const [h, p] = [target.slice(0, target.lastIndexOf(':')), target.slice(target.lastIndexOf(':') + 1)]
        const out = connect({ host: h.replace(/^\[|\]$/g, ''), port: Number(p) }, () => {
          s.write('HTTP/1.1 200 Connection established\r\n\r\n')
          s.pipe(out).pipe(s)
        })
      }).on('error', () => {})
    })
  const ok = upstream(false)
  const no = upstream(true)
  await Promise.all([ok, no].map((u) => new Promise<void>((r) => u.listen(0, '127.0.0.1', r))))
  const at = (u: typeof ok) => `127.0.0.1:${(u.address() as AddressInfo).port}`
  try {
    const host = new URL(inside).host
    const req = `CONNECT ${host} HTTP/1.1\r\n\r\nGET /w HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`
    const through = await raw(await egressProxy(() => true, undefined, () => at(ok)), req)
    expect(through).toStartWith('HTTP/1.1 200 Connection Established\r\n\r\nHTTP/1.1 200')
    const plain = `GET ${inside}/g HTTP/1.1\r\nHost: x\r\n\r\n`
    expect(await raw(await egressProxy(() => true, undefined, () => at(ok)), plain)).toEndWith('secret')
    expect(asked).toEqual([host, host])
    expect(hits).toEqual(['/w', '/g'])
    // a refusing upstream is a 502; an internal address never reaches the upstream
    expect(await raw(await egressProxy(() => true, undefined, () => at(no)), req)).toStartWith('HTTP/1.1 502')
    expect(await raw(await egressProxy(undefined, undefined, () => at(ok)), req)).toStartWith('HTTP/1.1 403')
    expect(asked).toEqual([host, host, host])
  } finally {
    ok.close()
    no.close()
  }
})
