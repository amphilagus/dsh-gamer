import assert from 'node:assert/strict'
import test from 'node:test'
import { GamingClient } from './client.ts'
import { logoutCurrentSession } from './logout.ts'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function withFetch(
  impl: typeof fetch,
  run: () => Promise<void>,
) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

function activeClient() {
  const client = new GamingClient('https://platform.example')
  client.token = 'player-token'
  client.ticket = 'match-ticket'
  client.gameBaseUrl = 'https://game.example'
  client.spectatorUrl = 'https://game.example/spectate/m1'
  client.matchId = 'm1'
  client.seat = '1'
  client.role = 'black'
  client.gameSlug = 'gomoku'
  client.roomId = 'room/1'
  return client
}

test('logout leaves the game and room before revoking and clearing the session', async () => {
  const calls: Array<{ url: string; method: string }> = []
  await withFetch(async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' })
    return jsonResponse({ ok: true })
  }, async () => {
    const client = activeClient()
    const result = await logoutCurrentSession(client)
    assert.equal(result.ok, true)
    assert.equal(result.loggedOut, true)
    assert.deepEqual(result.cleanup, {
      game: { status: 'left' },
      room: { status: 'left' },
    })
    assert.doesNotMatch(JSON.stringify(result), /player-token|match-ticket/)
    assert.deepEqual(calls, [
      { url: 'https://game.example/v1/leave', method: 'POST' },
      { url: 'https://platform.example/v1/rooms/room%2F1/leave', method: 'POST' },
      { url: 'https://platform.example/v1/auth/logout', method: 'POST' },
    ])
    assert.equal(client.platformUrl, 'https://platform.example')
    for (const value of [
      client.token,
      client.ticket,
      client.gameBaseUrl,
      client.spectatorUrl,
      client.matchId,
      client.seat,
      client.role,
      client.gameSlug,
      client.roomId,
    ]) assert.equal(value, undefined)
  })
})

test('cleanup failures are reported but do not prevent token revocation', async () => {
  const calls: string[] = []
  await withFetch(async (input) => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith('https://game.example/')) return jsonResponse({ error: { code: 'game_down' } }, 503)
    if (url.includes('/v1/rooms/')) return jsonResponse({ error: { code: 'room_down' } }, 503)
    return jsonResponse({ ok: true })
  }, async () => {
    const client = activeClient()
    const result = await logoutCurrentSession(client)
    assert.equal(result.ok, true)
    assert.equal(result.loggedOut, true)
    assert.equal(result.cleanup.game.status, 'failed')
    assert.equal(result.cleanup.room.status, 'failed')
    assert.equal(calls.at(-1), 'https://platform.example/v1/auth/logout')
    assert.equal(client.token, undefined)
    assert.equal(client.roomId, undefined)
  })
})

test('an older platform fails explicitly and keeps the local token', async () => {
  await withFetch(async () => jsonResponse({ error: { code: 'not_found' } }, 404), async () => {
    const client = new GamingClient('https://platform.example')
    client.token = 'player-token'
    const result = await logoutCurrentSession(client)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'logout_unsupported')
    assert.equal(client.token, 'player-token')
  })
})

test('a platform server failure keeps the local token for retry', async () => {
  await withFetch(async () => jsonResponse({ error: { code: 'unavailable' } }, 503), async () => {
    const client = new GamingClient('https://platform.example')
    client.token = 'player-token'
    const result = await logoutCurrentSession(client)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'logout_failed')
    assert.equal(client.token, 'player-token')
  })
})

test('an already invalid server token clears local state', async () => {
  await withFetch(async () => jsonResponse({ error: { code: 'unauthorized' } }, 401), async () => {
    const client = new GamingClient('https://platform.example')
    client.token = 'expired-token'
    client.roomId = 'stale-room'
    const result = await logoutCurrentSession(client)
    assert.equal(result.ok, true)
    assert.equal(result.serverSession, 'already_invalid')
    assert.equal(client.token, undefined)
    assert.equal(client.roomId, undefined)
  })
})

test('logout without a token is idempotent and does not call the network', async () => {
  let calls = 0
  await withFetch(async () => {
    calls += 1
    return jsonResponse({ ok: true })
  }, async () => {
    const client = new GamingClient('https://platform.example')
    client.roomId = 'stale-room'
    const result = await logoutCurrentSession(client)
    assert.equal(result.ok, true)
    assert.equal(result.loggedOut, false)
    assert.equal(result.alreadyLoggedOut, true)
    assert.equal(client.roomId, undefined)
    assert.equal(calls, 0)
  })
})
