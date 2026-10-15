# Dangling default preset: "选择工作区 does nothing"

**Symptom.** In the packaged desktop app, picking a workspace appeared to work and
then did nothing. The "选择工作区" button opened its menu, "添加工作区…" opened the
in-app directory browser, **打开** listed real directories, and the chosen folder
even appeared in the sidebar under 工作区 — but the main view stayed on
「选择一个工作区开始」 forever. No error dialog appeared anywhere, and the console
was silent unless you went looking.

**Cause.** Nothing to do with the directory picker, and nothing to do with the
desktop shell. `settings.yaml` contained:

```yaml
agent-presets:
  default: code
```

`code` is not a preset this DSH build ships. `AgentPresets.resolve()` does not
fall back on an unknown id — it throws:

```
agent-preset/not-found: preset "code" not found
(available: standard, ptc, minimal, cordis, project)
```

Picking a workspace triggers session creation, and session creation resolves the
default preset. So the failure landed one step *after* the part the UI made
visible, which is why the picker looked broken.

**Why the error was invisible.** The hero picker's `onPick` handler swallows the
rejection:

```js
onPick: (workspaceId) => {
  setPickerOpen(false);
  setPendingWorkspaceId(workspaceId);
  selectWorkspace(workspaceId).catch(() => {
    setPendingWorkspaceId((current) => current === workspaceId ? void 0 : current);
  });
}
```

The `catch` reverts the optimistic selection and shows nothing. The only trace is
a `console.warn` from a different call site (`initial workspace selection
failed: …`). The sidebar's own `startSession` path logs a similar warning. Neither
surfaces in the UI.

**Why the id was dangling.** `settings.yaml` is portable between machines and DSH
versions, and preset sets differ between builds. This machine's `~/.dsh/settings.yaml`
is the source — it carries `default: code`, which the global DSH install resolves
against a different preset set. The desktop data root inherited the same value. On
DSH 0.1.5-rc.2 only four presets ship:

```
cordis  minimal  ptc  standard
```

There is no `code` preset anywhere in the installation. It is a leftover from
another version, not a user choice that can be honoured.

## The fix

`src/main/presets.ts` repairs a dangling default once, at startup, before the
window can create a session. It mirrors the discipline of `locale.ts`:

- **Only a dangling id is touched.** If the configured id resolves, nothing is
  written — including an unusual-but-valid choice like `cordis`.
- **Only the value is substituted.** Comments, key order, indentation style and
  every other section survive byte-for-byte. No YAML round-trip.
- **An empty preset list means "do not touch anything".** A failed enumeration
  must never be mistaken for "no presets exist", which would rewrite a good
  default.
- **It does not author the missing preset.** A dangling id points at something
  that is not there; inventing it would silently change agent behaviour.
- **The fallback is itself validated**, so the repair cannot write a second
  dangling id.

The authoritative preset list is read from the live composition
(`host.availablePresets()`), not assumed, because the shipped set changes between
builds.

Observed startup log on a home carrying `default: code`:

```
[dsh-desktop] presets: 5 available (standard, ptc, minimal, cordis, project)
[dsh-desktop] preset default: repaired — default preset "code" does not exist
              in this build; reset to "standard"
```

Second launch, same home:

```
[dsh-desktop] preset default: unchanged — default "standard" resolves
```

## A second, unrelated defect found on the way

While verifying the fix, DSH failed to boot at all with:

```
settings-file: invalid document at …/settings.yaml:
BLOCK_AS_IMPLICIT_KEY at line 103, column 17
```

Line 103 had two keys on one line, because a mojibake character in a model name
had swallowed the newline during an earlier GBK/UTF-8 round-trip of the file:

```yaml
- id: my-model-selfhosted
  name: My-Model-鑷儴缃?          contextWindow: 200000    # two keys, one line
```

This is pre-existing corruption in `settings.yaml`, unrelated to the desktop
shell, and it breaks DSH startup for any client. It was repaired to:

```yaml
- id: my-model-selfhosted
  name: My-Model-自部署
  contextWindow: 200000
```

Both `settings.yaml` copies on this machine were affected at the same line and
were fixed. Worth keeping in mind when a `settings.yaml` travels between
machines: mojibake in a value can corrupt the *structure*, not just the text.

## Verification

| Check | Result |
| --- | --- |
| `node scripts/selfcheck-presets.mjs` | 22/22 |
| Packaged/dev app self-heals `default: code` | `repaired` → `standard`, empty stderr |
| Second launch is idempotent | `unchanged` |
| Composer reachable after picking a workspace | yes (textarea present, no warnings) |
| `project` (project mode) still offered | yes, among the 5 presets |

## Deliberate non-goals

- **Not fixed in DSH.** `resolve()`'s hard failure is DSH's own design and the
  installation is not modified. The repair lives in the shell, which owns the
  portable `settings.yaml`.
- **No UI for it.** The repair is not a user-facing feature; it is a guard against
  a class of stale configuration. It logs and moves on.
