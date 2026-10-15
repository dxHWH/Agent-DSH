/**
 * First-run locale seeding.
 *
 * ## Why this exists
 *
 * DSH ships both `zh` and `en` dictionaries through `dsh-client-locale`, and the
 * language is normally chosen in Settings → General. A desktop application
 * should not make a Chinese-reading user hunt for that setting on first launch,
 * so the shell seeds `zh` once, when the DSH home is first created.
 *
 * ## What this deliberately does NOT do
 *
 * It never overwrites an existing preference. Seeding is a **first-run default**,
 * not a policy: once `settings.yaml` exists, the user's own choice wins forever —
 * including choosing `en`, which must not be re-flipped to `zh` on next launch.
 * That is why the decision is "does the settings file exist?", not "what does it
 * currently say?".
 *
 * ## The contract this writes against
 *
 * From `@deepseek-ai/dsh-client-locale/lib/index.js`:
 *   - namespace: `locale`
 *   - field:     `preference`
 *   - accepted:  `["zh", "en"]` (BCP 47-style, matching `/^[A-Za-z]{2,8}(-…)*$/`)
 *
 * `settings.yaml` is YAML, and DSH merges sections by namespace — so writing a
 * single `locale` section is additive and cannot disturb other settings.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The languages DSH ships dictionaries for. */
export type ShippedLocale = 'zh' | 'en'

/** Result of a seeding attempt, for logging and tests. */
export interface LocaleSeedResult {
  /** What happened. */
  action: 'seeded' | 'already-configured' | 'settings-missing-dir' | 'failed'
  /** The locale now in effect, when it could be determined. */
  locale?: string
  /** Human-readable explanation. */
  detail: string
}

const SETTINGS_FILENAME = 'settings.yaml'
const LOCALE_NAMESPACE = 'locale'
const LOCALE_PREFERENCE_FIELD = 'preference'

/**
 * Read the currently configured locale preference, if any.
 *
 * This is a deliberately narrow scan rather than a full YAML parse: the shell
 * only needs to know whether the `locale.preference` key is already present, and
 * pulling in a YAML dependency to answer that would be disproportionate.
 */
function readConfiguredLocale(settingsPath: string): string | undefined {
  let text: string
  try {
    text = readFileSync(settingsPath, 'utf8')
  } catch {
    return undefined
  }

  // Find a top-level `locale:` block and look for `preference:` inside it.
  const lines = text.split(/\r?\n/)
  let inLocaleBlock = false
  for (const line of lines) {
    const topLevel = /^([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (topLevel) {
      inLocaleBlock = topLevel[1] === LOCALE_NAMESPACE
      continue
    }
    // Any other non-indented content ends the block.
    if (/^\S/.test(line) && line.trim() !== '') {
      inLocaleBlock = false
      continue
    }
    if (!inLocaleBlock) continue
    const field = new RegExp(`^\\s+${LOCALE_PREFERENCE_FIELD}:\\s*(\\S+)\\s*$`).exec(line)
    if (field) return field[1].replace(/^["']|["']$/g, '')
  }
  return undefined
}

/**
 * Seed the locale preference on first run.
 *
 * ## The condition this keys on
 *
 * Seeding is gated on whether a locale preference is **already set**, not on
 * whether the settings file exists. DSH creates `settings.yaml` itself as soon
 * as any feature writes a section (the onboarding notice is written on the very
 * first launch), so keying on file existence would mean the seed almost never
 * runs on a genuinely fresh install.
 *
 * An existing explicit preference is still never touched — including `en`, which
 * must not be re-flipped to `zh` on the next launch.
 *
 * @param dshHome - the resolved DSH home (must already exist).
 * @param locale - the locale to seed when none is set; defaults to `zh`.
 * @returns what happened, for logging.
 */
export function seedFirstRunLocale(dshHome: string, locale: ShippedLocale = 'zh'): LocaleSeedResult {
  if (!existsSync(dshHome)) {
    return {
      action: 'settings-missing-dir',
      detail: `DSH home does not exist yet: ${dshHome}`,
    }
  }

  const settingsPath = join(dshHome, SETTINGS_FILENAME)

  // An explicit choice — the user's or a previous seed — always wins.
  if (existsSync(settingsPath)) {
    const configured = readConfiguredLocale(settingsPath)
    if (configured !== undefined) {
      return {
        action: 'already-configured',
        locale: configured,
        detail: `settings.yaml already selects "${configured}"`,
      }
    }
  }

  // Either no settings file, or one whose sections do not include `locale`.
  // Append the section rather than replacing the file, so whatever DSH has
  // already written survives.
  const section = `${LOCALE_NAMESPACE}:\n  ${LOCALE_PREFERENCE_FIELD}: ${locale}\n`
  const existing = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
  const content = existing === ''
    ? `# Agent Desktop settings.\n# Managed by DSH; safe to edit. Language: Settings -> General.\n${section}`
    : existing.endsWith('\n')
      ? `${existing}${section}`
      : `${existing}\n${section}`

  try {
    writeFileSync(settingsPath, content, 'utf8')
    return {
      action: 'seeded',
      locale,
      detail:
        existing === ''
          ? `seeded "${locale}" into a new settings.yaml`
          : `appended "locale.preference: ${locale}" to the existing settings.yaml`,
    }
  } catch (error) {
    return { action: 'failed', detail: `could not write ${settingsPath}: ${String(error)}` }
  }
}
