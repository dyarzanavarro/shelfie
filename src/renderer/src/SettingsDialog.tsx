import { useEffect, useState, type FormEvent } from 'react'
import type { ActionResult, KindleSettings, KindleSettingsInput } from '../../shared/types'

interface Props {
  onClose: () => void
  onSaved: (settings: KindleSettings) => void
}

const PRESETS: Record<string, Pick<KindleSettingsInput, 'smtpHost' | 'smtpPort' | 'smtpSecure'>> = {
  Gmail: { smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
  'iCloud Mail': { smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: false },
  'Yahoo Mail': { smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpSecure: true }
}

export function SettingsDialog({ onClose, onSaved }: Props) {
  const [form, setForm] = useState<KindleSettingsInput | null>(null)
  const [hasPassword, setHasPassword] = useState(false)
  const [status, setStatus] = useState<ActionResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.api.getSettings().then(({ hasPassword, ...rest }) => {
      setForm(rest)
      setHasPassword(hasPassword)
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!form) return null

  const set = <K extends keyof KindleSettingsInput>(key: K, value: KindleSettingsInput[K]) => {
    setForm({ ...form, [key]: value })
    setStatus(null)
  }

  const applyPreset = (name: string) => {
    const preset = PRESETS[name]
    if (preset) setForm({ ...form, ...preset })
  }

  const test = async () => {
    setBusy(true)
    setStatus(await window.api.testSmtp(form))
    setBusy(false)
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      onSaved(await window.api.saveSettings(form))
      onClose()
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : String(err) })
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onSubmit={save} onMouseDown={(e) => e.stopPropagation()}>
        <h2>Send to Kindle</h2>
        <p className="hint">
          Books are emailed to your Kindle address. In your Amazon account, open <b>Manage Your Content and Devices →
          Preferences → Personal Document Settings</b> to find your Kindle email and add the “From” address below to
          the approved senders list.
        </p>

        <label>
          Kindle email
          <input
            type="email"
            required
            placeholder="name_abc123@kindle.com"
            value={form.kindleEmail}
            onChange={(e) => set('kindleEmail', e.target.value)}
          />
        </label>
        <label>
          From address (approved sender)
          <input
            type="email"
            required
            placeholder="you@gmail.com"
            value={form.fromAddress}
            onChange={(e) => {
              const fromAddress = e.target.value
              setForm({ ...form, fromAddress, smtpUser: form.smtpUser === form.fromAddress ? fromAddress : form.smtpUser })
              setStatus(null)
            }}
          />
        </label>

        <fieldset>
          <legend>
            Outgoing mail (SMTP)
            <select defaultValue="" onChange={(e) => applyPreset(e.target.value)} aria-label="Mail provider preset">
              <option value="" disabled>
                Preset…
              </option>
              {Object.keys(PRESETS).map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </legend>
          <div className="row">
            <label className="grow">
              Server
              <input required value={form.smtpHost} onChange={(e) => set('smtpHost', e.target.value)} />
            </label>
            <label className="narrow">
              Port
              <input
                type="number"
                required
                value={form.smtpPort}
                onChange={(e) => {
                  const port = Number(e.target.value)
                  setForm({ ...form, smtpPort: port, smtpSecure: port === 465 ? true : port === 587 ? false : form.smtpSecure })
                }}
              />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={form.smtpSecure} onChange={(e) => set('smtpSecure', e.target.checked)} />
            Use TLS from the start (port 465); untick for STARTTLS (port 587)
          </label>
          <label>
            Username
            <input value={form.smtpUser} onChange={(e) => set('smtpUser', e.target.value)} />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="off"
              placeholder={hasPassword ? '•••••••• (saved — leave blank to keep)' : ''}
              value={form.smtpPassword ?? ''}
              onChange={(e) => set('smtpPassword', e.target.value || undefined)}
            />
          </label>
          {form.smtpHost.includes('gmail') && (
            <p className="hint">Gmail needs an App Password (Google Account → Security → 2-Step Verification → App passwords).</p>
          )}
        </fieldset>

        {status && <p className={status.ok ? 'status ok' : 'status error'}>{status.message}</p>}

        <div className="modal-actions">
          <button type="button" onClick={test} disabled={busy}>
            Test connection
          </button>
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
