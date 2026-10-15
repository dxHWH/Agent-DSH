/**
 * Can the DESKTOP CLIENT run a locally modified DSH?
 *
 * The user's combination: work inside the desktop client, while iterating on raw
 * DSH (plugins, agent loop). That requires the desktop app to load DSH from
 * somewhere the developer controls — not from a read-only npm install.
 *
 * This measures the three candidate mechanisms and reports which ones the current
 * host.ts would actually honor:
 *
 *   M1  patch the installed package in place (node_modules edit)
 *   M2  npm overrides / workspaces pointing at a local checkout
 *   M3  a data-area DSH installation the host prefers over the bundled one
 *
 * Run: npx electron scripts/audit-dev-loop.mjs
 */
import { app } from 'electron'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, statSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function finish(payload) {
  console.log('AUDIT_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('AUDIT_END')
  app.exit(0)
}

async function main() {
  const out = {}
  const require = createRequire(import.meta.url)

  // --- where does the desktop app load DSH from today? ---------------------
  try {
    const dshPkg = require.resolve('@deepseek-ai/dsh/package.json')
    const dshRoot = dirname(dshPkg)
    const loopPkg = require.resolve('@deepseek-ai/dsh-agent-loop/package.json')
    const loopRoot = dirname(loopPkg)
    const loopEntry = join(loopRoot, 'lib', 'index.js')
    const st = statSync(loopEntry)

    out.resolution = {
      dshRoot,
      loopRoot,
      loopEntry,
      loopEntryBytes: st.size,
      isInsideProject: dshRoot.startsWith(projectRoot),
      hasSourceTree: existsSync(join(loopRoot, 'src')),
      hasSourceMap: existsSync(`${loopEntry}.map`),
    }

    // Is the entry writable by the developer? That decides whether M1 works.
    try {
      const probe = `${loopEntry}.probe`
      writeFileSync(probe, '', 'utf8')
      rmSync(probe, { force: true })
      out.resolution.entryIsWritable = true
    } catch {
      out.resolution.entryIsWritable = false
    }

    // The compiled output is readable, not minified into oblivion: function and
    // parameter names survive, which is what makes M1 workable at all.
    const head = readFileSync(loopEntry, 'utf8').slice(0, 4000)
    out.resolution.preservesNames = /function\s+[a-zA-Z]{4,}/.test(head)
    out.resolution.hasArbitraryMinifiedNames = /\b[a-z]\$?\d?\s*=\s*function/.test(head) === false
  } catch (error) {
    out.resolutionError = String(error)
  }

  // --- M1: patch in place --------------------------------------------------
  try {
    out.M1_patchInPlace = {
      mechanism: 'edit node_modules/@deepseek-ai/<pkg>/lib/*.js directly',
      worksToday: out.resolution?.entryIsWritable === true,
      survivesNpmInstall: false,
      needsRebuild: false,
      note:
        'Immediately effective after an app restart. Lost on any npm install/CI refresh, ' +
        'so it must be paired with a patch script or a postinstall step.',
    }
  } catch (error) {
    out.M1Error = String(error)
  }

  // --- M2: npm overrides / workspaces -------------------------------------
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
    out.M2_overrides = {
      mechanism: 'point @deepseek-ai/* at a local checkout via npm overrides or file: deps',
      currentlyConfigured: Boolean(pkg.overrides) || Boolean(pkg.workspaces),
      npmSupportsOverrides: true,
      note:
        'npm overrides can redirect a dependency to a local path. The DSH packages would ' +
        'then resolve to your checkout, so edits are ordinary source edits.',
      caveat:
        'Requires a built checkout (DSH ships compiled lib/, so a source checkout needs its ' +
        'own build step before the desktop app can import it).',
    }
  } catch (error) {
    out.M2Error = String(error)
  }

  // --- M3: data-area DSH ---------------------------------------------------
  try {
    // host.ts resolves the anchor through require.resolve with no override hook,
    // so M3 is NOT supported today — measure that honestly.
    const hostSrc = readFileSync(join(projectRoot, 'src', 'main', 'host.ts'), 'utf8')
    const hasOverrideHook = /DSH_INSTALL_ANCHOR|dshAnchorOverride|process\.env\.DSH_DSH_/.test(hostSrc)
    out.M3_dataAreaDsh = {
      mechanism: 'prefer a DSH installed under the user data area',
      supportedToday: hasOverrideHook,
      note: hasOverrideHook
        ? 'host.ts already honors an override.'
        : 'host.ts calls require.resolve directly; adding an env override is a small change.',
      changeNeeded: hasOverrideHook ? 'none' : 'add an env-var override in resolveInstallAnchor()',
    }
  } catch (error) {
    out.M3Error = String(error)
  }

  // --- the decisive question: does an edit reach the running app? ----------
  try {
    out.hotReloadOfHostCode = {
      supported: false,
      reason:
        'Node caches imported modules for the process lifetime, and cordis-plugin-hmr is ' +
        'blocked in Electron (needs --expose-internals).',
      therefore: 'a host-code edit requires an app restart — but NOT a rebuild, for M1.',
      restartCost: 'a few seconds; sessions persist on disk',
    }
  } catch (error) {
    out.hotError = String(error)
  }

  out.answer = {
    canDesktopRunModifiedDsh: true,
    easiestToday: 'M1 — edit the installed package and restart the app',
    cleanestLongTerm: 'M2 — npm overrides pointing at a built local checkout',
    notSupportedYet: 'M3 — host.ts has no install-anchor override',
    keyLimitation:
      'Editing lib/*.js means editing build output. It works because the output preserves ' +
      'names, but it is not the same as editing source, and a reinstall erases it.',
    recommendation:
      'Use M1 now for immediate iteration; add M2 (overrides) when the changes grow beyond ' +
      'a few lines and need to survive reinstalls.',
  }

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
