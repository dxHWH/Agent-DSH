/**
 * `ProjectIndex` — the public face of the SQLite index.
 *
 * Two strictly separated paths:
 * - **Query path** (`openIfCurrent`, `status`): never builds. It answers "is
 *   there a current, valid index?" and hands back a read-only connection, or
 *   says why not so the caller can fall back to scanning sources.
 * - **Build path** (`rebuild`): only invoked by an explicit user action (the
 *   desktop Settings window, in a worker thread). Takes the build lock, writes a
 *   new generation, validates it, flips `current.json`, cleans up.
 *
 * Staleness = the stored quick fingerprint, schema version or builder version
 * differs from the present one.
 */
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { listSources, type SourceOptions } from '../sources.js'
import { buildIndex, type BuildProgressFn } from './builder.js'
import { quickFingerprint } from './fingerprint.js'
import { IndexLifecycle } from './lifecycle.js'
import { BUILDER_VERSION, SCHEMA_VERSION } from './schema.js'
import { databaseSize, openForQuery, validateDatabase } from './store.js'

export const INDEX_DIR_NAME = '.agent-index'

export interface IndexStatus {
  state: 'ready' | 'building' | 'stale' | 'missing' | 'error'
  generation: string | null
  error_message: string | null
  source_count: number
  line_count: number
  term_count: number
}

export interface IndexCoverage {
  built_at: string | null
  db_size_bytes: number
  schema_version: number | null
  builder_version: number | null
  /** Human-readable description of what the index covers. */
  scope: string
}

/** How long a "ready" verdict is trusted before re-fingerprinting the tree. */
const READY_TTL_MS = 30_000

export class ProjectIndex {
  readonly projectRoot: string
  readonly indexDir: string
  private readonly lifecycle: IndexLifecycle
  private readonly sourceOptions: SourceOptions
  private readyCheckedAt = 0

  constructor(projectRoot: string, sourceOptions: SourceOptions = {}) {
    this.projectRoot = projectRoot
    this.indexDir = join(projectRoot, INDEX_DIR_NAME)
    this.lifecycle = new IndexLifecycle(this.indexDir)
    this.sourceOptions = sourceOptions
  }

  /** Current state, without building anything. */
  status(): IndexStatus {
    const base: IndexStatus = { state: 'missing', generation: null, error_message: null, source_count: 0, line_count: 0, term_count: 0 }
    const lock = this.lifecycle.lock()
    const building = lock.exists() && !lock.isStale()
    const current = this.lifecycle.readCurrent()
    if (!current) return { ...base, state: building ? 'building' : 'missing' }

    const counts = { generation: current.generation, source_count: current.source_count, line_count: current.line_count, term_count: current.term_count }
    const [ok, issues] = validateDatabase(join(this.indexDir, current.db_filename), true)
    if (!ok) return { ...base, ...counts, state: building ? 'building' : 'error', error_message: issues.join('; ') }
    if (building) return { ...base, ...counts, state: 'building' }
    if (current.schema_version !== SCHEMA_VERSION || current.builder_version !== BUILDER_VERSION) {
      return { ...base, ...counts, state: 'stale', error_message: 'index was built by a different schema/builder version' }
    }
    if (Date.now() - this.readyCheckedAt > READY_TTL_MS) {
      if (quickFingerprint(listSources(this.projectRoot, this.sourceOptions)) !== current.fingerprint) {
        return { ...base, ...counts, state: 'stale', error_message: 'source files changed since the last build' }
      }
      this.readyCheckedAt = Date.now()
    }
    return { ...base, ...counts, state: 'ready' }
  }

  coverage(): IndexCoverage | null {
    const current = this.lifecycle.readCurrent()
    if (!current) return null
    return {
      built_at: current.created_at,
      db_size_bytes: databaseSize(join(this.indexDir, current.db_filename)),
      schema_version: current.schema_version,
      builder_version: current.builder_version,
      scope: `${current.source_count} files, ${current.line_count} lines, ${current.term_count} terms`,
    }
  }

  /**
   * Query path: a read-only connection when the index is current, otherwise the
   * state explaining why not. Never builds. Caller closes the connection.
   */
  openIfCurrent(): { conn: DatabaseSync; status: IndexStatus } | { conn: null; status: IndexStatus } {
    const status = this.status()
    if (status.state !== 'ready') return { conn: null, status }
    const current = this.lifecycle.readCurrent()
    if (!current) return { conn: null, status: { ...status, state: 'missing' } }
    try {
      return { conn: openForQuery(join(this.indexDir, current.db_filename)), status }
    } catch (e) {
      return { conn: null, status: { ...status, state: 'error', error_message: String(e) } }
    }
  }

  /**
   * Build path: build a new generation and switch to it.
   * @returns the resulting status (throws when the lock is held or the build fails).
   */
  rebuild(progress?: BuildProgressFn): IndexStatus {
    this.lifecycle.ensureDirectory()
    const generation = this.lifecycle.nextGeneration()
    const lock = this.lifecycle.lock()
    if (!lock.acquire(generation)) throw new Error('another build is already running for this project')
    const dbPath = this.lifecycle.generationPath(generation)
    try {
      progress?.({ completed: 0, total: -1, current: 'scanning project files' })
      const files = listSources(this.projectRoot, this.sourceOptions)
      const fingerprint = quickFingerprint(files)
      const stats = buildIndex(dbPath, files, fingerprint, progress)
      const [ok, issues] = validateDatabase(dbPath)
      if (!ok) throw new Error(`new index failed validation: ${issues.join('; ')}`)
      this.lifecycle.writeCurrent({
        generation,
        db_filename: `${generation}.sqlite3`,
        created_at: new Date().toISOString(),
        fingerprint,
        schema_version: SCHEMA_VERSION,
        builder_version: BUILDER_VERSION,
        ...stats,
      })
      this.lifecycle.cleanup(generation)
      this.readyCheckedAt = Date.now()
    } catch (e) {
      // The previous generation (if any) stays current; drop the partial file.
      this.lifecycle.cleanup()
      throw e
    } finally {
      lock.release()
    }
    return this.status()
  }
}
