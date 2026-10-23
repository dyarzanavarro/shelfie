import { crc32, deflateRawSync } from 'node:zlib'

interface Entry {
  name: Buffer
  method: 0 | 8
  crc: number
  size: number
  data: Buffer
  offset: number
}

/** Minimal ZIP writer that keeps insertion order (EPUB requires "mimetype" first and uncompressed). */
export class ZipWriter {
  private entries: Entry[] = []
  private chunks: Buffer[] = []
  private offset = 0

  add(name: string, content: Buffer | string, store = false): void {
    const raw = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    const deflated = store ? raw : deflateRawSync(raw)
    const useStore = store || deflated.length >= raw.length
    const entry: Entry = {
      name: Buffer.from(name, 'utf8'),
      method: useStore ? 0 : 8,
      crc: crc32(raw),
      size: raw.length,
      data: useStore ? raw : deflated,
      offset: this.offset
    }
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6) // UTF-8 file names
    header.writeUInt16LE(entry.method, 8)
    header.writeUInt16LE(0, 10) // time 00:00
    header.writeUInt16LE((2020 - 1980) << 9 | (1 << 5) | 1, 12) // date 2020-01-01
    header.writeUInt32LE(entry.crc, 14)
    header.writeUInt32LE(entry.data.length, 18)
    header.writeUInt32LE(entry.size, 22)
    header.writeUInt16LE(entry.name.length, 26)
    header.writeUInt16LE(0, 28)
    this.chunks.push(header, entry.name, entry.data)
    this.offset += header.length + entry.name.length + entry.data.length
    this.entries.push(entry)
  }

  toBuffer(): Buffer {
    const central: Buffer[] = []
    for (const e of this.entries) {
      const h = Buffer.alloc(46)
      h.writeUInt32LE(0x02014b50, 0)
      h.writeUInt16LE(20, 4)
      h.writeUInt16LE(20, 6)
      h.writeUInt16LE(0x0800, 8)
      h.writeUInt16LE(e.method, 10)
      h.writeUInt16LE(0, 12)
      h.writeUInt16LE((2020 - 1980) << 9 | (1 << 5) | 1, 14)
      h.writeUInt32LE(e.crc, 16)
      h.writeUInt32LE(e.data.length, 20)
      h.writeUInt32LE(e.size, 24)
      h.writeUInt16LE(e.name.length, 28)
      h.writeUInt32LE(e.offset, 42)
      central.push(h, e.name)
    }
    const cd = Buffer.concat(central)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(this.entries.length, 8)
    end.writeUInt16LE(this.entries.length, 10)
    end.writeUInt32LE(cd.length, 12)
    end.writeUInt32LE(this.offset, 16)
    return Buffer.concat([...this.chunks, cd, end])
  }
}
