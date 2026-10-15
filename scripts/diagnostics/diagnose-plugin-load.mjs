/**
 * Diagnose the "Failed to load plugins" failure in the desktop client.
 *
 * The error text is:
 *   client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js
 *
 * That message says the SHELL HTML requested a bundle the module system could not
 * fetch. This captures the actual network traffic and console output from the
 * window, so the failing request and its status are observed rather than guessed.
 *
 * Run: npx electron scripts/diagnostics/diagnose-plugin-load.mjs
 */
import { app, BrowserWindow } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function finish(payload) {
  console.log('DIAG_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('DIAG_END')
  app.exit(0)
}

async function main() {
  const out = { requests: [], failures: [], console: [] }
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'diag-home-'))

  const { startHost } = await import('../../dist/main/host.js')
  const host = await startHost({
    dshHome: process.env.DSH_HOME,
    profileDir: join(projectRoot, 'desktop-profile'),
    onProgress: (m) => out.console.push(`[host] ${m}`),
  })
  out.hostPort = host.port

  const win = new BrowserWindow({ show: false, width: 1200, height: 800 })

  // Capture every request the renderer makes for a plugin bundle.
  win.webContents.session.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    const u = details.url
    if (u.includes('/plugins') || u.includes('/assets/index-')) {
      out.requests.push({
        url: u.replace(`http://127.0.0.1:${host.port}`, ''),
        status: details.statusCode,
        method: details.method,
      })
    }
  })

  win.webContents.session.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (details) => {
    if (details.url.includes('/plugins')) {
      out.failures.push({ url: details.url, error: details.error })
    }
  })

  win.webContents.on('console-message', (_e, level, message) => {
    out.console.push(`[${level}] ${message}`)
  })

  await win.loadURL(host.authenticatedUrl())
  await new Promise((r) => setTimeout(r, 8000))

  // Read what the boot graph actually asked for.
  const boot = await win.webContents.executeJavaScript(
    `JSON.stringify({
       hasBoot: typeof window.__DSH_BOOT__ !== 'undefined',
       bootEntries: (typeof window.__DSH_BOOT__ !== 'undefined' && window.__DSH_BOOT__.entries)
         ? window.__DSH_BOOT__.entries.slice(0, 6).map(e => ({ id: e.id, url: e.url }))
         : null,
       bootBatches: (typeof window.__DSH_BOOT__ !== 'undefined' && window.__DSH_BOOT__.batches)
         ? window.__DSH_BOOT__.batches.map(b => ({ phase: b.phase, url: b.url, entries: b.entries.length }))
         : null,
       hasLoader: typeof window.__ModuleLoader__ !== 'undefined',
       rootChildren: document.getElementById('root')?.childElementCount ?? -1,
       bodyText: document.body.innerText.slice(0, 200),
     })`,
  )
  out.renderer = JSON.parse(boot)

  out.pluginRequests = out.requests
  out.analysis = {
    pluginRequestsMade: out.requests.length,
    anyNon200: out.requests.filter((r) => r.status !== 200),
    bootEntriesPresent: out.renderer.hasBoot,
    bootEntryCount: Array.isArray(out.renderer.bootEntries) ? out.renderer.bootEntries.length : 0,
  }

  await host.dispose()
  win.destroy()
  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
