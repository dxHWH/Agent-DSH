/**
 * Two-stage retrieval over the index.
 *
 * 1. **Recall**: lines sharing query terms, ranked by how many terms they
 *    share; a line must cover at least `MIN_TERM_OVERLAP` of the query terms.
 *    Capped at `MAX_RECALL` candidates.
 * 2. **Precision**: re-score each candidate's text with the same scorer the
 *    direct scan uses (`text.ts` `scoreLine`) and keep those above threshold.
 *
 * Sharing the scorer with the fallback path is what makes "index hit" and
 * "scan hit" return the same answers — only the speed differs.
 */
import type { DatabaseSync } from 'node:sqlite'
import { scoreLine, tokenize } from '../text.js'

export interface SearchHit {
  path: string
  line_no: number
  text: string
  score: number
}

const MAX_RECALL = 5000
const MIN_TERM_OVERLAP = 0.3
export const MIN_SCORE = 0.5

export function searchIndex(conn: DatabaseSync, query: string, limit: number): SearchHit[] {
  const terms = tokenize(query)
  if (terms.length === 0) return []

  const placeholders = terms.map(() => '?').join(',')
  const minHits = Math.max(1, Math.ceil(terms.length * MIN_TERM_OVERLAP))
  const rows = conn.prepare(
    `SELECT l.line_id AS line_id, l.line_no AS line_no, l.text AS text, s.path AS path, COUNT(*) AS hits
       FROM occurrence o
       JOIN term t ON t.term_id = o.term_id
       JOIN line l ON l.line_id = o.line_id
       JOIN source_file s ON s.source_id = l.source_id
      WHERE t.term IN (${placeholders})
      GROUP BY o.line_id
     HAVING COUNT(*) >= ?
      ORDER BY hits DESC
      LIMIT ${MAX_RECALL}`,
  ).all(...terms, minHits) as { line_no: number; text: string; path: string }[]

  const hits: SearchHit[] = []
  for (const r of rows) {
    const score = scoreLine(query, terms, r.text)
    if (score >= MIN_SCORE) hits.push({ path: r.path, line_no: Number(r.line_no), text: r.text, score })
  }
  return rankHits(hits).slice(0, limit)
}

/** Best score first, then path/line for a stable order. */
export function rankHits(hits: SearchHit[]): SearchHit[] {
  return hits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line_no - b.line_no))
}
