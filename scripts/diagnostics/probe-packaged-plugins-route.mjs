/**
 * Ask the packaged host's /plugins route what it knows.
 *
 * The renderer already showed entryCount 0. The host side composes that graph,
 * so the question is what the host's own module service reports. The /plugins
 * prefix route is served by the same service, so probing it distinguishes
 * "service has no graph" from "graph exists but injection lost it".
 *
 * Usage: node scripts/diagnostics/probe-packaged-plugins-route.mjs <hostPort>
 */
const hostPort = process.argv[2]

async function main() {
  if (!hostPort) throw new Error('usage: node probe-packaged-plugins-route.mjs <port>')

  const out = { probes: [] }
  const paths = [
    '/plugins',
    '/plugins/',
    '/plugins/??@deepseek-ai/dsh-client-modules/client.js',
    '/plugins/events',
  ]

  for (const p of paths) {
    try {
      const r = await fetch(`http://127.0.0.1:${hostPort}${p}`)
      const text = await r.text()
      out.probes.push({
        path: p,
        status: r.status,
        contentType: r.headers.get('content-type'),
        bytes: text.length,
        head: text.slice(0, 160).replace(/\s+/g, ' '),
      })
    } catch (error) {
      out.probes.push({ path: p, error: String(error).slice(0, 120) })
    }
  }

  console.log('ROUTE_BEGIN')
  console.log(JSON.stringify(out, null, 2))
  console.log('ROUTE_END')
}

main().catch((error) => {
  console.log('ROUTE_BEGIN')
  console.log(JSON.stringify({ fatal: String(error) }, null, 2))
  console.log('ROUTE_END')
})
