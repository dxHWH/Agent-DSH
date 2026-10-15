# Phase 1 notes — minimum viable client

English | [中文](phase1-notes.zh.md)

> Status: **complete and measured**
> Code: `src/main/{index,host,paths}.ts`
> Environment: Electron 37.10.3 (Node 22.21.1), `@deepseek-ai/dsh@0.1.5-rc.2`

---

## Terminology

| Term | Meaning |
|---|---|
| plugin tree | The final mounted structure produced by stacking every patch layer |
| entry | One mounted item in the plugin tree |
| pending | An entry held inactive because a service it depends on is not provided yet |
| inject | An entry's declaration of which services it needs in order to activate |
| prepare callback | The hook `boot()` runs before it mounts the plugin tree |
| commit | Confirm a successful boot and release work registered through `onReady` |
| spawn | Create a child process |
| asar | Electron's packaging archive; files inside it cannot be executed by path |

---

## 1. Outcome

The application starts, boots the DSH host in-process, and loads the real UI.
Measured log:

```
[dsh-desktop] data root (userdata): C:\Users\<user>\AppData\Roaming\DSH Desktop\dsh-home
[dsh-desktop] anchor: <repo>\node_modules\@deepseek-ai\dsh\package.json
[dsh-desktop] profile: initializing <repo>\desktop-profile
[dsh-desktop] profile loaded: 2 bundle layer(s)
[dsh-desktop] listening on 127.0.0.1:54199
[dsh-desktop] loading http://127.0.0.1:54199/?token=***
```

Independently verified:
```
GET /                              -> 401   (auth gateway working)
GET /assets/index-BKQ_L1z6.js      -> 200, 555,959 bytes  (byte count matches the source file)
```

**Plan A holds end to end.**

---

## 2. Three obstacles that had to be solved (all measured)

### 2.1 Electron's bundled Node is too old

**Symptom**: the plugin tree fails to load, reporting three missing built-in
module exports:
```
node:zlib   does not provide createZstdCompress
node:util   does not provide getSystemErrorMessage
node:module does not provide stripTypeScriptTypes
```

**Root cause**: Electron 33 bundles Node **20.18.3**, while DSH requires Node 22+
(`zstd` is 22.15+, `stripTypeScriptTypes` is 22.13+, `getSystemErrorMessage` is
22.14+).

**Fix**: upgrade to **Electron 37.10.3 (Node 22.21.1)**; all four APIs are present.

**This is a hard constraint**: Electron 33 and earlier cannot run DSH.

### 2.2 The main process must be ESM

**Symptom**: `ERR_REQUIRE_ESM` — every DSH package is `"type": "module"`.

**Fix**: `tsconfig.json` uses `"module": "ES2022"`, and `package.json` declares
`"type": "module"`. Electron 28+ supports an ESM main process.

### 2.3 A missing `provideCmdline` leaves 11 entries pending forever

**Symptom**:
```
dsh-desktop: 11 entries did not activate
@deepseek-ai/dsh-web-app/startup: pending (waiting for service: cmdlineArgs)
@deepseek-ai/dsh-host-webserver:   pending (waiting for service: webStartup)
...
```

**Root cause**: `web-startup` injects `cmdlineArgs` and parses it into the
`webStartup` service; the webserver and other rows then inject `webStartup`.
Without `cmdlineArgs` the whole chain breaks.

**Fix**: call this inside `boot`'s prepare callback:
```ts
provideCmdline(hostCtx, { args: [...], exit, ready })
```

`appReady` must be provided too: it is `commit()`ed after a successful boot to
release lifecycle work. The commit timing matters — committing on a *failed*
boot would mask the real error.

---

## 3. A patch-semantics trap (important)

**A patch entry's `config` replaces the row's config wholesale — it does not merge.**

Measured evidence (`scripts/diagnostics/check-patches.mjs`): when the desktop patch wrote only
`config: { printUrl: false, surfaceContext: true }`, the composed result was:

```json
{ "printUrl": false, "surfaceContext": true }
```

`openBrowser` **disappeared** and fell back to the plugin schema default of
`true` — so DSH quietly launched a system browser behind Electron's back.

**The correct approach**: restate every field the row needs.

```ts
{ id: 'web-runtime', config: {
    openBrowser: false, printUrl: false, surfaceContext: true, trustedHosts: [],
} }
```

The trap is worth internalizing: a patch *looks* like "override a few keys", but
it actually *replaces the whole config object*.

---

## 4. The command-line contract

`provideCmdline`'s `args` go straight to commander's
`program.parse(args, { from: 'user' })`.

Measured (`scripts/diagnostics/check-cmdline.mjs`):

| args | action ran? | Result |
|---|---|---|
| `['--no-open', '--port', '0']` | yes | `openBrowser: false, port: '0'` |
| `['web', '--no-open']` | no | `excessArguments` |
| `['dsh --profile web', ...]` | no | `excessArguments` |

In other words: **do not include the program name** — pass flags only.

The final choice is `['--no-open', '--port', '0']`:
- `--no-open` makes `openBrowser` false (belt and braces with the patch)
- `--port 0` lets the OS assign a port; `readPort` reads the real value back

---

## 5. Data root and portability (the "move to another Windows machine" requirement)

`resolveDshHome()` resolves in this order: **explicit config > `$DSH_HOME` > `~/.dsh`**.

The desktop shell sets `process.env.DSH_HOME` **before importing any DSH module**.
The ordering is load-bearing — DSH resolves its home at import time.

Measured: after startup, DSH wrote every piece of user state under `dsh-home`:
```
%APPDATA%\DSH Desktop\dsh-home\.credentials.yaml      <- API credentials
%APPDATA%\DSH Desktop\dsh-home\.anonymous-user-id
%APPDATA%\DSH Desktop\dsh-home\storages\workspace.json
```

**Nothing landed outside `dsh-home`.**

`src/main/paths.ts` supports four data-root modes:

| Mode | Location | Use |
|---|---|---|
| `userdata` | `%APPDATA%\DSH Desktop\dsh-home` | Default |
| `portable` | `dsh-data\dsh-home` beside the executable | The whole folder can be copied |
| `custom` | A user-chosen absolute path | On a shared or synced drive |
| `env` | Whatever `$DSH_HOME` says | Power users, CI |

The choice is recorded in `desktop-shell.json` next to the executable — it stores
*where* the data lives, never the data itself — so a portable deployment moves by
copying the folder.

---

## 6. On the "keep the API configuration surface" requirement

**No parallel configuration store was created.** This is deliberate:

- Credentials go through DSH's `.credentials.yaml` (`ctx.credentials`)
- Settings go through DSH's `settings.yaml`
- Both live under `dsh-home` and are managed by DSH's own Settings UI

The shell **does not bypass, copy, or cache** those values, which means:

1. DSH's official model/credential settings UI works unchanged (decided earlier:
   reuse rather than rebuild)
2. A key configured in the desktop app also works when `dsh web` is pointed at
   the same `DSH_HOME`
3. Credentials travel with `dsh-home` during migration

`host.ts` is the only file that touches the DSH API, and it only boots the host
and reads the port/token — it never touches settings or credentials. That
discipline is what guarantees the properties above.

---

## 7. Open items and next steps

- **HMR is not enabled**: DSH's HMR service requires Node's `--expose-internals`,
  which cannot be appended after an Electron main process starts. The shell
  deliberately does not mount it, avoiding a startup error. The profile still
  declares `patchReload: live`, but the watcher is not force-enabled.
- **`node-pty` native build**: `build/Release/pty.node` is absent, but
  `prebuilds/win32-x64/` ships complete prebuilt artifacts (`conpty.node`,
  `conpty.dll`, `OpenConsole.exe`), so no local compilation is needed. Those
  native binaries must be `asarUnpack`ed when packaging, or child processes
  cannot load them. **Handled and verified in Phase 3.**
- **Tray, window state, native capabilities**: Phase 2. **Complete.**
- **Packaging, and asar's effect on child-process spawn**: Phase 3's primary risk.
  **Verified** — the packaged app serves its frontend correctly from the
  unpacked tree.
