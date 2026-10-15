/**
 * SQLite connections (`node:sqlite`, synchronous) and validation.
 *
 * Build connections favour throughput (WAL, NORMAL sync, big cache); query
 * connections are read-only so a query can never mutate or create an index.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { REQUIRED_TABLES, integrityCheck } from './schema.js'

export function openForBuild(dbPath: string): DatabaseSync {
  const conn = new DatabaseSync(dbPath)
  conn.exec('PRAGMA journal_mode = WAL')
  conn.exec('PRAGMA synchronous = NORMAL')
  conn.exec('PRAGMA temp_store = MEMORY')
  conn.exec('PRAGMA foreign_keys = ON')
  conn.exec('PRAGMA cache_size = -65536')
  return conn
}

export function openForQuery(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true })
}

/** Is this database complete and usable? Returns `[ok, issues]`. */
export function validateDatabase(dbPath: string, skipIntegrity = false): [boolean, string[]] {
  if (!existsSync(dbPath)) return [false, ['database file does not exist']]
  let conn: DatabaseSync
  try {
    conn = openForQuery(dbPath)
  } catch (e) {
    return [false, [`cannot open database: ${String(e)}`]]
  }
  try {
    if (!skipIntegrity && !integrityCheck(conn)) return [false, ['integrity check failed']]
    const names = new Set((conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name))
    const missing = REQUIRED_TABLES.filter((t) => !names.has(t))
    if (missing.length > 0) return [false, [`missing tables: ${missing.join(', ')}`]]
    const row = conn.prepare("SELECT value FROM index_meta WHERE key = 'build_status'").get() as { value: string } | undefined
    if (row?.value !== 'complete') return [false, [`build_status = ${row?.value ?? 'unset'}`]]
    return [true, []]
  } finally {
    conn.close()
  }
}

export function databaseSize(dbPath: string): number {
  try { return statSync(dbPath).size } catch { return 0 }
}
