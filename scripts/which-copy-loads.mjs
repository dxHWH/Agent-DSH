/**
 * Determine which physical copy of a packaged file Electron actually loads.
 *
 * ## Why this matters
 *
 * `asarUnpack` COPIES rather than moves, so a file can appear to exist in two
 * places. Which one runs is not obvious, and getting it wrong makes a hand
 * applied hotfix look either effective or useless when it is the opposite.
 *
 * The archive's own header answers it definitively. An entry carrying
 * `"unpacked": true` has **no bytes in the archive** — the only real copy is
 * under `app.asar.unpacked`, and that is the one Electron loads. An entry with a
 * numeric `offset` lives inside the archive and is read from there.
 *
 * The practical rule for this project: everything under `node_modules/@deepseek-ai/**`
 * matches `asarUnpack`, so those files load from `app.asar.unpacked` and editing
 * that copy DOES take effect. `dist/main/*.js` (the shell itself) does not match,
 * so it loads from inside the archive.
 *
 * This reads the header directly instead of using `@electron/asar`'s
 * `extractFile`, whose key handling rejects the separator style `listPackage`
 * returns. Reading the header needs no extraction and cannot be confused by it.
 *
 * Usage:
 *   node scripts/which-copy-loads.mjs <resourcesDir> <moduleRelPath> [more paths...]
 */
import { closeSync, openSync, readFileSync, readSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const [resourcesDir, ...moduleRels] = process.argv.slice(2)

if (!resourcesDir || moduleRels.length === 0) {
  console.error('usage: node scripts/which-copy-loads.mjs <resourcesDir> <moduleRelPath> [more...]')
  process.exit(1)
}

const archivePath = join(resourcesDir, 'app.asar')
if (!existsSync(archivePath)) {
  console.error(`no archive at ${archivePath}`)
  process.exit(1)
}

/**
 * Read an asar archive's JSON header.
 *
 * Layout: a 16-byte pickle prefix whose last uint32 is the JSON length, then the
 * JSON itself, then the file payloads.
 */
function readAsarHeader(path) {
  const fd = openSync(path, 'r')
  try {
    const prefix = Buffer.alloc(16)
    readSync(fd, prefix, 0, 16, 0)
    const jsonSize = prefix.readUInt32LE(12)
    const json = Buffer.alloc(jsonSize)
    readSync(fd, json, 0, jsonSize, 16)
    return JSON.parse(json.toString('utf8'))
  } finally {
    closeSync(fd)
  }
}

/** Walk the header tree by path segments. */
function lookup(node, segments) {
  let current = node
  for (const segment of segments) {
    if (!current?.files) return undefined
    current = current.files[segment]
    if (!current) return undefined
  }
  return current
}

const header = readAsarHeader(archivePath)

console.log(`archive: ${archivePath}\n`)

let problems = 0

for (const rel of moduleRels) {
  const segments = rel.replace(/\\/g, '/').split('/').filter(Boolean)
  const entry = lookup(header, segments)

  console.log(rel)

  if (!entry) {
    console.log('  NOT IN ARCHIVE (and therefore not an unpacked member either)')
    problems += 1
    console.log('')
    continue
  }

  const unpackedPath = join(resourcesDir, 'app.asar.unpacked', ...segments)
  const onDisk = existsSync(unpackedPath)

  if (entry.unpacked === true) {
    console.log(`  loads from : app.asar.unpacked  (size ${entry.size} bytes)`)
    console.log(`  file there : ${onDisk ? 'present' : 'MISSING — this is a broken package'}`)
    if (!onDisk) problems += 1
  } else if ('offset' in entry) {
    // The header omits `offset` when it is 0 — an entry that owns the first
    // payload still lives inside the archive, so presence of the KEY is the
    // signal rather than a numeric value.
    const offset = entry.offset ?? 0
    console.log(`  loads from : inside app.asar  (offset ${offset}, size ${entry.size} bytes)`)
    if (onDisk) {
      console.log('  ALSO on disk under app.asar.unpacked — that copy is NOT loaded')
    }
  } else {
    console.log(`  ambiguous: neither unpacked nor offset (keys: ${Object.keys(entry).join(', ')})`)
    problems += 1
  }
  console.log('')
}

console.log(problems === 0 ? 'all entries resolved' : `${problems} entr(ies) need attention`)
process.exit(problems === 0 ? 0 : 1)
