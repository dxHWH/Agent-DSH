/**
 * 编排：读 session → 转换 → 打包 → 保存（本地目录，默认）或上传（企业微信微盘，可选），返回归档结果。
 *
 * 供 host 插件 Remote 与独立验证脚本复用。
 */
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertEvents, findTurnByMessageId, modeOf } from './convert.js'
import { readSessionFile } from './session-read.js'
import { buildZip, buildDisplayName, shortId } from './zip.js'
import { saveZipLocally } from './local.js'
import { DEFAULT_ROOT_NAME, uploadZip, type UploadConfig } from './upload.js'
import type { FeedbackRecord, SessionHeaderLike, SessionEventLike, TurnRecord } from './types.js'

/** 归档后端：本地目录（默认）或企业微信微盘（可选）。 */
export type ArchiveBackend = 'local' | 'wecom'

/** 归档配置（来自 settings.yaml 的 `feedback-archive` 段）。 */
export interface ArchiveConfig extends UploadConfig {
  backend?: ArchiveBackend
  /** 本地归档目录（空 = <数据根>/feedback-archive）。 */
  localDir?: string
}

/** 默认配置。 */
export const DEFAULT_UPLOAD_CONFIG: ArchiveConfig = {
  backend: 'local',
  rootName: DEFAULT_ROOT_NAME,
  // wecom 后端不写死 folder_id：机器人只能写自己建的目录。留空 = 在当前机器人的空间里按名查找，
  // 没有就新建（换机器人后自动生效）。确需指定时在 settings.yaml 的 feedback-archive.rootFolderId 填写。
}

export interface ArchiveRequest {
  sessionId: string
  messageId: string
  note?: string
  category?: string
}

export interface ArchiveResult {
  ok: boolean
  archiveId?: string
  fileid?: string
  remotePath?: string
  /** 本地后端保存的绝对路径。 */
  localPath?: string
  backend?: ArchiveBackend
  fileName?: string
  mode?: string
  turnIndex?: number
  error?: string
  stage?: string
}

/**
 * 从 session 文件路径归档「被点踩的那一轮」。
 * @param sessionFilePath .jsonl.zstd 路径
 * @param messageId 被点踩的 assistant 消息 id
 * @param feedback 点踩反馈（分类标签 + 原因文本）
 */
export async function archiveFromFile(
  sessionFilePath: string,
  messageId: string,
  cfg: ArchiveConfig,
  feedback?: FeedbackRecord,
): Promise<ArchiveResult> {
  let header: SessionHeaderLike | undefined
  let events: SessionEventLike[]
  try {
    const r = readSessionFile(sessionFilePath)
    header = r.header
    events = r.events
  } catch (e) {
    return { ok: false, stage: 'read', error: e instanceof Error ? e.message : String(e) }
  }

  return archiveFromEvents(header, events, messageId, cfg, feedback)
}

/**
 * 从已解析的事件流归档「被点踩的那一轮」。
 * @param feedback 点踩反馈（分类标签 + 原因文本），会生成 feedback.md 放进 ZIP 内 turn 同目录。
 */
export async function archiveFromEvents(
  header: SessionHeaderLike | undefined,
  events: SessionEventLike[],
  messageId: string,
  cfg: ArchiveConfig,
  feedback?: FeedbackRecord,
): Promise<ArchiveResult> {
  const records = convertEvents(events, header)
  const turn = findTurnByMessageId(events, records, messageId)
  if (!turn) {
    return { ok: false, stage: 'locate', error: `未找到 messageId=${messageId} 所属的轮` }
  }
  // 允许归档未完成（暂停/中断/失败等）的轮：只要该轮有用户输入即可打包。
  // 不再拒绝 request_state !== 'complete'，否则暂停的计划/对话点踩归档会失败。
  if (!turn.user_prompt.trim()) {
    return { ok: false, stage: 'locate', error: '该轮缺少用户输入，无法归档' }
  }

  const mode = modeOf(header)
  const archiveId = randomUUID()
  const sid = shortId(archiveId)
  const remoteName = buildDisplayName(mode, turn.user_prompt, sid)
  const createdAt = new Date().toISOString()

  // 打包
  let zipBytes: Uint8Array
  try {
    zipBytes = buildZip({
      archiveId,
      sessionId: header?.id ?? '',
      scope: 'latest_completed_turn',
      mode,
      title: turn.title || header?.id || '',
      turns: [turn],
      createdAt,
      ...(feedback ? { feedback: { ...feedback, createdAt } } : {}),
    })
  } catch (e) {
    return { ok: false, stage: 'zip', error: e instanceof Error ? e.message : String(e) }
  }

  // 默认：保存到本地目录
  if ((cfg.backend ?? 'local') !== 'wecom') {
    const saved = saveZipLocally(zipBytes, remoteName, mode, cfg.localDir)
    if (!saved.ok) return { ok: false, stage: 'save', error: saved.error }
    return {
      ok: true,
      backend: 'local',
      archiveId,
      localPath: saved.path,
      fileName: remoteName,
      mode,
      turnIndex: turn.turn_index,
    }
  }

  // 可选：企业微信微盘。先落临时文件再交给 wecom-cli。
  const tmpZip = join(tmpdir(), `feedback-archive-${sid}.zip`)
  try {
    writeFileSync(tmpZip, zipBytes)
  } catch (e) {
    return { ok: false, stage: 'zip', error: e instanceof Error ? e.message : String(e) }
  }

  const up = await uploadZip(tmpZip, remoteName, mode, cfg)
  try { unlinkSync(tmpZip) } catch { /* best effort */ }
  if (!up.ok) {
    return { ok: false, stage: up.stage, error: up.error }
  }
  return {
    ok: true,
    backend: 'wecom',
    archiveId,
    fileid: up.fileid,
    remotePath: up.remotePath,
    fileName: remoteName,
    mode,
    turnIndex: turn.turn_index,
  }
}
