/**
 * The shell's own configuration surface.
 *
 * ## Scope — what belongs here and what does not
 *
 * This window owns **application-level** settings only: where user data lives,
 * and read-only diagnostics about the running host.
 *
 * It deliberately does **not** manage API keys, models, or anything else DSH
 * already owns. DSH ships a complete Settings UI reachable inside the main
 * window, backed by `settings.yaml` and `.credentials.yaml` in the resolved
 * DSH home. Duplicating that here would create a second source of truth — the
 * exact failure this design avoids. The division is:
 *
 * | Concern | Owner |
 * |---|---|
 * | API keys, models, providers | DSH Settings UI (`ctx.credentials` / `ctx.settings`) |
 * | Data root location | this window |
 * | Port, version, profile, paths | this window (diagnostics) |
 *
 * Because both surfaces resolve the *same* DSH home, a key configured in either
 * place is one key, and it travels with that home when the install moves.
 */
import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeDataRoot, portableRoot, readShellConfig, resolvePaths, writeShellConfig, type DataRootMode } from './paths.js'
import {
  listPresets, readPresetConfig, writePresetConfig,
  parseMcpServers, writeMcpServer, appendMcpServer, testMcpServer,
  parseProjectConfig, writeProjectRoot,
  type McpServerEntry,
} from './mcp.js'
import { cancelRebuild, indexStatus, startRebuild, setIndexWindowResolver } from './index-manager.js'
import { wecomAuthorize, wecomLogout, wecomStatus } from './wecom.js'

/** Diagnostics shown in the settings window; never contains secret values. */
export interface ShellDiagnostics {
  appVersion: string
  electronVersion: string
  nodeVersion: string
  chromeVersion: string
  dshVersion: string
  dataRoot: string
  dataRootMode: DataRootMode
  dataRootLabel: string
  shellConfigPath: string
  portableRoot: string
  profileDir: string
  hostPort: number | null
  isPackaged: boolean
  /** Non-secret names present in the DSH home, to confirm data landed there. */
  contents: string[]
  /**
   * The language DSH currently has configured, read from `settings.yaml`.
   *
   * Displayed read-only: the authoritative language control is DSH's own
   * Settings → General, which owns the `locale.preference` key and can change it
   * live. Offering a second writer here would let the two disagree.
   */
  locale: string
  /** True when no preference is stored and DSH follows the browser's language. */
  localeIsAutomatic: boolean
}

/** Everything the renderer needs to render the settings window. */
export interface ShellSettingsView {
  diagnostics: ShellDiagnostics
  modes: { value: DataRootMode; label: string; description: string }[]
  current: { dataRootMode: DataRootMode; customPath?: string }
}

let settingsWindow: BrowserWindow | null = null

/** Read the installed DSH version without importing DSH (keeps startup cheap). */
function readDshVersion(): string {
  try {
    const { createRequire } = require('node:module') as typeof import('node:module')
    const dshPkg = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
    const manifest = JSON.parse(require('node:fs').readFileSync(dshPkg, 'utf8')) as { version?: string }
    return manifest.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Non-secret listing of the DSH home, so the user can see data really landed. */
function listHomeContents(home: string): string[] {
  try {
    if (!existsSync(home)) return []
    return readdirSync(home)
      .map((name) => {
        const full = join(home, name)
        try {
          return statSync(full).isDirectory() ? `${name}/` : name
        } catch {
          return name
        }
      })
      .sort()
  } catch {
    return []
  }
}

/**
 * Read the locale DSH currently has configured.
 *
 * Returns `undefined` when no preference is stored, which is a meaningful state:
 * DSH then follows the browser's `navigator.languages`.
 */
function readConfiguredLocale(dshHome: string): string | undefined {
  try {
    const settingsPath = join(dshHome, 'settings.yaml')
    if (!existsSync(settingsPath)) return undefined
    const lines = readFileSync(settingsPath, 'utf8').split(/\r?\n/)
    let inLocaleBlock = false
    for (const line of lines) {
      const topLevel = /^([A-Za-z0-9_-]+):\s*$/.exec(line)
      if (topLevel) {
        inLocaleBlock = topLevel[1] === 'locale'
        continue
      }
      if (/^\S/.test(line) && line.trim() !== '') {
        inLocaleBlock = false
        continue
      }
      if (!inLocaleBlock) continue
      const field = /^\s+preference:\s*(\S+)\s*$/.exec(line)
      if (field) return field[1].replace(/^["']|["']$/g, '')
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Gather the current diagnostics. */
export function collectDiagnostics(hostPort: number | null, profileDirValue: string): ShellDiagnostics {
  const paths = resolvePaths()
  const locale = readConfiguredLocale(paths.dshHome)
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome ?? 'unknown',
    dshVersion: readDshVersion(),
    dataRoot: paths.dshHome,
    dataRootMode: paths.mode,
    dataRootLabel: describeDataRoot(paths),
    shellConfigPath: paths.shellConfigPath,
    portableRoot: portableRoot(),
    profileDir: profileDirValue,
    hostPort,
    isPackaged: app.isPackaged,
    contents: listHomeContents(paths.dshHome),
    locale: locale ?? 'auto',
    localeIsAutomatic: locale === undefined,
  }
}

const MODE_DESCRIPTIONS: { value: DataRootMode; label: string; description: string }[] = [
  {
    value: 'userdata',
    label: 'Per-user application data (default)',
    description: 'Keeps DSH data in this Windows account\u2019s application data folder.',
  },
  {
    value: 'portable',
    label: 'Portable \u2014 beside the application',
    description: 'Stores everything next to the app so the whole folder can be copied to another machine.',
  },
  {
    value: 'custom',
    label: 'Custom folder',
    description: 'Point DSH data at a folder you choose, such as a synced or shared drive.',
  },
  {
    value: 'env',
    label: 'Use the DSH_HOME environment variable',
    description: 'Defer entirely to an externally set DSH_HOME.',
  },
]

/**
 * Register the settings IPC surface.
 *
 * Called once from the main process. Every handler is read-mostly; the single
 * mutation (changing the data root) is written to the shell's pointer file and
 * takes effect on the next launch, because DSH resolves its home at import time
 * and cannot be relocated in a running process.
 */
export function registerSettingsIpc(getHostPort: () => number | null, getProfileDir: () => string): void {
  const view = (): ShellSettingsView => {
    const config = readShellConfig()
    return {
      diagnostics: collectDiagnostics(getHostPort(), getProfileDir()),
      modes: MODE_DESCRIPTIONS,
      current: { dataRootMode: config.dataRootMode, customPath: config.customPath },
    }
  }

  ipcMain.handle('shell:get-settings', () => view())

  ipcMain.handle('shell:set-data-root', async (_event, mode: DataRootMode, customPath?: string) => {
    if (!MODE_DESCRIPTIONS.some((m) => m.value === mode)) {
      return { ok: false, error: `unknown data root mode: ${String(mode)}` }
    }
    let resolvedCustom = customPath
    if (mode === 'custom') {
      if (!resolvedCustom) {
        const picked = await dialog.showOpenDialog({
          title: 'Choose where Agent Desktop keeps its data',
          properties: ['openDirectory', 'createDirectory'],
        })
        if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
        resolvedCustom = picked.filePaths[0]
      }
    }
    writeShellConfig({ dataRootMode: mode, ...(resolvedCustom ? { customPath: resolvedCustom } : {}) })
    return { ok: true, requiresRestart: true, view: view() }
  })

  ipcMain.handle('shell:open-data-root', async () => {
    const paths = resolvePaths()
    if (!existsSync(paths.dshHome)) return { ok: false, error: 'the data folder does not exist yet' }
    const error = await shell.openPath(paths.dshHome)
    return error ? { ok: false, error } : { ok: true }
  })

  ipcMain.handle('shell:open-path', async (_event, target: string) => {
    // Only ever open the known roots, never a renderer-supplied arbitrary path.
    const allowed = new Set([resolvePaths().dshHome, portableRoot(), resolvePaths().shellConfigPath])
    if (!allowed.has(target)) return { ok: false, error: 'path is not a known shell location' }
    if (!existsSync(target)) return { ok: false, error: 'path does not exist' }
    const error = await shell.openPath(target)
    return error ? { ok: false, error } : { ok: true }
  })

  ipcMain.handle('shell:restart', () => {
    app.relaunch()
    app.exit(0)
    return { ok: true }
  })

  /**
   * Focus the main window, where DSH's own settings live.
   *
   * This deliberately does not try to click through DSH's UI. Driving another
   * application's DOM by guessed selectors would break on any DSH update, and
   * the shell has no contract for it. Bringing the window forward is the honest
   * amount of help to give.
   */
  ipcMain.handle('shell:focus-main-window', () => {
    const main = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('http://127.0.0.1:'))
    if (!main || main.isDestroyed()) {
      return { ok: false, error: 'the DSH window is not open yet' }
    }
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
    return { ok: true }
  })

  // ── MCP server configuration ───────────────────────────────────────────────

  const dshHome = (): string => resolvePaths().dshHome

  ipcMain.handle('shell:mcp:list-presets', () => {
    return { ok: true, presets: listPresets(dshHome()) }
  })

  ipcMain.handle('shell:mcp:get-servers', (_event, presetId: string) => {
    const body = readPresetConfig(dshHome(), presetId)
    if (body === null) return { ok: false, error: `preset "${presetId}" has no agent.cordis.yml` }
    const { entries, error } = parseMcpServers(body)
    return { ok: true, servers: entries, parseError: error }
  })

  /** Shared persist helper for add / update / remove. */
  const persistServers = (presetId: string, mutate: (body: string) => string) => {
    const body = readPresetConfig(dshHome(), presetId)
    if (body === null) return { ok: false, error: `preset "${presetId}" has no agent.cordis.yml` }
    const next = mutate(body)
    const wr = writePresetConfig(dshHome(), presetId, next)
    if (!wr.ok) return { ok: false, error: wr.error }
    return { ok: true, requiresRestart: true }
  }

  ipcMain.handle('shell:mcp:add-server', (_event, presetId: string, entry: McpServerEntry) => {
    if (!entry || typeof entry.id !== 'string' || !entry.id) return { ok: false, error: 'entry.id is required' }
    return persistServers(presetId, (body) => appendMcpServer(body, entry))
  })

  ipcMain.handle('shell:mcp:update-server', (_event, presetId: string, id: string, entry: McpServerEntry) => {
    return persistServers(presetId, (body) => writeMcpServer(body, entry, id))
  })

  ipcMain.handle('shell:mcp:remove-server', (_event, presetId: string, id: string) => {
    return persistServers(presetId, (body) => writeMcpServer(body, null, id))
  })

  ipcMain.handle('shell:mcp:test', async (_event, entry: McpServerEntry) => {
    return await testMcpServer(entry)
  })

  // ── Project directory (dsh-tool-example projectRoot) ───────────────────────

  ipcMain.handle('shell:project:get', (_event, presetId: string) => {
    const body = readPresetConfig(dshHome(), presetId)
    if (body === null) return { ok: false, error: `preset "${presetId}" has no agent.cordis.yml` }
    const cfg = parseProjectConfig(body)
    if (cfg === null) return { ok: false, error: `preset "${presetId}" has no tool-example plugin row` }
    return { ok: true, projectRoot: cfg.projectRoot, reportDir: cfg.reportDir }
  })

  ipcMain.handle('shell:project:set', (_event, presetId: string, projectRoot: string) => {
    if (typeof projectRoot !== 'string' || !projectRoot.trim()) {
      return { ok: false, error: 'projectRoot is required' }
    }
    const body = readPresetConfig(dshHome(), presetId)
    if (body === null) return { ok: false, error: `preset "${presetId}" has no agent.cordis.yml` }
    const next = writeProjectRoot(body, projectRoot.trim())
    const wr = writePresetConfig(dshHome(), presetId, next)
    if (!wr.ok) return { ok: false, error: wr.error }
    return { ok: true, requiresRestart: true, projectRoot: projectRoot.trim() }
  })

  ipcMain.handle('shell:project:browse', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Select project directory',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = settingsWindow && !settingsWindow.isDestroyed()
      ? await dialog.showOpenDialog(settingsWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    return { ok: true, path: result.filePaths[0] }
  })

  // ── Configuration index (query + rebuild + progress) ───────────────────────

  ipcMain.handle('shell:index:status', async (_event, projectRoot: string) => {
    if (typeof projectRoot !== 'string' || !projectRoot.trim()) {
      return { ok: false, error: 'projectRoot is required' }
    }
    return { ok: true, snapshot: await indexStatus(projectRoot.trim()) }
  })

  ipcMain.handle('shell:index:cancel', async (_event, projectRoot: string) => {
    if (typeof projectRoot !== 'string' || !projectRoot.trim()) {
      return { ok: false, error: 'projectRoot is required' }
    }
    return cancelRebuild(projectRoot.trim())
  })

  // ── WeCom bot authorization (dislike-archive upload) ───────────────────────
  // Credentials go straight to wecom-cli's encrypted store; nothing is persisted
  // or logged here. See wecom.ts.

  ipcMain.handle('shell:wecom:status', () => wecomStatus(dshHome()))

  let wecomBusy = false
  ipcMain.handle('shell:wecom:authorize', async (_event, botId: string, secret: string) => {
    if (wecomBusy) return { ok: false, error: '正在授权中，请稍候' }
    wecomBusy = true
    try {
      return await wecomAuthorize(dshHome(), String(botId ?? ''), String(secret ?? ''))
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      wecomBusy = false
    }
  })

  ipcMain.handle('shell:wecom:logout', () => wecomLogout())

  ipcMain.handle('shell:index:rebuild', (_event, projectRoot: string) => {
    if (typeof projectRoot !== 'string' || !projectRoot.trim()) {
      return { ok: false, error: 'projectRoot is required' }
    }
    const result = startRebuild(projectRoot.trim())
    return result.started ? { ok: true } : { ok: false, error: result.error }
  })
}

/**
 * Locate a bundled asset relative to this module, not to `app.getAppPath()`.
 *
 * `getAppPath()` follows the *entry point* — running `electron scripts/x.mjs`
 * makes it the `scripts/` directory — so assets resolved that way break outside
 * the packaged app. `import.meta.url` always points at `dist/main/`, which is
 * what the build output layout is anchored to.
 */
function assetPath(...segments: string[]): string {
  return join(dirname(fileURLToPath(import.meta.url)), ...segments)
}

/** Open (or focus) the settings window. */
export function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 720,
    height: 640,
    minWidth: 560,
    minHeight: 420,
    title: 'Agent Desktop Settings',
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: assetPath('..', 'preload', 'settings.cjs'),
    },
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })

  setIndexWindowResolver(() => settingsWindow)

  void settingsWindow.loadFile(assetPath('..', 'settings', 'index.html'))
}
