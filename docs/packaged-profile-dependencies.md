# The profile's missing dependencies: 15 typert contributors and a lone `zod`

**Symptom.** After the previous fix, the installed build got further and then
failed with a wall of errors that all named the same missing package:

```
dsh-desktop: plugin tree failed to load: failed to apply loader entry
typert-loader (@deepseek-ai/dsh-typert-loader): typert-loader: 15 typert
contributor(s) failed to register:
  - typert-loader: @deepseek-ai/dsh-llm exports "./typert" but importing
    …\resources\desktop-profile\node_modules\@deepseek-ai\dsh-llm\lib\typert.host.js
    failed: Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod'
  … (14 more, all 'zod')
```

Note the path: **`resources\desktop-profile\node_modules\`** — not `app.asar`.

**Cause.** This is a direct consequence of an earlier fix. To make client-plugin
resolution work in the packaged layout, `electron-builder.config.cjs` copies
`node_modules/@deepseek-ai` under `desktop-profile/`, so that
`createRequire(profileDir).resolve(...)` can find the DSH packages.

But DSH packages import ordinary npm dependencies too — `zod`, `commander`,
`diff`, `js-yaml` and ~28 more. **Only `@deepseek-ai` was copied.** Node
resolves a bare specifier by walking *up* from the importing file, so
`desktop-profile/node_modules/@deepseek-ai/dsh-llm/lib/typert.host.js` looks in
`desktop-profile/node_modules/` and finds nothing but `@deepseek-ai`. It never
looks inside `app.asar`, where those packages actually live.

In a source checkout this never happens: the profile sits inside the project, so
the upward walk reaches the project's `node_modules` and everything resolves. The
defect exists only in the packaged layout.

**Why one name appeared 15 times.** The typert loader imports 15 contributors in
one batch and reports each failure separately. All 15 failed for the same reason —
`zod` — because `zod` is the first import in each `typert.host.js`. The 15 entries
are one root cause, not 15 problems.

## The scope was larger than the error suggested

An audit of the profile's real import graph found **31 unresolvable packages** (excerpt below),
not just `zod`:

```
@agentclientprotocol/sdk   @babel/code-frame        @earendil-works/pi-ai
@joplin/turndown-plugin-gfm @modelcontextprotocol/sdk @octokit/webhooks
@opentelemetry/api-logs     @opentelemetry/exporter-logs-otlp-http
@opentelemetry/resources    @opentelemetry/sdk-logs  @vscode/ripgrep
commander  compression  diff  eventsource-parser  fflate
ipaddr.js  js-yaml  koffi  mime-types  negotiator
node-addon-require-builtin  node-pty  picomatch  resolve.exports
sharp  turndown  undici  ws  yaml  zod
```

Fixing only `zod` would have produced the same boot failure with a different name
one step later. This is why the fix is driven by the import graph rather than by
the error message.

## The fix

`extraResources` now copies those packages into `desktop-profile/node_modules`
alongside `@deepseek-ai`. Copying just the needed set (rather than the whole
622 MB `node_modules`) keeps the installer at ~133 MB; the 31 packages total
about 57 MB.

## The guard

`scripts/audit-profile-dependencies.mjs` recomputes the list from the real import
graph — it walks every host-side `.js` file in the profile's packages, extracts
bare `import`/`require` specifiers, and reports any that cannot resolve. It runs as
part of `postdist`, so a DSH release that adds a dependency is caught at build
time rather than at a user's launch.

Two classes of false positive had to be excluded, or the audit would cry wolf and
hide real findings:

- **Browser-side halves** (`lib/client.js`). These are shipped to the renderer by
  `client-modules` and run in the browser, where React comes from the frontend
  bundle. They are never executed by the host Node process. Reporting them flagged
  `react`/`react-dom` as missing forever.
- **Node builtins** and template-literal fragments such as `` `${spec}` ``, which
  minified bundles contain and the specifier regexes pick up as package names.

## Verification

| Check | Result |
| --- | --- |
| `audit-profile-dependencies.mjs <profile>` | 0 unresolvable |
| `audit-packaged-packages.mjs <asar>` | 240/240, 0 missing |
| Packaged app boots | yes, `client graph: 53 entries, 2 batches`, empty stderr |
| `verify-packaged-ui.mjs <port>` | 5/5 |

## The pattern

Three packaging-only failures in a row, each hidden behind the previous one:

1. `packaged-plugin-failure.md` — client plugins could not resolve their manifests.
2. `packaged-peer-dependency-failure.md` — 24 peer-only packages absent from the archive.
3. This one — the profile's copy of the DSH tree had no sibling dependencies.

Each was introduced or exposed by the fix for the one before. The common lesson is
that **a copied subtree is not a working environment**: copying packages without
their dependency closure produces a tree that resolves in the source checkout and
fails in the artifact. Both audits now run on every `npm run dist`.
