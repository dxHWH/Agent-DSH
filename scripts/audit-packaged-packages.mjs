/**
 * List which `@deepseek-ai` packages are missing from a packaged app.asar.
 *
 * The packaged host imports DSH's own packages at runtime, so a package present
 * on disk but absent from the archive is a boot failure waiting to happen —
 * exactly the `cordis-plugin-group` symptom.
 *
 * Usage: node scripts/audit-packaged-packages.mjs <path-to-app.asar>
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

const archive = process.argv[2]
if (!archive || !existsSync(archive)) {
  console.error(`usage: node scripts/audit-packaged-packages.mjs <app.asar>  (got: ${archive})`)
  process.exit(1)
}

/** Archive paths use the platform separator, so normalize before matching. */
const entries = asar.listPackage(archive).map((p) => p.replace(/\\/g, '/'))

const inArchive = new Set()
for (const entry of entries) {
  const m = /\/node_modules\/@deepseek-ai\/([^/]+)(?:\/|$)/.exec(`/${entry}`)
  if (m) inArchive.add(m[1])
}

const onDisk = readdirSync('node_modules/@deepseek-ai')
const missing = onDisk.filter((p) => !inArchive.has(p)).sort()
const extra = [...inArchive].filter((p) => !onDisk.includes(p)).sort()

console.log(`packages on disk        : ${onDisk.length}`)
console.log(`@deepseek-ai in archive : ${inArchive.size}`)
console.log(`missing from archive    : ${missing.length}`)
if (extra.length > 0) console.log(`in archive but not disk : ${extra.join(', ')}`)

if (missing.length > 0) {
  console.log('\nmissing:')
  for (const m of missing) console.log(`  ${m}`)
}

// The runtime actually resolves the DSH bundle, so spot-check the packages the
// boot path imports directly rather than trusting the aggregate count.
const critical = ['dsh-app-boot', 'dsh-cmdline', 'cordis', 'cordis-plugin-group', 'cordis-plugin-loader']
console.log('\ncritical packages:')
let bad = 0
for (const c of critical) {
  const ok = inArchive.has(c)
  if (!ok) bad++
  console.log(`  ${ok ? 'OK  ' : 'MISS'} ${c}`)
}

process.exit(missing.length > 0 || bad > 0 ? 1 : 0)
