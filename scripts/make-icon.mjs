/**
 * Generate `assets/icon.ico`, `icon.png` and `icon.svg` without an image library.
 *
 * electron-builder wants a Windows `.ico` with at least a 256×256 entry. Rather
 * than add a native image dependency, this renders the app mark into raw RGBA
 * buffers and writes the ICO container by hand — the format is a small header
 * plus one BMP payload per size.
 *
 * Run: node scripts/make-icon.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const SIZES = [16, 24, 32, 48, 64, 128, 256]

/**
 * Draw the mark: a rounded dark tile with a lighter glyph, using the palette
 * from the app's own UI so the icon matches the window chrome.
 */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4) // RGBA, bottom-up handled below
  const bg = [26, 26, 26, 255] // #1a1a1a, the app background
  const fg = [76, 141, 255, 255] // #4c8dff, the accent

  const radius = size * 0.22
  const inset = size * 0.5 - radius

  /** Signed distance to a rounded square, for antialiased edges. */
  const roundRect = (x, y, half, r) => {
    const dx = Math.abs(x) - (half - r)
    const dy = Math.abs(y) - (half - r)
    const ax = Math.max(dx, 0)
    const ay = Math.max(dy, 0)
    return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r
  }

  // Glyph: a chevron ">" suggesting a prompt, drawn as two thick strokes.
  const stroke = Math.max(1.5, size * 0.085)
  const chevron = (x, y) => {
    // Distance from the point to the two segments forming ">".
    const x0 = size * 0.36
    const y0 = size * 0.34
    const x1 = size * 0.58
    const y1 = size * 0.5
    const x2 = size * 0.36
    const y2 = size * 0.66
    const seg = (px, py, ax, ay, bx, by) => {
      const vx = bx - ax
      const vy = by - ay
      const wx = px - ax
      const wy = py - ay
      const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
      return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
    }
    return Math.min(seg(x, y, x0, y0, x1, y1), seg(x, y, x0, y0 + (y2 - y0), x1, y1))
  }

  // A bar after the chevron, reading as a cursor/underscore.
  const bar = (x, y) => {
    const bx0 = size * 0.62
    const bx1 = size * 0.76
    const by = size * 0.66
    const inside = x >= bx0 && x <= bx1 && Math.abs(y - by) <= stroke / 2
    return inside ? 0 : Number.POSITIVE_INFINITY
  }

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = px + 0.5 - size / 2
      const y = py + 0.5 - size / 2

      // Tile coverage with a 1px antialiased edge.
      const d = roundRect(x, y, size / 2, radius)
      const tile = Math.max(0, Math.min(1, 0.5 - d))

      // Glyph coverage.
      const gd = Math.min(chevron(px + 0.5, py + 0.5), bar(px + 0.5, py + 0.5))
      const glyph = Math.max(0, Math.min(1, 0.5 - (gd - stroke / 2)))

      const r = Math.round(bg[0] * (1 - glyph) + fg[0] * glyph)
      const g = Math.round(bg[1] * (1 - glyph) + fg[1] * glyph)
      const b = Math.round(bg[2] * (1 - glyph) + fg[2] * glyph)
      const a = Math.round(255 * tile)

      // ICO stores rows bottom-up.
      const row = size - 1 - py
      const off = (row * size + px) * 4
      pixels[off] = b
      pixels[off + 1] = g
      pixels[off + 2] = r
      pixels[off + 3] = a
    }
  }
  return pixels
}

/** Wrap one rendered size as a 32-bit BMP payload (the ICO DIB format). */
function toDib(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight (image + mask)
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // biCompression = BI_RGB
  header.writeUInt32LE(rgba.length, 20) // biSizeImage

  // The AND mask is 1bpp, row-padded to 4 bytes; all zero means "use alpha".
  const maskStride = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskStride * size)
  return Buffer.concat([header, rgba, mask])
}

const images = SIZES.map((size) => ({ size, dib: toDib(render(size), size) }))

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type = icon
header.writeUInt16LE(images.length, 4)

const entries = Buffer.alloc(16 * images.length)
let offset = header.length + entries.length
images.forEach(({ size, dib }, index) => {
  const at = index * 16
  entries[at] = size >= 256 ? 0 : size // 0 means 256
  entries[at + 1] = size >= 256 ? 0 : size
  entries[at + 2] = 0 // palette
  entries[at + 3] = 0 // reserved
  entries.writeUInt16LE(1, at + 4) // planes
  entries.writeUInt16LE(32, at + 6) // bit count
  entries.writeUInt32LE(dib.length, at + 8)
  entries.writeUInt32LE(offset, at + 12)
  offset += dib.length
})

const ico = Buffer.concat([header, entries, ...images.map((i) => i.dib)])

mkdirSync(join(root, 'assets'), { recursive: true })
const out = join(root, 'assets', 'icon.ico')
writeFileSync(out, ico)
console.log(`[icon] wrote ${out} (${ico.length} bytes, sizes: ${SIZES.join(', ')})`)

// ── icon.png (tray + window icon): the 256px render as a PNG ────────────────
// `render()` produces BGRA rows bottom-up (the ICO DIB layout); PNG wants RGBA
// rows top-down, each prefixed with a filter byte (0 = none).
{
  const size = 256
  const bgra = render(size)
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4
    const dst = y * (size * 4 + 1)
    raw[dst] = 0
    for (let x = 0; x < size; x++) {
      const s = src + x * 4
      const d = dst + 1 + x * 4
      raw[d] = bgra[s + 2]
      raw[d + 1] = bgra[s + 1]
      raw[d + 2] = bgra[s]
      raw[d + 3] = bgra[s + 3]
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
  const pngOut = join(root, 'assets', 'icon.png')
  writeFileSync(pngOut, png)
  console.log(`[icon] wrote ${pngOut} (${png.length} bytes)`)
}

// ── icon.svg: the same mark as vector (docs, web, and `scripts/brand.mjs`) ──
{
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" rx="14" fill="#1a1a1a"/>' +
    '<path d="M23 21.8 37.1 32 23 42.2" fill="none" stroke="#4c8dff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M39.7 42.2h8.9" stroke="#4c8dff" stroke-width="6" stroke-linecap="round"/></svg>\n'
  const svgOut = join(root, 'assets', 'icon.svg')
  writeFileSync(svgOut, svg)
  console.log(`[icon] wrote ${svgOut}`)
}
