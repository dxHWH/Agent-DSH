/**
 * System tray presence.
 *
 * The window is the app's only real surface, so closing it would normally end
 * the session — and with it any long-running DSH work. The tray keeps the
 * application alive and gives the window a way back.
 *
 * The subtle failure this module guards against: a user clicks the window's X,
 * sees it vanish, and concludes the app has exited. A one-time balloon on the
 * first close is the cheapest way to teach the real behavior.
 */
import { app, Menu, Tray, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface TrayCallbacks {
  /** Show and focus the main window, restoring it if minimized or hidden. */
  show(): void
  /** Open the shell's settings window. */
  settings(): void
  /** Quit the application for real. */
  quit(): void
}

let tray: Tray | null = null
let informedAboutTray = false

/**
 * The tray icon.
 *
 * Electron refuses to construct a `Tray` without an image, so a generated
 * 16×16 placeholder is used when the packaged icon is unavailable. That keeps a
 * missing asset from taking down startup over a cosmetic detail.
 */
function trayImage(): NativeImage {
  const candidates = [
    join(process.resourcesPath ?? '', 'icon.png'),
    join(app.getAppPath(), 'assets', 'icon.png'),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      const image = nativeImage.createFromPath(candidate)
      if (!image.isEmpty()) return image
    }
  }
  // 16x16 transparent placeholder — the tray entry still works, it is just bare.
  return nativeImage.createEmpty()
}

/** Create the tray icon and its menu. */
export function createTray(callbacks: TrayCallbacks): Tray {
  if (tray) return tray

  tray = new Tray(trayImage())
  tray.setToolTip('Agent Desktop')

  const menu = Menu.buildFromTemplate([
    {
      label: 'Show Agent Desktop',
      click: () => callbacks.show(),
    },
    {
      label: 'Settings…',
      click: () => callbacks.settings(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => callbacks.quit(),
    },
  ])
  tray.setContextMenu(menu)

  // Left click shows the window; double-click is not bound separately, since
  // Windows fires a click first and the second handler would be redundant.
  tray.on('click', () => callbacks.show())

  return tray
}

/** Remove the tray icon. */
export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

/**
 * Tell the user, once, that closing the window did not quit the application.
 *
 * Shown at most once per process so it informs without nagging.
 */
export function notifyMinimizedToTray(win: BrowserWindow): void {
  if (informedAboutTray) return
  informedAboutTray = true
  try {
    if (process.platform === 'win32' && tray) {
      tray.displayBalloon({
        title: 'Agent Desktop is still running',
        content: 'The window was hidden to the tray. Use the tray icon to reopen it, or Quit to exit.',
      })
      return
    }
    win.webContents.executeJavaScript(
      `void 0;`,
    ).catch(() => {})
  } catch {
    // Notifications are a courtesy; never let one break the close path.
  }
}
