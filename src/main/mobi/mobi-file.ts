import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const NULL_INDEX = 0xffffffff

export interface MobiHeader {
  /** Absolute record number of this header's record 0. */
  base: number
  compression: number
  textLength: number
  textRecordCount: number
  encryption: number
  encoding: 'utf8' | 'latin1'
  version: number
  headerLength: number
  firstImage: number
  extraDataFlags: number
  ncxIndex: number
  fragmentIndex: number
  skeletonIndex: number
  fdstIndex: number
  fullName: string
  exth: Map<number, Buffer[]>
}

export interface IndexEntry {
  text: Buffer
  tags: Map<number, number[]>
}

export interface Index {
  entries: IndexEntry[]
  cncx: Map<number, string>
}

/** Forward-encoded variable-width integer: 7 bits per byte, high bit marks the last byte. */
function readForwardVarint(buf: Buffer, pos: number): [value: number, consumed: number] {
  let value = 0
  let consumed = 0
  while (pos + consumed < buf.length) {
    const b = buf[pos + consumed++]
    value = value * 128 + (b & 0x7f)
    if (b & 0x80) break
  }
  return [value, consumed]
}

/** Trailing entries are stored backwards at the end of each text record. */
function trailingEntriesSize(rec: Buffer, flags: number): number {
  let size = 0
  for (let f = flags >> 1; f; f >>= 1) {
    if (!(f & 1)) continue
    let value = 0
    let shift = 0
    for (let end = rec.length - size; end > 0; ) {
      const b = rec[--end]
      value |= (b & 0x7f) << shift
      shift += 7
      if (b & 0x80 || shift >= 28 || end === 0) break
    }
    size += value
  }
  if (flags & 1) size += (rec[rec.length - size - 1] & 0x3) + 1
  return size
}

function decompressPalmDoc(input: Buffer): Buffer {
  const out = Buffer.alloc(Math.max(input.length * 8, 4096))
  let o = 0
  for (let i = 0; i < input.length; ) {
    const c = input[i++]
    if (c >= 1 && c <= 8) {
      input.copy(out, o, i, i + c)
      o += c
      i += c
    } else if (c < 0x80) {
      out[o++] = c
    } else if (c >= 0xc0) {
      out[o++] = 0x20
      out[o++] = c ^ 0x80
    } else {
      const pair = (c << 8) | input[i++]
      const distance = (pair >> 3) & 0x7ff
      const length = (pair & 7) + 3
      for (let j = 0; j < length; j++, o++) out[o] = out[o - distance]
    }
  }
  return out.subarray(0, o)
}

/** HUFF/CDIC decompression (used by most Amazon-produced books). */
class HuffCdic {
  private dict1: Array<[codelen: number, term: boolean, maxcode: number]> = []
  private mincode: number[] = []
  private maxcode: number[] = []
  private dictionary: Array<{ data: Buffer; done: boolean } | null> = []

  constructor(huff: Buffer, cdics: Buffer[]) {
    if (huff.toString('latin1', 0, 8) !== 'HUFF\0\0\0\x18') throw new Error('Invalid HUFF record')
    const off1 = huff.readUInt32BE(8)
    const off2 = huff.readUInt32BE(12)
    for (let i = 0; i < 256; i++) {
      const v = huff.readUInt32BE(off1 + i * 4)
      const codelen = v & 0x1f
      this.dict1.push([codelen, (v & 0x80) !== 0, ((v >>> 8) + 1) * 2 ** (32 - codelen) - 1])
    }
    this.mincode.push(0)
    this.maxcode.push(2 ** 32 - 1)
    for (let codelen = 1; codelen <= 32; codelen++) {
      const min = huff.readUInt32BE(off2 + (codelen - 1) * 8)
      const max = huff.readUInt32BE(off2 + (codelen - 1) * 8 + 4)
      this.mincode.push(min * 2 ** (32 - codelen))
      this.maxcode.push((max + 1) * 2 ** (32 - codelen) - 1)
    }

    for (const cdic of cdics) {
      if (cdic.toString('latin1', 0, 8) !== 'CDIC\0\0\0\x10') throw new Error('Invalid CDIC record')
      const phrases = cdic.readUInt32BE(8)
      const bits = cdic.readUInt32BE(12)
      const n = Math.min(2 ** bits, phrases - this.dictionary.length)
      for (let i = 0; i < n; i++) {
        const off = cdic.readUInt16BE(16 + i * 2)
        const len = cdic.readUInt16BE(16 + off)
        this.dictionary.push({ data: cdic.subarray(18 + off, 18 + off + (len & 0x7fff)), done: (len & 0x8000) !== 0 })
      }
    }
  }

  unpack(input: Buffer): Buffer {
    const data = Buffer.concat([input, Buffer.alloc(8)])
    const totalBits = input.length * 8
    const out: Buffer[] = []
    for (let bit = 0; ; ) {
      const byte = bit >>> 3
      const shift = bit & 7
      const word = data.readUInt32BE(byte)
      const code = shift ? ((word << shift) | (data[byte + 4] >>> (8 - shift))) >>> 0 : word

      let [codelen, term, maxcode] = this.dict1[code >>> 24]
      if (!term) {
        while (code < this.mincode[codelen]) codelen++
        maxcode = this.maxcode[codelen]
      }
      bit += codelen
      if (bit > totalBits) break

      const r = Math.floor((maxcode - code) / 2 ** (32 - codelen))
      const entry = this.dictionary[r]
      if (!entry) throw new Error('Corrupt HUFF/CDIC data')
      if (!entry.done) {
        this.dictionary[r] = null // guards against cycles
        entry.data = this.unpack(entry.data)
        entry.done = true
        this.dictionary[r] = entry
      }
      out.push(entry.data)
    }
    return Buffer.concat(out)
  }
}

export class MobiFile {
  readonly buf: Buffer
  readonly recordCount: number
  /** The header used for text: the KF8 one when the file contains KF8, else the legacy MOBI one. */
  readonly header: MobiHeader
  readonly isKF8: boolean

  constructor(file: string | Buffer) {
    this.buf = typeof file === 'string' ? readFileSync(file) : file
    if (this.buf.toString('ascii', 60, 68) !== 'BOOKMOBI') throw new Error('Not a MOBI/AZW file')
    this.recordCount = this.buf.readUInt16BE(76)

    const first = this.readHeader(0)
    const boundary = first.exth.get(121)?.[0]?.readUInt32BE(0)
    if (first.version >= 8) {
      this.header = first
    } else if (boundary !== undefined && boundary !== NULL_INDEX && boundary < this.recordCount) {
      this.header = this.readHeader(boundary)
    } else {
      this.header = first
    }
    this.isKF8 = this.header.version >= 8
  }

  record(i: number): Buffer {
    const start = this.buf.readUInt32BE(78 + i * 8)
    const end = i + 1 < this.recordCount ? this.buf.readUInt32BE(78 + (i + 1) * 8) : this.buf.length
    return this.buf.subarray(start, end)
  }

  private readHeader(base: number): MobiHeader {
    const r = this.record(base)
    if (r.toString('ascii', 16, 20) !== 'MOBI') throw new Error('Missing MOBI header')
    const headerLength = r.readUInt32BE(20)
    const u32 = (off: number) => (off + 4 <= 16 + headerLength ? r.readUInt32BE(off) : NULL_INDEX)
    const encoding = r.readUInt32BE(28) === 65001 ? 'utf8' : 'latin1'

    const exth = new Map<number, Buffer[]>()
    let pos = 16 + headerLength
    if (r.readUInt32BE(128) & 0x40 && r.toString('ascii', pos, pos + 4) === 'EXTH') {
      const count = r.readUInt32BE(pos + 8)
      pos += 12
      for (let i = 0; i < count && pos + 8 <= r.length; i++) {
        const type = r.readUInt32BE(pos)
        const len = r.readUInt32BE(pos + 4)
        if (len < 8) break
        exth.set(type, [...(exth.get(type) ?? []), r.subarray(pos + 8, pos + len)])
        pos += len
      }
    }

    const nameOffset = r.readUInt32BE(84)
    return {
      base,
      compression: r.readUInt16BE(0),
      textLength: r.readUInt32BE(4),
      textRecordCount: r.readUInt16BE(8),
      encryption: r.readUInt16BE(12),
      encoding,
      version: r.readUInt32BE(36),
      headerLength,
      firstImage: r.readUInt32BE(108),
      extraDataFlags: headerLength >= 0xe4 ? r.readUInt16BE(0xf2) : 0,
      ncxIndex: u32(0xf4),
      fragmentIndex: u32(0xf8),
      skeletonIndex: u32(0xfc),
      fdstIndex: u32(0xc0),
      fullName: r.toString(encoding, nameOffset, nameOffset + r.readUInt32BE(88)),
      exth
    }
  }

  exthString(type: number): string | undefined {
    return this.header.exth.get(type)?.[0]?.toString(this.header.encoding).trim() || undefined
  }

  exthStrings(type: number): string[] {
    return (this.header.exth.get(type) ?? []).map((b) => b.toString(this.header.encoding).trim()).filter(Boolean)
  }

  /** Decompressed book text (all flows for KF8) as raw bytes. */
  text(): Buffer {
    const h = this.header
    if (h.encryption !== 0) throw new Error('This book is DRM-protected and cannot be converted')
    if (![1, 2, 17480].includes(h.compression)) throw new Error(`Unknown compression type ${h.compression}`)

    let huff: HuffCdic | undefined
    if (h.compression === 17480) {
      const r0 = this.record(h.base)
      const first = h.base + r0.readUInt32BE(0x70)
      const count = r0.readUInt32BE(0x74)
      huff = new HuffCdic(this.record(first), Array.from({ length: count - 1 }, (_, i) => this.record(first + 1 + i)))
    }

    const parts: Buffer[] = []
    for (let i = 1; i <= h.textRecordCount; i++) {
      const rec = this.record(h.base + i)
      const data = rec.subarray(0, rec.length - trailingEntriesSize(rec, h.extraDataFlags))
      parts.push(huff ? huff.unpack(data) : h.compression === 2 ? decompressPalmDoc(data) : data)
    }
    const text = Buffer.concat(parts)
    // In KF8 the flow table (FDST) defines the boundaries; textLength may cover only the HTML flow.
    return this.isKF8 ? text : text.subarray(0, h.textLength)
  }

  /** Index record numbers in the header are relative to the header's base record. */
  readIndex(relativeIndex: number): Index | undefined {
    if (relativeIndex === NULL_INDEX) return undefined
    const start = this.header.base + relativeIndex
    const head = this.record(start)
    if (head.toString('ascii', 0, 4) !== 'INDX') return undefined

    const indexCount = head.readUInt32BE(24)
    const cncxCount = head.readUInt32BE(52)
    const tagxStart = head.readUInt32BE(4)
    if (head.toString('ascii', tagxStart, tagxStart + 4) !== 'TAGX') return undefined
    const tagxLength = head.readUInt32BE(tagxStart + 4)
    const controlByteCount = head.readUInt32BE(tagxStart + 8)
    const tagTable: Array<[tag: number, perEntry: number, mask: number, end: number]> = []
    for (let p = tagxStart + 12; p < tagxStart + tagxLength; p += 4) {
      tagTable.push([head[p], head[p + 1], head[p + 2], head[p + 3]])
    }

    const cncx = new Map<number, string>()
    for (let j = 0; j < cncxCount; j++) {
      const rec = this.record(start + indexCount + 1 + j)
      for (let p = 0; p < rec.length && rec[p] !== 0; ) {
        const offset = p
        const [len, consumed] = readForwardVarint(rec, p)
        p += consumed
        cncx.set(j * 0x10000 + offset, rec.toString(this.header.encoding, p, p + len))
        p += len
      }
    }

    const entries: IndexEntry[] = []
    for (let i = 1; i <= indexCount; i++) {
      const rec = this.record(start + i)
      const idxt = rec.readUInt32BE(20)
      const count = rec.readUInt32BE(24)
      const positions = Array.from({ length: count }, (_, j) => rec.readUInt16BE(idxt + 4 + 2 * j))
      positions.push(idxt)
      for (let j = 0; j < count; j++) {
        const pos = positions[j]
        const textLength = rec[pos]
        entries.push({
          text: rec.subarray(pos + 1, pos + 1 + textLength),
          tags: this.readTagMap(rec, pos + 1 + textLength, controlByteCount, tagTable)
        })
      }
    }
    return { entries, cncx }
  }

  private readTagMap(
    rec: Buffer,
    start: number,
    controlByteCount: number,
    tagTable: Array<[number, number, number, number]>
  ): Map<number, number[]> {
    const pending: Array<{ tag: number; count?: number; bytes?: number; perEntry: number }> = []
    let controlIndex = 0
    let dataPos = start + controlByteCount

    for (const [tag, perEntry, mask, end] of tagTable) {
      if (end === 1) {
        controlIndex++
        continue
      }
      let value = rec[start + controlIndex] & mask
      if (value === 0) continue
      if (value === mask && bitCount(mask) > 1) {
        const [bytes, consumed] = readForwardVarint(rec, dataPos)
        dataPos += consumed
        pending.push({ tag, bytes, perEntry })
      } else {
        let m = mask
        while (!(m & 1)) {
          m >>= 1
          value >>= 1
        }
        pending.push({ tag, count: value, perEntry })
      }
    }

    const tags = new Map<number, number[]>()
    for (const { tag, count, bytes, perEntry } of pending) {
      const values: number[] = []
      if (count !== undefined) {
        for (let k = 0; k < count * perEntry; k++) {
          const [v, consumed] = readForwardVarint(rec, dataPos)
          dataPos += consumed
          values.push(v)
        }
      } else {
        for (let used = 0; used < bytes!; ) {
          const [v, consumed] = readForwardVarint(rec, dataPos)
          dataPos += consumed
          used += consumed
          values.push(v)
        }
      }
      tags.set(tag, values)
    }
    return tags
  }

  /** KF8 flow table: byte ranges of the text flows (flow 0 is HTML, the rest CSS/SVG). */
  flows(text: Buffer): Buffer[] {
    const idx = this.header.fdstIndex
    if (!this.isKF8 || idx === NULL_INDEX) return [text]
    const rec = this.record(this.header.base + idx)
    if (rec.toString('ascii', 0, 4) !== 'FDST') return [text]
    const count = rec.readUInt32BE(8)
    return Array.from({ length: count }, (_, i) => text.subarray(rec.readUInt32BE(12 + i * 8), rec.readUInt32BE(16 + i * 8)))
  }

  /**
   * Resource by 0-based index from the first image record. Images in combined MOBI/KF8 files are
   * shared, so for the KF8 header try relative to its base first, then absolute.
   */
  resource(index: number): Buffer | undefined {
    const first = this.header.firstImage
    if (first === NULL_INDEX) return undefined
    const candidates = this.header.base ? [this.header.base + first + index, first + index] : [first + index]
    for (const n of candidates) {
      if (n < this.recordCount) {
        const rec = this.record(n)
        if (rec.length && !isMetaRecord(rec)) return decodeFontRecord(rec)
      }
    }
    return undefined
  }

  coverIndex(): number | undefined {
    const off = this.header.exth.get(201)?.[0]
    return off && off.length >= 4 ? off.readUInt32BE(0) : undefined
  }
}

function bitCount(n: number): number {
  let c = 0
  for (; n; n >>= 1) c += n & 1
  return c
}

const META_TAGS = new Set(['FLIS', 'FCIS', 'SRCS', 'BOUN', 'DATP', 'RESC', 'CMET', 'PAGE', 'CRES', 'FDST', 'INDX', 'EOF\0'])

function isMetaRecord(rec: Buffer): boolean {
  return META_TAGS.has(rec.toString('latin1', 0, 4)) || (rec.length === 4 && rec.readUInt32BE(0) === 0xe98e0d0a)
}

/** KF8 embedded fonts: optional XOR obfuscation of the first 1040 bytes, then optional zlib. */
function decodeFontRecord(rec: Buffer): Buffer {
  if (rec.toString('ascii', 0, 4) !== 'FONT') return rec
  const flags = rec.readUInt32BE(8)
  const dataStart = rec.readUInt32BE(12)
  const xorLen = rec.readUInt32BE(16)
  const xorStart = rec.readUInt32BE(20)
  let data = Buffer.from(rec.subarray(dataStart))
  if (flags & 2 && xorLen > 0) {
    const key = rec.subarray(xorStart, xorStart + xorLen)
    for (let i = 0; i < Math.min(1040, data.length); i++) data[i] ^= key[i % xorLen]
  }
  if (flags & 1) data = inflateSync(data)
  return data
}
