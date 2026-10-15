/**
 * Can a composition host multiple switchable "modes"?
 *
 * The question is narrower than general extensibility. What matters is whether:
 *   A. Two alternative profiles can coexist in one installation.
 *   B. A profile can genuinely change *behavior*, not just add tools —
 *      i.e. is the agent loop itself swappable per profile.
 *   C. The switch can be a single action rather than editing YAML by hand.
 *
 * This is deliberately about DSH's composition mechanics only. No project
 * contents are read.
 *
 * Run: npx electron scripts/audit-mode-switching.mjs
 */
import { app } from 'electron'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

/** Compose a profile directory into its effective entry list. */
function compose(boot, installAnchor, dir, label) {
  const profile = boot.loadProfileDirectory(label, dir, installAnchor)
  const rows = boot.composeEntries([
    profile.layers.flatMap((l) => l.patches ?? []),
    profile.patches ?? [],
  ])
  return { profile, rows }
}

async function main() {
  const out = {}
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const require = createRequire(import.meta.url)
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'mode-audit-home-'))

  // --- A. can two alternative profiles coexist? ----------------------------
  try {
    const sandbox = mkdtempSync(join(tmpdir(), 'mode-audit-'))

    // "General" — a copy of the shipped desktop profile.
    const generalDir = join(sandbox, 'general')
    cpSync(join(projectRoot, 'desktop-profile'), generalDir, { recursive: true })

    // "Specialized" — same base, plus a behavioural patch layer.
    const specialDir = join(sandbox, 'specialized')
    cpSync(join(projectRoot, 'desktop-profile'), specialDir, { recursive: true })
    writeFileSync(
      join(specialDir, 'cordis.patch.yml'),
      `# A specialization layer: same bundles, different behaviour.
- id: agent-loop
  config:
    maxParallelToolCalls: 2
- insert:
    - id: mode-marker
      name: '@deepseek-ai/dsh-cordis-host-runner'
      disabled: true
`,
      'utf8',
    )

    const g = compose(boot, installAnchor, generalDir, 'dsh-general')
    const s = compose(boot, installAnchor, specialDir, 'dsh-specialized')

    out.twoProfilesCoexist = true
    out.generalEntryCount = g.rows.length
    out.specializedEntryCount = s.rows.length

    const gLoop = g.rows.find((r) => r.id === 'agent-loop')
    const sLoop = s.rows.find((r) => r.id === 'agent-loop')
    out.generalLoopParallelism = gLoop?.config?.maxParallelToolCalls ?? 'default'
    out.specializedLoopParallelism = sLoop?.config?.maxParallelToolCalls ?? 'default'

    const gMarker = g.rows.find((r) => r.id === 'mode-marker')
    const sMarker = s.rows.find((r) => r.id === 'mode-marker')
    out.markerOnlyInSpecialized = sMarker !== undefined && gMarker === undefined

    out.profilesAreIndependent =
      out.generalLoopParallelism !== out.specializedLoopParallelism && out.markerOnlyInSpecialized

    rmSync(sandbox, { recursive: true, force: true })
  } catch (error) {
    out.stepAError = String(error)
  }

  // --- B. can a profile swap the agent loop itself? ------------------------
  try {
    const sandbox = mkdtempSync(join(tmpdir(), 'mode-loop-'))
    cpSync(join(projectRoot, 'desktop-profile'), sandbox, { recursive: true })
    writeFileSync(
      join(sandbox, 'cordis.patch.yml'),
      `- id: agent-loop
  disabled: true
- insert:
    - id: custom-agent-loop
      name: '@deepseek-ai/dsh-cordis-host-runner'
      disabled: true
`,
      'utf8',
    )

    const { rows } = compose(boot, installAnchor, sandbox, 'dsh-loop-swap')
    const native = rows.find((r) => r.id === 'agent-loop')
    const custom = rows.find((r) => r.id === 'custom-agent-loop')

    out.nativeLoopDisabled = native?.disabled === true
    out.customLoopPresent = custom !== undefined
    out.loopIsSwappablePerProfile = out.nativeLoopDisabled && out.customLoopPresent

    rmSync(sandbox, { recursive: true, force: true })
  } catch (error) {
    out.stepBError = String(error)
  }

  // --- C. what already supports "one-click" switching? --------------------
  try {
    // The DSH web UI already ships a selector for this exact purpose.
    const presetsPkg = require.resolve('@deepseek-ai/dsh-agent-presets/package.json')
    const presetsRoot = dirname(presetsPkg)
    const presetsDir = join(presetsRoot, 'presets')
    out.agentPresetsShipped = existsSync(presetsDir) ? readdirSync(presetsDir) : []
    out.agentPresetsSwitcherInUi = true

    // A user-level default makes the switch sticky across sessions.
    out.userDefaultKey = 'agent-presets.default (in settings.yaml)'
  } catch (error) {
    out.stepCError = String(error)
  }

  // --- D. which launcher flags select a profile? --------------------------
  try {
    const binSource = readFileSync(require.resolve('@deepseek-ai/dsh/bin.js'), 'utf8')
    out.launcherAcceptsProfileFlag = /--profile <name>/.test(binSource)
    out.launcherHasWebAlias = /command\("web"\)/.test(binSource)
    out.desktopNameReserved = /managed exclusively by the Electron application/.test(binSource)
  } catch (error) {
    out.stepDError = String(error)
  }

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
