/**
 * 转换器：DSH session 事件流 → 归档 turn 结构。
 *
 * 输入：完整事件流（含 header 的 `{header, events}` 或纯 `events`）。
 * 输出：按 turn 分组的 `TurnRecord[]`，并按 messageId 定位「被点踩的那一轮」。
 *
 * 关键规则：
 * - 轮边界 = `turn/start` / `turn/end`；
 * - 用户输入只取 `source.kind === "user"` 的 `user/message`（排除 system-prompt 快照等合成消息）；
 * - 助手回答 = 该轮所有 `assistant/message` 的 text 拼接；
 * - 工具调用 = `tool/call`（name/arguments）与 `tool/result`（结果）按 callId 配对；
 * - usage 按轮求和（DSH 是 camelCase：inputTokens/outputTokens/totalTokens…）；
 * - 完成判定 = `turn/end` 存在且 `reason.kind === "completed"`。
 */
import {
  MODE_LABELS,
  type SessionEventLike,
  type SessionHeaderLike,
  type ToolCallRecord,
  type TurnRecord,
  type UsageLike,
} from './types.js'

/** 写类工具名（用于 files_changed 提取）。 */
const WRITE_TOOL_NAMES = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'replace_in_file', 'write_to_file',
  'write', 'edit',
])
/** 路径类参数名（用于从 write 工具 arguments 提取文件路径）。 */
const PATH_KEYS = ['file_path', 'filePath', 'target_file', 'targetFile', 'path']

/** 工具结果截断上限（复用 archive-extension 的 64KB 口径）。 */
const MAX_TOOL_RESULT_CHARS = 65536

/** 从消息 content 里提取全部 text 块。 */
function extractText(content: any[] | undefined): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out += block.text
    }
  }
  return out
}

/** 从 assistant message content 里提取 tool-call 块（id/name/arguments）。 */
function extractToolCallBlocks(content: any[] | undefined): Array<{ id: string; name: string; arguments: string }> {
  if (!Array.isArray(content)) return []
  return content
    .filter((b) => b && typeof b === 'object' && b.type === 'tool-call')
    .map((b) => ({ id: String(b.id ?? ''), name: String(b.name ?? ''), arguments: String(b.arguments ?? '{}') }))
}

/** 从 tool/result message 里提取 tool-result 块（toolCallId/content/isError）。 */
function extractToolResultBlocks(message: any): Array<{ toolCallId: string; text: string; isError: boolean }> {
  const content = message?.content
  if (!Array.isArray(content)) return []
  const out: Array<{ toolCallId: string; text: string; isError: boolean }> = []
  for (const block of content) {
    if (!block || typeof block !== 'object' || block.type !== 'tool-result') continue
    out.push({
      toolCallId: String(block.toolCallId ?? ''),
      text: extractText(block.content),
      isError: block.isError === true,
    })
  }
  return out
}

/** 截断超长文本。 */
function truncate(text: string, max = MAX_TOOL_RESULT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

/** 汇总一个 summary（去换行、限长）。 */
function summarize(text: string, max = 80): string {
  if (!text) return ''
  const s = text.replace(/\r/g, ' ').replace(/\n/g, ' ')
  return s.length > max ? s.slice(0, max) + '...' : s
}

/** 从 write 工具的 arguments 提取文件路径。 */
function extractFilePath(name: string, argumentsStr: string): string {
  if (!WRITE_TOOL_NAMES.has(name)) return ''
  let args: any
  try {
    args = JSON.parse(argumentsStr)
  } catch {
    return ''
  }
  if (!args || typeof args !== 'object') return ''
  for (const k of PATH_KEYS) {
    if (typeof args[k] === 'string' && args[k]) return args[k]
  }
  return ''
}

/** usage 求和累加器。 */
function addUsage(acc: Required<Record<keyof NonNullable<object>, number>> & Record<string, number>, u: UsageLike | undefined): void {
  if (!u) return
  const map: Array<[string, number | undefined]> = [
    ['input_tokens', u.inputTokens],
    ['output_tokens', u.outputTokens],
    ['total_tokens', u.totalTokens],
    ['cache_read_input_tokens', u.cacheReadTokens],
    ['cache_write_tokens', u.cacheWriteTokens],
    ['cache_miss_tokens', u.cachedMissTokens],
    ['last_tokens', u.lastTokens],
    ['credit', u.credit],
  ]
  for (const [k, v] of map) {
    if (typeof v === 'number' && Number.isFinite(v)) acc[k] = (acc[k] ?? 0) + v
  }
}

/** 会话头 → 模式 id（即 agent 预设 id：project / standard / 其它；缺省 standard）。 */
export function modeOf(header: SessionHeaderLike | undefined): string {
  return header?.agentPreset || 'standard'
}

/** 模式 id → 显示标签。 */
export function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode
}

/**
 * 把完整事件流按 turn 分组并转换为归档结构。
 * @param events 有序事件流（含或不含 header 行）。
 * @param header 会话头（可选，缺省时从事件流首行的 type==="session" 提取）。
 * @param sessionTitle 会话标题（可选，从 session/title 事件提取）。
 */
export function convertEvents(
  events: SessionEventLike[],
  header?: SessionHeaderLike,
  sessionTitle = '',
): TurnRecord[] {
  // 分离 header 行（若有 type==="session" 的事件）
  let headerObj = header
  let title = sessionTitle
  const body: SessionEventLike[] = []
  for (const ev of events) {
    if (ev.type === 'session' && headerObj === undefined) {
      headerObj = ev.data as unknown as SessionHeaderLike
      continue
    }
    if (ev.type === 'session/title' && !title) {
      title = ev.data?.title ?? ''
      continue
    }
    body.push(ev)
  }

  const sessionId = headerObj?.id ?? ''
  const mode = modeOf(headerObj)

  // 按 turn 分组（每个 turn 独立记录 start/end/reason，避免共用最后一轮的状态）
  const turns: Array<{ index: number; events: SessionEventLike[]; startedAt: number; endedAt: number; reason: any }> = []
  let current: SessionEventLike[] | null = null
  let currentIndex = -1
  let currentStartedAt = 0
  let currentEndedAt = 0
  let currentReason: any = null

  for (const ev of body) {
    if (ev.type === 'turn/start') {
      current = []
      currentIndex = Number(ev.data?.turn ?? 0)
      currentStartedAt = ev.time
      currentEndedAt = ev.time
      currentReason = null
      turns.push({ index: currentIndex, events: current, startedAt: currentStartedAt, endedAt: currentEndedAt, reason: null })
      continue
    }
    if (ev.type === 'turn/end') {
      currentEndedAt = ev.time
      currentReason = ev.data?.reason
      if (current !== null && turns.length > 0) {
        const t = turns[turns.length - 1]
        t.endedAt = currentEndedAt
        t.reason = currentReason
      }
      continue
    }
    if (current !== null) {
      current.push(ev)
      if (ev.time > currentEndedAt) currentEndedAt = ev.time
      if (turns.length > 0) turns[turns.length - 1].endedAt = currentEndedAt
    }
  }

  const records: TurnRecord[] = []
  for (const turn of turns) {
    records.push(buildTurn(turn.index, turn.events, turn.startedAt, turn.endedAt, turn.reason, sessionId, mode, title))
  }
  return records
}

/** 把 turn/end 的 reason.kind 映射为 request_state（未知/缺失归为 incomplete）。 */
function mapRequestState(kind: unknown): TurnRecord['request_state'] {
  switch (kind) {
    case 'completed': return 'complete'
    case 'aborted': return 'aborted'
    case 'blocked': return 'blocked'
    case 'error': return 'error'
    case 'max-tokens': return 'max-tokens'
    case 'interrupted': return 'interrupted'
    default: return 'incomplete'
  }
}

/** 构造单个 turn 记录。 */
function buildTurn(
  index: number,
  events: SessionEventLike[],
  startedAt: number,
  endedAt: number,
  reason: any,
  sessionId: string,
  mode: string,
  title: string,
): TurnRecord {
  let userPrompt = ''
  let agentResponse = ''
  let reasoning = ''
  let model = ''
  let provider = ''
  const usage: Record<string, number> = {}
  const toolCalls: ToolCallRecord[] = []
  const byCallId = new Map<string, ToolCallRecord>()
  const filesChanged: string[] = []
  const flow: Array<{ seq: number; role: string; kind: string; time: number; summary: string }> = []

  for (const ev of events) {
    const data = ev.data ?? {}

    if (ev.type === 'user/message') {
      const kind = data?.source?.kind
      const text = extractText(data?.content)
      if (kind === 'user' && text && !userPrompt) {
        userPrompt = text
      }
      flow.push({ seq: ev.seq, role: 'user', kind: kind === 'user' ? 'question' : 'context', time: ev.time, summary: summarize(text) })
      continue
    }

    if (ev.type === 'assistant/message') {
      const msg = data?.message
      const text = extractText(msg?.content)
      if (text) agentResponse += (agentResponse ? '\n\n' : '') + text
      if (msg?.source?.model) model = String(msg.source.model)
      if (msg?.source?.provider) provider = String(msg.source.provider)
      addUsage(usage, data?.usage)
      // tool-call 块也记录（与独立的 tool/call 事件互补，但以独立事件为准）
      for (const tc of extractToolCallBlocks(msg?.content)) {
        if (!byCallId.has(tc.id)) {
          const rec: ToolCallRecord = { name: tc.name, arguments: tc.arguments, callId: tc.id, result: '', is_error: false, truncated: false }
          byCallId.set(tc.id, rec)
          toolCalls.push(rec)
        }
      }
      if (text) flow.push({ seq: ev.seq, role: 'assistant', kind: 'answer', time: ev.time, summary: summarize(text) })
      continue
    }

    if (ev.type === 'tool/call') {
      const callId = String(data.callId ?? '')
      const name = String(data.name ?? '')
      const args = String(data.arguments ?? '{}')
      let rec = byCallId.get(callId)
      if (!rec) {
        rec = { name, arguments: args, callId, result: '', is_error: false, truncated: false }
        byCallId.set(callId, rec)
        toolCalls.push(rec)
      } else {
        rec.name = name
        rec.arguments = args
      }
      const fp = extractFilePath(name, args)
      if (fp && !filesChanged.includes(fp)) filesChanged.push(fp)
      flow.push({ seq: ev.seq, role: 'assistant', kind: 'tool_call', time: ev.time, summary: name })
      continue
    }

    if (ev.type === 'tool/result') {
      const blocks = extractToolResultBlocks(data?.message)
      for (const b of blocks) {
        const rec = byCallId.get(b.toolCallId)
        if (rec) {
          const { text, truncated } = truncate(b.text)
          rec.result = text
          rec.is_error = b.isError
          rec.truncated = truncated
        }
      }
      flow.push({ seq: ev.seq, role: 'tool', kind: 'tool_result', time: ev.time, summary: (data?.message?.source?.callId ?? '') })
      continue
    }
  }

  // 完成判定：把 turn/end 的 reason.kind 映射为具体的 request_state。
  // 对齐 DSH TurnEndReasonMap 的 kind：completed/aborted/blocked/error/max-tokens/interrupted。
  const kind = reason?.kind
  const requestState: TurnRecord['request_state'] = mapRequestState(kind)
  const durationMs = Math.max(0, endedAt - startedAt)

  // 组装 tokens（补齐字段）
  const tokens: TurnRecord['tokens'] = {
    input_tokens: Math.round(usage.input_tokens ?? 0),
    output_tokens: Math.round(usage.output_tokens ?? 0),
    total_tokens: Math.round(usage.total_tokens ?? 0),
    cache_read_input_tokens: Math.round(usage.cache_read_input_tokens ?? 0),
    cache_write_tokens: Math.round(usage.cache_write_tokens ?? 0),
    cache_miss_tokens: Math.round(usage.cache_miss_tokens ?? 0),
    last_tokens: Math.round(usage.last_tokens ?? 0),
    credit: usage.credit ?? 0,
  }

  return {
    turn_index: index,
    mode,
    request_state: requestState,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    duration_source: 'session_events',
    user_prompt: userPrompt,
    agent_response: agentResponse,
    reasoning,
    model,
    provider,
    tool_calls: toolCalls,
    files_changed: filesChanged,
    tokens,
    messages: flow,
    session_id: sessionId,
    title,
  }
}

/**
 * 按 messageId 定位所属 turn。
 * @returns 匹配的 turn 记录，找不到返回 undefined。
 */
export function findTurnByMessageId(
  events: SessionEventLike[],
  records: TurnRecord[],
  messageId: string,
): TurnRecord | undefined {
  // 先找该 messageId 属于哪个 turn index
  let turnIndex = -1
  for (const ev of events) {
    if (ev.type !== 'assistant/message') continue
    const id = ev.data?.message?.id
    if (id === messageId) {
      turnIndex = Number(ev.data?.turn ?? -1)
      break
    }
  }
  if (turnIndex < 0) return undefined
  return records.find((r) => r.turn_index === turnIndex)
}
