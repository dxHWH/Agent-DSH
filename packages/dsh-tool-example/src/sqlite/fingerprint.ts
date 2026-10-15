/**
 * Source fingerprints.
 *
 * - **Quick** (stat) fingerprint: hash of every in-scope file's path, size and
 *   mtime. Cheap enough to compute on the query path to decide "is the index
 *   still current?".
 * - **Strong** (content) digest: SHA-256 of a file's bytes, recorded per file at
 *   build time for later verification / incremental strategies.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { SourceFile } from '../sources.js'

export function quickFingerprint(files: readonly SourceFile[]): string {
  const h = createHash('sha256')
  for (const f of files) h.update(`${f.path}\0${f.size}\0${f.mtimeMs}\n`)
  return h.digest('hex').slice(0, 32)
}

export function contentDigest(abs: string): string {
  try {
    return createHash('sha256').update(readFileSync(abs)).digest('hex')
  } catch {
    return ''
  }
}
