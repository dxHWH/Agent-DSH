/**
 * Why is the packaged app's boot graph EMPTY?
 *
 * CDP showed the packaged renderer receives `entryCount: 0, batchCount: 0`,
 * while the source build receives 6 entries and 2 batches. `client-modules`
 * composes the graph by scanning the HOST LOADER's entries, so an empty graph
 * means the loader had no client-plugin rows — not that bundle serving broke.
 *
 * This boots the host twice and compares the loader's entry list:
 *   A. through the source module tree (known good)
 *   B. pointed at the packaged app.asar tree (known bad)
 *
 * Run: npx electron scripts/diagnostics/diagnose-empty-boot.mjs
 */
import { app } from 'electron'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
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

/** Boot a host and report what the client-modules node half would see. */
async function probe(label, installAnchor, profileDir, home) {
  const rec = { label, installAnchor, profileDir }
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const { provideCmdline } = await import('@deepseek-ai/dsh-cmdline')

  try {
    const profile = boot.loadProfileDirectory(label, profileDir, installAnchor)
    const rows = boot.composeEntries([
      profile.layers.flatMap((l) => l.patches ?? []),
      profile.patches ?? [],
    ])
    rec.composedRows = rows.length
    // Count rows whose name looks like a client plugin — these are what the
    // boot graph is built from.
    rec.clientLookingRows = rows.filter((r) => (r.name ?? '').includes('dsh-client')).length

    const ctx = await boot.boot(
      label,
      join(profile.dir, 'cordis.yml'),
      [...profile.layers.flatMap((l) => l.patches ?? []), ...(profile.patches ?? [])],
      (hostCtx) => {
        provideCmdline(hostCtx, { args: ['--no-open', '--port', '0'], exit: () => {} })
      },
    )
    rec.booted = true

    // The loader's actual entry list — what client-modules scans.
    const loader = ctx.get('loader')
    rec.loaderPresent = loader !== undefined
    if (loader && typeof loader.entries === 'function') {
      const entries = loader.entries()
      rec.loaderEntryCount = Array.isArray(entries) ? entries.length : -1
    }

    // The client-modules service exposes the graph it composed.
    const modules = ctx.get('clientModules')
    rec.clientModulesPresent = modules !== undefined
    if (modules && typeof modules.graph === 'function') {
      const graph = modules.graph()
      rec.graphEntries = graph?.entries?.length ?? -1
      rec.graphBatches = graph?.batches?.length ?? -1
      rec.graphRev = graph?.rev ?? null
    }

    await ctx.fiber.dispose()
  } catch (error) {
    rec.error = String(error).slice(0, 400)
  }
  return rec
}

async function main() {
  const out = {}
  const require = createRequire(import.meta.url)
  const sourceAnchor = require.resolve('@deepseek-ai/dsh/package.json')

  const resources = join(projectRoot, 'release', 'win-unpacked', 'resources')
  const asarAnchorCandidate = join(resources, 'app.asar', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const unpackedAnchorCandidate = join(resources, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')

  out.anchors = {
    source: sourceAnchor,
    asar: asarAnchorCandidate,
    asarExists: existsSync(asarAnchorCandidate),
    unpacked: unpackedAnchorCandidate,
    unpackedExists: existsSync(unpackedAnchorCandidate),
  }

  // Both profiles exist; use the packaged one for both runs so the profile is
  // held constant and only the module tree varies.
  const profileDir = join(resources, 'desktop-profile')

  const homeA = mkdtempSync(join(tmpdir(), 'empty-a-'))
  out.sourceTree = await probe('probe-source', sourceAnchor, profileDir, homeA)
  rmSync(homeA, { recursive: true, force: true })

  // The decisive run: same profile, but the anchor points into the packaged
  // asar. If the graph is empty here while the source run above is populated,
  // the packaged module tree is what loses the client-plugin rows.
  if (existsSync(asarAnchorCandidate)) {
    const homeB = mkdtempSync(join(tmpdir(), 'empty-b-'))
    out.asarTree = await probe('probe-asar', asarAnchorCandidate, profileDir, homeB)
    rmSync(homeB, { recursive: true, force: true })
  }

  // And the unpacked copy, to see whether it behaves like source or like asar.
  if (existsSync(unpackedAnchorCandidate)) {
    const homeC = mkdtempSync(join(tmpdir(), 'empty-c-'))
    out.unpackedTree = await probe('probe-unpacked', unpackedAnchorCandidate, profileDir, homeC)
    rmSync(homeC, { recursive: true, force: true })
  }

  out.comparison = {
    sourceGraphEntries: out.sourceTree?.graphEntries,
    asarGraphEntries: out.asarTree?.graphEntries,
    unpackedGraphEntries: out.unpackedTree?.graphEntries,
  }
  out.diagnosis =
    out.asarTree?.graphEntries === 0
      ? 'The packaged asar tree composes an EMPTY client graph — that is the failure.'
      : 'The asar tree also composes entries, so the empty graph has another cause.'

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
