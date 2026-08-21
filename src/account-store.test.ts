import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SavedAccountError,
  SavedAccountStore,
  passwordCredentialRef,
  savedAccountId,
  validateSavedAccountSettings,
  type AccountCredentialStore,
  type AccountSettingsScope,
  type SavedAccountSettings,
} from './account-store.ts'

class MemorySettings implements AccountSettingsScope {
  value: SavedAccountSettings = { accounts: {} }
  failNext = false
  get() { return this.value }
  async mutate(ops: readonly import('./account-store.ts').AccountSettingsPathOp[]) {
    if (this.failNext) {
      this.failNext = false
      throw new Error('settings unavailable')
    }
    for (const op of ops) {
      const accountId = op.path[1]
      if (!accountId) throw new Error('invalid account path')
      if (op.op === 'set') this.value.accounts[accountId] = structuredClone(op.value) as never
      else delete this.value.accounts[accountId]
    }
  }
}

class MemoryCredentials implements AccountCredentialStore {
  values = new Map<string, string>()
  failNextSet = false
  failNextUnset = false
  async resolve(ref: string) {
    const value = this.values.get(ref)
    return value === undefined ? undefined : { value, source: 'memory' }
  }
  async describe(ref: string) {
    return { configured: this.values.has(ref), source: 'memory', writable: true }
  }
  async set(ref: string, value: string) {
    if (this.failNextSet) {
      this.failNextSet = false
      throw new Error('credential set unavailable')
    }
    this.values.set(ref, value)
  }
  async unset(ref: string) {
    if (this.failNextUnset) {
      this.failNextUnset = false
      throw new Error('credential unset unavailable')
    }
    this.values.delete(ref)
  }
}

test('saved account ids and credential refs are stable, normalized, and platform-scoped', () => {
  assert.equal(savedAccountId('community', 'Alice'), 'community/alice')
  assert.equal(passwordCredentialRef('community', 'Alice'), passwordCredentialRef('community', 'alice'))
  assert.notEqual(passwordCredentialRef('community', 'alice'), passwordCredentialRef('local', 'alice'))
})

test('save persists only metadata in settings and list never exposes password or credential ref', async () => {
  const settings = new MemorySettings()
  const credentials = new MemoryCredentials()
  const store = new SavedAccountStore(settings, credentials, () => '2026-08-21T00:00:00.000Z')
  const account = await store.save('community', 'Alice', 'super-secret')
  validateSavedAccountSettings(settings.value)
  assert.equal(account.accountId, 'community/alice')
  assert.equal(credentials.values.get(account.credentialRef), 'super-secret')
  assert.doesNotMatch(JSON.stringify(settings.value), /super-secret/)
  const listed = await store.list()
  assert.deepEqual(listed, [{
    accountId: 'community/alice',
    platformId: 'community',
    username: 'Alice',
    credentialConfigured: true,
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  }])
  assert.doesNotMatch(JSON.stringify(listed), /super-secret|credentialRef/)
  assert.equal((await store.resolve('community/alice')).password, 'super-secret')
})

test('same username on different platforms produces independent saved accounts', async () => {
  const settings = new MemorySettings()
  const credentials = new MemoryCredentials()
  const store = new SavedAccountStore(settings, credentials)
  await store.save('community', 'Alice', 'community-password')
  await store.save('local', 'Alice', 'local-password')
  assert.deepEqual((await store.list()).map((row) => row.accountId), ['community/alice', 'local/alice'])
  assert.equal((await store.resolve('local/alice')).password, 'local-password')
})

test('settings failures compensate credential save and forget', async () => {
  const settings = new MemorySettings()
  const credentials = new MemoryCredentials()
  const store = new SavedAccountStore(settings, credentials)
  await store.save('community', 'Alice', 'old-password')
  const ref = passwordCredentialRef('community', 'Alice')

  settings.failNext = true
  await assert.rejects(store.save('community', 'Alice', 'new-password'), /settings unavailable/)
  assert.equal(credentials.values.get(ref), 'old-password')

  settings.failNext = true
  await assert.rejects(store.forget('community/alice'), /settings unavailable/)
  assert.equal(credentials.values.get(ref), 'old-password')
  assert.equal(Object.keys(settings.value.accounts).length, 1)

  assert.equal(await store.forget('community/alice'), true)
  assert.equal(await store.forget('community/alice'), false)
  assert.equal(credentials.values.has(ref), false)
})

test('credential write failures leave account metadata unchanged', async () => {
  const settings = new MemorySettings()
  const credentials = new MemoryCredentials()
  const store = new SavedAccountStore(settings, credentials)

  credentials.failNextSet = true
  await assert.rejects(store.save('community', 'Alice', 'secret'), /credential set unavailable/)
  assert.deepEqual(settings.value, { accounts: {} })

  await store.save('community', 'Alice', 'secret')
  const before = structuredClone(settings.value)
  credentials.failNextUnset = true
  await assert.rejects(store.forget('community/alice'), /credential unset unavailable/)
  assert.deepEqual(settings.value, before)
})

test('missing account and missing credential have stable safe error codes', async () => {
  const settings = new MemorySettings()
  const credentials = new MemoryCredentials()
  const store = new SavedAccountStore(settings, credentials)
  await assert.rejects(store.resolve('community/missing'), (error: unknown) => (
    error instanceof SavedAccountError && error.code === 'saved_account_not_found'
  ))
  await store.save('community', 'Alice', 'secret')
  credentials.values.clear()
  await assert.rejects(store.resolve('community/alice'), (error: unknown) => (
    error instanceof SavedAccountError && error.code === 'saved_credential_missing'
  ))
})
