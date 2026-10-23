import { parse, type DefaultTreeAdapterMap } from 'parse5'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const DROP = new Set(['script', 'noscript', 'iframe', 'object', 'form', 'guide'])
const XML_NAME = /^[A-Za-z_][\w.-]*$/

export interface SerializeOptions {
  /** Return a new value, a [name, value] pair to rename, or null to drop the attribute. */
  attr?: (el: Element, name: string, value: string) => string | [string, string] | null
  /** Rename an element and/or move presentational attributes into its style. */
  element?: (el: Element) => { tag?: string; style?: string; drop?: string[] } | undefined
}

/** Kindle "aid" attributes become ids (unless the element already has one) so kindle:pos links can target them. */
export const aidToId: NonNullable<SerializeOptions['attr']> = (el, name, value) => {
  if (name !== 'aid') return value
  return el.attrs.some((a) => a.name === 'id') ? null : ['id', `aid-${value}`]
}

export interface ParsedHtml {
  title: string | undefined
  styles: string[]
  stylesheetHrefs: string[]
  /** Serialized attributes of <body>, with a leading space (or empty). */
  bodyAttrs: string
  body: string
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;')

function isElement(n: Node): n is Element {
  return 'tagName' in n
}

function find(node: Node, tag: string): Element | undefined {
  if (isElement(node) && node.tagName === tag) return node
  for (const child of 'childNodes' in node ? node.childNodes : []) {
    const hit = find(child, tag)
    if (hit) return hit
  }
  return undefined
}

function textContent(node: Node): string {
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterMap['textNode']).value
  return ('childNodes' in node ? node.childNodes : []).map(textContent).join('')
}

function serializeAttrs(
  node: Element,
  opts: SerializeOptions,
  inSvg: boolean,
  mapped: ReturnType<NonNullable<SerializeOptions['element']>>
): string {
  const dropped = new Set(mapped?.drop ?? [])
  let extraStyle = mapped?.style ?? ''
  let attrs = ''
  for (const a of node.attrs) {
    const name = a.prefix ? `${a.prefix}:${a.name}` : a.name
    if (a.prefix === 'xmlns' || name === 'xmlns' || dropped.has(name)) continue
    if (name === 'style' && extraStyle) {
      attrs += ` style="${escAttr(`${extraStyle}; ${a.value}`)}"`
      extraStyle = ''
      continue
    }
    if (!(XML_NAME.test(name) || name === 'xml:lang' || name === 'epub:type' || (inSvg && a.prefix === 'xlink'))) continue
    if (/^on/i.test(name)) continue
    const result = opts.attr ? opts.attr(node, name, a.value) : a.value
    if (result === null) continue
    const [outName, outValue] = Array.isArray(result) ? result : [name, result]
    attrs += ` ${outName}="${escAttr(outValue)}"`
  }
  if (extraStyle) attrs += ` style="${escAttr(extraStyle)}"`
  return attrs
}

function serializeNode(node: Node, opts: SerializeOptions, inSvg: boolean): string {
  if (node.nodeName === '#text') return escText((node as DefaultTreeAdapterMap['textNode']).value)
  if (!isElement(node)) return ''

  if (DROP.has(node.tagName)) return ''
  const children = (node.tagName === 'template' ? [] : node.childNodes)
    .map((c) => serializeNode(c, opts, inSvg || node.tagName === 'svg'))
    .join('')
  // Kindle-specific tags like <mbp:pagebreak/> have no XHTML equivalent; keep their content.
  if (node.tagName.includes(':') || !XML_NAME.test(node.tagName)) return children

  const mapped = inSvg ? undefined : opts.element?.(node)
  const tag = mapped?.tag ?? node.tagName
  let attrs = tag === 'svg' && !inSvg ? ' xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"' : ''
  attrs += serializeAttrs(node, opts, inSvg, mapped)

  if (VOID.has(tag) || (inSvg && !children)) return `<${tag}${attrs}/>`
  return `<${tag}${attrs}>${children}</${tag}>`
}

export function parseHtml(html: string, opts: SerializeOptions = {}): ParsedHtml {
  const doc = parse(html)
  const head = find(doc, 'head')
  const body = find(doc, 'body')

  const styles: string[] = []
  const stylesheetHrefs: string[] = []
  const walk = (n: Node) => {
    if (isElement(n)) {
      if (n.tagName === 'style') styles.push(textContent(n))
      if (n.tagName === 'link' && /stylesheet/i.test(n.attrs.find((a) => a.name === 'rel')?.value ?? '')) {
        const href = n.attrs.find((a) => a.name === 'href')?.value
        if (href) stylesheetHrefs.push(href)
      }
    }
    if ('childNodes' in n) n.childNodes.forEach(walk)
  }
  if (head) walk(head)

  const title = head && find(head, 'title')
  return {
    title: title ? textContent(title).trim() || undefined : undefined,
    styles,
    stylesheetHrefs,
    bodyAttrs: body ? serializeAttrs(body, opts, false, opts.element?.(body)) : '',
    body: body ? body.childNodes.map((c) => serializeNode(c, opts, false)).join('') : ''
  }
}

export function plainText(html: string): string {
  return textContent(parse(html)).replace(/\s+/g, ' ').trim()
}
