/**
 * Drive a real pick through the PACKAGED picker and capture the worker path.
 *
 * Earlier attempts to hook `child_process.spawn` failed (ESM namespaces are
 * read-only). This instead calls the picker's public entry directly and lets it
 * spawn for real — the child's failure or success, plus whatever it prints,
 * reveals the path it used.
 *
 * Run: npx electron scripts/diagnostics/trigger-packaged-pick.mjs
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function finish(payload) {
  console.log('PICK_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('PICK_END')
  app.exit(0)
}

async function main() {
  const out = {}
  const resources = join(projectRoot, 'release', 'win-unpacked', 'resources')

  const asarIndex = join(
    resources, 'app.asar', 'node_modules', '@deepseek-ai',
    'dsh-host-directory-picker-native', 'lib', 'index.js',
  )
  const unpackedIndex = join(
    resources, 'app.asar.unpacked', 'node_modules', '@deepseek-ai',
    'dsh-host-directory-picker-native', 'lib', 'index.js',
  )

  /*
   * Importing through the ASAR path is what a packaged host does, because that
   * is the specifier its module graph resolves. The module then computes its own
   * `import.meta.url` from that location, so the worker path it spawns follows.
   *
   * Only one import can win per process (Node caches by resolved URL), so this
   * run tests the ASAR side — the one that fails — and reports what happens.
   */
  const target = existsSync(asarIndex) ? asarIndex : unpackedIndex
  out.importedFrom = target
  out.importedFromAsar = target.includes(`app.asar${sep}`) && !target.includes('unpacked')

  const controller = new AbortController()

  try {
    const mod = await import(pathToFileURL(target).href)
    const pick = mod.pickNativeDirectory ?? mod.default?.pick ?? mod.default

    out.exportShape = {
      pickNativeDirectory: typeof mod.pickNativeDirectory,
      defaultType: typeof mod.default,
    }

    if (typeof pick !== 'function') {
      out.error = 'no callable pick export found'
      finish(out)
      return
    }

    // The pick blocks until a human answers, so abort quickly: what matters is
    // whether the child starts at all, reported before the abort.
    setTimeout(() => {
      out.abortedAfterMs = 3000
      controller.abort()
    }, 3000)

    const result = await pick(controller.signal)
    out.result = result
    out.verdict = 'pick returned normally'
  } catch (error) {
    out.error = String(error).slice(0, 300)
    // The picker's own message names the failure mode.
    out.verdict = /worker exited before reporting/.test(String(error))
      ? 'REPRODUCED in-process: the worker exited without reporting'
      : 'pick threw a different error'
  }

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
