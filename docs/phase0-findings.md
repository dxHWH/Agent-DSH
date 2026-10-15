# Phase 0 findings

English | [中文](phase0-findings.zh.md)

> Environment: Windows, Node v24.21.0, Electron 33.4.11, `@deepseek-ai/dsh@0.1.5-rc.2`
> Experiment code: `src/main/probe.ts`; raw output: `phase0-*.json`

---

## Terminology

| Term | Meaning |
|---|---|
| boot graph | The manifest of which client plugins to load, delivered via `window.__DSH_BOOT__` |
| facade | The entry object the browser side loads plugins through (`__ModuleLoader__` here) |
| `did-fail-load` | The Electron event fired when a page or resource fails to load |
| origin | The browser security triple of scheme + host + port |
| opaque origin | A special origin such as `file://` that cannot be compared for sameness |
| in-process | Called by direct `import`, rather than by spawning a child process |
| ESM | ECMAScript modules — the standard `import`/`export` format |
| prepare callback | The hook `boot()` invokes before it mounts the plugin tree |

---

## Summary

| Experiment | Hypothesis | Measured | Verdict |
|---|---|---|---|
| 1. Load `dist` over `file://` | ES modules with `crossorigin` would be blocked by CORS | **Hypothesis wrong** — modules loaded fine | Disproved |
| 2. Load a real URL | Feasible | Depends on experiment 3 | — |
| 3. Import the DSH boot library in-process | Feasible | **Fully feasible** | Confirmed |

**Chosen architecture: plan A (Electron embeds an HTTP server and loads a real URL) — the conclusion stands, but the reasoning had to be corrected.**

The original reasoning was wrong. The corrected reasoning follows. **The choice
itself did not change**, because it rests on experiment 3, not on the disproved
CORS assumption.

---

## Experiment 1: loading the frontend `dist` over `file://`

**Command**
```
npx electron . --probe=file
```

**Raw output**
```json
{
  "probe": "file",
  "ok": true,
  "distIndex": "<repo>\\node_modules\\@deepseek-ai\\dsh-web-frontend\\dist\\index.html",
  "dom": {
    "rootChildren": 1,
    "hasBoot": false,
    "hasLoader": false
  },
  "failures": [],
  "corsSuspicious": [
    "[3] Error: web boot: window.__ModuleLoader__ bootstrap facade is missing (file:///<repo>/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BKQ_L1z6.js:114)"
  ],
  "totalConsoleMessages": 2
}
```

**Analysis**

- `failures: []` — **no `did-fail-load` at all**. The entire ES module graph
  (`index-BKQ_L1z6.js` + `vendor-CCJJTK99.js`) loaded and executed.
- `rootChildren: 1` — **React mounted successfully** into `#root`.
- `totalConsoleMessages: 2` — two messages, no CORS/CSP errors.

**My original judgement was wrong.** I predicted that
`<script type="module" crossorigin>` would be blocked by CORS under a `file://`
origin. Measurement shows Electron 33 allows module loading over `file://` by
default — presumably Chromium exempts module requests from the `file://` opaque
origin (treating it as same-origin with itself). **That judgement is void.**

- The actual failure point is: `window.__ModuleLoader__ bootstrap facade is missing`

This matches the research exactly: `dist/index.html` is 17 lines of plain static
HTML containing **neither `__DSH_BOOT__` nor `__ModuleLoader__`**. Both are
injected by `dsh web` at serve time through `ctx.webServer.renderIndex()`. Under
`file://` there is no server, so nothing injects them and bootstrap fails.

**What was disproved is the reasoning, not the conclusion**: `file://` genuinely
does not work, but because **the boot injection is missing**, not because the
transport is blocked.

---

## Experiment 3: importing the DSH boot library in-process

**Command**
```
npx electron . --probe=boot
```

**Raw output (excerpt)**
```json
{
  "probe": "boot",
  "ok": true,
  "exports": [
    "DEFAULT_PROFILE_BUNDLES", "DEFAULT_PROFILE_PATCH_RELOAD",
    "FAIL_LOUD_RELEASE_TIMEOUT_MS", "HARNESS_SOURCE_SECTION",
    "PROFILES_DIR", "PROFILE_PATCH_FILENAME", "PROFILE_TEMPLATES",
    "addHarnessSourceSection", "assertEntriesActivated", "assertEntriesLoaded",
    "boot", "composeEntries", "healProfilesModuleFallback", "initProfile",
    "installFailLoud", "loadEnv", "loadLayeredEnv", "loadOptionalPatches",
    "loadOverlayPatches", "loadProfile", "loadProfileDirectory",
    "mountRootInclude", "readProfileManifest", "renderConfigDump",
    "resolveBundleDir", "resolveConfigPath", "resolveProfileDir",
    "watchUserPatches", "writeProfileManifest"
  ],
  "hasLoadProfileDirectory": true,
  "hasBoot": true
}
```

**Analysis**

- `@deepseek-ai/dsh-app-boot` can be `import`ed directly from the Electron main process.
- `loadProfileDirectory`, `boot`, `composeEntries`, `initProfile` and the rest are
  all publicly available, matching the research.
- **Precondition**: the main process must be **ESM**. Every DSH package is
  `"type": "module"`, and a CommonJS build fails with `ERR_REQUIRE_ESM` (hit
  during these experiments). Electron 28+ supports an ESM main process; Electron
  33 works.

**Confirmed exact signatures**

```ts
boot(
  binName: string,
  absoluteConfigPath: string,
  patches?: PatchOptions[],
  prepare?: (ctx: Context) => Promise<void> | void,
  bareModuleBaseUrl?: string,
): Promise<Context>

loadProfileDirectory(
  binName: string,
  dir: string,
  installAnchor: string,
  options?: { userLayer?: boolean },
): Profile
```

---

## The boot pattern used for Phase 1 (extracted from the real `dsh web`)

`runProfile()` in `dsh/lib/profile-boot-Dk-7KqJc.js` is the reliable blueprint.
Key steps:

1. `loadProfile(NAME, name, INSTALL_ANCHOR, home?, { userLayer })` loads the profile
2. `writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)`
   resets the root config to `[]`
3. Layer order (**order is precedence; later layers win**):
   ```
   bundlePatches -> profile.patches -> homePatches -> overlays -> telemetryPatch
   ```
4. `composeEntries([...])` yields the effective entry list
5. `boot(NAME, rootConfig, structuredClone(allPatches), (hostCtx) => { ... })`
6. Inside the `prepare` callback:
   - `hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)`
   - `provideCmdline(hostCtx, { args, exit, ready })`
7. `installFailLoud` wraps fatal errors; SIGTERM/SIGINT trigger `fiber.dispose()`

**The desktop shell's strategy**: use `loadProfileDirectory` instead of
`loadProfile`, pointing at an application-owned profile directory. That bypasses
the CLI's reservation of the `desktop` name — which is exactly the use the
upstream README documents for that function.

---

## Corrections to the plan document

The argument in `PLAN-desktop-client.zh.md` that "`file://` will fail due to
CORS" **has been disproved by measurement** and should read "`file://` lacks the
boot injection". Plan A's conclusion is unchanged.

Newly confirmed technical constraints:
- **The main process must be ESM** (otherwise DSH cannot be imported)
- Electron 33 supports an ESM main process

> **Later revision (Phase 1 measurement)**: Electron 33, used during these
> experiments, can import the boot library but **cannot actually load the DSH
> plugin tree** — it bundles Node 20, which lacks `zlib.createZstdCompress`,
> `util.getSystemErrorMessage`, and `module.stripTypeScriptTypes`. The real
> floor is **Electron 37 (Node 22.21.1)**. See `phase1-notes.md`.

---

## What remained unverified

- **Full in-process serve**: `loadProfileDirectory` + `boot` had not yet been
  driven far enough to serve an accessible HTTP endpoint and read the port back.
  This was Phase 1's first task and the last unverified link in plan A.
  (**Now done** — see `phase1-notes.md`.)
- **npm 11 blocking install scripts**: in this environment `npm install` blocked
  six packages' install scripts (the Electron binary, `dsh-subprocess-local`'s
  spawn helper, `koffi`, `node-pty`, `protobufjs`, `@google/genai`). All were
  approved via `npm install-scripts approve`. `node-pty` in fact ships
  `prebuilds/win32-x64/`, so no local compilation is needed; those native
  binaries must be `asarUnpack`ed when packaging (see `phase1-notes.md`).
