export type BookFormat = 'epub' | 'pdf' | 'mobi' | 'azw3' | 'azw'

export interface BookFile {
  id: number
  format: BookFormat
  path: string
  size: number
}

export interface Book {
  id: number
  title: string
  authors: string[]
  description: string | null
  publisher: string | null
  publishedDate: string | null
  language: string | null
  isbn: string | null
  series: string | null
  seriesIndex: number | null
  hasCover: boolean
  addedAt: string
  formats: BookFile[]
}

export interface ImportResult {
  path: string
  status: 'imported' | 'duplicate' | 'unsupported' | 'error'
  bookId?: number
  message?: string
}

export interface ImportProgress {
  done: number
  total: number
}

export type SortKey = 'added' | 'title' | 'author'

export interface ListQuery {
  search?: string
  sort?: SortKey
}

export interface KindleSettings {
  kindleEmail: string
  fromAddress: string
  smtpHost: string
  smtpPort: number
  /** true = TLS from the start (port 465); false = STARTTLS (port 587). */
  smtpSecure: boolean
  smtpUser: string
  hasPassword: boolean
}

export interface KindleSettingsInput extends Omit<KindleSettings, 'hasPassword'> {
  /** Omit to keep the stored password. */
  smtpPassword?: string
}

/** A Kindle mounted as a USB drive. */
export interface KindleDevice {
  root: string
  firmware: string
  freeBytes: number
  totalBytes: number
}

export type ActionResult = { ok: true; message: string } | { ok: false; message: string }

export interface LibraryApi {
  listBooks(query: ListQuery): Promise<Book[]>
  /** Files or folders; folders are searched recursively. */
  importFiles(paths: string[]): Promise<ImportResult[]>
  pickAndImport(folders?: boolean): Promise<ImportResult[]>
  /** Returns an unsubscribe function. */
  onImportProgress(listener: (progress: ImportProgress) => void): () => void
  removeBook(id: number): Promise<void>
  showInFolder(id: number): Promise<void>
  libraryPath(): Promise<string>
  pathForFile(file: File): string
  convertToEpub(id: number): Promise<ActionResult>
  convertToAzw3(id: number): Promise<ActionResult>
  getSettings(): Promise<KindleSettings>
  saveSettings(input: KindleSettingsInput): Promise<KindleSettings>
  testSmtp(input: KindleSettingsInput): Promise<ActionResult>
  sendToKindle(id: number): Promise<ActionResult>
  findKindles(): Promise<KindleDevice[]>
  booksOnKindle(root: string): Promise<number[]>
  copyToKindle(id: number, root: string): Promise<ActionResult>
  ejectKindle(root: string): Promise<ActionResult>
}
