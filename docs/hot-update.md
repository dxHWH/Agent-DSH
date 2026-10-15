# Desktop hot-update capabilities

English | [中文](hot-update.zh.md)

> Question: can the desktop client do "hot updates"?
> Method: splitting "hot update" into four layers, measuring each, and running an
> end-to-end experiment on the viable path.
> Scripts: `scripts/audit-hot-update.mjs`, `scripts/experiment-hot-update.mjs`

---

## Conclusion

**"Hot update" means four different things here, with wildly different feasibility.
Two layers work today, one is hard-blocked by Electron, and one needs an
architectural change.**

| Layer | Meaning | Possible? | Evidence |
|---|---|---|---|
| **L1 Composition** | Change the plugin composition without restarting | **Yes** | Measured: 152 → 153 entries |
| **L2 Client plugin** | Swap a UI plugin bundle | **Yes, but needs a rebuild watcher** | Component mounted |
| **L3 Host plugin** | Swap a node-side plugin | **No** | Requires `--expose-internals` |
| **L4 DSH version** | Change the harness version | **Needs an architectural change** | Version lives inside the installer |

**The most practical path: change the composition + reload the renderer = effective
without restarting Electron.** Verified by measurement (`rendererSurvivedReload: true`).

---

## 1. Disambiguating the term

"Hot update" refers to at least four distinct things on the desktop. Conflating them
leads to wrong conclusions:

| Layer | Typical scenario | What the user sees |
|---|---|---|
| L1 Composition | Enable/disable/configure plugins | Interface capabilities change |
| L2 Client plugin | Update a plugin that has UI | One panel changes |
| L3 Host plugin | Update node-side logic | Background behavior changes |
| L4 DSH itself | Upgrade the harness version | Overall capability changes |

---

## 2. L1 composition hot update: possible

### Mechanism

The profile declares `patchReload: live`; the host exports `watchUserPatches`, which
watches the patch file and recomposes on change.

Measured:

```
L1_compositionRecomposes: { before: 152, after: 153, changes: true }
L1_watchUserPatchesExported: true
L1_patchReloadDeclared: "live"
```

### But two things must be distinguished

| | Takes effect? |
|---|---|
| The **host** recomputes the composition | Yes (driven by the watcher) |
| Whether an **already-open interface** follows | **Not necessarily** — see L4 |

This distinction matters: the composition is recomputed host-side, but a loaded
browser interface holds the **old boot graph**.

---

## 3. L2 client plugin hot swap: possible, with one precondition

### The mechanism DSH already ships

`dsh-client-hmr` provides browser-side plugin hot swap:

- Host side: stat-polls bundles and broadcasts over the SSE channel `/plugins/events`
- Client side: on a `rebuilt` frame it **swaps that plugin in place** (new fiber, new
  component state) while the data layer (connection / Session objects) is **untouched**

Measured: the component is mounted in this desktop composition,

```
L2_clientHmrPresent: true
L2_servesSSE: true
L2_pollsBundles: true
L2_rowMounted: true
L2_rowDisabled: false
```

### Precondition: something must actually rebuild

The README is explicit:

> *"The reload chain stays idle without a rebuild watcher: only a
> `pnpm run dev:web`-style process rewriting client bundles produces the rebuilds it reacts to."*

**It is pure development machinery.** With no tsdown/vite-style watch process writing
`lib/client.js`, it stays idle and nothing happens.

**Production implication**: to hot-update a plugin in the field, you must supply the
"write the bundle" step yourself (for example, download a new bundle into the plugin
directory and trigger a rebuild).

### Known design boundaries

| Boundary | Note |
|---|---|
| State is lost | A new fiber and new components; React state is not preserved |
| No rollback | A failure leaves the entry FAILED; the old bundle is not restored |
| Coarse by design | react-refresh-grade state preservation is deliberately out of scope |

---

## 4. L3 host plugin hot swap: hard-blocked by Electron

### Root cause

`cordis-plugin-hmr` requires `ctx.loader.internal`:

```js
if (!this.ctx.loader.internal) throw new Error("--expose-internals is required for HMR service")
```

Measured:

```
L3_requiresExposeInternals: true
environment.exposeInternalsPresent: false
environment.execArgv: []
L3_willThrowAtRuntime: true
```

### Why it cannot be worked around

`--expose-internals` is a **Node process startup flag** and must be supplied when the
process is created. The Electron main process is already running, so it **cannot be
appended at runtime**.

### Possible detours (unverified)

All of these add complexity, each with its own cost:

| Detour | Cost |
|---|---|
| `NODE_OPTIONS` | Electron ignores it by default, and `--expose-internals` is in the category that may not be passed through `NODE_OPTIONS` anyway |
| Run the host in a separate Node child process | Loses every advantage of in-process boot (port/token handoff, lifecycle) |
| Host the server in a `utilityProcess` | Requires restructuring `host.ts` and solving cross-process service registry problems |

**Recommendation: accept that L3 is unavailable.** Update host plugins via
"change config + reload the renderer", or by restarting the app.

---

## 5. L4 how a composition change reaches an open interface

This is the most practical layer, and it is verified.

### The key mechanism

When the renderer reloads, it **re-requests the boot graph from the host**. Therefore:

```
edit patch -> host recomputes composition -> reload renderer -> interface sees the new composition
```

**Electron never restarts.**

### Measured result

```
domBeforeChange:        { rootChildren: 1, title: "DeepSeek Harness", hasLoader: true }
domAfterReload:         { rootChildren: 1, title: "DeepSeek Harness", hasLoader: true }
rendererSurvivedReload: true
electronRestartRequired: false
```

The interface **fully recovered** after the reload (React mounted, title intact,
module loader present).

### What this means

| Scenario | App restart needed? |
|---|---|
| Change composition (enable/disable/configure) | **No** — reload the renderer |
| Update a client plugin bundle | No (L2 mechanism or a reload) |
| Update a host plugin | Yes (L3 limitation) |
| Upgrade the DSH version | Yes (and an architectural change is needed first) |

---

## 6. A practical design: a desktop hot-update button

Given the measurements above, a **restart-free hot update** is buildable:

```
1. The app watches the data-area profile (or offers a "check for updates" button)
2. Detect a patch/plugin change
3. Recompose host-side
4. The main process calls win.webContents.reload()
5. The interface seamlessly refreshes onto the new composition
```

**Components already verified:**

| Component | Status |
|---|---|
| Host recomposes | Possible (`watchUserPatches`) |
| Renderer reload | Possible (measured: the UI fully recovers) |
| Detect changes (watch/poll) | Needs implementing |
| Notify the user | Needs implementing |

**Effort: small to moderate.** The core mechanisms already exist; the work is wiring
them together and adding user-facing feedback.

### One design problem to handle

Reloading the renderer **interrupts work in progress** (for example, a streaming
response).

Recommendations:
- Only trigger when idle, or warn explicitly
- Or auto-update only when no session is active

---

## 7. L4 in full: hot-updating the DSH version

To hot-update **DSH itself**, the architectural change from `self-maintenance.md` must
come first: move the DSH install tree into the data area so it can be replaced
independently.

The flow then becomes:

```
1. Download the new DSH into a temp directory in the data area
2. Verify integrity
3. Stop the host (dispose)
4. Atomically replace the dsh/ directory
5. startHost() again
6. Reload the renderer
```

**This is friendlier than restarting the app** (the window never disappears), but it is
considerably more complex and must handle rollback on a failed replacement.

**Recommended order**: do the composition hot update first (§6). It is the foundation
for the rest and carries low risk.

---

## 8. Capability boundaries

| Capability | Status | What is needed |
|---|---|---|
| Composition changes take effect | Host-side yes; the UI needs a reload | Wire together + user feedback |
| Client plugin hot swap | Mechanism exists | A "rebuild" step (self-built for production) |
| Host plugin hot swap | **Not possible** | Accept, or restructure to a child-process architecture |
| DSH version hot update | Not possible | Complete self-maintenance stages 1 and 3 first |
| App self-update | Not possible | Wire up electron-updater + signing |

---

## 9. Reproducing

```bash
npm run audit:hot-update          # per-layer capability measurement
npm run experiment:hot-update     # end-to-end hot-update path
```

---

## 10. Evidence strength

- **Confirmed by measurement**: L1 recomposition (152→153); L2 component mounted and
  not disabled; L3 requiring `--expose-internals` (absent in the current process);
  the UI fully recovering after a reload
- **Confirmed by reading contracts**: `dsh-client-hmr`'s SSE mechanism and its
  "needs a rebuild watcher" precondition; `cordis-plugin-hmr`'s `ctx.loader.internal`
  requirement; the `/plugins` combo path format
- **Not verified**: a complete implementation of §6's hot-update button; the three L3
  detours (none experimented, costs listed)
