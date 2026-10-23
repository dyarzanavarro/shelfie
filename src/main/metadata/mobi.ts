import { MobiFile } from '../mobi/mobi-file'
import { detectImageExt, normalizeIsbn, type ExtractedMetadata } from './types'

export function readMobi(file: string): ExtractedMetadata {
  const mobi = new MobiFile(file)

  let cover: ExtractedMetadata['cover']
  const coverIndex = mobi.coverIndex()
  const data = coverIndex !== undefined ? mobi.resource(coverIndex) : undefined
  const ext = data && detectImageExt(data)
  if (data && ext) cover = { data: Buffer.from(data), ext }

  const isbnRaw = mobi.exthString(104)
  return {
    title: mobi.exthString(503) ?? (mobi.header.fullName.trim() || undefined),
    authors: mobi.exthStrings(100),
    publisher: mobi.exthString(101),
    description: mobi.exthString(103)?.replace(/<[^>]+>/g, '').trim(),
    isbn: isbnRaw ? normalizeIsbn(isbnRaw) : null,
    publishedDate: mobi.exthString(106),
    language: mobi.exthString(524),
    cover
  }
}
