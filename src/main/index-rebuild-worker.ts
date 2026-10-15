/**
 * Worker entry for rebuilding the `dsh-tool-example` project index.
 *
 * Runs the heavy synchronous SQLite build off the Electron main thread, so the
 * main process event loop stays responsive and progress events reach the
 * settings window in real time (instead of piling up until the build returns).
 *
 * Message protocol (parent -> worker):
 *   { type: 'rebuild', projectRoot: string }
 *
 * Message protocol (worker -> parent):
 *   { type: 'progress', completed, total, current }
 *   { type: 'finalizing', current }
 *   { type: 'done', status, coverage }
 *   { type: 'error', error }
 *
 * Cancellation is `worker.terminate()` from the parent (see index-manager.ts).
 */

import { parentPort } from 'node:worker_threads'
import { ProjectIndex } from '@deepseek-ai/dsh-tool-example'

interface RebuildRequest {
  type: 'rebuild'
  projectRoot: string
}

parentPort?.on('message', (message: RebuildRequest) => {
  if (!message || message.type !== 'rebuild') return
  const { projectRoot } = message

  try {
    const index = new ProjectIndex(projectRoot)

    const status = index.rebuild((p: { completed: number; total: number; current: string }) => {
      // total < 0 marks the phases without a file count (scan, integrity check).
      if (p.total < 0) parentPort?.postMessage({ type: 'finalizing', current: p.current })
      else parentPort?.postMessage({ type: 'progress', completed: p.completed, total: p.total, current: p.current })
    })

    parentPort?.postMessage({ type: 'done', status, coverage: index.coverage() })
  } catch (e) {
    parentPort?.postMessage({ type: 'error', error: String(e) })
  } finally {
    // Close the port so the worker's event loop drains and the thread exits,
    // rather than lingering on the registered `message` listener.
    parentPort?.close()
  }
})
