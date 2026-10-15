/**
 * Reproduce the directory-picker failure.
 *
 * The UI reports:
 *   directory picker failed: win32 folder dialog worker exited before reporting a result
 *
 * That message comes from the worker's `exit` handler, meaning the child died
 * WITHOUT sending a `done` or `error` message. Running the worker standalone
 * cannot reproduce it (it asserts on the missing IPC channel), so this forks it
 * exactly as the picker does and captures whatever it prints.
 *
 * Usage:
 *   node scripts/diagnostics/repro-directory-picker.mjs                 # source tree
 *   node scripts/diagnostics/repro-directory-picker.mjs --packaged      # packaged tree
 */
import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const packaged = process.argv.includes('--packaged')

const worker = packaged
  ? join(
      projectRoot, 'release', 'win-unpacked', 'resources', 'app.asar.unpacked',
      'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'worker.cjs',
    )
  : join(
      projectRoot, 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'worker.cjs',
    )

console.log(`mode: ${packaged ? 'packaged' : 'source'}`)
console.log(`worker: ${worker}`)
console.log(`exists: ${existsSync(worker)}`)

// The worker requires these; the picker supplies them at spawn time.
const env = {
  ...process.env,
  DSH_DIALOG_TITLE: 'Select a workspace',
  DSH_DIALOG_INITIAL_DIR: projectRoot,
}

const child = fork(worker, [], {
  env,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})

let sawResult = false

child.stdout?.on('data', (d) => process.stdout.write(`[stdout] ${d}`))
child.stderr?.on('data', (d) => process.stderr.write(`[stderr] ${d}`))

child.on('message', (message) => {
  sawResult = true
  console.log(`[message] ${JSON.stringify(message)}`)
  // Close the dialog the moment it reports showing.
  if (message && message.kind === 'showing') {
    console.log('[test] dialog is showing; sending close')
    child.send({ kind: 'close' })
  }
})

child.on('error', (error) => {
  console.log(`[error] ${error.message}`)
})

child.on('exit', (code, signal) => {
  console.log(`[exit] code=${code} signal=${signal} sawResult=${sawResult}`)
  if (!sawResult) {
    console.log('')
    console.log('=> REPRODUCED: the worker exited without reporting a result.')
    console.log('   This is the failure the UI surfaces.')
  }
  process.exit(0)
})

// Give the dialog time to appear, then close it so the test does not hang.
setTimeout(() => {
  console.log('[test] timeout reached; killing worker')
  child.kill()
}, 8000)
