/**
 * Agent Desktop — Electron main process.
 *
 * Architecture (verified end-to-end; see `docs/phase0-findings.md` and
 * `docs/phase1-notes.md`):
 *   boot DSH in-process on an OS-assigned port, then point a BrowserWindow at
 *   the real tokenized loopback URL. Loading a real HTTP origin means the
 *   shipped DSH frontend works unmodified: its boot graph is injected by the
 *   server, its `/api` and `/plugins` routes resolve normally, and the
 *   browser-session cookie exchange needs no reimplementation.
 *
 * Responsibilities kept in this file: window lifecycle, tray integration, and
 * the security posture of the renderer. Everything that talks to DSH lives in
 * `host.ts`.
 */
import { app, BrowserWindow, Menu, session, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { seedFirstRunLocale } from './locale.js'
import { ensureProjectPreset } from './agent-preset.js'
import { seedModelPreset } from './model-preset.js'
import { cancelAllRebuilds } from './index-manager.js'
import { describeDataRoot, legacyMigration, resolvePaths } from './paths.js'
import { repairDefaultPreset } from './presets.js'
import { openSettingsWindow, registerSettingsIpc } from './settings.js'
import { createTray, destroyTray, notifyMinimizedToTray } from './tray.js'
import { restoreWindowState, saveWindowState } from './window-state.js'

/** The application-owned DSH profile directory. */
function profileDir(): string {
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'desktop-profile')
    : join(app.getAppPath(), 'desktop-profile')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

let mainWindow: BrowserWindow | null = null
let host: import('./host.js').DshHost | null = null

/** Set once the user chooses a real quit, so close-to-tray stops intercepting. */
let quitting = false

/**
 * Clear every stale `dsh-auth-*` cookie for the loopback host before a launch.
 *
 * DSH mints one authority-bound auth cookie per browser session, keyed by
 * `dsh-auth-<sha256(host:port)>`. Because the desktop host binds an OS-assigned
 * port (`--port 0`), the authority — and therefore the cookie name — changes on
 * every launch. Each launch adds a fresh cookie and none are ever overwritten or
 * removed, so after ~64 launches the accumulated `Cookie` header (~14.5 KB)
 * combines with the ~2.5 KB `/plugins` combo URL to exceed Node's 16 KB
 * `maxHeaderSize`. The result is an HTTP 431 on the client-plugin combo bundle,
 * which surfaces as "Failed to load plugins — bundle script … failed to load".
 *
 * These cookies are single-launch secrets: the process token is regenerated each
 * boot, so any surviving cookie is unusable garbage. Clearing them is therefore
 * safe and is exactly the cleanup DSH itself does not perform.
 */
async function clearStaleAuthCookies(): Promise<void> {
  const cookies = await session.defaultSession.cookies.get({})
  const stale = cookies.filter(
    (cookie) => cookie.name.startsWith('dsh-auth-') && (cookie.domain === '127.0.0.1' || cookie.domain === 'localhost'),
  )
  if (stale.length === 0) return
  console.log(`[dsh-desktop] clearing ${stale.length} stale dsh-auth cookie(s)`)
  await Promise.all(
    stale.map((cookie) =>
      session.defaultSession.cookies.remove(
        `http://${cookie.domain}${cookie.path ?? '/'}`,
        cookie.name,
      ),
    ),
  )
}

/**
 * Create the application window and load the host's authenticated URL.
 *
 * @param url - the tokenized loopback URL the DSH host is serving.
 */
async function createWindow(url: string): Promise<BrowserWindow> {
  const state = restoreWindowState()

  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    title: 'Agent Desktop',
    webPreferences: {
      // The renderer runs DSH's own UI, which needs no Node access whatsoever.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      // No preload: the shell exposes no IPC surface to the renderer, so there
      // is nothing to bridge.
      preload: undefined,
    },
  })

  if (state.maximized) win.maximize()

  win.once('ready-to-show', () => win.show())

  // Keep the product name in the taskbar/title bar: the DSH web UI sets its own
  // <title>, which would otherwise replace it after load.
  win.on('page-title-updated', (event) => event.preventDefault())

  // External links open in the user's browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target)
    return { action: 'deny' }
  })

  // Block in-app navigation away from our own loopback host.
  win.webContents.on('will-navigate', (event, target) => {
    if (host && !target.startsWith(`http://127.0.0.1:${host.port}`)) {
      event.preventDefault()
      void shell.openExternal(target)
    }
  })

  // Persist geometry as it changes, debounced so dragging is not a write storm.
  let saveTimer: NodeJS.Timeout | undefined
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveWindowState(win), 400)
  }
  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)
  win.on('maximize', scheduleSave)
  win.on('unmaximize', scheduleSave)

  // Closing hides to the tray instead of ending the session.
  win.on('close', (event) => {
    saveWindowState(win)
    if (quitting) return
    event.preventDefault()
    win.hide()
    notifyMinimizedToTray(win)
  })

  win.on('closed', () => {
    if (saveTimer) clearTimeout(saveTimer)
    mainWindow = null
  })

  // The launch token is regenerated each boot, so any cookie a previous launch
  // left behind is dead weight — and, accumulated, it overflows the server's
  // request-header budget. Clear them before the window loads anything.
  await clearStaleAuthCookies()

  await win.loadURL(url)
  return win
}

/** A readable failure surface, so a boot error is never a blank window. */
function showFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const escaped = message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string)
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Agent Desktop — startup failed</title>
<style>
 body{font:14px/1.6 system-ui,Segoe UI,sans-serif;background:#1a1a1a;color:#e8e8e8;padding:2.5rem;max-width:60rem;margin:auto}
 h1{font-size:1.3rem;margin:0 0 .5rem} pre{background:#111;border:1px solid #333;border-radius:6px;padding:1rem;overflow:auto;white-space:pre-wrap}
 .hint{color:#9aa0a6;margin-top:1.5rem}
</style></head><body>
<h1>DSH host failed to start</h1>
<pre>${escaped}</pre>
<p class="hint">Check the console output for the full boot trace.</p>
</body></html>`
  const win = new BrowserWindow({ width: 900, height: 560, backgroundColor: '#1a1a1a' })
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  mainWindow = win
}

/**
 * Apply the resolved data root to the environment *before* any DSH module is
 * imported: DSH resolves its home at import time, so ordering is load-bearing.
 *
 * Locale seeding happens here too — before DSH reads `settings.yaml` — so a
 * first launch comes up already in the seeded language rather than switching
 * into it after the fact.
 */
function applyDataRoot(): void {
  const paths = resolvePaths()
  process.env.DSH_HOME = paths.dshHome
  console.log(`[dsh-desktop] data root (${paths.mode}): ${paths.dshHome}`)
  console.log(`[dsh-desktop] ${describeDataRoot(paths)}`)
  if (legacyMigration) console.log(`[dsh-desktop] legacy data: ${legacyMigration}`)

  const seeded = seedFirstRunLocale(paths.dshHome)
  console.log(`[dsh-desktop] locale: ${seeded.action} — ${seeded.detail}`)

  // First-run model selection (assets/model-preset/models.yaml); never overwrites.
  try {
    const models = seedModelPreset(paths.dshHome)
    console.log(`[dsh-desktop] model preset: ${models.action} — ${models.detail}`)
  } catch (error) {
    console.error('[dsh-desktop] model preset failed:', error)
  }

  // Presets are discovered when the host mounts, so the project preset must
  // exist before startHost(). Never overwrites an existing preset.
  try {
    const preset = ensureProjectPreset(paths.dshHome)
    console.log(`[dsh-desktop] project preset: ${preset.action} — ${preset.detail}`)
  } catch (error) {
    console.error('[dsh-desktop] project preset install failed:', error)
  }
}

/** Show and focus the window, recreating nothing — the host keeps running. */
function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

/** Quit for real: dispose the host, then let the close path proceed. */
function quitApplication(): void {
  quitting = true
  app.quit()
}

/** Build the application menu, which is mostly a set of standard shortcuts. */
function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Settings…', accelerator: 'Ctrl+,', click: () => openSettingsWindow() },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Ctrl+Q', click: () => quitApplication() },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function bootstrap(): Promise<void> {
  applyDataRoot()

  const { startHost } = await import('./host.js')
  host = await startHost({
    dshHome: process.env.DSH_HOME as string,
    profileDir: profileDir(),
    onProgress: (message) => console.log(`[dsh-desktop] ${message}`),
  })

  const url = host.authenticatedUrl()
  console.log(`[dsh-desktop] loading ${url.replace(/token=[^&]+/, 'token=***')}`)

  // Repair a dangling `agent-presets.default` before the window can create a
  // session. `settings.yaml` travels between machines and DSH versions, and a
  // default naming a preset this build does not ship makes EVERY session fail to
  // create — which surfaces as the workspace picker appearing to do nothing.
  // Runs here, not in `applyDataRoot`, because the authoritative preset list
  // only exists once the composition is live.
  const available = await host.availablePresets()
  if (available.length > 0) {
    const repaired = repairDefaultPreset(process.env.DSH_HOME as string, available)
    console.log(`[dsh-desktop] preset default: ${repaired.action} — ${repaired.detail}`)
  }

  mainWindow = await createWindow(url)
  createTray({ show: showWindow, quit: quitApplication, settings: openSettingsWindow })
}

// A second instance would fight over the data root and the DSH home locks.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(async () => {
    // Harden the default session: deny every permission the DSH UI never needs.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write'])
      callback(allowed.has(permission))
    })

    buildMenu()

    // The settings window's IPC surface. Registered before bootstrap so the
    // window works even if the host fails to start — diagnostics are exactly
    // what a user needs in that case.
    registerSettingsIpc(
      () => host?.port ?? null,
      () => profileDir(),
    )

    try {
      await bootstrap()
    } catch (error) {
      console.error('[dsh-desktop] boot failed:', error)
      showFailure(error)
    }
  })

  // The tray keeps the app alive after the last window closes, so this event
  // must NOT quit — it fires whenever the window is hidden and re-shown.
  app.on('window-all-closed', () => {
    if (quitting) app.quit()
  })

  app.on('activate', showWindow)

  app.on('before-quit', () => {
    quitting = true
    destroyTray()
    void cancelAllRebuilds()
    void host?.dispose()
  })
}
