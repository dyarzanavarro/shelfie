import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { EpubContent, EpubMetadata, TocEntry } from './types'
import { ZipWriter } from './zip'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const relative = (fromHref: string, toHref: string) => posix.relative(posix.dirname(fromHref), toHref) || posix.basename(toHref)

function chapterXhtml(
  ch: EpubContent['chapters'][number],
  lang: string,
  fallbackTitle: string
): string {
  const links = ch.stylesheets.map((h) => `    <link rel="stylesheet" type="text/css" href="${esc(relative(ch.href, h))}"/>`)
  const styles = ch.inlineCss.filter((c) => c.trim()).map((c) => `    <style type="text/css">${esc(c)}</style>`)
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(lang)}" lang="${esc(lang)}">
  <head>
    <meta charset="utf-8"/>
    <title>${esc(ch.title || fallbackTitle)}</title>
${[...links, ...styles].join('\n')}
  </head>
  <body${ch.bodyAttrs ?? ''}>
${ch.body}
  </body>
</html>
`
}

function navList(entries: TocEntry[], indent: string): string {
  if (!entries.length) return ''
  const items = entries.map(
    (e) =>
      `${indent}  <li><a href="${esc(e.href)}">${esc(e.label)}</a>${
        e.children.length ? `\n${navList(e.children, indent + '    ')}\n${indent}  ` : ''
      }</li>`
  )
  return `${indent}<ol>\n${items.join('\n')}\n${indent}</ol>`
}

function ncxPoints(entries: TocEntry[], counter: { n: number }, indent: string): string {
  return entries
    .map((e) => {
      const n = ++counter.n
      return `${indent}<navPoint id="np${n}" playOrder="${n}">
${indent}  <navLabel><text>${esc(e.label)}</text></navLabel>
${indent}  <content src="${esc(e.href)}"/>
${ncxPoints(e.children, counter, indent + '  ')}${indent}</navPoint>
`
    })
    .join('')
}

export function buildEpub(content: EpubContent, meta: EpubMetadata): Buffer {
  const lang = meta.language || content.language || 'en'
  const uid = meta.isbn ? `urn:isbn:${meta.isbn}` : `urn:uuid:${randomUUID()}`
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const toc = content.toc.length ? content.toc : [{ label: meta.title, href: content.chapters[0]?.href ?? 'nav.xhtml', children: [] }]

  const manifest: string[] = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
  ]
  content.chapters.forEach((ch, i) => {
    const svg = /<svg\b/i.test(ch.body) ? ' properties="svg"' : ''
    manifest.push(`<item id="c${i + 1}" href="${esc(ch.href)}" media-type="application/xhtml+xml"${svg}/>`)
  })
  content.resources.forEach((r, i) => {
    const cover = r.href === content.coverHref ? ' properties="cover-image"' : ''
    manifest.push(`<item id="r${i + 1}" href="${esc(r.href)}" media-type="${r.mediaType}"${cover}/>`)
  })
  const coverId = content.resources.findIndex((r) => r.href === content.coverHref)

  const metadata = [
    `<dc:identifier id="uid">${esc(uid)}</dc:identifier>`,
    `<dc:title>${esc(meta.title)}</dc:title>`,
    ...meta.authors.map((a, i) => `<dc:creator id="author${i}">${esc(a)}</dc:creator>`),
    `<dc:language>${esc(lang)}</dc:language>`,
    meta.publisher && `<dc:publisher>${esc(meta.publisher)}</dc:publisher>`,
    meta.publishedDate && `<dc:date>${esc(meta.publishedDate)}</dc:date>`,
    meta.description && `<dc:description>${esc(meta.description)}</dc:description>`,
    meta.series && `<meta property="belongs-to-collection" id="series">${esc(meta.series)}</meta>`,
    meta.series && '<meta refines="#series" property="collection-type">series</meta>',
    meta.series && meta.seriesIndex != null && `<meta refines="#series" property="group-position">${meta.seriesIndex}</meta>`,
    meta.series && `<meta name="calibre:series" content="${esc(meta.series)}"/>`,
    meta.series && meta.seriesIndex != null && `<meta name="calibre:series_index" content="${meta.seriesIndex}"/>`,
    coverId >= 0 && `<meta name="cover" content="r${coverId + 1}"/>`,
    `<meta property="dcterms:modified">${modified}</meta>`
  ].filter(Boolean)

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${esc(lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    ${metadata.join('\n    ')}
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${content.chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('\n    ')}
  </spine>
</package>
`

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(lang)}" lang="${esc(lang)}">
  <head><meta charset="utf-8"/><title>${esc(meta.title)}</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Contents</h1>
${navList(toc, '      ')}
    </nav>
  </body>
</html>
`

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${esc(uid)}"/></head>
  <docTitle><text>${esc(meta.title)}</text></docTitle>
  <navMap>
${ncxPoints(toc, { n: 0 }, '    ')}  </navMap>
</ncx>
`

  const zip = new ZipWriter()
  zip.add('mimetype', 'application/epub+zip', true)
  zip.add(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`
  )
  zip.add('OEBPS/content.opf', opf)
  zip.add('OEBPS/nav.xhtml', nav)
  zip.add('OEBPS/toc.ncx', ncx)
  for (const ch of content.chapters) zip.add(`OEBPS/${ch.href}`, chapterXhtml(ch, lang, meta.title))
  for (const r of content.resources) zip.add(`OEBPS/${r.href}`, r.data)
  return zip.toBuffer()
}
