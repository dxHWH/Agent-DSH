/**
 * Read the packaged app's renderer state over the Chrome DevTools Protocol.
 *
 * The packaged app is the only place the failure reproduces, and it exposes a
 * CDP endpoint when launched with --remote-debugging-port. This connects to that
 * page and evaluates the live DOM plus any recorded failure, which is the
 * closest thing to standing inside the installed app.
 *
 * Usage:
 *   1. release\win-unpacked\DSH Desktop.exe --remote-debugging-port=9222
 *   2. node scripts/diagnostics/inspect-packaged-cdp.mjs 9222
 */
const port = process.argv[2] ?? '9222'

/** Minimal CDP client over WebSocket, using Node's global WebSocket. */
async function evaluate(wsUrl, expression) {
  const { WebSocket } = globalThis
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  const id = 1
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP timeout')), 10000)
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id === id) {
        clearTimeout(timer)
        resolve(msg)
      }
    })
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  ws.close()
  return result
}

async function main() {
  const listRes = await fetch(`http://127.0.0.1:${port}/json`)
  const targets = await listRes.json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) {
    console.log(JSON.stringify({ error: 'no page target', targets }, null, 2))
    return
  }

  const probe = `JSON.stringify({
    title: document.title,
    url: location.href.replace(/token=[^&]+/, 'token=***'),
    rootChildren: document.getElementById('root')?.childElementCount ?? -1,
    hasLoader: typeof window.__ModuleLoader__ !== 'undefined',
    hasBoot: typeof window.__DSH_BOOT__ !== 'undefined',
    bodyText: document.body.innerText.slice(0, 400),
    scripts: [...document.querySelectorAll('script')].map(s => s.src || 'inline').slice(0, 8),
  })`

  const res = await evaluate(page.webSocketDebuggerUrl, probe)
  console.log('CDP_BEGIN')
  console.log(JSON.stringify({ target: { title: page.title, url: page.url }, result: res.result }, null, 2))
  console.log('CDP_END')
}

main().catch((error) => {
  console.log('CDP_BEGIN')
  console.log(JSON.stringify({ fatal: String(error) }, null, 2))
  console.log('CDP_END')
})
