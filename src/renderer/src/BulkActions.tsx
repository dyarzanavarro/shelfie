import { useState } from 'react'
import type { ActionResult, Book, KindleDevice } from '../../shared/types'
import { Cover } from './Cover'

const has = (book: Book, ...formats: string[]) => book.formats.some((f) => formats.includes(f.format))

interface Props {
  books: Book[]
  usbKindle: KindleDevice | null
  onKindle: Set<number>
  onClear: () => void
  onChanged: () => void
  onCopiedToKindle: () => void
  onResult: (result: ActionResult) => void
}

interface Action {
  key: string
  label: (n: number) => string
  verb: string
  eligible: (b: Book) => boolean
  run: (b: Book) => Promise<ActionResult>
}

export function BulkActions({ books, usbKindle, onKindle, onClear, onChanged, onCopiedToKindle, onResult }: Props) {
  const [running, setRunning] = useState<{ verb: string; done: number; total: number } | null>(null)

  const actions: Action[] = [
    ...(usbKindle
      ? [
          {
            key: 'usb',
            label: (n: number) => `Copy ${n} to Kindle (USB)`,
            verb: 'Copying',
            eligible: (b: Book) => !onKindle.has(b.id) && has(b, 'azw3', 'mobi', 'azw', 'pdf', 'epub'),
            run: (b: Book) => window.api.copyToKindle(b.id, usbKindle.root)
          }
        ]
      : []),
    {
      key: 'azw3',
      label: (n) => `Convert ${n} to AZW3 (for Kindle)`,
      verb: 'Converting',
      eligible: (b) => has(b, 'epub') && !has(b, 'azw3'),
      run: (b) => window.api.convertToAzw3(b.id)
    },
    {
      key: 'epub',
      label: (n) => `Convert ${n} to EPUB`,
      verb: 'Converting',
      eligible: (b) => has(b, 'mobi', 'azw3', 'azw') && !has(b, 'epub'),
      run: (b) => window.api.convertToEpub(b.id)
    }
  ]

  const run = async (action: Action) => {
    const targets = books.filter(action.eligible)
    const failures: string[] = []
    setRunning({ verb: action.verb, done: 0, total: targets.length })
    for (const [i, book] of targets.entries()) {
      const result = await action.run(book)
      if (!result.ok) failures.push(`${book.title}: ${result.message}`)
      setRunning({ verb: action.verb, done: i + 1, total: targets.length })
    }
    setRunning(null)
    failures.forEach((f) => console.error(f))
    const ok = targets.length - failures.length
    onResult({
      ok: failures.length === 0,
      message: failures.length
        ? `${ok} done, ${failures.length} failed. First problem: ${failures[0]}`
        : `${action.verb === 'Copying' ? 'Copied' : 'Converted'} ${ok} book${ok === 1 ? '' : 's'}`
    })
    onChanged()
    if (action.key === 'usb') onCopiedToKindle()
  }

  return (
    <aside className="details bulk">
      <button className="close" onClick={onClear} aria-label="Clear selection">
        ×
      </button>
      <div className="cover-stack">
        {books.slice(0, 3).map((b) => (
          <Cover key={b.id} book={b} />
        ))}
      </div>
      <h2>{books.length} books selected</h2>
      <p className="details-author">Ctrl-click to add or remove books, Shift-click to select a range.</p>

      {running ? (
        <div className="bulk-progress">
          <p>
            {running.verb} {Math.min(running.done + 1, running.total)} of {running.total}…
          </p>
          <div className="progress">
            <div style={{ width: `${(100 * running.done) / Math.max(1, running.total)}%` }} />
          </div>
        </div>
      ) : (
        <div className="details-primary">
          {actions.map((action, i) => {
            const n = books.filter(action.eligible).length
            return (
              <button key={action.key} className={i === 0 ? 'primary' : undefined} disabled={n === 0} onClick={() => run(action)}>
                {action.label(n)}
              </button>
            )
          })}
          <button onClick={onClear}>Clear selection</button>
        </div>
      )}

      <ul className="bulk-list">
        {books.map((b) => (
          <li key={b.id}>
            <span>{b.title}</span>
            <span className="muted">{b.formats.map((f) => f.format.toUpperCase()).join(' · ')}</span>
          </li>
        ))}
      </ul>
    </aside>
  )
}
