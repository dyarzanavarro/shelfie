import AdmZip from 'adm-zip'
import { XMLParser } from 'fast-xml-parser'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { detectImageExt, normalizeIsbn, type ExtractedMetadata } from './types'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  textNodeName: '#text',
  isArray: (name) => ['creator', 'identifier', 'meta', 'item', 'title', 'rootfile'].includes(name)
})

const text = (node: unknown): string | undefined => {
  if (node == null) return undefined
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim() || undefined
  const t = (node as Record<string, unknown>)['#text']
  return t == null ? undefined : String(t).trim() || undefined
}

const attr = (node: unknown, name: string): string | undefined =>
  node && typeof node === 'object' ? ((node as Record<string, unknown>)[`@${name}`] as string | undefined) : undefined

export function readEpub(file: string): ExtractedMetadata {
  const zip = new AdmZip(file)
  const container = parser.parse(zip.readAsText('META-INF/container.xml'))
  const opfPath: string | undefined = attr(container?.container?.rootfiles?.rootfile?.[0], 'full-path')
  if (!opfPath) throw new Error('EPUB has no OPF rootfile')

  const pkg = parser.parse(zip.readAsText(opfPath))?.package
  const metas: unknown[] = pkg?.metadata?.meta ?? []
  const coverId = attr(metas.find((m) => attr(m, 'name') === 'cover'), 'content')
  return { ...metadataFromOpf(pkg), cover: readCover(zip, opfPath, pkg, coverId) }
}

/** Reads a standalone OPF file, e.g. the metadata.opf Calibre keeps next to each book. */
export function readOpfFile(file: string): ExtractedMetadata {
  return metadataFromOpf(parser.parse(readFileSync(file, 'utf8'))?.package)
}

function metadataFromOpf(pkg: any): ExtractedMetadata {
  const md = pkg?.metadata ?? {}
  const metas: unknown[] = md.meta ?? []
  const metaNamed = (name: string) => attr(metas.find((m) => attr(m, 'name') === name), 'content')

  const isbn = (md.identifier ?? [])
    .map((id: unknown) => {
      const value = text(id)
      if (!value) return null
      const scheme = attr(id, 'scheme')?.toLowerCase()
      if (scheme === 'isbn' || /^urn:isbn:/i.test(value) || /^(97[89])?\d{9}[\dX]$/i.test(value.replace(/-/g, ''))) {
        return normalizeIsbn(value)
      }
      return null
    })
    .find(Boolean)

  const seriesIndex = Number(metaNamed('calibre:series_index'))

  return {
    title: text(md.title?.[0]),
    authors: (md.creator ?? [])
      .filter((c: unknown) => {
        const role = attr(c, 'role')
        return !role || role === 'aut'
      })
      .map(text)
      .filter(Boolean),
    description: text(md.description)?.replace(/<[^>]+>/g, '').trim(),
    publisher: text(md.publisher),
    publishedDate: text(Array.isArray(md.date) ? md.date[0] : md.date),
    language: text(Array.isArray(md.language) ? md.language[0] : md.language),
    isbn: isbn ?? null,
    series: metaNamed('calibre:series') ?? null,
    seriesIndex: Number.isFinite(seriesIndex) ? seriesIndex : null
  }
}

function readCover(zip: AdmZip, opfPath: string, pkg: any, coverId: string | undefined) {
  const items: unknown[] = pkg?.manifest?.item ?? []
  const item =
    items.find((i) => (attr(i, 'properties') ?? '').split(/\s+/).includes('cover-image')) ??
    (coverId && items.find((i) => attr(i, 'id') === coverId)) ??
    items.find((i) => /^image\//.test(attr(i, 'media-type') ?? '') && /cover/i.test(`${attr(i, 'id')} ${attr(i, 'href')}`))
  const href = attr(item, 'href')
  if (!href) return undefined

  const entryPath = posix.normalize(posix.join(posix.dirname(opfPath), decodeURIComponent(href)))
  const data = zip.getEntry(entryPath)?.getData()
  const ext = data && detectImageExt(data)
  return data && ext ? { data, ext } : undefined
}
