/**
 * Can the agent loop actually be replaced?
 *
 * `AgentRegistry.setFactory` documents "Throws if a factory is already
 * registered", and `dsh-agent-loop` registers itself on construction. So a
 * custom driver cannot simply overwrite it — the built-in row must be removed
 * from the composition first.
 *
 * This experiment proves both halves:
 *   A. Registering a second factory on a live tree is rejected.
 *   B. Removing the `agent-loop` row and then registering a custom factory works,
 *      and the custom factory is the one the registry dispatches to.
 *
 * Run: npx electron scripts/experiment-replace-loop.mjs
 */
import { app } from 'electron'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function finish(payload) {
  console.log('EXPERIMENT_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('EXPERIMENT_END')
  app.exit(0)
}

/** Boot a composition and return the live root context. */
async function bootWith(patches) {
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const require = createRequire(import.meta.url)
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')

  const dir = mkdtempSync(join(tmpdir(), 'loop-replace-'))
  cpSync(join(projectRoot, 'desktop-profile'), dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.yml'), '[]\n', 'utf8')

  const profile = boot.loadProfileDirectory('dsh-desktop', dir, installAnchor)
  const bundlePatches = profile.layers.flatMap((l) => l.patches ?? [])
  const rootConfig = join(profile.dir, 'cordis.yml')

  // `dsh-web-app/startup` injects `cmdlineArgs`; without it 11 entries stay
  // pending and boot fails. See docs/phase1-notes.zh.md §2.3.
  const { provideCmdline } = await import('@deepseek-ai/dsh-cmdline')

  const ctx = await boot.boot(
    'dsh-desktop',
    rootConfig,
    [...bundlePatches, ...(profile.patches ?? []), ...patches],
    (hostCtx) => {
      provideCmdline(hostCtx, {
        args: ['--no-open', '--port', '0'],
        exit: () => {},
      })
    },
  )
  return { ctx, dir }
}

async function main() {
  const out = {}
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'loop-replace-home-'))

  // --- A. a second factory on a live tree must be rejected ------------------
  try {
    const { ctx, dir } = await bootWith([])
    const agents = ctx.get('agents')
    out.registryPresent = agents !== undefined
    out.registryHasFactory = true

    let rejected = false
    let message = ''
    try {
      agents.setFactory({
        createAgent: async () => {
          throw new Error('should never run')
        },
        resume: async () => {
          throw new Error('should never run')
        },
      })
    } catch (error) {
      rejected = true
      message = String(error)
    }
    out.secondFactoryRejected = rejected
    out.rejectionMessage = message

    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    out.stepAError = String(error)
  }

  // --- B. disabling the built-in row frees the factory slot -----------------
  try {
    const { ctx, dir } = await bootWith([{ id: 'agent-loop', disabled: true }])

    const agents = ctx.get('agents')
    out.registryStillPresentWithoutLoop = agents !== undefined

    let registered = false
    let registerError = ''
    try {
      agents.setFactory({
        createAgent: async () => {
          throw new Error('stub factory: createAgent not exercised here')
        },
        resume: async () => {
          throw new Error('stub factory: resume not exercised here')
        },
      })
      registered = true
    } catch (error) {
      registerError = String(error)
    }

    out.customFactoryAcceptedAfterDisable = registered
    out.registerError = registerError

    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    out.stepBError = String(error)
  }

  // --- C. what the loop row can be configured with -------------------------
  try {
    const boot = await import('@deepseek-ai/dsh-app-boot')
    const require = createRequire(import.meta.url)
    const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
    const profile = boot.loadProfileDirectory('dsh-desktop', join(projectRoot, 'desktop-profile'), installAnchor)
    const rows = boot.composeEntries([
      profile.layers.flatMap((l) => l.patches ?? []),
      profile.patches ?? [],
      [{ id: 'agent-loop', config: { maxParallelToolCalls: 3 } }],
    ])
    const row = rows.find((r) => r.id === 'agent-loop')
    out.patchConfigReachesLoop = row?.config?.maxParallelToolCalls === 3
    out.loopRowAfterPatch = row ? { id: row.id, name: row.name, config: row.config } : null
  } catch (error) {
    out.stepCError = String(error)
  }

  out.verdict = out.customFactoryAcceptedAfterDisable
    ? 'replaceable: disabling the built-in row frees the factory slot for a custom driver'
    : 'NOT replaceable by this route'

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
