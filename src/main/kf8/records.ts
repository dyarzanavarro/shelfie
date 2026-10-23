// Low-level KF8 (AZW3) record writers: PalmDB container, text records, INDX indexes and CNCX strings.
// Layouts mirror what Amazon's own tools produce, verified against real Kindle store files.

export const NULL = 0xffffffff
export const TEXT_RECORD_SIZE = 4096

/** Kindle's base-32 digits (0-9, A-V), zero-padded to `width`. */
export const base32 = (n: number, width: number) => n.toString(32).toUpperCase().padStart(width, '0')

/** Forward variable-width integer: 7 bits per byte, most significant first, high bit set on the last byte. */
export function forwardVarint(n: number): Buffer {
  const bytes = [n & 0x7f]
  for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) bytes.unshift(n & 0x7f)
  bytes[bytes.length - 1] |= 0x80
  return Buffer.from(bytes)
}

export function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}

const padTo4 = (b: Buffer) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b)

/**
 * PalmDOC compression (LZ77 with a 2047-byte window, 3–10 byte matches, and a "space + letter"
 * shorthand). Matches are found through hash chains of 3-byte prefixes.
 */
export function compressPalmDoc(data: Buffer): Buffer {
  const n = data.length
  const out = Buffer.alloc(n + Math.ceil(n / 8) + 16)
  let o = 0
  const head = new Int32Array(1 << 13).fill(-1)
  const prev = new Int32Array(n)
  const hash = (p: number) => ((data[p] << 7) ^ (data[p + 1] << 4) ^ data[p + 2]) & 0x1fff
  const insert = (p: number) => {
    if (p + 2 >= n) return
    const h = hash(p)
    prev[p] = head[h]
    head[h] = p
  }

  for (let i = 0; i < n; ) {
    let bestLen = 0
    let bestDist = 0
    if (i + 3 <= n) {
      for (let p = head[hash(i)], chain = 0; p >= 0 && i - p <= 2047 && chain < 64; p = prev[p], chain++) {
        let len = 0
        while (len < 10 && i + len < n && data[p + len] === data[i + len]) len++
        if (len > bestLen) {
          bestLen = len
          bestDist = i - p
          if (len === 10) break
        }
      }
    }
    if (bestLen >= 3) {
      out[o++] = 0x80 | (bestDist >> 5)
      out[o++] = ((bestDist << 3) & 0xff) | (bestLen - 3)
      for (let k = 0; k < bestLen; k++) insert(i + k)
      i += bestLen
      continue
    }
    const c = data[i]
    if (c === 0x20 && i + 1 < n && data[i + 1] >= 0x40 && data[i + 1] <= 0x7f) {
      out[o++] = data[i + 1] ^ 0x80
      insert(i)
      insert(i + 1)
      i += 2
    } else if (c === 0 || (c >= 9 && c <= 0x7f)) {
      out[o++] = c
      insert(i++)
    } else {
      // Bytes 1–8 and 0x80+ can't stand alone: emit a counted literal run of up to 8.
      let j = i
      while (j < n && j - i < 8 && (data[j] >= 0x80 || (data[j] >= 1 && data[j] <= 8))) j++
      out[o++] = j - i
      for (; i < j; i++) {
        out[o++] = data[i]
        insert(i)
      }
    }
  }
  return out.subarray(0, o)
}

/**
 * Splits text into 4096-byte records, each PalmDOC-compressed. Each record ends with the bytes
 * needed to finish a UTF-8 character cut at the boundary, plus a byte counting them (the
 * "multibyte" trailing entry, extra data flag 1).
 */
export function textRecords(text: Buffer): Buffer[] {
  const records: Buffer[] = []
  for (let i = 0; i < text.length; i += TEXT_RECORD_SIZE) {
    const next = i + TEXT_RECORD_SIZE
    let overlap = 0
    while (overlap < 3 && next + overlap < text.length && (text[next + overlap] & 0xc0) === 0x80) overlap++
    records.push(Buffer.concat([compressPalmDoc(text.subarray(i, next)), text.subarray(next, next + overlap), Buffer.from([overlap])]))
  }
  return records
}

/** Strings referenced from index entries by offset (record number * 0x10000 + byte offset). */
export class Cncx {
  private records: Buffer[][] = [[]]
  private size = 0
  private offsets = new Map<string, number>()

  add(s: string): number {
    const known = this.offsets.get(s)
    if (known !== undefined) return known
    const bytes = Buffer.from(s, 'utf8')
    const entry = Buffer.concat([forwardVarint(bytes.length), bytes])
    if (this.size + entry.length > 0xfff8) {
      this.records.push([])
      this.size = 0
    }
    const offset = (this.records.length - 1) * 0x10000 + this.size
    this.records[this.records.length - 1].push(entry)
    this.size += entry.length
    this.offsets.set(s, offset)
    return offset
  }

  toRecords(): Buffer[] {
    return this.offsets.size ? this.records.map((parts) => padTo4(Buffer.concat(parts))) : []
  }
}

export interface TagDef {
  tag: number
  /** Values per occurrence. */
  perEntry: number
  /** Bits of the control byte that hold the occurrence count. */
  mask: number
}

export interface IndexEntry {
  label: string
  tags: Map<number, number[]>
}

function lowestBit(mask: number): number {
  let shift = 0
  while (!((mask >> shift) & 1)) shift++
  return shift
}

function serializeEntry(entry: IndexEntry, groups: TagDef[][]): Buffer {
  const label = Buffer.from(entry.label, 'latin1')
  const control: number[] = []
  const data: Buffer[] = []
  for (const group of groups) {
    let byte = 0
    for (const def of group) {
      const values = entry.tags.get(def.tag)
      if (!values?.length) continue
      const occurrences = values.length / def.perEntry
      const shift = lowestBit(def.mask)
      if (!Number.isInteger(occurrences) || occurrences << shift > def.mask) {
        throw new Error(`Index tag ${def.tag} has ${values.length} values; doesn't fit its mask`)
      }
      byte |= occurrences << shift
    }
    control.push(byte)
  }
  for (const def of groups.flat()) for (const v of entry.tags.get(def.tag) ?? []) data.push(forwardVarint(v))
  return Buffer.concat([Buffer.from([label.length]), label, Buffer.from(control), ...data])
}

function indxHeader(fields: Record<number, number>): Buffer {
  const h = Buffer.alloc(192)
  h.write('INDX', 0, 'latin1')
  h.writeUInt32BE(192, 4)
  for (const [off, v] of Object.entries(fields)) h.writeUInt32BE(v >>> 0, Number(off))
  return h
}

function idxt(offsets: number[]): Buffer {
  const b = Buffer.alloc(4 + 2 * offsets.length)
  b.write('IDXT', 0, 'latin1')
  offsets.forEach((o, i) => b.writeUInt16BE(o, 4 + 2 * i))
  return padTo4(b)
}

const MAX_ENTRY_BYTES = 0xf000

/** An INDX index: header record, data records, then its CNCX records. Entries must be sorted by label. */
export function buildIndex(entries: IndexEntry[], groups: TagDef[][], cncx: Buffer[] = []): Buffer[] {
  const serialized = entries.map((e) => serializeEntry(e, groups))

  // Data records, each holding as many entries as fit.
  const dataRecords: Buffer[] = []
  const geometry: Array<{ last: string; count: number }> = []
  for (let i = 0; i < serialized.length; ) {
    const offsets: number[] = []
    const parts: Buffer[] = []
    let size = 0
    while (i < serialized.length && (parts.length === 0 || size + serialized[i].length + 2 * (parts.length + 1) < MAX_ENTRY_BYTES)) {
      offsets.push(192 + size)
      parts.push(serialized[i])
      size += serialized[i].length
      i++
    }
    const body = padTo4(Buffer.concat(parts))
    dataRecords.push(
      Buffer.concat([indxHeader({ 12: 1, 20: 192 + body.length, 24: parts.length, 28: NULL, 32: NULL }), body, idxt(offsets)])
    )
    geometry.push({ last: entries[i - 1].label, count: parts.length })
  }

  // TAGX: tag definitions, with an end marker closing each control byte's group.
  const tagDefs = groups.flatMap((g) => [...g.map((d) => [d.tag, d.perEntry, d.mask, 0]), [0, 0, 0, 1]])
  const tagx = Buffer.alloc(12 + 4 * tagDefs.length)
  tagx.write('TAGX', 0, 'latin1')
  tagx.writeUInt32BE(tagx.length, 4)
  tagx.writeUInt32BE(groups.length, 8)
  tagDefs.forEach((d, i) => Buffer.from(d).copy(tagx, 12 + 4 * i))

  const geoOffsets: number[] = []
  const geoParts: Buffer[] = []
  let pos = 192 + tagx.length
  for (const g of geometry) {
    const label = Buffer.from(g.last, 'latin1')
    const count = Buffer.alloc(2)
    count.writeUInt16BE(g.count)
    const part = Buffer.concat([Buffer.from([label.length]), label, count])
    geoOffsets.push(pos)
    geoParts.push(part)
    pos += part.length
  }
  const geo = padTo4(Buffer.concat(geoParts))
  const header = Buffer.concat([
    indxHeader({
      16: 2,
      20: 192 + tagx.length + geo.length,
      24: dataRecords.length,
      28: 65001,
      32: NULL,
      36: entries.length,
      52: cncx.length,
      180: 192
    }),
    tagx,
    geo,
    idxt(geoOffsets)
  ])
  return [header, ...dataRecords, ...cncx]
}

/** FLIS and FCIS: fixed-layout records every Kindle book carries. */
export function flisRecord(): Buffer {
  return Buffer.from('464c4953000000080041000000000000ffffffff000100030000000300000001ffffffff', 'hex')
}

export function fcisRecord(textLength: number): Buffer {
  const b = Buffer.from('46434953000000140000001000000002000000000000000000000000000000280000000000000028000000080001000100000000', 'hex')
  b.writeUInt32BE(textLength, 20)
  return b
}

export const EOF_RECORD = Buffer.from([0xe9, 0x8e, 0x0d, 0x0a])

/** PalmDB container: 78-byte header, record table, 2 bytes of padding, then the records. */
export function palmDb(name: string, records: Buffer[]): Buffer {
  const header = Buffer.alloc(78)
  header.write(name.slice(0, 31), 0, 'latin1')
  const now = Math.floor(Date.now() / 1000)
  header.writeUInt32BE(now, 36)
  header.writeUInt32BE(now, 40)
  header.write('BOOKMOBI', 60, 'latin1')
  header.writeUInt32BE(2 * records.length - 1, 68)
  header.writeUInt16BE(records.length, 76)

  const table = Buffer.alloc(8 * records.length + 2)
  let offset = header.length + table.length
  records.forEach((r, i) => {
    table.writeUInt32BE(offset, 8 * i)
    table.writeUInt32BE((2 * i) & 0xffffff, 8 * i + 4)
    offset += r.length
  })
  return Buffer.concat([header, table, ...records])
}
