import type { NewBook } from '../db'

export interface ExtractedCover {
  data: Buffer
  ext: 'jpg' | 'png' | 'gif' | 'webp'
}

export interface ExtractedMetadata extends Partial<NewBook> {
  cover?: ExtractedCover
}

export function detectImageExt(data: Buffer): ExtractedCover['ext'] | null {
  if (data[0] === 0xff && data[1] === 0xd8) return 'jpg'
  if (data[0] === 0x89 && data.toString('ascii', 1, 4) === 'PNG') return 'png'
  if (data.toString('ascii', 0, 3) === 'GIF') return 'gif'
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return null
}

export function normalizeIsbn(raw: string): string | null {
  const digits = raw.replace(/^urn:isbn:/i, '').replace(/[^0-9Xx]/g, '').toUpperCase()
  return digits.length === 10 || digits.length === 13 ? digits : null
}
