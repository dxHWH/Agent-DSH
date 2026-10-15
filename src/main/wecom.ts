/**
 * 企业微信机器人授权（点踩归档的可选 wecom 后端）—— 设置面板后端。
 *
 * 凭证由 wecom-cli 自己加密保存（`%USERPROFILE%\.config\wecom\credentials.enc` +
 * `.encryption_key`），本模块**不落盘、不记录** Bot ID / Secret 明文：
 *
 * 1. Secret 只在内存里经 ConPTY 写给 `wecom-cli auth init --manual`。
 *    wecom-cli 的手动模式要求真实终端（管道 stdin 会被拒：893001），
 *    所以用随包的 node-pty 起一个隐藏的伪终端来填两个提示。
 * 2. 先在**临时配置目录**（`WECOM_CLI_CONFIG_DIR`）里授权并在线验证；
 *    成功后才把两份凭证文件拷进正式目录。凭证错误时正式目录完全不动，
 *    已有的可用授权不会被一次手误覆盖掉。
 * 3. 临时目录无论成败都会删除。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** wecom-cli 写凭证的两个文件。 */
const CREDENTIAL_FILES = ['credentials.enc', '.encryption_key'] as const

export interface WecomCliInfo {
  /** 实际调用的可执行文件。 */
  cmd: string
  /** 来源：settings / env / npm-global / bundled / dev。 */
  source: string
}

export interface WecomStatus {
  ok: boolean
  cli?: WecomCliInfo
  authorized?: boolean
  /** 已授权时的 Bot ID（来自 `auth show`，非 Secret）。 */
  botId?: string
  configDir: string
  error?: string
}

export interface WecomAuthResult {
  ok: boolean
  botId?: string
  error?: string
  /** 失败时的企业微信错误码（如 853000 = bot_id 或 secret 无效）。 */
  errcode?: number
}

/** wecom-cli 的正式配置目录（与 CLI 默认一致，可被 WECOM_CLI_CONFIG_DIR 覆盖）。 */
export function wecomConfigDir(): string {
  const fromEnv = process.env.WECOM_CLI_CONFIG_DIR
  return fromEnv && fromEnv.trim() ? fromEnv : join(homedir(), '.config', 'wecom')
}

/**
 * 读 `settings.yaml` 的 `feedback-archive.wecomCliPath`（与归档插件同一个设置项），
 * 只做最小解析，避免依赖 YAML 库。
 */
function configuredCliPath(dshHome: string): string {
  try {
    const body = readFileSync(join(dshHome, 'settings.yaml'), 'utf8')
    const block = /^feedback-archive:\s*\n((?:[ \t]+.*\n?)*)/m.exec(body)?.[1] ?? ''
    const m = /^\s+wecomCliPath:\s*['"]?([^'"\n]*)['"]?\s*$/m.exec(block)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

/**
 * 与 `dsh-tool-feedback-archive/src/upload.ts` 的 `resolveWecomCli` 同一查找顺序，
 * 保证设置面板授权的就是归档时实际调用的那个 CLI。
 * `.cmd` npm shim 解析为同目录 node.exe + wecom.js；node-pty 需要真实 exe，
 * 因此再进一步解析到平台二进制。
 */
export function resolveWecomCli(dshHome: string): WecomCliInfo | null {
  const candidates: { path: string; source: string }[] = []
  const explicit = configuredCliPath(dshHome)
  if (explicit) candidates.push({ path: explicit, source: 'settings' })
  if (process.env.WECOM_CLI) candidates.push({ path: process.env.WECOM_CLI, source: 'env' })
  if (process.env.APPDATA) candidates.push({ path: join(process.env.APPDATA, 'npm', 'wecom-cli.cmd'), source: 'npm-global' })
  // 可选：打包者手动放进 resources/wecom-cli/ 的二进制（默认不随包分发）。
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push({ path: join(resourcesPath, 'wecom-cli', 'wecom-cli.exe'), source: 'bundled' })
  // 源码运行：若开发者自行 `npm i -D @wecom/cli-win32-x64`，用该二进制。
  candidates.push({ path: join(process.cwd(), 'node_modules', '@wecom', 'cli-win32-x64', 'bin', 'wecom-cli.exe'), source: 'dev' })

  for (const c of candidates) {
    if (!c.path || !existsSync(c.path)) continue
    if (c.path.toLowerCase().endsWith('.cmd')) {
      const exe = join(dirname(c.path), 'node_modules', '@wecom', 'cli', 'node_modules', '@wecom', 'cli-win32-x64', 'bin', 'wecom-cli.exe')
      const hoisted = join(dirname(c.path), 'node_modules', '@wecom', 'cli-win32-x64', 'bin', 'wecom-cli.exe')
      const found = [exe, hoisted].find((p) => existsSync(p))
      if (found) return { cmd: found, source: c.source }
      continue
    }
    return { cmd: c.path, source: c.source }
  }
  return null
}

/** 运行一次 `wecom-cli auth show`（只读，不涉及 Secret）。 */
function authShow(cmd: string, configDir?: string): Promise<{ authorized: boolean; botId?: string; raw: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env }
    if (configDir) env.WECOM_CLI_CONFIG_DIR = configDir
    const child = spawn(cmd, ['auth', 'show'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    const timer = setTimeout(() => child.kill(), 15000)
    const done = () => {
      clearTimeout(timer)
      const authorized = /Status:\s*authorized/i.test(out)
      const botId = /Bot ID:\s*(\S+)/i.exec(out)?.[1]
      resolve({ authorized, botId, raw: out.trim() })
    }
    child.on('close', done)
    child.on('error', () => { clearTimeout(timer); resolve({ authorized: false, raw: 'wecom-cli 启动失败' }) })
  })
}

export async function wecomStatus(dshHome: string): Promise<WecomStatus> {
  const configDir = wecomConfigDir()
  const cli = resolveWecomCli(dshHome)
  if (!cli) return { ok: false, configDir, error: '未找到 wecom-cli（可选后端：npm i -g @wecom/cli，或在 settings.yaml 的 feedback-archive.wecomCliPath 指定路径）' }
  const s = await authShow(cli.cmd)
  return { ok: true, cli, authorized: s.authorized, botId: s.botId, configDir }
}

/** 去掉 ANSI 控制序列。 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

/**
 * 在 `configDir` 里交互式执行 `auth init --manual`。
 * 返回 CLI 退出码与（脱敏后的）输出。
 */
function runManualInit(cmd: string, configDir: string, botId: string, secret: string): Promise<{ exitCode: number; output: string }> {
  // node-pty 是随包的原生模块（asarUnpack），惰性加载，避免主进程启动时就付出成本。
  const pty = require('node-pty') as typeof import('node-pty')
  return new Promise((resolve) => {
    const term = pty.spawn(cmd, ['auth', 'init', '--manual'], {
      name: 'xterm',
      cols: 200,
      rows: 40,
      env: { ...process.env, WECOM_CLI_CONFIG_DIR: configDir } as Record<string, string>,
    })
    let raw = ''
    let step = 0
    let settled = false
    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Secret 从未出现在输出里（CLI 回显为 ▪），这里仍兜底替换一次。
      const output = stripAnsi(raw).split(secret).join('***')
      resolve({ exitCode, output })
    }
    term.onData((chunk) => {
      raw += chunk
      const text = stripAnsi(raw)
      const botIdx = text.search(/Bot ?ID/i)
      if (step === 0 && botIdx >= 0) {
        step = 1
        setTimeout(() => term.write(`${botId}\r`), 250)
      } else if (step === 1 && /Secret/i.test(text.slice(botIdx + 6))) {
        step = 2
        setTimeout(() => term.write(`${secret}\r`), 250)
      }
    })
    term.onExit(({ exitCode }) => finish(exitCode))
    const timer = setTimeout(() => {
      try { term.kill() } catch { /* already gone */ }
      finish(-1)
    }, 60000)
  })
}

/**
 * 校验并保存机器人凭证。先在临时目录里在线验证，通过后才替换正式凭证。
 */
export async function wecomAuthorize(dshHome: string, botIdRaw: string, secretRaw: string): Promise<WecomAuthResult> {
  const botId = (botIdRaw ?? '').trim()
  const secret = (secretRaw ?? '').trim()
  if (!botId) return { ok: false, error: '请填写 Bot ID' }
  if (!secret) return { ok: false, error: '请填写 Secret' }
  if (/[\r\n]/.test(botId + secret)) return { ok: false, error: 'Bot ID / Secret 不能包含换行' }

  const cli = resolveWecomCli(dshHome)
  if (!cli) return { ok: false, error: '未找到 wecom-cli' }

  const staging = mkdtempSync(join(tmpdir(), 'dsh-wecom-auth-'))
  try {
    const { exitCode, output } = await runManualInit(cli.cmd, staging, botId, secret)
    const verified = await authShow(cli.cmd, staging)
    const haveFiles = CREDENTIAL_FILES.every((f) => existsSync(join(staging, f)))
    if (exitCode !== 0 || !verified.authorized || !haveFiles) {
      const errcode = Number(/"errcode"\s*:\s*(\d+)/.exec(output)?.[1]) || undefined
      const errmsg = /"errmsg"\s*:\s*"([^"]*)"/.exec(output)?.[1]
      const message = /"message"\s*:\s*"([^"]*)"/.exec(output)?.[1]
      let error: string
      if (errcode === 853000) error = 'Bot ID 或 Secret 无效（企业微信 853000），请核对后重试'
      else if (exitCode === -1) error = '授权超时（60 秒），请检查网络能否访问 qyapi.weixin.qq.com'
      else error = errmsg || message || `授权失败（exit=${exitCode}）`
      return { ok: false, error, errcode }
    }

    // 验证通过：替换正式凭证。保留一份旧凭证备份，便于手动回退。
    const target = wecomConfigDir()
    mkdirSync(target, { recursive: true })
    for (const f of CREDENTIAL_FILES) {
      const dest = join(target, f)
      if (existsSync(dest) && statSync(dest).isFile()) copyFileSync(dest, `${dest}.bak`)
    }
    for (const f of CREDENTIAL_FILES) copyFileSync(join(staging, f), join(target, f))

    const final = await authShow(cli.cmd)
    if (!final.authorized) return { ok: false, error: '凭证已验证但写入正式目录后读取失败，请重试或检查目录权限：' + target }
    return { ok: true, botId: final.botId ?? botId }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** 清除本机凭证（备份为 .bak，不可恢复授权状态需重新填写）。 */
export function wecomLogout(): { ok: boolean; error?: string } {
  try {
    const target = wecomConfigDir()
    for (const f of CREDENTIAL_FILES) {
      const p = join(target, f)
      if (existsSync(p)) {
        copyFileSync(p, `${p}.bak`)
        rmSync(p, { force: true })
      }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
