/**
 * Safe project-relative path resolution.
 *
 * Every path a model hands to a tool is untrusted. This resolver rejects
 * absolute paths, `..` traversal, and anything that escapes the project root or
 * the caller's declared `allowedRoots` after resolution (including through
 * symlinks/junctions, via `realpath`). Evidence locators are produced as
 * project-relative POSIX paths so results never leak machine paths.
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathEscapeError'
  }
}

export interface ResolvedPath {
  absolute: string
  /** Project-relative POSIX path, safe to show as evidence. */
  locator: string
}

export class ScopedPathResolver {
  readonly projectRoot: string

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot)
  }

  resolve(relativePath: string, allowedRoots: string[] = ['.'], mustExist = false): ResolvedPath {
    if (!relativePath || !relativePath.trim()) throw new PathEscapeError('path is empty')
    if (allowedRoots.length === 0) throw new PathEscapeError('allowedRoots is empty; declare at least one root')
    if (isAbsolute(relativePath)) throw new PathEscapeError(`absolute paths are not allowed: ${relativePath}`)
    if (normalize(relativePath).split(sep).includes('..')) throw new PathEscapeError(`'..' is not allowed: ${relativePath}`)

    const roots = allowedRoots.map((r) => {
      if (isAbsolute(r) || normalize(r).split(sep).includes('..')) throw new PathEscapeError(`invalid allowed root: ${r}`)
      return resolve(this.projectRoot, r)
    })

    let candidate = resolve(this.projectRoot, relativePath)
    // Follow links so a junction pointing outside the project cannot slip through.
    if (existsSync(candidate)) candidate = realpathSync(candidate)
    const realRoot = existsSync(this.projectRoot) ? realpathSync(this.projectRoot) : this.projectRoot

    if (!within(candidate, realRoot)) throw new PathEscapeError(`path escapes the project: ${relativePath}`)
    const realRoots = roots.map((r) => (existsSync(r) ? realpathSync(r) : r))
    if (!realRoots.some((r) => within(candidate, r))) throw new PathEscapeError(`path is outside the allowed roots: ${relativePath}`)
    if (mustExist && !existsSync(candidate)) throw new PathEscapeError(`path does not exist: ${relativePath}`)
    if (mustExist && !statSync(candidate).isFile() && !statSync(candidate).isDirectory()) {
      throw new PathEscapeError(`not a file or directory: ${relativePath}`)
    }
    return { absolute: candidate, locator: relative(realRoot, candidate).split(sep).join('/') }
  }

  /** Project-relative POSIX locator for an absolute path inside the project. */
  locatorFor(absolutePath: string): string {
    const rel = relative(this.projectRoot, resolve(absolutePath))
    if (rel.startsWith('..') || isAbsolute(rel)) throw new PathEscapeError(`not inside the project: ${absolutePath}`)
    return rel.split(sep).join('/')
  }
}

function within(candidate: string, root: string): boolean {
  const a = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  const b = process.platform === 'win32' ? root.toLowerCase() : root
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}
