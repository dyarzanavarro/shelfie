import { readFile } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'
import type { ExtractedMetadata } from './types'

export async function readPdf(file: string): Promise<ExtractedMetadata> {
  const doc = await PDFDocument.load(await readFile(file), { ignoreEncryption: true, updateMetadata: false })
  const author = doc.getAuthor()
  return {
    title: doc.getTitle()?.trim() || undefined,
    authors: author ? author.split(/\s*(?:;|&|\band\b)\s*/).filter(Boolean) : []
  }
}
