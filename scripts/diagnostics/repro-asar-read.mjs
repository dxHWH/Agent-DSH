/**
 * Minimal reproduction: can `node:fs` read an asar entry marked `unpacked`?
 *
 * This is the decisive test for the packaged plugin-load failure. Everything so
 * far is circumstantial: the anchor resolves inside app.asar, DSH reads bundles
 * with `node:fs`, and the asar record carries `"unpacked": true`. The remaining
 * question is whether that read actually fails — and that can only be answered
 * by trying it.
 *
 * Run inside the PACKAGED app so the asar is real:
 *   release\win-unpacked\DSH Desktop.exe --inspect ...   (not practical)
 *
 * Instead this runs under the dev Electron binary but points at the packaged
 * asar, which is the same archive the installed app reads.
 *
 * Run: npx electron scripts/diagnostics/repro-asar-read.mjs
 */
import { app } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function finish(payload) {
  console.log('REPRO_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('REPRO_END')
  app.exit(0)
}

async function main() {
  const out = { cases: [] }
  const resources = join(projectRoot, 'release', 'win-unpacked', 'resources')
  const asarPath = join(resources, 'app.asar')
  const unpackedPath = join(resources, 'app.asar.unpacked')

  const rel = 'node_modules/@deepseek-ai/dsh-client-modules/lib/client.js'
  const insideAsar = join(asarPath, rel)
  const insideUnpacked = join(unpackedPath, rel)

  out.layout = {
    asarPath,
    unpackedExists: existsSync(unpackedPath),
    asarExists: existsSync(asarPath),
  }

  /** Try one read and record what actually happens. */
  const attempt = (label, p) => {
    const rec = { label, path: p.replace(resources, '<resources>') }
    try {
      rec.existsSync = existsSync(p)
      const st = statSync(p)
      rec.statSize = st.size
      const buf = readFileSync(p)
      rec.readBytes = buf.length
      // Distinguish real content from an empty placeholder.
      rec.firstBytes = buf.subarray(0, 24).toString('utf8').replace(/\n/g, '\\n')
      rec.verdict = buf.length > 0 ? 'READ OK' : 'EMPTY (placeholder)'
    } catch (error) {
      rec.error = `${error.code}: ${error.message}`
      rec.verdict = 'THREW'
    }
    out.cases.push(rec)
    return rec
  }

  // Case 1: the path DSH actually computes in the packaged app.
  attempt('asar path (what the packaged anchor produces)', insideAsar)

  // Case 2: the real on-disk copy, for comparison.
  attempt('unpacked path (the real file)', insideUnpacked)

  // Case 3: the dsh package.json the anchor itself resolves to.
  attempt('asar package.json (anchor target)', join(asarPath, 'node_modules/@deepseek-ai/dsh/package.json'))

  out.summary = {
    asarReadWorked: out.cases[0]?.verdict === 'READ OK',
    unpackedReadWorked: out.cases[1]?.verdict === 'READ OK',
    sameSize: out.cases[0]?.readBytes === out.cases[1]?.readBytes,
  }

  out.conclusion = out.summary.asarReadWorked
    ? 'Electron DOES redirect asar reads to the unpacked copy — the asar path is not the failure cause, and the fix must be sought elsewhere.'
    : 'Electron does NOT satisfy this read from the asar path — rewriting the anchor to app.asar.unpacked is the correct fix.'

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
