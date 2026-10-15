/**
 * Attach to a RUNNING packaged desktop app and capture what its renderer does.
 *
 * The source build works; the packaged build fails with:
 *   client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js
 *
 * Rather than re-deriving the host in-process (which would test the source tree
 * again), this connects to the already-running packaged instance and records the
 * network traffic that actually fails there.
 *
 * Run: npx electron scripts/diagnostics/diagnose-packaged.mjs <port> <token>
 */
import { app, BrowserWindow } from 'electron'

const port = process.argv.find((a) => a.startsWith('--port='))?.slice(7)
const token = process.argv.find((a) => a.startsWith('--token='))?.slice(8)

function finish(payload) {
  console.log('DIAG_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('DIAG_END')
  app.exit(0)
}

async function main() {
  const out = { port, requests: [], consoleMsgs: [] }

  const win = new BrowserWindow({ show: false, width: 1200, height: 800 })

  win.webContents.session.webRequest.onCompleted({ urls: [`http://127.0.0.1:${port}/*`] }, (d) => {
    if (d.url.includes('/plugins') || d.url.includes('/assets/')) {
      out.requests.push({ url: d.url.replace(`http://127.0.0.1:${port}`, '').slice(0, 120), status: d.statusCode })
    }
  })

  win.webContents.on('console-message', (_e, level, message) => {
    out.consoleMsgs.push(`[${level}] ${String(message).slice(0, 300)}`)
  })

  const url = token
    ? `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
    : `http://127.0.0.1:${port}/`

  await win.loadURL(url)
  await new Promise((r) => setTimeout(r, 7000))

  const probe = await win.webContents.executeJavaScript(
    `JSON.stringify({
       title: document.title,
       rootChildren: document.getElementById('root')?.childElementCount ?? -1,
       hasLoader: typeof window.__ModuleLoader__ !== 'undefined',
       bodyText: document.body.innerText.slice(0, 300),
     })`,
  )
  out.renderer = JSON.parse(probe)
  out.requestsMade = out.requests.length
  out.nonOk = out.requests.filter((r) => r.status !== 200)

  win.destroy()
  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
