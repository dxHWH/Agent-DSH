/**
 * Default-preset repair self-check.
 *
 * The behavior worth protecting is the boundary around the repair, not the
 * rewrite itself:
 *
 *   1. A default naming a preset this build does NOT ship is reset — that is the
 *      bug, and it makes every session creation fail.
 *   2. A default naming a preset that DOES resolve is never touched, even when it
 *      is not the one we would have picked.
 *   3. Every other byte of settings.yaml survives — sections, comments, order.
 *   4. No preset list, no edit: an unreadable preset set must never be treated
 *      as "nothing is available", which would rewrite a good default.
 *
 * Run: node scripts/selfcheck-presets.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` [${detail}]` : ''}`)
}

function freshHome(settingsText) {
  const dir = mkdtempSync(join(tmpdir(), 'preset-check-'))
  if (settingsText !== undefined) writeFileSync(join(dir, 'settings.yaml'), settingsText, 'utf8')
  return dir
}

/** The preset set a real 0.1.5-rc.2 build ships. */
const SHIPPED = ['standard', 'ptc', 'minimal', 'cordis', 'project']
/** With the project preset present (this is the desktop's actual set). */
const WITH_PROJECT = ['standard', 'ptc', 'minimal', 'cordis', 'project']

async function main() {
  const { repairDefaultPreset, readConfiguredPreset, rewriteConfiguredPreset } = await import(
    '../dist/main/presets.js'
  )

  // --- 1. a dangling default is repaired ----------------------------------
  const homeA = freshHome('ui-onboarding:\n  welcomeNoticeVersion: x\nagent-presets:\n  default: code\nlocale:\n  preference: zh\n')
  const a = repairDefaultPreset(homeA, SHIPPED)
  record('dangling default is repaired', a.action === 'repaired', `${a.action}: ${a.preset}`)
  record('repair targets a shipped preset', SHIPPED.includes(a.preset), a.preset)

  const textA = readFileSync(join(homeA, 'settings.yaml'), 'utf8')
  record('bad id is gone', !/default:\s*code/.test(textA))
  record('replacement is written', /default:\s*standard/.test(textA))
  record('other sections survive', /welcomeNoticeVersion: x/.test(textA))
  record('locale section survives', /preference:\s*zh/.test(textA))
  record('no BOM introduced', !textA.startsWith('\uFEFF'))

  // --- 2. a valid default is never touched --------------------------------
  const homeB = freshHome('agent-presets:\n  default: minimal\n')
  const before = readFileSync(join(homeB, 'settings.yaml'), 'utf8')
  const b = repairDefaultPreset(homeB, SHIPPED)
  record('valid default is left alone', b.action === 'unchanged' && b.preset === 'minimal', b.action)
  record('valid default bytes unchanged', readFileSync(join(homeB, 'settings.yaml'), 'utf8') === before)

  // A valid-but-unusual choice must also stand: we do not "upgrade" the user.
  const homeC = freshHome('agent-presets:\n  default: cordis\n')
  const c = repairDefaultPreset(homeC, SHIPPED)
  record('unusual valid default stands', c.action === 'unchanged' && c.preset === 'cordis', c.action)

  // --- 3. no preset list means no edit ------------------------------------
  const homeD = freshHome('agent-presets:\n  default: code\n')
  const beforeD = readFileSync(join(homeD, 'settings.yaml'), 'utf8')
  const d = repairDefaultPreset(homeD, [])
  record('empty preset list never rewrites', d.action === 'unchanged', d.action)
  record('empty preset list leaves bytes alone', readFileSync(join(homeD, 'settings.yaml'), 'utf8') === beforeD)

  // --- 4. absence of a default is not a repair ----------------------------
  const homeE = freshHome('locale:\n  preference: zh\n')
  const e = repairDefaultPreset(homeE, SHIPPED)
  record('missing default is not a repair', e.action === 'unchanged', e.action)

  const homeF = freshHome(undefined)
  const f = repairDefaultPreset(homeF, SHIPPED)
  record('missing settings.yaml is handled', f.action === 'settings-missing', f.action)

  // --- 5. project is a legitimate default -------------------------------------
  const homeG = freshHome('agent-presets:\n  default: code\n')
  const g = repairDefaultPreset(homeG, WITH_PROJECT, 'project')
  record('requested fallback is honored', g.action === 'repaired' && g.preset === 'project', g.preset ?? g.action)

  // A fallback that is itself dangling must not be written.
  const homeH = freshHome('agent-presets:\n  default: code\n')
  const h = repairDefaultPreset(homeH, SHIPPED, 'nope')
  record('dangling fallback is not written', h.action === 'repaired' && SHIPPED.includes(h.preset), h.preset ?? h.action)

  // --- 6. indentation and ordering are preserved --------------------------
  const homeI = freshHome('a:\n  b: 1\nagent-presets:\n    default: code\nz:\n  y: 2\n')
  repairDefaultPreset(homeI, SHIPPED)
  const textI = readFileSync(join(homeI, 'settings.yaml'), 'utf8')
  record('4-space indent preserved', /^ {4}default: standard$/m.test(textI))
  record('key order preserved', textI.indexOf('a:') < textI.indexOf('agent-presets:') && textI.indexOf('agent-presets:') < textI.indexOf('z:'))

  // --- 7. pure helpers ------------------------------------------------
  record('readConfiguredPreset finds nested default', readConfiguredPreset('agent-presets:\n  default: ptc\n') === 'ptc')
  record('readConfiguredPreset ignores other blocks', readConfiguredPreset('other:\n  default: nope\n') === undefined)
  record('readConfiguredPreset strips quotes', readConfiguredPreset('agent-presets:\n  default: "ptc"\n') === 'ptc')
  record('rewriteConfiguredPreset is precise', rewriteConfiguredPreset('agent-presets:\n  default: code\n', 'ptc') === 'agent-presets:\n  default: ptc\n')

  rmSync(homeA, { recursive: true, force: true })
  rmSync(homeB, { recursive: true, force: true })
  rmSync(homeC, { recursive: true, force: true })
  rmSync(homeD, { recursive: true, force: true })
  rmSync(homeE, { recursive: true, force: true })
  rmSync(homeF, { recursive: true, force: true })
  rmSync(homeG, { recursive: true, force: true })
  rmSync(homeH, { recursive: true, force: true })
  rmSync(homeI, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exit(1)
}

main().catch((error) => {
  console.error('selfcheck failed:', error)
  process.exit(1)
})
