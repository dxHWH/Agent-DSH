/**
 * Index builder: read every in-scope file, store its lines, and record an
 * inverted index term → line.
 *
 * Synchronous by design (node:sqlite is synchronous); run it in a worker thread
 * when the caller must stay responsive (the desktop shell does).
 */
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { SourceFile } from '../sources.js'
import { tokenize } from '../text.js'
import { contentDigest } from './fingerprint.js'
import { BUILDER_VERSION, SCHEMA_VERSION, initSchema, integrityCheck, writeMeta } from './schema.js'
import { openForBuild } from './store.js'

/** `total < 0` marks the post-file phases (finalize / integrity check). */
export type BuildProgressFn = (p: { completed: number; total: number; current: string }) => void

export interface BuildStats {
  source_count: number
  line_count: number
  term_count: number
}

const MAX_LINE_CHARS = 2000

export function buildIndex(dbPath: string, files: readonly SourceFile[], fingerprint: string, progress?: BuildProgressFn): BuildStats {
  const conn: DatabaseSync = openForBuild(dbPath)
  try {
    initSchema(conn)
    writeMeta(conn, {
      build_status: 'building',
      schema_version: String(SCHEMA_VERSION),
      builder_version: String(BUILDER_VERSION),
      fingerprint,
      started_at: new Date().toISOString(),
    })

    const insSource = conn.prepare('INSERT INTO source_file (path, size, mtime_ms, digest) VALUES (?, ?, ?, ?)')
    const insLine = conn.prepare('INSERT INTO line (source_id, line_no, text) VALUES (?, ?, ?)')
    const insTerm = conn.prepare('INSERT OR IGNORE INTO term (term) VALUES (?)')
    const getTerm = conn.prepare('SELECT term_id FROM term WHERE term = ?')
    const insOcc = conn.prepare('INSERT OR IGNORE INTO occurrence (term_id, line_id) VALUES (?, ?)')
    const termIds = new Map<string, number>()
    const termId = (t: string): number => {
      let id = termIds.get(t)
      if (id === undefined) {
        insTerm.run(t)
        id = Number((getTerm.get(t) as { term_id: number }).term_id)
        termIds.set(t, id)
      }
      return id
    }

    let lineCount = 0
    conn.exec('BEGIN')
    files.forEach((f, i) => {
      progress?.({ completed: i, total: files.length, current: f.path })
      let text: string
      try { text = readFileSync(f.abs, 'utf8') } catch { return }
      if (text.includes('\u0000')) return // binary file with a text extension
      const sourceId = Number(insSource.run(f.path, f.size, f.mtimeMs, contentDigest(f.abs)).lastInsertRowid)
      const lines = text.split(/\r?\n/)
      for (let n = 0; n < lines.length; n++) {
        const raw = lines[n]
        if (!raw.trim()) continue
        const line = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw
        const terms = tokenize(line)
        if (terms.length === 0) continue
        const lineId = Number(insLine.run(sourceId, n + 1, line).lastInsertRowid)
        for (const t of terms) insOcc.run(termId(t), lineId)
        lineCount++
      }
      // Commit in batches so the WAL stays bounded on large projects.
      if (i % 200 === 199) { conn.exec('COMMIT'); conn.exec('BEGIN') }
    })
    conn.exec('COMMIT')

    progress?.({ completed: files.length, total: -1, current: 'integrity check' })
    if (!integrityCheck(conn)) throw new Error('integrity check failed after build')
    const stats: BuildStats = { source_count: files.length, line_count: lineCount, term_count: termIds.size }
    writeMeta(conn, {
      build_status: 'complete',
      finished_at: new Date().toISOString(),
      source_count: String(stats.source_count),
      line_count: String(stats.line_count),
      term_count: String(stats.term_count),
    })
    conn.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return stats
  } finally {
    conn.close()
  }
}
