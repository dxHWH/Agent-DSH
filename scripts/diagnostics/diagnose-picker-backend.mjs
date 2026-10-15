/**
 * Which directory-picker backend did the host actually mount, and why?
 *
 * `dsh-host-directory-picker-auto` samples the host once at boot and mounts
 * either the native chooser or the in-app browser. The native chooser is the one
 * that fails, so knowing which was selected — and which signal decided it — is
 * what makes a fix possible.
 *
 * Run: npx electron scripts/diagnostics/diagnose-picker-backend.mjs
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
  const out = {}
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const { provideCmdline } = await import('@deepseek-ai/dsh-cmdline')
  const require = createRequire(import.meta.url)

  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'backend-home-'))
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')

  out.launchFacts = {
    // The auto-chooser refuses native over SSH; these are the signals it reads.
    sshConnection: process.env.SSH_CONNECTION ?? '(unset)',
    sshTty: process.env.SSH_TTY ?? '(unset)',
    display: process.env.DISPLAY ?? '(unset)',
    waylandDisplay: process.env.WAYLAND_DISPLAY ?? '(unset)',
    platform: process.platform,
  }

  const profile = boot.loadProfileDirectory('dsh-desktop', join(projectRoot, 'desktop-profile'), installAnchor)
  const ctx = await boot.boot(
    'dsh-desktop',
    join(profile.dir, 'cordis.yml'),
    [...profile.layers.flatMap((l) => l.patches ?? []), ...(profile.patches ?? [])],
    (hostCtx) => {
      provideCmdline(hostCtx, { args: ['--no-open', '--port', '0'], exit: () => {} })
    },
  )

  // The mounted backend is discoverable from the loader rows the chooser added.
  try {
    const loader = ctx.get('loader')
    const rows = [...loader.entries()].map((e) => e?.options?.name).filter(Boolean)
    out.mountedBackends = rows.filter((n) => n.includes('directory-picker'))
  } catch (error) {
    out.loaderError = String(error)
  }

  // The live capability names which backend answered.
  try {
    const picker = ctx.get('directoryPicker')
    out.pickerKeys = picker ? Object.keys(picker) : null
    const cap = picker?.nativeCapability
    out.capabilityKind = cap?.kind ?? null
    out.capabilityKeys = cap ? Object.keys(cap) : null
  } catch (error) {
    out.pickerError = String(error)
  }

  await ctx.fiber.dispose()
  rmSync(process.env.DSH_HOME, { recursive: true, force: true })
  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
