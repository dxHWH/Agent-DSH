/**
 * What path does the picker actually spawn?
 *
 * The anchor rewrite did not fix the failure, so the assumption behind it —
 * "rewriting the anchor changes `import.meta.url` inside the picker package" —
 * is wrong. `import.meta.url` is where the MODULE was loaded from, which the
 * anchor does not control.
 *
 * This hooks `child_process.spawn` inside a packaged-mode host and records the
 * exact argv the picker uses, so the real path is observed instead of inferred.
 *
 * Run: npx electron scripts/diagnostics/diagnose-picker-spawn.mjs
 */
import { app } from 'electron'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function finish(payload) {
  console.log('DIAG_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('DIAG_END')
  app.exit(0)
}

async function main() {
  const out = { spawns: [] }
  const require = createRequire(import.meta.url)

  // Point at the PACKAGED trees so the paths under test are the shipped ones.
  const resources = join(projectRoot, 'release', 'win-unpacked', 'resources')

  // --- what does importing the picker package report as its own location? ---
  try {
    const asarPicker = join(
      resources, 'app.asar', 'node_modules', '@deepseek-ai',
      'dsh-host-directory-picker-native', 'lib', 'index.js',
    )
    const unpackedPicker = join(
      resources, 'app.asar.unpacked', 'node_modules', '@deepseek-ai',
      'dsh-host-directory-picker-native', 'lib', 'index.js',
    )

    out.candidates = {
      asarPickerExists: existsSync(asarPicker),
      unpackedPickerExists: existsSync(unpackedPicker),
      asarWorker: asarPicker.replace(`lib${sep}index.js`, `lib${sep}worker.cjs`),
      unpackedWorker: unpackedPicker.replace(`lib${sep}index.js`, `lib${sep}worker.cjs`),
    }

    // Import each and read import.meta.url indirectly: the module's own path is
    // what `spawnDialogWorker` uses, so loading from each location shows what a
    // real host would see.
    const load = async (spec) => {
      try {
        const mod = await import(spec)
        return { ok: true, exports: Object.keys(mod).slice(0, 6) }
      } catch (error) {
        return { ok: false, error: String(error).slice(0, 200) }
      }
    }

    out.asarImport = await load(`file:///${asarPicker.replace(/\\/g, '/')}`)
    out.unpackedImport = await load(`file:///${unpackedPicker.replace(/\\/g, '/')}`)
  } catch (error) {
    out.candidateError = String(error)
  }

  // --- hook spawn and drive a real pick through the packaged picker ---------
  try {
    const { spawn } = await import('node:child_process')
    const originalSpawn = spawn
    const childProcess = await import('node:child_process')

    // Patch before loading the picker so its spawn call is captured.
    childProcess.spawn = function patched(...args) {
      out.spawns.push({ command: String(args[0]).slice(0, 120), argv: (args[1] ?? []).map((a) => String(a).slice(0, 200)) })
      return originalSpawn.apply(this, args)
    }

    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'picker-diag-'))
    const { startHost } = await import('../../dist/main/host.js')
    const host = await startHost({
      dshHome: process.env.DSH_HOME,
      profileDir: join(resources, 'desktop-profile'),
      onProgress: (m) => {
        if (/anchor|graph/.test(m)) out.hostLog = `${out.hostLog ?? ''}${m}\n`
      },
    })

    out.hostPort = host.port
    await host.dispose()
    rmSync(process.env.DSH_HOME, { recursive: true, force: true })
  } catch (error) {
    out.spawnError = String(error).slice(0, 300)
  }

  out.workerSpawns = out.spawns.filter((s) => s.argv.some((a) => a.includes('worker.cjs')))

  out.conclusion =
    out.workerSpawns.length === 0
      ? 'No picker spawn observed in this run (the picker is only spawned on an actual pick).'
      : out.workerSpawns[0].argv.some((a) => a.includes('app.asar' + sep) && !a.includes('unpacked'))
        ? 'CONFIRMED: the picker spawns the ASAR path — that is why the worker dies.'
        : 'The picker spawns the unpacked path.'

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
