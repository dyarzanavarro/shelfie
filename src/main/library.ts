import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImportResult } from '../shared/types'
import { LibraryDb } from './db'
import createConvertWorker from './convert-worker?nodeWorker'
import type { EpubMetadata } from './epub/types'
import { extractMetadata, formatOf } from './metadata'
import { readOpfFile } from './metadata/epub'
import { detectImageExt, type ExtractedCover, type ExtractedMetadata } from './metadata/types'

// Conversion is CPU-heavy (seconds for large books), so it runs off the main process thread.
function convertInWorker(source: string, meta: EpubMetadata, target: 'epub' | 'azw3'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const worker = createConvertWorker({ workerData: { source, meta, target } })
    worker.once('message', (m: { ok: boolean; data?: Uint8Array; message?: string }) =>
      m.ok ? resolve(Buffer.from(m.data!)) : reject(new Error(m.message))
    )
    worker.once('error', reject)
    worker.once('exit', (code) => code !== 0 && reject(new Error(`Converter stopped unexpectedly (code ${code})`)))
  })
}

interface Sidecar {
  meta: ExtractedMetadata
  coverFile?: string
}

interface ImportGroup {
  files: string[]
  sidecar?: Sidecar
}

// EPUB first: it carries the richest metadata and cover, and later formats merge into it.
const FORMAT_PRIORITY = ['epub', 'azw3', 'mobi', 'azw', 'pdf']

async function collectGroups(dir: string, groups: ImportGroup[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile() && formatOf(e.name))
    .map((e) => join(dir, e.name))
    .sort((a, b) => FORMAT_PRIORITY.indexOf(formatOf(a)!) - FORMAT_PRIORITY.indexOf(formatOf(b)!))

  if (files.length) {
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name.toLowerCase()))
    if (names.has('metadata.opf')) {
      let meta: ExtractedMetadata = {}
      try {
        meta = readOpfFile(join(dir, 'metadata.opf'))
      } catch (err) {
        console.warn(`Unreadable metadata.opf in ${dir}:`, err)
      }
      groups.push({ files, sidecar: { meta, coverFile: names.has('cover.jpg') ? join(dir, 'cover.jpg') : undefined } })
    } else {
      for (const file of files) groups.push({ files: [file] })
    }
  }

  for (const sub of entries.filter((e) => e.isDirectory())) await collectGroups(join(dir, sub.name), groups)
}

async function readCoverFile(file: string | undefined): Promise<ExtractedCover | undefined> {
  if (!file) return undefined
  const data = await readFile(file).catch(() => null)
  const ext = data && detectImageExt(data)
  return data && ext ? { data, ext } : undefined
}

const MAX_SEGMENT = 80

function safeSegment(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEGMENT)
    .replace(/[. ]+$/, '')
  return cleaned || 'Unknown'
}

// Calibre stores local midnight as UTC, e.g. "1843-08-31T22:00:00+00:00" for 1843-09-01 in UTC+2.
function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(T(\d{2}))?/)
  if (!m || Number(m[1]) < 1000) return null // Calibre writes 0101-01-01 for "unknown"
  if (m[4] && m[3] && Number(m[5]) >= 12) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1))
    return d.toISOString().slice(0, 10)
  }
  return [m[1], m[2], m[3]].filter(Boolean).join('-')
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

export class Library {
  readonly db: LibraryDb

  constructor(readonly root: string) {
    this.db = new LibraryDb(join(root, 'library.db'))
  }

  absDir(bookId: number): string | undefined {
    const dir = this.db.getDir(bookId)
    return dir ? join(this.root, dir) : undefined
  }

  async coverPath(bookId: number): Promise<string | undefined> {
    const dir = this.absDir(bookId)
    if (!dir) return undefined
    const cover = (await readdir(dir).catch(() => [])).find((f) => f.startsWith('cover.'))
    return cover ? join(dir, cover) : undefined
  }

  absPath(relPath: string): string {
    return join(this.root, relPath)
  }

  /** Converts the book's MOBI/AZW3 file to EPUB and stores it as an extra format. Returns the EPUB path. */
  async convertToEpub(bookId: number): Promise<string> {
    const book = this.db.getBook(bookId)
    if (!book) throw new Error('Book not found')
    const existing = book.formats.find((f) => f.format === 'epub')
    if (existing) return this.absPath(existing.path)

    const source = ['azw3', 'mobi', 'azw'].map((fmt) => book.formats.find((f) => f.format === fmt)).find(Boolean)
    if (!source) throw new Error('No MOBI or AZW3 file to convert')

    return this.storeConverted(bookId, await convertInWorker(this.absPath(source.path), book, 'epub'), 'epub')
  }

  /** Converts the book's EPUB to AZW3 (what Kindles read over USB) and stores it. Returns the AZW3 path. */
  async convertToAzw3(bookId: number): Promise<string> {
    const book = this.db.getBook(bookId)
    if (!book) throw new Error('Book not found')
    const existing = book.formats.find((f) => f.format === 'azw3')
    if (existing) return this.absPath(existing.path)

    const source = book.formats.find((f) => f.format === 'epub')
    if (!source) throw new Error('No EPUB file to convert')
    return this.storeConverted(bookId, await convertInWorker(this.absPath(source.path), book, 'azw3'), 'azw3')
  }

  private async storeConverted(bookId: number, data: Buffer, format: 'epub' | 'azw3'): Promise<string> {
    const book = this.db.getBook(bookId)!
    const relPath = join(this.db.getDir(bookId)!, `${safeSegment(book.title)} - ${safeSegment(book.authors[0] ?? 'Unknown')}.${format}`)
    await writeFile(this.absPath(relPath), data)
    this.db.addFormat(bookId, format, relPath, data.length, createHash('sha256').update(data).digest('hex'))
    return this.absPath(relPath)
  }

  /** Imports files and folders; folders are searched recursively. */
  async importFiles(paths: string[], onProgress?: (done: number, total: number) => void): Promise<ImportResult[]> {
    const groups: ImportGroup[] = []
    for (const path of paths) {
      const info = await stat(path).catch(() => null)
      if (info?.isDirectory()) await collectGroups(path, groups)
      else groups.push({ files: [path] })
    }

    const total = groups.reduce((n, g) => n + g.files.length, 0)
    const results: ImportResult[] = []
    for (const group of groups) {
      // Every file in a Calibre book folder is the same book, so later formats join the first one.
      let mergeInto: number | undefined
      for (const path of group.files) {
        const result = await this.importOne(path, group.sidecar, mergeInto)
        if (group.sidecar && result.bookId) mergeInto = result.bookId
        results.push(result)
        onProgress?.(results.length, total)
      }
    }
    return results
  }

  private async importOne(path: string, sidecar?: Sidecar, mergeInto?: number): Promise<ImportResult> {
    const format = formatOf(path)
    if (!format) return { path, status: 'unsupported', message: 'Unsupported file type' }

    let bookId: number | undefined
    let absDir: string | undefined
    try {
      const hash = await hashFile(path)
      if (this.db.hashExists(hash)) return { path, status: 'duplicate', message: 'Already in library' }

      const { size } = await stat(path)
      const { cover, ...meta } = sidecar?.meta.title && sidecar.meta.authors?.length
        ? { ...sidecar.meta, cover: await readCoverFile(sidecar.coverFile) }
        : await extractMetadata(path, format)
      const title = meta.title!
      const authors = meta.authors!

      const fileName = `${safeSegment(title)} - ${safeSegment(authors[0])}.${format}`
      const target = mergeInto !== undefined && this.db.getBook(mergeInto)
      const existing = target && !target.formats.some((f) => f.format === format)
        ? { id: target.id, dir: this.db.getDir(target.id)!, hasCover: target.hasCover }
        : this.db.findMergeTarget({ title, authors, isbn: meta.isbn }, format)
      if (existing) {
        const dir = join(this.root, existing.dir)
        await copyFile(path, join(dir, fileName))
        if (cover && !existing.hasCover) await writeFile(join(dir, `cover.${cover.ext}`), cover.data)
        this.db.setDir(existing.id, existing.dir, existing.hasCover || !!cover)
        this.db.addFormat(existing.id, format, join(existing.dir, fileName), size, hash)
        return { path, status: 'imported', bookId: existing.id }
      }

      bookId = this.db.insertBook({ ...meta, title, authors, publishedDate: normalizeDate(meta.publishedDate) }, '')
      const relDir = join(safeSegment(authors[0]), `${safeSegment(title)} (${bookId})`)
      absDir = join(this.root, relDir)
      await mkdir(absDir, { recursive: true })

      await copyFile(path, join(absDir, fileName))
      if (cover) await writeFile(join(absDir, `cover.${cover.ext}`), cover.data)

      this.db.setDir(bookId, relDir, !!cover)
      this.db.addFormat(bookId, format, join(relDir, fileName), size, hash)
      return { path, status: 'imported', bookId }
    } catch (err) {
      if (bookId !== undefined) this.db.deleteBook(bookId)
      if (absDir) await rm(absDir, { recursive: true, force: true })
      return { path, status: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }
}
