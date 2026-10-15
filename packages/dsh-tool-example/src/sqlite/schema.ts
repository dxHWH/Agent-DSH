/**
 * Index schema and version constants.
 *
 * Bump `SCHEMA_VERSION` when the table layout changes and `BUILDER_VERSION`
 * when what the builder writes changes (tokenization, scope…). Either change
 * makes every existing index "stale", so users are prompted to rebuild instead
 * of silently querying an index built by different rules.
 */
import type { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 1
export const BUILDER_VERSION = 1

export const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS index_meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS source_file (
     source_id INTEGER PRIMARY KEY,
     path      TEXT NOT NULL UNIQUE,
     size      INTEGER NOT NULL,
     mtime_ms  INTEGER NOT NULL,
     digest    TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS line (
     line_id   INTEGER PRIMARY KEY,
     source_id INTEGER NOT NULL REFERENCES source_file(source_id),
     line_no   INTEGER NOT NULL,
     text      TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS term (
     term_id INTEGER PRIMARY KEY,
     term    TEXT NOT NULL UNIQUE
   )`,
  `CREATE TABLE IF NOT EXISTS occurrence (
     term_id INTEGER NOT NULL REFERENCES term(term_id),
     line_id INTEGER NOT NULL REFERENCES line(line_id),
     PRIMARY KEY (term_id, line_id)
   ) WITHOUT ROWID`,
]

export const REQUIRED_TABLES = ['index_meta', 'source_file', 'line', 'term', 'occurrence']

export function initSchema(conn: DatabaseSync): void {
  for (const stmt of DDL) conn.exec(stmt)
}

export function writeMeta(conn: DatabaseSync, meta: Record<string, string>): void {
  const stmt = conn.prepare('INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)')
  for (const [k, v] of Object.entries(meta)) stmt.run(k, v)
}

export function integrityCheck(conn: DatabaseSync): boolean {
  const row = conn.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined
  return row?.integrity_check === 'ok'
}
