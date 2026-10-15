# Packaged plugin load failure: root cause and fix

English | [中文](packaged-plugin-failure.zh.md)

> Symptom: the packaged app shows **"Failed to load plugins"**
> ```
> client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js
> ```
> The source build (`npm start`) works perfectly.
> Status: **root cause identified, fix verified**

---

## Fix result (verified)

```
before: client graph: 0 entries, 0 batches (rev 240c4d8dcf0d)
after:  client graph: 53 entries, 2 batches (rev bac2a6a25253)
```

The packaged renderer's state:

```json
"boot":   { "entryCount": 53, "batchCount": 2 }
"loader": { "mode": "live" }
"rootHTML": "<div data-slot=\"root\">...<div data-slot=\"sidebar\">..."
```

**The UI renders fully** — no more "Failed to load plugins" page.

### What the fix is

`electron-builder.config.cjs` gained an `extraResources` entry:

```js
{
  from: 'node_modules/@deepseek-ai',
  to: 'desktop-profile/node_modules/@deepseek-ai',
}
```

It gives the profile directory its own resolution path to the DSH packages.

---

## 1. Root cause

**`client-modules` resolves each package manifest through `ctx.loader.internal` (which needs Node's `--expose-internals`); that internal is unavailable in Electron, and the fallback path uses the wrong base directory, so every client plugin is discarded.**

### Source evidence

`dsh-client-modules/lib/index.js`, `locatePkgJson`:

```js
const internal = this.ctx.loader.internal;
if (internal === void 0 || typeof Reflect.get(internal, "resolveSync") !== "function") {
  // fallback: resolve via createRequire against baseUrl
  return {
    path: createRequire(baseUrl).resolve(`${expectedPackageName}/package.json`),
    packageName: expectedPackageName
  };
}
```

**Preferred path**: `loader.internal.resolveSync` — requires `--expose-internals`
**Fallback path**: `createRequire(baseUrl)` — where `baseUrl` is the **profile directory**

---

## 2. The decisive evidence

### Host-side diagnostics from the packaged app (before the fix)

```
[dsh-desktop] loader.internal present: false, resolveSync: undefined
[dsh-desktop] fallback resolve from profile FAILED:
              Error: Cannot find module '@deepseek-ai/dsh-client-modules/package.json'
[dsh-desktop] client graph: 0 entries, 0 batches (rev 240c4d8dcf0d)
```

### The full causal chain

```
1. locatePkgJson checks ctx.loader.internal
        |
2. Electron has no --expose-internals -> internal === undefined
        |
3. Falls back to createRequire(profileDir).resolve('@deepseek-ai/<pkg>/package.json')
        |
4. No DSH package exists under the profile directory -> MODULE_NOT_FOUND
        |
5. Every entry is discarded -> sources = 0 -> composed graph = 0 entries
        |
6. The bundle the HTML requests is absent from the graph -> /plugins returns 404
        |
7. The UI shows "Failed to load plugins"
```

### Corroboration: the `pkgMeta` keys expose the fallback

```
clientModules pkgMeta entries: 128
  meta file:///D:/.../desktop-profile/ cordis:include: null
  meta file:///D:/.../desktop-profile/ @deepseek-ai/cordis-plugin-timer: null
```

**Every key is prefixed with `desktop-profile/`** — the fingerprint of the fallback
using the profile as its `baseUrl`.

---

## 3. Why the source build is unaffected

**It is an accident of layout:**

```
source profile directory:  <repo>\desktop-profile
                           | upward lookup finds node_modules
                           <repo>\node_modules\@deepseek-ai\...  <- hit!
```

In a source checkout the profile sits **inside the project**, so Node's upward lookup
**reaches through** to the project's `node_modules` and the fallback succeeds.

**Once packaged, the profile is at `resources/desktop-profile` with nothing above it
to reach** — so it fails.

> An earlier audit flagged that same "reach-through" as a design defect
> (see `self-maintenance.md`). **It turned out to be the final explanation of this failure.**

---

## 4. Relationship to the other known problems

This root cause also explains two previously recorded issues:

| Problem | Connection |
|---|---|
| HMR unavailable (needs `--expose-internals`) | **Same origin** — both trace to Electron being unable to provide Node internals |
| Packaged profile resolution reaching the dev machine | **Same origin** — both are symptoms of a non-self-contained profile |

**These three problems are three faces of one root cause.**

---

## 5. Impact

| Scenario | Before the fix | After the fix |
|---|---|---|
| `npm start` (development) | Works | Works |
| Packaged app | **Unusable** | **Works** |

**Cost**: the installer grows (a second copy of the DSH tree under the profile).
Using a junction/symlink instead of a copy would avoid the duplication.

---

## 6. Diagnostic tooling (now built in)

`host.ts` prints these at startup (in BOTH builds, so they compare directly):

```
[dsh-desktop] client graph: N entries, M batches (rev ...)
[dsh-desktop] loader rows: N total, M with fiber, K disabled
[dsh-desktop] loader.internal present: true|false, resolveSync: function|undefined
[dsh-desktop] fallback resolve from profile SUCCEEDED|FAILED: ...
[dsh-desktop] clientModules pkgMeta entries: N
```

---

## 7. Evidence strength

- **Confirmed by measurement**: before the fix `loader.internal` was `undefined`,
  the fallback resolve failed, and the graph held 0 entries; **after the fix,
  53 entries, `mode: live`, and a fully rendered UI**
- **The causal chain is complete**: from the missing internal through the failed
  fallback, the empty scan, the empty graph, the 404 bundle, to the UI error — every
  link has measurement or source behind it
- **Hypotheses disproved during the investigation** (recorded for reference): asar
  read failure, constructor-time race, and the `onlyLoadAppFromAsar` fuse — all three
  were eliminated by measurement
