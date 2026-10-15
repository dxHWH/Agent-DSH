/**
 * 打包：归档 turn 结构 → ZIP 字节 + 文件名。
 *
 * ZIP 内容（对齐 archive-extension 的可读性契约）：
 *   manifest.json        归档元信息
 *   session.json         会话元信息 + 轮摘要索引
 *   turn-NN.json         该轮完整机器可读记录
 *   turn-NN.md           该轮人读 Markdown
 *
 * 远端文件名：[模式标签]用户请求前16字_<短id>.zip
 */
import { zipSync, strToU8, type Zippable } from 'fflate'
import type { FeedbackRecord, TurnRecord } from './types.js'
import { modeLabel } from './convert.js'

/** 文件名里用户请求保留长度（需求：扩展到 16 字符）。 */
const PROMPT_SNIPPET_LEN = 16

/** 清洗文件名非法字符。 */
function sanitizeFilenamePart(s: string): string {
  return s.replace(/[/\\:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 生成远端文件名：[模式]用户请求前16字_<shortid>.zip */
export function buildDisplayName(mode: string, userPrompt: string, shortId: string): string {
  let snippet = sanitizeFilenamePart(userPrompt)
  if (snippet.length > PROMPT_SNIPPET_LEN) snippet = snippet.slice(0, PROMPT_SNIPPET_LEN).trim()
  const label = modeLabel(mode)
  let name = `[${label}]${snippet}_${shortId}.zip`
  if (name.length > 255) name = `${shortId}.zip`
  return name
}

/** 渲染单轮人读 Markdown。 */
export function renderTurnMarkdown(turn: TurnRecord): string {
  const L: string[] = []
  const turnNo = turn.turn_index + 1
  const start = new Date(turn.started_at).toLocaleString('zh-CN', { hour12: false })
  L.push(`# 第 ${turnNo} 轮 · ${start}`)
  L.push('')
  const durS = turn.duration_ms > 0 ? (turn.duration_ms / 1000).toFixed(1) + ' s' : 'n/a'
  L.push(`- **耗时**：${durS}（来源：${turn.duration_source}）`)
  L.push(`- **模式**：${modeLabel(turn.mode)}`)
  const tk = turn.tokens
  L.push(`- **Tokens**：输入 ${fmt(tk.input_tokens)} · 输出 ${fmt(tk.output_tokens)} · 总计 ${fmt(tk.total_tokens)}（缓存读 ${fmt(tk.cache_read_input_tokens)} / 写 ${fmt(tk.cache_write_tokens)}）`)
  L.push(`- **积分**：${tk.credit}`)
  if (turn.model) L.push(`- **模型**：${turn.provider ? turn.provider + '/' : ''}${turn.model}`)
  L.push(`- **请求状态**：${requestStateLabel(turn.request_state)}`)
  L.push('')

  if (turn.user_prompt) {
    L.push('## 用户提问')
    L.push('')
    L.push(turn.user_prompt)
    L.push('')
  }
  if (turn.agent_response) {
    L.push('## 助手回答')
    L.push('')
    L.push(turn.agent_response)
    L.push('')
  }
  const tcs = turn.tool_calls
  if (tcs.length > 0) {
    L.push(`## 工具调用（${tcs.length} 次）`)
    L.push('')
    L.push('| # | 工具 | 参数 | 结果摘要 | 出错 | 截断 |')
    L.push('|---|------|------|----------|------|------|')
    tcs.forEach((tc, i) => {
      L.push(`| ${i + 1} | ${esc(tc.name)} | ${esc(summarize(tc.arguments, 60))} | ${esc(summarize(tc.result, 160))} | ${tc.is_error ? '是' : '否'} | ${tc.truncated ? '是' : '否'} |`)
    })
    L.push('')
  }
  if (turn.files_changed.length > 0) {
    L.push('## 文件变更')
    L.push('')
    for (const f of turn.files_changed) if (f) L.push('- ' + f)
    L.push('')
  }
  L.push('---')
  L.push(`session_id: ${turn.session_id} | turn_index: ${turn.turn_index} | mode: ${turn.mode}`)
  L.push('')
  return L.join('\n')
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}
function esc(s: string): string {
  return s.replace(/\|/g, '\\|')
}
function summarize(s: string, max: number): string {
  if (!s) return ''
  const t = s.replace(/\r/g, ' ').replace(/\n/g, ' ')
  return t.length > max ? t.slice(0, max) + '...' : t
}

/** request_state → 中文可读标签（未知值透传原值）。 */
function requestStateLabel(state: string): string {
  switch (state) {
    case 'complete': return '已完成'
    case 'aborted': return '已中断（用户取消）'
    case 'blocked': return '已阻塞'
    case 'error': return '失败'
    case 'max-tokens': return '已达 token 上限'
    case 'interrupted': return '已中断（会话恢复补记）'
    case 'incomplete': return '未完成'
    default: return state
  }
}

/** 生成一个短 id（archive_id 前 8 位）。 */
export function shortId(archiveId: string): string {
  return archiveId.slice(0, 8)
}

/** 构造 manifest + session 元信息对象。 */
export interface ArchiveBundleInput {
  archiveId: string
  sessionId: string
  scope: 'latest_completed_turn' | 'session_snapshot'
  mode: string
  title: string
  turns: TurnRecord[]
  createdAt: string
  /** 点踩反馈（分类标签 + 原因文本），生成 feedback.md 放进 turn 同目录。 */
  feedback?: FeedbackRecord
}

/** 反馈标签的中文名映射（与现有 FeedbackDialog 分类一致）。 */
export const FEEDBACK_CATEGORY_LABELS: Record<string, string> = {
  'task-result': '任务结果',
  'instruction-following': '指令理解与遵循',
  'product-interaction': '产品功能与交互',
  'service-stability': '稳定性和速度',
  'resource-cost': '资源使用与费用',
  'security-privacy-permission': '安全隐私与权限',
  other: '其他',
}

/** 渲染反馈说明 Markdown。 */
export function renderFeedbackMarkdown(feedback: FeedbackRecord): string {
  const L: string[] = []
  L.push('# 反馈说明')
  L.push('')
  L.push(`- **归档时间**：${feedback.createdAt ?? new Date().toISOString()}`)
  if (feedback.category) {
    const label = FEEDBACK_CATEGORY_LABELS[feedback.category] ?? feedback.category
    L.push(`- **分类标签**：${label}（${feedback.category}）`)
  }
  if (feedback.note && feedback.note.trim()) {
    L.push('')
    L.push('## 原因')
    L.push('')
    L.push(feedback.note.trim())
    L.push('')
  }
  if (!feedback.category && !(feedback.note && feedback.note.trim())) {
    L.push('')
    L.push('（无分类标签与原因）')
    L.push('')
  }
  return L.join('\n')
}

/** 打包为 ZIP 字节。 */
export function buildZip(input: ArchiveBundleInput): Uint8Array {
  const files: Zippable = {}
  const fileList: string[] = []

  // manifest.json
  const manifest = {
    archive_id: input.archiveId,
    scope: input.scope,
    session_id: input.sessionId,
    mode: input.mode,
    created_at: input.createdAt,
    files: [] as string[],
  }

  // session.json
  const turnsSummary = input.turns.map((t) => ({
    turn_index: t.turn_index,
    request_state: t.request_state,
    started_at: t.started_at,
    ended_at: t.ended_at,
    duration_ms: t.duration_ms,
    duration_source: t.duration_source,
    total_tokens: t.tokens.total_tokens,
    credit: t.tokens.credit,
    user_prompt: summarize(t.user_prompt, 120),
  }))
  const session = {
    session_id: input.sessionId,
    scope: input.scope,
    mode: input.mode,
    title: input.title,
    turn_count: input.turns.length,
    turns: turnsSummary,
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  files['session.json'] = strToU8(JSON.stringify(session, null, 2))
  fileList.push('manifest.json', 'session.json')

  // turn-NN.json / turn-NN.md
  for (const t of input.turns) {
    const nn = `turn-${String(t.turn_index).padStart(2, '0')}`
    files[`${nn}.json`] = strToU8(JSON.stringify(t, null, 2))
    files[`${nn}.md`] = strToU8(renderTurnMarkdown(t))
    fileList.push(`${nn}.json`, `${nn}.md`)
  }

  // feedback.md（点踩反馈：分类标签 + 原因文本），与 turn-NN 同级
  if (input.feedback) {
    files['feedback.md'] = strToU8(renderFeedbackMarkdown(input.feedback))
    fileList.push('feedback.md')
  }

  manifest.files = fileList
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))

  return zipSync(files, { level: 6 })
}
