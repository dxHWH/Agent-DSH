/**
 * Find every bare import that the profile's copied `@deepseek-ai` tree cannot
 * resolve from its own location.
 *
 * Why this is needed: the packaged profile ships `node_modules/@deepseek-ai`
 * (the client-plugin resolution fix), but those packages import ordinary npm
 * dependencies too — `zod`, `js-yaml`, `chokidar`, … Node resolves a bare
 * specifier by walking UP from the importing file, so it looks in
 * `desktop-profile/node_modules` and finds only `@deepseek-ai`. Every other
 * dependency is unreachable, and the failure surfaces one import at a time.
 *
 * This walks the real `import`/`require`/`export … from` specifiers in the
 * profile's packages and reports which ones have no resolution target.
 *
 * Usage: node scripts/audit-profile-dependencies.mjs <profileDir> <sourceNodeModules>
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { builtinModules } from 'node:module'

/** Node builtins resolve without a node_modules entry, so they are not misses. */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

const profileDir = process.argv[2]
const sourceModules = process.argv[3] ?? 'node_modules'

if (!profileDir || !existsSync(profileDir)) {
  console.error('usage: node scripts/audit-profile-dependencies.mjs <profileDir> [sourceNodeModules]')
  process.exit(1)
}

/** Recursively collect .js files under a directory, capped for safety. */
function walk(dir, out = [], limit = 4000) {
  if (out.length >= limit) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (out.length >= limit) break
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, out, limit)
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full)
  }
  return out
}

/** Bare specifiers only: skip relative paths, URLs and node: builtins. */
function bareSpecifiers(text) {
  const found = new Set()
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
  ]
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const spec = m[1]
      if (!spec) continue
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
      if (/^[a-z]+:/i.test(spec) && !spec.startsWith('file:')) continue
      found.add(spec)
    }
  }
  return found
}

/**
 * A real npm package name, as opposed to a template-literal fragment.
 *
 * Minified client bundles contain strings like `import("${spec}")` inside
 * generated code, which the specifier regexes happily pick up as `"${spec}"`.
 * Those are not dependencies — no package can be named that — so they are
 * filtered rather than reported, otherwise the audit cries wolf and a real
 * missing package could hide among the noise.
 */
function isRealPackageName(spec) {
  if (spec.includes('$') || spec.includes('{') || spec.includes('}')) return false
  if (spec.includes('\\') || spec.includes(' ')) return false
  // npm names are lowercase; a leading uppercase segment is not a package.
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(spec)
}

/** Package name from a specifier: `@scope/name/sub` -> `@scope/name`. */
function packageOf(spec) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const profileModules = join(profileDir, 'node_modules')
const scopeDir = join(profileModules, '@deepseek-ai')

if (!existsSync(scopeDir)) {
  console.error(`no @deepseek-ai under ${profileModules}`)
  process.exit(1)
}

/** Packages present in the profile's own node_modules. */
function presentInProfile(name) {
  return existsSync(join(profileModules, name))
}

const packages = readdirSync(scopeDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)

const unresolved = new Map()

for (const pkg of packages) {
  const pkgDir = join(scopeDir, pkg)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  } catch {
    continue
  }
  // Only the entry points DSH actually loads matter here.
  const files = walk(join(pkgDir, 'lib'))
  for (const file of files) {
    /*
     * Skip the browser-side halves.
     *
     * `lib/client.js` is shipped to the renderer by `client-modules` and runs in
     * the browser, where React and friends come from the frontend bundle. It is
     * never executed by the host Node process, so its imports are not this
     * process's dependencies. Reporting them would flag `react`/`react-dom` as
     * missing forever and bury the real findings.
     */
    const base = file.slice(pkgDir.length + 1)
    if (/(^|[\\/])client\.js$/.test(base)) continue
    // Types-only trees are never imported at runtime.
    if (/[\\/]types[\\/]/.test(base)) continue

    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const spec of bareSpecifiers(text)) {
      if (!isRealPackageName(spec)) continue
      const name = packageOf(spec)
      if (name.startsWith('@deepseek-ai/')) continue
      // Node's own builtins are resolvable without a node_modules entry.
      if (BUILTINS.has(name)) continue
      if (presentInProfile(name)) continue
      if (!unresolved.has(name)) unresolved.set(name, new Set())
      unresolved.get(name).add(`${pkg}/${base}`)
    }
  }
}

const names = [...unresolved.keys()].sort()
console.log(`profile packages scanned : ${packages.length}`)
console.log(`unresolvable dependencies: ${names.length}\n`)

for (const name of names) {
  const users = [...unresolved.get(name)]
  const available = existsSync(join(sourceModules, name))
  console.log(`${name}${available ? '' : '  [NOT ON DISK EITHER]'}`)
  console.log(`  imported by ${users.length} file(s), e.g. ${users.slice(0, 3).join(', ')}`)
}

if (names.length > 0) {
  const missingOnDisk = names.filter((n) => !existsSync(join(sourceModules, n)))
  console.log(`\nsafe to copy from source : ${names.length - missingOnDisk.length}`)
  if (missingOnDisk.length > 0) console.log(`missing everywhere       : ${missingOnDisk.join(', ')}`)
}

process.exit(names.length > 0 ? 1 : 0)
