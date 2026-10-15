/**
 * The hint appended when the query index is unavailable.
 *
 * The index is built only when the user explicitly clicks "Rebuild index" in the
 * desktop Settings window; the tool's query path never builds it. When the index
 * is missing / stale / building, the tool degrades to scanning source files
 * (still correct, only slower) and appends this hint so the model can relay it.
 */
import type { ToolResult } from './result.js'

const STATE_LABEL: Record<string, string> = {
  missing: 'has not been built yet',
  stale: 'is stale (source files changed)',
  building: 'is being rebuilt',
  error: 'failed to build last time',
}

export function indexStateNote(state: string | null | undefined): string | null {
  if (!state || state === 'ready') return null
  const label = STATE_LABEL[state] ?? 'is unavailable'
  return `The query index ${label}; source files were scanned directly (slower). ` +
    `To speed this up, open Settings -> Project & Index and click "Rebuild index".`
}

/** Append the hint to `answer` and mirror it in `payload.index_hint`. */
export function appendIndexHint(res: ToolResult, note: string | null): ToolResult {
  if (!note || res.answer.includes(note)) return res
  return {
    ...res,
    answer: res.answer ? `${res.answer}\n\nNote: ${note}` : `Note: ${note}`,
    payload: { ...(res.payload ?? {}), index_hint: note },
  }
}
