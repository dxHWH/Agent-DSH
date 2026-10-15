# Capability and extensibility audit

English | [中文](capability-audit.zh.md)

> Question: can a desktop client have all the features and extensibility of the Web UI?
> Method: **measured composition-level comparison** between the built desktop client
> and a stock `dsh web` — not inference.
> Scripts: `scripts/audit-capabilities.mjs`, `scripts/audit-extensibility.mjs`

---

## Terminology

This document keeps English identifiers — they are the actual names in the code,
and translating them invites ambiguity. Chinese explanations live in the
[Chinese edition](capability-audit.zh.md#术语对照).

| Term | Meaning |
|---|---|
| `profile` | An ordered stack of bundles that decides which components boot |
| `bundle` | A patch-layer package, e.g. `dsh-base`, `dsh-web-app` |
| `entry` / `row` | One mounted plugin item in the composed tree |
| `patch` | An add/override/disable layer; later layers win |
| `insert` | The patch syntax that creates new rows (must be explicit) |
| `composition` | The final plugin tree after every patch layer is applied |
| `host` | The DSH body running on the Node side |
| shell | This project — the Electron wrapper |
| HMR | Hot module replacement; edit code without restarting |

---

## Conclusion

**Features: identical, zero difference.**
**Extensibility: identical, with one structural difference worth knowing.**

---

## 1. Feature parity: measured 152 : 152, exactly equal

### Method

Compose two profiles with `dsh-app-boot` and compare the resulting entry lists:

- **Baseline**: a freshly initialized `web` profile (equivalent to `dsh web`)
- **Subject**: the desktop client's `desktop-profile`

### Result

```json
"diff": {
  "onlyInWeb": [],
  "onlyInDesktop": [],
  "identical": true,
  "webCount": 152,
  "desktopCount": 152
}
```

**Zero difference.** Breakdown:

| Category | Count | Note |
|---|---|---|
| Total entries | 152 | Identical |
| Client plugins (`dsh-client-*`) | 45 | Identical |
| UI plugins | 36 | Chat, session, tools, approval, plan, goal, subagent, … |

### Why they must be identical

Both sides declare a **byte-for-byte identical** profile manifest:

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app"
]}}
```

And both load the **same frontend artifact**: `@deepseek-ai/dsh-web-frontend/dist`.

The desktop client replaces or trims nothing at the UI layer. It puts DSH's own
interface into a native window rather than rewriting one.

### The only differences are in the shell, and they only add

Capabilities the desktop build **has beyond** the web build (none of which
affect DSH's internal features):

| Capability | Source |
|---|---|
| Tray residency, close-to-tray | `tray.ts` |
| Window size/position persistence | `window-state.ts` |
| Native application menu and shortcuts | `index.ts` |
| Shell settings window (data root, diagnostics) | `settings.ts` |
| Relocatable data root (4 modes) | `paths.ts` |
| OS-assigned port (eliminates port conflicts) | `host.ts` |

**No DSH feature is reduced.**

---

## 2. Extensibility: verified empirically

Static parity does not prove extensibility. So the profile's **user patch
layer** was actually modified to see whether it changes the composition.

### Result

```
beforeCount:  152
afterCount:   153          <- insert took effect
rowAdded:     true
addedRow:     { id: 'user-added-plugin', name: '@deepseek-ai/dsh-cordis-host-runner' }
disableWorks: true         <- id-targeted override took effect
verdict:      extensible: insert adds rows, id-targeted entries override and disable
```

### Available extension mechanisms

| Mechanism | Carrier | Verified |
|---|---|---|
| Add a plugin | `- insert:` in `cordis.patch.yml` | Yes |
| Override config / disable a component | `- id: <target>` + `config:` / `disabled:` | Yes |
| Out-of-tree client plugin | `dsh.client` declared in the package's `package.json` | Not tested (requires building a bundle) |
| Hot patch reload | the profile's `patchReload: live` | Declared; see the limitation below |

### A trap worth knowing (hit during testing)

**A bare `- id: xxx` entry does not add a row — it only targets an existing one.**

The first attempt looked like this:

```yaml
- id: user-added-plugin
  name: '@deepseek-ai/dsh-cordis-host-runner'
```

The entry count stayed at 152, the row was not added, and **no error was
raised** — a silent failure. The correct form wraps the row in `insert`:

```yaml
- insert:
    - id: user-added-plugin
      name: '@deepseek-ai/dsh-cordis-host-runner'
```

This is the first trap any desktop-side extension work will hit, and it belongs
in the documentation.

---

## 3. Real differences and limitations

These are not "missing features" but **structural differences** of the desktop
form, and they should be stated plainly:

### 3.1 HMR / client-plugin hot reload is unavailable

DSH's client-plugin hot reload depends on `cordis-plugin-hmr`, which **requires
Node's `--expose-internals` flag**. That flag cannot be appended after an
Electron main process has started.

**Impact**: developing an out-of-tree client plugin requires an app restart
rather than a live swap.
**Not affected**: already-built client plugins load normally (they go through
the static `/plugins` bundle path, which does not need HMR).

> Note: this is the same problem the official DSH design would hit on a
> `file://` + Electron path; the upstream README offers no solution.

### 3.2 The port is dynamic, not fixed at 3080

The desktop build passes `--port 0` so the OS assigns a free port, avoiding
conflicts. This does not affect functionality (the window loads the real URL),
but:

- An external tool hardcoding `127.0.0.1:3080` **will not connect**
- The actual port is visible in the shell settings window under Diagnostics, and
  is printed to stdout

### 3.3 The auth cookie's origin is random

A different port each launch means a different `127.0.0.1:<port>`, and the
browser session cookie is bound to that origin. The desktop client performs the
token exchange itself, so **the user never notices** — but pointing an ordinary
browser at this desktop instance requires going through the URL again.

### 3.4 The `desktop` profile name is reserved by the CLI

`dsh --profile desktop` **is rejected by the CLI** (reserved upstream for the
Electron app). This does not affect the desktop client (it uses
`loadProfileDirectory`, bypassing CLI lookup), but it means:

- You **cannot use `dsh plugin --profile desktop add <pkg>`** to manage the
  desktop client's plugins
- To add a desktop plugin, edit `desktop-profile/cordis.patch.yml` or
  `package.json` directly

This is intentional upstream design, not a defect in this implementation.

### 3.5 Live patch reload is not force-enabled

The profile declares `patchReload: live`, but `host.ts` **deliberately does not
mount the HMR plugin** (reason in 3.1). The user patch layer takes effect
normally **at startup**; changes made while running are not hot-reloaded.

---

## 4. Language support (Chinese mode)

### DSH already ships both languages

Measured: `dsh-client-locale` is mounted, and its compiled output contains both
the `zh` and `en` dictionaries:

```json
"localeRows": [{ "id": "locale", "name": "@deepseek-ai/dsh-client-locale" }],
"clientMentionsZh": true,
"clientMentionsEn": true
```

Exact contract (from `dsh-client-locale/lib/index.js`):

| Item | Value |
|---|---|
| Settings namespace | `locale` |
| Field | `preference` |
| Accepted values | `["zh", "en"]` |
| Storage | `$DSH_HOME/settings.yaml` |
| Switch entry point | Main window Settings → General → Language (applies live) |

**So Chinese is not a new feature — the work is making the desktop client speak
Chinese on first launch.**

### What the desktop client does: first-run seeding

`src/main/locale.ts` seeds `zh` before DSH reads its settings.

**Key design boundaries (all verified):**

| Scenario | Behavior |
|---|---|
| Fresh data root | Seeds `zh` |
| `locale.preference: en` already set | **Never overwritten** |
| `settings.yaml` exists without a locale section | Appends the section, keeps the others |
| Second launch | Does not re-seed |

The third row was a real defect found and fixed during implementation: DSH writes
its `ui-onboarding` section on the very first launch, so keying the decision on
"does the file exist?" meant **a genuinely fresh install would never be seeded**.
The condition is now "is a locale already set?", and the write **appends** rather
than replaces.

End-to-end measurement (data root cleared, then launched):

```yaml
# DSH Desktop settings.
locale:
  preference: zh                        <- seeded
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1    <- appended by DSH afterwards; locale untouched
```

That proves both halves: the seed takes effect, and DSH's own startup does not
erase it.

### Reproducing

```bash
npm run selfcheck:locale    # 15 assertions
```

---

## 5. Answers

**Can it have all the Web UI's features?**
Yes, and it is measurably identical (152/152, zero difference). The desktop
client **is** the Web UI — the same frontend artifact, the same profile, the
same host, just placed in a native window.

**Can it have the same extensibility?**
Yes. The profile's patch layer can add, override, and disable, all verified. The
out-of-tree client plugin mechanism (`dsh.client` declaration) is shared entirely
with the web build, because both go through the same `/plugins` path.

**What does it cost?**
Three structural differences. None affect day-to-day use, but they affect
development and external integration:

1. Client-plugin hot reload is unavailable (restart required)
2. The port is dynamic, so external tools must not hardcode 3080
3. `dsh plugin` cannot manage desktop plugins; edit the profile files directly

---

## 6. Reproducing

```bash
npm run audit:capabilities     # feature parity comparison
npm run audit:extensibility    # extensibility measurement
npm run audit:locale           # installed locale capability inventory
npm run selfcheck:locale       # Chinese seeding and its boundaries (15 assertions)
```
