/**
 * Portable path resolution for the desktop shell.
 *
 * Two requirements drive this module:
 *
 * 1. **User configuration must remain DSH's own.** The shell must never grow a
 *    parallel settings store — API keys, models, and sessions belong to DSH's
 *    `settings.yaml` / `.credentials.yaml` under the resolved home, so the
 *    shipped Settings UI keeps working unchanged.
 *
 * 2. **The client must run on another Windows machine.** Nothing may hardcode a
 *    developer's absolute paths. The user-data root is chosen at runtime, and
 *    relocating it relocates configuration *and* session history together.
 *
 * `resolveDshHome()` in `@deepseek-ai/dsh-home-paths` resolves, highest first:
 * an explicit configured path, then `$DSH_HOME`, then `~/.dsh`. Setting
 * `DSH_HOME` before any DSH plugin mounts is therefore sufficient to own the
 * whole data root — that is the single lever this module pulls.
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** How the user-data root is chosen. */
export type DataRootMode =
  /** Next to the executable — the whole folder is copyable between machines. */
  | 'portable'
  /** Per-user application data (Electron's `userData`), the default. */
  | 'userdata'
  /** An explicit absolute path recorded in the shell's own pointer file. */
  | 'custom'
  /** Defer entirely to an externally set `$DSH_HOME` (power users, CI). */
  | 'env'

/** The shell's own tiny pointer file — it stores *where* data lives, never the data. */
export interface ShellConfig {
  dataRootMode: DataRootMode
  /** Used only when `dataRootMode` is `custom`. */
  customPath?: string
}

/** Resolved, absolute locations the shell and DSH agree on. */
export interface ResolvedPaths {
  /** The DSH home: settings.yaml, .credentials.yaml, sessions, storages. */
  dshHome: string
  /** The shell's own config file (points at the chosen data root). */
  shellConfigPath: string
  /** Where a portable deployment keeps everything. */
  portableRoot: string
  mode: DataRootMode
  /** True when the resolved root did not exist and was created now. */
  created: boolean
}

const SHELL_CONFIG_FILENAME = 'desktop-shell.json'

/**
 * The portable root: a `dsh-data` folder beside the executable.
 *
 * In development the executable is Electron's own binary inside
 * `node_modules`, so the app path is used instead to keep the folder inside the
 * project rather than buried in dependencies.
 */
export function portableRoot(): string {
  return app.isPackaged
    ? join(resolve(app.getPath('exe'), '..'), 'dsh-data')
    : join(app.getAppPath(), 'dsh-data')
}

/** The shell config lives beside the executable, so it travels with a portable copy. */
function shellConfigPath(): string {
  return app.isPackaged
    ? join(resolve(app.getPath('exe'), '..'), SHELL_CONFIG_FILENAME)
    : join(app.getAppPath(), SHELL_CONFIG_FILENAME)
}

/** Read the shell config, tolerating absence and corruption. */
export function readShellConfig(): ShellConfig {
  const path = shellConfigPath()
  try {
    if (!existsSync(path)) return { dataRootMode: 'userdata' }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ShellConfig>
    const mode = parsed.dataRootMode
    const valid: DataRootMode[] = ['portable', 'userdata', 'custom', 'env']
    return {
      dataRootMode: mode && valid.includes(mode) ? mode : 'userdata',
      customPath: typeof parsed.customPath === 'string' ? parsed.customPath : undefined,
    }
  } catch {
    // A corrupt pointer must never prevent startup; fall back to the default.
    return { dataRootMode: 'userdata' }
  }
}

/** Persist the shell config so the choice survives restarts. */
export function writeShellConfig(config: ShellConfig): void {
  writeFileSync(shellConfigPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

/**
 * Result of a legacy-data migration, for the startup log.
 *
 * Kept as an extension point: if the product is ever renamed, Electron's
 * `userData` (derived from the product name) moves with it, and a one-time,
 * never-overwriting copy from the old `%APPDATA%\<old name>\dsh-home` belongs
 * here (see `docs/handbook/05-maintenance.md`). Not `fs.cpSync` — it crashes
 * the process on non-ASCII Windows paths.
 */
export let legacyMigration: string | null = null

/**
 * Resolve the DSH home for this launch and make sure it exists.
 *
 * Crucially this **does not** mutate `process.env.DSH_HOME` — the caller does
 * that before importing any DSH module, because DSH resolves its home at import
 * time. Keeping the mutation at the call site makes the ordering requirement
 * visible instead of hiding it in a helper.
 */
export function resolvePaths(): ResolvedPaths {
  const config = readShellConfig()
  const portable = portableRoot()
  let dshHome: string
  let mode: DataRootMode = config.dataRootMode

  switch (config.dataRootMode) {
    case 'portable':
      dshHome = join(portable, 'dsh-home')
      break
    case 'custom': {
      if (config.customPath && config.customPath.trim() !== '') {
        dshHome = resolve(config.customPath)
      } else {
        // A custom mode with no path recorded is unusable; degrade rather than fail.
        mode = 'userdata'
        dshHome = join(app.getPath('userData'), 'dsh-home')
      }
      break
    }
    case 'env': {
      const fromEnv = process.env.DSH_HOME
      if (fromEnv && fromEnv.trim() !== '') {
        dshHome = resolve(fromEnv)
      } else {
        // Nothing to defer to; fall back to the per-user root.
        mode = 'userdata'
        dshHome = join(app.getPath('userData'), 'dsh-home')
      }
      break
    }
    case 'userdata':
    default:
      dshHome = join(app.getPath('userData'), 'dsh-home')
      break
  }

  const created = !existsSync(dshHome)
  if (created) mkdirSync(dshHome, { recursive: true })
  if (mode === 'portable' && !existsSync(portable)) mkdirSync(portable, { recursive: true })

  return {
    dshHome,
    shellConfigPath: shellConfigPath(),
    portableRoot: portable,
    mode,
    created,
  }
}

/** Human-readable description of where data lives, for the About/diagnostics surface. */
export function describeDataRoot(paths: ResolvedPaths): string {
  const labels: Record<DataRootMode, string> = {
    portable: 'Portable (beside the application)',
    userdata: 'Per-user application data',
    custom: 'Custom location',
    env: 'From the DSH_HOME environment variable',
  }
  const defaultHome = join(homedir(), '.dsh')
  const isDefault = resolve(paths.dshHome) === resolve(defaultHome)
  return `${labels[paths.mode]}\n${paths.dshHome}${isDefault ? '  (DSH default location)' : ''}`
}
