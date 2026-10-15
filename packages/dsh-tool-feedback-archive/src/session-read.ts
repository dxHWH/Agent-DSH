/**
 * 会话读取：从 `.jsonl.zstd` 文件解出 header + 事件流。
 *
 * DSH 的 session 日志是「拼接的多帧」zstd（header 1 帧 + 每批事件各 1 帧，带 checksum）。
 * 需要先做帧扫描（ZSTD_MAGIC = 0x28B52FFD LE），再逐帧 zstdDecompressSync。
 * 该算法与 dsh-session-persistence-jsonl 的 scanZstdFrames 一致。
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { Buffer } from 'node:buffer'
import type { SessionEventLike, SessionHeaderLike } from './types.js'

const ZSTD_MAGIC = 4247762216 // 0x28B52FFD 小端读

/** 扫描完整帧区间。 */
export function scanZstdFrames(input: Uint8Array): Array<{ start: number; end: number }> {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const frames: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt zstd: invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset); offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) break
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt zstd: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) break
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

/** 多帧解压整个 `.jsonl.zstd` 为明文文本。 */
export function decompressZstdFile(bytes: Uint8Array): string {
  const frames = scanZstdFrames(bytes)
  const parts: string[] = []
  for (const f of frames) {
    parts.push(zstdDecompressSync(bytes.subarray(f.start, f.end)).toString('utf8'))
  }
  return parts.join('')
}

/** 解析 JSONL 文本为事件流 + header。 */
export function parseSessionLog(text: string): { header?: SessionHeaderLike; events: SessionEventLike[] } {
  const events: SessionEventLike[] = []
  let header: SessionHeaderLike | undefined
  for (const line of text.split('\n')) {
    const l = line.trim()
    if (!l) continue
    let o: any
    try {
      o = JSON.parse(l)
    } catch {
      continue
    }
    if (o.type === 'session' && header === undefined) {
      header = o as unknown as SessionHeaderLike
      continue
    }
    events.push(o as SessionEventLike)
  }
  return { header, events }
}

/** 从文件路径读取 session 日志（header + 事件流）。 */
export function readSessionFile(path: string): { header?: SessionHeaderLike; events: SessionEventLike[] } {
  const bytes = readFileSync(path)
  const text = decompressZstdFile(bytes)
  return parseSessionLog(text)
}
