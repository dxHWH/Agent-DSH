/**
 * Confirm the browse swap actually took effect.
 *
 * The composition now lists BOTH `directory-picker-auto` and the browse pair.
 * That is expected only if auto is disabled-but-present; if it is still RUNNING
 * then both backends would publish `directoryPicker` and the mount would fail
 * loud. So the decisive check is which capability the live service exposes.
 *
 * Run: npx electron scripts/diagnostics/verify-browse-swap.mjs
 */
import { app } from 'electron'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function finish(payload) {
  console.log('VERIFY_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('VERIFY_END')
  app.exit(0)
}

async function main() {
  const out = {}
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const { provideCmdline } = await import('@deepseek-ai/dsh-cmdline')
  const require = createRequire(import.meta.url)

  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'browse-swap-'))
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
  const profile = boot.loadProfileDirectory('dsh-desktop', join(projectRoot, 'desktop-profile'), installAnchor)

  const rows = boot.composeEntries([
    profile.layers.flatMap((l) => l.patches ?? []),
    profile.patches ?? [],
  ])
  out.composedRows = {
    autoDisabled: rows.find((r) => r.id === 'directory-picker')?.disabled === true,
    browseHostPresent: rows.some((r) => r.id === 'directory-picker-browse'),
    browseClientPresent: rows.some((r) => r.id === 'ui-directory-picker-browse'),
  }

  const ctx = await boot.boot(
    'dsh-desktop',
    join(profile.dir, 'cordis.yml'),
    [...profile.layers.flatMap((l) => l.patches ?? []), ...(profile.patches ?? [])],
    (hostCtx) => {
      provideCmdline(hostCtx, { args: ['--no-open', '--port', '0'], exit: () => {} })
    },
  )
  out.booted = true

  // Which capability does the live service expose? Only one backend may publish
  // `directoryPicker`, so this also proves the swap did not double-mount.
  const picker = ctx.get('directoryPicker')
  out.liveService = picker ? Object.keys(picker) : null

  // The service should now expose a browse capability and no native one.
  out.verdict = {
    browseCapabilityPresent: picker?.browseCapability !== undefined,
    nativeCapabilityAbsent: picker?.nativeCapability === undefined,
  }
  out.swapSucceeded = Object.values(out.verdict).every(Boolean)

  // Exercise browse with a harmless listing, proving it works without an OS dialog.
  try {
    const cap = picker?.browseCapability
    if (cap && typeof cap.list === 'function') {
      const listing = await cap.list(undefined)
      out.listProbe = {
        ok: true,
        entries: Array.isArray(listing?.entries) ? listing.entries.length : typeof listing,
        hasHome: typeof listing?.home === 'string',
      }
    } else {
      out.listProbe = { ok: false, reason: 'browse capability exposes no list()' }
    }
  } catch (error) {
    out.listProbe = { ok: false, error: String(error).slice(0, 200) }
  }

  await ctx.fiber.dispose()
  rmSync(process.env.DSH_HOME, { recursive: true, force: true })
  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
