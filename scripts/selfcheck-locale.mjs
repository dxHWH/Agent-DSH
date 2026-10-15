/**
 * Locale seeding self-check.
 *
 * The behavior worth protecting is not "Chinese gets written" — it is the
 * boundary around it:
 *
 *   1. A fresh home is seeded with `zh`.
 *   2. An existing settings file is NEVER overwritten, including one that
 *      selects `en`. Re-flipping a user's deliberate choice to Chinese on every
 *      launch would be a bug, not a feature.
 *   3. Other settings sections survive seeding untouched.
 *
 * Run: npx electron scripts/selfcheck-locale.mjs
 */
import { app } from 'electron'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` [${detail}]` : ''}`)
}

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'locale-check-'))
}

async function main() {
  const { seedFirstRunLocale } = await import('../dist/main/locale.js')

  // --- 1. a fresh home is seeded -------------------------------------------
  const homeA = freshHome()
  const a = seedFirstRunLocale(homeA)
  record('fresh home is seeded', a.action === 'seeded' && a.locale === 'zh', a.action)

  const settingsA = join(homeA, 'settings.yaml')
  record('settings.yaml created', existsSync(settingsA))
  const textA = readFileSync(settingsA, 'utf8')
  record('written content selects zh', /locale:\s*\n\s+preference:\s*zh/.test(textA), 'locale.preference: zh')

  // --- 2. an existing choice is never overwritten --------------------------
  const homeB = freshHome()
  const englishSettings = 'agent-presets:\n  default: code\nlocale:\n  preference: en\n'
  writeFileSync(join(homeB, 'settings.yaml'), englishSettings, 'utf8')
  const b = seedFirstRunLocale(homeB)
  record('existing en is respected', b.action === 'already-configured', b.action)
  record('existing en reports its value', b.locale === 'en', String(b.locale))
  const textB = readFileSync(join(homeB, 'settings.yaml'), 'utf8')
  record('existing file is byte-identical', textB === englishSettings, 'not rewritten')

  // --- 3. a settings file without a locale gets the section appended ---------
  // DSH writes its own sections (the onboarding notice) on the very first
  // launch, so a file existing without `locale` is the *normal* fresh-install
  // state — it must still be seeded, and the existing section must survive.
  const homeC = freshHome()
  const noLocale = 'ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\n'
  writeFileSync(join(homeC, 'settings.yaml'), noLocale, 'utf8')
  const c = seedFirstRunLocale(homeC)
  record('no-locale file is seeded', c.action === 'seeded' && c.locale === 'zh', c.action)
  const textC = readFileSync(join(homeC, 'settings.yaml'), 'utf8')
  record('existing section survives appending', textC.includes('ui-onboarding'), 'ui-onboarding kept')
  record('appended content selects zh', /locale:\s*\n\s+preference:\s*zh/.test(textC), 'locale.preference: zh')

  // --- 4. unrelated settings survive later launches -------------------------
  // Simulates the real ordering: the seeder runs, then DSH appends its own
  // sections, then a later launch runs the seeder again. Nothing may be lost.
  const homeD = freshHome()
  seedFirstRunLocale(homeD)
  const seeded = readFileSync(join(homeD, 'settings.yaml'), 'utf8')
  writeFileSync(
    join(homeD, 'settings.yaml'),
    `${seeded}agent-default-model:\n  provider: my-gateway\n  model: example-large\n`,
    'utf8',
  )
  const second = seedFirstRunLocale(homeD)
  const final = readFileSync(join(homeD, 'settings.yaml'), 'utf8')
  record('second launch does not re-seed', second.action === 'already-configured', second.action)
  record('other sections survive', final.includes('agent-default-model') && final.includes('my-gateway'))
  record('locale survives a second launch', /locale:\s*\n\s+preference:\s*zh/.test(final), 'still zh')

  // --- 5. the seeder reports a missing home rather than throwing -------------
  const missing = join(tmpdir(), 'definitely-not-here-' + Date.now())
  const e = seedFirstRunLocale(missing)
  record('missing home is reported', e.action === 'settings-missing-dir', e.action)
  record('missing home writes nothing', !existsSync(join(missing, 'settings.yaml')))

  // --- 6. the seeded value is one DSH actually accepts ----------------------
  // DSH's schema is `["zh", "en"]`; a typo here would fail silently in the UI.
  const accepted = ['zh', 'en']
  record('seeded value is a DSH-shipped locale', accepted.includes(a.locale ?? ''), String(a.locale))

  for (const dir of [homeA, homeB, homeC, homeD]) rmSync(dir, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  writeFileSync(
    join(app.getAppPath(), '..', 'locale-selfcheck.json'),
    JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results }, null, 2),
    'utf8',
  )
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((error) => {
  console.error('locale self-check crashed:', error)
  app.exit(2)
})
