import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePlatforms } from './config.ts'
import { GamerSessionManager } from './session-manager.ts'

function json(body: unknown, status = 200) {
  return Response.json(body, { status })
}

async function withFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>,
) {
  const previous = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch
  try { await run() } finally { globalThis.fetch = previous }
}

test('every session starts without a platform and selection creates a fresh bound client', async () => {
  const changes: string[] = []
  const manager = new GamerSessionManager(resolvePlatforms({}), {
    onClientChanged: (_id, previous, next) => changes.push(`${previous?.platformUrl ?? 'none'} -> ${next?.platformUrl ?? 'none'}`),
  })
  const fresh = manager.ensure('s1')
  assert.equal(fresh.platform, undefined)
  assert.equal(fresh.client, undefined)
  const selected = await manager.selectPlatform('s1', 'local')
  assert.equal(selected.ok, true)
  assert.equal(selected.state.client?.platformUrl, 'http://127.0.0.1:8787')
  assert.deepEqual(changes, ['none -> http://127.0.0.1:8787'])
})

test('failed logout aborts a platform switch and preserves token and match state', { concurrency: false }, async () => {
  await withFetch(() => json({ error: 'offline' }, 503), async () => {
    const manager = new GamerSessionManager(resolvePlatforms({}))
    const state = (await manager.selectPlatform('s1', 'community')).state
    state.client!.token = 'community-token'
    state.client!.ticket = 'match-ticket'
    state.client!.roomId = 'room-one'
    const switched = await manager.selectPlatform('s1', 'local')
    assert.equal(switched.ok, false)
    assert.equal(state.platform?.id, 'community')
    assert.equal(state.client?.token, 'community-token')
    assert.equal(state.client?.ticket, 'match-ticket')
    assert.equal(state.client?.roomId, 'room-one')
  })
})

test('successful switch logs out on the old origin and never carries its token to the target', { concurrency: false }, async () => {
  const calls: Array<{ url: string; authorization: string | null }> = []
  await withFetch((_url, init) => {
    const url = String(_url)
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') })
    return json({ ok: true, cleanup: { room: 'none', game: 'none' } })
  }, async () => {
    const manager = new GamerSessionManager(resolvePlatforms({}))
    const state = (await manager.selectPlatform('s1', 'community')).state
    state.client!.token = 'community-token'
    const switched = await manager.selectPlatform('s1', 'local')
    assert.equal(switched.ok, true)
    assert.equal(switched.state.client?.platformUrl, 'http://127.0.0.1:8787')
    assert.equal(switched.state.client?.token, undefined)
    assert.deepEqual(calls, [{
      url: 'https://arena.amphilagus.com/v1/auth/logout',
      authorization: 'Bearer community-token',
    }])
  })
})

test('prepareLogin is idempotent for the active saved account and logs out for another account', { concurrency: false }, async () => {
  let logoutCalls = 0
  const changes: Array<{ previous: unknown; next: unknown }> = []
  await withFetch(() => {
    logoutCalls++
    return json({ ok: true, cleanup: { room: 'none', game: 'none' } })
  }, async () => {
    const manager = new GamerSessionManager(resolvePlatforms({}), {
      onClientChanged: (_id, previous, next) => changes.push({ previous, next }),
    })
    const state = (await manager.selectPlatform('s1', 'community')).state
    const firstClient = state.client
    state.client!.token = 'token'
    state.client!.ticket = 'old-ticket'
    state.client!.roomId = 'old-room'
    manager.markAccount(state, { accountId: 'community/alice', username: 'Alice' })
    const same = await manager.prepareLogin('s1', 'community', 'community/alice')
    assert.equal(same.ok && same.alreadyCurrent, true)
    assert.equal(logoutCalls, 0)
    assert.equal(state.client, firstClient)
    const other = await manager.prepareLogin('s1', 'community', 'community/bob')
    assert.equal(other.ok, true)
    assert.equal(logoutCalls, 1)
    assert.notEqual(state.client, firstClient)
    assert.equal(state.client?.token, undefined)
    assert.equal(state.client?.ticket, undefined)
    assert.equal(state.client?.roomId, undefined)
    assert.equal(state.account, undefined)
    assert.equal(changes.length, 2)
    assert.equal(changes[1].previous, firstClient)
    assert.equal(changes[1].next, state.client)
  })
})

test('prepareLogin creates a fresh client even when the saved platform is already selected but logged out', async () => {
  const manager = new GamerSessionManager(resolvePlatforms({}))
  const state = (await manager.selectPlatform('s1', 'local')).state
  const firstClient = state.client
  firstClient!.roomId = 'stale-room'
  const prepared = await manager.prepareLogin('s1', 'local', 'local/alice')
  assert.equal(prepared.ok, true)
  assert.notEqual(state.client, firstClient)
  assert.equal(state.client?.roomId, undefined)
})
