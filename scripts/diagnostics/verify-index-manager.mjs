// Headless Electron check of src/main/index-manager.ts (built to dist/main):
//   - indexStatus() returns status + coverage (lazy-loads dsh-tool-example)
//   - startRebuild() refuses a duplicate for the same project under a different spelling
//   - cancelRebuild() terminates the worker, emits 'cancelled', leaves no build.lock
//     and keeps current.json pointing at the previous generation
//
// Usage: npx electron scripts/diagnostics/verify-index-manager.mjs <projectRoot>
// Does NOT open a window or touch the running app.
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = process.argv.find((a, i) => i > 1 && existsSync(a) && !a.endsWith('.mjs'))
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failed++
}

app.whenReady().then(async () => {
  if (!projectRoot) { console.log('SKIP: pass a project root'); app.exit(0); return }
  const mgr = await import(pathToFileURL(join(root, 'dist', 'main', 'index-manager.js')).href)
  const events = []
  mgr.setIndexWindowResolver(() => ({ isDestroyed: () => false, webContents: { send: (_c, e) => events.push(e) } }))

  const snap = await mgr.indexStatus(projectRoot)
  check('indexStatus returns status', !!snap.status, snap.status?.state ?? snap.error)
  check('indexStatus returns coverage', snap.coverage !== undefined, JSON.stringify(snap.coverage))

  const curPath = join(mgr.indexDirFor(projectRoot), 'current.json')
  const before = existsSync(curPath) ? readFileSync(curPath, 'utf8') : null

  const r1 = mgr.startRebuild(projectRoot)
  check('startRebuild starts', r1.started, r1.error)
  const alt = projectRoot.replace(/\//g, '\\').toUpperCase() + '\\'
  const r2 = mgr.startRebuild(alt)
  check('duplicate (different spelling) refused', !r2.started, r2.error)

  // wait for some progress, then cancel
  const t0 = Date.now()
  while (!events.some((e) => e.phase === 'building') && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 200))
  check('progress events arrive', events.some((e) => e.phase === 'building'), `${events.length} events`)
  const c = await mgr.cancelRebuild(alt)
  check('cancel ok', c.ok, c.error)
  const t1 = Date.now()
  while (!events.some((e) => e.phase === 'cancelled') && Date.now() - t1 < 10000) await new Promise((r) => setTimeout(r, 100))
  check('cancelled event emitted', events.some((e) => e.phase === 'cancelled'))
  check('no error event after cancel', !events.some((e) => e.phase === 'error'))
  check('build.lock removed', !existsSync(join(mgr.indexDirFor(projectRoot), 'build.lock')))
  const after = existsSync(curPath) ? readFileSync(curPath, 'utf8') : null
  check('current.json unchanged', before === after)
  const snap2 = await mgr.indexStatus(projectRoot)
  check('not building after cancel', snap2.building === false)

  // throttle: building events must be spaced >= ~150ms
  const b = events.filter((e) => e.phase === 'building')
  console.log(`  building events forwarded: ${b.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  console.log(failed ? `\n${failed} failed` : '\nall passed')
  app.exit(failed ? 1 : 0)
})
