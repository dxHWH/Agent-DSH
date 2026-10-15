/**
 * First-run install of the bundled "project" agent preset.
 *
 * The package ships a template under `resources/agent-preset/project/` that
 * contains **no machine-specific paths**, only four placeholders:
 *
 *   __PROJECT_ROOT__       project directory — left empty; the user binds it in
 *                          Settings → Project & Index
 *   __NODE_EXE__           node.exe for the knowledge-base MCP bridge — filled
 *                          when a system Node.js is detected
 *   __MCP_REMOTE_PROXY__   mcp-remote's proxy.js — npm global install
 *   __MCP_AUTH_DIR__       %USERPROFILE%\.mcp-auth
 *
 * Rules:
 * - An existing `<data root>/.agent-presets/project/` is **never overwritten**
 *   (user edits and copied presets win).
 * - The knowledge-base MCP row ships `disabled: true` in the template; the user
 *   enables it after pointing it at a real server.
 */
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Directory name of the bundled preset under `.agent-presets/`. */
export const PROJECT_PRESET_ID = 'project'

export interface AgentPresetResult {
  action: 'installed' | 'kept-existing' | 'no-template'
  detail: string
}

function templateDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'agent-preset', PROJECT_PRESET_ID)
    : join(app.getAppPath(), 'assets', 'agent-preset', PROJECT_PRESET_ID)
}

/** A system Node.js (the mcp-remote bridge needs a real Node, not Electron). */
function findNodeExe(): string | null {
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'nodejs', 'node.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'] as string, 'nodejs', 'node.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'),
    process.env.NVM_SYMLINK && join(process.env.NVM_SYMLINK, 'node.exe'),
  ].filter(Boolean) as string[]
  for (const dir of (process.env.PATH ?? '').split(';')) if (dir) candidates.push(join(dir, 'node.exe'))
  return candidates.find((p) => existsSync(p)) ?? null
}

function defaultMcpRemoteProxy(): string {
  return join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'mcp-remote', 'dist', 'proxy.js')
}

/**
 * File-by-file copy that never overwrites.
 * Not `fs.cpSync`: on Windows its native implementation crashes the whole main
 * process on non-ASCII paths, and try/catch cannot intercept that.
 */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const s = join(from, e.name)
    const d = join(to, e.name)
    if (e.isDirectory()) copyTree(s, d)
    else if (!existsSync(d)) copyFileSync(s, d)
  }
}

/** YAML single-quoted string: only `'` needs escaping (as `''`). */
const q = (s: string): string => s.replace(/'/g, "''")

export function ensureProjectPreset(dshHome: string): AgentPresetResult {
  const target = join(dshHome, '.agent-presets', PROJECT_PRESET_ID)
  if (existsSync(join(target, 'agent.cordis.yml'))) return { action: 'kept-existing', detail: target }

  const tpl = templateDir()
  if (!existsSync(join(tpl, 'agent.cordis.yml'))) return { action: 'no-template', detail: tpl }

  const nodeExe = findNodeExe()
  const body = readFileSync(join(tpl, 'agent.cordis.yml'), 'utf8')
    .replace('__PROJECT_ROOT__', '')
    .replace('__NODE_EXE__', q(nodeExe ?? 'node.exe'))
    .replace('__MCP_REMOTE_PROXY__', q(defaultMcpRemoteProxy()))
    .replaceAll('__MCP_AUTH_DIR__', q(join(homedir(), '.mcp-auth')))

  copyTree(tpl, target)
  writeFileSync(join(target, 'agent.cordis.yml'), body, 'utf8')
  return { action: 'installed', detail: `${target} (node: ${nodeExe ?? 'not found'})` }
}
