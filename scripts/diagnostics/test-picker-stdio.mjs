/**
 * Does the picker's EXACT spawn configuration fail in a GUI Electron process?
 *
 * The picker spawns the worker with:
 *   stdio: ['ignore', 'inherit', 'inherit', 'ipc']
 *   windowsHide: true
 *
 * Earlier tests used `pipe`/`fork`, which worked. A packaged Windows GUI app has
 * no attached console, so `inherit` for stdout/stderr can fail at spawn — and
 * that is exactly the difference between my working tests and the failing app.
 *
 * Run: npx electron scripts/diagnostics/test-picker-stdio.mjs
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function finish(payload) {
  console.log('TEST_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('TEST_END')
  app.exit(0)
}

/** Spawn with one stdio configuration and report what happens. */
function tryStdio(workerPath, stdio, label) {
  return new Promise((resolve) => {
    const record = { label, stdio: stdio.map((s) => (typeof s === 'string' ? s : 'stream')) }
    let child
    try {
      child = spawn(process.execPath, [workerPath], {
        env: { ...process.env, DSH_DIALOG_TITLE: 'stdio probe' },
        stdio,
        windowsHide: true,
      })
    } catch (error) {
      record.spawnThrew = String(error).slice(0, 200)
      resolve(record)
      return
    }

    let settled = false
    const done = (extra) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      Object.assign(record, extra)
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      resolve(record)
    }

    child.on('message', (message) => {
      record.firstMessage = message
      if (message && message.kind === 'showing') {
        record.sawShowing = true
        try {
          child.send({ kind: 'close' })
        } catch {
          /* channel gone */
        }
      }
      if (message && (message.kind === 'done' || message.kind === 'error')) done({ sawResult: true })
    })
    child.on('error', (error) => done({ processError: String(error).slice(0, 200) }))
    child.on('exit', (code, signal) => done({ exitCode: code, exitSignal: signal, sawResult: false }))

    const timer = setTimeout(() => done({ timedOut: true }), 7000)
  })
}

async function main() {
  const out = {}
  const resources = join(projectRoot, 'release', 'win-unpacked', 'resources')
  const rel = join('node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'worker.cjs')
  const worker = join(resources, 'app.asar', rel)

  out.workerExists = existsSync(worker)
  out.workerPath = worker

  // 1. The picker's actual configuration.
  out.pickerStdio = await tryStdio(worker, ['ignore', 'inherit', 'inherit', 'ipc'], 'picker-exact')

  // 2. Same but with piped stdio, to isolate whether `inherit` is the culprit.
  out.pipedStdio = await tryStdio(worker, ['ignore', 'pipe', 'pipe', 'ipc'], 'pipe')

  // 3. And with inherited stdio but windowsHide disabled.
  out.noHide = await tryStdio(worker, ['ignore', 'inherit', 'inherit', 'ipc'], 'picker-exact-no-hide')

  out.verdict = {
    exactConfigWorks: out.pickerStdio?.sawShowing === true,
    pipedConfigWorks: out.pipedStdio?.sawShowing === true,
    inheritIsTheDifference:
      out.pickerStdio?.sawShowing !== true && out.pipedStdio?.sawShowing === true,
  }

  out.conclusion = out.verdict.inheritIsTheDifference
    ? 'CONFIRMED: inherited stdio is what breaks the spawn — piping works.'
    : out.verdict.exactConfigWorks
      ? 'The exact picker configuration works here; the packaged difference lies elsewhere.'
      : 'Neither configuration works in this environment.'

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
