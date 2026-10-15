/**
 * Agent-preset default repair.
 *
 * ## The failure this prevents
 *
 * `settings.yaml` may carry a top-level `agent-presets.default` naming a preset
 * id that does not exist in the running DSH build. DSH does **not** fall back
 * when that happens — `AgentPresets.resolve()` throws:
 *
 *   agent-preset/not-found: preset "code" not found
 *   (available: standard, ptc, minimal, cordis, project)
 *
 * The visible symptom is remote from the cause, which is what makes this worth
 * handling in the shell at all: the workspace picker opens, the directory is
 * picked, the workspace is even created and appears in the sidebar — and then
 * the view stays on "选择一个工作区开始" forever, because the session the pick
 * triggers can never be created. Nothing in the UI names the preset.
 *
 * A dangling id is easy to acquire and has nothing to do with the desktop app:
 * `settings.yaml` is portable between machines and DSH versions, and preset
 * sets differ between builds (0.1.5-rc.2 ships only standard/ptc/minimal/cordis,
 * so a `default: code` inherited from a machine-level `~/.dsh/settings.yaml`
 * breaks every session on a fresh data root).
 *
 * ## What this deliberately does NOT do
 *
 * It never edits a *valid* default: if the configured id resolves, the user's
 * choice stands, including one we would not have chosen. Repair only triggers on
 * an id that provably cannot resolve. It also does not attempt to author the
 * missing preset — a dangling id is a pointer to something that is not there,
 * and inventing it would silently change agent behaviour.
 *
 * Because seeding runs before DSH reads `settings.yaml`, the repair lands before
 * the bad value is ever consulted.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Result of a repair attempt, for logging and tests. */
export interface PresetRepairResult {
  /** What happened. */
  action: 'unchanged' | 'repaired' | 'settings-missing' | 'failed'
  /** The preset id now configured, when it could be determined. */
  preset?: string
  /** Human-readable explanation. */
  detail: string
}

const SETTINGS_FILENAME = 'settings.yaml'
const PRESETS_NAMESPACE = 'agent-presets'
const DEFAULT_FIELD = 'default'

/**
 * Read the configured default preset id, if any.
 *
 * A narrow line scan rather than a YAML parse, for the same reason `locale.ts`
 * uses one: the shell needs exactly one scalar out of a file it must otherwise
 * leave byte-identical, and a YAML round-trip would rewrite unrelated content
 * (comments, key order, quoting) that belongs to DSH.
 *
 * @param text - the raw `settings.yaml` contents.
 * @returns the configured id, or undefined when no default is set.
 */
export function readConfiguredPreset(text: string): string | undefined {
  const lines = text.split(/\r?\n/)
  let inPresetsBlock = false
  for (const line of lines) {
    const topLevel = /^([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (topLevel) {
      inPresetsBlock = topLevel[1] === PRESETS_NAMESPACE
      continue
    }
    // Any other non-indented content ends the block.
    if (/^\S/.test(line) && line.trim() !== '') {
      inPresetsBlock = false
      continue
    }
    if (!inPresetsBlock) continue
    const field = new RegExp(`^\\s+${DEFAULT_FIELD}:\\s*(\\S+)\\s*$`).exec(line)
    if (field) return field[1].replace(/^["']|["']$/g, '')
  }
  return undefined
}

/**
 * Rewrite one `agent-presets.default` value in place, preserving every other
 * byte of the file.
 *
 * Only the value is substituted, so indentation style, comments and section
 * order survive untouched — the same additive discipline `locale.ts` follows.
 *
 * @param text - the raw `settings.yaml` contents.
 * @param nextId - the replacement preset id.
 * @returns the updated contents.
 */
export function rewriteConfiguredPreset(text: string, nextId: string): string {
  const lines = text.split(/\r?\n/)
  let inPresetsBlock = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string
    const topLevel = /^([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (topLevel) {
      inPresetsBlock = topLevel[1] === PRESETS_NAMESPACE
      continue
    }
    if (/^\S/.test(line) && line.trim() !== '') {
      inPresetsBlock = false
      continue
    }
    if (!inPresetsBlock) continue
    const field = new RegExp(`^(\\s+${DEFAULT_FIELD}:\\s*)(\\S+)(\\s*)$`).exec(line)
    if (field) {
      lines[i] = `${field[1]}${nextId}${field[3]}`
      return lines.join('\n')
    }
  }
  return text
}

/**
 * Repair a dangling `agent-presets.default`.
 *
 * @param dshHome - the resolved DSH home (must already exist).
 * @param available - the preset ids the running build actually ships.
 * @param fallback - the id to use when the configured one is dangling;
 *   defaults to `standard`, which every shipped build provides.
 * @returns what happened, for logging.
 */
export function repairDefaultPreset(
  dshHome: string,
  available: readonly string[],
  fallback = 'standard',
): PresetRepairResult {
  const settingsPath = join(dshHome, SETTINGS_FILENAME)
  if (!existsSync(settingsPath)) {
    return { action: 'settings-missing', detail: `no settings.yaml at ${settingsPath}` }
  }

  let text: string
  try {
    text = readFileSync(settingsPath, 'utf8')
  } catch (error) {
    return { action: 'failed', detail: `could not read ${settingsPath}: ${String(error)}` }
  }

  const configured = readConfiguredPreset(text)
  if (configured === undefined) {
    return { action: 'unchanged', detail: 'no agent-presets.default configured' }
  }
  if (available.includes(configured)) {
    return { action: 'unchanged', preset: configured, detail: `default "${configured}" resolves` }
  }

  // Prefer the requested fallback, but never write another dangling id.
  const target = available.includes(fallback) ? fallback : available[0]
  if (target === undefined) {
    return {
      action: 'unchanged',
      preset: configured,
      detail: `default "${configured}" does not resolve and no preset is available to fall back to`,
    }
  }

  try {
    writeFileSync(settingsPath, rewriteConfiguredPreset(text, target), 'utf8')
    return {
      action: 'repaired',
      preset: target,
      detail: `default preset "${configured}" does not exist in this build; reset to "${target}"`,
    }
  } catch (error) {
    return { action: 'failed', detail: `could not write ${settingsPath}: ${String(error)}` }
  }
}
