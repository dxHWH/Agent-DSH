/**
 * Check what the shipped locale service actually offers in this composition.
 *
 * DSH ships `dsh-client-locale` with `zh`/`en` dictionaries, so "Chinese mode"
 * may already be available without any shell work. This verifies that rather
 * than assuming it.
 *
 * Run: npx electron scripts/audit-locale.mjs
 */
import { app } from 'electron'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
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
  const require = createRequire(import.meta.url)

  // Where the locale package lives, and what it ships.
  try {
    const pkgPath = require.resolve('@deepseek-ai/dsh-client-locale/package.json')
    const root = dirname(pkgPath)
    out.packageRoot = root
    out.version = JSON.parse(readFileSync(pkgPath, 'utf8')).version

    const localesDir = join(root, 'lib', 'locales')
    out.localesDirExists = existsSync(localesDir)
    if (out.localesDirExists) {
      out.shippedLocales = require('node:fs').readdirSync(localesDir)
    }
  } catch (error) {
    out.packageError = String(error)
  }

  // What the composition mounts for locale, and the settings schema it registers.
  try {
    const boot = await import('@deepseek-ai/dsh-app-boot')
    const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
    const profile = boot.loadProfileDirectory('dsh-desktop', join(projectRoot, 'desktop-profile'), installAnchor)
    const rows = boot.composeEntries([
      profile.layers.flatMap((l) => l.patches ?? []),
      profile.patches ?? [],
    ])
    const localeRows = rows.filter((r) => (r.name ?? '').includes('locale') || (r.id ?? '').includes('locale'))
    out.localeRows = localeRows.map((r) => ({ id: r.id, name: r.name }))
  } catch (error) {
    out.compositionError = String(error)
  }

  // What a current DSH home has recorded for locale, if anything.
  try {
    const settingsPath = join(app.getPath('userData'), 'dsh-home', 'settings.yaml')
    out.settingsPath = settingsPath
    if (existsSync(settingsPath)) {
      const text = readFileSync(settingsPath, 'utf8')
      out.settingsHasLocale = /locale/i.test(text)
      out.settingsExcerpt = text.slice(0, 400)
    } else {
      out.settingsExists = false
    }
  } catch (error) {
    out.settingsError = String(error)
  }

  // Enumerate the locale API surface from the compiled client half.
  try {
    const clientPath = require.resolve('@deepseek-ai/dsh-client-locale/client')
    out.clientEntry = clientPath
    const source = readFileSync(clientPath, 'utf8')
    out.clientMentionsZh = source.includes("'zh'") || source.includes('"zh"')
    out.clientMentionsEn = source.includes("'en'") || source.includes('"en"')
    const addLang = source.match(/addLanguage/g)
    out.addLanguageOccurrences = addLang ? addLang.length : 0
  } catch (error) {
    out.clientError = String(error)
  }

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
