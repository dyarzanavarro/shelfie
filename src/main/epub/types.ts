export interface EpubChapter {
  /** Relative to the OEBPS root, e.g. "text/part0001.xhtml". */
  href: string
  title?: string
  bodyAttrs?: string
  body: string
  stylesheets: string[]
  inlineCss: string[]
}

export interface EpubResource {
  href: string
  mediaType: string
  data: Buffer
}

export interface TocEntry {
  label: string
  href: string
  children: TocEntry[]
}

export interface EpubContent {
  chapters: EpubChapter[]
  resources: EpubResource[]
  toc: TocEntry[]
  coverHref?: string
  language?: string
}

export interface EpubMetadata {
  title: string
  authors: string[]
  language?: string | null
  publisher?: string | null
  publishedDate?: string | null
  description?: string | null
  isbn?: string | null
  series?: string | null
  seriesIndex?: number | null
}
