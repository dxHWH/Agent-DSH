/**
 * 类型定义：DSH session 事件流 → 归档 turn 结构。
 *
 * 数据源：DSH session 日志（`sessionPersistence.open(id,'read').read(0)` 返回的
 * `SessionEvent[]`，或直接解 `.jsonl.zstd` 得到的同构事件流）。
 */

/** 一条会话事件（只声明本插件关心的字段，其余透传为 unknown）。 */
export interface SessionEventLike {
  type: string
  seq: number
  time: number
  data?: any
  surfaceOp?: string | { op: string }
  sourceEventSeqs?: number[]
}

/** 会话头（session 日志首行 / persistence header）。 */
export interface SessionHeaderLike {
  id: string
  version: number
  createdAt: number
  cwd?: string
  parentSession?: string
  isSeeded: boolean
  origin?: string
  delegationDepth?: number
  agentPreset?: string
}

/** 单个文本块。 */
export interface TextBlock {
  type: 'text'
  text: string
}

/** tool-call 块（assistant message content 内）。 */
export interface ToolCallBlock {
  type: 'tool-call'
  id: string
  name: string
  arguments: string
}

/** tool-result 块（tool/result message content 内）。 */
export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: string
  content: TextBlock[]
  isError?: boolean
}

/** 一次工具调用（归档字段）。 */
export interface ToolCallRecord {
  name: string
  arguments: string
  callId: string
  result: string
  is_error: boolean
  truncated: boolean
}

/** token 用量（DSH 用 camelCase）。 */
export interface UsageLike {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cachedMissTokens?: number
  lastTokens?: number
  credit?: number
}

/** 转换后的单个 turn（归档核心结构）。 */
export interface TurnRecord {
  turn_index: number
  mode: string
  /**
   * 请求状态：正常完成 / 被取消中断 / 阻塞 / 失败 / token 上限 / 崩溃后补 / 其它未完成。
   * 对齐 DSH `TurnEndReasonMap` 的 `kind`，未知/缺失归为 `incomplete`。
   */
  request_state: 'complete' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted' | 'incomplete'
  started_at: number
  ended_at: number
  duration_ms: number
  duration_source: string
  user_prompt: string
  agent_response: string
  reasoning: string
  model: string
  provider: string
  tool_calls: ToolCallRecord[]
  files_changed: string[]
  tokens: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    cache_read_input_tokens: number
    cache_write_tokens: number
    cache_miss_tokens: number
    last_tokens: number
    credit: number
  }
  messages: Array<{ seq: number; role: string; kind: string; time: number; summary: string }>
  session_id: string
  title: string
}

/** 模式标签映射。 */
export const MODE_LABELS: Record<string, string> = {
  project: '项目模式',
  standard: '标准模式',
}

/** 点踩反馈（分类标签 + 原因文本）。 */
export interface FeedbackRecord {
  /** 分类标签（与现有 FeedbackCategory 一致）。 */
  category?: string
  /** 原因文本。 */
  note?: string
  /** 归档时间（ISO）。 */
  createdAt?: string
}
