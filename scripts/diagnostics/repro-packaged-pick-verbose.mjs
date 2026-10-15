/**
 * Reproduce the picker failure the way the PACKAGED app hits it.
 *
 * Every isolated test so far works — forking the worker off both the asar and
 * the unpacked path opens a real dialog. So the difference must be in the
 * packaged app's RUNTIME environment, not the path.
 *
 * This boots the packaged composition inside the packaged runtime and performs a
 * real pick, capturing the worker's own stderr — the one channel every test so
 * far has failed to surface, because `fork` defaults to inheriting a channel the
 * picker may configure differently.
 *
 * Run: "release\win-unpacked\DSH Desktop.exe" --remote-debugging-port=9226  (no)
 * Instead: npx electron scripts/diagnostics/repro-packaged-pick-verbose.mjs
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
  const out = { notes: [] }
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const { provideCmdline } = await import('@deepseek-ai/dsh-cmdline')
  const require = createRequire(import.meta.url)

  // Use the PACKAGED anchor so the composition under test is the shipped one.
  const resources = join(projectRoot, 'release', 'win-unpacked', 'resources')
  const packagedAnchor = join(resources, 'app.asar', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')

  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'pkgpick-home-'))
  const profileDir = join(resources, 'desktop-profile')

  out.anchor = packagedAnchor

  // Boot reading bundles from the PACKAGED tree while running in this Electron.
  // The bundled DSH resolves from the packaged anchor, which is what the shipped
  // app does; the difference from the shipped app is only which Electron binary
  // hosts it.
  const profile = boot.loadProfileDirectory('dsh-desktop', profileDir, packagedAnchor)

  const ctx = await boot.boot(
    'dsh-desktop',
    join(profile.dir, 'cordis.yml'),
    [...profile.layers.flatMap((l) => l.patches ?? []), ...(profile.patches ?? [])],
    (hostCtx) => {
      provideCmdline(hostCtx, { args: ['--no-open', '--port', '0'], exit: () => {} })
    },
  )
  out.booted = true

  // Which picker backends are mounted, and which one answers `pick`?
  const picker = ctx.get('directoryPicker')
  out.pickerServiceKeys = picker ? Object.keys(picker) : null

  const cap = picker?.nativeCapability
  out.nativeCapabilityKeys = cap ? Object.keys(cap) : null

  // Perform the pick with a short abort; a human would otherwise have to answer.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)

  try {
    const pick = cap?.pick
    out.pickType = typeof pick
    if (typeof pick === 'function') {
      const result = await pick.call(cap, controller.signal)
      out.result = result
      out.verdict = 'pick returned'
    } else {
      out.verdict = 'no pick function on the native capability'
    }
  } catch (error) {
    out.error = String(error).slice(0, 400)
    out.verdict = /worker exited before reporting/.test(String(error))
      ? 'REPRODUCED: worker exited before reporting'
      : 'pick threw a different error'
  } finally {
    clearTimeout(timer)
  }

  await ctx.fiber.dispose()
  rmSync(process.env.DSH_HOME, { recursive: true, force: true })
  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
