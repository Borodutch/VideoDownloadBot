import { lookup } from 'node:dns/promises'
import { BlockList, connect, createServer, isIP, type Socket } from 'node:net'

// yt-dlp runs inside the docker network and follows redirects, so a public
// link can bounce it to the Bot API server, another container or a metadata
// endpoint. All of its traffic goes through this proxy, which resolves every
// host itself, refuses anything but public unicast addresses and connects to
// the very address it checked (no DNS rebinding in between).

const blocked = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8], // this network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT, Tailscale
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private, docker bridges
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 3], // multicast, reserved, broadcast
] as const)
  blocked.addSubnet(net, bits, 'ipv4')

// The host's own public addresses look public but lead to every port docker
// publishes on it, so the operator lists them: comma-separated addresses or
// CIDRs, IPv4 and IPv6. A bad entry throws, at startup for EGRESS_DENY.
export function denyList(spec: string) {
  const list = new BlockList()
  for (const entry of spec.split(',').map((e) => e.trim()).filter(Boolean)) {
    const [net = '', bits, extra] = entry.split('/')
    const family = isIP(net)
    const max = family === 4 ? 32 : 128
    const prefix = bits === undefined ? max : /^\d+$/.test(bits) ? Number(bits) : NaN
    if (!family || extra !== undefined || !(prefix >= 0 && prefix <= max))
      throw new Error(`EGRESS_DENY: bad entry ${entry}`)
    list.addSubnet(net, prefix, family === 4 ? 'ipv4' : 'ipv6')
  }
  return list
}

const denied = denyList(process.env.EGRESS_DENY ?? '')

// The environment for yt-dlp: it hands ffmpeg the proxy as http_proxy, which
// a no_proxy overrides, and other proxy variables could let requests skip it
export function proxyFreeEnv(env: Record<string, string | undefined> = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => !/^(no|all|https?|ftp)_proxy$/i.test(k)),
  )
}

export function isPublicIp(ip: string, deny = denied): boolean {
  if (isIP(ip) === 4) return !blocked.check(ip, 'ipv4') && !deny.check(ip, 'ipv4')
  if (isIP(ip) !== 6) return false
  const v6 = ip.toLowerCase()
  // IPv4-mapped (::ffff:a.b.c.d) answers for the IPv4 address inside
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPublicIp(mapped[1]!, deny)
  // Only global unicast 2000::/3, minus Teredo, 6to4 and documentation
  return (
    /^[23][0-9a-f]{0,3}:/.test(v6) &&
    !/^(2001:0?db8:|2001:0{0,4}:|2002:)/.test(v6) &&
    !deny.check(v6, 'ipv6')
  )
}

async function resolve(host: string, allow: (ip: string) => boolean) {
  const ips = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((a) => a.address)
  // one internal answer is enough to refuse: no picking between records
  if (!ips.length || !ips.every(allow)) return
  return ips.find((ip) => isIP(ip) === 4) ?? ips[0]
}

const reply = (s: Socket, status: string) =>
  s.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)

const hop = /^(host|connection|keep-alive|proxy-connection|proxy-authorization)$/i

// CONNECT host:port. The port comes from the target itself: URL drops a
// default one, so http://host:80 would read as no port at all.
export function connectTarget(target: string) {
  const url = new URL(`http://${target}`)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error(target)
  const port = target.match(/:(\d+)$/)?.[1]
  return { host: url.hostname, port: port === undefined ? 443 : Number(port) }
}

// Where a head ends: just past its first empty line, as clients read it (a
// line ends at an LF, a CR before it dropped), within the first 64 KB; or -1.
// It reads no further than that line.
function headEnd(b: Buffer) {
  const max = Math.min(b.length, 64 * 1024)
  for (let lf = b.indexOf(10); lf >= 0 && lf < max; lf = b.indexOf(10, lf + 1)) {
    const next = b[lf + 1] === 13 ? lf + 2 : lf + 1
    if (next < max && b[next] === 10) return next + 1
  }
  return -1
}

// A CR or LF outside a CRLF. Clients may split a head with one into other
// lines than its CRLFs make, so such a head isn't taken apart line by line
const bare = /\r(?!\n)|(?<!\r)\n/
const bareLf = /(?<!\r)\n/

// Resolves with buf and what s sends after it, up to the chunk that ends a
// head (or passes 64 KB), leaving s paused; closed if s closed first
export function readHead(s: Socket, buf: Buffer = Buffer.alloc(0)) {
  return new Promise<{ got: Buffer; closed: boolean }>((r) => {
    if (headEnd(buf) >= 0 || buf.length > 64 * 1024) return r({ got: buf, closed: false })
    if (s.destroyed) return r({ got: buf, closed: true })
    // Each chunk is looked at once, after the last two bytes before it (an end
    // not seen yet can only start at an LF in them), and the head is put
    // together once: a head that trickles in costs linear time. (Looking from
    // its start on every chunk let an upstream keep the bot's thread busy,
    // #462.)
    const chunks = [buf]
    let length = buf.length
    let last = buf.subarray(-2)
    const data = (chunk: Buffer) => {
      chunks.push(chunk)
      length += chunk.length
      const seen = Buffer.concat([last, chunk])
      if (headEnd(seen) < 0 && length <= 64 * 1024) return void (last = seen.subarray(-2))
      s.off('data', data).off('close', closed).pause()
      r({ got: Buffer.concat(chunks, length), closed: false })
    }
    const closed = () => {
      s.off('data', data)
      r({ got: Buffer.concat(chunks, length), closed: true })
    }
    s.on('data', data).once('close', closed).resume()
  })
}

// via(host) names an HTTP proxy (host:port) to reach that host through, the
// WARP tunnel for YouTube (#415); the address is still checked here first and
// the tunnel is asked for that very address, never the name
export type Via = (host: string) => string | undefined

async function serve(client: Socket, allow: (ip: string) => boolean, idle: number, via: Via) {
  client.setTimeout(5 * 60_000, () => client.destroy())
  client.on('error', () => {})
  const { got: head, closed } = await readHead(client)
  if (closed) return
  const end = headEnd(head)
  if (end < 0) return reply(client, '431 Request Header Fields Too Large')
  const text = head.toString('latin1', 0, end)
  // an upstream could read other lines in it than these
  if (bare.test(text)) return reply(client, '400 Bad Request')
  const lines = text.slice(0, -4).split('\r\n')
  const [method, target, version, extra] = lines[0]!.split(' ')
  const fields = (name: string) =>
    lines
      .slice(1)
      .filter((l) => l.split(':')[0]!.trim().toLowerCase() === name)
      .map((l) => l.slice(l.indexOf(':') + 1).trim())
  let host: string, port: number, request: Buffer | undefined
  let body = 0
  try {
    if (!method || !target || !/^HTTP\/1\.[01]$/.test(version ?? '') || extra)
      throw new Error(lines[0])
    if (method === 'CONNECT') {
      ;({ host, port } = connectTarget(target))
    } else {
      const url = new URL(target)
      if (url.protocol !== 'http:' || !/^http:\/\//i.test(target))
        throw new Error(target)
      host = url.hostname
      port = Number(url.port || 80)
      // the path as sent: a normalized one could break signed URLs
      const after = target.slice(7)
      const at = after.search(/[/?#]/)
      const path = (at < 0 ? '' : after.slice(at)).replace(/#.*/, '')
      // one request per connection, its body sized up front: whatever else
      // the client sends on it is dropped, never handed to this upstream
      const length = fields('content-length')
      if (fields('transfer-encoding').length || length.length > 1) throw new Error()
      if (length[0] !== undefined && !/^\d+$/.test(length[0])) throw new Error()
      body = Number(length[0] ?? 0)
      request = Buffer.from(
        [
          `${method} ${path.startsWith('/') ? path : `/${path}`} ${version}`,
          // the host it actually goes to, not whatever the client claimed
          `Host: ${url.host}`,
          ...lines.slice(1).filter((l) => !hop.test(l.split(':')[0]!.trim())),
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
        'latin1',
      )
    }
  } catch {
    return reply(client, '400 Bad Request')
  }
  host = host.replace(/^\[(.*)\]$/, '$1')
  let ip: string | undefined
  try {
    ip = await resolve(host, allow)
  } catch {
    return reply(client, '502 Bad Gateway')
  }
  if (!ip) {
    console.error('egress refused', host)
    return reply(client, '403 Forbidden')
  }
  // gone while resolving
  if (client.destroyed) return
  const hop2 = via(host)
  const upstream = connect(hop2 ? connectTarget(hop2) : { host: ip, port })
  let open = false
  // close the client too: a destroyed upstream doesn't end the piped client
  // on Node, and yt-dlp would sit on a dead connection
  upstream.setTimeout(idle, () => {
    upstream.destroy()
    open ? client.destroy() : reply(client, '504 Gateway Timeout')
  })
  upstream.on('error', () =>
    open ? client.destroy() : reply(client, '502 Bad Gateway'),
  )
  client.on('close', () => upstream.destroy())
  // through via's proxy: CONNECT to the checked address, then on as if direct
  const tunnel = async () => {
    const at = isIP(ip) === 6 ? `[${ip}]:${port}` : `${ip}:${port}`
    upstream.write(`CONNECT ${at} HTTP/1.1\r\nHost: ${at}\r\n\r\n`)
    const answer = await readHead(upstream)
    if (answer.closed || !/^HTTP\/1\.[01] 200 /.test(answer.got.toString('latin1'))) {
      upstream.destroy()
      return reply(client, '502 Bad Gateway')
    }
    go()
  }
  upstream.once('connect', () => (hop2 ? void tunnel() : go()))
  const go = () => {
    open = true
    const rest = head.subarray(end)
    if (request) {
      upstream.write(request)
      const forward = (chunk: Buffer) => {
        // past the body: a second request, maybe for another host
        if (chunk.length > body) return client.destroy()
        body -= chunk.length
        // a slow upstream: stop reading the body until it catches up
        if (!upstream.write(chunk)) client.pause()
      }
      upstream.on('drain', () => client.resume())
      if (rest.length) forward(rest)
      client.on('data', forward)
      void passAnswer(upstream, client)
    } else {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (rest.length) upstream.write(rest)
      client.pipe(upstream)
      upstream.pipe(client)
    }
    // readHead paused it after the tunnel's answer; Bun's pipe doesn't resume
    upstream.resume()
    if (!upstream.writableNeedDrain) client.resume()
  }
}

// The upstream's answer goes back saying the connection closes after it (RFC
// 9112 9.6: a server that doesn't keep connections MUST, in every answer but
// a 1xx). Upstreams asked to close mostly say so, but not all do (Bun's server
// doesn't), and a client that keeps the connection (yt-dlp's pool does) sends
// its next request, as a redirect's, on it: dropped, so it gets no answer
// (#458). Informational (1xx) heads before the final one go as they came.
async function passAnswer(upstream: Socket, client: Socket) {
  let got: Buffer = Buffer.alloc(0)
  // the 1xx heads passed on, which don't wait for the client to take them
  let early = 0
  for (;;) {
    const read = await readHead(upstream, got)
    got = read.got
    // Closed before a head ended: what came goes as it came, as before #458.
    // Clients (Python's http.client) take the close for the head's end, and
    // the connection closes with it
    if (read.closed) return void client.end(got)
    const end = headEnd(got)
    // no head in the first 64 KB: not one to change
    if (end < 0) break
    const head = got.subarray(0, end)
    const code = status(head)
    // A 101 hands the connection to another protocol: the rest goes as it
    // came, piped. Any head but a 1xx's is the final one, whatever its status
    // line says (as on #458), and says the connection closes. Past 64 KB of
    // 1xx heads (an upstream that never ends them) nothing is a head either.
    if (code === 101) break
    if (!(code >= 100 && code < 200)) {
      got = Buffer.concat([closing(head), got.subarray(end)])
      break
    }
    if ((early += end) > 64 * 1024) break
    client.write(head)
    got = got.subarray(end)
  }
  if (got.length) client.write(got)
  upstream.pipe(client)
  upstream.resume()
}

// The code in a head's status line as Python's http.client (yt-dlp's) reads
// it: the line split at any blank it knows, a version that starts with HTTP/,
// then a code int() takes ("0200", "+200" and "2_00" too); or NaN
function status(head: Buffer) {
  const line = head.toString('latin1', 0, head.indexOf(10))
  const [version, code = ''] = line.split(/[\t\n\v\f\r\x1c-\x1f \x85\xa0]+/).filter(Boolean)
  return version?.startsWith('HTTP/') && /^\+?\d+(_\d+)*$/.test(code) ? Number(code.replace(/_/g, '')) : NaN
}

// An answer's head with "Connection: close", right after the status line,
// instead of whatever it said about the connection (its Connection,
// Keep-Alive and Proxy-Connection fields go: for HTTP/1.0, Python keeps a
// connection with either of the last two, whatever Connection says). The
// close comes first because Python's header parser stops at a malformed field
// line, so a close after one would be lost. A head with a bare LF goes as it
// came, since its clients may end it elsewhere (a mixed "LF CRLF" ends it for
// them, #462). In one with a bare CR, which Python splits lines at and ffmpeg
// doesn't, the lines with one go as they came. Otherwise folded lines are
// unfolded first, as RFC 9112 5.2 has a proxy do, so a dropped field's
// continuation doesn't join the field before it (in a bare-CR head, which
// isn't unfolded, it goes with the field), and lines with blanks before them
// right after the status line, which continue no field, are dropped (RFC 9112
// 2.2) rather than fold into the close. (Blanks before a fold stay: matching
// them too takes quadratic time on a long run.)
export function closing(head: Buffer) {
  const text = head.toString('latin1')
  if (bareLf.test(text)) return head
  const at = text.indexOf('\r\n')
  const section = text.slice(at + 2, -4)
  const connection = (l: string) => /^(connection|keep-alive|proxy-connection)$/i.test(l.split(':')[0]!.trim())
  let fields: string[] = []
  if (bare.test(text)) {
    // whether the line goes, with the lines that continue it
    let drop = true
    for (const l of section ? section.split('\r\n') : []) {
      if (bare.test(l)) drop = false
      else if (!/^[ \t]/.test(l)) drop = connection(l)
      if (!drop) fields.push(l)
    }
  } else
    fields = section
      .replace(/\r\n[ \t]+/g, ' ')
      .split('\r\n')
      .filter((l) => /^[^ \t]/.test(l) && !connection(l))
  return Buffer.from([text.slice(0, at), 'Connection: close', ...fields, '', ''].join('\r\n'), 'latin1')
}

// Listens on loopback only; resolves to the proxy URL for --proxy
export function egressProxy(
  allow = (ip: string) => isPublicIp(ip),
  upstreamIdle = 5 * 60_000,
  via: Via = () => undefined,
) {
  const server = createServer((s) => void serve(s, allow, upstreamIdle, via).catch(() => s.destroy()))
  return new Promise<string>((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const a = server.address()
      ok(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`)
    })
  })
}
