import { basename, extname } from 'node:path'
import type { BookFormat } from '../../shared/types'
import { readEpub } from './epub'
import { readMobi } from './mobi'
import { readPdf } from './pdf'
import type { ExtractedMetadata } from './types'

export const SUPPORTED_FORMATS: BookFormat[] = ['epub', 'pdf', 'mobi', 'azw3', 'azw']

export function formatOf(file: string): BookFormat | null {
  const ext = extname(file).slice(1).toLowerCase() as BookFormat
  return SUPPORTED_FORMATS.includes(ext) ? ext : null
}

// "Author - Title.epub" or "Title.epub"
function guessFromFilename(file: string): Pick<ExtractedMetadata, 'title' | 'authors'> {
  const name = basename(file, extname(file)).replace(/_/g, ' ').trim()
  const parts = name.split(/\s+-\s+/)
  if (parts.length >= 2) return { authors: [parts[0]], title: parts.slice(1).join(' - ') }
  return { title: name, authors: [] }
}

export async function extractMetadata(file: string, format: BookFormat): Promise<ExtractedMetadata> {
  let meta: ExtractedMetadata = {}
  try {
    if (format === 'epub') meta = readEpub(file)
    else if (format === 'pdf') meta = await readPdf(file)
    else meta = readMobi(file)
  } catch (err) {
    console.warn(`Metadata extraction failed for ${file}:`, err)
  }

  const fallback = guessFromFilename(file)
  return {
    ...meta,
    title: meta.title || fallback.title,
    authors: meta.authors?.length ? meta.authors : fallback.authors?.length ? fallback.authors : ['Unknown']
  }
}
