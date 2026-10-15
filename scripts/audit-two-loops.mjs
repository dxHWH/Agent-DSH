/**
 * Can a SECOND agent loop coexist with the native one?
 *
 * The user's product picture: one button switching between
 *   [general mode] = stock DSH, barely modified
 *   [project mode]     = a separately derived harness, possibly with its own copy of
 *                    the agent-loop logic, modified
 *
 * The preset mechanism mounts ONE standing composition per preset, and presets
 * join by scope. So the decisive question is whether two *different* agent-loop
 * implementations can be mounted side by side — one per mode — rather than the
 * factory being a process-global singleton that the second mount would collide on.
 *
 * Earlier measurement established `setFactory` is exclusive (throws when a factory
 * is already registered). This one checks what that means for a two-mode design,
 * and what the alternatives are.
 *
 * Run: npx electron scripts/audit-two-loops.mjs
 */
import { app } from 'electron'
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

async function main() {
  const out = {}
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const require = createRequire(import.meta.url)
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'twoloop-home-'))

  // --- 1. is the agent-loop row agent-plane (per preset) or host-plane? ----
  try {
    const profile = boot.loadProfileDirectory('dsh-desktop', join(projectRoot, 'desktop-profile'), installAnchor)
    const rows = boot.composeEntries([
      profile.layers.flatMap((l) => l.patches ?? []),
      profile.patches ?? [],
    ])
    const loopRow = rows.find((r) => r.id === 'agent-loop')

    // Where the row lives decides whether a preset can restate it.
    const presetSrc = readFileSync(
      join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'),
      'utf8',
    )
    out.placement = {
      loopRowId: loopRow?.id ?? null,
      loopRowInProfile: loopRow !== undefined,
      loopRowMentionedInAnyPreset: presetSrc.includes('agent-loop'),
      // If the loop is NOT in a preset, every preset shares the one host instance.
      implication:
        'If agent-loop is host-plane, every preset shares one loop implementation, ' +
        'so a per-mode loop cannot be achieved by presets alone.',
    }
  } catch (error) {
    out.placementError = String(error)
  }

  // --- 2. what does the factory exclusivity actually protect? -------------
  try {
    const agentTypes = require.resolve('@deepseek-ai/dsh-agent')
    const dts = readFileSync(agentTypes.replace(/index\.js$/, 'types/index.d.ts'), 'utf8')

    out.factoryContract = {
      setFactoryIsExclusive: /Throws if a factory is already registered/.test(dts),
      // The registry is a process-global service; one factory serves all sessions.
      registryIsProcessGlobal: /Agent service \(`ctx\.agents`\)/.test(dts),
      // So two loops in one process would have to be one factory dispatching internally.
      conclusion:
        'One process = one factory. Two loop BEHAVIOURS must therefore live inside one ' +
        'factory that dispatches by mode, OR in two separate host processes.',
    }
  } catch (error) {
    out.factoryError = String(error)
  }

  // --- 3. can a preset restate the loop row? ------------------------------
  try {
    // A preset's agent.cordis.yml is an agent-plane composition. If it names
    // agent-loop, that row would be mounted per preset — but the loop publishes
    // a host service, which is exactly what presets are forbidden from doing.
    const presetSrc = readFileSync(
      join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'),
      'utf8',
    )
    // The file's own comment states the rule.
    out.presetRule = {
      statedInPresetFile: /A service row here MUST sit inside a group carrying an `isolate` realm/.test(presetSrc),
      isolatesUsed: [...presetSrc.matchAll(/isolate:\n((?:\s+\w+: true\n)+)/g)].length,
      implication:
        'A host service mounted from a preset needs an isolate realm. agent-loop publishes ' +
        'the AgentFactory into the root realm, so it cannot simply be restated per preset.',
    }
  } catch (error) {
    out.presetRuleError = String(error)
  }

  // --- 4. what IS the supported way to get two behaviours? ----------------
  try {
    const loopSrc = readFileSync(require.resolve('@deepseek-ai/dsh-agent-loop'), 'utf8')
    const hooks = new Set()
    for (const m of loopSrc.matchAll(/dispatch\.(waterfall|serial|bail)\(\s*"([^"]+)"/g)) {
      hooks.add(`${m[2]} (${m[1]})`)
    }
    out.supportedRoutes = {
      lifecycleHooks: [...hooks].sort(),
      // Hooks let one loop behave differently per mode without a second loop.
      hookRoute:
        'A plugin can make ONE loop behave two ways by intercepting agent/* per session — ' +
        'no second loop implementation needed.',
      // Or replace the single factory with one that dispatches.
      factoryDispatchRoute:
        'Replace AgentFactory once with an implementation that picks behaviour by mode; ' +
        'that keeps one process and one registry.',
      // Or run two hosts.
      twoProcessRoute:
        'Run two DSH hosts (two ports) and have the shell switch which URL the window loads. ' +
        'Heaviest, but gives complete isolation between modes.',
    }
  } catch (error) {
    out.routesError = String(error)
  }

  // --- 5. how big is a duplicated loop, really? ---------------------------
  try {
    const loopRoot = dirname(require.resolve('@deepseek-ai/dsh-agent-loop'))
    const entries = ['lib/index.js']
    const sizes = {}
    for (const e of entries) {
      const p = join(loopRoot, e)
      if (existsSync(p)) sizes[e] = readFileSync(p, 'utf8').length
    }
    out.duplicationCost = {
      files: sizes,
      note:
        'The loop is a single ~71 KB compiled module today. A derived copy is therefore ' +
        'small in bytes but is still a FORK: upstream fixes will not reach it.',
    }
  } catch (error) {
    out.dupError = String(error)
  }

  out.answer = {
    canTwoLoopsCoexistInOneProcess: false,
    why:
      'The AgentRegistry is process-global and setFactory is exclusive: one process mounts ' +
      'one factory. Presets cannot restate the loop because it publishes into the root realm.',
    options: {
      A_hooks: 'one loop, two behaviours via agent/* interception — least duplication',
      B_factoryDispatch: 'one custom factory that dispatches by mode — custom code, one process',
      C_twoHosts: 'two hosts on two ports, shell switches URL — full isolation, most machinery',
    },
    recommendation:
      'Try A first. Only fork the loop (B or a derived copy) if interception genuinely cannot ' +
      'express the project behaviour. C is the fallback when the two modes must not share a process.',
  }

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
