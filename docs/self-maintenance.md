# Desktop self-maintenance capabilities

English | [中文](self-maintenance.zh.md)

> Question: how does the desktop build handle **self-maintenance, plugin
> extension, and DSH upgrades**?
> Method: measurement against the **packaged artifacts** (not the source tree),
> including a simulated clean-machine environment.
> Script: `scripts/audit-self-maintenance.mjs`

---

## Summary

| Maintenance dimension | Possible today | Blocker |
|---|---|---|
| Change composition (enable/disable/configure plugins) | **Partly** | Requires editing `resources/desktop-profile/`, which **an upgrade overwrites** |
| Install out-of-tree plugins | **No** | The profile has no `node_modules` of its own |
| Upgrade the bundled DSH | **No** | The version is pinned inside the installer |
| Application auto-update | **No** | `electron-updater` is not wired up |

**All four require an architectural change, not just documentation.** This document
proposes one.

---

## 1. A real defect found by measurement

### The packaged profile is not self-contained

Measured from `release/win-unpacked/resources/desktop-profile/`:

```
resolving @deepseek-ai/dsh-base from the profile directory
  -> <repo>\node_modules\@deepseek-ai\dsh-base\package.json
     ^^^ reached into the DEVELOPER MACHINE's project root, not app.asar.unpacked
```

**Why**: `release/win-unpacked` sits inside the project directory, so Node's upward
lookup naturally hits the developer's `node_modules`.

### On a clean machine it fails

After copying the packaged artifacts to a location with no `node_modules`:

```
@deepseek-ai/dsh-base/package.json -> FAILED: MODULE_NOT_FOUND
@deepseek-ai/cordis/package.json   -> FAILED: MODULE_NOT_FOUND
```

### Why the installed build still runs

Because `loadProfileDirectory(binName, dir, installAnchor)` takes an `installAnchor`
pointing at **DSH's own installation**, and bundles resolve from there rather than
from the profile directory.

**But that masks the real issue**: the profile directory declares
`dsh.profile.bundles` yet cannot resolve them by itself. The moment you try to
install an out-of-tree plugin, this breaks — because an out-of-tree plugin can
**only** resolve from the profile's own `node_modules`.

### Conclusion

This is not a "can it be maintained" question. It is that **the profile directory
must be self-contained**. The proposal below takes that as its premise.

---

## 2. The proposal: move maintainable content out of the install directory

### Core idea

The packaged `resources/` directory **is overwritten on upgrade**, so it cannot hold
user-maintainable content.

The correct placement is the user data area, alongside `settings.yaml` and
`.credentials.yaml`:

```
<data root>\
├── settings.yaml
├── .credentials.yaml
├── storages\
├── .agent-presets\          # already there: the user's agent presets
└── desktop-profile\         # NEW: the user-maintainable composition
    ├── package.json         # declares bundles and dependencies
    ├── cordis.patch.yml     # the user-editable composition overlay
    ├── cordis.yml
    ├── pnpm-workspace.yaml
    └── node_modules\        # out-of-tree plugins install here
```

**Benefits:**

| Effect | Why |
|---|---|
| Upgrades do not overwrite it | The data area is outside the installer |
| It migrates with the data | Copies along with settings and credentials |
| Plugins become installable | It has its own `node_modules` |
| It is revertible | Broke it? Delete and recreate |

### First-run bootstrap

On startup the app should:

1. Check whether `<data root>/desktop-profile/` exists
2. If not → copy a template out of the package (the template stays read-only, acting
   as "factory defaults")
3. If it exists → use it as-is, preserving the user's changes

That keeps it working out of the box without ever overwriting user edits.

---

## 3. The four maintenance needs, concretely

### 1. Change the composition

Edit `<data root>/desktop-profile/cordis.patch.yml`:

```yaml
# disable a built-in plugin
- id: ui-schedule
  disabled: true

# override configuration
- id: agent-loop
  config:
    maxParallelToolCalls: 4

# add a row (MUST be wrapped in insert)
- insert:
    - id: my-plugin
      name: '@scope/my-dsh-plugin'
```

**Measured**: patches take effect (entry count 152 → 153; disabling works).

> **Trap**: a bare `- id: xxx` only targets an existing row. It does not add one,
> **and it fails silently**. New rows require `insert:`.

### 2. Install out-of-tree plugins

The profile is an ordinary npm project, so a package manager can be used directly:

```powershell
cd "<data root>\desktop-profile"
npm install @scope/my-dsh-plugin
```

Then mount it in `cordis.patch.yml` with an `insert` row.

**External client plugins** (those with UI) must declare it in their package:

```json
{
  "dsh": { "client": { "platform": "web" } }
}
```

and export a built `./client` bundle — a missing one fails loudly with
`MissingClientBundleError`.

> **Note**: `dsh plugin --profile desktop` cannot be used, because the CLI reserves
> that name (measured). Use a package manager inside the profile directory instead.

### 3. Upgrade the bundled DSH

This is the item that most needs architectural support. Three tiers:

| Approach | How | Suitable for |
|---|---|---|
| **A. App upgrade** | Ship a new installer; the user installs it | Simple, but reinstalls the whole app |
| **B. Separate DSH directory** | DSH lives in the data area and can be replaced on its own | Recommended |
| **C. Follow the system dsh** | Reuse a globally installed `dsh` | Saves size, but the version is uncontrolled |

**Design for approach B**: move the DSH installation tree out of
`app.asar.unpacked` into the user data area:

```
<data root>\
└── dsh\                    # an independently upgradeable DSH install
    └── node_modules\
        └── @deepseek-ai\dsh\
```

On startup, prefer the data-area DSH and fall back to the bundled one when absent.
Upgrading then means replacing the `dsh/` directory — no app reinstall.

**What must change**: `resolveInstallAnchor()` in `host.ts` and the profile
resolution chain.

### 4. Application auto-update

Wire up `electron-updater` (currently not installed — measured).

Requires:
- A release source (GitHub Releases / a static server / S3)
- `electron-builder`'s `publish` configuration
- Update check and download wiring in the main process
- **Code signing** (otherwise every update trips SmartScreen)

> Signing is a **practical prerequisite** for auto-update, not optional. Unsigned
> auto-updates degrade the user experience noticeably.

---

## 4. Recommended sequence

| Stage | Content | Value | Risk |
|---|---|---|---|
| 1 | Move the profile to the data area + first-run bootstrap | Composition becomes maintainable; upgrades stop overwriting | Low |
| 2 | Document the out-of-tree plugin install flow | Plugins become extensible | Low |
| 3 | Move the DSH install tree to the data area | DSH becomes independently upgradeable | Medium (resolution chain) |
| 4 | Wire up electron-updater | App auto-update | Medium (needs a release source + signing) |
| 5 | Code signing | Removes SmartScreen warnings | Needs a certificate |

**Stage 1 is the prerequisite for the rest** — it answers the fundamental question of
*where user changes live*.

---

## 5. What users can do today

Until the architectural change lands, an installed user can still maintain things by
hand, but should know the costs:

| Goal | Today's approach | Cost |
|---|---|---|
| Change composition | Edit `resources/desktop-profile/cordis.patch.yml` directly | **An app upgrade overwrites it** |
| Install a plugin | Manually create `node_modules` in the profile and install | The profile resolution chain is incomplete; may fail |
| Upgrade DSH | Reinstall a newer app build | No independent upgrade |

**Recommendation**: until stage 1 lands, keep your changes somewhere else (for
example a backed-up patch file) and re-apply them after an upgrade.

---

## 6. Reproducing

```bash
npm run audit:self-maintenance   # packaged-artifact maintenance measurement
```

---

## 7. Evidence strength

- **Confirmed by measurement**: packaged profile location and writability; a patch's
  actual effect on the composition (152→153); the profile having no `node_modules`;
  the resolution chain reaching into the developer machine; resolution failing at a
  clean location; `electron-updater` not being installed
- **Confirmed by reading contracts**: the `installAnchor` parameter's meaning in
  `loadProfileDirectory`; the CLI reserving the `desktop` name; the `dsh.client`
  declaration requirement for external client plugins
- **Not verified**: the full bootstrap flow for a data-area profile (testable only
  once implemented); the practical feasibility of an independent DSH upgrade
  (verifiable once the resolution chain changes)
