/**
 * MCP server configuration for the settings window.
 *
 * Owns reading and writing the `dsh-mcp-client` rows inside an agent preset's
 * `agent.cordis.yml`, plus a dry-run "test connection + list tools" that talks
 * MCP Streamable HTTP directly over JSON-RPC (so the shell needs no MCP SDK
 * dependency).
 *
 * ## Why text-level editing instead of a YAML library
 *
 * `agent.cordis.yml` carries comments and `!!js` expressions (e.g.
 * `disabled: !!js process.platform === 'win32'`) that a YAML round-trip would
 * destroy. We therefore locate the MCP block and edit it as text, leaving every
 * other line byte-identical. The block is delimited by the plugin marker
 * `name: '@deepseek-ai/dsh-mcp-client'`.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** One MCP server row, as the settings UI edits it. */
export interface McpServerEntry {
  id: string
  serverName: string
  transport: 'stdio' | 'streamable-http'
  /** streamable-http */
  url: string
  headers: Record<string, string>
  /** stdio */
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  toolCallTimeoutMs: number
  failOnStartupError: boolean
}

export interface McpServerSummary {
  id: string
  serverName: string
  transport: 'stdio' | 'streamable-http'
  url: string
  command: string
}

export interface McpTestResult {
  ok: boolean
  serverName: string
  serverInfo?: { name: string; version: string }
  protocolVersion?: string
  tools?: { name: string; description: string }[]
  error?: string
}

/** A preset directory name and whether its agent.cordis.yml exists. */
export interface McpPreset {
  id: string
  hasConfig: boolean
}

const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client'

/** Resolve the agent presets directory under a DSH home. */
export function presetsDir(dshHome: string): string {
  return join(dshHome, '.agent-presets')
}

/** The agent.cordis.yml path for one preset. */
export function presetConfigPath(dshHome: string, presetId: string): string {
  return join(presetsDir(dshHome), presetId, 'agent.cordis.yml')
}

/** List preset ids that have a directory (config may or may not exist). */
export function listPresets(dshHome: string): McpPreset[] {
  const dir = presetsDir(dshHome)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((name) => {
        try { return statSync(join(dir, name)).isDirectory() } catch { return false }
      })
      .map((id) => ({ id, hasConfig: existsSync(presetConfigPath(dshHome, id)) }))
      .sort((a, b) => a.id.localeCompare(b.id))
  } catch {
    return []
  }
}

/**
 * Parse the MCP rows out of an `agent.cordis.yml` body as text.
 *
 * Each row is a top-level list item (`- id: ...`) whose `name` is the MCP client
 * plugin. We split the file into lines and walk the top-level items.
 */
export function parseMcpServers(body: string): { entries: McpServerEntry[]; error?: string } {
  const lines = body.split(/\r?\n/)
  const entries: McpServerEntry[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!/^- id:/.test(line)) { i++; continue }
    // Collect this item's lines until the next top-level `- ` or end.
    const itemLines: string[] = [line]
    let j = i + 1
    while (j < lines.length && !/^- /.test(lines[j])) {
      itemLines.push(lines[j])
      j++
    }
    const block = itemLines.join('\n')

    if (!block.includes(`name: '${MCP_CLIENT_PLUGIN}'`) && !block.includes(`name: "${MCP_CLIENT_PLUGIN}"`)) {
      i = j
      continue
    }

    const entry = parseMcpBlock(block)
    if (entry) entries.push(entry)
    i = j
  }

  return { entries }
}

/** Parse one `- id: ... / name: '@deepseek-ai/dsh-mcp-client' / config: ...` block. */
function parseMcpBlock(block: string): McpServerEntry | null {
  const id = /^- id:\s*(\S+)/.exec(block)?.[1] ?? ''
  const serverName = strField(block, 'serverName') ?? ''
  const transport = strField(block, 'transport')
  if (!serverName || (transport !== 'stdio' && transport !== 'streamable-http')) return null

  const entry: McpServerEntry = {
    id,
    serverName,
    transport,
    url: transport === 'streamable-http' ? (strField(block, 'url') ?? '') : '',
    headers: mapField(block, 'headers'),
    command: transport === 'stdio' ? (strField(block, 'command') ?? '') : '',
    args: listField(block, 'args'),
    env: mapField(block, 'env'),
    cwd: strField(block, 'cwd') ?? '',
    toolCallTimeoutMs: numField(block, 'toolCallTimeoutMs') ?? 60000,
    failOnStartupError: boolField(block, 'failOnStartupError') ?? false,
  }
  return entry
}

function strField(block: string, name: string): string | null {
  const m = new RegExp(`^\\s+${name}:\\s*['"]([^'"]*)['"]`, 'm').exec(block)
  if (m) return m[1]
  // unquoted scalar (e.g. url: https://...)
  const m2 = new RegExp(`^\\s+${name}:\\s*(\\S+)`, 'm').exec(block)
  return m2 ? m2[1] : null
}

/** Unquote one YAML scalar ('x' / "x" / x). Single-quoted '' is an escaped quote. */
function unquoteYaml(raw: string): string {
  const s = raw.trim()
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s) as string } catch { return s.slice(1, -1) }
  }
  return s
}

/** Split a flow sequence body (`a, 'b, c', "d"`) on top-level commas. */
function splitFlow(body: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  for (let k = 0; k < body.length; k++) {
    const ch = body[k]
    if (q) {
      cur += ch
      if (ch === q) {
        if (q === "'" && body[k + 1] === "'") { cur += body[++k]; continue }
        q = null
      }
    } else if (ch === "'" || ch === '"') { q = ch; cur += ch }
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out.map(unquoteYaml).filter((s) => s.length > 0)
}

/** Lines indented deeper than `key:` that follow it (its block children). */
function childLines(block: string, name: string): { indent: number; inline: string; children: string[] } | null {
  const lines = block.split('\n')
  for (let k = 0; k < lines.length; k++) {
    const m = new RegExp(`^(\\s+)${name}:(.*)$`).exec(lines[k])
    if (!m) continue
    const indent = m[1].length
    const children: string[] = []
    for (let n = k + 1; n < lines.length; n++) {
      const l = lines[n]
      if (!l.trim() || /^\s*#/.test(l)) continue
      if (l.length - l.trimStart().length <= indent) break
      children.push(l.trim())
    }
    return { indent, inline: m[2].replace(/\s+#.*$/, '').trim(), children }
  }
  return null
}

/** Read a string list in flow (`[a, b]`) or block (`- a`) form. */
function listField(block: string, name: string): string[] {
  const f = childLines(block, name)
  if (!f) return []
  if (f.inline.startsWith('[')) return splitFlow(f.inline.replace(/^\[/, '').replace(/\]$/, ''))
  return f.children.filter((l) => l.startsWith('- ')).map((l) => unquoteYaml(l.slice(2)))
}

/** Read a flat string map in block form (`key: value` children). */
function mapField(block: string, name: string): Record<string, string> {
  const f = childLines(block, name)
  const out: Record<string, string> = {}
  if (!f) return out
  for (const l of f.children) {
    const m = /^([^:\s]+|'[^']*'|"[^"]*"):\s*(.*)$/.exec(l)
    if (m) out[unquoteYaml(m[1])] = unquoteYaml(m[2])
  }
  return out
}

function numField(block: string, name: string): number | null {
  const m = new RegExp(`^\\s+${name}:\\s*(\\d+)`, 'm').exec(block)
  return m ? Number(m[1]) : null
}

function boolField(block: string, name: string): boolean | null {
  const m = new RegExp(`^\\s+${name}:\\s*(true|false)`, 'm').exec(block)
  return m ? m[1] === 'true' : null
}

/** Render one entry back to a `- id: ...` YAML block (4-space config indent). */
export function renderMcpBlock(entry: McpServerEntry): string {
  const lines = [`- id: ${entry.id}`, `  name: '${MCP_CLIENT_PLUGIN}'`, `  config:`]
  lines.push(`    serverName: ${quoteYaml(entry.serverName)}`)
  lines.push(`    transport: ${entry.transport}`)
  if (entry.transport === 'streamable-http') {
    lines.push(`    url: ${quoteYaml(entry.url)}`)
    if (Object.keys(entry.headers).length > 0) {
      lines.push(`    headers:`)
      for (const [k, v] of Object.entries(entry.headers)) lines.push(`      ${k}: ${quoteYaml(v)}`)
    }
  } else {
    lines.push(`    command: ${quoteYaml(entry.command)}`)
    if (entry.args.length > 0) lines.push(`    args: [${entry.args.map((a) => quoteYaml(a)).join(', ')}]`)
    if (entry.cwd) lines.push(`    cwd: ${quoteYaml(entry.cwd)}`)
    if (Object.keys(entry.env).length > 0) {
      lines.push(`    env:`)
      for (const [k, v] of Object.entries(entry.env)) lines.push(`      ${k}: ${quoteYaml(v)}`)
    }
  }
  if (entry.toolCallTimeoutMs !== 60000) lines.push(`    toolCallTimeoutMs: ${entry.toolCallTimeoutMs}`)
  if (entry.failOnStartupError) lines.push(`    failOnStartupError: true`)
  return lines.join('\n')
}

function quoteYaml(value: string): string {
  if (/^[A-Za-z0-9_.\-/:]+$/.test(value) && value !== '') return value
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Update or remove one MCP entry in the body by id, preserving all other lines
 * byte-for-byte. Pass `entry: null` to remove the matching row. Returns the new
 * body (or the original body unchanged when the id was not found).
 */
export function writeMcpServer(
  body: string,
  entry: McpServerEntry | null, // null = remove by id
  id: string,
): string {
  const lines = body.split(/\r?\n/)
  const out: string[] = []
  let i = 0
  let replaced = false

  while (i < lines.length) {
    const line = lines[i]
    if (!/^- id:/.test(line)) {
      out.push(line)
      i++
      continue
    }
    const itemLines: string[] = [line]
    let j = i + 1
    while (j < lines.length && !/^- /.test(lines[j])) {
      itemLines.push(lines[j])
      j++
    }
    const block = itemLines.join('\n')
    const isMcp = block.includes(`name: '${MCP_CLIENT_PLUGIN}'`) || block.includes(`name: "${MCP_CLIENT_PLUGIN}"`)
    const blockId = /^- id:\s*(\S+)/.exec(block)?.[1] ?? ''

    if (isMcp && blockId === id) {
      if (entry !== null) out.push(renderMcpBlock(entry))
      replaced = true
      i = j
      continue
    }

    out.push(...itemLines)
    i = j
  }

  return out.join('\n')
}

/** Append a new MCP entry to the body (used for add). */
export function appendMcpServer(body: string, entry: McpServerEntry): string {
  const block = renderMcpBlock(entry)
  const trimmed = body.replace(/\s+$/, '')
  return `${trimmed}\n\n${block}\n`
}

/** Read a preset's agent.cordis.yml; returns null when missing. */
export function readPresetConfig(dshHome: string, presetId: string): string | null {
  const path = presetConfigPath(dshHome, presetId)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

export function writePresetConfig(dshHome: string, presetId: string, body: string): { ok: boolean; error?: string } {
  const path = presetConfigPath(dshHome, presetId)
  try {
    writeFileSync(path, body, 'utf8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

// ── Project directory (`dsh-tool-example` projectRoot) ────────────────────────

const PROJECT_PLUGIN = '@deepseek-ai/dsh-tool-example'

/** The project tool plugin's bound project directory. */
export interface ProjectConfig {
  projectRoot: string
  reportDir: string
}

/**
 * Read the `projectRoot` / `reportDir` out of a `tool-example` plugin block.
 *
 * Reuses the same text-level, comment-preserving approach as the MCP block:
 * the `tool-example` row is a top-level list item whose `name` is the plugin,
 * and its `config.projectRoot` carries the bound project directory.
 */
export function parseProjectConfig(body: string): ProjectConfig | null {
  const lines = body.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!/^- id:/.test(line)) { i++; continue }
    const itemLines: string[] = [line]
    let j = i + 1
    while (j < lines.length && !/^- /.test(lines[j])) {
      itemLines.push(lines[j])
      j++
    }
    const block = itemLines.join('\n')
    if (block.includes(`name: '${PROJECT_PLUGIN}'`) || block.includes(`name: "${PROJECT_PLUGIN}"`)) {
      return {
        projectRoot: strField(block, 'projectRoot') ?? '',
        reportDir: strField(block, 'reportDir') ?? '',
      }
    }
    i = j
  }
  return null
}

/**
 * Write `projectRoot` into the `tool-example` block, preserving every other line
 * byte-for-byte. When the block already has a `config.projectRoot` line, it is
 * replaced in place; otherwise a `projectRoot` line is inserted under `config`.
 * `reportDir` is left untouched.
 */
export function writeProjectRoot(body: string, projectRoot: string): string {
  const lines = body.split(/\r?\n/)
  const out: string[] = []
  let i = 0
  let replaced = false

  while (i < lines.length) {
    const line = lines[i]
    if (!/^- id:/.test(line)) {
      out.push(line)
      i++
      continue
    }
    const itemLines: string[] = [line]
    let j = i + 1
    while (j < lines.length && !/^- /.test(lines[j])) {
      itemLines.push(lines[j])
      j++
    }
    const block = itemLines.join('\n')
    const isProjectRow = block.includes(`name: '${PROJECT_PLUGIN}'`) || block.includes(`name: "${PROJECT_PLUGIN}"`)

    if (isProjectRow) {
      out.push(...rewriteProjectRootBlock(itemLines, projectRoot))
      replaced = true
      i = j
      continue
    }

    out.push(...itemLines)
    i = j
  }

  return out.join('\n')
}

/** Replace or insert the `projectRoot` line inside one tool-example block's lines. */
function rewriteProjectRootBlock(itemLines: string[], projectRoot: string): string[] {
  const result: string[] = []
  let inserted = false
  let sawConfig = false
  const indent = '    ' // config: is at 2 spaces, its keys at 4
  const target = `${indent}projectRoot:`

  for (const line of itemLines) {
    if (/^\s+projectRoot:\s*/.test(line)) {
      // Replace the existing value in place, preserving its quote style.
      result.push(`${indent}projectRoot: ${quoteYaml(projectRoot)}`)
      inserted = true
      continue
    }
    result.push(line)
    if (/^\s+config:\s*$/.test(line)) sawConfig = true
  }

  // No projectRoot line found: insert it right after the `config:` line.
  if (!inserted && sawConfig) {
    const configIdx = result.findIndex((l) => /^\s+config:\s*$/.test(l))
    result.splice(configIdx + 1, 0, `${indent}projectRoot: ${quoteYaml(projectRoot)}`)
  }

  return result
}

// ── MCP Streamable HTTP connection test (JSON-RPC over fetch) ────────────────

const MCP_PROTOCOL_VERSION = '2025-11-25'
const MCP_FALLBACK_VERSION = '2025-03-26'

/** Minimal JSON-RPC call to an MCP Streamable HTTP endpoint. */
async function mcpRpc(
  url: string,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ ok: boolean; result?: any; error?: string; sessionId?: string; protocolVersion?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 1000))
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    })
    const sessionId = resp.headers.get('mcp-session-id') ?? undefined
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status} ${resp.statusText}`, sessionId }
    }
    const contentType = resp.headers.get('content-type') ?? ''
    const text = await resp.text()
    // Streamable HTTP may return SSE; for initialize/tools-list the payload is
    // usually a single JSON object. Handle both.
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      // SSE fallback: extract the first `data:` line carrying JSON.
      const m = /^data:\s*(\{.*\})/m.exec(text)
      if (!m) return { ok: false, error: `unexpected response (${contentType || 'unknown'})`, sessionId }
      data = JSON.parse(m[1])
    }
    if (data && data.error) {
      return { ok: false, error: `${data.error.code ?? ''} ${data.error.message ?? 'MCP error'}`.trim(), sessionId }
    }
    return { ok: true, result: data?.result, sessionId, protocolVersion: data?.result?.protocolVersion }
  } catch (e) {
    const msg = (e as Error)?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String((e as Error)?.message ?? e)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

/** Test an MCP server connection and return its tool list. */
export async function testMcpServer(entry: McpServerEntry): Promise<McpTestResult> {
  const base: McpTestResult = { ok: false, serverName: entry.serverName }
  if (entry.transport !== 'streamable-http') {
    return { ...base, error: 'stdio transport test is not yet supported; only streamable-http can be tested here' }
  }
  if (!entry.url) return { ...base, error: 'missing url' }

  // 1. initialize
  const init = await mcpRpc(entry.url, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'dsh-desktop-settings', version: '0.0.0' },
  }, entry.headers, entry.toolCallTimeoutMs)
  if (!init.ok) return { ...base, error: `initialize failed: ${init.error}` }

  // The server may negotiate an older protocol version; respect it for the next call.
  const negotiated = init.protocolVersion ?? MCP_FALLBACK_VERSION

  // 2. tools/list
  const toolsResp = await mcpRpc(entry.url, 'tools/list', {}, entry.headers, entry.toolCallTimeoutMs)
  if (!toolsResp.ok) return { ...base, error: `tools/list failed: ${toolsResp.error}` }

  const serverInfo = init.result?.serverInfo
  const tools = Array.isArray(toolsResp.result?.tools)
    ? toolsResp.result.tools.map((t: any) => ({ name: String(t?.name ?? ''), description: String(t?.description ?? '') }))
    : []

  return {
    ok: true,
    serverName: entry.serverName,
    serverInfo: serverInfo ? { name: String(serverInfo.name ?? ''), version: String(serverInfo.version ?? '') } : undefined,
    protocolVersion: negotiated,
    tools,
  }
}
