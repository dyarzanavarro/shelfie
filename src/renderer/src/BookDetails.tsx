import { useState } from 'react'
import type { ActionResult, Book, KindleDevice } from '../../shared/types'
import { Cover } from './Cover'

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const CONVERTIBLE = ['mobi', 'azw3', 'azw']

// What a Kindle can open when copied over USB (not EPUB).
const USB_READABLE = ['azw3', 'mobi', 'azw', 'pdf']

interface Props {
  book: Book
  kindleConfigured: boolean
  usbKindle: KindleDevice | null
  onKindle: boolean
  onCopiedToKindle: () => void
  onClose: () => void
  onChanged: () => void
  onRemoved: () => void
  onResult: (result: ActionResult) => void
  onOpenSettings: () => void
}

export function BookDetails({
  book,
  kindleConfigured,
  usbKindle,
  onKindle,
  onCopiedToKindle,
  onClose,
  onChanged,
  onRemoved,
  onResult,
  onOpenSettings
}: Props) {
  const [busy, setBusy] = useState<'convert' | 'send' | 'usb' | null>(null)
  const usbReadable = book.formats.some((f) => USB_READABLE.includes(f.format))

  const copyToKindle = async () => {
    if (!usbKindle) return
    setBusy('usb')
    try {
      onResult(await window.api.copyToKindle(book.id, usbKindle.root))
      onCopiedToKindle()
    } finally {
      setBusy(null)
    }
  }
  const hasEpub = book.formats.some((f) => f.format === 'epub')
  const canConvert = !hasEpub && book.formats.some((f) => CONVERTIBLE.includes(f.format))

  const rows: Array<[string, string | null]> = [
    ['Series', book.series ? `${book.series}${book.seriesIndex != null ? ` #${book.seriesIndex}` : ''}` : null],
    ['Publisher', book.publisher],
    ['Published', book.publishedDate?.slice(0, 10) ?? null],
    ['Language', book.language],
    ['ISBN', book.isbn],
    ['Added', new Date(book.addedAt + 'Z').toLocaleDateString()]
  ]

  const run = async (kind: 'convert' | 'send') => {
    setBusy(kind)
    try {
      const result = kind === 'convert' ? await window.api.convertToEpub(book.id) : await window.api.sendToKindle(book.id)
      onResult(result)
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!confirm(`Remove “${book.title}” from the library? Its files will be moved to the Recycle Bin.`)) return
    await window.api.removeBook(book.id)
    onRemoved()
  }

  return (
    <aside className="details">
      <button className="close" onClick={onClose} aria-label="Close details">
        ×
      </button>
      <Cover book={book} large />
      <h2>{book.title}</h2>
      <p className="details-author">{book.authors.join(', ')}</p>

      <div className="formats">
        {book.formats.map((f) => (
          <span key={f.id} className="badge">
            {f.format.toUpperCase()} · {formatSize(f.size)}
          </span>
        ))}
      </div>

      <div className="details-primary">
        {usbKindle &&
          (onKindle ? (
            <button disabled title="This book's file is already in the Kindle's documents folder">
              ✓ On your Kindle
            </button>
          ) : (
            <button
              className="primary"
              disabled={!!busy || !usbReadable}
              title={usbReadable ? undefined : 'Kindles can’t open EPUB over USB. Use Send to Kindle for this book.'}
              onClick={copyToKindle}
            >
              {busy === 'usb' ? 'Copying…' : 'Copy to Kindle (USB)'}
            </button>
          ))}
        {kindleConfigured ? (
          <button className={usbKindle ? undefined : 'primary'} disabled={!!busy} onClick={() => run('send')}>
            {busy === 'send' ? (canConvert ? 'Converting & sending…' : 'Sending…') : 'Send to Kindle'}
          </button>
        ) : (
          <button onClick={onOpenSettings}>Set up Send to Kindle…</button>
        )}
        {canConvert && (
          <button disabled={!!busy} onClick={() => run('convert')}>
            {busy === 'convert' ? 'Converting…' : 'Convert to EPUB'}
          </button>
        )}
      </div>

      <dl>
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>

      {book.description && <p className="description">{book.description}</p>}

      <div className="details-actions">
        <button onClick={() => window.api.showInFolder(book.id)}>Open folder</button>
        <button className="danger" onClick={remove}>
          Remove
        </button>
      </div>
    </aside>
  )
}
