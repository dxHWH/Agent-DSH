/**
 * Does spawn work on an asar-internal path inside a real Electron main process?
 *
 * The picker runs in the Electron MAIN process (not RUN_AS_NODE), where the asar
 * filesystem shim is active. Testing under `ELECTRON_RUN_AS_NODE` disables that
 * shim and gives misleading answers, so this runs a real main process and tries
 * both paths.
 *
 * Run: npx electron scripts/diagnostics/test-asar-spawn.mjs
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function finish(payload) {
  console.log('TEST_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('TEST_END')
  app.exit(0)
}

/** Run a node script and report the first line of output or the failure. */
function tryRun(scriptPath, env, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill()
        resolve({ outcome: 'timeout', out: out.slice(0, 120), err: err.slice(0, 200) })
      }
    }, timeoutMs)

    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ outcome: `exit ${code}`, out: out.slice(0, 160), err: err.slice(0, 300) })
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ outcome: 'spawn error', err: String(error).slice(0, 200) })
    })
  })
}

async function main() {
  const out = {}
  const resources = join(projectRoot, 'release', 'win-unpacked', 'resources')
  const rel = join('node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'worker.cjs')

  const asarWorker = join(resources, 'app.asar', rel)
  const unpackedWorker = join(resources, 'app.asar.unpacked', rel)

  out.paths = {
    asarWorker,
    unpackedWorker,
    // Run WITHOUT ELECTRON_RUN_AS_NODE so the asar shim stays active.
    asarExists: existsSync(asarWorker),
    unpackedExists: existsSync(unpackedWorker),
  }

  // The worker asserts on a missing title, so supply one; it then tries to show
  // a dialog on an IPC-less stdio, which is fine — what matters is whether node
  // can LOAD the file at all.
  const env = { DSH_DIALOG_TITLE: 'probe' }

  out.spawnAsarPath = await tryRun(asarWorker, env)
  out.spawnUnpackedPath = await tryRun(unpackedWorker, env)

  out.verdict = {
    asarSpawnWorks: out.spawnAsarPath.outcome.startsWith('exit') && !/Cannot find module/.test(out.spawnAsarPath.err),
    unpackedSpawnWorks:
      out.spawnUnpackedPath.outcome.startsWith('exit') && !/Cannot find module/.test(out.spawnUnpackedPath.err),
  }
  out.conclusion = out.verdict.asarSpawnWorks
    ? 'spawn CAN load the asar path — the failure lies elsewhere'
    : 'spawn CANNOT load the asar path — rewriting to the unpacked path is required'

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
