/**
 * Project-index management for the settings window.
 *
 * Owns querying and rebuilding the `dsh-tool-example` SQLite project index
 * that lives under `{projectRoot}/.agent-index`. The heavy lift is delegated
 * to `dsh-tool-example`'s `ProjectIndex`.
 *
 * This settings-window rebuild is the ONLY place the index is built: the
 * agent's query path uses `checkCurrent()`, which never builds, and falls back
 * to reading source files with a "rebuild in Settings" hint.
 *
 * Rebuilds run in a worker thread. Progress is pushed to the settings window
 * over `webContents.send('shell:index:progress', …)`, throttled so a fast build
 * cannot flood the IPC channel. One rebuild runs per project (keyed by the
 * normalized path, so `D:\x` and `d:/x/` are the same project), it can be
 * cancelled, and a worker that dies without reporting still settles the UI.
 */

import { BrowserWindow } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { IndexCoverage, IndexStatus } from '@deepseek-ai/dsh-tool-example'

/** A point-in-time snapshot of one project's index, for the settings UI. */
export interface IndexSnapshot {
  projectRoot: string
  /** Absolute path to the index directory (`…/.agent-index`). */
  indexDir: string
  exists: boolean
  status: IndexStatus | null
  /** Build time, size and what the current generation covers. */
  coverage: IndexCoverage | null
  /** True when a rebuild is currently running for this project. */
  building: boolean
  /** Error from the last status attempt, if any. */
  error?: string
}

/** Progress event pushed to the renderer during a rebuild. */
export interface IndexProgressEvent {
  projectRoot: string
  phase: 'building' | 'finalizing' | 'done' | 'error' | 'cancelled'
  completed: number
  total: number
  current: string
  status?: IndexStatus
  coverage?: IndexCoverage | null
  error?: string
  /** Wall-clock seconds since the rebuild started. */
  elapsed?: number
}

/** Resolve the settings window to push progress to (injected by settings.ts). */
type WindowResolver = () => BrowserWindow | null

let windowResolver: WindowResolver = () => null

/** Called by settings.ts once the settings window exists. */
export function setIndexWindowResolver(resolver: WindowResolver): void {
  windowResolver = resolver
}

/** The index directory for a project root. */
export function indexDirFor(projectRoot: string): string {
  return join(projectRoot, '.agent-index')
}

/** Canonical key for a project root: resolved, no trailing separator, case-folded on Windows. */
function projectKey(projectRoot: string): string {
  let p = resolve(projectRoot)
  while (p.length > 3 && (p.endsWith('\\') || p.endsWith('/'))) p = p.slice(0, -1)
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/**
 * Load `dsh-tool-example` on first use rather than at module load.
 *
 * This module is imported (via settings.ts) before the DSH host boots and
 * before `DSH_HOME` is set; a static import would drag the whole DSH tool
 * graph into startup. The settings window only needs it when the user checks
 * or rebuilds an index.
 */
let toolModule: Promise<typeof import('@deepseek-ai/dsh-tool-example')> | null = null
function loadTool(): Promise<typeof import('@deepseek-ai/dsh-tool-example')> {
  toolModule ??= import('@deepseek-ai/dsh-tool-example')
  return toolModule
}

/**
 * Rewrite an `app.asar` path to its unpacked twin, so a worker-thread script can
 * be loaded from a real file on disk.
 *
 * `new Worker()` loads its script through Node's module loader, which — unlike
 * Electron's fs shim — cannot read from inside the asar archive. `asarUnpack`
 * copies such files to `app.asar.unpacked`, and the URL is still reported under
 * `app.asar`, so we rewrite the segment exactly as `host.ts` does for spawned
 * helpers. In a source checkout there is no asar, so this is a no-op.
 */
function unpackAsarPath(anchor: string): string {
  const asarSegment = `app.asar${sep}`
  if (!anchor.includes(asarSegment)) return anchor
  const unpacked = anchor.replace(asarSegment, `app.asar.unpacked${sep}`)
  return existsSync(unpacked) ? unpacked : anchor
}

interface RunningRebuild {
  projectRoot: string
  worker: Worker
  startedAt: number
  cancelled: boolean
}

/** Rebuild bookkeeping: one in-flight rebuild per normalized project root. */
const inFlight = new Map<string, RunningRebuild>()

/** Minimum interval between forwarded progress events. */
const PROGRESS_THROTTLE_MS = 150

/**
 * Query a project's index status without touching it.
 *
 * Constructs an index handle (cheap — nothing is built) and reads
 * `status()` plus `coverage()`.
 */
export async function indexStatus(projectRoot: string): Promise<IndexSnapshot> {
  const indexDir = indexDirFor(projectRoot)
  const snapshot: IndexSnapshot = {
    projectRoot,
    indexDir,
    exists: existsSync(indexDir),
    status: null,
    coverage: null,
    building: inFlight.has(projectKey(projectRoot)),
  }

  if (!projectRoot || !existsSync(projectRoot)) {
    snapshot.error = 'project directory does not exist'
    return snapshot
  }

  try {
    const { ProjectIndex } = await loadTool()
    const index = new ProjectIndex(projectRoot)
    snapshot.status = index.status()
    snapshot.coverage = index.coverage()
  } catch (e) {
    snapshot.error = String(e)
  }

  return snapshot
}

/**
 * Rebuild a project's index in the background, streaming progress to the
 * settings window.
 *
 * Returns immediately with `{ started: true }`; the caller subscribes to
 * `shell:index:progress` events for completion. Refuses when a rebuild is
 * already running for this project.
 */
export function startRebuild(projectRoot: string): { started: boolean; error?: string } {
  if (!projectRoot || !existsSync(projectRoot)) {
    return { started: false, error: 'project directory does not exist' }
  }
  const key = projectKey(projectRoot)
  if (inFlight.has(key)) {
    return { started: false, error: 'a rebuild is already running for this project' }
  }

  // No rebuild is in flight for this project, so a lock naming our own pid is a
  // leftover from a terminated/crashed worker — drop it instead of letting the
  // new build busy-wait on it.
  try {
    const lock = JSON.parse(readFileSync(join(indexDirFor(projectRoot), 'build.lock'), 'utf8'))
    if (Number(lock?.pid) === process.pid) releaseOrphanLock(projectRoot)
  } catch {
    // no lock / unreadable — nothing to do
  }

  const startedAt = Date.now()
  const elapsed = () => Math.round((Date.now() - startedAt) / 100) / 10

  const push = (event: IndexProgressEvent) => {
    const win = windowResolver()
    if (win && !win.isDestroyed()) {
      win.webContents.send('shell:index:progress', { ...event, elapsed: elapsed() })
    }
  }

  // Run the heavy synchronous build in a worker thread so the main-process
  // event loop stays responsive. The worker script must be resolved through the
  // unpacked asar path when packaged.
  const workerScriptPath = unpackAsarPath(join(dirname(fileURLToPath(import.meta.url)), 'index-rebuild-worker.js'))
  const worker = new Worker(pathToFileURL(workerScriptPath))
  const run: RunningRebuild = { projectRoot, worker, startedAt, cancelled: false }
  inFlight.set(key, run)

  let settled = false
  const settle = (event: IndexProgressEvent) => {
    if (settled) return
    settled = true
    push(event)
  }

  let lastProgressAt = 0
  let pendingProgress: IndexProgressEvent | null = null
  let progressTimer: NodeJS.Timeout | null = null
  const flushProgress = () => {
    progressTimer = null
    if (pendingProgress && !settled) push(pendingProgress)
    pendingProgress = null
    lastProgressAt = Date.now()
  }

  worker.on('message', (message: unknown) => {
    const m = message as { type?: string; completed?: number; total?: number; current?: string; status?: IndexStatus; coverage?: IndexCoverage | null; error?: string }
    if (!m || typeof m.type !== 'string') return
    if (m.type === 'progress') {
      pendingProgress = { projectRoot, phase: 'building', completed: m.completed ?? 0, total: m.total ?? 0, current: m.current ?? '' }
      const wait = PROGRESS_THROTTLE_MS - (Date.now() - lastProgressAt)
      if (wait <= 0) flushProgress()
      else progressTimer ??= setTimeout(flushProgress, wait)
    } else if (m.type === 'finalizing') {
      push({ projectRoot, phase: 'finalizing', completed: 0, total: 0, current: m.current ?? '' })
    } else if (m.type === 'done') {
      settle({ projectRoot, phase: 'done', completed: 0, total: 0, current: '', status: m.status, coverage: m.coverage ?? null })
    } else if (m.type === 'error') {
      settle({ projectRoot, phase: 'error', completed: 0, total: 0, current: '', error: m.error })
    }
  })

  worker.on('error', (e) => {
    settle({ projectRoot, phase: 'error', completed: 0, total: 0, current: '', error: String(e) })
  })

  worker.on('exit', (code) => {
    if (progressTimer) clearTimeout(progressTimer)
    inFlight.delete(key)
    if (run.cancelled) {
      settle({ projectRoot, phase: 'cancelled', completed: 0, total: 0, current: '' })
    } else if (!settled) {
      // A worker that crashes (OOM, native abort) may exit without posting
      // `done`/`error` and without releasing its lock; never leave the progress
      // modal hanging or the next rebuild blocked on a dead lock.
      releaseOrphanLock(projectRoot)
      settle({ projectRoot, phase: 'error', completed: 0, total: 0, current: '', error: `index worker exited unexpectedly (code ${code})` })
    }
  })

  worker.postMessage({ type: 'rebuild', projectRoot })

  return { started: true }
}

/**
 * Cancel a running rebuild.
 *
 * The build is a synchronous loop inside the worker, so cancellation terminates
 * the thread. That is safe: the new generation is written to its own file and
 * `current.json` only flips after a successful build, so the previous index
 * stays in use. The orphaned lock file names this process's pid and is reclaimed
 * on the next rebuild (see `releaseOrphanLock`), and the half-written generation
 * file is removed by the next successful build's cleanup.
 */
export async function cancelRebuild(projectRoot: string): Promise<{ ok: boolean; error?: string }> {
  const run = inFlight.get(projectKey(projectRoot))
  if (!run) return { ok: false, error: 'no rebuild is running for this project' }
  run.cancelled = true
  await run.worker.terminate()
  releaseOrphanLock(run.projectRoot)
  return { ok: true }
}

/**
 * Remove the build lock a terminated worker left behind.
 *
 * Worker threads share the main process's pid, so the lock's pid-liveness
 * check would consider it held forever; once we know no rebuild is running for
 * this project, the lock is ours to drop.
 */
function releaseOrphanLock(projectRoot: string): void {
  try {
    rmSync(join(indexDirFor(projectRoot), 'build.lock'), { force: true })
  } catch {
    // ignore
  }
}

/** Terminate every running rebuild (app quit). */
export async function cancelAllRebuilds(): Promise<void> {
  await Promise.all([...inFlight.values()].map((run) => cancelRebuild(run.projectRoot)))
}
