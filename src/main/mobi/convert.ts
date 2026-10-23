import { detectImageExt } from '../metadata/types'
import type { EpubChapter, EpubContent, EpubResource, TocEntry } from '../epub/types'
import { MobiFile, type Index } from './mobi-file'
import { aidToId, parseHtml, plainText, type SerializeOptions } from './xhtml'

const MEDIA_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  css: 'text/css'
}

const partHref = (i: number) => `part${String(i).padStart(4, '0')}.xhtml`

function detectResource(data: Buffer): { ext: string; folder: string } | null {
  const img = detectImageExt(data)
  if (img) return { ext: img, folder: 'images' }
  const magic = data.toString('latin1', 0, 4)
  if (magic === 'OTTO') return { ext: 'otf', folder: 'fonts' }
  if (magic === 'true' || data.readUInt32BE(0) === 0x00010000) return { ext: 'ttf', folder: 'fonts' }
  if (magic === 'wOFF') return { ext: 'woff', folder: 'fonts' }
  return null
}

/** Loads resource records on demand and remembers which ones the book references. */
class Resources {
  private byIndex = new Map<number, EpubResource | null>()
  readonly extra: EpubResource[] = []

  constructor(private mobi: MobiFile) {}

  /** 0-based index from the first resource record; returns href relative to the OEBPS root. */
  href(index: number): string | undefined {
    if (!this.byIndex.has(index)) {
      const data = this.mobi.resource(index)
      const kind = data && data.length > 4 ? detectResource(data) : null
      this.byIndex.set(
        index,
        kind && data
          ? { href: `${kind.folder}/res${String(index).padStart(5, '0')}.${kind.ext}`, mediaType: MEDIA_TYPES[kind.ext], data }
          : null
      )
    }
    return this.byIndex.get(index)?.href
  }

  all(): EpubResource[] {
    return [...[...this.byIndex.values()].filter((r): r is EpubResource => !!r), ...this.extra]
  }
}

function buildToc(index: Index | undefined, resolve: (tags: Map<number, number[]>) => string | undefined): TocEntry[] {
  if (!index) return []
  const root: TocEntry[] = []
  const stack: Array<{ depth: number; children: TocEntry[] }> = [{ depth: -1, children: root }]
  for (const { tags } of index.entries) {
    const labelOffset = tags.get(3)?.[0]
    const label = labelOffset !== undefined ? index.cncx.get(labelOffset)?.trim() : undefined
    const href = resolve(tags)
    if (!label || !href) continue
    const depth = tags.get(4)?.[0] ?? 0
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop()
    const entry: TocEntry = { label, href, children: [] }
    stack[stack.length - 1].children.push(entry)
    stack.push({ depth, children: entry.children })
  }
  return root
}

function fallbackToc(chapters: EpubChapter[]): TocEntry[] {
  return chapters.map((c, i) => {
    const heading = c.body.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1]
    const label = (heading && plainText(heading)) || c.title || `Section ${i + 1}`
    return { label: label.slice(0, 120), href: c.href, children: [] }
  })
}

function hasContent(body: string): boolean {
  return /<(img|svg|image)\b/i.test(body) || plainText(body).length > 0
}

function coverHref(mobi: MobiFile, resources: Resources): string | undefined {
  const idx = mobi.coverIndex()
  return idx !== undefined ? resources.href(idx) : undefined
}

// ---------- Legacy MOBI (version 6) ----------

// Kindle's defaults for legacy MOBI: paragraphs have no vertical margin; spacing comes from markup.
const MOBI_BASE_CSS = `p { margin: 0; }
img { max-width: 100%; height: auto; }
table { max-width: 100%; }
div.pagebreak { page-break-before: always; break-before: page; height: 0; }
`
const PAGEBREAK = '<div class="pagebreak"></div>'
const MAX_FILE_CHARS = 250_000

/** Last resort for books without page breaks: cut oversized files after a closing </p>. */
function splitAtParagraphs(chunk: string): string[] {
  if (chunk.length <= MAX_FILE_CHARS * 1.5) return [chunk]
  const parts: string[] = []
  let start = 0
  while (chunk.length - start > MAX_FILE_CHARS * 1.5) {
    const close = chunk.slice(start + MAX_FILE_CHARS).match(/<\/p\s*>/i)
    if (!close) break
    const cut = start + MAX_FILE_CHARS + close.index! + close[0].length
    parts.push(chunk.slice(start, cut))
    start = cut
  }
  parts.push(chunk.slice(start))
  return parts
}

const FONT_SIZES =['x-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xx-large']
const BLOCKS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li', 'dd', 'dt'])
const cssLength = (v: string) => (/^-?\d+(\.\d+)?$/.test(v.trim()) ? `${v.trim()}px` : v.trim())

/** Mobipocket presentational markup → CSS. */
const legacyMarkup: NonNullable<SerializeOptions['element']> = (el) => {
  const get = (n: string) => el.attrs.find((a) => a.name === n)?.value
  const styles: string[] = []
  const drop: string[] = []

  if (el.tagName === 'font') {
    const size = get('size')
    if (size) {
      const n = /^[+-]/.test(size) ? 3 + Number(size) : Number(size)
      styles.push(`font-size: ${FONT_SIZES[Math.min(7, Math.max(1, n || 3))]}`)
    }
    if (get('color')) styles.push(`color: ${get('color')}`)
    if (get('face')) styles.push(`font-family: ${get('face')}`)
    return { tag: 'span', style: styles.join('; '), drop: ['size', 'color', 'face'] }
  }
  if (el.tagName === 'center') return { tag: 'div', style: 'text-align: center' }
  if (el.tagName === 'big') return { tag: 'span', style: 'font-size: larger' }
  if (el.tagName === 'strike') return { tag: 's' }
  if (el.tagName === 'tt') return { tag: 'code' }

  if (BLOCKS.has(el.tagName)) {
    const height = get('height')
    const width = get('width')
    const align = get('align')
    if (height && parseFloat(height) !== 0) styles.push(`margin-top: ${cssLength(height)}`)
    if (width && parseFloat(width) !== 0) styles.push(`text-indent: ${cssLength(width)}`)
    if (align) styles.push(`text-align: ${align.toLowerCase()}`)
    drop.push('height', 'width', 'align')
  } else if (el.tagName === 'img') {
    drop.push('align', 'hspace', 'vspace', 'border')
  }
  return { style: styles.join('; '), drop }
}

function convertMobi6(mobi: MobiFile): EpubContent {
  const enc = mobi.header.encoding
  let raw = mobi.text().toString('latin1') // latin1 keeps a 1:1 mapping between chars and bytes
  const resources = new Resources(mobi)
  const ncx = mobi.readIndex(mobi.header.ncxIndex)

  const targets = new Set<number>()
  for (const m of raw.matchAll(/filepos\s*=\s*['"]?0*(\d+)/gi)) targets.add(Number(m[1]))
  for (const { tags } of ncx?.entries ?? []) {
    const pos = tags.get(1)?.[0]
    if (pos !== undefined) targets.add(pos)
  }

  // Insert anchors from the end so earlier byte offsets stay valid.
  for (const pos of [...targets].filter((p) => p < raw.length).sort((a, b) => b - a)) {
    let at = pos
    if (raw.lastIndexOf('<', at - 1) > raw.lastIndexOf('>', at - 1)) at = raw.indexOf('>', at) + 1 || raw.length
    raw = `${raw.slice(0, at)}<a id="filepos${pos}"></a>${raw.slice(at)}`
  }

  raw = raw
    .replace(/filepos\s*=\s*(['"]?)0*(\d+)\1/gi, 'href="#filepos$2"')
    .replace(/\brecindex\s*=\s*(['"]?)0*(\d+)\1/gi, 'data-recindex="$2"')

  // Start a new file only where a TOC entry begins (or a file gets too big); other page breaks become CSS.
  const tocAnchors = new Set(
    (ncx?.entries ?? []).map(({ tags }) => `filepos${tags.get(1)?.[0]}`).filter((id) => id !== 'fileposundefined')
  )
  const splitEverywhere = tocAnchors.size < 2
  const chunks: string[] = []
  let current = ''
  raw.split(/<mbp:pagebreak[^>]*>/i).forEach((piece, i) => {
    const startsChapter = [...piece.matchAll(/id="(filepos\d+)"/g)].some((m) => tocAnchors.has(m[1]))
    if (i > 0 && (splitEverywhere || startsChapter || current.length > MAX_FILE_CHARS)) {
      chunks.push(current)
      current = piece
    } else {
      current += i > 0 ? PAGEBREAK + piece : piece
    }
  })
  chunks.push(current)
  const sized = chunks.flatMap(splitAtParagraphs)

  const chapters: EpubChapter[] = []
  const anchorFile = new Map<string, string>()
  let pending = ''

  sized.forEach((chunk, i) => {
    const html = Buffer.from(pending + chunk, 'latin1').toString(enc)
    const parsed = parseHtml(html, {
      element: legacyMarkup,
      attr: (el, name, value) => {
        if (name === 'data-recindex') {
          const href = resources.href(Number(value) - 1)
          return href ? ['src', `../${href}`] : null
        }
        if (el.tagName === 'img' && (name === 'hirecindex' || name === 'lorecindex')) return null
        return value
      }
    })
    if (!hasContent(parsed.body) && i < sized.length - 1) {
      pending += chunk
      return
    }
    pending = ''
    const file = partHref(chapters.length + 1)
    for (const m of parsed.body.matchAll(/id="(filepos\d+)"/g)) anchorFile.set(m[1], file)
    chapters.push({ href: `text/${file}`, title: parsed.title, body: parsed.body, stylesheets: [], inlineCss: parsed.styles })
  })

  resources.extra.push({ href: 'styles/mobi.css', mediaType: 'text/css', data: Buffer.from(MOBI_BASE_CSS) })
  for (const ch of chapters) {
    ch.stylesheets.push('styles/mobi.css')
    ch.body = ch.body.replace(/href="#(filepos\d+)"/g, (m, id) => {
      const file = anchorFile.get(id)
      return file ? `href="${file}#${id}"` : m
    })
  }

  let toc = buildToc(ncx, (tags) => {
    const pos = tags.get(1)?.[0]
    const file = pos !== undefined ? anchorFile.get(`filepos${pos}`) : undefined
    return file ? `text/${file}#filepos${pos}` : undefined
  })
  if (!toc.length) toc = fallbackToc(chapters)

  const cover = coverHref(mobi, resources)
  return { chapters, resources: resources.all(), toc, coverHref: cover, language: mobi.exthString(524) }
}

// ---------- KF8 / AZW3 (version 8) ----------

interface Fragment {
  insertPos: number
  file: number
  length: number
}

interface Part {
  start: number
  html: string // latin1
}

function convertKf8(mobi: MobiFile): EpubContent {
  const enc = mobi.header.encoding
  const flows = mobi.flows(mobi.text())
  const text = flows[0]
  const skel = mobi.readIndex(mobi.header.skeletonIndex)
  const frag = mobi.readIndex(mobi.header.fragmentIndex)
  if (!skel || !frag) throw new Error('KF8 book is missing its skeleton/fragment index')

  const fragments: Fragment[] = frag.entries.map(({ text: t, tags }) => ({
    insertPos: Number(t.toString('latin1')),
    file: tags.get(3)?.[0] ?? 0,
    length: tags.get(6)?.[1] ?? 0
  }))

  // Each skeleton is an HTML file with holes; its fragments follow it contiguously in the text.
  const parts: Part[] = []
  let fragPtr = 0
  for (const { tags } of skel.entries) {
    const [start, length] = tags.get(6) ?? [0, 0]
    const fragCount = tags.get(1)?.[0] ?? 0
    let base = start + length
    let html = text.subarray(start, base)
    for (let i = 0; i < fragCount && fragPtr < fragments.length; i++) {
      const f = fragments[fragPtr++]
      const slice = text.subarray(base, base + f.length)
      const at = f.insertPos - start
      html = Buffer.concat([html.subarray(0, at), slice, html.subarray(at)])
      base += f.length
    }
    parts.push({ start, html: html.toString('latin1') })
  }

  const fileForPos = (pos: number) =>
    parts.findIndex((p, i) => pos >= p.start && (i === parts.length - 1 || pos < parts[i + 1].start))

  // Find the element at or before the target position that carries an id (or aid).
  const resolvePos = (fid: number, off: number): string | undefined => {
    const f = fragments[fid]
    if (!f) return undefined
    const pos = f.insertPos + off
    let pn = fileForPos(pos)
    if (pn < 0) pn = fileForPos(f.insertPos)
    if (pn < 0) return undefined
    const html = parts[pn].html
    let npos = pos - parts[pn].start
    const gt = html.indexOf('>', npos)
    const lt = html.indexOf('<', npos)
    if (lt === npos || (gt !== -1 && (lt === -1 || gt < lt))) npos = gt + 1
    const tagsBefore = [...html.slice(0, npos).matchAll(/<[^>]*\s(?:id|aid)\s*=\s*['"][^'"]*['"][^>]*>/gi)]
    const tag = tagsBefore[tagsBefore.length - 1]?.[0]
    const id = tag?.match(/\sid\s*=\s*['"]([^'"]*)['"]/i)?.[1]
    const aid = tag?.match(/\said\s*=\s*['"]([^'"]*)['"]/i)?.[1]
    const anchor = id ?? (aid ? `aid-${aid}` : undefined)
    return partHref(pn + 1) + (anchor ? `#${anchor}` : '')
  }

  const resources = new Resources(mobi)
  const flowHrefs = new Map<number, string>()

  const embedRef = (code: string, prefix: string) => {
    const href = resources.href(parseInt(code, 32) - 1)
    return href ? `${prefix}${href}` : ''
  }

  const flowRef = (code: string, mime: string) => {
    const n = parseInt(code, 32)
    if (!flowHrefs.has(n) && flows[n]) {
      const ext = /svg/.test(mime) ? 'svg' : 'css'
      const href = `${ext === 'css' ? 'styles' : 'images'}/flow${String(n).padStart(3, '0')}.${ext}`
      let content = flows[n].toString('latin1').replace(/kindle:embed:(\w{4})(\?mime=[\w/+.-]*)?/g, (_, c) => embedRef(c, '../'))
      if (ext === 'svg') content = content.replace(/^[\s\S]*?(<svg)/i, '$1')
      resources.extra.push({ href, mediaType: MEDIA_TYPES[ext], data: Buffer.from(content, 'latin1') })
      flowHrefs.set(n, href)
    }
    return flowHrefs.get(n) ? `../${flowHrefs.get(n)}` : ''
  }

  const chapters: EpubChapter[] = parts.map((part, i) => {
    const latin = part.html
      .replace(/kindle:pos:fid:(\w{4}):off:(\w{10})/g, (_, fid, off) => resolvePos(parseInt(fid, 32), parseInt(off, 32)) ?? '#')
      .replace(/kindle:embed:(\w{4})(\?mime=[\w/+.-]*)?/g, (_, c) => embedRef(c, '../'))
      .replace(/kindle:flow:(\w{4})\?mime=([\w/+.-]*)/g, (_, c, mime) => flowRef(c, mime))
    const parsed = parseHtml(Buffer.from(latin, 'latin1').toString(enc), { attr: aidToId })
    return {
      href: `text/${partHref(i + 1)}`,
      title: parsed.title,
      bodyAttrs: parsed.bodyAttrs,
      body: parsed.body,
      stylesheets: parsed.stylesheetHrefs.filter((h) => h.startsWith('../styles/')).map((h) => h.slice(3)),
      inlineCss: parsed.styles.map((css) => css.replace(/kindle:embed:(\w{4})(\?mime=[\w/+.-]*)?/g, (_, c) => embedRef(c, '../')))
    }
  })

  let toc = buildToc(mobi.readIndex(mobi.header.ncxIndex), (tags) => {
    const [fid, off] = tags.get(6) ?? []
    const href = fid !== undefined ? resolvePos(fid, off ?? 0) : undefined
    return href ? `text/${href}` : undefined
  })
  if (!toc.length) toc = fallbackToc(chapters)

  const cover = coverHref(mobi, resources)
  return { chapters, resources: resources.all(), toc, coverHref: cover, language: mobi.exthString(524) }
}

export function mobiToEpubContent(file: string | Buffer): EpubContent {
  const mobi = new MobiFile(file)
  return mobi.isKF8 ? convertKf8(mobi) : convertMobi6(mobi)
}
