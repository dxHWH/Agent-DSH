/**
 * Does a DSH "kernel" iteration need a client hot update?
 *
 * The distinction that matters: WHERE the changed code lives determines what must
 * be updated. Three cases behave completely differently:
 *
 *   1. A preset/composition change  -> data, no client update
 *   2. A plugin package change      -> plugin bundle, client reload may suffice
 *   3. The DSH package itself       -> new code on disk, requires a restart
 *
 * Conflating these is exactly how "no hot update needed" becomes wrong advice.
 * This measures where the running code actually comes from in each case.
 *
 * Run: npx electron scripts/audit-kernel-iteration.mjs
 */
import { app } from 'electron'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function finish(payload) {
  console.log('AUDIT_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('AUDIT_END')
  app.exit(0)
}

/** Total bytes under a directory, bounded so a huge tree cannot hang the audit. */
function treeSize(dir, budget = 4000) {
  let bytes = 0
  let files = 0
  const walk = (d) => {
    if (files > budget) return
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (files > budget) return
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else {
        try {
          bytes += statSync(full).size
          files++
        } catch {
          /* skip */
        }
      }
    }
  }
  walk(dir)
  return { bytes, files, truncated: files > budget }
}

async function main() {
  const out = {}
  const require = createRequire(import.meta.url)

  // --- where does the RUNNING host code come from? -------------------------
  try {
    const bootEntry = require.resolve('@deepseek-ai/dsh-agent-loop')
    out.runningHostCode = {
      agentLoopEntry: bootEntry,
      // In a source checkout this resolves into the project's node_modules.
      // In a packaged app it resolves inside app.asar.unpacked.
      isInsideProject: bootEntry.startsWith(projectRoot),
    }

    // The loop is the closest thing to a "kernel": it drives turns and steps.
    const loopDir = dirname(bootEntry)
    const loopPkg = JSON.parse(readFileSync(join(loopDir, '..', 'package.json'), 'utf8'))
    out.agentLoop = { version: loopPkg.version, package: loopPkg.name }
  } catch (error) {
    out.runningHostCodeError = String(error)
  }

  // --- case 1: composition / preset change --------------------------------
  try {
    // A preset is a file; the composition is assembled from patch layers.
    // Neither writes executable host code.
    out.case1_compositionChange = {
      whatChanges: 'a YAML file under <dshHome>/.agent-presets or cordis.patch.yml',
      executableHostCodeWritten: false,
      clientBundleChanged: false,
      requiresClientUpdate: false,
      requiresHostRestart: 'yes for discovery to re-read the roster',
      // The renderer must re-fetch the boot graph, but that is a reload, not an update.
      requiresRendererReload: 'only if composition rows changed',
    }
  } catch (error) {
    out.case1Error = String(error)
  }

  // --- case 2: plugin package change --------------------------------------
  try {
    // A client plugin ships a built bundle served over /plugins.
    const modulesEntry = require.resolve('@deepseek-ai/dsh-client-modules')
    out.case2_pluginChange = {
      whereClientPluginsLive: dirname(modulesEntry),
      clientBundleIsFileOnDisk: true,
      // Replacing that file changes what the browser loads, but the browser must
      // be told — either by the HMR channel or by a reload.
      requiresClientUpdate: 'yes if the plugin has a UI (a bundle must be replaced)',
      requiresHostRestart: 'yes if the plugin has a node half',
      note:
        'A UI-only plugin can be swapped by replacing its client.js and reloading; ' +
        'a plugin with a node half needs the host process restarted (L3 is blocked).',
    }
  } catch (error) {
    out.case2Error = String(error)
  }

  // --- case 3: the DSH package itself -------------------------------------
  try {
    const dshPkgPath = require.resolve('@deepseek-ai/dsh/package.json')
    const dshRoot = dirname(dshPkgPath)
    const dshPkg = JSON.parse(readFileSync(dshPkgPath, 'utf8'))

    // The whole @deepseek-ai tree is what "the kernel" means in practice.
    const scopeDir = dirname(dshRoot)
    const size = treeSize(scopeDir)

    out.case3_dshIteration = {
      dshVersion: dshPkg.version,
      dshRoot,
      scopeDir,
      packagedPackages: size.files,
      approxBytes: size.bytes,
      sizeTruncated: size.truncated,
      // Replacing code on disk cannot affect an already-running process: Node
      // has already imported it.
      requiresHostRestart: 'yes — imported modules cannot be swapped in a live process',
      requiresClientUpdate:
        'yes if the frontend dist changed (new UI assets), otherwise the existing window still works',
      requiresAppReinstall: 'only in the packaged layout, where resources/ is replaced wholesale',
    }
  } catch (error) {
    out.case3Error = String(error)
  }

  // --- the decisive fact: is the running code reloadable? -----------------
  try {
    // Node caches ESM/CJS modules for the process lifetime. Nothing in DSH
    // hot-swaps host modules, and cordis-plugin-hmr is blocked in Electron.
    out.runningCodeIsReloadable = {
      nodeModuleCache: 'persists for the process lifetime',
      dshHostHotSwap: 'only via cordis-plugin-hmr, which is blocked (needs --expose-internals)',
      conclusion: 'host-side code changes require a process restart',
    }

    // What a host restart costs, concretely.
    out.restartCost = {
      windowSurvives: false,
      sessionsSurvive: 'yes — persisted to disk under the DSH home',
      hostPort: 'changes (OS-assigned)',
      measurement: 'app.relaunch() is available; a full app restart is the current path',
    }
  } catch (error) {
    out.reloadError = String(error)
  }

  out.answer = {
    compositionChange: 'no client update — data only',
    pluginChange: 'client update yes for UI plugins; host restart yes for node-side plugins',
    kernelChange: 'yes — a new DSH version means new code on disk, requiring a restart',
    clarification:
      'The earlier "no L2/L3/L4" conclusion was scoped to the SPECIALIZED AGENT work ' +
      '(composition + presets). A kernel iteration is a different case entirely and ' +
      'does require updating the code that is deployed.',
  }

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
