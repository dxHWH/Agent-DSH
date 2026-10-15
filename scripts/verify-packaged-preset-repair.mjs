/**
 * Confirm the dangling-preset repair actually shipped inside the packaged asar.
 *
 * The build output is the only artifact a user installs, so "it works in dev" is
 * not evidence. This reads the three modules the fix touches straight out of the
 * archive.
 *
 * Usage: node scripts/verify-packaged-preset-repair.mjs [asarPath]
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

const archive = process.argv[2] ?? 'release-check/win-unpacked/resources/app.asar'

if (!existsSync(archive)) {
  console.error(`no archive at ${archive}`)
  process.exit(1)
}

const read = (p) => asar.extractFile(archive, p).toString('utf8')

/** The archive stores paths with the platform separator; try both spellings. */
function readModule(rel) {
  for (const candidate of [rel, rel.split('/').join('\\'), rel.split('\\').join('/')]) {
    try {
      return read(candidate)
    } catch {
      // try the next spelling
    }
  }
  throw new Error(`not found in archive: ${rel}`)
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` [${detail}]` : ''}`)
}

const index = readModule('dist/main/index.js')
const presets = readModule('dist/main/presets.js')
const host = readModule('dist/main/host.js')

check('dist/main/presets.js is packaged', presets.includes('repairDefaultPreset'), `${presets.length} bytes`)
check('index.js calls repairDefaultPreset', index.includes('repairDefaultPreset'))
check('index.js reads host.availablePresets', index.includes('availablePresets'))
check('index.js logs the outcome', index.includes('preset default'))
check('host.js exposes availablePresets', host.includes('availablePresets'))
check('host.js resolves the agentPresets service', host.includes('agentPresets'))
check('presets.js guards against an empty list', presets.includes('available.length') || presets.includes('available.includes'))
check('presets.js never writes a BOM', !presets.includes('\\uFEFF'))

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) process.exit(1)
