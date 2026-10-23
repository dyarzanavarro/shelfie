import { randomBytes, randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { isExternal, resolveHref, type EpubBook } from '../epub/read'
import type { EpubMetadata, TocEntry } from '../epub/types'
import { detectImageExt } from '../metadata/types'
import {
  base32,
  buildIndex,
  Cncx,
  EOF_RECORD,
  fcisRecord,
  flisRecord,
  NULL,
  palmDb,
  textRecords,
  TEXT_RECORD_SIZE,
  u32,
  type IndexEntry
} from './records'

// Builds a standalone KF8 (AZW3) book, the format Kindles read when books are copied over USB.
//
// KF8 stores each XHTML file as a "skeleton" (the file with its content cut out) followed by
// "fragments" that get inserted back at recorded positions. Links point at (fragment, offset)
// pairs, and images, fonts and stylesheets live in separate records referenced by number.

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const DROP = new Set(['script', 'noscript', 'iframe', 'object', 'form', 'video', 'audio', 'canvas', 'template', 'embed'])
const XML_NAME = /^[A-Za-z_][\w.-]*$/
/** Fragments are kept around this size, like Amazon's own tools. */
const FRAGMENT_LIMIT = 8192
/** Fixed-length so links can be patched in place once every fragment's position is known. */
const POS_PLACEHOLDER = 'kindle:pos:fid:0000:off:0000000000'

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;')
const isElement = (n: Node): n is Element => 'tagName' in n
const childNodes = (n: Node): Node[] => ('childNodes' in n ? n.childNodes : [])
const attrName = (a: { name: string; prefix?: string }) => (a.prefix ? `${a.prefix}:${a.name}` : a.name)
const getAttr = (el: Element, name: string) => el.attrs.find((a) => attrName(a) === name)?.value

function textOf(n: Node): string {
  if (n.nodeName === '#text') return (n as DefaultTreeAdapterMap['textNode']).value
  return childNodes(n).map(textOf).join('')
}

function find(n: Node, tag: string): Element | undefined {
  if (isElement(n) && n.tagName === tag) return n
  for (const c of childNodes(n)) {
    const hit = find(c, tag)
    if (hit) return hit
  }
  return undefined
}

/** XHTML's <div/> means an empty div, but an HTML parser would treat it as an unclosed tag. */
function expandSelfClosing(html: string): string {
  return html.replace(/<([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*\/>/g, (m, tag, attrs) =>
    VOID.has(tag.toLowerCase()) ? m : `<${tag}${attrs}></${tag}>`
  )
}

// ---------- Resources (images, fonts) and flows (CSS, SVG) ----------

const IMAGE_MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif' } as const

function fontKind(data: Buffer): 'ttf' | 'otf' | null {
  const magic = data.toString('latin1', 0, 4)
  if (magic === 'OTTO') return 'otf'
  if (magic === 'true' || data.readUInt32BE(0) === 0x00010000) return 'ttf'
  return null
}

/** KF8 font record: 24-byte header, then the zlib-compressed font. */
function fontRecord(data: Buffer): Buffer {
  const header = Buffer.alloc(24)
  header.write('FONT', 0, 'latin1')
  header.writeUInt32BE(data.length, 4)
  header.writeUInt32BE(1, 8) // zlib
  header.writeUInt32BE(24, 12)
  return Buffer.concat([header, deflateSync(data)])
}

class Resources {
  /** Image and font records, in order; kindle:embed numbers are 1-based indexes into this. */
  readonly records: Buffer[] = []
  /** Flow 0 is the book's HTML; CSS and SVG files become flows 1, 2, … */
  readonly flows: Buffer[] = [Buffer.alloc(0)]
  private embeds = new Map<string, string | null>()
  private flowRefs = new Map<string, string>()
  private cssInProgress = new Set<string>()

  constructor(private book: EpubBook) {}

  /** kindle:embed reference for an image or font, or undefined if it's missing/unsupported. */
  embed(path: string): string | undefined {
    if (!this.embeds.has(path)) {
      const data = this.book.files.get(path)?.data
      let ref: string | null = null
      if (data && data.length > 4) {
        const image = detectImageExt(data)
        const font = fontKind(data)
        if (image && image !== 'webp') {
          this.records.push(data)
          ref = `kindle:embed:${base32(this.records.length, 4)}?mime=${IMAGE_MIME[image]}`
        } else if (font) {
          this.records.push(fontRecord(data))
          ref = `kindle:embed:${base32(this.records.length, 4)}?mime=${font === 'otf' ? 'application/vnd.ms-opentype' : 'application/x-font-truetype'}`
        }
      }
      this.embeds.set(path, ref)
    }
    return this.embeds.get(path) ?? undefined
  }

  /** 0-based resource index of an image (registering it if needed), for the cover. */
  index(path: string): number | undefined {
    const ref = this.embed(path)
    return ref ? parseInt(ref.slice(13, 17), 32) - 1 : undefined
  }

  /** Reference for <img src>: images embed directly, SVG files become flows. */
  imageSrc(path: string): string | undefined {
    const file = this.book.files.get(path)
    if (file && (/svg/.test(file.mediaType) || path.endsWith('.svg'))) {
      return this.flow(path, 'image/svg+xml', () => this.svg(file.data.toString('utf8'), path))
    }
    return this.embed(path)
  }

  stylesheet(path: string): string | undefined {
    const file = this.book.files.get(path)
    if (!file) return undefined
    return this.flow(path, 'text/css', () => this.css(file.data.toString('utf8'), path))
  }

  /** Rewrites url(...) to embedded resources and inlines @import. */
  css(css: string, base: string): string {
    this.cssInProgress.add(base)
    const out = css
      .replace(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/gi, (m, href) => {
        if (isExternal(href)) return m
        const path = resolveHref(base, href).split('#')[0]
        const file = this.book.files.get(path)
        return file && !this.cssInProgress.has(path) ? this.css(file.data.toString('utf8'), path) : ''
      })
      .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, _q, href) => {
        if (isExternal(href) || href.startsWith('#')) return m
        const ref = this.embed(resolveHref(base, href.trim()).split('#')[0])
        return ref ? `url(${ref})` : m
      })
    this.cssInProgress.delete(base)
    return out
  }

  private svg(svg: string, base: string): string {
    return svg.replace(/((?:xlink:)?href)\s*=\s*(["'])([^"']+)\2/g, (m, name, q, href) => {
      if (isExternal(href) || href.startsWith('#')) return m
      const ref = this.embed(resolveHref(base, href).split('#')[0])
      return ref ? `${name}=${q}${ref}${q}` : m
    })
  }

  private flow(path: string, mime: string, content: () => string): string {
    let ref = this.flowRefs.get(path)
    if (!ref) {
      this.flows.push(Buffer.from(content(), 'utf8'))
      ref = `kindle:flow:${base32(this.flows.length - 1, 4)}?mime=${mime}`
      this.flowRefs.set(path, ref)
    }
    return ref
  }
}

// ---------- Serializing XHTML with byte positions ----------

/** Output buffer that tracks byte positions, element ids and link placeholders. */
class Out {
  parts: string[] = []
  pos = 0
  ids: Array<[id: string, pos: number]> = []
  links: Array<[pos: number, target: string]> = []

  write(s: string): void {
    this.parts.push(s)
    this.pos += Buffer.byteLength(s, 'utf8')
  }

  append(other: Out): void {
    for (const [id, p] of other.ids) this.ids.push([id, p + this.pos])
    for (const [p, t] of other.links) this.links.push([p + this.pos, t])
    this.parts.push(...other.parts)
    this.pos += other.pos
  }
}

interface FileContext {
  path: string
  spinePaths: Set<string>
  aids: Map<Element, string>
  resources: Resources
}

/**
 * Writes an element's start tag. Returns the matching end tag, '' when the element is unwrapped
 * (only its children are kept), 'void' for self-closing elements, or null to drop it entirely.
 */
function writeStartTag(el: Element, out: Out, ctx: FileContext, inSvg: boolean): string | 'void' | null {
  const tag = el.tagName
  if (DROP.has(tag)) return null
  if (tag.includes(':') || !XML_NAME.test(tag)) return ''

  let src: string | undefined
  if (tag === 'img') {
    const raw = getAttr(el, 'src')
    src = raw && !isExternal(raw) ? ctx.resources.imageSrc(resolveHref(ctx.path, raw).split('#')[0]) : undefined
    if (!src) return null
  }

  const id = getAttr(el, 'id')
  if (id && !inSvg) out.ids.push([id, out.pos])

  out.write(`<${tag}`)
  if (tag === 'svg' && !inSvg) out.write(' xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"')
  for (const a of el.attrs) {
    const name = attrName(a)
    if (a.prefix === 'xmlns' || name === 'xmlns' || name === 'aid' || name === 'epub:type' || /^on/i.test(name)) continue
    if (!(XML_NAME.test(name) || name === 'xml:lang' || (inSvg && a.prefix === 'xlink'))) continue

    if (tag === 'img' && name === 'src') {
      out.write(` src="${escAttr(src!)}"`)
    } else if ((tag === 'a' || tag === 'area') && name === 'href' && !isExternal(a.value)) {
      const target = resolveHref(ctx.path, a.value)
      if (!ctx.spinePaths.has(target.split('#')[0])) continue
      out.write(' href="')
      out.links.push([out.pos, target])
      out.write(`${POS_PLACEHOLDER}"`)
    } else if (inSvg && (tag === 'image' || tag === 'use') && (name === 'xlink:href' || name === 'href') && !isExternal(a.value) && !a.value.startsWith('#')) {
      const ref = ctx.resources.embed(resolveHref(ctx.path, a.value).split('#')[0])
      if (ref) out.write(` ${name}="${escAttr(ref)}"`)
    } else {
      out.write(` ${name}="${escAttr(a.value)}"`)
    }
  }
  const aid = ctx.aids.get(el)
  if (aid) out.write(` aid="${aid}"`)

  if ((VOID.has(tag) && !inSvg) || (inSvg && !el.childNodes.length)) {
    out.write('/>')
    return 'void'
  }
  out.write('>')
  return `</${tag}>`
}

function writeNode(node: Node, out: Out, ctx: FileContext, inSvg: boolean): void {
  if (node.nodeName === '#text') return out.write(escText((node as DefaultTreeAdapterMap['textNode']).value))
  if (!isElement(node)) return
  const end = writeStartTag(node, out, ctx, inSvg)
  if (end === null || end === 'void') return
  const childSvg = inSvg || node.tagName === 'svg'
  for (const c of node.tagName === 'template' ? [] : node.childNodes) writeNode(c, out, ctx, childSvg)
  out.write(end)
}

/** Elements written as a real start/end tag pair with an aid, so fragments can be inserted into them. */
function canHoldFragments(el: Element, ctx: FileContext): boolean {
  const tag = el.tagName
  return (
    ctx.aids.has(el) && el.childNodes.length > 0 && tag !== 'svg' && tag !== 'img' && tag !== 'template' &&
    !DROP.has(tag) && !VOID.has(tag) && !tag.includes(':') && XML_NAME.test(tag)
  )
}

interface Fragment {
  start: number
  end: number
  /** aid of the element the fragment is inserted into. */
  aid: string
}

/**
 * Writes a container's children, grouping them into fragments of about FRAGMENT_LIMIT bytes.
 * A child too big for one fragment stays in the skeleton and its own children are fragmented.
 */
function writeFragmented(container: Element, out: Out, ctx: FileContext, fragments: Fragment[]): void {
  const aid = ctx.aids.get(container)!
  let group: { start: number; size: number } | null = null
  const close = () => {
    if (group && out.pos > group.start) fragments.push({ start: group.start, end: out.pos, aid })
    group = null
  }

  for (const child of container.childNodes) {
    const piece = new Out()
    writeNode(child, piece, ctx, false)
    if (!piece.pos) continue

    if (piece.pos > FRAGMENT_LIMIT && isElement(child) && canHoldFragments(child, ctx)) {
      close()
      const end = writeStartTag(child, out, ctx, false) as string
      writeFragmented(child, out, ctx, fragments)
      out.write(end)
      continue
    }
    if (group && group.size + piece.pos > FRAGMENT_LIMIT) close()
    if (!group) group = { start: out.pos, size: 0 }
    out.append(piece)
    group.size += piece.pos
  }
  close()
}

interface LaidOutFile {
  path: string
  doc: Buffer
  fragments: Fragment[]
  ids: Map<string, number>
  links: Array<[pos: number, target: string]>
  /** Absolute position of this file in the HTML flow. */
  start: number
  /** Global sequence number of this file's first fragment. */
  firstFragment: number
}

function layoutFile(path: string, html: string, ctx: Omit<FileContext, 'path' | 'aids'>, nextAid: () => string): LaidOutFile {
  const doc = parse(expandSelfClosing(html))
  const htmlEl = find(doc, 'html')
  const head = find(doc, 'head')
  const body = find(doc, 'body')!
  const fctx: FileContext = { ...ctx, path, aids: new Map() }

  // Every element outside SVG gets an aid, as in Amazon's files; fragments are inserted by aid.
  const assign = (n: Node) => {
    if (!isElement(n) || n.tagName === 'svg') return
    fctx.aids.set(n, nextAid())
    n.childNodes.forEach(assign)
  }
  assign(body)

  const out = new Out()
  const lang = ['lang', 'xml:lang', 'dir']
    .map((name) => [name, htmlEl && getAttr(htmlEl, name)] as const)
    .filter(([, v]) => v)
    .map(([n, v]) => ` ${n}="${escAttr(v!)}"`)
    .join('')
  out.write(`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"${lang}><head>`)
  const title = head && find(head, 'title')
  out.write(`<title>${escText(title ? textOf(title).trim() : '')}</title>`)
  for (const el of head ? head.childNodes.filter(isElement) : []) {
    if (el.tagName === 'link' && /stylesheet/i.test(getAttr(el, 'rel') ?? '')) {
      const href = getAttr(el, 'href')
      const ref = href && !isExternal(href) ? ctx.resources.stylesheet(resolveHref(path, href).split('#')[0]) : undefined
      if (ref) out.write(`<link href="${ref}" rel="stylesheet" type="text/css"/>`)
    } else if (el.tagName === 'style') {
      out.write(`<style type="text/css">${ctx.resources.css(textOf(el), path)}</style>`)
    }
  }
  out.write('<meta http-equiv="Content-Type" content="text/html; charset=utf-8"/></head>')

  writeStartTag(body, out, fctx, false)
  const fragments: Fragment[] = []
  writeFragmented(body, out, fctx, fragments)
  if (!fragments.length) {
    const start = out.pos
    out.write('<div></div>')
    fragments.push({ start, end: out.pos, aid: fctx.aids.get(body)! })
  }
  out.write('</body></html>')

  const ids = new Map<string, number>()
  for (const [id, pos] of out.ids) if (!ids.has(id)) ids.set(id, pos)
  return { path, doc: Buffer.from(out.parts.join(''), 'utf8'), fragments, ids, links: out.links, start: 0, firstFragment: 0 }
}

// ---------- Book assembly ----------

interface Target {
  /** Absolute position in the HTML flow. */
  pos: number
  fid: number
  off: number
}

function resolver(files: LaidOutFile[]) {
  const byPath = new Map(files.map((f) => [f.path, f]))
  return (href: string): Target | undefined => {
    const [path, frag] = href.split('#', 2)
    const file = byPath.get(path)
    if (!file) return undefined
    const local = (frag !== undefined ? file.ids.get(frag) : undefined) ?? file.fragments[0].start
    // The fragment containing the position, else the next one (targets can sit in the skeleton).
    let index = file.fragments.findIndex((f) => local >= f.start && local < f.end)
    let off = index >= 0 ? local - file.fragments[index].start : 0
    if (index < 0) {
      index = file.fragments.findIndex((f) => f.start >= local)
      if (index < 0) index = file.fragments.length - 1
      off = 0
    }
    return { pos: file.start + file.fragments[index].start + off, fid: file.firstFragment + index, off }
  }
}

const LANGUAGE_CODES: Record<string, number> = {
  ar: 1, bg: 2, ca: 3, zh: 4, cs: 5, da: 6, de: 7, el: 8, en: 9, es: 10, fi: 11, fr: 12, he: 13, hu: 14, is: 15,
  it: 16, ja: 17, ko: 18, nl: 19, no: 20, nb: 20, nn: 20, pl: 21, pt: 22, ro: 24, ru: 25, hr: 26, sk: 27, sv: 29, tr: 31, uk: 34
}

function exthRecord(type: number, data: Buffer | string | number): Buffer {
  const body = typeof data === 'number' ? u32(data) : Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
  return Buffer.concat([u32(type), u32(body.length + 8), body])
}

export function buildAzw3(book: EpubBook, meta: EpubMetadata): Buffer {
  const resources = new Resources(book)
  const spinePaths = new Set(book.spine.map((f) => f.path))
  let aidCounter = 0
  const nextAid = () => base32(aidCounter++, 1)

  // 1. Lay out each spine document; positions are known once all files are placed.
  const files = book.spine.map((f) => layoutFile(f.path, f.data.toString('utf8'), { spinePaths, resources }, nextAid))
  let start = 0
  let seq = 0
  for (const f of files) {
    f.start = start
    f.firstFragment = seq
    start += f.doc.length
    seq += f.fragments.length
  }
  const resolve = resolver(files)

  // 2. Patch links, then cut each file into its skeleton and fragments.
  const htmlParts: Buffer[] = []
  const skeletonEntries: IndexEntry[] = []
  const fragmentEntries: IndexEntry[] = []
  const selectors = new Cncx()
  for (const [fileNumber, f] of files.entries()) {
    for (const [pos, target] of f.links) {
      const t = resolve(target)!
      f.doc.write(`kindle:pos:fid:${base32(t.fid, 4)}:off:${base32(t.off, 10)}`, pos, 'latin1')
    }
    const skeleton: Buffer[] = []
    let cursor = 0
    for (const frag of f.fragments) {
      skeleton.push(f.doc.subarray(cursor, frag.start))
      cursor = frag.end
    }
    skeleton.push(f.doc.subarray(cursor))
    const skeletonBytes = Buffer.concat(skeleton)
    htmlParts.push(skeletonBytes)

    let fragmentOffset = 0
    f.fragments.forEach((frag, i) => {
      const length = frag.end - frag.start
      htmlParts.push(f.doc.subarray(frag.start, frag.end))
      fragmentEntries.push({
        label: String(f.start + frag.start).padStart(10, '0'),
        tags: new Map([
          [2, [selectors.add(`P-//*[@aid='${frag.aid}']`)]],
          [3, [fileNumber]],
          [4, [f.firstFragment + i]],
          [6, [fragmentOffset, length]]
        ])
      })
      fragmentOffset += length
    })
    skeletonEntries.push({
      label: `SKEL${String(fileNumber).padStart(10, '0')}`,
      tags: new Map([
        [1, [f.fragments.length, f.fragments.length]],
        [6, [f.start, skeletonBytes.length, f.start, skeletonBytes.length]]
      ])
    })
  }
  const html = Buffer.concat(htmlParts)
  resources.flows[0] = html

  // 3. Table of contents, in breadth-first order with parent/child links (as Kindles expect).
  const ncx = ncxEntries(book.toc.length ? book.toc : fallbackToc(book, files), resolve, html.length)

  // 4. Records: text, indexes, resources, then the flow table and trailer records.
  const coverIndex = book.coverPath ? resources.index(book.coverPath) : undefined
  const text = Buffer.concat(resources.flows)
  const texts = textRecords(text)
  // Amazon's files put a single zero byte record between the text and the indexes.
  const records: Buffer[] = [Buffer.alloc(0), ...texts, Buffer.alloc(1)]
  const firstNonText = records.length
  const fragIndex = records.length
  records.push(...buildIndex(fragmentEntries, [[{ tag: 2, perEntry: 1, mask: 1 }, { tag: 3, perEntry: 1, mask: 2 }, { tag: 4, perEntry: 1, mask: 4 }, { tag: 6, perEntry: 2, mask: 8 }]], selectors.toRecords()))
  const skelIndex = records.length
  records.push(...buildIndex(skeletonEntries, [[{ tag: 1, perEntry: 1, mask: 3 }, { tag: 6, perEntry: 2, mask: 12 }]]))
  const ncxIndex = records.length
  records.push(...buildIndex(ncx.entries, [NCX_TAGS], ncx.labels))
  const firstResource = resources.records.length ? records.length : NULL
  records.push(...resources.records)
  const fdstIndex = records.length
  const fdst = Buffer.alloc(12 + 8 * resources.flows.length)
  fdst.write('FDST', 0, 'latin1')
  fdst.writeUInt32BE(12, 4)
  fdst.writeUInt32BE(resources.flows.length, 8)
  let flowStart = 0
  resources.flows.forEach((flow, i) => {
    fdst.writeUInt32BE(flowStart, 12 + 8 * i)
    fdst.writeUInt32BE((flowStart += flow.length), 16 + 8 * i)
  })
  records.push(fdst)
  const flisIndex = records.length
  records.push(flisRecord())
  const fcisIndex = records.length
  records.push(fcisRecord(html.length), EOF_RECORD)

  // 5. Record 0: PalmDOC header, MOBI header, EXTH metadata, full title.
  const asin = randomUUID()
  const start116 = book.startHref ? resolve(book.startHref) : undefined
  const exth: Buffer[] = [
    ...meta.authors.map((a) => exthRecord(100, a)),
    ...(meta.publisher ? [exthRecord(101, meta.publisher)] : []),
    ...(meta.description ? [exthRecord(103, meta.description.replace(/<[^>]+>/g, '').trim())] : []),
    ...(meta.isbn ? [exthRecord(104, meta.isbn)] : []),
    ...(meta.publishedDate ? [exthRecord(106, meta.publishedDate)] : []),
    exthRecord(113, asin),
    exthRecord(504, asin),
    exthRecord(501, 'EBOK'),
    exthRecord(503, meta.title),
    ...(meta.language ? [exthRecord(524, meta.language)] : []),
    exthRecord(125, resources.records.length),
    ...(coverIndex !== undefined ? [exthRecord(201, coverIndex), exthRecord(203, 0)] : []),
    ...(start116 ? [exthRecord(116, start116.pos)] : []),
    exthRecord(204, 201),
    exthRecord(205, 2),
    exthRecord(206, 9),
    exthRecord(207, 0)
  ]
  let exthBlock = Buffer.concat([Buffer.from('EXTH', 'latin1'), u32(0), u32(exth.length), ...exth])
  if (exthBlock.length % 4) exthBlock = Buffer.concat([exthBlock, Buffer.alloc(4 - (exthBlock.length % 4))])
  exthBlock.writeUInt32BE(exthBlock.length, 4)

  const title = Buffer.from(meta.title, 'utf8')
  const header = Buffer.alloc(280)
  header.writeUInt16BE(2, 0) // PalmDOC compression
  header.writeUInt32BE(html.length, 4)
  header.writeUInt16BE(texts.length, 8)
  header.writeUInt16BE(TEXT_RECORD_SIZE, 10)
  const fields: Record<number, number> = {
    16: 0x4d4f4249, // 'MOBI'
    20: 264,
    24: 2,
    28: 65001,
    32: randomBytes(4).readUInt32BE(0),
    36: 8,
    40: NULL, 44: NULL, 48: NULL, 52: NULL, 56: NULL, 60: NULL, 64: NULL, 68: NULL, 72: NULL, 76: NULL,
    80: firstNonText,
    84: 280 + exthBlock.length,
    88: title.length,
    92: LANGUAGE_CODES[(meta.language ?? '').toLowerCase().split('-')[0]] ?? 0,
    104: 8,
    108: firstResource,
    128: 0x50,
    164: NULL,
    168: NULL,
    192: fdstIndex,
    196: resources.flows.length,
    200: fcisIndex,
    204: 1,
    208: flisIndex,
    212: 1,
    224: NULL,
    232: NULL,
    236: NULL,
    240: 1, // extra data flags (low 16 bits at 242): multibyte trailing bytes
    244: ncxIndex,
    248: fragIndex,
    252: skelIndex,
    256: NULL,
    260: NULL,
    264: NULL,
    272: NULL
  }
  for (const [off, v] of Object.entries(fields)) header.writeUInt32BE(v >>> 0, Number(off))

  const nameEnd = 280 + exthBlock.length + title.length + 2
  records[0] = Buffer.concat([header, exthBlock, title, Buffer.alloc(2 + ((4 - (nameEnd % 4)) % 4) + 8192)])

  const pdbName = meta.title.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 31) || 'book'
  return palmDb(pdbName, records)
}

const NCX_TAGS = [
  { tag: 1, perEntry: 1, mask: 0x01 }, // offset
  { tag: 2, perEntry: 1, mask: 0x02 }, // length
  { tag: 3, perEntry: 1, mask: 0x04 }, // label (CNCX)
  { tag: 4, perEntry: 1, mask: 0x08 }, // depth
  { tag: 21, perEntry: 1, mask: 0x10 }, // parent
  { tag: 22, perEntry: 1, mask: 0x20 }, // first child
  { tag: 23, perEntry: 1, mask: 0x40 }, // last child
  { tag: 6, perEntry: 2, mask: 0x80 } // position: fragment id, offset
]

function fallbackToc(book: EpubBook, files: LaidOutFile[]): TocEntry[] {
  return files.map((f, i) => {
    const title = f.doc.toString('utf8', 0, 2000).match(/<title>([^<]*)<\/title>/)?.[1]?.trim()
    return { label: title || `Section ${i + 1}`, href: book.spine[i].path, children: [] }
  })
}

function ncxEntries(toc: TocEntry[], resolve: (href: string) => Target | undefined, htmlLength: number) {
  interface Node {
    label: string
    target: Target
    depth: number
    children: Node[]
    parent?: Node
  }
  // Resolve targets; entries that point nowhere are skipped, their children promoted.
  const build = (entries: TocEntry[], depth: number): Node[] =>
    entries.flatMap((e) => {
      const target = resolve(e.href)
      if (!target) return build(e.children, depth)
      const node: Node = { label: e.label, target, depth, children: [] }
      node.children = build(e.children, depth + 1)
      node.children.forEach((c) => (c.parent = node))
      return [node]
    })

  const order: Node[] = []
  for (let level = build(toc, 0); level.length; level = level.flatMap((n) => n.children)) order.push(...level)
  const indexOf = new Map(order.map((n, i) => [n, i]))
  const byPosition = [...order].sort((a, b) => a.target.pos - b.target.pos)
  const labelWidth = Math.max(2, Math.max(0, order.length - 1).toString(16).length)

  const labels = new Cncx()
  const entries: IndexEntry[] = order.map((n, i) => {
    const next = byPosition.find((m) => m.target.pos > n.target.pos)
    const tags = new Map<number, number[]>([
      [1, [n.target.pos]],
      [2, [(next?.target.pos ?? htmlLength) - n.target.pos]],
      [3, [labels.add(n.label)]],
      [4, [n.depth]]
    ])
    if (n.parent) tags.set(21, [indexOf.get(n.parent)!])
    if (n.children.length) {
      tags.set(22, [indexOf.get(n.children[0])!])
      tags.set(23, [indexOf.get(n.children[n.children.length - 1])!])
    }
    tags.set(6, [n.target.fid, n.target.off])
    return { label: i.toString(16).toUpperCase().padStart(labelWidth, '0'), tags }
  })
  return { entries, labels: labels.toRecords() }
}
