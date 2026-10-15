/**
 * Index lifecycle: generations and the `current.json` pointer.
 *
 * Every build writes a NEW file `generation-NNNNNN.sqlite3`. Only after the
 * build completes and validates does `current.json` flip to it (atomic
 * write-then-rename). Consequences:
 * - a cancelled or crashed build never damages the index in use;
 * - readers never see a half-written database;
 * - old generations are deleted after a successful flip (best-effort — a file
 *   still open by a reader on Windows is simply retried next time).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BuildLock } from './locking.js'

export interface CurrentPointer {
  generation: string
  db_filename: string
  created_at: string
  fingerprint: string
  schema_version: number
  builder_version: number
  source_count: number
  line_count: number
  term_count: number
}

export class IndexLifecycle {
  constructor(readonly dir: string) {}

  get currentPath(): string {
    return join(this.dir, 'current.json')
  }

  lock(): BuildLock {
    return new BuildLock(join(this.dir, 'build.lock'))
  }

  ensureDirectory(): void {
    mkdirSync(this.dir, { recursive: true })
  }

  readCurrent(): CurrentPointer | null {
    try {
      const d = JSON.parse(readFileSync(this.currentPath, 'utf8'))
      if (typeof d?.db_filename !== 'string') return null
      return d as CurrentPointer
    } catch {
      return null
    }
  }

  writeCurrent(pointer: CurrentPointer): void {
    const tmp = `${this.currentPath}.tmp`
    writeFileSync(tmp, JSON.stringify(pointer, null, 2), 'utf8')
    renameSync(tmp, this.currentPath)
  }

  generationPath(generation: string): string {
    return join(this.dir, `${generation}.sqlite3`)
  }

  nextGeneration(): string {
    let n = 0
    for (const f of this.listGenerations()) n = Math.max(n, Number(/^generation-(\d+)/.exec(f)?.[1] ?? 0))
    return `generation-${String(n + 1).padStart(6, '0')}`
  }

  listGenerations(): string[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir).filter((f) => /^generation-\d+\.sqlite3$/.test(f)).sort()
  }

  /** Remove every generation except the current one (and `keep`). */
  cleanup(keep?: string): void {
    const keepNames = new Set<string>()
    const current = this.readCurrent()
    if (current) keepNames.add(current.db_filename)
    if (keep) keepNames.add(`${keep}.sqlite3`)
    for (const name of this.listGenerations()) {
      if (keepNames.has(name)) continue
      for (const suffix of ['', '-wal', '-shm']) {
        try { unlinkSync(join(this.dir, name + suffix)) } catch { /* in use or gone */ }
      }
    }
  }
}
