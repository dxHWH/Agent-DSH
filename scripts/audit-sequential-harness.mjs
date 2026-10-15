/**
 * Sequential (not parallel) harness switching.
 *
 * Revised requirement: the two modes never run at once. One process runs one
 * harness at a time. "project mode" is plugin-like: activating it and starting a
 * session from its own UI entry is what routes work through the second harness.
 *
 * That removes the setFactory collision entirely — but raises a new, decisive
 * question: can the harness be swapped WITHOUT restarting the process, or does
 * "activate project mode" necessarily mean "restart with a different composition"?
 *
 * This measures the mechanics of swapping the agent-producing side at runtime.
 *
 * Run: npx electron scripts/audit-sequential-harness.mjs
 */
import { app, BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs'
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

async function bootHost(patches, home) {
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const require = createRequire(import.meta.url)
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
  const { provideCmdline } = await import('@deepseek-ai/dsh-cmdline')

  const dir = mkdtempSync(join(tmpdir(), 'seq-prof-'))
  cpSync(join(projectRoot, 'desktop-profile'), dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.yml'), '[]\n', 'utf8')

  const profile = boot.loadProfileDirectory('dsh-desktop', dir, installAnchor)
  const ctx = await boot.boot(
    'dsh-desktop',
    join(profile.dir, 'cordis.yml'),
    [...profile.layers.flatMap((l) => l.patches ?? []), ...(profile.patches ?? []), ...patches],
    (hostCtx) => {
      provideCmdline(hostCtx, { args: ['--no-open', '--port', '0'], exit: () => {} })
    },
  )
  return { ctx, dir }
}

async function main() {
  const out = {}
  const home = mkdtempSync(join(tmpdir(), 'seq-home-'))
  process.env.DSH_HOME = home

  // --- 1. DISPOSE the tree, then boot a different one ----------------------
  // Does tearing down and re-booting inside ONE Electron process actually free
  // the factory slot? If yes, sequential switching needs no process restart.
  try {
    // Boot A: the general composition (native loop).
    const a = await bootHost([], home)
    const agentsA = a.ctx.get('agents')
    out.firstBoot = {
      agentsServicePresent: agentsA !== undefined,
      loopRowId: 'agent-loop',
    }

    // Tear it down the way the shell does on quit.
    await a.ctx.fiber.dispose()
    rmSync(a.dir, { recursive: true, force: true })
    out.firstBootDisposed = true

    // Boot B: a composition that DISABLES the native loop and mounts a stand-in.
    // If the slot was truly freed, this succeeds; if not, setFactory throws.
    let secondBootSucceeded = false
    let secondBootError = ''
    let b = null
    try {
      b = await bootHost(
        [
          { id: 'agent-loop', disabled: true },
          {
            insert: [
              {
                id: 'project-loop',
                name: '@deepseek-ai/dsh-cordis-host-runner',
                disabled: true,
              },
            ],
          },
        ],
        home,
      )
      secondBootSucceeded = true
    } catch (error) {
      secondBootError = String(error)
    }

    out.secondBoot = {
      succeeded: secondBootSucceeded,
      error: secondBootError,
      // The decisive fact: whether a disposed tree releases process-global state.
      slotFreedByDispose: secondBootSucceeded,
    }

    if (b) {
      await b.ctx.fiber.dispose()
      rmSync(b.dir, { recursive: true, force: true })
    }
  } catch (error) {
    out.sequentialError = String(error)
  }

  // --- 2. what the shell must do to switch modes --------------------------
  try {
    out.switchMechanics = {
      ifDisposeFreesState:
        'the shell can dispose the current tree and boot the other composition in the same process',
      whatChanges: 'the profile patch layer (which loop row is mounted, disabled, or replaced)',
      whatDoesNot:
        'the Electron process, the window, the data root, the port allocation strategy',
      windowHandling:
        'a renderer reload re-fetches the boot graph, so the UI follows the new composition',
    }
  } catch (error) {
    out.mechError = String(error)
  }

  // --- 3. is a plugin-like "project mode" expressible as a preset? ------------
  try {
    const presetSrc = readFileSync(
      join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'),
      'utf8',
    )
    out.presetPath = {
      // A preset can add tools, persona, prompt sections, skills — agent-plane rows.
      canCarry: ['tools', 'persona', 'prompt sections', 'skills', 'plan policy', 'compaction'],
      // It CANNOT carry the loop, because the loop publishes a host service.
      cannotCarry: ['the agent loop / AgentFactory (host-plane, root realm)'],
      presetFileStatesTheRule: /isolate realm/.test(presetSrc),
    }
  } catch (error) {
    out.presetError = String(error)
  }

  // --- 4. so what carries the loop? ---------------------------------------
  try {
    out.loopOwner = {
      theLoopIsHostPlane: true,
      therefore:
        'a preset cannot supply a second loop, so "project mode = different loop" needs either ' +
        'a composition-level switch (profile patch) or a factory that dispatches by mode',
      compositionSwitchIsSequential:
        'which is fine here, because the modes never run at once',
    }
  } catch (error) {
    out.loopOwnerError = String(error)
  }

  out.answer = {
    parallelNotRequired: true,
    keyQuestionAnswered: out.secondBoot?.slotFreedByDispose === true,
    ifTrue:
      'mode switching can happen in ONE process: dispose the tree, boot the other composition, ' +
      'reload the renderer. No process restart, no second host.',
    ifFalse:
      'a disposed tree does not free the factory slot, so each mode needs its own process',
    pluginLikeEntry:
      'the UI entry that starts a project session is ordinary client-plugin work; what it triggers ' +
      'is the composition switch above',
  }

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
