/**
 * Knowledge-base fallback.
 *
 * When a local deterministic query produces a *negative* result, tag the result
 * with a fixed marker and an instruction so the agent calls the knowledge-base
 * MCP tool in the same turn, using the user's original words.
 *
 * Why the agent makes that call, not the tool:
 * - the knowledge base wants the user's question verbatim; the tool only sees
 *   structured arguments;
 * - knowledge-base queries can be long-running; blocking inside a tool would
 *   stall the whole call.
 * The decision is made deterministically here; the model only carries it out.
 */

/** Fixed marker in the result text; the system prompt keys off it. */
export const KB_FALLBACK_MARKER = '[local miss -> knowledge base]'

/** Gaps that mean "the tool was misused", not "cannot answer": retry, do not fall back. */
const MISUSE_GAP = /^(unknown_operation|unsupported_operation|invalid_argument)/

/** First-line wording of a partial/needs_input result that means "nothing found". */
const NOT_FOUND = /not found|no match|未找到|无匹配/i

export interface KbFallbackDecision {
  reason: string
}

/**
 * Is this result negative (the local project cannot answer the question)?
 *
 * - `capability_gap` → fall back, except misuse-type gaps;
 * - `partial` / `needs_input` whose first line says "not found" → fall back;
 * - ambiguity candidates, missing arguments, execution errors (correctable
 *   mistakes such as a wrong path) → do not fall back.
 */
export function classifyNegative(value: unknown): KbFallbackDecision | null {
  if (value === null || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const status = typeof v.status === 'string' ? v.status : ''
  const answer = typeof v.answer === 'string' ? v.answer : ''
  const payload = (v.payload && typeof v.payload === 'object' ? v.payload : {}) as Record<string, unknown>
  const gapReason = typeof payload.gap_reason === 'string' ? payload.gap_reason : ''

  if (status === 'capability_gap') {
    if (MISUSE_GAP.test(gapReason)) return null
    return { reason: firstLine(answer) || status }
  }
  if (status === 'partial' || status === 'needs_input') {
    const head = firstLine(answer)
    if (NOT_FOUND.test(head)) return { reason: head }
  }
  return null
}

function firstLine(s: string): string {
  const line = s.trim().split(/\r?\n/, 1)[0] ?? ''
  return line.length > 120 ? line.slice(0, 120) + '…' : line
}

/** Instruction appended to the answer (model-visible). */
export function fallbackNotice(toolName: string, kbTool: string, reason: string): string {
  return `\n\n${KB_FALLBACK_MARKER} ${toolName} could not answer from the local project (${reason}). ` +
    `Unless there is an obvious local correction (fix a wrong argument and retry once), call ${kbTool} ` +
    `in this turn with the user's original question verbatim; no need to ask for permission. ` +
    `If it returns a query id for a long-running job, tell the user the id instead of polling.`
}

/**
 * Wrap a `defineTool` product: when `execute` returns a negative result, append
 * the fallback instruction to `answer` and record `payload.kb_fallback`. Status,
 * evidence and every other field are left unchanged.
 *
 * @param isKbAvailable - whether the knowledge-base tool is visible to the
 *   calling agent. When it is not, nothing is appended: never instruct the model
 *   to call a tool it does not have.
 */
export function withKbFallback<T extends { name: string; execute: (args: any, exec: any) => Promise<any> }>(
  def: T,
  kbTool: string,
  isKbAvailable: (exec: any) => boolean,
): T {
  const original = def.execute
  const wrapped = async (args: any, exec: any) => {
    const value = await original(args, exec)
    const decision = classifyNegative(value)
    if (!decision || !isKbAvailable(exec)) return value
    const out: Record<string, unknown> = { ...value }
    out.answer = `${typeof value.answer === 'string' ? value.answer : ''}${fallbackNotice(def.name, kbTool, decision.reason)}`
    const payload = value.payload && typeof value.payload === 'object' ? value.payload : {}
    out.payload = { ...payload, kb_fallback: { required: true, tool: kbTool, reason: decision.reason } }
    return out
  }
  return { ...def, execute: wrapped }
}
