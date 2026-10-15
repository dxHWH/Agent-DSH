# knowledge/

Domain knowledge assets shipped with the plugin (glossaries, field semantics,
curated mappings…). The directory is listed in `package.json` `files`, so it is
packaged alongside `lib/`.

Locate it from code relative to the package root, never from `process.cwd()`:

```ts
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const knowledgeDir = join(packageRoot, 'knowledge')
```

Rules of thumb:

- Load lazily and degrade gracefully: a missing or malformed asset must yield
  an empty result, never a tool failure.
- Assets are hand-curated facts; keep them versioned and reviewable (Markdown /
  JSON), and record in the result evidence when an answer came from an asset
  rather than from the live project (`verified: false`).
- Never put machine-specific absolute paths or secrets here
  (`scripts/bundle-portable.mjs` scans packaged text for local paths).
