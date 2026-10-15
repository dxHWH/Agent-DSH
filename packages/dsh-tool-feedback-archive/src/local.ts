/**
 * 默认后端：把归档 ZIP 保存到本机目录。
 *
 * 目录结构：<localDir>/<模式>/<YYYY-MM-DD>/<显示名>.zip
 * `localDir` 为空时使用 `<DSH 数据根>/feedback-archive`（DSH_HOME 由桌面壳在启动时设置）。
 * 无网络、无凭证；同名文件自动追加序号，绝不覆盖已有归档。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'

export interface LocalSaveResult {
  ok: boolean
  path?: string
  error?: string
}

/** 本地归档根目录。 */
export function resolveLocalDir(configured?: string): string {
  const c = (configured ?? '').trim()
  if (c) return isAbsolute(c) ? c : resolve(c)
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'feedback-archive')
}

/** Windows 文件名非法字符替换为 `_`。 */
function safeSegment(s: string): string {
  return s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'archive'
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function saveZipLocally(zipBytes: Uint8Array, fileName: string, mode: string, localDir?: string): LocalSaveResult {
  try {
    const dir = join(resolveLocalDir(localDir), safeSegment(mode), today())
    mkdirSync(dir, { recursive: true })
    const base = safeSegment(fileName.replace(/\.zip$/i, ''))
    const ext = extname(fileName) || '.zip'
    let target = join(dir, base + ext)
    for (let n = 2; existsSync(target); n++) target = join(dir, `${base} (${n})${ext}`)
    writeFileSync(target, zipBytes, { flag: 'wx' })
    return { ok: true, path: target }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
