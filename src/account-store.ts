import { createHash } from 'node:crypto'

export interface SavedAccount {
  accountId: string
  platformId: string
  username: string
  credentialRef: string
  createdAt: string
  updatedAt: string
}

export interface SavedAccountSettings {
  accounts: Record<string, SavedAccount>
}

export interface PublicSavedAccount {
  accountId: string
  platformId: string
  username: string
  credentialConfigured: boolean
  createdAt: string
  updatedAt: string
}

export interface AccountSettingsScope {
  get(): SavedAccountSettings
  mutate(ops: readonly AccountSettingsPathOp[]): Promise<void>
}

export type AccountSettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

export interface AccountCredentialStore {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

export function savedAccountId(platformId: string, username: string): string {
  return `${platformId}/${username.toLowerCase()}`
}

export function passwordCredentialRef(platformId: string, username: string): string {
  const digest = createHash('sha256')
    .update(platformId)
    .update('\0')
    .update(username.toLowerCase())
    .digest('hex')
    .toUpperCase()
  return `DSH_GAMER_PASSWORD_${digest}`
}

export function validateSavedAccountSettings(settings: SavedAccountSettings): void {
  for (const [key, row] of Object.entries(settings.accounts)) {
    if (key !== row.accountId) throw new TypeError(`saved account key "${key}" does not match accountId "${row.accountId}"`)
    if (row.accountId !== savedAccountId(row.platformId, row.username)) {
      throw new TypeError(`saved account id "${row.accountId}" does not match its platform and username`)
    }
    if (row.credentialRef !== passwordCredentialRef(row.platformId, row.username)) {
      throw new TypeError(`saved account "${row.accountId}" has an invalid credential reference`)
    }
  }
}

export class SavedAccountError extends Error {
  readonly code: 'saved_account_not_found' | 'saved_credential_missing'

  constructor(code: 'saved_account_not_found' | 'saved_credential_missing', message: string) {
    super(message)
    this.code = code
  }
}

export class SavedAccountStore {
  private readonly scope: AccountSettingsScope
  private readonly credentials: AccountCredentialStore
  private readonly now: () => string

  constructor(
    scope: AccountSettingsScope,
    credentials: AccountCredentialStore,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.scope = scope
    this.credentials = credentials
    this.now = now
  }

  private snapshot(): SavedAccount[] {
    return Object.values(this.scope.get().accounts).map((row) => ({ ...row }))
  }

  async list(): Promise<PublicSavedAccount[]> {
    const rows = this.snapshot().sort((a, b) => a.accountId.localeCompare(b.accountId))
    return Promise.all(rows.map(async ({ credentialRef: ref, ...row }) => ({
      ...row,
      credentialConfigured: (await this.credentials.describe(ref)).configured,
    })))
  }

  async resolve(accountId: string): Promise<{ account: SavedAccount; password: string }> {
    const account = this.snapshot().find((row) => row.accountId === accountId)
    if (!account) throw new SavedAccountError('saved_account_not_found', `Saved account "${accountId}" was not found.`)
    const hit = await this.credentials.resolve(account.credentialRef)
    if (!hit) {
      throw new SavedAccountError(
        'saved_credential_missing',
        `Saved account "${accountId}" has no configured password. Log in again with remember=true.`,
      )
    }
    return { account, password: hit.value }
  }

  async save(platformId: string, username: string, password: string): Promise<SavedAccount> {
    const accountId = savedAccountId(platformId, username)
    const ref = passwordCredentialRef(platformId, username)
    const before = this.snapshot()
    const existing = before.find((row) => row.accountId === accountId)
    const oldSecret = await this.credentials.resolve(ref)
    const timestamp = this.now()
    const account: SavedAccount = {
      accountId,
      platformId,
      username,
      credentialRef: ref,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }
    await this.credentials.set(ref, password)
    try {
      await this.scope.mutate([{ op: 'set', path: ['accounts', accountId], value: account }])
    } catch (error) {
      try {
        if (oldSecret) await this.credentials.set(ref, oldSecret.value)
        else await this.credentials.unset(ref)
      } catch { /* keep the original settings failure */ }
      throw error
    }
    return account
  }

  async forget(accountId: string): Promise<boolean> {
    const before = this.snapshot()
    const account = before.find((row) => row.accountId === accountId)
    if (!account) return false
    const oldSecret = await this.credentials.resolve(account.credentialRef)
    await this.credentials.unset(account.credentialRef)
    try {
      await this.scope.mutate([{ op: 'unset', path: ['accounts', accountId] }])
    } catch (error) {
      try {
        if (oldSecret) await this.credentials.set(account.credentialRef, oldSecret.value)
      } catch { /* keep the original settings failure */ }
      throw error
    }
    return true
  }
}
