/**
 * The DSH host adapter — the ONLY module in this application allowed to import
 * from `@deepseek-ai/*`.
 *
 * DSH is `0.1.5-rc.2`, a release candidate. Concentrating every coupling here
 * keeps a future DSH upgrade a single-file change.
 *
 * ## How the host is started
 *
 * Rather than spawning `dsh web` as a child process and scraping its stdout for
 * the port, this boots DSH **in-process** through its own public boot library.
 * That is the path `dsh-app-boot` documents for "application-owned npm
 * projects, such as Electron's reserved Desktop profile", and it avoids both
 * the CLI's `desktop` name reservation and any stdout parsing.
 *
 * `loadProfileDirectory` is used instead of `loadProfile` precisely because it
 * loads an application-owned directory *without* resolving it through
 * `$DSH_HOME/profiles` — which is why the CLI is free to reject the `desktop`
 * name.
 *
 * ## Verified prerequisites
 *
 * - The Electron main process must be **ESM**: every DSH package is
 *   `"type": "module"`, and `require()` fails with `ERR_REQUIRE_ESM`.
 * - Electron must bundle **Node 22+**: DSH imports `zlib.createZstdCompress`,
 *   `util.getSystemErrorMessage`, and `module.stripTypeScriptTypes`, none of
 *   which exist in the Node 20 that ships with Electron 33. Electron 37
 *   (Node 22.21.1) is the verified floor.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { createRequire } from 'node:module'

/** An application-owned profile: a tiny npm project declaring its bundle stack. */
export interface HostOptions {
  /** The DSH home for this launch — must already be applied to `process.env`. */
  dshHome: string
  /** Absolute directory of this application's own `desktop` profile. */
  profileDir: string
  /** Progress sink for the splash/console. */
  onProgress?: (message: string) => void
}

/** A running in-process DSH host. */
export interface DshHost {
  /** The actual bound port — resolved after `port: 0` was requested. */
  port: number
  /** The one-shot launch token, when the composition exposes one. */
  token: string
  /** The authenticated URL a window should load. */
  authenticatedUrl(): string
  /**
   * Preset ids this composition actually resolves.
   *
   * Read from the live service rather than assumed, because the shipped set
   * changes between DSH builds — 0.1.5-rc.2 ships standard/ptc/minimal/cordis
   * only. An empty array means the answer could not be determined, which callers
   * must treat as "do not touch anything" rather than "nothing is available".
   */
  availablePresets(): Promise<readonly string[]>
  /** Dispose the DSH tree and settle the composed plugins. */
  dispose(): Promise<void>
}

/**
 * Enumerate the preset ids the live composition resolves.
 *
 * `agentPresets.list()` is the same call `resolve()` uses before it throws, so a
 * non-empty answer here is exactly the set the UI can offer. Every failure path
 * returns an empty array: a diagnostic that cannot run must never be mistaken
 * for a definitive "no presets exist".
 *
 * @param ctx - the composed host context.
 * @param onProgress - progress sink.
 * @returns the resolved preset ids, or an empty array when unavailable.
 */
async function readAvailablePresets(
  ctx: any,
  onProgress: (m: string) => void,
): Promise<readonly string[]> {
  try {
    const service = ctx?.get?.('agentPresets')
    if (typeof service?.list !== 'function') {
      onProgress('presets: agentPresets service not mounted')
      return []
    }
    const listed = await service.list()
    const ids = Array.isArray(listed)
      ? listed.map((p: any) => (typeof p === 'string' ? p : p?.id)).filter((id: unknown): id is string => typeof id === 'string')
      : []
    onProgress(`presets: ${ids.length} available (${ids.join(', ') || 'none'})`)
    return ids
  } catch (error) {
    onProgress(`presets: enumeration failed: ${String(error).slice(0, 160)}`)
    return []
  }
}

/**
 * Point the DSH installation at its unpacked copy when running from an asar.
 *
 * ## Why this is necessary
 *
 * Several DSH packages spawn child processes that live inside their own package
 * directory. The clearest case is the directory picker, which runs
 * `lib/worker.cjs` as a child to drive the Win32 folder dialog. It locates that
 * file from its own `import.meta.url`.
 *
 * Under Electron the URL of an unpacked entry is still reported as
 * `…/app.asar/…`, because `asarUnpack` COPIES to `app.asar.unpacked` rather than
 * moving. `spawn` cannot execute a path that exists only inside the archive, so
 * the child dies immediately and the picker reports
 * "win32 folder dialog worker exited before reporting a result".
 *
 * Rewriting the anchor to the unpacked directory means every path DSH derives
 * from it — worker scripts, native addons, its own manifests — resolves to a
 * real file on disk.
 *
 * In a source checkout there is no asar, so this is a no-op.
 */
function useUnpackedDshTree(anchor: string): string {
  const asarSegment = `app.asar${sep}`
  if (!anchor.includes(asarSegment)) return anchor

  const unpacked = anchor.replace(asarSegment, `app.asar.unpacked${sep}`)
  // Only adopt the rewrite when the unpacked tree actually exists; otherwise the
  // original path is the only thing that can work.
  return existsSync(unpacked) ? unpacked : anchor
}

/**
 * Locate the running dsh installation's `package.json`, which every boot API
 * takes as its `installAnchor`.
 *
 * Resolved through package exports so the application keeps working after a DSH
 * upgrade and on a machine that never had a global `dsh` install.
 */
function resolveInstallAnchor(): string {
  const require = createRequire(import.meta.url)
  return useUnpackedDshTree(require.resolve('@deepseek-ai/dsh/package.json'))
}

/** The bundled web profile template, used to seed our own profile directory. */
function webTemplateBundles(boot: Record<string, any>): string[] {
  const template = boot.PROFILE_TEMPLATES?.web
  const bundles = template?.bundles
  if (!Array.isArray(bundles) || bundles.length === 0) {
    throw new Error(
      'dsh-host: the shipped web profile template exposed no bundle list; ' +
        'the DSH installation does not match what this shell expects.',
    )
  }
  return bundles as string[]
}

/**
 * Ensure our application-owned profile directory exists and declares the bundle
 * stack our desktop composition needs.
 *
 * The composition mirrors the shipped `web` bundle: the shell deliberately
 * reuses DSH's own UI and host rather than reimplementing either, so the same
 * bundle list applies. Only the shell-owned overrides differ (see
 * `buildDesktopPatches`).
 */
function ensureProfile(
  boot: Record<string, any>,
  profileDir: string,
  onProgress: (m: string) => void,
): void {
  const manifestPath = join(profileDir, 'package.json')
  if (existsSync(manifestPath)) {
    onProgress(`profile: reusing ${profileDir}`)
    return
  }
  onProgress(`profile: initializing ${profileDir}`)
  const bundles = webTemplateBundles(boot)
  boot.initProfile(profileDir, bundles, 'live')
  // `initProfile` writes the manifest, patch layer, and pnpm workspace files.
}

/** The composition root config filename, matching DSH's own launcher. */
const PROFILE_ROOT_FILENAME = 'cordis.yml'

/** A minimal app-ready signal, mirroring `dsh-cmdline`'s `AppReady`. */
interface AppReadyKit {
  service: { onReady(listener: () => void): () => void }
  commit(): void
}

/**
 * Build the readiness signal DSH's app plugins accept.
 *
 * Lifecycle work registered through `onReady` must run only after a successful
 * boot, and must never mask a boot failure — so nothing fires until `commit()`.
 */
function createAppReady(onProgress: (m: string) => void): AppReadyKit {
  const listeners = new Set<() => void>()
  let committed = false
  return {
    service: {
      onReady: (listener: () => void) => {
        if (committed) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    commit: () => {
      if (committed) return
      committed = true
      for (const listener of listeners) {
        try {
          listener()
        } catch (error) {
          onProgress(`ready listener failed: ${String(error)}`)
        }
      }
      listeners.clear()
    },
  }
}

/**
 * Boot DSH in-process on an OS-assigned port.
 *
 * @returns a handle exposing the real port, the authenticated URL, and disposal.
 */
export async function startHost(options: HostOptions): Promise<DshHost> {
  const onProgress = options.onProgress ?? (() => {})
  const boot = (await import('@deepseek-ai/dsh-app-boot')) as unknown as Record<string, any>
  const installAnchor = resolveInstallAnchor()
  onProgress(`anchor: ${installAnchor}`)

  // Shutdown coordination: `exit` is what the composition's app plugins call
  // when they want the process to end; the shell decides what that means.
  const abort = new AbortController()
  const isAborted = (): boolean => abort.signal.aborted
  let disposed = false
  const requestExit = (code: number): void => {
    onProgress(`host requested exit (${code})`)
    abort.abort()
  }

  const appReady = createAppReady(onProgress)

  ensureProfile(boot, options.profileDir, onProgress)

  const profile = boot.loadProfileDirectory('dsh-desktop', options.profileDir, installAnchor)
  onProgress(`profile loaded: ${profile.layers?.length ?? 0} bundle layer(s)`)

  // DSH's own launcher rewrites the root config to an empty list each boot;
  // every entry comes from the patch stack instead.
  const rootConfig = join(profile.dir, PROFILE_ROOT_FILENAME)
  writeFileSync(rootConfig, '[]\n', 'utf8')

  const bundlePatches = (profile.layers ?? []).flatMap((layer: any) => layer.patches ?? [])
  const desktopPatches = buildDesktopPatches()
  const allPatches = [...bundlePatches, ...(profile.patches ?? []), ...desktopPatches]

  const ctx = await boot.boot(
    'dsh-desktop',
    rootConfig,
    structuredClone(allPatches),
    async (hostCtx: any) => {
      // Provide the launch facts the composition's app plugins inject against.
      // `dsh-web-app/startup` waits for `cmdlineArgs`, and the webserver waits
      // on `webStartup`, so omitting this leaves 11 entries pending forever.
      //
      // The arguments are not decoration: `web-startup` parses them into the
      // `webStartup` provider, and `web-runtime` reads `openBrowser` from it.
      // Passing `--no-open` is how the shell suppresses DSH's own browser
      // launch — a patch-level config override cannot reach it.
      const { provideCmdline } = await import('@deepseek-ai/dsh-cmdline')
      provideCmdline(hostCtx, {
        args: ['--no-open', '--port', '0'],
        exit: requestExit,
        ready: appReady.service,
      })

      const launchEnv = boot.DSH_LAUNCH_ENVIRONMENT_KEY
      if (launchEnv !== undefined && typeof hostCtx.provide === 'function') {
        hostCtx.provide(launchEnv, boot.loadLayeredEnv?.('dsh-desktop') ?? {})
      }
    },
  )

  const settled = (): boolean =>
    !isAborted() &&
    ctx?.fiber?.state === 2 &&
    typeof ctx.get === 'function' &&
    ctx.get('loader') !== undefined

  // Live patch reload is intentionally NOT wired up here. DSH's HMR service
  // requires Node's `--expose-internals`, which an Electron main process cannot
  // enable after launch; mounting it only produces a startup error. The profile
  // still uses `patchReload: live` so the row exists, but the shell does not
  // force the watcher on.

  if (settled()) appReady.commit()

  const port = readPort(ctx)
  onProgress(`listening on 127.0.0.1:${port}`)

  /*
   * Report where the directory picker's dialog worker actually lives.
   *
   * The picker spawns `lib/worker.cjs` from its own module location, and a
   * packaged host reports that location inside `app.asar` — where `spawn` cannot
   * execute it, so the child dies and the UI reports "win32 folder dialog worker
   * exited before reporting a result". Logging the resolved path here turns that
   * into a visible fact instead of a guess.
   */
  try {
    const requireFromHost = createRequire(import.meta.url)
    const pickerPkg = requireFromHost.resolve('@deepseek-ai/dsh-host-directory-picker-native/package.json')
    const workerPath = join(dirname(pickerPkg), 'lib', 'worker.cjs')

    // Match the archive SEGMENT, not the substring: `…/app.asar.unpacked/…`
    // also contains "app.asar", so a plain `includes` check misreports an
    // unpacked path as archived.
    const asarSegment = `${sep}app.asar${sep}`
    const insideAsar = workerPath.includes(asarSegment)
    onProgress(`picker worker: ${workerPath}`)
    onProgress(`picker worker inside asar: ${insideAsar}, exists: ${existsSync(workerPath)}`)

    /*
     * Reproduce the picker's spawn from inside the RUNNING host.
     *
     * Every isolated test of this spawn succeeded, so the failure depends on the
     * real host's state. Running the same spawn here — with the worker's own
     * stderr surfaced — is the last place the packaged failure can still be
     * observed and explained.
     */
    if (process.env.DSH_DESKTOP_PROBE_PICKER === '1') {
      const { spawn } = await import('node:child_process')
      const child = spawn(process.execPath, [workerPath], {
        env: { ...process.env, DSH_DIALOG_TITLE: 'probe' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      })
      let stderr = ''
      let stdout = ''
      child.stdout?.on('data', (d) => (stdout += d))
      child.stderr?.on('data', (d) => (stderr += d))
      child.on('message', (m: any) => {
        onProgress(`picker probe message: ${JSON.stringify(m)}`)
        if (m?.kind === 'showing') {
          try {
            child.send({ kind: 'close' })
          } catch {
            /* channel may be gone */
          }
        }
      })
      child.on('error', (e) => onProgress(`picker probe spawn error: ${String(e).slice(0, 200)}`))
      await new Promise<void>((resolve) => {
        const done = (): void => resolve()
        child.on('exit', (code, signal) => {
          onProgress(`picker probe exit: code=${code} signal=${signal}`)
          onProgress(`picker probe stderr: ${stderr.slice(0, 400) || '(empty)'}`)
          onProgress(`picker probe stdout: ${stdout.slice(0, 200) || '(empty)'}`)
          done()
        })
        setTimeout(() => {
          try {
            child.kill()
          } catch {
            /* ignore */
          }
          onProgress('picker probe timed out (dialog likely open)')
          done()
        }, 6000)
      })
    }
  } catch (error) {
    onProgress(`picker worker probe failed: ${String(error).slice(0, 140)}`)
  }

  // Report the client-plugin graph the host composed.
  //
  // The renderer requests exactly what this graph advertises, so an empty graph
  // there means `/plugins` answers 404 and the UI shows "Failed to load plugins".
  // Logging it host-side makes that failure visible at its source instead of
  // only as a renderer-side error.
  try {
    const modules = ctx?.get?.('clientModules')
    if (modules && typeof modules.graph === 'function') {
      const graph = modules.graph()
      const entries = graph?.entries?.length ?? 0
      onProgress(`client graph: ${entries} entries, ${graph?.batches?.length ?? 0} batches (rev ${graph?.rev ?? 'none'})`)
      if (entries === 0) {
        // Enumerate what the scan had to work with.
        //
        // `loader.entries()` is a GENERATOR, so `Array.isArray` reports -1 for a
        // perfectly healthy loader. Spread it instead.
        const loader = ctx?.get?.('loader')
        let loaderCount = -1
        try {
          const list = loader?.entries?.()
          loaderCount = list && typeof list[Symbol.iterator] === 'function' ? [...list].length : -1
        } catch (error) {
          onProgress(`loader enumeration failed: ${String(error)}`)
        }
        onProgress(`client graph is EMPTY — loader entries: ${loaderCount}`)

        // The scan keys off `entry.options.name`, and skips any entry whose
        // `fiber` is undefined (see processOne in client-modules). Report both,
        // because an entry list full of fiber-less rows is exactly what produces
        // an empty graph with a healthy-looking loader.
        try {
          const list = loader?.entries?.()
          if (list && typeof list[Symbol.iterator] === 'function') {
            const all = [...list]
            const withFiber = all.filter((e: any) => e?.fiber !== undefined)
            const disabled = all.filter((e: any) => e?.disabled === true)
            onProgress(`loader rows: ${all.length} total, ${withFiber.length} with fiber, ${disabled.length} disabled`)
            const names = withFiber
              .map((e: any) => e?.options?.name)
              .filter(Boolean)
              .slice(0, 6)
            onProgress(`rows with fiber: ${names.join(', ') || '(none)'}`)

            // `clientModules` composes its graph in its CONSTRUCTOR, seeding the
            // dirty set from `ctx.loader.entries()`, and has no full-rescan path.
            // If that constructor ran before the loader filled, the empty result
            // is frozen. Sampling the loader count over time distinguishes a
            // genuine late fill from a loader that was always populated.
            const loaderRowCount = all.length
            onProgress(`race check: graph=${entries} entries vs loader=${loaderRowCount} rows`)

            const sample = (ms: number): Promise<void> =>
              new Promise((resolve) => setTimeout(resolve, ms))
            const counts: number[] = []
            for (const delay of [1000, 2000]) {
              await sample(delay)
              try {
                const again = loader?.entries?.()
                counts.push(again && typeof again[Symbol.iterator] === 'function' ? [...again].length : -1)
              } catch {
                counts.push(-1)
              }
            }
            onProgress(`loader row count over time: ${loaderRowCount} -> ${counts.join(' -> ')}`)

            // The scan reports per-package failures through the module service's
            // own error sink. Ask the service directly which packages it holds,
            // because an empty graph with a full loader means every candidate was
            // rejected — and the reason lives in that per-package state.
            try {
              const svc: any = modules
              if (svc.sources instanceof Map) onProgress(`clientModules sources: ${svc.sources.size}`)
              if (svc.dirty instanceof Set) onProgress(`clientModules dirty: ${svc.dirty.size}`)

              /*
               * `sources` empty + `dirty` empty means every candidate was
               * processed and rejected. The service keeps `pkgMeta`, which is
               * keyed by package — inspect it directly rather than guessing why
               * a package was dropped.
               */
              if (svc.pkgMeta instanceof Map) {
                onProgress(`clientModules pkgMeta entries: ${svc.pkgMeta.size}`)
                const sample = [...svc.pkgMeta.entries()].slice(0, 2)
                for (const [pkg, meta] of sample) {
                  onProgress(`  meta ${String(pkg).slice(0, 90)}: ${JSON.stringify(meta)?.slice(0, 160)}`)
                }
              }

              // `locatePkgJson` prefers `loader.internal.resolveSync` and only
              // falls back to `createRequire(baseUrl)` when that internal is
              // absent. The fallback resolves against the PROFILE directory,
              // where no DSH package exists — which would explain an empty scan.
              try {
                const internal = (ctx as any)?.loader?.internal
                onProgress(
                  `loader.internal present: ${internal !== undefined}, resolveSync: ${typeof Reflect.get(internal ?? {}, 'resolveSync')}`,
                )
              } catch (error) {
                onProgress(`loader.internal probe failed: ${String(error).slice(0, 120)}`)
              }

              // Confirm the fallback's fate: resolve a client package from the
              // profile directory, exactly as the fallback would.
              try {
                const requireFromProfile = createRequire(join(options.profileDir, 'package.json'))
                const viaFallback = requireFromProfile.resolve('@deepseek-ai/dsh-client-modules/package.json')
                onProgress(`fallback resolve from profile SUCCEEDED: ${viaFallback}`)
              } catch (error) {
                onProgress(`fallback resolve from profile FAILED: ${String(error).slice(0, 140)}`)
              }
            } catch (error) {
              onProgress(`service introspection failed: ${String(error).slice(0, 120)}`)
            }
            if (entries === 0 && loaderRowCount > 0) {
              onProgress(
                counts.every((c) => c === loaderRowCount)
                  ? '=> the loader was ALREADY full when the graph was read; the scan missed it for another reason'
                  : '=> the loader kept growing; the constructor-time scan ran too early',
              )
            }

            // A row that DOES name a client plugin is the surgical probe: if
            // resolution works for it, the scan should have produced an entry,
            // and the fault lies further along; if it fails, the package lookup
            // is what breaks under packaging.
            const clientRow = withFiber.find((e: any) =>
              String(e?.options?.name ?? '').includes('dsh-client'),
            )
            if (clientRow) {
              const rowName = clientRow.options.name
              onProgress(`probe row: ${rowName}`)
              try {
                const requireFromHost = createRequire(import.meta.url)
                const resolved = requireFromHost.resolve(`${rowName}/package.json`)
                onProgress(`  package.json resolved: ${resolved}`)
                const manifest = JSON.parse(readFileSync(resolved, 'utf8'))
                const decl = manifest?.dsh?.client
                onProgress(`  dsh.client declaration: ${decl ? JSON.stringify(decl) : '(absent)'}`)
                const clientArtifact = join(dirname(resolved), 'lib', 'client.js')
                onProgress(`  client.js exists: ${existsSync(clientArtifact)}`)
              } catch (error) {
                onProgress(`  resolution FAILED: ${String(error).slice(0, 160)}`)
              }
            }
          }
        } catch {
          /* best-effort diagnostics */
        }
      }
    } else {
      onProgress('client graph unavailable: clientModules service not mounted')
    }
  } catch (error) {
    onProgress(`client graph probe failed: ${String(error)}`)
  }

  // The connection service owns the launch token and knows how to attach it.
  // Using its own `authenticatedUrl` keeps the token format DSH's business
  // rather than ours — we never reconstruct it by hand.
  const baseUrl = `http://127.0.0.1:${port}/`
  const connection = ctx?.get?.('connection')
  const authenticatedUrl =
    typeof connection?.authenticatedUrl === 'function'
      ? (): string => String(connection.authenticatedUrl(baseUrl))
      : (): string => baseUrl

  return {
    port,
    token: readToken(ctx),
    authenticatedUrl,
    availablePresets: () => readAvailablePresets(ctx, onProgress),
    dispose: async () => {
      if (disposed) return
      disposed = true
      abort.abort()
      await ctx?.fiber?.dispose()
    },
  }
}

/**
 * Desktop-specific overrides applied above every bundle layer.
 *
 * A patch entry's `config` **replaces** the row's composed config wholesale
 * rather than merging into it, so every field the row needs must be restated
 * here. Omitting `openBrowser` does not leave the bundle's value in place — it
 * falls back to the plugin's schema default (`true`), which makes DSH launch a
 * system browser behind the shell's back.
 *
 * `trustedHosts` stays empty: the window loads a loopback URL, which the
 * request-trust fence already accepts, and the shell never exposes the host to
 * the network.
 */
function buildDesktopPatches(): any[] {
  return [
    {
      id: 'web-runtime',
      config: {
        openBrowser: false,
        printUrl: false,
        surfaceContext: true,
        trustedHosts: [],
      },
    },
    // Feedback-archive plugin (host half): the archive HTTP route + the
    // `feedback-archive` settings namespace. Mounted on the HOST plane (not in a
    // preset) so sessions of every preset can be archived from the dislike
    // button.
    {
      insert: [
        {
          id: 'tool-feedback-archive',
          name: '@deepseek-ai/dsh-tool-feedback-archive',
        },
      ],
    },
    // Its client half re-implements Like/Dislike + the feedback dialog (Dislike
    // archives the turn), so the stock ui-message-feedback is disabled to avoid
    // duplicate buttons.
    {
      id: 'ui-message-feedback',
      disabled: true,
    },
  ]
}

/** Read the real bound port back from the composed tree. */
function readPort(ctx: any): number {
  const server = ctx?.get?.('webServer')
  const port = server?.port
  if (typeof port !== 'number' || !Number.isFinite(port) || port <= 0) {
    throw new Error(
      'dsh-host: the composed tree exposed no bound web server port. ' +
        'Is @deepseek-ai/dsh-host-webserver mounted in this profile?',
    )
  }
  return port
}
/**
 * Read the launch token for diagnostics only.
 *
 * The shell never needs it directly — {@link DshHost.authenticatedUrl} delegates
 * to the connection service — but logging its presence helps distinguish "no
 * token minted" from "token rejected" when troubleshooting a 401.
 */
function readToken(ctx: any): string {
  const connection = ctx?.get?.('connection')
  const token = connection?.browserAuth?.launchToken
  return typeof token === 'string' ? token : ''
}
