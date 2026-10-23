import Database from 'better-sqlite3'
import type { Book, BookFile, BookFormat, ListQuery } from '../shared/types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS books (
  id             INTEGER PRIMARY KEY,
  title          TEXT NOT NULL,
  sort_title     TEXT NOT NULL,
  description    TEXT,
  publisher      TEXT,
  published_date TEXT,
  language       TEXT,
  isbn           TEXT,
  series         TEXT,
  series_index   REAL,
  dir            TEXT NOT NULL,
  has_cover      INTEGER NOT NULL DEFAULT 0,
  added_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS authors (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS book_authors (
  book_id   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  PRIMARY KEY (book_id, author_id)
);
CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS book_tags (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, tag_id)
);
CREATE TABLE IF NOT EXISTS formats (
  id      INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  format  TEXT NOT NULL,
  path    TEXT NOT NULL,
  size    INTEGER NOT NULL,
  hash    TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_formats_book ON formats(book_id);
`

export interface NewBook {
  title: string
  authors: string[]
  description?: string | null
  publisher?: string | null
  publishedDate?: string | null
  language?: string | null
  isbn?: string | null
  series?: string | null
  seriesIndex?: number | null
}

export function sortTitle(title: string): string {
  return title.replace(/^(the|a|an)\s+/i, '').trim().toLowerCase()
}

export function sortAuthor(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length < 2) return name.toLowerCase()
  const last = parts.pop()!
  return `${last}, ${parts.join(' ')}`.toLowerCase()
}

export class LibraryDb {
  private db: Database.Database

  constructor(file: string) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(SCHEMA)
  }

  hashExists(hash: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM formats WHERE hash = ?').get(hash)
  }

  insertBook(book: NewBook, dir: string): number {
    const tx = this.db.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO books (title, sort_title, description, publisher, published_date, language, isbn, series, series_index, dir)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          book.title,
          sortTitle(book.title),
          book.description ?? null,
          book.publisher ?? null,
          book.publishedDate ?? null,
          book.language ?? null,
          book.isbn ?? null,
          book.series ?? null,
          book.seriesIndex ?? null,
          dir
        )
      const bookId = Number(lastInsertRowid)
      const upsertAuthor = this.db.prepare(
        'INSERT INTO authors (name, sort_name) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET name = name RETURNING id'
      )
      const link = this.db.prepare('INSERT OR IGNORE INTO book_authors (book_id, author_id, position) VALUES (?, ?, ?)')
      book.authors.forEach((name, i) => {
        const { id } = upsertAuthor.get(name, sortAuthor(name)) as { id: number }
        link.run(bookId, id, i)
      })
      return bookId
    })
    return tx()
  }

  setDir(bookId: number, dir: string, hasCover: boolean): void {
    this.db.prepare('UPDATE books SET dir = ?, has_cover = ? WHERE id = ?').run(dir, hasCover ? 1 : 0, bookId)
  }

  addFormat(bookId: number, format: BookFormat, path: string, size: number, hash: string): void {
    this.db
      .prepare('INSERT INTO formats (book_id, format, path, size, hash) VALUES (?, ?, ?, ?, ?)')
      .run(bookId, format, path, size, hash)
  }

  // Same ISBN, or same title + first author, and no file of this format yet.
  findMergeTarget(
    book: { title: string; authors: string[]; isbn?: string | null },
    format: BookFormat
  ): { id: number; dir: string; hasCover: boolean } | undefined {
    const row = this.db
      .prepare(
        `SELECT b.id, b.dir, b.has_cover FROM books b
         WHERE ((b.isbn IS NOT NULL AND b.isbn = ?)
            OR (b.sort_title = ? AND EXISTS (
                  SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                  WHERE ba.book_id = b.id AND ba.position = 0 AND a.name = ? COLLATE NOCASE)))
         AND NOT EXISTS (SELECT 1 FROM formats f WHERE f.book_id = b.id AND f.format = ?)
         ORDER BY b.id LIMIT 1`
      )
      .get(book.isbn ?? null, sortTitle(book.title), book.authors[0], format) as
      | { id: number; dir: string; has_cover: number }
      | undefined
    return row && { id: row.id, dir: row.dir, hasCover: !!row.has_cover }
  }

  getDir(bookId: number): string | undefined {
    const row = this.db.prepare('SELECT dir FROM books WHERE id = ?').get(bookId) as { dir: string } | undefined
    return row?.dir
  }

  deleteBook(bookId: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM books WHERE id = ?').run(bookId)
      this.db.prepare('DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM book_authors)').run()
    })()
  }

  getBook(id: number): Book | undefined {
    return this.listBooks({ id })[0]
  }

  listBooks({ search, sort = 'added', id }: ListQuery & { id?: number }): Book[] {
    const order = {
      added: 'b.added_at DESC, b.id DESC',
      title: 'b.sort_title ASC',
      author: 'first_author_sort ASC, b.sort_title ASC'
    }[sort]

    const params: Array<string | number> = []
    let where = ''
    if (id !== undefined) {
      where = 'WHERE b.id = ?'
      params.push(id)
    } else if (search?.trim()) {
      const like = `%${search.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`
      where = `WHERE b.title LIKE ? ESCAPE '\\' OR b.series LIKE ? ESCAPE '\\' OR b.isbn LIKE ? ESCAPE '\\'
               OR EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                          WHERE ba.book_id = b.id AND a.name LIKE ? ESCAPE '\\')`
      params.push(like, like, like, like)
    }

    const rows = this.db
      .prepare(
        `SELECT b.*,
           (SELECT json_group_array(name) FROM (SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
             WHERE ba.book_id = b.id ORDER BY ba.position)) AS authors_json,
           (SELECT a.sort_name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
             WHERE ba.book_id = b.id ORDER BY ba.position LIMIT 1) AS first_author_sort
         FROM books b ${where} ORDER BY ${order}`
      )
      .all(...params) as Array<Record<string, any>>

    const formatsByBook = new Map<number, BookFile[]>()
    for (const f of this.db.prepare('SELECT id, book_id, format, path, size FROM formats').all() as any[]) {
      const list = formatsByBook.get(f.book_id) ?? []
      list.push({ id: f.id, format: f.format, path: f.path, size: f.size })
      formatsByBook.set(f.book_id, list)
    }

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      authors: JSON.parse(r.authors_json),
      description: r.description,
      publisher: r.publisher,
      publishedDate: r.published_date,
      language: r.language,
      isbn: r.isbn,
      series: r.series,
      seriesIndex: r.series_index,
      hasCover: !!r.has_cover,
      addedAt: r.added_at,
      formats: formatsByBook.get(r.id) ?? []
    }))
  }
}
