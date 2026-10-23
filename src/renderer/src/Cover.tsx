import { useState } from 'react'
import type { Book } from '../../shared/types'

const HUES = [210, 340, 160, 30, 270, 0, 190, 120]

export function Cover({ book, large = false }: { book: Book; large?: boolean }) {
  const [failed, setFailed] = useState(false)
  const className = large ? 'cover large' : 'cover'

  if (book.hasCover && !failed) {
    return (
      <img
        className={className}
        src={`cover://book/${book.id}?v=${encodeURIComponent(book.addedAt)}`}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    )
  }

  const hue = HUES[book.id % HUES.length]
  return (
    <div className={`${className} placeholder`} style={{ background: `hsl(${hue} 35% 28%)` }}>
      <span className="ph-title">{book.title}</span>
      <span className="ph-author">{book.authors[0]}</span>
    </div>
  )
}
