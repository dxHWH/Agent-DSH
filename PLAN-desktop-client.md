# DSH Desktop — implementation plan

English | [中文](PLAN-desktop-client.zh.md)

> Status: **Phases 0–3 complete and measured**
> Target directory: `<repo>`
> Basis: a full read of the installed `@deepseek-ai/dsh@0.1.5-rc.2` artifacts (READMEs, package.json, compiled `lib`)

---

## Terminology

| Term | Meaning |
|---|---|
| profile | An ordered stack of bundles that decides which components boot |
| bundle | A patch-layer package, e.g. `dsh-base`, `dsh-web-app` |
| patch / overlay | An add/override/disable layer; later layers win |
| entry | One mounted plugin item in the composed tree |
| composition | The final plugin tree after every patch layer is applied |
| host | The DSH body running on the Node side |
| shell | This project — the Electron wrapper |
| boot graph | The manifest of client plugins to load, delivered via `window.__DSH_BOOT__` |
| launch token | A one-shot random credential minted per process launch |
| loopback | A host-only network address (`127.0.0.1`) |
| spawn | Create a child process |
| asar | Electron's packaging archive; files inside cannot be executed by path |
| HMR | Hot module replacement; edit code without restarting |

---

## Results

| Phase | Result | Evidence |
|---|---|---|
| 0 Feasibility | Complete; **the CORS hypothesis was disproved** | `docs/phase0-findings.md` |
| 1 Minimum viable client | End to end | Server listening + frontend JS `HTTP 200, 555,959 bytes` |
| 2 Desktop capabilities | Self-check **12/12** | `npm run selfcheck:shell` |
| 3 Packaging | Installer **110.8 MB**, asar verified | `release/DSH Desktop Setup 0.1.0.exe` |
| 3 Migration | Self-check **11/11** | `npm run selfcheck:portable` |
| Language (Chinese) | Self-check **15/15** | `npm run selfcheck:locale` |
| Feature parity | **152 : 152, zero difference** | `npm run audit:capabilities` |

**Key technical conclusions established during implementation:**

- **Electron 37+ is mandatory**: DSH needs three Node 22+ built-in exports
  (`zstd`, `getSystemErrorMessage`, `stripTypeScriptTypes`); Electron 33's Node 20
  cannot load the plugin tree.
- **The main process must be ESM.**
- **`provideCmdline` is mandatory**, or 11 entries stay pending forever.
- **A patch's `config` replaces wholesale, it does not merge** — the easiest trap to hit.
- **Only `insert:` adds rows**; a bare `- id:` targets an existing row and fails silently.

## Locked decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Architecture | **Plan A** (Electron embeds an HTTP server and loads a real URL) |
| 2 | DSH dependency | **Bundle a pinned DSH** (`0.1.5-rc.2`, shipped inside the installer) |
| 3 | Target platform | **Windows only** |
| 4 | Tray behavior | **Tray residency; closing the window minimizes to tray** |
| 5 | Configuration entry point | **Reuse DSH's own Settings UI**; the shell only does application-level config |
| 6 | Language | **Seed Chinese on first run**; never overwrite an existing choice |

---

## 1. Executive summary

**DSH reserves a place for a desktop client but does not implement one.** There is
a documented, deliberately named extension seam:

| Evidence | Source |
|---|---|
| The CLI rejects the `desktop` profile: `profile "desktop" is managed exclusively by the Electron application` | `dsh/lib/bin.js:28-30` |
| "Electron's reserved Desktop profile" loads its own directory via `loadProfileDirectory` | `dsh-app-boot/README.md:50` |
| "It serves browsers only; **Electron loads dist over `file://` and carries fetch over an IPC bridge**" | `dsh-host-webserver/README.md:12` |
| The client transport can be swapped by a shell: `ClientTransportHooks { fetch, openStream?, loadBundle?, ownsHost? }` | `dsh-client-connection/lib/types/client/index.d.ts:37-63` |
| The frontend `dist/` is a plain static artifact with **no server address compiled in** | Measured: `dsh-web-frontend/dist/index.html` |

**But no Electron or Tauri code ships at all**: every `@deepseek-ai` package has
zero Electron dependencies, and `PROFILE_TEMPLATES` contains only
`acp`/`web`/`headless`/`sdk`/`sdk-minimal` — no `desktop`.

**The core judgement of this plan:**

> Use an **Electron shell with an embedded real HTTP server, loading a real
> `127.0.0.1` URL in a `BrowserWindow`**.
>
> Do **not** use the `file://` + IPC fetch bridge the docs mention.

That judgement contradicts the upstream README's hint. Phase 0 measurement
**upheld the conclusion but corrected the reasoning** — see §4.2.

---

## 2. Verified technical facts

Everything below was confirmed by reading source/artifacts or by measurement, not
by inference.

### 2.1 The real shape of the `dsh` CLI

`dsh` is only a **profile launcher** with three commands:

- `dsh --profile <name>` — boots `$DSH_HOME/profiles/<name>`
- `dsh web` — a hardcoded alias for `--profile web`
- `dsh plugin --profile <name> <pnpm args>` — forwards to pnpm

The key mechanism: **the launcher parses only its own flags and hands the rest to
the booted app verbatim.** `rejectElectronProfile()` is called from exactly two
sites — the root command (`bin.js:92`, before `resolveBoot`, so `--dump-config` is
covered too) and the `plugin` subcommand (`bin.js:109`). It is case-insensitive.

Patch layer order:
```
bundle patches -> profile/cordis.patch.yml -> $DSH_HOME/cordis.patch.yml -> --patch -> telemetry
```

### 2.2 The frontend artifact (the core reusable asset)

`dsh-web-frontend/dist/` is a **complete, prebuilt vite SPA**:

```
dist/index.html                 679 B
dist/manifest.webmanifest       267 B
dist/favicon.svg              3,721 B
dist/assets/index-BKQ_L1z6.js   555,959 B
dist/assets/vendor-CCJJTK99.js  740,575 B
dist/assets/index-DPX2bQLO.css   51,949 B
dist/assets/vendor-BNsW4eBh.css  29,288 B
dist/assets/langs/*.js          ~24 (shiki syntax grammars)
dist/assets/*.woff2             ~90 (KaTeX fonts)
```

> Note: `assets/langs/*.js` are shiki **code-highlighting grammars**, unrelated to
> UI language. The UI language comes from `dsh-client-locale` (see §2.8).

In `package.json` the `exports` map contains only `./dist/*` and `./package.json`
— **no `main`, `bin`, or `types`, and no runtime dependencies**. It is a pure
build artifact.

**`index.html` is 17 lines. Measured facts:**
- Every asset reference is a **relative path** (`./assets/...`)
- **No `window.__DSH_BOOT__`**
- **No server address**

That is decisive: `dist` carries no server information at all. It relies on
`dsh web` injecting the boot graph at serve time through
`ctx.webServer.renderIndex(html)`.

### 2.3 Client–host protocol

**Not stdio, not plain JSON-RPC.** Three carriers:

| Purpose | Carrier | Constant |
|---|---|---|
| Unary calls | HTTP POST | `API_PATH = "/api"` |
| Streams | One WebSocket | `/api/remote.mux` |
| Non-JSON responses | HTTP GET/HEAD/POST | `GET\|HEAD /api/file?path=` |

Envelope format:
```ts
ClientRequest  { type: 'client-request',  rpcId, method, payload }
ServerResponse { type: 'server-response', rpcId, result }
result = { ok: true, value: T } | { ok: false, error: { code, message, details } }
```

The caller mints `rpcId`; the host echoes it. **`RemoteResult` never rejects for a
carrier fault** — errors travel inside `ok:false`.

### 2.4 Authentication

- Each process launch mints a random launch token
- `?token=...` is accepted **only on `GET /`**; it then writes an authority-bound
  signed cookie and 303-redirects to a clean `/`
- The cookie signing secret is the `client-connection/browser-session` grant record
  in `ctx.credentials`, stored in `$DSH_HOME/.credentials.yaml` (measured to exist)
- Cookie attributes: `HttpOnly`, `SameSite=Strict`, `Path=/`, **deliberately no
  `Secure`** (loopback HTTP), 30-day default
- Request-trust fence: `Host` must be loopback or in `trustedHosts`; `Origin` must
  equal Host; `sec-fetch-site: cross-site` is refused
- **`dsh web --host 0.0.0.0` is rejected at startup**

### 2.5 The client plugin system

**No module federation, no native dynamic `import()`.** It is a hand-rolled
**lazy-CJS module table** replacing the vendored cordis Loader's import seam.

Out-of-tree plugin registration (no core changes needed):
1. Declare `dsh.client { platform: 'web' }` in `package.json`
2. Export a built `./client` bundle
3. Appear as an enabled Loader entry in the composition

Bundle URL: `/plugins/<package-id>/client.js`; the boot graph arrives via
`window.__DSH_BOOT__`.

**Build prerequisite**: `lib/client.js` must be built; a missing bundle fails
loudly with `MissingClientBundleError`.

### 2.6 Route ownership (full path map)

| Path | Owner |
|---|---|
| `/api` (prefix) | `dsh-client-connection` |
| `/api/remote.mux` (upgrade) | `dsh-api-gateway` |
| `/plugins` (prefix) | `dsh-client-modules` |
| `/plugins/events` (SSE) | `dsh-client-hmr` |
| fallback (everything else) | `dsh-host-frontend-static` |

The default listen address is **`127.0.0.1:3080`** in
`dsh-web-app/cordis.patch.yml`.

The desktop build instead passes `--port 0` so the OS assigns a free port.

### 2.7 Local environment

```
Node      v24.21.0
npm       11.19.0
dsh       0.1.5-rc.2
Electron  37.10.3 (Node 22.21.1)
DSH_HOME  C:\Users\<user>\.dsh
```

### 2.8 Language support (`dsh-client-locale`)

Measured to be mounted, with both `zh` and `en` dictionaries in its compiled output.

Exact contract (from `dsh-client-locale/lib/index.js`):

| Item | Value |
|---|---|
| Settings namespace | `locale` |
| Field | `preference` |
| Accepted values | `["zh", "en"]` |
| Storage | `$DSH_HOME/settings.yaml` |
| Switch entry point | Main window Settings → General → Language (applies live) |

---

## 3. Goals and non-goals

### Goals
- A native desktop window that opens on double-click — no manual browser, no port to remember
- Reuse DSH's official frontend `dist` and every host capability (sessions, tools, approval, sandbox)
- Desktop capabilities a browser cannot provide: native window control, tray, native directory picker, open file/folder
- **Coexist** with the existing `dsh web` workflow without conflict
- Stay out-of-tree: **never modify the DSH installation** (so `dsh` upgrades keep working)
- Relocatable: all user state in one folder, copyable to another Windows machine

### Non-goals (explicitly out of scope)
- No mobile or web-surface rework
- No fork or rebuild of the DSH frontend (`dist` is reused as-is)
- No custom editor or terminal emulator
- No auto-update or code signing (deferred)
- No attempt at a serverless `file://` architecture

---

## 4. Architecture choice

### 4.1 Three candidates

| | A. Embedded server + real URL | B. `file://` + IPC bridge | C. System-browser shell (Tauri/light) |
|---|---|---|---|
| Auth | Reuses the official token→cookie flow, **zero rework** | Needs `ownsHost: true`, bypassing auth | Same as A |
| ES modules | Normal (http origin) | Measured to load, but the boot injection is missing | Normal |
| WebSocket streams | Native | Must implement `openStream` | Native |
| `/plugins` bundles | Native | Must implement `loadBundle` + `fetchBundle` | Native |
| Upstream documentation | Not mentioned, but fully compliant | Explicitly mentioned | Not mentioned |
| Implementation effort | **Low** | High | Medium |
| Native capabilities (tray/pickers) | Complete | Complete | Limited by the chosen framework |

### 4.2 Verdict: plan A (corrected after measurement)

> **This section was corrected by the Phase 0 measurement.** The original
> argument ("`file://` fails due to CORS") **was disproved by experiment**; see
> `docs/phase0-findings.md`. Plan A's conclusion is unchanged, but the reasoning
> is different.

**Reasoning (corrected):**

1. **The real reason `file://` does not work is the missing boot injection, not
   CORS.** Measured: over `file://` the ES modules load fine, React mounts, and
   `did-fail-load` is empty — the original CORS judgement was wrong. What actually
   fails is `window.__ModuleLoader__ bootstrap facade is missing`: `dist/index.html`
   is 17 lines of static HTML, and both `__DSH_BOOT__` and `__ModuleLoader__` are
   injected by `dsh web` at serve time through `ctx.webServer.renderIndex()`.
   Under `file://` there is no server to inject them.
   - Implementing the injection by hand is theoretically possible (read the boot
     graph, serve the `/plugins` bytes), but it amounts to **reimplementing
     everything plan A gets for free**.

2. **Plan A gets every protocol capability for free.** Under an HTTP origin,
   `fetch` to `/api`, the `/api/remote.mux` WebSocket, `/plugins` bundle loading,
   and the `/plugins/events` SSE channel all work natively, with **no
   `ClientTransportHooks` implementation at all**.

3. **Zero rework for authentication.** Pointing the `BrowserWindow` at
   `http://127.0.0.1:<port>/?token=<token>` writes the cookie normally, exactly as
   a browser would.

4. **It is the only option verifiable immediately.** The IPC bridge protocol plan B
   depends on (channel names, serialization, stream framing) is entirely
   undocumented in the installed artifacts.

**Additional constraints confirmed by measurement:**
- **The Electron main process must be ESM** — every DSH package is
  `"type": "module"`, and CommonJS fails with `ERR_REQUIRE_ESM`.
- **Electron 37+ (Node 22+)** — Electron 33 can import the boot library but cannot
  load the plugin tree.
- `loadProfileDirectory`, `boot`, and the other boot APIs are **directly importable
  from an Electron main process**.

### 4.3 Key implementation points

**Do not spawn `dsh web` and parse stdout for the port.** The robust approach is to
**boot DSH in-process**:

```js
import { loadProfileDirectory, boot } from '@deepseek-ai/dsh-app-boot'
```

- `loadProfileDirectory(binName, dir, installAnchor, options)` is a public, exported
  API documented for exactly this "application-owned profile directory" case. It
  does **not** go through CLI profile lookup, so the `desktop` name reservation
  does not apply.
- `--port 0` lets the OS assign a port, read back through `ctx.webServer.port`,
  **eliminating port conflicts entirely**.

---

## 5. Additional contracts discovered during implementation

These three were not anticipated during planning but were confirmed by
measurement. They are hard constraints:

### 5.1 `provideCmdline` must be called

Without it, 11 entries stay pending forever:
```
@deepseek-ai/dsh-web-app/startup: pending (waiting for service: cmdlineArgs)
@deepseek-ai/dsh-host-webserver:   pending (waiting for service: webStartup)
```

`appReady` must also be provided, and `commit()`ed only **after** a successful
boot — otherwise it masks the real error.

### 5.2 A patch's `config` replaces wholesale

It does not merge. Writing only `config: { printUrl: false }` makes `openBrowser`
fall back to the schema default of `true`, so DSH quietly launches a system
browser behind Electron's back. Every field the row needs must be restated.

### 5.3 Only `insert:` adds rows

A bare `- id: xxx` only **targets** an existing row; it does not create one, **and
it fails silently** (the entry count does not change and no error is raised).

```yaml
- insert:
    - id: my-plugin
      name: '@scope/my-dsh-plugin'
```

---

## 6. Phased plan (all complete)

### Phase 0 — Feasibility ✅

- [x] Initialize the npm project, install Electron (upgraded to 37 for Node 22+)
- [x] **Experiment 1**: `BrowserWindow.loadFile(dist/index.html)` — disproved the CORS hypothesis
- [x] **Experiment 3**: in-process `loadProfileDirectory` + `boot` — confirmed importable
- [x] Produced `docs/phase0-findings.md`

### Phase 1 — Minimum viable client ✅

- [x] Electron main process boots DSH via `loadProfileDirectory` (`port: 0`)
- [x] Authenticated URL obtained through `connection.authenticatedUrl()`
- [x] `BrowserWindow` loads that URL (no preload — minimal attack surface)
- [x] Lifecycle: graceful DSH shutdown
- [x] Single-instance lock; a readable error page on boot failure
- [x] Security baseline: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`

### Phase 2 — Desktop capabilities ✅

- [x] Tray: show/hide, settings, quit
- [x] Close minimizes to tray rather than exiting (with a first-time balloon)
- [x] Window state persistence (size/position/maximized, with off-screen protection)
- [x] Application menu and shortcuts
- [x] Shell settings window (data root, diagnostics, read-only language display)
- [x] Native notifications

### Phase 3 — Packaging and distribution ✅

- [x] `electron-builder` produces a Windows NSIS installer
- [x] Bundles a pinned DSH (into `app.asar.unpacked`)
- [x] `asarUnpack`: native binaries + the DSH tree + non-JS assets
- [x] Application icon (a 7-size ICO, generated by script)
- [x] Packaged app measured: frontend JS `HTTP 200, 555,959 bytes`
- [x] Migration measured: config and credentials intact after copying the folder

### Phase 4 — Exploration (not done)

- [ ] A custom-scheme, portless approach
- [ ] A desktop-specific client plugin (via the `dsh.client` declaration)
- [ ] Auto-update (`electron-updater`)
- [ ] Code signing

---

## 7. Risk register (with actual outcomes)

| Risk | Impact | Outcome |
|---|---|---|
| `0.1.5-rc.2` is a release candidate | Seams may move | Mitigated: all coupling concentrated in `host.ts` |
| `loadProfileDirectory` unverified in Electron | Phase 1 blocked | **Cleared** — experiment 3 passed |
| **`app.asar` breaks child-process spawn** | All tool calls fail when packaged | **Cleared** — `asarUnpack` works, verified on the packaged app |
| Port conflicts | Startup failure | **Cleared** — `--port 0` lets the OS assign |
| Hardcoded frontend `dist` path | Blank window after upgrade | **Mitigated** — resolved dynamically via `require.resolve` |
| **Electron's bundled Node too old** | Plugin tree fails to load | **Hit and fixed** — upgraded to Electron 37 |
| Close-to-tray mistaken for exit | UX problem | **Mitigated** — first-time balloon |
| Misconfigured `nodeIntegration` enabling RCE | Serious security risk | **Mitigated** — `sandbox: true`, no preload on the main window |
| Locale seeding overwriting a user's choice | User setting changed silently | **Mitigated** — first run only; an existing choice is never overwritten |

---

## 8. Actual directory structure

```
<repo>\
├── PLAN-desktop-client.md / .zh.md       # this document
├── README.md / .zh.md                    # usage guide
├── package.json                          # Electron app manifest
├── electron-builder.config.cjs           # packaging config
├── tsconfig.json / tsconfig.preload.json # main process ESM / preload CJS
├── src\
│   ├── main\
│   │   ├── index.ts                      # main entry, window lifecycle, menu
│   │   ├── host.ts                       # * DSH boot adapter (the ONLY DSH coupling)
│   │   ├── paths.ts                      # data-root resolution (4 modes)
│   │   ├── locale.ts                     # first-run Chinese seeding
│   │   ├── settings.ts                   # shell settings window + IPC
│   │   ├── tray.ts                       # system tray
│   │   └── window-state.ts               # window state persistence
│   ├── preload\
│   │   └── settings.ts                   # minimal preload for the settings window (compiled to .cjs)
│   └── settings\
│       └── index.html                    # settings window UI
├── scripts\                              # self-check and audit scripts
├── docs\                                 # technical docs (bilingual)
├── assets\icon.ico                       # application icon
├── desktop-profile\                      # the application-owned DSH profile directory
└── release\                              # build output
```

**Architectural discipline**: every call into `@deepseek-ai/*` is allowed **only in
`src/main/host.ts`**. DSH is a release candidate, so keeping the coupling in one
file minimizes the change surface for a future upgrade.

---

## 9. Open items

1. **Phase 0 disproved the original hypothesis** but plan A stands; the only
   retained architectural fallback is the custom-scheme, portless approach (Phase 4).
2. **`app.asar` and DSH child processes** — solved with `asarUnpack` and verified.
3. **Upgrade channel for the bundled DSH** — pinning `0.1.5-rc.2` means users miss
   upstream fixes. Phase 4 should evaluate a controlled upgrade process rather than
   tracking automatically.
4. **HMR is unavailable** — DSH's HMR service needs Node's `--expose-internals`,
   which cannot be appended after an Electron main process starts. This affects the
   development loop for out-of-tree client plugins, not the loading of already-built ones.

---

## 10. Reference: confirmed file paths

```
dsh install root
C:\Users\<user>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\

launcher
  lib\bin.js                                        # command parsing, desktop name reservation
  lib\profile-boot-Dk-7KqJc.js                      # the real runProfile implementation (349 lines)

frontend artifact (the reuse target)
  node_modules\@deepseek-ai\dsh-web-frontend\dist\index.html
  node_modules\@deepseek-ai\dsh-web-frontend\dist\assets\*

key interfaces
  dsh-app-boot\README.md:50                         # Electron's reserved profile + loadProfileDirectory
  dsh-host-webserver\README.md:12                   # the Electron file:// + IPC bridge statement
  dsh-client-connection\lib\types\client\index.d.ts:37-63   # ClientTransportHooks
  dsh-client-connection\lib\client.js:6307,6344     # runtime read of __DSH_TRANSPORT__
  dsh-web-app\cordis.patch.yml                      # default 127.0.0.1:3080
  dsh-client-locale\lib\index.js                    # locale namespace and preference field
  dsh-cmdline\lib\index.js                          # provideCmdline contract
  dsh-permission-presets\lib\index.js               # permission presets

user configuration
  C:\Users\<user>\.dsh\settings.yaml
  C:\Users\<user>\.dsh\.credentials.yaml
  C:\Users\<user>\.dsh\profiles\web\
```

---

## 11. Evidence strength

- **Confirmed by measurement**: §2.1, §2.2, §2.7, §2.8, all of §4.2, and the three
  contracts in §5
- **Confirmed by reading source/READMEs**: §2.3, §2.4, §2.5, §2.6
- **Disproved inference**: the original §4.2 claim that "`file://` fails due to
  CORS" — Phase 0 measured that ES modules load fine over `file://`, and the real
  cause is the missing boot injection
- **Undocumented gaps**: the concrete Electron IPC bridge protocol (channel names,
  serialization, stream framing) and how `__DSH_BOOT__` is injected outside
  `renderIndex`. Upstream decision records
  (`.agents/notes/implemented/architecture/2026-07-2*-*.md`) are not in the npm
  package; obtaining them from the GitHub repository is worthwhile.
