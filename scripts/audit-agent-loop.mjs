/**
 * Agent-loop extensibility audit.
 *
 * The question: can the internal agent loop be modified?
 *
 * There are three plausible answers and they have very different consequences:
 *   1. Intercept it from outside via the `agent/*` lifecycle hooks.
 *   2. Configure it (parallelism, agents, model routes).
 *   3. Replace the whole `AgentFactory` with a custom driver.
 *
 * This script measures which of those are actually available, rather than
 * assuming the README's "choose a custom Agent implementation" sentence implies
 * an easy swap.
 *
 * Run: npx electron scripts/audit-agent-loop.mjs
 */
import { app } from 'electron'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function finish(payload) {
  console.log('AUDIT_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('AUDIT_END')
  app.exit(0)
}

async function main() {
  const out = { hooks: {}, factory: {}, composition: {} }
  const require = createRequire(import.meta.url)

  // --- 1. which lifecycle hooks the loop actually dispatches ---------------
  try {
    const loopPath = require.resolve('@deepseek-ai/dsh-agent-loop')
    const source = readFileSync(loopPath, 'utf8')

    // The loop drives extensions through three dispatch shapes:
    //   waterfall — listeners may rewrite the value, chain continues
    //   serial    — listeners notified in order
    //   bail      — first listener returning a value wins
    const collect = (shape) => {
      const re = new RegExp(`dispatch\\.${shape}\\(\\s*"([^"]+)"`, 'g')
      const found = new Set()
      let m
      while ((m = re.exec(source)) !== null) found.add(m[1])
      return [...found].sort()
    }

    out.hooks.waterfall = collect('waterfall')
    out.hooks.serial = collect('serial')
    out.hooks.bail = collect('bail')
    out.hooks.all = [...new Set([...out.hooks.waterfall, ...out.hooks.serial, ...out.hooks.bail])].sort()
    out.hooks.count = out.hooks.all.length

    // The factory registration is the replacement seam.
    out.factory.registersItself = source.includes('setFactory')
    out.factory.setFactoryCall = /ctx\.agents\.setFactory\(/.test(source)
  } catch (error) {
    out.hooks.error = String(error)
  }

  // --- 2. is setFactory exclusive? ----------------------------------------
  try {
    const agentPath = require.resolve('@deepseek-ai/dsh-agent')
    const agentSource = readFileSync(agentPath, 'utf8')
    // The docstring is the contract; look for the exclusivity statement.
    out.factory.throwsIfAlreadyRegistered = /already registered/i.test(agentSource)
    const m = /Throws if a factory is already registered/.exec(agentSource)
    out.factory.exclusivityDocFound = m !== null
  } catch (error) {
    out.factory.error = String(error)
  }

  // --- 3. how the loop is composed in this profile ------------------------
  try {
    const boot = await import('@deepseek-ai/dsh-app-boot')
    const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
    const profile = boot.loadProfileDirectory('dsh-desktop', join(projectRoot, 'desktop-profile'), installAnchor)
    const rows = boot.composeEntries([
      profile.layers.flatMap((l) => l.patches ?? []),
      profile.patches ?? [],
    ])

    const loopRows = rows
      .filter((r) => (r.name ?? '').includes('agent-loop') || (r.id ?? '') === 'agent-loop' || (r.id ?? '') === 'agent')
      .map((r) => ({ id: r.id, name: r.name, disabled: r.disabled === true }))

    out.composition.loopRows = loopRows
    out.composition.agentLoopRowName = rows.find((r) => r.id === 'agent')?.name ?? null
    out.composition.canBeDisabledByPatch = loopRows.length > 0
  } catch (error) {
    out.composition.error = String(error)
  }

  // --- 4. is a custom AgentFactory a real public contract? ----------------
  try {
    const agentTypes = require.resolve('@deepseek-ai/dsh-agent')
    const dts = readFileSync(agentTypes.replace(/index\.js$/, 'types/index.d.ts'), 'utf8')
    out.factory.publicInterface = /export interface AgentFactory/.test(dts)
    out.factory.registryExposesSetFactory = /setFactory\(factory: AgentFactory\)/.test(dts)
    // Whether the registry docstring frames the loop as *the* implementation.
    out.factory.framedAsSwappable = /provides to the registry/i.test(dts)
  } catch (error) {
    out.factory.typeError = String(error)
  }

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
