/**
 * Text normalization and tokenization shared by the index builder, the index
 * query, and the direct-scan fallback — so all three agree on what "matches".
 *
 * CJK-aware: NFKC folds full-width forms, common CJK punctuation maps to ASCII,
 * and CJK runs are tokenized into bigrams (there are no spaces to split on).
 */

const PUNCT_MAP: Record<string, string> = {
  '，': ',', '。': '.', '：': ':', '；': ';', '！': '!', '？': '?',
  '（': '(', '）': ')', '【': '[', '】': ']', '《': '<', '》': '>',
  '「': "'", '」': "'", '『': '"', '』': '"', '“': '"', '”': '"',
  '‘': "'", '’': "'", '—': '-', '～': '~',
}

/** Lower-case, NFKC, CJK punctuation to ASCII, collapse whitespace. */
export function normalizeText(text: string): string {
  if (!text) return ''
  let s = text.normalize('NFKC')
  for (const [from, to] of Object.entries(PUNCT_MAP)) s = s.split(from).join(to)
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Normalized text with all whitespace removed (for substring matching). */
export function compactText(text: string): string {
  return normalizeText(text).replace(/\s+/g, '')
}

/**
 * Query wrappers that carry no search signal ("where is", "how to configure",
 * "在哪", "怎么配置"…). Stripping them keeps recall focused on the subject.
 */
const QUERY_WRAPPERS = [
  /^(where is|where are|find|search for|search|look up|show me)\s+/i,
  /\s+(defined|configured|located)\??$/i,
  /^(在哪里?|哪里|查找|搜索|查一下|查询)/,
  /(在哪里?|在哪个文件|怎么配置|如何配置|是什么)[?？]?$/,
]

export function stripQueryWrapper(query: string): string {
  let q = query.trim()
  for (const re of QUERY_WRAPPERS) q = q.replace(re, '')
  return q.trim() || query.trim()
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/

/**
 * Index terms of a text: ASCII words (length ≥ 2) and CJK bigrams (a lone CJK
 * character becomes a unigram). Duplicates are removed.
 */
export function tokenize(text: string): string[] {
  const norm = normalizeText(text)
  const out = new Set<string>()
  for (const m of norm.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0])
  for (const run of norm.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) ?? []) {
    if (run.length === 1) out.add(run)
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

/** Too little signal to search for (one ASCII letter, pure punctuation…). */
export function isLowInformation(text: string): boolean {
  const c = compactText(text)
  if (c.length === 0) return true
  if (CJK.test(c)) return false
  return c.replace(/[^a-z0-9]/g, '').length < 2
}

/**
 * Precision score of a candidate line for a query, in [0, 1].
 * 1.0 = the compact query occurs verbatim; otherwise the fraction of query
 * terms present in the line.
 */
export function scoreLine(query: string, queryTerms: readonly string[], line: string): number {
  const cq = compactText(query)
  const cl = compactText(line)
  if (cq && cl.includes(cq)) return 1
  if (queryTerms.length === 0) return 0
  const lineTerms = new Set(tokenize(line))
  let hit = 0
  for (const t of queryTerms) if (lineTerms.has(t)) hit++
  return (hit / queryTerms.length) * 0.9
}
