/**
 * Build lock: an exclusively created file (`wx` = O_CREAT|O_EXCL) naming the
 * owning pid. A lock whose pid is no longer alive is stale and may be reclaimed.
 *
 * Caveat: worker threads share their process's pid, so a lock left by a
 * terminated worker looks "alive" to this check. The desktop shell knows when no
 * rebuild is in flight and removes such orphans itself (see
 * `src/main/index-manager.ts` `releaseOrphanLock`).
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'

export interface LockInfo {
  pid: number
  started_at: string
  generation: string
  host: string
}

function isPidRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class BuildLock {
  constructor(readonly path: string) {}

  exists(): boolean {
    return existsSync(this.path)
  }

  read(): LockInfo | null {
    try {
      const d = JSON.parse(readFileSync(this.path, 'utf8'))
      return { pid: Number(d.pid), started_at: String(d.started_at), generation: String(d.generation), host: String(d.host ?? '') }
    } catch {
      return null
    }
  }

  /** Try to take the lock; returns false when another live builder holds it. */
  acquire(generation: string): boolean {
    if (this.exists() && this.isStale()) this.release()
    let fd: number
    try {
      fd = openSync(this.path, 'wx')
    } catch {
      return false
    }
    try {
      const info: LockInfo = { pid: process.pid, started_at: new Date().toISOString(), generation, host: hostname() }
      writeSync(fd, JSON.stringify(info, null, 2))
    } finally {
      closeSync(fd)
    }
    return true
  }

  isStale(): boolean {
    const info = this.read()
    return info === null || !isPidRunning(info.pid)
  }

  release(): void {
    try { unlinkSync(this.path) } catch { /* already gone */ }
  }
}
