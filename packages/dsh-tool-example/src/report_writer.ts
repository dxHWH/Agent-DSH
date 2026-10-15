/**
 * Write a Markdown report and describe it as an artifact.
 *
 * Long results do not belong in the conversation: the model sees a compact
 * summary in `answer`, the full material lands in a file, and the tool
 * description tells the model to call `present` on the returned artifact so the
 * user gets a file card.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ArtifactRef } from './result.js'

/** Keep ASCII letters/digits, CJK, '-' and '_'; everything else becomes '_'. */
export function safeFilename(name: string): string {
  let out = ''
  for (const ch of name) {
    if (/[a-zA-Z0-9]/.test(ch) || ch === '-' || ch === '_') out += ch
    else if (ch >= '\u4e00' && ch <= '\u9fff') out += ch
    else out += '_'
  }
  return out.slice(0, 80) || 'report'
}

export interface WrittenReport {
  artifact?: ArtifactRef
  absolutePath?: string
  error?: string
}

/**
 * @param prefix - file-name prefix (the tool or domain name).
 * @param subject - what the report is about.
 * @param body - Markdown text.
 * @param outputDir - absolute, or relative to the session workspace.
 * @param workspaceRoot - the session workspace (`exec.agent.session.header.cwd`).
 */
export function writeReport(
  prefix: string,
  subject: string,
  body: string,
  outputDir: string,
  label: string,
  workspaceRoot: string | undefined,
): WrittenReport {
  try {
    const base = workspaceRoot ? resolve(workspaceRoot) : process.cwd()
    const dir = isAbsolute(outputDir) ? outputDir : join(base, outputDir)
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
    const abs = join(dir, `${safeFilename(prefix)}_${safeFilename(subject)}_${stamp}.md`)
    writeFileSync(abs, body, 'utf8')
    const rel = relative(base, abs)
    const path = rel.startsWith('..') || isAbsolute(rel) ? abs : rel.split(sep).join('/')
    return { artifact: { path, media_type: 'text/markdown', label }, absolutePath: abs }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
