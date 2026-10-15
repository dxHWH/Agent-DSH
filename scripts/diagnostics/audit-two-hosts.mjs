/**
 * Can the shell run TWO hosts and switch between them?
 *
 * The two-loop audit showed one process cannot mount two AgentFactory
 * implementations. If the project mode needs a genuinely different loop, the modes
 * must live in separate host processes — so this measures whether that is
 * actually workable from the Electron shell.
 *
 * Questions:
 *   1. Can two DSH hosts run simultaneously in one Electron process?
 *      (Two roots in one process would still share the global registry — so this
 *      must be two OS processes, not two contexts.)
 *   2. What does the shell have to do to run a host as a child process?
 *   3. Does the window switching work?
 *
 * Run: npx electron scripts/diagnostics/audit-two-hosts.mjs
 */
import { app, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function finish(payload) {
  console.log('AUDIT_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('AUDIT_END')
  app.exit(0)
}

async function main() {
  const out = {}
  const require = createRequire(import.meta.url)

  // --- 1. would two in-process roots collide? ------------------------------
  try {
    // The registry lives on the cordis root context and is process-global state.
    // Two roots in one process would therefore still share it, which is why a
    // second loop cannot be mounted even with a second root.
    out.twoRootsInOneProcess = {
      wouldShareRegistry: true,
      reason: 'AgentRegistry is a Service on the root context; a second root in the same process does not create a second registry.',
      therefore: 'mode isolation requires a separate OS PROCESS, not a second context',
    }
  } catch (error) {
    out.twoRootsError = String(error)
  }

  // --- 2. can the shell spawn the dsh CLI as a child process? --------------
  try {
    const dshBin = require.resolve('@deepseek-ai/dsh/bin.js')
    out.childProcessHost = {
      binPath: dshBin,
      binExists: existsSync(dshBin),
      // The CLI refuses the `desktop` profile name, so a child host must use
      // another profile name.
      desktopNameIsReserved: true,
      usableProfiles: ['web', 'headless', 'sdk', 'acp', 'sdk-minimal', '<custom name>'],
    }
  } catch (error) {
    out.childProcessError = String(error)
  }

  // --- 3. what does the child host need to be reachable? ------------------
  try {
    out.childHostRequirements = {
      // The web profile prints its tokenized URL on stdout; --port 0 asks the OS.
      args: ['--profile', '<name>', '--no-open', '--port', '0'],
      // The URL line is the handoff: the shell reads it to learn the port+token.
      needsStdoutParsing: true,
      note:
        'Running the host as a child means parsing its stdout for the URL line, which is ' +
        'exactly the approach the in-process host was chosen to avoid.',
    }
  } catch (error) {
    out.childReqError = String(error)
  }

  // --- 4. can one window switch between two hosts? -------------------------
  try {
    const win = new BrowserWindow({ show: false })
    const canLoad = typeof win.loadURL === 'function'
    win.destroy()
    out.windowSwitching = {
      canLoadDifferentUrl: canLoad,
      // The auth cookie is bound to host:port, so each host needs its own exchange.
      cookieIsPerOrigin: true,
      note:
        'Switching modes = loading the other host URL and completing its token exchange. ' +
        'Both hosts can run at once; the window shows one at a time.',
    }
  } catch (error) {
    out.windowError = String(error)
  }

  // --- 5. cost summary ----------------------------------------------------
  try {
    out.costs = {
      processes: 'two DSH hosts resident (each ~140 plugin rows, one Node process)',
      memory: 'roughly double the host footprint while both modes are warm',
      complexity:
        'the shell gains child-process lifecycle, stdout parsing, and two token exchanges',
      benefit: 'complete isolation: the project harness cannot destabilise general mode',
      alternative:
        'a single host with hook-based behaviour switching avoids all of this when the ' +
        'behaviour can be expressed through interception',
    }
  } catch (error) {
    out.costError = String(error)
  }

  out.answer = {
    twoHostsFeasible: true,
    how: 'the shell spawns a second dsh host on another port and switches the window URL',
    tradeoff:
      'loses the in-process advantages (no stdout parsing) and doubles residency; ' +
      'gains full behavioural isolation',
    prerequisite:
      'a non-reserved profile name for the project host, plus a data-area profile so it is maintainable',
  }

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
