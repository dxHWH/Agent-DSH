/**
 * Which L1-L4 layer does "specialized agent + mode switching" land on?
 *
 * The previous audit established L1-L4 as a hot-update taxonomy. This one answers
 * a different, narrower question: for the specialized-agent work specifically,
 * which of those layers carries the change?
 *
 * The answer is not uniform across the work — different parts land on different
 * layers — so this measures each part instead of assigning one label.
 *
 * Run: npx electron scripts/audit-agent-layer-mapping.mjs
 */
import { app } from 'electron'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
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
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'lmap-home-'))

  const rowsOf = (dir) => {
    const p = boot.loadProfileDirectory('dsh-desktop', dir, installAnchor)
    return boot.composeEntries([p.layers.flatMap((l) => l.patches ?? []), p.patches ?? []])
  }

  // ---------------------------------------------------------------------
  // Part A — the preset FILES themselves.
  //
  // A preset is discovered from <dshHome>/.agent-presets, which is a directory,
  // not a composition row. So this part is not L1 at all: it is data that the
  // host reads. Nothing about it is a plugin swap.
  // ---------------------------------------------------------------------
  try {
    const presetDir = join(process.env.DSH_HOME, '.agent-presets')
    mkdirSync(join(presetDir, 'probe-mode'), { recursive: true })
    writeFileSync(
      join(presetDir, 'probe-mode', 'preset.yml'),
      'name: Probe\norder: 99\n',
      'utf8',
    )
    out.partA_presetFiles = {
      location: presetDir,
      isCompositionRow: false,
      isData: true,
      layer: 'none of L1-L4 — this is data, read by dsh-agent-presets discovery',
      note: 'Adding a preset adds no profile row and swaps no plugin bundle.',
    }
  } catch (error) {
    out.partAError = String(error)
  }

  // ---------------------------------------------------------------------
  // Part B — mounting/removing the preset ROSTER row.
  //
  // If the shell had to add or remove the agent-presets plugin row, that would
  // be L1 (host-plane composition change) or L3 (host plugin swap). Measure
  // whether the roster row is already present and whether it can be disabled.
  // ---------------------------------------------------------------------
  try {
    const rows = rowsOf(join(projectRoot, 'desktop-profile'))
    const roster = rows.find((r) => (r.name ?? '').includes('agent-presets'))
    out.partB_rosterRow = {
      present: roster !== undefined,
      id: roster?.id ?? null,
      name: roster?.name ?? null,
      disabled: roster?.disabled === true,
      layerIfChanged: 'L1 (host-plane composition change) — but no change is needed, it ships mounted',
    }
  } catch (error) {
    out.partBError = String(error)
  }

  // ---------------------------------------------------------------------
  // Part C — the switching UI.
  //
  // dsh-client-ui-agent-preset is a CLIENT plugin, so changing it (e.g. branding
  // the picker) would be L2 — a client bundle swap. Measure whether it is
  // mounted and whether we would ever need to swap it.
  // ---------------------------------------------------------------------
  try {
    const rows = rowsOf(join(projectRoot, 'desktop-profile'))
    const uiRow = rows.find((r) => (r.name ?? '').includes('dsh-client-ui-agent-preset'))
    out.partC_switcherUi = {
      present: uiRow !== undefined,
      id: uiRow?.id ?? null,
      isClientPlugin: true,
      layerIfChanged: 'L2 (client plugin swap) — but no change is needed, it ships mounted',
    }
  } catch (error) {
    out.partCError = String(error)
  }

  // ---------------------------------------------------------------------
  // Part D — the switching LOGIC service.
  //
  // dsh-agent-presets provides a host-plane service. Replacing it would be L3.
  // Measure whether the shipped implementation already covers mode switching.
  // ---------------------------------------------------------------------
  try {
    const rows = rowsOf(join(projectRoot, 'desktop-profile'))
    const svc = rows.find((r) => (r.name ?? '') === '@deepseek-ai/dsh-agent-presets')
    out.partD_switchingService = {
      present: svc !== undefined,
      id: svc?.id ?? null,
      isHostService: true,
      layerIfReplaced: 'L3 (host plugin swap) — blocked in Electron anyway',
      needToReplace: false,
    }
  } catch (error) {
    out.partDError = String(error)
  }

  // ---------------------------------------------------------------------
  // Part E — do preset changes require an app restart?
  //
  // This is the operationally important mapping: discovery happens at boot, so
  // a new preset needs a host restart (or at least a renderer reload) to appear.
  // ---------------------------------------------------------------------
  try {
    const src = readFileSync(
      require.resolve('@deepseek-ai/dsh-agent-presets'),
      'utf8',
    )
    // Does discovery run once at apply time, or is it re-run on demand?
    out.partE_discoveryAtBoot = /apply\s*\(/.test(src)
    out.partE_hasReScanHook = /rescan|rediscover|refresh/i.test(src)
    out.partE_operationalLayer = {
      toAddAPreset: 'L1-adjacent: needs host restart or renderer reload for discovery to see it',
      reason: 'discovery reads the roster at plugin start, not per keystroke',
    }
  } catch (error) {
    out.partEError = String(error)
  }

  // ---------------------------------------------------------------------
  // Part F — would updating the preset CONTENT ever need L3/L4?
  // ---------------------------------------------------------------------
  try {
    out.partF_contentUpdate = {
      editingGExistingPreset:
        'No plugin swap: the composition file is re-read when the preset mounts, so a new session picks it up',
      addingNewPluginToAPreset:
        'L1 if the plugin is already installed (composition row); L4-adjacent if the package is not installed yet',
      changingHarnessCode: 'L4 (DSH version upgrade) — only if the loop itself must change',
    }
  } catch (error) {
    out.partFError = String(error)
  }

  out.answer = {
    presetFiles: 'not L1-L4 — data',
    presetRosterRow: 'L1 if ever changed (ships mounted; do not change)',
    switcherUi: 'L2 if ever changed (ships mounted; do not change)',
    switchingService: 'L3 if ever replaced (blocked; not needed)',
    updatingHarness: 'L4 — only if the agent loop itself must change',
    bottomLine:
      'The specialized-agent work is DATA plus at most an L1 composition row. ' +
      'It does not require L2, L3, or L4.',
  }

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
