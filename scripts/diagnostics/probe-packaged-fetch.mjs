/**
 * Ask the packaged renderer WHY the bundle request failed.
 *
 * hasBoot/hasLoader are both true, so the graph arrived and the loader exists —
 * only the bundle fetch failed. Re-issuing that exact request from inside the
 * page reveals whether it is a 404, an auth rejection, or a network error, which
 * an in-process diagnosis cannot show because that path already works.
 *
 * Usage: node scripts/diagnostics/probe-packaged-fetch.mjs 9222
 */
const port = process.argv[2] ?? '9222'

async function evaluate(wsUrl, expression) {
  const { WebSocket } = globalThis
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

  // Read the boot graph, then re-issue the exact URL it asked for.
  const expr = `(async () => {
    const out = { boot: null, probes: [] };
    const boot = window.__DSH_BOOT__;
    if (boot) {
      out.boot = {
        rev: boot.rev,
        batchCount: (boot.batches || []).length,
        firstBatchUrl: boot.batches && boot.batches[0] ? boot.batches[0].url : null,
        entryCount: (boot.entries || []).length,
      };
    }
    const urls = [];
    if (out.boot && out.boot.firstBatchUrl) urls.push(out.boot.firstBatchUrl);
    // Also probe the bare form, to separate "wrong URL" from "route missing".
    urls.push('/plugins/??@deepseek-ai/dsh-client-modules/client.js');

    for (const u of urls) {
      try {
        const r = await fetch(u, { credentials: 'same-origin' });
        const text = await r.text();
        out.probes.push({
          url: String(u).slice(0, 80),
          status: r.status,
          contentType: r.headers.get('content-type'),
          bytes: text.length,
          head: text.slice(0, 120),
        });
      } catch (e) {
        out.probes.push({ url: String(u).slice(0, 80), error: String(e) });
      }
    }
    return JSON.stringify(out);
  })()`

  const res = await evaluate(page.webSocketDebuggerUrl, expr)
  console.log('PROBE_BEGIN')
  console.log(typeof res.result?.result?.value === 'string' ? res.result.result.value : JSON.stringify(res, null, 2))
  console.log('PROBE_END')
}

main().catch((error) => {
  console.log('PROBE_BEGIN')
  console.log(JSON.stringify({ fatal: String(error) }, null, 2))
  console.log('PROBE_END')
})
