/**
 * Reproduce the failure through the REAL host, not a direct import.
 *
 * A direct import of the picker from the packaged asar path WORKS. So the
 * failure is not the path per se — it is something about how the running host
 * reaches the picker, or about the environment the host process has when the
 * pick happens.
 *
 * This boots the packaged composition and asks the host's own service to pick,
 * which is the closest reproduction of the user's action.
 *
 * Run: npx electron scripts/diagnostics/repro-host-pick.mjs
 */
import { app } from 'electron'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function finish(payload) {
  console.log('REPRO_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('REPRO_END')
  app.exit(0)
}

async function main() {
  const out = {}
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const { provideCmdline } = await import('@deepseek-ai/dsh-cmdline')
  const require = createRequire(import.meta.url)

  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'hostpick-home-'))
  const resources = join(projectRoot, 'release', 'win-unpacked', 'resources')
  const profileDir = join(resources, 'desktop-profile')
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')

  out.anchor = installAnchor
  out.anchorIsAsar = installAnchor.includes('app.asar')

  const profile = boot.loadProfileDirectory('dsh-desktop', profileDir, installAnchor)

  const ctx = await boot.boot(
    'dsh-desktop',
    join(profile.dir, 'cordis.yml'),
    [...profile.layers.flatMap((l) => l.patches ?? []), ...(profile.patches ?? [])],
    (hostCtx) => {
      provideCmdline(hostCtx, { args: ['--no-open', '--port', '0'], exit: () => {} })
    },
  )

  // Find whatever service performs a directory pick, and learn its shape.
  const candidates = ['directoryPicker', 'directory-picker', 'hostDirectoryPicker']
  out.services = {}
  for (const name of candidates) {
    const svc = ctx.get(name)
    if (svc !== undefined) {
      out.services[name] = Object.keys(svc).slice(0, 12)
    }
  }
  if (Object.keys(out.services).length === 0) {
    // Enumerate the registry instead of guessing names.
    const seen = []
    for (const name of candidates) if (ctx.get(name)) seen.push(name)
    out.services.enumerated = seen
  }

  // The pick itself: abort quickly, because a human would have to answer.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  out.abortAfterMs = 4000

  try {
    const picker = ctx.get('directoryPicker')
    if (picker === undefined) {
      out.error = 'no directoryPicker service on this composition'
    } else {
      const cap = picker.capability?.('native') ?? picker.native ?? picker
      out.capabilityShape = typeof cap
      const pick = cap.pick ?? cap
      out.pickType = typeof pick
      if (typeof pick === 'function') {
        const result = await pick.call(cap, controller.signal)
        out.result = result
        out.verdict = 'the host pick SUCCEEDED'
      } else {
        out.error = 'native capability exposes no callable pick'
      }
    }
  } catch (error) {
    out.error = String(error).slice(0, 300)
    out.verdict = /worker exited before reporting/.test(String(error))
      ? 'REPRODUCED through the host: worker exited before reporting'
      : 'the host pick threw a different error'
  } finally {
    clearTimeout(timer)
  }

  await ctx.fiber.dispose()
  rmSync(process.env.DSH_HOME, { recursive: true, force: true })
  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
