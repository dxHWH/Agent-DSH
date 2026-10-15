/**
 * Preload for the settings window.
 *
 * The main window deliberately has **no** preload: it runs DSH's own UI, which
 * needs no shell privileges. This window is different — it renders shell-owned
 * controls — so it gets a preload exposing exactly the settings API and nothing
 * else.
 *
 * The surface is intentionally a fixed set of named operations rather than a
 * generic `invoke(channel, ...)`: the renderer cannot reach an IPC channel this
 * file does not name, so a compromised settings page still cannot call arbitrary
 * main-process handlers.
 */
import { contextBridge, ipcRenderer } from 'electron'

/** Mirrors `ShellSettingsView` in the main process. */
interface ShellSettingsView {
  diagnostics: {
    appVersion: string
    electronVersion: string
    nodeVersion: string
    chromeVersion: string
    dshVersion: string
    dataRoot: string
    dataRootMode: string
    dataRootLabel: string
    shellConfigPath: string
    portableRoot: string
    profileDir: string
    hostPort: number | null
    isPackaged: boolean
    contents: string[]
    locale: string
    localeIsAutomatic: boolean
  }
  modes: { value: string; label: string; description: string }[]
  current: { dataRootMode: string; customPath?: string }
}

const api = {
  /** Read the current settings and diagnostics. */
  getSettings: (): Promise<ShellSettingsView> => ipcRenderer.invoke('shell:get-settings'),

  /**
   * Change where user data lives.
   *
   * Takes effect on the next launch: DSH resolves its home at import time, so a
   * running host cannot be relocated.
   */
  setDataRoot: (
    mode: string,
    customPath?: string,
  ): Promise<{ ok: boolean; canceled?: boolean; requiresRestart?: boolean; error?: string; view?: ShellSettingsView }> =>
    ipcRenderer.invoke('shell:set-data-root', mode, customPath),

  /** Reveal the DSH data folder in the system file manager. */
  openDataRoot: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('shell:open-data-root'),

  /** Reveal one of the known shell locations. */
  openPath: (target: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:open-path', target),

  /** Relaunch the application so a changed data root takes effect. */
  restart: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('shell:restart'),

  /** Bring the main DSH window to the front, where its own settings live. */
  focusMainWindow: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:focus-main-window'),

  /** MCP server configuration for agent presets. */
  mcp: {
    listPresets: (): Promise<{ ok: boolean; presets?: { id: string; hasConfig: boolean }[]; error?: string }> =>
      ipcRenderer.invoke('shell:mcp:list-presets'),

    getServers: (presetId: string): Promise<{ ok: boolean; servers?: unknown[]; parseError?: string; error?: string }> =>
      ipcRenderer.invoke('shell:mcp:get-servers', presetId),

    addServer: (presetId: string, entry: unknown): Promise<{ ok: boolean; requiresRestart?: boolean; error?: string }> =>
      ipcRenderer.invoke('shell:mcp:add-server', presetId, entry),

    updateServer: (presetId: string, id: string, entry: unknown): Promise<{ ok: boolean; requiresRestart?: boolean; error?: string }> =>
      ipcRenderer.invoke('shell:mcp:update-server', presetId, id, entry),

    removeServer: (presetId: string, id: string): Promise<{ ok: boolean; requiresRestart?: boolean; error?: string }> =>
      ipcRenderer.invoke('shell:mcp:remove-server', presetId, id),

    test: (entry: unknown): Promise<{ ok: boolean; serverName?: string; serverInfo?: { name: string; version: string }; protocolVersion?: string; tools?: { name: string; description: string }[]; error?: string }> =>
      ipcRenderer.invoke('shell:mcp:test', entry),
  },

  /** Bound project directory (dsh-tool-example projectRoot). */
  project: {
    get: (presetId: string): Promise<{ ok: boolean; projectRoot?: string; reportDir?: string; error?: string }> =>
      ipcRenderer.invoke('shell:project:get', presetId),

    set: (presetId: string, projectRoot: string): Promise<{ ok: boolean; requiresRestart?: boolean; projectRoot?: string; error?: string }> =>
      ipcRenderer.invoke('shell:project:set', presetId, projectRoot),

    browse: (): Promise<{ ok: boolean; canceled?: boolean; path?: string }> =>
      ipcRenderer.invoke('shell:project:browse'),

    /** Query the configuration index status for a project root. */
    indexStatus: (projectRoot: string): Promise<{ ok: boolean; snapshot?: unknown; error?: string }> =>
      ipcRenderer.invoke('shell:index:status', projectRoot),

    /** Start an index rebuild; completion arrives via `onIndexProgress`. */
    indexRebuild: (projectRoot: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('shell:index:rebuild', projectRoot),

    /** Cancel a running rebuild; the previous index generation stays in use. */
    indexCancel: (projectRoot: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('shell:index:cancel', projectRoot),

    /**
     * Subscribe to rebuild progress. Returns an unsubscribe function.
     * The listener receives `{ projectRoot, phase, completed, total, current, status?, error? }`.
     */
    onIndexProgress: (listener: (event: unknown) => void): (() => void) => {
      const wrapped = (_event: unknown, payload: unknown) => listener(payload)
      ipcRenderer.on('shell:index:progress', wrapped)
      return () => ipcRenderer.removeListener('shell:index:progress', wrapped)
    },
  },

  /** WeCom bot authorization for dislike-archive uploads. */
  wecom: {
    status: (): Promise<{ ok: boolean; cli?: { cmd: string; source: string }; authorized?: boolean; botId?: string; configDir: string; error?: string }> =>
      ipcRenderer.invoke('shell:wecom:status'),

    /** Verify online in a staging dir, then replace the stored credentials. */
    authorize: (botId: string, secret: string): Promise<{ ok: boolean; botId?: string; error?: string; errcode?: number }> =>
      ipcRenderer.invoke('shell:wecom:authorize', botId, secret),

    logout: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('shell:wecom:logout'),
  },
}

contextBridge.exposeInMainWorld('dshShell', api)
