/**
 * Is the packaged app's empty boot graph a TIMING problem?
 *
 * `client-modules` composes the graph from `ctx.loader.entries()` and has no
 * full-rescan path. If its first activation pass runs before the Loader has
 * populated entries, the empty result is frozen — which matches the observed
 * rev being constant across launches.
 *
 * This boots the host exactly as the packaged app does, then samples the loader
 * entry count over time, and finally reports the graph the module service holds.
 * A loader that fills LATE would confirm the timing hypothesis.
 *
 * Run: npx electron scripts/diagnostics/diagnose-boot-timing.mjs
 */
import { app } from 'electron'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  const out = { timeline: [] }
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const { provideCmdline } = await import('@deepseek-ai/dsh-cmdline')
  const require = createRequire(import.meta.url)
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')

  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'timing-home-'))
  const profileDir = join(projectRoot, 'desktop-profile')

  const profile = boot.loadProfileDirectory('dsh-desktop', profileDir, installAnchor)

  // Record every internal/plugin emission — that is the event client-modules
  // listens on, so the ORDER of these against its first scan matters.
  let pluginEvents = 0

  const t0 = Date.now()
  const ctx = await boot.boot(
    'dsh-desktop',
    join(profile.dir, 'cordis.yml'),
    [...profile.layers.flatMap((l) => l.patches ?? []), ...(profile.patches ?? [])],
    (hostCtx) => {
      provideCmdline(hostCtx, { args: ['--no-open', '--port', '0'], exit: () => {} })
      hostCtx.on?.('internal/plugin', () => {
        pluginEvents++
      })
    },
  )

  out.bootMs = Date.now() - t0

  // Sample the module graph over time to see whether it ever fills in.
  const modules = ctx.get('clientModules')
  out.clientModulesPresent = modules !== undefined

  for (const delay of [0, 500, 1500, 3000]) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    let entries = -1
    try {
      const g = modules?.graph?.()
      entries = g?.entries?.length ?? -1
    } catch (error) {
      entries = `error: ${String(error).slice(0, 60)}`
    }
    out.timeline.push({ atMs: Date.now() - t0, graphEntries: entries, pluginEvents })
  }

  // Whether a late manual rescan is even possible.
  const graph = modules?.graph?.()
  out.finalGraph = {
    entries: graph?.entries?.length ?? -1,
    batches: graph?.batches?.length ?? -1,
    rev: graph?.rev ?? null,
  }
  out.finalPluginEvents = pluginEvents

  // The loader's real entry count, read directly.
  try {
    const loader = ctx.get('loader')
    const entries = loader?.entries?.()
    out.loaderEntryCount = Array.isArray(entries) ? entries.length : -1
  } catch (error) {
    out.loaderError = String(error)
  }

  await ctx.fiber.dispose()
  rmSync(process.env.DSH_HOME, { recursive: true, force: true })

  out.diagnosis =
    out.finalGraph.entries > 0
      ? 'The graph is populated in this process — the empty graph is packaging-specific.'
      : 'The graph stays empty even here — the cause is not packaging alone.'

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
