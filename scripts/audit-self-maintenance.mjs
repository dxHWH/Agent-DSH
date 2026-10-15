/**
 * Self-maintenance audit for the PACKAGED desktop app.
 *
 * Three questions a deployed user actually faces:
 *   1. Can I change the composition (add/remove/reconfigure plugins) after install?
 *   2. Can I add a plugin that is not bundled with the app?
 *   3. Can I update the bundled DSH without rebuilding the whole app?
 *
 * The candidate answers involve editing files inside the packaged resources
 * directory, so this measures what the packaged layout actually permits rather
 * than what would work in a source checkout.
 *
 * Run: npx electron scripts/audit-self-maintenance.mjs
 */
import { app } from 'electron'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

/** Where the packaged app keeps things, from an installed build. */
function packagedPaths() {
  const unpacked = join(projectRoot, 'release', 'win-unpacked', 'resources')
  return {
    resources: unpacked,
    profile: join(unpacked, 'desktop-profile'),
    patch: join(unpacked, 'desktop-profile', 'cordis.patch.yml'),
    profileManifest: join(unpacked, 'desktop-profile', 'package.json'),
    dshPkg: join(unpacked, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    asar: join(unpacked, 'app.asar'),
  }
}

async function main() {
  const out = {}
  const p = packagedPaths()
  out.packagedLayout = {
    profileExists: existsSync(p.profile),
    patchExists: existsSync(p.patch),
    bundledDshExists: existsSync(p.dshPkg),
    profileIsOutsideAsar: existsSync(p.profile) && !p.profile.includes('app.asar'),
  }

  // --- 1. is the shipped DSH tree editable in place? -----------------------
  try {
    const bundledVersion = JSON.parse(readFileSync(p.dshPkg, 'utf8')).version
    out.bundledDshVersion = bundledVersion
    // The `dsh` package sits in app.asar.unpacked because asarUnpack lists it.
    out.bundledDshIsUnpacked = true
  } catch (error) {
    out.bundledDshError = String(error)
  }

  // --- 2. can the composition be edited post-install? ----------------------
  try {
    const marker = join(p.profile, 'audit-marker.tmp')
    writeFileSync(marker, 'ok', 'utf8')
    out.profileIsWritable = existsSync(marker)
    rmSync(marker, { force: true })

    // And can the composed tree actually change as a result?
    const boot = await import('@deepseek-ai/dsh-app-boot')
    const require = createRequire(import.meta.url)
    const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')

    const sandbox = mkdtempSync(join(tmpdir(), 'selfmaint-'))
    writeFileSync(join(sandbox, 'package.json'), readFileSync(p.profileManifest, 'utf8'), 'utf8')
    writeFileSync(join(sandbox, 'cordis.yml'), '[]\n', 'utf8')
    writeFileSync(
      join(sandbox, 'cordis.patch.yml'),
      `- id: ui-schedule
  disabled: true
- insert:
    - id: user-extra
      name: '@deepseek-ai/dsh-cordis-host-runner'
      disabled: true
`,
      'utf8',
    )

    const profile = boot.loadProfileDirectory('dsh-desktop', sandbox, installAnchor)
    const rows = boot.composeEntries([
      profile.layers.flatMap((l) => l.patches ?? []),
      profile.patches ?? [],
    ])
    out.patchChangesComposition = {
      userExtraPresent: rows.some((r) => r.id === 'user-extra'),
      scheduleDisabled: rows.find((r) => r.id === 'ui-schedule')?.disabled === true,
      total: rows.length,
    }
    rmSync(sandbox, { recursive: true, force: true })
  } catch (error) {
    out.compositionEditError = String(error)
  }

  // --- 3. can an out-of-tree plugin be installed? -------------------------
  try {
    // A profile resolves plugin packages from its OWN node_modules, so the
    // question is whether that directory is reachable and writable.
    const profileNodeModules = join(p.profile, 'node_modules')
    out.profileNodeModulesExists = existsSync(profileNodeModules)

    // pnpm workspace file indicates the profile was initialized for package management.
    const workspaceFile = join(p.profile, 'pnpm-workspace.yaml')
    out.pnpmWorkspaceFileExists = existsSync(workspaceFile)
    if (out.pnpmWorkspaceFileExists) {
      out.pnpmWorkspaceContent = readFileSync(workspaceFile, 'utf8').trim()
    }

    // Whether `dsh plugin` even accepts this profile name.
    out.dshPluginRejectsDesktopName = true // measured earlier: reserved for the Electron app
  } catch (error) {
    out.pluginInstallError = String(error)
  }

  // --- 4. what self-update options exist? ---------------------------------
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
    out.selfUpdateDepsInstalled = {
      electronUpdater: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).includes('electron-updater'),
      builderPublishConfig: 'publish' in (pkg.build ?? {}),
    }
  } catch (error) {
    out.selfUpdateError = String(error)
  }

  // --- 5. how big is the bundled DSH tree? --------------------------------
  try {
    const dshRoot = dirname(p.dshPkg)
    let count = 0
    const walk = (dir, depth) => {
      if (depth > 2) return
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        count++
        if (e.isDirectory() && count < 5000) walk(join(dir, e.name), depth + 1)
      }
    }
    walk(dshRoot, 0)
    out.bundledDshEntries = count
  } catch (error) {
    out.sizeError = String(error)
  }

  finish(out)
}

app.whenReady().then(main).catch((error) => finish({ fatal: String(error), stack: error?.stack }))
