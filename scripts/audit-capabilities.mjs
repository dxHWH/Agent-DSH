/**
 * Capability audit: what does the desktop composition actually mount, compared
 * with a stock `dsh web` composition?
 *
 * The question this answers is whether the shell loses anything by booting the
 * same bundles through its own profile directory — the answer should be "no
 * functional difference", but that is a claim worth measuring rather than
 * assuming.
 *
 * Run: npx electron scripts/audit-capabilities.mjs
 */
import { app } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function finish(payload) {
  console.log('AUDIT_BEGIN')
  console.log(JSON.stringify(payload, null, 2))
  console.log('AUDIT_END')
  app.exit(0)
}

/** Boot a composition and report its mounted entries. */
async function compose(profileDir, label) {
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const require = createRequire(import.meta.url)
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')

  const profile = boot.loadProfileDirectory(label, profileDir, installAnchor)
  const bundlePatches = profile.layers.flatMap((l) => l.patches ?? [])
  const rows = boot.composeEntries([bundlePatches, profile.patches ?? []])

  const ids = rows.map((r) => r.id).filter(Boolean).sort()
  const names = rows.map((r) => r.name).filter(Boolean).sort()

  // Client-side plugins are the ones declaring `dsh.client` in their manifest;
  // they are what the UI's extensibility is built from.
  const clientPlugins = names.filter((n) => n.includes('dsh-client'))

  return {
    label,
    profileDir,
    bundles: profile.layers.map((l) => l.name ?? l.dir ?? 'unknown'),
    entryCount: rows.length,
    ids,
    names,
    clientPluginCount: clientPlugins.length,
    clientPlugins,
  }
}

async function main() {
  const out = {}

  try {
    // A pristine `web` profile, initialized fresh, exactly as `dsh web` builds it.
    const boot = await import('@deepseek-ai/dsh-app-boot')
    const webDir = mkdtempSync(join(tmpdir(), 'audit-web-profile-'))
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'audit-web-home-'))
    boot.initProfile(webDir, boot.PROFILE_TEMPLATES.web.bundles, 'live')
    out.web = await compose(webDir, 'dsh-web-baseline')
  } catch (error) {
    out.web = { error: String(error) }
  }

  try {
    // The desktop shell's own profile directory, as shipped.
    out.desktop = await compose(join(projectRoot, 'desktop-profile'), 'dsh-desktop')
  } catch (error) {
    out.desktop = { error: String(error) }
  }

  // The comparison that matters: is anything present in one and missing in the other?
  if (out.web?.ids && out.desktop?.ids) {
    const webIds = new Set(out.web.ids)
    const desktopIds = new Set(out.desktop.ids)
    out.diff = {
      onlyInWeb: [...webIds].filter((id) => !desktopIds.has(id)).sort(),
      onlyInDesktop: [...desktopIds].filter((id) => !webIds.has(id)).sort(),
      identical: [...webIds].every((id) => desktopIds.has(id)) && webIds.size === desktopIds.size,
      webCount: webIds.size,
      desktopCount: desktopIds.size,
    }
  }

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
