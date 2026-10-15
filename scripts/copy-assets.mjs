/**
 * Copy non-TypeScript assets into `dist/`, and make the preload loadable.
 *
 * Two things happen here that the TypeScript build cannot express:
 *
 * 1. The settings window's HTML is copied verbatim.
 * 2. The preload is renamed to `.cjs`. `package.json` declares
 *    `"type": "module"`, so a compiled-CommonJS `settings.js` would be parsed
 *    as ESM and fail at load; Electron requires a sandboxed preload to be
 *    CommonJS, and the `.cjs` extension is what makes that unambiguous.
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const copies = [
  { from: join(root, 'src', 'settings'), to: join(root, 'dist', 'settings') },
]

for (const { from, to } of copies) {
  if (!existsSync(from)) {
    console.warn(`[build] skipping missing asset source: ${from}`)
    continue
  }
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
  console.log(`[build] copied ${from} -> ${to}`)
}

// Rename every compiled preload to `.cjs` so Node and Electron both read it as
// CommonJS despite the package-level `"type": "module"`.
const preloadDir = join(root, 'dist', 'preload')
if (existsSync(preloadDir)) {
  for (const name of ['settings']) {
    const js = join(preloadDir, `${name}.js`)
    const cjs = join(preloadDir, `${name}.cjs`)
    if (existsSync(js)) {
      renameSync(js, cjs)
      console.log(`[build] preload ${name}.js -> ${name}.cjs`)
    }
    const map = join(preloadDir, `${name}.js.map`)
    if (existsSync(map)) rmSync(map)
  }
}
