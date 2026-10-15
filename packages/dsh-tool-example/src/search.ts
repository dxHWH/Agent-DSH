/**
 * The `example_search` capability: find where a keyword/phrase appears in the
 * bound project.
 *
 * Index first; when the index is not current, scan sources directly with the
 * same scorer and append the "rebuild the index" hint. The answer stays
 * compact; the full hit list can be written to a report.
 */
import { readFileSync } from 'node:fs'
import { appendIndexHint, indexStateNote } from './index_hint.js'
import { writeReport } from './report_writer.js'
import type { Evidence, ToolResult } from './result.js'
import { listSources, type SourceOptions } from './sources.js'
import { ProjectIndex } from './sqlite/index.js'
import { MIN_SCORE, rankHits, searchIndex, type SearchHit } from './sqlite/query.js'
import { isLowInformation, scoreLine, stripQueryWrapper, tokenize } from './text.js'

export interface SearchArgs {
  query: string
  limit?: number
  write_report?: boolean
}

export interface SearchContext {
  projectRoot: string
  index: ProjectIndex
  sourceOptions: SourceOptions
  reportDir?: string
  workspaceRoot?: string
}

/** Lines shown inline in the answer; the rest goes to the report. */
const ANSWER_LINES = 15
const MAX_SCAN_HITS = 2000

export function runSearch(args: SearchArgs, ctx: SearchContext): ToolResult {
  const raw = String(args.query ?? '')
  const query = stripQueryWrapper(raw)
  if (isLowInformation(query)) {
    return {
      status: 'needs_input',
      answer: `The query "${raw}" has too little signal to search for. Ask the user for a more specific keyword (an identifier, a phrase, a file name).`,
      evidence: [],
    }
  }
  const limit = Math.min(Math.max(1, Math.trunc(args.limit ?? 50)), 500)

  let hits: SearchHit[]
  let via: 'index' | 'scan'
  let note: string | null = null
  const opened = ctx.index.openIfCurrent()
  if (opened.conn) {
    try {
      hits = searchIndex(opened.conn, query, limit)
      via = 'index'
    } finally {
      opened.conn.close()
    }
  } else {
    hits = scanSources(ctx.projectRoot, query, ctx.sourceOptions).slice(0, limit)
    via = 'scan'
    note = indexStateNote(opened.status.state)
  }

  if (hits.length === 0) {
    return appendIndexHint({
      status: 'partial',
      answer: `Not found: no line in the project matches "${query}".`,
      evidence: [],
      payload: { query, via },
    }, note)
  }

  const files = new Set(hits.map((h) => h.path))
  const lines = hits.slice(0, ANSWER_LINES).map((h) => `- ${h.path}:${h.line_no}  ${h.text.trim().slice(0, 160)}`)
  const more = hits.length > ANSWER_LINES ? `\n…and ${hits.length - ANSWER_LINES} more.` : ''
  const evidence: Evidence[] = hits.slice(0, ANSWER_LINES).map((h) => ({
    kind: 'file',
    source: h.path,
    locator: `L${h.line_no}`,
    claim: h.text.trim().slice(0, 200),
    verified: true,
  }))

  const result: ToolResult = {
    status: 'trusted_hit',
    answer: `Found ${hits.length} matching line(s) for "${query}" in ${files.size} file(s) (via ${via}):\n${lines.join('\n')}${more}`,
    evidence,
    payload: { query, via, hit_count: hits.length, file_count: files.size },
  }

  if (args.write_report && ctx.reportDir) {
    const body = [
      `# Search report: ${query}`,
      '',
      `- Project: \`${projectLabel(ctx.projectRoot)}\``,
      `- Retrieved via: ${via}`,
      `- Hits: ${hits.length} in ${files.size} file(s)`,
      '',
      '| # | File | Line | Score | Text |',
      '|---|---|---|---|---|',
      ...hits.map((h, i) => `| ${i + 1} | ${h.path} | ${h.line_no} | ${h.score.toFixed(2)} | ${escapeCell(h.text.trim().slice(0, 300))} |`),
      '',
    ].join('\n')
    const written = writeReport('search', query, body, ctx.reportDir, `Search report: ${query}`, ctx.workspaceRoot)
    if (written.artifact) {
      result.artifacts = [written.artifact]
      result.answer += `\n\nFull report: ${written.artifact.path} (call present to deliver it).`
    } else if (written.error) {
      result.answer += `\n\n(Report could not be written: ${written.error})`
    }
  }
  return appendIndexHint(result, note)
}

/** Direct scan with the same scoring as the index path. */
export function scanSources(projectRoot: string, query: string, options: SourceOptions): SearchHit[] {
  const terms = tokenize(query)
  const hits: SearchHit[] = []
  for (const f of listSources(projectRoot, options)) {
    let text: string
    try { text = readFileSync(f.abs, 'utf8') } catch { continue }
    if (text.includes('\u0000')) continue
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      const score = scoreLine(query, terms, line)
      if (score >= MIN_SCORE) hits.push({ path: f.path, line_no: i + 1, text: line.slice(0, 2000), score })
    }
    if (hits.length >= MAX_SCAN_HITS) break
  }
  return rankHits(hits)
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** Last path segment only: reports must not leak machine paths. */
function projectLabel(root: string): string {
  return root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root
}
