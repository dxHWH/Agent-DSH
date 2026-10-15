/**
 * 独立端到端验证脚本：给定 session 文件 + messageId，跑「读→转换→打包→上传」。
 *
 * 用法：
 *   node scripts/archive-dsh-session.mjs <session.zstd路径> <messageId> [--dry-run] [--upload] [--note "原因"] [--category task-result]
 */
import { readSessionFile } from '../packages/dsh-tool-feedback-archive/lib/session-read.js'
import { convertEvents, findTurnByMessageId, modeOf } from '../packages/dsh-tool-feedback-archive/lib/convert.js'
import { buildZip, buildDisplayName, shortId } from '../packages/dsh-tool-feedback-archive/lib/zip.js'
import { uploadZip } from '../packages/dsh-tool-feedback-archive/lib/upload.js'
import { DEFAULT_UPLOAD_CONFIG } from '../packages/dsh-tool-feedback-archive/lib/archive.js'
import { randomUUID } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const file = args[0]
const messageId = args[1]
const dryRun = args.includes('--dry-run')
const doUpload = args.includes('--upload')
const noteIdx = args.indexOf('--note')
const categoryIdx = args.indexOf('--category')
const note = noteIdx >= 0 ? args[noteIdx + 1] : undefined
const category = categoryIdx >= 0 ? args[categoryIdx + 1] : undefined

if (!file || !messageId) {
  console.error('用法: node scripts/archive-dsh-session.mjs <session.zstd> <messageId> [--dry-run] [--upload] [--note "原因"] [--category task-result]')
  process.exit(1)
}

const { header, events } = readSessionFile(file)
const records = convertEvents(events, header)
const turn = findTurnByMessageId(events, records, messageId)

if (!turn) {
  console.error('未找到该 messageId 所属的 turn')
  process.exit(1)
}
console.log('=== 定位到 turn ===')
console.log(`  turn_index: ${turn.turn_index}, state: ${turn.request_state}`)
console.log(`  mode: ${turn.mode} (${modeOf(header)})`)
console.log(`  user_prompt: ${turn.user_prompt.slice(0, 60)}...`)
console.log(`  agent_response: ${turn.agent_response.slice(0, 60)}...`)
console.log(`  tool_calls: ${turn.tool_calls.length}, tokens: ${turn.tokens.total_tokens}, credit: ${turn.tokens.credit}`)
console.log(`  model: ${turn.model}, provider: ${turn.provider}`)
if (note || category) console.log(`  feedback: category=${category ?? '(无)'} note=${note ?? '(无)'}`)

if (turn.request_state !== 'complete') {
  console.error('该轮未完成，拒绝归档')
  process.exit(1)
}

const archiveId = randomUUID()
const sid = shortId(archiveId)
const remoteName = buildDisplayName(turn.mode, turn.user_prompt, sid)
console.log(`\n=== 远端文件名 ===`)
console.log(`  ${remoteName}`)

// 打包（含 feedback.md）
const feedback = (note || category) ? { note, category, createdAt: new Date().toISOString() } : undefined
const zipBytes = buildZip({
  archiveId,
  sessionId: header?.id ?? '',
  scope: 'latest_completed_turn',
  mode: turn.mode,
  title: turn.title || header?.id || '',
  turns: [turn],
  createdAt: new Date().toISOString(),
  ...(feedback ? { feedback } : {}),
})
console.log(`\n=== 打包 ===`)
console.log(`  ZIP 大小: ${zipBytes.length} bytes`)

// 写本地
const outDir = join(tmpdir(), 'feedback-archive-out')
mkdirSync(outDir, { recursive: true })
const zipPath = join(outDir, remoteName)
writeFileSync(zipPath, zipBytes)
console.log(`  本地 ZIP: ${zipPath}`)

if (dryRun) {
  console.log('\n[dry-run] 未上传，ZIP 已生成。加 --upload 真实上传。')
  process.exit(0)
}

if (!doUpload) {
  console.log('\n未指定 --upload，跳过上传。')
  process.exit(0)
}

// 上传
console.log('\n=== 上传 ===')
const up = await uploadZip(zipPath, remoteName, turn.mode, DEFAULT_UPLOAD_CONFIG)
console.log(JSON.stringify(up, null, 2))
