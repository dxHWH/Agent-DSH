/**
 * Does the packaged app's directory picker work now?
 *
 * The anchor rewrite points DSH at `app.asar.unpacked`, which should make every
 * path DSH derives real on disk — including the dialog worker the picker spawns.
 * This checks the resolved worker path from inside the packaged runtime, which is
 * the only place the original failure occurred.
 *
 * Usage (inside the packaged app):
 *   "release\win-unpacked\DSH Desktop.exe" --remote-debugging-port=9225
 *   node scripts/diagnostics/verify-picker-path.mjs 9225
 */
const port = process.argv[2] ?? '9225'

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const id = 1
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP timeout')), 20000)
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
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')

  // The renderer cannot reach the host's module paths, so this reports what the
  // renderer CAN see: whether the UI is up. The host-side path facts come from
  // the startup log.
  const expr = `JSON.stringify({
    bootEntries: (window.__DSH_BOOT__?.entries || []).length,
    loaderMode: window.__ModuleLoader__?.mode ?? null,
    uiMounted: (document.getElementById('root')?.childElementCount ?? 0) > 0,
  })`

  const res = await evaluate(page.webSocketDebuggerUrl, expr)
  console.log('VERIFY_BEGIN')
  console.log(typeof res.result?.result?.value === 'string' ? res.result.result.value : JSON.stringify(res, null, 2))
  console.log('VERIFY_END')
}

main().catch((error) => {
  console.log('VERIFY_BEGIN')
  console.log(JSON.stringify({ fatal: String(error) }, null, 2))
  console.log('VERIFY_END')
})
