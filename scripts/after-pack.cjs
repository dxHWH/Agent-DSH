/**
 * electron-builder afterPack hook: make the packaged profile self-contained.
 *
 * The two local packages (`file:packages/dsh-tool-example`, `file:packages/dsh-tool-feedback-archive`)
 * are installed by npm as directory JUNCTIONS. `extraResources` copies
 * `node_modules/@deepseek-ai` verbatim, junctions included, so the packaged
 * `resources/desktop-profile/node_modules/@deepseek-ai/dsh-tool-example` still points at
 * the BUILD machine's `D:\...\packages\dsh-tool-example`. On any other machine that
 * path does not exist and the project tools / feedback archive fail to load.
 *
 * This hook replaces every junction/symlink under the profile with a real copy of
 * the package's shipped files (package.json + its `files` entries), then fails
 * the build if any reparse point remains anywhere in the output.
 */
const fs = require('node:fs')
const path = require('node:path')

/** Copy only what the package publishes: package.json + `files` globs' top-level dirs/files. */
function copyPackage(srcDir, destDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'))
  const roots = new Set(['package.json'])
  for (const entry of pkg.files ?? []) roots.add(entry.split(/[\\/]/)[0])
  fs.mkdirSync(destDir, { recursive: true })
  for (const name of roots) {
    const from = path.join(srcDir, name)
    if (!fs.existsSync(from)) continue
    fs.cpSync(from, path.join(destDir, name), { recursive: true, dereference: true })
  }
  return [...roots]
}

/** Every symlink/junction under `dir` (does not descend into links). */
function findLinks(dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) out.push(p)
    else if (e.isDirectory()) findLinks(p, out)
  }
  return out
}

exports.default = async function afterPack(context) {
  const resources = path.join(context.appOutDir, 'resources')
  const profileModules = path.join(resources, 'desktop-profile', 'node_modules')

  for (const link of findLinks(profileModules)) {
    const target = fs.realpathSync(link)
    fs.rmSync(link, { recursive: false, force: true })
    // rmSync on a junction removes the link only; make sure nothing is left.
    if (fs.existsSync(link)) fs.rmdirSync(link)
    if (!fs.statSync(target).isDirectory() || !fs.existsSync(path.join(target, 'package.json'))) {
      throw new Error(`afterPack: link ${link} -> ${target} is not a package directory`)
    }
    const copied = copyPackage(target, link)
    console.log(`  • afterPack: materialized ${path.relative(resources, link)} (${copied.join(', ')})`)
  }

  const remaining = findLinks(context.appOutDir)
  if (remaining.length > 0) {
    throw new Error(`afterPack: packaged output still contains links to the build machine:\n  ${remaining.join('\n  ')}`)
  }
}
