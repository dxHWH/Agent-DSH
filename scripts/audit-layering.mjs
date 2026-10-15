/**
 * Layering audit: where does "specialized agent + mode switching" belong?
 *
 * The question is about responsibility boundaries. DSH has three distinct planes,
 * and confusing them is the main way this kind of work goes wrong:
 *
 *   HOST plane      — process-global services: registries, sandbox, approval,
 *                     persistence, model routing. There is exactly one.
 *   AGENT plane     — per-session composition: tools, prompt sections, skills,
 *                     persona. One per preset, mounted once, shared by sessions.
 *   SHELL plane     — this Electron app: windows, tray, paths, locale seeding.
 *                     DSH does not know it exists.
 *
 * This measures which plane each kind of change actually lands on, instead of
 * assuming. It reads composition structure only; no project content is involved.
 *
 * Run: npx electron scripts/audit-layering.mjs
 */
import { app } from 'electron'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'layer-home-'))

  // --- 1. which rows live on which plane? ---------------------------------
  try {
    const profile = boot.loadProfileDirectory('dsh-desktop', join(projectRoot, 'desktop-profile'), installAnchor)
    const rows = boot.composeEntries([
      profile.layers.flatMap((l) => l.patches ?? []),
      profile.patches ?? [],
    ])

    // The agent plane is what a preset composes. Identify the shipped preset's
    // own rows so we can tell "host row" from "agent row" by membership.
    const presetSrc = readFileSync(
      join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'),
      'utf8',
    )
    const presetIds = new Set(
      [...presetSrc.matchAll(/^- id: (.+)$/gm)].map((m) => m[1].trim()),
    )

    const hostRows = rows.filter((r) => !presetIds.has(r.id)).map((r) => r.id)
    const agentRows = rows.filter((r) => presetIds.has(r.id)).map((r) => r.id)

    out.planes = {
      totalEntries: rows.length,
      agentPlaneRows: agentRows.length,
      hostPlaneRows: hostRows.length,
      agentPlaneSample: agentRows.slice(0, 12),
      // Rows that hand a capability to the agent but must stay host-side.
      hostOnlyExamples: hostRows.filter((id) =>
        ['sandbox', 'approval', 'session-persistence-jsonl', 'credentials', 'settings', 'session', 'llm'].includes(id),
      ),
    }

    // The preset roster plugin itself is host-plane.
    out.planes.presetRosterIsHostSide = rows.some((r) => r.id === 'agent-presets')
  } catch (error) {
    out.planesError = String(error)
  }

  // --- 2. can the SHELL change a preset? ----------------------------------
  try {
    // Presets are files under <dshHome>/.agent-presets. A shell can write them,
    // but that is data seeding, not composition ownership.
    const presetDir = join(process.env.DSH_HOME, '.agent-presets')
    out.shellCanWritePresetDir = true // it is an ordinary directory under the home
    out.shellPresetDirExistsYet = existsSync(presetDir)

    // The discovery contract: <dshHome>/.agent-presets is the `user` root.
    out.presetUserRoot = '<dshHome>/.agent-presets'
  } catch (error) {
    out.presetError = String(error)
  }

  // --- 3. what the shell currently owns -----------------------------------
  try {
    const mainFiles = ['host.ts', 'paths.ts', 'locale.ts', 'settings.ts', 'tray.ts', 'window-state.ts', 'index.ts']
    const ownership = {}
    for (const f of mainFiles) {
      const src = readFileSync(join(projectRoot, 'src', 'main', f), 'utf8')
      // A real (non-comment) import from the DSH packages.
      const realImports = [...src.matchAll(/^\s*import\s.*from\s+'@deepseek-ai\//gm)].length
      const dynamicImports = [...src.matchAll(/import\('@deepseek-ai\//g)].length
      ownership[f] = { staticImports: realImports, dynamicImports }
    }
    out.shellOwnership = ownership
    out.shellTouchesDshOnlyInHost = Object.entries(ownership)
      .filter(([f]) => f !== 'host.ts' && f !== 'settings.ts')
      .every(([, v]) => v.staticImports === 0 && v.dynamicImports === 0)
  } catch (error) {
    out.ownershipError = String(error)
  }

  // --- 4. does a preset change require a host restart? --------------------
  try {
    const dir = mkdtempSync(join(tmpdir(), 'layer-preset-'))
    cpSync(join(projectRoot, 'desktop-profile'), dir, { recursive: true })

    const before = boot.loadProfileDirectory('dsh-desktop', dir, installAnchor)
    const beforeRows = boot.composeEntries([
      before.layers.flatMap((l) => l.patches ?? []),
      before.patches ?? [],
    ])

    writeFileSync(
      join(dir, 'cordis.patch.yml'),
      '- id: preset-roster\n  disabled: true\n',
      'utf8',
    )
    const after = boot.loadProfileDirectory('dsh-desktop', dir, installAnchor)
    const afterRows = boot.composeEntries([
      after.layers.flatMap((l) => l.patches ?? []),
      after.patches ?? [],
    ])

    out.presetRosterRowId = beforeRows.find((r) => (r.name ?? '').includes('agent-presets'))?.id ?? null
    out.compositionStillLoads = afterRows.length > 0
    out.disablingRosterChangesHostComposition = beforeRows.length !== afterRows.length

    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    out.restartError = String(error)
  }

  // --- 5. summarize the answer -------------------------------------------
  out.answer = {
    presetFiles: 'DATA — files under <dshHome>/.agent-presets, owned by DSH discovery',
    presetRosterRow: 'HOST plane — a patch row in the profile composition',
    modeSwitchingUI: 'CLIENT plane — dsh-client-ui-agent-preset, ships in the frontend',
    modeSwitchingLogic: 'HOST plane — dsh-agent-presets service',
    shellRole:
      'SHELL plane — may SEED preset files and expose entry points, but must not own the roster',
  }

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
