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

// Resolves with everything read up to the end of the request head, or null
function readHead(client: Socket) {
  return new Promise<Buffer | null>((r) => {
    let head = Buffer.alloc(0)
    const data = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      if (head.includes('\r\n\r\n') || head.length > 64 * 1024) {
        client.off('data', data).pause()
        r(head)
      }
    }
    client.on('data', data).once('close', () => r(null))
  })
}

async function serve(client: Socket, allow: (ip: string) => boolean, idle: number) {
  client.setTimeout(5 * 60_000, () => client.destroy())
  client.on('error', () => {})
  const head = await readHead(client)
  if (!head) return
  const end = head.indexOf('\r\n\r\n')
  if (end < 0) return reply(client, '431 Request Header Fields Too Large')
  const lines = head.subarray(0, end).toString('latin1').split('\r\n')
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
  const upstream = connect({ host: ip, port })
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
  upstream.once('connect', () => {
    open = true
    const rest = head.subarray(end + 4)
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
    } else {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (rest.length) upstream.write(rest)
      client.pipe(upstream)
    }
    upstream.pipe(client)
    if (!upstream.writableNeedDrain) client.resume()
  })
}

// Listens on loopback only; resolves to the proxy URL for --proxy
export function egressProxy(allow = (ip: string) => isPublicIp(ip), upstreamIdle = 5 * 60_000) {
  const server = createServer((s) => void serve(s, allow, upstreamIdle).catch(() => s.destroy()))
  return new Promise<string>((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const a = server.address()
      ok(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`)
    })
  })
}
