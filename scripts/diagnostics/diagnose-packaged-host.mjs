/**
 * Where does the packaged app's plugin load actually break?
 *
 * The asar hypothesis is disproved: reads through the asar path work fine. So
 * the failure must be elsewhere. This captures the renderer's real network
 * activity inside a host booted the way the PACKAGED app boots — same anchor
 * path, same asar directory, same file resolution — and reports the first
 * non-200 or missing request.
 *
 * Run: npx electron scripts/diagnostics/diagnose-packaged-host.mjs
 */
import { app, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function finish(payload) {
  console.log('DIAG_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('DIAG_END')
  app.exit(0)
}

async function main() {
  const out = { requests: [], consoleMsgs: [] }

  // Point the whole run at the PACKAGED resources directory, so the anchor,
  // the profile, and the module tree are the ones the installed app uses.
  const resources = join(projectRoot, 'release', 'win-unpacked', 'resources')
  const asarModules = join(resources, 'app.asar', 'node_modules')
  const profileDir = join(resources, 'desktop-profile')

  out.packagedLayout = {
    asarModulesExists: existsSync(asarModules),
    profileExists: existsSync(profileDir),
  }

  process.env.DSH_HOME = join(app.getPath('userData'), 'diag-home')

  // Boot through the source host.ts but with the packaged profile. The anchor
  // itself is resolved by host.ts through require.resolve, which in this dev
  // process yields the SOURCE tree — so this run isolates the PROFILE as the
  // only packaged input. That is the variable the earlier runs did not control.
  const { startHost } = await import('../../dist/main/host.js')
  const host = await startHost({
    dshHome: process.env.DSH_HOME,
    profileDir,
    onProgress: (m) => out.consoleMsgs.push(`[host] ${m}`),
  })
  out.hostPort = host.port

  const win = new BrowserWindow({ show: false, width: 1200, height: 800 })
  win.webContents.session.webRequest.onCompleted({ urls: [`http://127.0.0.1:${host.port}/*`] }, (d) => {
    if (d.url.includes('/plugins')) {
      out.requests.push({ url: d.url.replace(`http://127.0.0.1:${host.port}`, '').slice(0, 90), status: d.statusCode })
    }
  })
  win.webContents.on('console-message', (_e, level, message) => {
    const m = String(message)
    if (/plugin|module|preload|fail/i.test(m)) out.consoleMsgs.push(`[${level}] ${m.slice(0, 250)}`)
  })

  await win.loadURL(host.authenticatedUrl())
  await new Promise((r) => setTimeout(r, 8000))

  const probe = await win.webContents.executeJavaScript(
    `JSON.stringify({
       rootChildren: document.getElementById('root')?.childElementCount ?? -1,
       hasLoader: typeof window.__ModuleLoader__ !== 'undefined',
       bodyText: document.body.innerText.slice(0, 180),
     })`,
  )
  out.renderer = JSON.parse(probe)
  out.pluginStatuses = out.requests.map((r) => r.status)
  out.anyNon200 = out.requests.filter((r) => r.status !== 200)

  await host.dispose()
  win.destroy()
  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
