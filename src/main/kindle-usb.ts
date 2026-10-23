import { execFile } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActionResult, BookFormat, KindleDevice } from '../shared/types'
import type { Library } from './library'

// Formats a Kindle reads when copied over USB, best first. Kindles can't open EPUB from USB.
const USB_FORMATS: BookFormat[] = ['azw3', 'mobi', 'azw', 'pdf']

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
const safeName = (s: string) =>
  s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '') || 'Unknown'

function candidateRoots(): string[] {
  if (process.platform === 'win32') return [...'DEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => `${l}:\\`)
  if (process.platform === 'darwin') return ['/Volumes/Kindle']
  return []
}

async function readKindle(root: string): Promise<KindleDevice | null> {
  // A mounted Kindle has system/version.txt ("Kindle 5.12.2.1.1 ...") next to its documents folder.
  const version = await readFile(join(root, 'system', 'version.txt'), 'utf8').catch(() => null)
  if (!version?.startsWith('Kindle') || !(await stat(join(root, 'documents')).catch(() => null))?.isDirectory()) return null
  const fs = await statfs(root)
  return {
    root,
    firmware: version.split('(')[0].replace('Kindle', '').trim(),
    freeBytes: fs.bavail * fs.bsize,
    totalBytes: fs.blocks * fs.bsize
  }
}

export async function findKindles(): Promise<KindleDevice[]> {
  const found = await Promise.all(candidateRoots().map((root) => readKindle(root).catch(() => null)))
  return found.filter((d): d is KindleDevice => !!d)
}

/** documents/<Author>/<Title> - <Author>.<ext>, the layout already on most sideloaded Kindles. */
function devicePath(root: string, title: string, author: string, format: BookFormat): string {
  return join(root, 'documents', safeName(author), `${safeName(title)} - ${safeName(author)}.${format}`)
}

export async function copyToKindle(library: Library, bookId: number, root: string): Promise<ActionResult> {
  const device = await readKindle(root).catch(() => null)
  if (!device) return { ok: false, message: 'Kindle not found. Is it still plugged in?' }

  const book = library.db.getBook(bookId)
  if (!book) return { ok: false, message: 'Book not found' }
  const file = USB_FORMATS.map((fmt) => book.formats.find((f) => f.format === fmt)).find(Boolean)
  if (!file) {
    return {
      ok: false,
      message: 'Kindles can’t open EPUB over USB, and this book has no MOBI, AZW3 or PDF. Use Send to Kindle instead.'
    }
  }

  const author = book.authors[0] ?? 'Unknown'
  const target = devicePath(root, book.title, author, file.format)
  const existing = await stat(target).catch(() => null)
  if (existing?.size === file.size) return { ok: true, message: `“${book.title}” is already on your Kindle` }
  if (file.size > device.freeBytes + (existing?.size ?? 0)) {
    return { ok: false, message: `Not enough space on the Kindle (${Math.round(device.freeBytes / 1e6)} MB free)` }
  }

  // Copy under a temporary name first so an unplugged cable never leaves a half-written book behind.
  const partial = `${target}.part`
  try {
    await mkdir(join(root, 'documents', safeName(author)), { recursive: true })
    await copyFile(library.absPath(file.path), partial)
    await rm(target, { force: true })
    await rename(partial, target)
    return { ok: true, message: `Copied “${book.title}” (${file.format.toUpperCase()}) to your Kindle` }
  } catch (err) {
    await rm(partial, { force: true }).catch(() => undefined)
    return { ok: false, message: `Copy failed: ${errorMessage(err)}` }
  }
}

/**
 * Library book ids already on the Kindle, matched by "<Title> - <Author>.<ext>" file names in documents/
 * and its author folders. That's the name this app uses, and the one Calibre used for older sideloads.
 */
export async function booksOnKindle(library: Library, root: string): Promise<number[]> {
  const present = new Set<string>()
  const docs = join(root, 'documents')
  for (const entry of await readdir(docs, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile()) present.add(entry.name.toLowerCase())
    else if (entry.isDirectory() && !entry.name.endsWith('.sdr')) {
      for (const name of await readdir(join(docs, entry.name)).catch(() => [])) present.add(name.toLowerCase())
    }
  }
  return library.db
    .listBooks({})
    .filter((book) => {
      const base = `${safeName(book.title)} - ${safeName(book.authors[0] ?? 'Unknown')}`.toLowerCase()
      return USB_FORMATS.some((fmt) => present.has(`${base}.${fmt}`))
    })
    .map((b) => b.id)
}

export function ejectKindle(root: string): Promise<ActionResult> {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, message: 'Eject the Kindle from your system tray' })
  const drive = root.slice(0, 2)
  if (!/^[A-Z]:$/.test(drive)) return Promise.resolve({ ok: false, message: 'Unexpected drive' })
  // Same as Explorer's "Eject". The verb fails silently if a file is still open, so check the drive is gone.
  const script = `(New-Object -ComObject Shell.Application).Namespace(17).ParseName('${drive}').InvokeVerb('Eject'); Start-Sleep -Milliseconds 1500`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20_000 }, async (err) => {
      if (err) return resolve({ ok: false, message: `Couldn’t eject: ${errorMessage(err)}` })
      const stillThere = await readKindle(root).catch(() => null)
      resolve(
        stillThere
          ? { ok: false, message: 'Windows didn’t eject the Kindle. Close anything using it and try again.' }
          : { ok: true, message: 'Kindle ejected. You can unplug it now.' }
      )
    })
  })
}
