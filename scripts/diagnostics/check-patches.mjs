// Verifies which composed rows our desktop patch actually reaches, and what
// `openBrowser` resolves to after composition.
// Run: node scripts/diagnostics/check-patches.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const boot = await import('@deepseek-ai/dsh-app-boot')

const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-patch-check-'))
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-patch-home-'))

const bundles = boot.PROFILE_TEMPLATES.web.bundles
boot.initProfile(profileDir, bundles, 'live')
const profile = boot.loadProfileDirectory('dsh-desktop', profileDir, installAnchor)
const bundlePatches = profile.layers.flatMap((l) => l.patches ?? [])

const desktopPatches = [
  { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
  { id: 'web-runtime', config: { printUrl: false, openBrowser: false } },
]

const composed = boot.composeEntries([
  bundlePatches,
  profile.patches ?? [],
  desktopPatches,
])

const interesting = ['web-startup', 'webserver', 'web-runtime']
console.log('=== composed rows of interest ===')
for (const row of composed) {
  if (interesting.includes(row.id)) {
    console.log(JSON.stringify(row, null, 2))
  }
}

// Does any row still carry a `!!js` webStartup reference?
const webRuntime = composed.find((r) => r.id === 'web-runtime')
console.log('\n=== web-runtime config keys ===')
console.log(JSON.stringify(webRuntime?.config ?? null))

// Find every row whose id matches our patch targets, to prove patch reach.
console.log('\n=== patch reach ===')
for (const target of ['webserver', 'web-runtime', 'web-startup']) {
  const matches = composed.filter((r) => r.id === target)
  console.log(`${target}: ${matches.length} matching row(s)`)
}
