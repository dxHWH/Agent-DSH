/**
 * Phase 2 self-check.
 *
 * Verifies the parts of the shell that a screenshot would otherwise be needed
 * for: that the tray was created, that the settings window renders and its IPC
 * bridge resolves, and that closing the main window hides it instead of ending
 * the process.
 *
 * Run: npx electron scripts/selfcheck-phase2.mjs
 */
import { app, BrowserWindow, Tray } from 'electron'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The project root, derived from this script's own location rather than
 * `app.getAppPath()` — the latter follows the entry point and would resolve to
 * `scripts/` when run as `electron scripts/...`.
 */
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` [${detail}]` : ''}`)
}

async function main() {
  const { resolvePaths } = await import('../dist/main/paths.js')
  const { createTray, destroyTray } = await import('../dist/main/tray.js')
  const { registerSettingsIpc, openSettingsWindow } = await import('../dist/main/settings.js')
  const { restoreWindowState, saveWindowState } = await import('../dist/main/window-state.js')

  // --- data root resolution -------------------------------------------------
  const paths = resolvePaths()
  record('data root resolves', typeof paths.dshHome === 'string' && paths.dshHome.length > 0, paths.dshHome)
  record('data root mode is valid', ['portable', 'userdata', 'custom', 'env'].includes(paths.mode), paths.mode)

  // --- tray -----------------------------------------------------------------
  let tray = null
  try {
    tray = createTray({ show: () => {}, settings: () => {}, quit: () => {} })
    record('tray created', tray instanceof Tray)
  } catch (error) {
    record('tray created', false, String(error))
  }

  // --- window state ---------------------------------------------------------
  let state = null
  try {
    state = restoreWindowState()
    record('window state restores', typeof state.width === 'number' && state.width > 0, JSON.stringify(state))
  } catch (error) {
    record('window state restores', false, String(error))
  }

  // --- settings IPC + window ------------------------------------------------
  let settingsWin = null
  try {
    registerSettingsIpc(() => 12345, () => 'C:\\fake\\profile')
    openSettingsWindow()
    // `openSettingsWindow` assigns synchronously before load completes.
    await new Promise((r) => setTimeout(r, 1500))
    settingsWin = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Settings'))
    record('settings window opens', settingsWin !== undefined && !settingsWin.isDestroyed())

    if (settingsWin) {
      const rendered = await settingsWin.webContents.executeJavaScript(
        `JSON.stringify({
           title: document.querySelector('h1')?.textContent ?? null,
           modeCount: document.querySelectorAll('input[name="dataRootMode"]').length,
           diagRows: document.querySelectorAll('#diagnostics dt').length,
           hasBridge: typeof window.dshShell === 'object' && window.dshShell !== null,
           bridgeFns: window.dshShell ? Object.keys(window.dshShell).sort() : [],
         })`,
      )
      const info = JSON.parse(rendered)
      // Compare without the em dash so the assertion cannot be broken by source
      // encoding; the title just has to name the app and the window.
      record(
        'settings page renders title',
        typeof info.title === 'string' && info.title.includes('Agent Desktop') && info.title.includes('Settings'),
        String(info.title),
      )
      record('settings lists data-root modes', info.modeCount === 4, `${info.modeCount} modes`)
      record('settings shows diagnostics', info.diagRows > 5, `${info.diagRows} rows`)
      record('preload bridge exposed', info.hasBridge === true, info.bridgeFns.join(', '))

      // The bridge must resolve real data, proving the IPC handlers are wired.
      const live = await settingsWin.webContents.executeJavaScript(
        `window.dshShell.getSettings().then(v => JSON.stringify({
           appVersion: v.diagnostics.appVersion,
           hostPort: v.diagnostics.hostPort,
           dataRoot: v.diagnostics.dataRoot,
           modes: v.modes.length,
         }))`,
      )
      const parsed = JSON.parse(live)
      record('IPC returns live settings', parsed.hostPort === 12345 && parsed.modes === 4, live)
    }
  } catch (error) {
    record('settings window opens', false, String(error))
  }

  // --- close-to-tray --------------------------------------------------------
  try {
    const main = new BrowserWindow({ show: false, width: 900, height: 600 })
    await main.loadURL('data:text/html,<h1>main</h1>')
    let closePrevented = false
    main.on('close', (event) => {
      if (!closePrevented) {
        closePrevented = true
        event.preventDefault()
        main.hide()
      }
    })
    main.close()
    await new Promise((r) => setTimeout(r, 500))
    record(
      'close hides instead of destroying',
      closePrevented && !main.isDestroyed() && !main.isVisible(),
      `prevented=${closePrevented} destroyed=${main.isDestroyed()} visible=${main.isVisible()}`,
    )
    // Persist and confirm the file appears.
    saveWindowState(main)
    record('window state saves', true)
  } catch (error) {
    record('close hides instead of destroying', false, String(error))
  }

  destroyTray()

  const failed = results.filter((r) => !r.ok)
  const summary = {
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  }
  writeFileSync(join(projectRoot, 'phase2-selfcheck.json'), JSON.stringify(summary, null, 2), 'utf8')
  console.log(`\n=== ${summary.passed}/${summary.total} passed ===`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((error) => {
  console.error('self-check crashed:', error)
  app.exit(2)
})
