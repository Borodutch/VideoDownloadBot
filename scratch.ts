import { chmod, mkdir, readdir, rm, stat, statfs, utimes } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PREFIX = 'bot-'
// A container that hasn't touched its folder for this long is gone
const STALE = 10 * 60_000
const TMPFS = 0x01021994

/**
 * Where jobs keep their files: the container's own /tmp, unless SHARED_DIR names a directory the local Bot API
 * server mounts at the same path (on hetzner-main a size-capped tmpfs, so the media never hits the shared disk).
 * Then files upload by their path (file://, which a --local server reads itself) instead of as a second copy over
 * HTTP. Old and new containers overlap during a deploy, so each keeps its own folder there and touches it every
 * minute; the folders of containers that died are swept after STALE. yt-dlp gets it as TMPDIR too: the release
 * binary is a PyInstaller one-file build that unpacks ~85 MB into TMPDIR on every run, link checks included.
 */
export function scratch(shared = process.env.SHARED_DIR?.trim()) {
  const root = shared ? resolve(shared) : undefined
  const dir = root ? join(root, `${PREFIX}${hostname()}`) : join(tmpdir(), 'videodownloadbot')
  return {
    root,
    dir,
    // For yt-dlp's environment
    env: root ? { TMPDIR: dir } : {},
    // What a fresh file is sent as: its file:// URI or an upload
    local: (path: string) => (root ? `file://${path}` : undefined),
    // The Bot API server runs as another user: folders it needs get o+x, files o+r
    open: (path: string, file = false) =>
      root ? chmod(path, file ? 0o644 : 0o711) : Promise.resolve(),
    // Empties this container's folder (a restarted container keeps its hostname, so its leftovers go too) and
    // keeps it alive for the others' sweeps
    async start() {
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true, mode: 0o711 })
      if (!root) return
      await this.open(dir)
      // a mount that failed at boot leaves the plain folder on the disk underneath
      const fs = await statfs(root).catch(() => undefined)
      if (fs?.type !== TMPFS) console.warn(`SHARED_DIR ${root} isn't a tmpfs, downloads go to disk`)
      const beat = async () => {
        const now = new Date()
        // back if a sweep took it anyway (the clock jumped, the container sat paused)
        await mkdir(dir, { recursive: true, mode: 0o711 }).catch(console.error)
        await utimes(dir, now, now).catch(console.error)
        await sweep(root, dir).catch(console.error)
      }
      await beat()
      setInterval(beat, 60_000).unref()
    },
  }
}

// Removes the folders other containers left behind; anything else in root (the Bot API server's temp files) stays
export async function sweep(root: string, mine: string, now = Date.now(), stale = STALE) {
  const gone: string[] = []
  for (const name of await readdir(root)) {
    const path = join(root, name)
    if (!name.startsWith(PREFIX) || path === mine) continue
    const s = await stat(path).catch(() => undefined)
    if (!s?.isDirectory() || now - s.mtimeMs < stale) continue
    await rm(path, { recursive: true, force: true })
    gone.push(name)
  }
  return gone
}
