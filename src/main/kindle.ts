import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import nodemailer from 'nodemailer'
import type { ActionResult, KindleSettingsInput } from '../shared/types'
import type { Library } from './library'
import type { SettingsStore } from './settings'

// Amazon's limit for Send to Kindle by email.
const MAX_EMAIL_BYTES = 50 * 1024 * 1024
const KINDLE_DOMAIN = /@(free\.)?kindle\.(com|cn)$/i
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

function transport(settings: KindleSettingsInput, password: string | undefined) {
  return nodemailer.createTransport({
    host: settings.smtpHost,
    port: Number(settings.smtpPort),
    secure: settings.smtpSecure,
    auth: settings.smtpUser ? { user: settings.smtpUser, pass: password ?? '' } : undefined,
    connectionTimeout: 15_000
  })
}

function missingSettings(s: KindleSettingsInput, password: string | undefined): string | null {
  if (!s.smtpHost) return 'Set an SMTP server in Kindle settings first'
  if (s.smtpUser && !password) return 'Enter your SMTP password in Kindle settings'
  if (!s.fromAddress) return 'Set the "From" address (it must be on your Amazon approved senders list)'
  return null
}

export async function testSmtp(store: SettingsStore, input: KindleSettingsInput): Promise<ActionResult> {
  const password = await store.password(input)
  const missing = missingSettings(input, password)
  if (missing) return { ok: false, message: missing }
  try {
    await transport(input, password).verify()
    return { ok: true, message: 'Connected to the mail server' }
  } catch (err) {
    return { ok: false, message: `Connection failed: ${errorMessage(err)}` }
  }
}

export async function sendToKindle(library: Library, store: SettingsStore, bookId: number): Promise<ActionResult> {
  const settings = store.get()
  const password = await store.password()
  const missing = missingSettings(settings, password)
  if (missing) return { ok: false, message: missing }
  if (!KINDLE_DOMAIN.test(settings.kindleEmail)) return { ok: false, message: 'Set your @kindle.com address in Kindle settings' }

  const book = library.db.getBook(bookId)
  if (!book) return { ok: false, message: 'Book not found' }

  let file: string
  try {
    const epub = book.formats.find((f) => f.format === 'epub')
    const pdf = book.formats.find((f) => f.format === 'pdf')
    if (epub) file = library.absPath(epub.path)
    else if (book.formats.some((f) => ['mobi', 'azw3', 'azw'].includes(f.format))) file = await library.convertToEpub(bookId)
    else if (pdf) file = library.absPath(pdf.path)
    else return { ok: false, message: 'This book has no format Send to Kindle accepts' }
  } catch (err) {
    return { ok: false, message: `Conversion failed: ${errorMessage(err)}` }
  }

  const { size } = await stat(file)
  if (size > MAX_EMAIL_BYTES) return { ok: false, message: 'The file is larger than the 50 MB Send to Kindle limit' }

  const author = book.authors[0] ?? 'Unknown'
  const filename = `${book.title} - ${author}${extname(file)}`.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  try {
    await transport(settings, password).sendMail({
      from: settings.fromAddress,
      to: settings.kindleEmail,
      subject: book.title,
      text: `"${book.title}" by ${book.authors.join(', ')}, sent from Shelfie.`,
      attachments: [{ filename, path: file }]
    })
    return { ok: true, message: `Sent “${book.title}” to ${settings.kindleEmail}. It should appear on your Kindle in a few minutes.` }
  } catch (err) {
    return { ok: false, message: `Sending failed: ${errorMessage(err)}` }
  }
}
