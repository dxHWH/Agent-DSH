/**
 * Explain why packages are missing from the archive: peer-only dependencies.
 *
 * electron-builder walks `dependencies`, and npm does not hoist a peer-only
 * package into the tree it follows. DSH declares many runtime-required packages
 * as peers (cordis and its plugins, plus the seam packages), so they exist on
 * disk under node_modules yet never reach the archive. The host then fails at
 * boot with "Cannot find package ...".
 *
 * This checks, for each missing package, whether it is reachable as a peer of
 * something that IS packaged — which is the signature of the bug.
 *
 * Usage: node scripts/diagnostics/diagnose-missing-packages.mjs <path-to-app.asar>
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

const archive = process.argv[2]
if (!archive || !existsSync(archive)) {
  console.error('usage: node scripts/diagnostics/diagnose-missing-packages.mjs <app.asar>')
  process.exit(1)
}

const entries = asar.listPackage(archive).map((p) => p.replace(/\\/g, '/'))
const inArchive = new Set()
for (const entry of entries) {
  const m = /\/node_modules\/@deepseek-ai\/([^/]+)(?:\/|$)/.exec(`/${entry}`)
  if (m) inArchive.add(m[1])
}

const scopeDir = 'node_modules/@deepseek-ai'
const onDisk = readdirSync(scopeDir)
const missing = onDisk.filter((p) => !inArchive.has(p)).sort()

/** Read a package's manifest, tolerating absence. */
function manifest(name) {
  const p = join(scopeDir, name, 'package.json')
  if (!existsSync(p)) return undefined
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return undefined
  }
}

/** Does anything packaged declare `name` at all (any dependency field)? */
function declaredBy(name) {
  const declarers = []
  for (const pkg of onDisk) {
    const m = manifest(pkg)
    if (!m) continue
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      const spec = m[field]?.[`@deepseek-ai/${name}`]
      if (spec) declarers.push(`${pkg} (${field})`)
    }
  }
  return declarers
}

console.log(`missing from archive: ${missing.length}\n`)

let peerOnly = 0
for (const name of missing) {
  const m = manifest(name)
  const declarers = declaredBy(name)
  const onlyPeers = declarers.length > 0 && declarers.every((d) => d.includes('(peerDependencies)'))
  const packagedDeclarer = declarers.some((d) => inArchive.has(d.split(' ')[0]))
  const flag = onlyPeers && packagedDeclarer ? 'PEER-ONLY' : 'other'
  if (flag === 'PEER-ONLY') peerOnly++
  console.log(`${flag.padEnd(10)} ${name}`)
  console.log(`           version ${m?.version ?? '?'}, declared by: ${declarers.join(', ') || '(nothing)'}`)
}

console.log(`\npeer-only missing: ${peerOnly}/${missing.length}`)
