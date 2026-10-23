import { useCallback, useEffect, useState, type DragEvent } from 'react'
import type {
  ActionResult,
  Book,
  ImportProgress,
  ImportResult,
  KindleDevice,
  KindleSettings,
  SortKey
} from '../../shared/types'
import { BookDetails } from './BookDetails'
import { Cover } from './Cover'
import { SettingsDialog } from './SettingsDialog'

interface Toast {
  text: string
  error?: boolean
}

const isConfigured = (s: KindleSettings | null) => !!s && !!s.kindleEmail && !!s.smtpHost && !!s.fromAddress

function summarize(results: ImportResult[]): string | null {
  if (!results.length) return null
  const count = (s: ImportResult['status']) => results.filter((r) => r.status === s).length
  const parts = [
    count('imported') && `${count('imported')} added`,
    count('duplicate') && `${count('duplicate')} already in library`,
    count('unsupported') && `${count('unsupported')} unsupported`,
    count('error') && `${count('error')} failed`
  ].filter(Boolean)
  return parts.join(' · ')
}

export function App() {
  const [books, setBooks] = useState<Book[]>([])
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortKey>('added')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [settings, setSettings] = useState<KindleSettings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    window.api.getSettings().then(setSettings)
  }, [])

  // Poll for a Kindle plugged in over USB.
  const [usbKindle, setUsbKindle] = useState<KindleDevice | null>(null)
  const [onKindle, setOnKindle] = useState<Set<number>>(new Set())
  const usbRoot = usbKindle?.root
  useEffect(() => {
    let alive = true
    const check = async () => {
      const [device] = await window.api.findKindles()
      if (alive) setUsbKindle((prev) => (prev?.root === device?.root && prev?.freeBytes === device?.freeBytes ? prev : device ?? null))
    }
    check()
    const t = setInterval(check, 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const refreshOnKindle = useCallback(async () => {
    setOnKindle(new Set(usbRoot ? await window.api.booksOnKindle(usbRoot) : []))
  }, [usbRoot])
  useEffect(() => {
    refreshOnKindle()
  }, [refreshOnKindle, books.length])

  const eject = async () => {
    if (!usbRoot) return
    const result = await window.api.ejectKindle(usbRoot)
    showResult(result)
    if (result.ok) setUsbKindle(null)
  }

  const showResult = (r: ActionResult) => setToast({ text: r.message, error: !r.ok })

  const refresh = useCallback(async () => {
    setBooks(await window.api.listBooks({ search, sort }))
  }, [search, sort])

  useEffect(() => {
    const t = setTimeout(refresh, 150)
    return () => clearTimeout(t)
  }, [refresh])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.error ? 9000 : 5000)
    return () => clearTimeout(t)
  }, [toast])

  useEffect(
    () =>
      window.api.onImportProgress((p) => {
        setProgress(p)
        if (p.done % 25 === 0) refresh() // let big imports fill the grid as they go
      }),
    [refresh]
  )

  const runImport = async (task: () => Promise<ImportResult[]>) => {
    setBusy(true)
    setProgress(null)
    try {
      const results = await task()
      const errors = results.filter((r) => r.status === 'error')
      errors.forEach((r) => console.error('Import failed', r.path, r.message))
      const text = summarize(results)
      setToast(text ? { text, error: errors.length > 0 } : null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const paths = Array.from(e.dataTransfer.files).map((f) => window.api.pathForFile(f))
    if (paths.length) runImport(() => window.api.importFiles(paths))
  }

  const selected = books.find((b) => b.id === selectedId) ?? null

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.relatedTarget) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <header className="toolbar">
        <h1>Library</h1>
        <span className="count">{books.length} books</span>
        <input
          className="search"
          type="search"
          placeholder="Search title, author, series, ISBN…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort by">
          <option value="added">Recently added</option>
          <option value="title">Title</option>
          <option value="author">Author</option>
        </select>
        {usbKindle && (
          <span className="device-chip" title={`Kindle firmware ${usbKindle.firmware} on ${usbKindle.root}`}>
            <span className="dot" /> Kindle · {Math.round(usbKindle.freeBytes / 1e6)} MB free
            <button className="link" onClick={eject}>
              Eject
            </button>
          </span>
        )}
        <button onClick={() => setSettingsOpen(true)} title="Send to Kindle settings">
          Kindle settings
        </button>
        <button disabled={busy} onClick={() => runImport(() => window.api.pickAndImport(true))} title="Import every book in a folder and its subfolders, e.g. a Calibre library">
          Add folder
        </button>
        <button className="primary" disabled={busy} onClick={() => runImport(() => window.api.pickAndImport())}>
          {busy ? (progress ? `Importing ${progress.done} / ${progress.total}` : 'Importing…') : 'Add books'}
        </button>
      </header>
      {busy && progress && (
        <div className="progress" role="progressbar" aria-valuenow={progress.done} aria-valuemax={progress.total}>
          <div style={{ width: `${(100 * progress.done) / progress.total}%` }} />
        </div>
      )}

      <div className="body">
        <main className="grid-wrap" onClick={() => setSelectedId(null)}>
          {books.length === 0 ? (
            <div className="empty">
              {search ? (
                <p>No books match “{search}”.</p>
              ) : (
                <>
                  <p className="empty-title">Your library is empty</p>
                  <p>Drop EPUB, MOBI, AZW3 or PDF files or whole folders anywhere, or use “Add books” / “Add folder”.</p>
                </>
              )}
            </div>
          ) : (
            <ul className="grid">
              {books.map((book) => (
                <li
                  key={book.id}
                  className={book.id === selectedId ? 'card selected' : 'card'}
                  onClick={(e) => {
                    e.stopPropagation()
                    setSelectedId(book.id)
                  }}
                >
                  <Cover book={book} />
                  {onKindle.has(book.id) && <span className="on-kindle">On Kindle</span>}
                  <div className="card-title" title={book.title}>
                    {book.title}
                  </div>
                  <div className="card-author">{book.authors.join(', ')}</div>
                </li>
              ))}
            </ul>
          )}
        </main>

        {selected && (
          <BookDetails
            book={selected}
            kindleConfigured={isConfigured(settings)}
            usbKindle={usbKindle}
            onKindle={onKindle.has(selected.id)}
            onCopiedToKindle={refreshOnKindle}
            onClose={() => setSelectedId(null)}
            onChanged={refresh}
            onRemoved={async () => {
              setSelectedId(null)
              await refresh()
            }}
            onResult={showResult}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
      </div>

      {dragging && <div className="drop-overlay">Drop to add to library</div>}
      {toast && (
        <div className={toast.error ? 'toast error' : 'toast'} role="status">
          {toast.text}
        </div>
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onSaved={setSettings} />}
    </div>
  )
}
