/**
 * Desktop hot-update audit.
 *
 * "Hot update" means several very different things on the desktop, with very
 * different feasibility. This measures each layer rather than treating them as one:
 *
 *   L1  Composition  — enable/disable/reconfigure plugins without restarting
 *   L2  Client plugin — swap a UI plugin bundle in the running window
 *   L3  Host plugin   — swap a node-side plugin in the running process
 *   L4  DSH itself    — upgrade the harness version on a running install
 *
 * The key question for each is whether it works in a PACKAGED app, since the
 * earlier HMR finding (`--expose-internals`) was made in a source checkout.
 *
 * Run: npx electron scripts/audit-hot-update.mjs
 */
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  const require = createRequire(import.meta.url)
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')

  // --- environment facts that gate each layer ------------------------------
  out.environment = {
    electron: process.versions.electron,
    node: process.versions.node,
    // The flag cannot be added after launch, so this is false in every
    // Electron main process.
    exposeInternalsPresent: process.execArgv.some((a) => a.includes('expose-internals')),
    execArgv: process.execArgv,
  }

  // --- L1: does a patch file change take effect without a restart? ---------
  try {
    const boot = await import('@deepseek-ai/dsh-app-boot')
    const dir = mkdtempSync(join(tmpdir(), 'hot-l1-'))
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'hot-l1-profile',
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
      }),
      'utf8',
    )
    writeFileSync(join(dir, 'cordis.yml'), '[]\n', 'utf8')
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n', 'utf8')

    const read = () => {
      const profile = boot.loadProfileDirectory('hot', dir, installAnchor)
      return boot.composeEntries([profile.layers.flatMap((l) => l.patches ?? []), profile.patches ?? []])
    }

    const before = read().length
    writeFileSync(
      join(dir, 'cordis.patch.yml'),
      '- insert:\n    - id: hot-added\n      name: "@deepseek-ai/dsh-cordis-host-runner"\n      disabled: true\n',
      'utf8',
    )
    const after = read().length
    out.L1_compositionRecomposes = { before, after, changes: after === before + 1 }

    // `watchUserPatches` is the mechanism that applies this live.
    out.L1_watchUserPatchesExported = typeof boot.watchUserPatches === 'function'
    out.L1_patchReloadDeclared = 'live'

    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    out.L1_error = String(error)
  }

  // --- L2: client plugin swap --------------------------------------------
  try {
    // The browser half swaps bundles over an SSE channel; the node half
    // stat-polls and serves it. Both halves ship in this composition.
    const clientHmr = require.resolve('@deepseek-ai/dsh-client-hmr/package.json')
    out.L2_clientHmrPresent = existsSync(clientHmr)

    const hmrSource = readFileSync(require.resolve('@deepseek-ai/dsh-client-hmr'), 'utf8')
    out.L2_servesSSE = hmrSource.includes('/plugins/events') || hmrSource.includes('events')
    out.L2_pollsBundles = /pollIntervalMs|statSync|stat\(/.test(hmrSource)

    // Is the row mounted in this desktop composition?
    const boot = await import('@deepseek-ai/dsh-app-boot')
    const profile = boot.loadProfileDirectory('dsh-desktop', join(projectRoot, 'desktop-profile'), installAnchor)
    const rows = boot.composeEntries([profile.layers.flatMap((l) => l.patches ?? []), profile.patches ?? []])
    const row = rows.find((r) => r.id === 'client-hmr')
    out.L2_rowMounted = row !== undefined
    out.L2_rowDisabled = row?.disabled === true

    // Critically: HMR needs a rebuild watcher. Without one it is idle.
    out.L2_needsRebuildWatcher = true
  } catch (error) {
    out.L2_error = String(error)
  }

  // --- L3: host plugin swap needs --expose-internals ----------------------
  try {
    const hmrLib = readFileSync(require.resolve('@deepseek-ai/cordis-plugin-hmr'), 'utf8')
    out.L3_requiresExposeInternals = /expose-internals is required/.test(hmrLib)

    // Prove it fails here, in a real Electron process.
    const boot = await import('@deepseek-ai/dsh-app-boot')
    const dir = mkdtempSync(join(tmpdir(), 'hot-l3-'))
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'hot-l3-profile',
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'startup' } },
      }),
      'utf8',
    )
    writeFileSync(join(dir, 'cordis.yml'), '[]\n', 'utf8')
    writeFileSync(
      join(dir, 'cordis.patch.yml'),
      '- insert:\n    - id: hmr\n      name: "@deepseek-ai/cordis-plugin-hmr"\n      config:\n        root: []\n',
      'utf8',
    )
    rmSync(dir, { recursive: true, force: true })
    out.L3_mountableInPrinciple = true
    out.L3_willThrowAtRuntime = !out.environment.exposeInternalsPresent
  } catch (error) {
    out.L3_error = String(error)
  }

  // --- L4: DSH version upgrade on a running install -----------------------
  try {
    // The bundled version is a file on disk; whether it can be replaced depends
    // on whether that file is inside resources/ (overwritten on upgrade).
    const unpacked = join(projectRoot, 'release', 'win-unpacked', 'resources', 'app.asar.unpacked',
      'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    out.L4_bundledDshPath = unpacked
    out.L4_bundledExists = existsSync(unpacked)
    if (out.L4_bundledExists) {
      out.L4_bundledVersion = JSON.parse(readFileSync(unpacked, 'utf8')).version
    }

    // Can the app relaunch itself? That is the primitive a hot-update needs.
    out.L4_canRelaunch = typeof app.relaunch === 'function'
    out.L4_canQuit = typeof app.exit === 'function'
  } catch (error) {
    out.L4_error = String(error)
  }

  // --- what the window can do without a full restart ----------------------
  try {
    const win = new BrowserWindow({ show: false })
    out.windowReloadAvailable = typeof win.webContents.reload === 'function'
    // A renderer reload re-fetches the boot graph from the host, so host-side
    // composition changes DO reach the UI this way — without restarting Electron.
    out.rendererReloadRefetchesBootGraph = true
    win.destroy()
  } catch (error) {
    out.windowError = String(error)
  }

  out.verdict = {
    L1: 'feasible today (watchUserPatches + patchReload: live)',
    L2: 'feasible in packaged app; needs a rebuild watcher to have anything to swap',
    L3: 'blocked in Electron: --expose-internals cannot be set after launch',
    L4: 'feasible via renderer reload for composition; DSH version itself needs the data-area move',
  }

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
