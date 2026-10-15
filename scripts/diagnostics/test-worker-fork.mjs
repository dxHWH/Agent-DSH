/**
 * Fork the worker the way the picker does, from a REAL Electron main process.
 *
 * The previous test used `spawn` over stdio, which fails the worker's IPC assert
 * before it does anything — so it proved loading works but said nothing about the
 * dialog. `fork` provides the IPC channel the worker requires, which is the
 * actual call shape.
 *
 * Run: npx electron scripts/diagnostics/test-worker-fork.mjs
 */
import { app } from 'electron'
import { fork } from 'node:child_process'
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

/** Fork one worker and report what it says. */
function tryFork(workerPath, label) {
  return new Promise((resolve) => {
    const record = { label, workerPath }
    let child
    try {
      child = fork(workerPath, [], {
        env: { ...process.env, DSH_DIALOG_TITLE: 'fork probe', DSH_DIALOG_INITIAL_DIR: projectRoot },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
    } catch (error) {
      record.forkThrew = String(error).slice(0, 200)
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

    child.stdout?.on('data', (d) => (record.stdout = `${record.stdout ?? ''}${d}`.slice(0, 200)))
    child.stderr?.on('data', (d) => (record.stderr = `${record.stderr ?? ''}${d}`.slice(0, 300)))

    child.on('message', (message) => {
      record.firstMessage = message
      // Close the dialog as soon as it reports showing, so the test ends.
      if (message && message.kind === 'showing') {
        record.sawShowing = true
        try {
          child.send({ kind: 'close' })
        } catch {
          /* channel may already be gone */
        }
      }
      if (message && (message.kind === 'done' || message.kind === 'error')) {
        done({ sawResult: true })
      }
    })
    child.on('error', (error) => done({ processError: String(error).slice(0, 200) }))
    child.on('exit', (code, signal) => done({ exitCode: code, exitSignal: signal, sawResult: false }))

    const timer = setTimeout(() => done({ timedOut: true }), 8000)
  })
}

async function main() {
  const out = {}
  const resources = join(projectRoot, 'release', 'win-unpacked', 'resources')
  const rel = join('node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'worker.cjs')

  const asarWorker = join(resources, 'app.asar', rel)
  const unpackedWorker = join(resources, 'app.asar.unpacked', rel)
  out.exists = { asar: existsSync(asarWorker), unpacked: existsSync(unpackedWorker) }

  out.asarFork = await tryFork(asarWorker, 'asar')
  out.unpackedFork = await tryFork(unpackedWorker, 'unpacked')

  out.verdict = {
    asarWorkerUsable: out.asarFork.sawShowing === true,
    unpackedWorkerUsable: out.unpackedFork.sawShowing === true,
  }
  out.conclusion =
    out.verdict.asarWorkerUsable && out.verdict.unpackedWorkerUsable
      ? 'BOTH paths work from a real Electron main process — the packaged failure has another cause.'
      : out.verdict.unpackedWorkerUsable
        ? 'Only the UNPACKED path works — the picker must be pointed at it.'
        : 'Neither path works here; the failure reproduces in this environment.'

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
