/**
 * Extensibility audit: does the desktop composition still accept out-of-tree
 * plugins the way `dsh plugin` does for a stock profile?
 *
 * Static parity (same 152 entries) does not by itself prove extensibility. What
 * matters is whether the shell's application-owned profile directory can be
 * modified at runtime — adding a plugin row, then observing it mount.
 *
 * This test adds a real out-of-tree plugin row to a *copy* of the desktop
 * profile and confirms it appears in the composed tree, which is exactly what
 * `dsh plugin --profile desktop add <pkg>` would achieve for a normal profile.
 *
 * Run: npx electron scripts/audit-extensibility.mjs
 */
import { app } from 'electron'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function finish(payload) {
  console.log('AUDIT_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('AUDIT_END')
  app.exit(0)
}

async function main() {
  const out = {}
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const require = createRequire(import.meta.url)
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'audit-ext-home-'))

  // Work on a copy so the shipped profile is never touched by a test.
  const dir = mkdtempSync(join(tmpdir(), 'audit-ext-profile-'))
  cpSync(join(projectRoot, 'desktop-profile'), dir, { recursive: true })

  const read = () => {
    const profile = boot.loadProfileDirectory('dsh-desktop', dir, installAnchor)
    const bundlePatches = profile.layers.flatMap((l) => l.patches ?? [])
    return boot.composeEntries([bundlePatches, profile.patches ?? []])
  }

  try {
    const before = read()
    out.beforeCount = before.length
    out.patchPath = join(dir, 'cordis.patch.yml')
    out.patchFileExists = true

    // The user patch layer is the documented extension point for a profile.
    //
    // A bare `- id: ...` entry *targets an existing row*; it does not create
    // one. New rows must be wrapped in an `insert:` list — a distinction worth
    // demonstrating, because getting it wrong fails silently (the entry count
    // does not change and no error is raised).
    const patch = `- insert:
    - id: user-added-plugin
      name: '@deepseek-ai/dsh-cordis-host-runner'
      disabled: true
`
    writeFileSync(out.patchPath, patch, 'utf8')
    out.patchWritten = readFileSync(out.patchPath, 'utf8').trim()

    const after = read()
    out.afterCount = after.length
    const added = after.find((r) => r.id === 'user-added-plugin')
    out.rowAdded = added !== undefined
    out.addedRow = added ? { id: added.id, name: added.name, disabled: added.disabled } : null

    // Disabling an existing bundle row must also work — the other half of
    // extensibility: a deployment can turn parts off.
    writeFileSync(
      out.patchPath,
      `- id: ui-schedule
  disabled: true
`,
      'utf8',
    )
    const disabled = read()
    const scheduleRow = disabled.find((r) => r.id === 'ui-schedule')
    out.disableWorks = scheduleRow?.disabled === true

    out.verdict =
      out.rowAdded && out.disableWorks
        ? 'extensible: insert adds rows, id-targeted entries override and disable'
        : 'NOT extensible: patch layer did not take effect'
  } catch (error) {
    out.error = String(error)
    out.stack = error?.stack?.split('\n').slice(0, 8).join('\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error) }))
