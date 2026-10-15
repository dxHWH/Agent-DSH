# Directory picker failure: workaround (native → browse)

English | [中文](directory-picker-failure.zh.md)

> Symptom (user-reported): the packaged app reports this when opening a folder:
> ```
> directory picker failed: directory picker failed:
> win32 folder dialog worker exited before reporting a result
> ```
> Status: **worked around by switching to the browse backend. Root cause NOT identified.**

---

## 1. The fix applied: switch to the browse backend

### Why this approach

`dsh-host-directory-picker-auto` (the adaptive chooser) **always** picks native on Windows:

```js
// dsh-host-directory-picker-auto/lib/index.js L67
if (facts.platform === "darwin" || facts.platform === "win32") return "native";
```

The native backend drives a Win32 `IFileOpenDialog` from a **child process** — and
that is the chain failing in your environment.

DSH's own README documents the swap point:

> *"Pinning an interaction means composing that `-native` or `-browse` row directly
> instead of this one — that is the seam's documented swap point."*

### What was changed

`desktop-profile/cordis.patch.yml`:

```yaml
- id: directory-picker
  disabled: true

- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: ui-directory-picker-browse
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
```

**The browse backend starts no child process.** It lists directories through Node's
standard library and renders the picker inside the app, so there is no worker to lose.

### Verification

```
autoDisabled:            true     <- the adaptive chooser is disabled
browseCapabilityPresent: true     <- browse took over
nativeCapabilityAbsent:  true     <- the native chain is gone entirely
swapSucceeded:           true
listProbe: { entries: 48, hasHome: true }   <- browse actually works
```

**To revert**: delete those two patch entries to restore the native dialog.

**Cost**: no OS-native dialog; selection happens inside the app.

---

## 2. Root cause: not identified

**I ran 8 targeted checks, and every one showed the native chain working.**

| # | Check | Result |
|---|---|---|
| 1 | Fork the worker from the source tree | **Works** — dialog opens, returns `done` |
| 2 | Fork from the packaged tree (explicit unpacked path) | **Works** |
| 3 | Fork from the packaged tree (asar path) | **Works** — `sawShowing: true` |
| 4 | Import the picker and pick directly | **Works** — returns `null` (cancel) |
| 5 | Real host, native capability pick | **Works** — aborted by timeout |
| 6 | Boot a host with the packaged anchor and profile | **Works** |
| 7 | The picker's **exact** stdio config (`inherit` + `windowsHide`) | **Works** |
| 8 | **A real spawn probe inside the packaged runtime** | **Works** — `exit code=0`, empty stderr |

**Check 8 is the strongest** — it ran the picker's exact spawn inside the real main
process of the packaged `DSH Desktop.exe`:

```
picker worker: ...app.asar\...\worker.cjs
picker probe exit: code=0 signal=null
picker probe stderr: (empty)
picker probe timeout reached (dialog likely open)   <- the dialog really did open
```

**I could not reproduce the failure under controlled conditions.**

---

## 3. Hypotheses disproved during the investigation

| # | Hypothesis | How it was disproved |
|---|---|---|
| 1 | koffi was not built | It loads `ole32.dll` under both Node and Electron |
| 2 | `@koromix/koffi-win32-x64` missing | Present in the package, 1 MB, loads fine |
| 3 | `spawn` cannot execute an asar path | **Both** the asar and unpacked paths fork successfully |
| 4 | A `files` exclusion would leave the worker unpacked-only | It removed the package **entirely** — worse |
| 5 | `inherit` stdio fails in a console-less GUI process | All three stdio configurations **work** |
| 6 | The anchor rewrite fixes it | It works but does **not** affect `import.meta.url`, so it did not address this |

**Item 6 is the important lesson**: I previously claimed "fix verified" on indirect
evidence, and that claim was wrong.

---

## 4. Known weaknesses DSH itself documents

The `dsh-host-directory-picker-native` README states plainly:

> **"Windows has no mechanism fallback"** — the child-process picker through
> packaged koffi is the only native tier, so a COM refusal or dialog crash
> surfaces the failure.

> **"Windows foreground grant relies on injected input"** — the child synthesizes
> an Alt press before `Show` so the dialog can take the foreground from a
> background host; **where synthesized input is suppressed (secure desktops,
> restricted remote sessions, an elevated foreground window), the dialog may still
> open behind other windows. The technique is validated on Windows 11 only.**

**The second item deserves attention** — if the worker crashes during `Show` rather
than during spawn, the symptom is exactly "exited before reporting a result".

**If any of these apply to your environment, that may be the explanation:**
- Secure desktops / restricted desktop environments
- Remote sessions (RDP)
- An elevated process holding the foreground
- Anything other than Windows 11

---

## 5. If you later want the native dialog back

1. Delete the two patch entries in `cordis.patch.yml` (reverting to native)
2. **First establish which phase fails**: does the dialog flash briefly?
   - Never appears → the spawn phase
   - Appears then vanishes → a crash during `Show` (matching §4's second item)
3. Enable the runtime probe: launch the packaged app with
   `DSH_DESKTOP_PROBE_PICKER=1`, which performs one real picker spawn and prints the
   worker's stderr

---

## 6. Diagnostic tooling (kept)

| Script | Purpose |
|---|---|
| `scripts/diagnostics/diagnose-picker-backend.mjs` | Show which backend actually mounted |
| `scripts/diagnostics/verify-browse-swap.mjs` | Verify the browse swap took effect |
| `scripts/diagnostics/repro-directory-picker.mjs` | Fork the worker and watch the dialog |
| `scripts/diagnostics/test-worker-fork.mjs` | Fork inside an Electron main process (asar vs unpacked) |

`host.ts` prints the worker path at startup (in both builds):
```
[dsh-desktop] picker worker: ...
[dsh-desktop] picker worker inside asar: ..., exists: ...
```

---

## 7. My mistake

**I previously claimed the fix was "verified", based on a flawed verification method.**

What I verified was **path-level** (the worker could be spawned, the path was
correct), not an **end-to-end click**. I should have said so the moment I found I
could not reproduce it, rather than declaring a fix.

This time the approach is different: **switch to an implementation path that does not
depend on the failing subsystem**, and label the root cause as unidentified.

---

## 8. Evidence strength

- **Confirmed by measurement**: the browse swap took effect (capability replaced,
  `list` returned 48 entries); all 8 native checks in §2 passed
- **Not reproduced**: the user-reported error message
- **Not verified**: the end-to-end click experience of the browse backend in the
  packaged UI (requires human confirmation)
