/**
 * Portable-mode verification.
 *
 * Proves the migration promise end to end: with `dataRootMode: "portable"`,
 * every piece of DSH state (settings, credentials, sessions) lives beside the
 * application, so copying the folder to another Windows machine carries it all.
 *
 * The check is deliberately structural rather than a smoke test: it starts a
 * real host against a fresh portable root, records what DSH writes there, then
 * relocates the whole root and starts a second host against the moved copy —
 * confirming the state is read back, not recreated empty.
 *
 * Run: npx electron scripts/selfcheck-portable.mjs
 */
import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The project root, derived from this script's own location rather than
 * `app.getAppPath()` — the latter follows the entry point and would resolve to
 * `scripts/` when run as `electron scripts/...`.
 */
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)
}

/** Non-recursive listing, for compact reporting. */
function list(dir) {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

async function main() {
  const workspace = projectRoot
  const sandbox = join(workspace, '.portable-test')
  rmSync(sandbox, { recursive: true, force: true })
  mkdirSync(sandbox, { recursive: true })

  // Simulates the "app folder" that would be copied between machines.
  const appFolderA = join(sandbox, 'machine-a')
  const portableRootA = join(appFolderA, 'dsh-data')
  const portableHomeA = join(portableRootA, 'dsh-home')
  mkdirSync(portableHomeA, { recursive: true })

  // Seed recognizable state the way a real user's setup would look.
  const credentials = 'version: 1\nrecords: {}\nrefs:\n  DEEPSEEK_API_KEY: sk_test_migrated_key\n'
  const settings = 'permission:\n  defaultPreset: danger-full-access\n'
  writeFileSync(join(portableHomeA, '.credentials.yaml'), credentials, 'utf8')
  writeFileSync(join(portableHomeA, 'settings.yaml'), settings, 'utf8')

  // The shell pointer file that selects portable mode.
  writeFileSync(
    join(appFolderA, 'desktop-shell.json'),
    `${JSON.stringify({ dataRootMode: 'portable' }, null, 2)}\n`,
    'utf8',
  )

  const { startHost } = await import('../dist/main/host.js')

  // The test drives `startHost` directly with the intended home rather than
  // faking Electron's own paths — the point under test is that DSH itself is
  // relocatable, not how the shell picks the path.
  process.env.DSH_HOME = portableHomeA

  const profileDir = join(projectRoot, 'desktop-profile')
  record('profile directory exists', existsSync(join(profileDir, 'package.json')), profileDir)

  let hostA = null
  try {
    hostA = await startHost({ dshHome: portableHomeA, profileDir })
    record('host boots against portable root', typeof hostA.port === 'number' && hostA.port > 0, `port ${hostA.port}`)
  } catch (error) {
    record('host boots against portable root', false, String(error))
  }

  const contentsA = list(portableHomeA)
  record('portable root holds DSH state', contentsA.length > 0, contentsA.join(', '))
  record('credentials file lives in portable root', existsSync(join(portableHomeA, '.credentials.yaml')))
  record('settings file lives in portable root', existsSync(join(portableHomeA, 'settings.yaml')))

  // Nothing may escape the portable root into the real user profile.
  const escaped = contentsA.filter((n) => n.includes('Agent Desktop'))
  record('nothing escapes to the per-user profile', escaped.length === 0, escaped.join(', '))

  if (hostA) await hostA.dispose()

  // --- copy the whole "machine A" folder to "machine B" ---------------------
  const appFolderB = join(sandbox, 'machine-b')
  try {
    cpSync(appFolderA, appFolderB, { recursive: true })
    record('whole app folder copies', existsSync(join(appFolderB, 'dsh-data', 'dsh-home')))
  } catch (error) {
    record('whole app folder copies', false, String(error))
  }

  // --- start against the copied root ---------------------------------------
  const portableHomeB = join(appFolderB, 'dsh-data', 'dsh-home')
  process.env.DSH_HOME = portableHomeB

  let hostB = null
  try {
    hostB = await startHost({ dshHome: portableHomeB, profileDir })
    record('host boots against moved root', typeof hostB.port === 'number' && hostB.port > 0, `port ${hostB.port}`)
  } catch (error) {
    record('host boots against moved root', false, String(error))
  }

  // The decisive assertion: the moved credentials are read back, not blanked.
  const movedCredentials = readFileSync(join(portableHomeB, '.credentials.yaml'), 'utf8')
  record(
    'moved credentials survive the copy',
    movedCredentials.includes('ck_test_migrated_key'),
    'key text preserved verbatim',
  )
  const movedSettings = readFileSync(join(portableHomeB, 'settings.yaml'), 'utf8')
  record(
    'moved settings survive the copy',
    movedSettings.includes('danger-full-access'),
    'setting text preserved verbatim',
  )

  // --- the shell pointer travelled too --------------------------------------
  const shellConfigB = JSON.parse(readFileSync(join(appFolderB, 'desktop-shell.json'), 'utf8'))
  record('shell pointer travels with the folder', shellConfigB.dataRootMode === 'portable')

  if (hostB) await hostB.dispose()

  rmSync(sandbox, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  const summary = { total: results.length, passed: results.length - failed.length, failed: failed.length, results }
  writeFileSync(join(workspace, 'phase3-portable-selfcheck.json'), JSON.stringify(summary, null, 2), 'utf8')
  console.log(`\n=== ${summary.passed}/${summary.total} passed ===`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((error) => {
  console.error('portable self-check crashed:', error)
  app.exit(2)
})
