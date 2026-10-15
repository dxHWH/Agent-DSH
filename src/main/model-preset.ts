/**
 * First-run model preset.
 *
 * Seeds top-level sections (by default `agent-default-model`; optionally a
 * `llm-pi-ai` provider section for an OpenAI-compatible gateway) from
 * `assets/model-preset/models.yaml` (packaged: `resources/model-preset/`),
 * each section only when `settings.yaml` does not have it yet — a user's own
 * model configuration is never touched. No secret is written: the key is
 * entered in the first-run dialog (feedback-archive client, `onboarding.tsx`).
 */
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ModelPresetResult {
  action: 'seeded' | 'kept-existing' | 'no-template'
  detail: string
}

function templatePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'model-preset', 'models.yaml')
    : join(app.getAppPath(), 'assets', 'model-preset', 'models.yaml')
}

/** Split a YAML document into its top-level sections (`name:` at column 0). */
function topLevelSections(text: string): Map<string, string> {
  const sections = new Map<string, string>()
  let current: string | null = null
  let buf: string[] = []
  const flush = (): void => {
    if (current !== null) sections.set(current, buf.join('\n').replace(/\s+$/, '') + '\n')
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):/.exec(line)
    if (m) {
      flush()
      current = m[1]
      buf = [line]
    } else if (current !== null && !/^#/.test(line)) {
      buf.push(line)
    }
  }
  flush()
  return sections
}

export function seedModelPreset(dshHome: string): ModelPresetResult {
  const tpl = templatePath()
  if (!existsSync(tpl)) return { action: 'no-template', detail: tpl }

  const settingsPath = join(dshHome, 'settings.yaml')
  const existing = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
  const have = new Set(topLevelSections(existing).keys())

  const added: string[] = []
  let append = ''
  for (const [name, body] of topLevelSections(readFileSync(tpl, 'utf8'))) {
    if (have.has(name)) continue
    append += body
    added.push(name)
  }
  if (added.length === 0) return { action: 'kept-existing', detail: 'settings.yaml already configures models' }

  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
  writeFileSync(settingsPath, existing + sep + append, 'utf8')
  return { action: 'seeded', detail: `added ${added.join(', ')}` }
}
