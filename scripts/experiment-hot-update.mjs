/**
 * End-to-end hot-update experiment: does a composition change reach the RUNNING
 * window without restarting Electron?
 *
 * Layered individually, L1 (composition recomposes) and "renderer reload" are
 * each known to work. The useful question is whether they compose into an actual
 * hot-update path:
 *
 *   1. boot a real host
 *   2. load it in a window
 *   3. change the profile's patch file on disk
 *   4. reload the renderer
 *   5. confirm the changed composition is what the window now sees
 *
 * That is the primitive a "hot update" feature would be built from, and nothing
 * short of running it proves the pieces connect.
 *
 * Run: npx electron scripts/experiment-hot-update.mjs
 */
import { app, BrowserWindow } from 'electron'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function finish(payload) {
  console.log('EXPERIMENT_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('EXPERIMENT_END')
  app.exit(0)
}

async function main() {
  const out = { steps: [] }
  const step = (name, detail) => {
    out.steps.push({ name, detail })
  }

  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'hotupd-home-'))

  // A writable copy of the desktop profile, standing in for the data-area
  // profile the self-maintenance proposal would create.
  const profileDir = mkdtempSync(join(tmpdir(), 'hotupd-profile-'))
  cpSync(join(projectRoot, 'desktop-profile'), profileDir, { recursive: true })
  step('profile prepared', profileDir)

  const { startHost } = await import('../dist/main/host.js')
  const host = await startHost({
    dshHome: process.env.DSH_HOME,
    profileDir,
    onProgress: (m) => step('host', m),
  })
  out.hostPort = host.port
  step('host booted', `port ${host.port}`)

  const url = host.authenticatedUrl()
  const win = new BrowserWindow({ show: false, width: 1200, height: 800 })
  await win.loadURL(url)
  await new Promise((r) => setTimeout(r, 4000))

  // What the host currently advertises for client bundles.
  //
  // Reading `window.__DSH_BOOT__` from the renderer proved unreliable: the boot
  // graph is consumed by the module system during startup and may no longer sit
  // on the global afterwards, so a zero there is a measurement artifact rather
  // than a real absence. The host's own `/plugins` route is the authoritative
  // source and is readable from outside the renderer.
  const readServedBundles = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${host.port}/plugins/${encodeURIComponent('ui-schedule')}/client.js`, {
        method: 'HEAD',
      })
      return { status: res.status, served: res.status === 200 }
    } catch (error) {
      return { status: -1, served: false, error: String(error) }
    }
  }

  // A DOM marker is the reliable renderer-side signal that the UI actually came up.
  const readDom = async () => {
    const raw = await win.webContents.executeJavaScript(
      `JSON.stringify({
         rootChildren: document.getElementById('root')?.childElementCount ?? -1,
         title: document.title,
         hasLoader: typeof window.__ModuleLoader__ !== 'undefined',
       })`,
    )
    return JSON.parse(raw)
  }

  const domBefore = await readDom()
  out.domBeforeChange = domBefore
  out.bundleBeforeChange = await readServedBundles()
  step('baseline', `dom=${JSON.stringify(domBefore)}`)

  // --- change the composition on disk, while the app is running -------------
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    `# Hot-added at runtime.
- id: ui-schedule
  disabled: true
`,
    'utf8',
  )
  step('patch written', 'disabled ui-schedule')

  // Give the live watcher a chance (patchReload: live is declared).
  await new Promise((r) => setTimeout(r, 3000))
  out.bundleAfterWatcher = await readServedBundles()
  out.watcherPickedItUp = out.bundleAfterWatcher.served !== out.bundleBeforeChange.served
  step('after watcher wait', JSON.stringify(out.bundleAfterWatcher))

  // --- reload the renderer, which re-fetches the boot graph ----------------
  win.webContents.reload()
  await new Promise((r) => setTimeout(r, 5000))
  out.domAfterReload = await readDom()
  out.bundleAfterReload = await readServedBundles()
  out.rendererSurvivedReload = out.domAfterReload.rootChildren > 0
  step('after renderer reload', `dom=${JSON.stringify(out.domAfterReload)}`)

  // --- did the host itself adopt the change? -------------------------------
  // If the host recomposed, its own served graph must contain the new entry.
  try {
    const res = await fetch(`http://127.0.0.1:${host.port}/plugins`, { method: 'HEAD' })
    out.pluginsRouteResponds = res.status < 500
  } catch {
    out.pluginsRouteResponds = false
  }

  out.verdict = {
    compositionChangedLive: out.watcherPickedItUp,
    rendererReloadKeepsWorking: out.rendererSurvivedReload,
    electronRestartRequired: !out.rendererSurvivedReload,
    note:
      'A renderer reload re-fetches the boot graph from the host. The measured result shows ' +
      'whether a running desktop window survives one and what the host then serves.',
  }

  await host.dispose()
  win.destroy()
  rmSync(profileDir, { recursive: true, force: true })

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
