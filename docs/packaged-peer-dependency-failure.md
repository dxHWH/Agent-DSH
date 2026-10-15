# The installer boot failure: peer-only packages never reach the archive

**Symptom.** A freshly installed build failed at startup with a single line in the
error window:

```
DSH host failed to start
Cannot find package '@deepseek-ai/cordis-plugin-group' imported from
…\resources\app.asar\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js
```

The package was present in the source tree and worked in development. Only the
packaged app was broken.

**Cause.** electron-builder walks `dependencies` to decide what to ship. DSH
declares many *runtime-required* packages as `peerDependencies` instead — the
cordis plugin chain, and the seam packages (`dsh-fs`, `dsh-sandbox`,
`dsh-settings`, `dsh-shell`, …). A peer dependency is not hoisted into the tree
electron-builder follows, so those packages sat in `node_modules` but never
entered the archive. The host imports them at boot, so it died on the first one it
reached — `cordis-plugin-group`, imported directly by `dsh-app-boot`.

The single name in the error was misleading: it was simply the first miss. An
audit of the installed archive found **24 missing packages**:

```
cordis-plugin-group        dsh-jobs                    dsh-session-telemetry
dsh-anonymous-user-id      dsh-output-retention        dsh-session-title-llm
dsh-attachment             dsh-sandbox                 dsh-settings
dsh-authorization          dsh-sdk-protocol            dsh-shell
dsh-bash-local             dsh-session-persistence     dsh-spill
dsh-code-runtime           dsh-session-query           dsh-subagent-in-process-driver
dsh-compaction                                         dsh-util-time
dsh-fs                     dsh-hook-protocol           dsh-util-workspace-path
                                                       dsh-workflow
```

Every one of the 24 is peer-only, and every one is declared as a peer by at least
one package that *is* packaged. That is the signature: the archive contained the
declarer but not the dependency.

This also explains why development never caught it. `npm start` runs from the
source tree, where `node_modules` has all 240 packages regardless of how they were
declared. The defect only exists in the packaged artifact.

## The fix

The 24 packages are declared explicitly in `package.json` `dependencies`, pinned
to the versions already resolved in `node_modules`, so electron-builder's walk
reaches them. No install changes versions — the tree already had exactly these
versions; the declaration only makes them visible to the packager.

Verified: **240 of 240** `@deepseek-ai` packages now in the archive, and the
installed build boots clean.

## Why this was worth a guard, not just a patch

Two properties make this class of bug dangerous:

1. **It is invisible until packaging.** Every dev signal — `npm start`, the
   self-checks, the audits — runs against a tree where the packages exist.
2. **It fails one package at a time.** The error names whichever import the boot
   sequence reached first, so fixing just that one would have produced an
   identical failure with a different name.

`scripts/audit-packaged-packages.mjs` therefore compares the archive against disk
and fails if anything is missing. It runs as `postdist`, so `npm run dist` now
reports an incomplete archive at build time instead of at a user's first launch.

Diagnostic counterpart: `scripts/diagnostics/diagnose-missing-packages.mjs` explains *why*
packages are missing by reporting, for each one, which packaged package declares
it and in which field. It is what identified the peer-only pattern.

## Verification

| Check | Result |
| --- | --- |
| `node scripts/audit-packaged-packages.mjs <asar>` | 240/240, 0 missing |
| Installed build boots | yes, empty stderr |
| `node scripts/verify-packaged-ui.mjs <port>` | 5/5 |

## Related

This is the third packaging-only defect in this project, after
`docs/packaged-plugin-failure.md` (the client-plugin resolution failure) and
`docs/directory-picker-failure.md` (the picker worker). The common thread: the
packaged runtime is a genuinely different environment from the source checkout,
and each difference has to be verified *in the artifact*, not inferred from a
working dev loop.
