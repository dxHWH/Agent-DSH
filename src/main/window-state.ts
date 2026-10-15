/**
 * Window state persistence.
 *
 * Remembers size, position, and maximized state across restarts, and keeps the
 * window on a visible display — a saved position from a monitor that is no
 * longer attached would otherwise open the window off-screen and look like a
 * failure to launch.
 */
import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

const DEFAULTS: WindowState = { width: 1280, height: 840, maximized: false }
const MIN_WIDTH = 720
const MIN_HEIGHT = 480

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function read(): WindowState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<WindowState>
    return {
      width: typeof parsed.width === 'number' ? Math.max(MIN_WIDTH, parsed.width) : DEFAULTS.width,
      height: typeof parsed.height === 'number' ? Math.max(MIN_HEIGHT, parsed.height) : DEFAULTS.height,
      x: typeof parsed.x === 'number' ? parsed.x : undefined,
      y: typeof parsed.y === 'number' ? parsed.y : undefined,
      maximized: parsed.maximized === true,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/**
 * Whether a saved rectangle still overlaps a connected display.
 *
 * A window restored entirely outside every work area is unreachable, so the
 * position is dropped and Electron centres it instead.
 */
function isVisibleOnSomeDisplay(state: WindowState): boolean {
  if (state.x === undefined || state.y === undefined) return false
  const candidate = {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
  } satisfies Rectangle
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    // Require a meaningful overlap, not a one-pixel sliver.
    const overlapX = Math.max(0, Math.min(candidate.x + candidate.width, area.x + area.width) - Math.max(candidate.x, area.x))
    const overlapY = Math.max(0, Math.min(candidate.y + candidate.height, area.y + area.height) - Math.max(candidate.y, area.y))
    return overlapX > 80 && overlapY > 80
  })
}

/** Window options restored from disk, safe to pass straight to BrowserWindow. */
export function restoreWindowState(): {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
} {
  const state = read()
  const visible = isVisibleOnSomeDisplay(state)
  return {
    width: state.width,
    height: state.height,
    ...(visible ? { x: state.x, y: state.y } : {}),
    maximized: state.maximized,
  }
}

/**
 * Persist the window's geometry.
 *
 * Called on resize/move (debounced by the caller) and once more on close, so a
 * crash mid-session loses at most the last few seconds of movement.
 */
export function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  try {
    // Bounds while maximized describe the maximized frame, which is not what a
    // restore should use — keep the last normal bounds instead.
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: win.isMaximized(),
    }
    writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch (error) {
    console.error('[dsh-desktop] could not persist window state:', error)
  }
}
