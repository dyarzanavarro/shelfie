import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import { posix } from 'node:path'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import type { TocEntry } from './types'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

/** A file inside the EPUB, addressed by its normalized path in the zip. */
export interface EpubFile {
  path: string
  mediaType: string
  data: Buffer
}

export interface EpubBook {
  /** Reading-order XHTML documents. */
  spine: EpubFile[]
  /** Every manifest item by zip path (spine documents included). */
  files: Map<string, EpubFile>
  /** TOC hrefs are zip paths, optionally with "#fragment". */
  toc: TocEntry[]
  coverPath?: string
  /** Where reading should start (EPUB guide "text" / landmarks "bodymatter"). */
  startHref?: string
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  textNodeName: '#text',
  isArray: (name) => ['item', 'itemref', 'meta', 'rootfile', 'navPoint', 'reference'].includes(name)
})

const attr = (node: unknown, name: string): string | undefined =>
  node && typeof node === 'object' ? ((node as Record<string, unknown>)[`@${name}`] as string | undefined) : undefined

/** Resolves an href relative to the file it appears in; keeps any "#fragment". */
export function resolveHref(base: string, href: string): string {
  const [path, frag] = href.split('#', 2)
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // keep as-is
  }
  const full = path ? posix.normalize(posix.join(posix.dirname(base), decoded)) : base
  return frag !== undefined ? `${full}#${frag}` : full
}

export function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href)
}

function isElement(n: Node): n is Element {
  return 'tagName' in n
}

function children(n: Node): Node[] {
  return 'childNodes' in n ? n.childNodes : []
}

function textOf(n: Node): string {
  if (n.nodeName === '#text') return (n as DefaultTreeAdapterMap['textNode']).value
  return children(n).map(textOf).join('')
}

function getAttr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => (a.prefix ? `${a.prefix}:${a.name}` : a.name) === name)?.value
}

function findAll(n: Node, pred: (el: Element) => boolean, out: Element[] = []): Element[] {
  if (isElement(n) && pred(n)) out.push(n)
  for (const c of children(n)) findAll(c, pred, out)
  return out
}

function navToc(navPath: string, html: string): TocEntry[] {
  const doc = parse(html)
  const navs = findAll(doc, (el) => el.tagName === 'nav')
  const nav = navs.find((el) => (getAttr(el, 'epub:type') ?? '').split(/\s+/).includes('toc')) ?? navs[0]
  if (!nav) return []
  const list = (ol: Element): TocEntry[] =>
    children(ol)
      .filter((c): c is Element => isElement(c) && c.tagName === 'li')
      .flatMap((li) => {
        const link = children(li).find((c): c is Element => isElement(c) && (c.tagName === 'a' || c.tagName === 'span'))
        const sub = children(li).find((c): c is Element => isElement(c) && (c.tagName === 'ol' || c.tagName === 'ul'))
        const nested = sub ? list(sub) : []
        const href = link && getAttr(link, 'href')
        const label = link ? textOf(link).replace(/\s+/g, ' ').trim() : ''
        if (!href || !label) return nested
        return [{ label, href: resolveHref(navPath, href), children: nested }]
      })
  const ol = findAll(nav, (el) => el.tagName === 'ol' || el.tagName === 'ul')[0]
  return ol ? list(ol) : []
}

function ncxToc(ncxPath: string, xml: string): TocEntry[] {
  const ncx = parser.parse(xml)?.ncx
  const points = (list: unknown[] | undefined): TocEntry[] =>
    (list ?? []).flatMap((p: any) => {
      const label = String(p?.navLabel?.text?.['#text'] ?? p?.navLabel?.text ?? '').replace(/\s+/g, ' ').trim()
      const src = attr(p?.content, 'src')
      const nested = points(p?.navPoint)
      if (!label || !src) return nested
      return [{ label, href: resolveHref(ncxPath, src), children: nested }]
    })
  return points(ncx?.navMap?.navPoint)
}

function uniqueIdentifier(pkg: any): string {
  const ids: unknown[] = [pkg?.metadata?.identifier ?? []].flat()
  const wanted = attr(pkg, 'unique-identifier')
  const node = ids.find((i) => attr(i, 'id') === wanted) ?? ids[0]
  const value = typeof node === 'object' && node ? (node as Record<string, unknown>)['#text'] : node
  return value == null ? '' : String(value).trim()
}

const xorPrefix = (key: Buffer, length: number) => (data: Buffer) => {
  const out = Buffer.from(data)
  for (let i = 0; i < Math.min(length, out.length); i++) out[i] ^= key[i % key.length]
  return out
}

/**
 * Embedded fonts are often "obfuscated" (XOR with a key derived from the book id) per the EPUB spec
 * or Adobe's scheme; undo that. Anything else listed in encryption.xml is real DRM.
 */
function readEncryption(xml: string | undefined, uid: string): Map<string, ((data: Buffer) => Buffer) | 'drm'> {
  const result = new Map<string, ((data: Buffer) => Buffer) | 'drm'>()
  if (!xml) return result
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, isArray: (n) => n === 'EncryptedData' }).parse(xml)
  for (const item of doc?.encryption?.EncryptedData ?? []) {
    const algorithm = attr(item?.EncryptionMethod, 'Algorithm') ?? ''
    const uri = attr(item?.CipherData?.CipherReference, 'URI')
    if (!uri) continue
    const path = resolveHref('', uri)
    if (algorithm === 'http://www.idpf.org/2008/embedding') {
      result.set(path, xorPrefix(createHash('sha1').update(uid.replace(/[ \u0009\u000d\u000a]/g, '')).digest(), 1040))
    } else if (algorithm === 'http://ns.adobe.com/pdf/enc#RC') {
      const key = Buffer.from(uid.replace(/^urn:uuid:/i, '').replace(/[^0-9a-f]/gi, ''), 'hex')
      result.set(path, key.length === 16 ? xorPrefix(key, 1024) : 'drm')
    } else {
      result.set(path, 'drm')
    }
  }
  return result
}

export function readEpubBook(file: string): EpubBook {
  const zip = new AdmZip(file)
  const entries = new Map(zip.getEntries().map((e) => [e.entryName, e]))
  const lower = new Map([...entries.keys()].map((k) => [k.toLowerCase(), k]))
  const read = (path: string): Buffer | undefined => {
    const entry = entries.get(path) ?? entries.get(lower.get(path.toLowerCase()) ?? '')
    return entry?.getData()
  }

  const container = parser.parse(read('META-INF/container.xml')?.toString('utf8') ?? '')
  const opfPath: string | undefined = attr(container?.container?.rootfiles?.rootfile?.[0], 'full-path')
  if (!opfPath) throw new Error('EPUB has no OPF package file')
  const pkg = parser.parse(read(opfPath)?.toString('utf8') ?? '')?.package
  if (!pkg) throw new Error('EPUB package file is unreadable')

  const encryption = readEncryption(read('META-INF/encryption.xml')?.toString('utf8'), uniqueIdentifier(pkg))

  const files = new Map<string, EpubFile>()
  const byId = new Map<string, { path: string; mediaType: string; properties: string[] }>()
  for (const item of pkg.manifest?.item ?? []) {
    const href = attr(item, 'href')
    if (!href) continue
    const path = resolveHref(opfPath, href)
    const mediaType = attr(item, 'media-type') ?? ''
    byId.set(attr(item, 'id') ?? path, { path, mediaType, properties: (attr(item, 'properties') ?? '').split(/\s+/) })
    const data = read(path)
    const decode = encryption.get(path)
    if (decode === 'drm') {
      if (/x?html/i.test(mediaType)) throw new Error('This book is DRM-protected and cannot be converted')
      continue
    }
    if (data) files.set(path, { path, mediaType, data: decode ? decode(data) : data })
  }

  const spine = (pkg.spine?.itemref ?? [])
    .map((ref: unknown) => byId.get(attr(ref, 'idref') ?? ''))
    .filter((item: { path: string } | undefined): item is { path: string; mediaType: string; properties: string[] } => !!item)
    .map((item: { path: string }) => files.get(item.path))
    .filter((f: EpubFile | undefined): f is EpubFile => !!f && /x?html/i.test(f.mediaType || f.path))
  if (!spine.length) throw new Error('EPUB has no readable chapters')

  // Table of contents: EPUB 3 nav document, else the EPUB 2 NCX.
  let toc: TocEntry[] = []
  const nav = [...byId.values()].find((i) => i.properties.includes('nav'))
  if (nav) toc = navToc(nav.path, read(nav.path)?.toString('utf8') ?? '')
  if (!toc.length) {
    const ncx = byId.get(attr(pkg.spine, 'toc') ?? '') ?? [...byId.values()].find((i) => i.mediaType === 'application/x-dtbncx+xml')
    if (ncx) toc = ncxToc(ncx.path, read(ncx.path)?.toString('utf8') ?? '')
  }

  const metas: unknown[] = pkg.metadata?.meta ?? []
  const coverId = attr(metas.find((m) => attr(m, 'name') === 'cover'), 'content')
  const cover =
    [...byId.values()].find((i) => i.properties.includes('cover-image')) ??
    (coverId ? byId.get(coverId) : undefined) ??
    [...byId.values()].find((i) => /^image\//.test(i.mediaType) && /cover/i.test(i.path))

  const guideText = (pkg.guide?.reference ?? []).find((r: unknown) => ['text', 'start'].includes(attr(r, 'type') ?? ''))
  const startHref = guideText ? resolveHref(opfPath, attr(guideText, 'href') ?? '') : undefined

  return { spine, files, toc, coverPath: cover?.path, startHref }
}
