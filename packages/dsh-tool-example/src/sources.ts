/**
 * Source enumeration: which project files the tool reads.
 *
 * One function decides the file set for the index builder, the fingerprint and
 * the direct-scan fallback, so the three can never disagree about scope.
 * Replace this module when adapting the skeleton to a real domain (e.g. read a
 * registry/manifest file instead of walking the tree).
 */
import { readdirSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'

export const DEFAULT_EXTENSIONS = [
  '.md', '.txt', '.json', '.yaml', '.yml', '.xml', '.csv', '.ini', '.toml',
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.cs', '.java', '.go', '.rs', '.lua', '.c', '.h', '.cpp', '.hpp',
]

/** Directories never descended into. */
const SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '.agent-index', 'dist', 'build', 'out', 'lib', 'bin', 'obj', '.vs', '.idea'])

export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const MAX_FILES = 50_000

export interface SourceFile {
  /** Project-relative POSIX path. */
  path: string
  abs: string
  size: number
  mtimeMs: number
}

export interface SourceOptions {
  extensions?: readonly string[]
}

/** Walk the project and return the in-scope files, sorted by path. */
export function listSources(projectRoot: string, options: SourceOptions = {}): SourceFile[] {
  const exts = new Set((options.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase()))
  const out: SourceFile[] = []
  const walk = (dir: string): void => {
    if (out.length >= MAX_FILES) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(abs)
      } else if (e.isFile() && exts.has(extname(e.name).toLowerCase())) {
        try {
          const st = statSync(abs)
          if (st.size > MAX_FILE_BYTES) continue
          out.push({ path: relative(projectRoot, abs).split(sep).join('/'), abs, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) })
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  }
  walk(projectRoot)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
