import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { KindleSettings, KindleSettingsInput } from '../shared/types'

interface StoredSettings extends Omit<KindleSettings, 'hasPassword'> {
  passwordEncrypted?: string
}

const DEFAULTS: StoredSettings = {
  kindleEmail: '',
  fromAddress: '',
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: ''
}

export class SettingsStore {
  constructor(private file: string) {}

  private read(): StoredSettings {
    if (!existsSync(this.file)) return { ...DEFAULTS }
    try {
      return { ...DEFAULTS, ...JSON.parse(readFileSync(this.file, 'utf8')) }
    } catch {
      return { ...DEFAULTS }
    }
  }

  get(): KindleSettings {
    const { passwordEncrypted, ...rest } = this.read()
    return { ...rest, hasPassword: !!passwordEncrypted }
  }

  /** Stored password, or the one in `input` when given (used to test unsaved settings). */
  async password(input?: KindleSettingsInput): Promise<string | undefined> {
    if (input?.smtpPassword) return input.smtpPassword
    const enc = this.read().passwordEncrypted
    if (!enc) return undefined
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'))
    if (shouldReEncrypt) await this.storePassword(result)
    return result
  }

  private async storePassword(password: string): Promise<void> {
    const current = this.read()
    current.passwordEncrypted = (await safeStorage.encryptStringAsync(password)).toString('base64')
    writeFileSync(this.file, JSON.stringify(current, null, 2))
  }

  async save(input: KindleSettingsInput): Promise<KindleSettings> {
    const current = this.read()
    const { smtpPassword, ...fields } = input
    const next: StoredSettings = {
      ...current,
      kindleEmail: fields.kindleEmail.trim(),
      fromAddress: fields.fromAddress.trim(),
      smtpHost: fields.smtpHost.trim(),
      smtpPort: Number(fields.smtpPort) || 465,
      smtpSecure: !!fields.smtpSecure,
      smtpUser: fields.smtpUser.trim()
    }
    if (smtpPassword && !(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('Secure password storage is not available on this system')
    }
    writeFileSync(this.file, JSON.stringify(next, null, 2))
    if (smtpPassword) await this.storePassword(smtpPassword)
    return this.get()
  }
}
