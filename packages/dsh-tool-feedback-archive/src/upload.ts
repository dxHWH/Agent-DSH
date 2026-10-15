/**
 * 可选后端：ZIP → 企业微信微盘（wecom-cli 机器人直传）。默认后端为本地目录，见 local.ts。
 *
 * 依赖本机 wecom-cli（机器人凭证经 `wecom-cli auth init` 存本机，插件零凭证）。
 * 目录结构：<rootName>/<模式>/<日期>/（机器人自建目录，复用 search+create 自愈）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 默认归档根目录名。 */
export const DEFAULT_ROOT_NAME = 'AgentDesktop反馈归档'

export interface UploadConfig {
  /** wecom-cli.cmd 绝对路径（空 = 自动探测）。 */
  wecomCliPath?: string
  /** 归档根目录名（机器人自建空间内）。 */
  rootName?: string
  /** 归档根目录 folder_id（空 = 按名 search/create）。 */
  rootFolderId?: string
}

export interface UploadResult {
  ok: boolean
  fileid?: string
  remotePath?: string
  fileName?: string
  error?: string
  stage?: string
}

/** 解析 wecom-cli 为可直接 spawn 的 { cmd, args 前缀 }（避开 .cmd 的 EINVAL）。 */
export interface ResolvedCli {
  cmd: string
  prefixArgs: string[]
}

/**
 * 探测并解析 wecom-cli。
 * 优先解析 npm shim（wecom-cli.cmd → node.exe + @wecom/cli/bin/wecom.js），
 * 这样 spawn 时无需 shell、无 .cmd 转义问题。
 */
export function resolveWecomCli(explicit?: string): ResolvedCli | null {
  let shim: string | null = null
  if (explicit && existsSync(explicit)) shim = explicit
  if (!shim && process.env.WECOM_CLI && existsSync(process.env.WECOM_CLI)) shim = process.env.WECOM_CLI
  const appData = process.env.APPDATA
  const candidates: string[] = []
  if (appData) candidates.push(join(appData, 'npm', 'wecom-cli.cmd'))
  // 可选：打包者手动放进 resources/wecom-cli/ 的 wecom-cli.exe（默认不随包分发）。
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push(join(resourcesPath, 'wecom-cli', 'wecom-cli.exe'))
  if (!shim) for (const c of candidates) if (existsSync(c)) { shim = c; break }
  if (!shim) return null

  // 若为 .cmd（npm shim），解析同目录 node.exe + wecom.js
  if (shim.toLowerCase().endsWith('.cmd')) {
    const dir = dirname(shim)
    const nodeExe = join(dir, 'node.exe')
    const wecomJs = join(dir, 'node_modules', '@wecom', 'cli', 'bin', 'wecom.js')
    if (existsSync(nodeExe) && existsSync(wecomJs)) {
      return { cmd: nodeExe, prefixArgs: [wecomJs] }
    }
  }
  // 直接可执行（exe / 无扩展名）
  return { cmd: shim, prefixArgs: [] }
}

/** 运行 wecom-cli 子命令，返回 { code, stdout, stderr }。 */
function runCli(resolved: ResolvedCli, args: string[], timeoutMs = 120000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.cmd, [...resolved.prefixArgs, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* noop */ }
    }, timeoutMs)
    child.stdout?.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr?.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** 从 wecom-cli 输出里解析 JSON（取首个以 { 开头的完整 JSON 对象）。 */
function parseJsonFrom(text: string): any | null {
  const idx = text.indexOf('{')
  if (idx < 0) return null
  try {
    return JSON.parse(text.slice(idx))
  } catch {
    return null
  }
}

/**
 * 当前授权机器人的 Bot ID（`wecom-cli auth show`，本地读取）。不缓存：用户可能在
 * 程序运行中换机器人重新授权。拿不到时返回 null（不按创建者过滤）。
 */
async function currentBotId(cli: ResolvedCli): Promise<string | null> {
  try {
    const { stdout } = await runCli(cli, ['auth', 'show'], 30000)
    return /Bot ID:\s*(\S+)/i.exec(stdout)?.[1] ?? null
  } catch {
    return null
  }
}

/** 从 CLI 输出取出错误信息（如 640008 权限不足）。 */
function cliError(stdout: string, stderr: string): string {
  const data = parseJsonFrom(stdout)
  const e = data?.error
  if (e?.message) return `${e.message}${e.code ? `（${e.code}）` : ''}`
  return (stdout + stderr).trim().split('\n').slice(-2).join(' | ').slice(0, 200)
}

/**
 * 按名查目录，返回 folder_id（校验父目录）。
 *
 * 只认当前机器人自己建的目录：机器人只能写入自己创建的微盘数据。换了新机器人后，
 * 搜索仍会命中旧机器人的同名归档根目录（同一授权人可见），往里建目录会
 * 640008 权限不足 —— 所以要按 creator_userid 过滤，找不到就在新机器人空间里新建。
 */
async function searchFolder(cli: ResolvedCli, name: string, parentId: string): Promise<string | null> {
  const botId = await currentBotId(cli)
  const { stdout } = await runCli(cli, ['disk', 'files', 'search', '--keywords', name, '--search-type', 'folder', '--limit', '50'])
  const data = parseJsonFrom(stdout)
  for (const f of data?.files ?? []) {
    if (f?.file_name !== name || f?.type !== 'folder') continue
    if (botId && f?.creator_userid && f.creator_userid !== botId) continue
    // 根目录：folder 的 folder_id === space_id（位于空间根）；子目录：folder_id === 父 id
    if (parentId === '') {
      if (f?.folder_id === f?.space_id) return String(f.id)
    } else {
      if (f?.folder_id === parentId) return String(f.id)
    }
  }
  return null
}

/** 建目录，返回 folder_id；失败时抛出 CLI 的真实错误。 */
async function createFolder(cli: ResolvedCli, parentId: string, name: string): Promise<string> {
  const args = ['disk', 'folders', 'create', '--folder-name', name]
  if (parentId) args.push('--folder-id', parentId)
  const { stdout, stderr } = await runCli(cli, args)
  const data = parseJsonFrom(stdout)
  const fid = data?.folder?.id
  if (fid) return String(fid)
  throw new Error(`无法创建微盘目录「${name}」：${cliError(stdout, stderr)}`)
}

/** 确保 <root>/<模式>/<日期>/ 链路存在，返回日期目录 folder_id。 */
async function ensureTargetDir(cli: ResolvedCli, cfg: UploadConfig, mode: string): Promise<string> {
  const rootName = cfg.rootName ?? DEFAULT_ROOT_NAME
  const rootId = cfg.rootFolderId
  const today = new Date()
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  // 不传 folder-id 时 create 落在机器人自己的空间根目录（新机器人首次归档即自动建好）。
  const root = rootId || await searchFolder(cli, rootName, '') || await createFolder(cli, '', rootName)
  const modeDir = await searchFolder(cli, mode, root) || await createFolder(cli, root, mode)
  return await searchFolder(cli, dateStr, modeDir) || await createFolder(cli, modeDir, dateStr)
}

/**
 * 上传 ZIP 到微盘。
 * @param zipPath 本地 ZIP 路径
 * @param remoteName 远端文件名
 * @param mode 模式（预设显示名，决定目录）
 * @param cfg 配置
 */
export async function uploadZip(zipPath: string, remoteName: string, mode: string, cfg: UploadConfig): Promise<UploadResult> {
  const cli = resolveWecomCli(cfg.wecomCliPath)
  if (!cli) {
    return { ok: false, stage: 'wecom-cli', error: '未找到 wecom-cli（npm i -g @wecom/cli，或在 settings.yaml 的 feedback-archive.wecomCliPath 指定，或设置 WECOM_CLI）' }
  }
  if (!existsSync(zipPath)) {
    return { ok: false, stage: 'zip', error: `ZIP 不存在：${zipPath}` }
  }

  let folderId: string
  try {
    folderId = await ensureTargetDir(cli, cfg, mode)
  } catch (e) {
    return { ok: false, stage: 'ensure-dir', error: e instanceof Error ? e.message : String(e) }
  }

  try {
    const { code, stdout, stderr } = await runCli(cli, [
      'disk', 'files', 'upload',
      '--file-path', zipPath,
      '--file-name', remoteName,
      '--folder-id', folderId,
    ], 300000)
    const data = parseJsonFrom(stdout)
    const file = data?.file ?? data
    const fileid = file?.id
    if (code === 0 && fileid) {
      return { ok: true, fileid: String(fileid), remotePath: file?.path ?? '', fileName: remoteName }
    }
    return { ok: false, stage: 'upload', error: `上传失败（exit=${code}）：${cliError(stdout, stderr)}` }
  } catch (e) {
    return { ok: false, stage: 'upload', error: e instanceof Error ? e.message : String(e) }
  }
}
