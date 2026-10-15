/**
 * Read the packaged renderer's module system state over CDP.
 *
 * The packaged host starts cleanly and its boot graph is present-but-empty
 * (entryCount 0). The graph is composed host-side from loader rows, so an empty
 * graph with a healthy host means the composition step produced nothing — OR the
 * injected graph is present but the loader failed before consuming it.
 *
 * This inspects what the page actually received and what the loader recorded.
 *
 * Usage: node scripts/diagnostics/inspect-packaged-modules.mjs 9222
 */
const port = process.argv[2] ?? '9222'

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

  const expr = `JSON.stringify({
    boot: (() => {
      const b = window.__DSH_BOOT__;
      if (!b) return null;
      return {
        rev: b.rev,
        entryCount: (b.entries || []).length,
        batchCount: (b.batches || []).length,
        entryIds: (b.entries || []).slice(0, 8).map(e => e.id),
        batchPhases: (b.batches || []).map(x => ({ phase: x.phase, entries: (x.entries||[]).length, url: String(x.url).slice(0,60) })),
      };
    })(),
    loader: (() => {
      const l = window.__ModuleLoader__;
      if (!l) return null;
      return {
        keys: Object.keys(l),
        mode: l.mode ?? null,
        pendingQueueLength: Array.isArray(l.pendingQueue) ? l.pendingQueue.length : null,
        manifest: l.manifest ? { entries: (l.manifest.entries||[]).length, batches: (l.manifest.batches||[]).length } : null,
      };
    })(),
    globals: Object.keys(window).filter(k => k.startsWith('__DSH') || k.startsWith('__Module')),
    rootHTML: (document.getElementById('root')?.innerHTML || '').slice(0, 300),
  })`

  const res = await evaluate(page.webSocketDebuggerUrl, expr)
  console.log('INSPECT_BEGIN')
  console.log(typeof res.result?.result?.value === 'string' ? res.result.result.value : JSON.stringify(res, null, 2))
  console.log('INSPECT_END')
}

main().catch((error) => {
  console.log('INSPECT_BEGIN')
  console.log(JSON.stringify({ fatal: String(error) }, null, 2))
  console.log('INSPECT_END')
})
