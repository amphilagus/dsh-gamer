import assert from 'node:assert/strict'
import test from 'node:test'
import { GamingClient } from './client.ts'
import { connectEntrySession, readRoomSnapshot, synchronizeLiveRoomSession } from './entry-session.ts'
import { discoverResumableMatches } from './recovery.ts'
import { leaveCurrentMatchThroughPlatform } from './match-departure.ts'

function json(body: unknown, status = 200) {
  return Response.json(body, { status })
}

function withFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
  run: () => Promise<void>,
) {
  const previous = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch
  return run().finally(() => { globalThis.fetch = previous })
}

const resumable = {
  matchId: 'mt_1',
  gameSlug: 'xuezhan',
  roomId: 'rm_1',
  seat: '1',
  status: 'bot_controlled' as const,
  departureId: 'dep_1',
  spectatorUrl: 'https://game.example/spectate/mt_1',
}

const joinResponse = {
  room: { roomId: 'rm_1', gameSlug: 'xuezhan', status: 'playing' },
  matchId: 'mt_1',
  seat: '1',
  ticket: 'new-secret-ticket',
  gameBaseUrl: 'https://game.example',
  spectatorUrl: 'https://game.example/spectate/mt_1',
  resumeDepartureId: 'dep_1',
}

test('login recovery discovery only reports original tables and never changes control', { concurrency: false }, async () => {
  const calls: string[] = []
  await withFetch((url) => {
    calls.push(url)
    return json({ matches: [resumable] })
  }, async () => {
    const client = new GamingClient('https://platform.example')
    client.token = 'player-token'
    const result = await discoverResumableMatches(client)
    assert.equal(result.status, 'recovery_available')
    assert.equal(result.matches[0].roomId, 'rm_1')
    assert.equal('spectatorUrl' in result.matches[0], false)
    assert.deepEqual(calls, ['https://platform.example/v1/session/resumable-matches'])
    assert.equal(client.ticket, undefined)
  })
})

test('join response is saved before the game session call and no platform confirmation follows', { concurrency: false }, async () => {
  const calls: string[] = []
  await withFetch((url) => {
    calls.push(url)
    if (url.endsWith('/v1/session')) return json({ matchId: 'mt_1', status: 'playing', seat: '1', role: 'east' })
    return json({}, 404)
  }, async () => {
    const client = new GamingClient('https://platform.example')
    client.token = 'player-token'
    const result = await connectEntrySession(client, joinResponse)
    assert.equal(client.ticket, 'new-secret-ticket')
    assert.equal(client.matchId, 'mt_1')
    assert.deepEqual(calls, ['https://game.example/v1/session'])
    assert.doesNotMatch(JSON.stringify(result), /new-secret-ticket|"ticket"/)
  })
})

test('game session failure preserves the entry context and is explicitly retryable', { concurrency: false }, async () => {
  await withFetch(() => json({ error: { code: 'offline' }, ticket: 'echoed-ticket' }, 503), async () => {
    const client = new GamingClient('https://platform.example')
    client.token = 'player-token'
    const result = await connectEntrySession(client, joinResponse) as {
      ok: boolean
      error: string
      retryable: boolean
      diagnostic: unknown
    }
    assert.equal(result.ok, false)
    assert.equal(result.error, 'game_session_failed')
    assert.equal(result.retryable, true)
    assert.equal(client.ticket, 'new-secret-ticket')
    assert.equal(client.roomId, 'rm_1')
    assert.doesNotMatch(JSON.stringify(result), /new-secret-ticket|echoed-ticket|"ticket"/)
  })
})

test('background room synchronization reads nested matchId and connects a fresh player ticket', { concurrency: false }, async () => {
  const calls: Array<{ url: string; authorization: string | null; body?: string }> = []
  await withFetch((url, init) => {
    calls.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    if (url === 'https://platform.example/v1/matches/mt_new') {
      return json({
        matchId: 'mt_new',
        roomId: 'rm_1',
        gameSlug: 'xuezhan',
        status: 'playing',
        seat: '1',
        role: 'east',
        ticket: 'fresh-ticket',
        gameBaseUrl: 'https://game-new.example',
      })
    }
    if (url === 'https://game-new.example/v1/session') {
      return json({ matchId: 'mt_new', status: 'playing', seat: '1', role: 'east' })
    }
    return json({}, 404)
  }, async () => {
    const client = new GamingClient('https://platform.example')
    client.token = 'player-token'
    client.rememberMatch({
      matchId: 'mt_old',
      roomId: 'rm_1',
      gameSlug: 'xuezhan',
      ticket: 'old-ticket',
      gameBaseUrl: 'https://game-old.example',
    })
    const room = { room: { roomId: 'rm_1', gameSlug: 'xuezhan', status: 'playing', matchId: 'mt_new' } }
    assert.deepEqual(readRoomSnapshot(room), {
      roomId: 'rm_1',
      gameSlug: 'xuezhan',
      matchId: 'mt_new',
    })
    assert.deepEqual(await synchronizeLiveRoomSession(client, room), {
      liveMatchId: 'mt_new',
      connected: true,
    })
    assert.equal(client.matchId, 'mt_new')
    assert.equal(client.ticket, 'fresh-ticket')
    assert.equal(client.gameBaseUrl, 'https://game-new.example')
    assert.deepEqual(calls, [
      {
        url: 'https://platform.example/v1/matches/mt_new',
        authorization: 'Bearer player-token',
        body: undefined,
      },
      {
        url: 'https://game-new.example/v1/session',
        authorization: 'Bearer fresh-ticket',
        body: JSON.stringify({ ticket: 'fresh-ticket' }),
      },
    ])
  })
})

test('failed background game connection clears transport and retries on the next probe', { concurrency: false }, async () => {
  let gameAttempts = 0
  let matchReads = 0
  await withFetch((url) => {
    if (url === 'https://platform.example/v1/matches/mt_new') {
      matchReads++
      return json({
        matchId: 'mt_new',
        roomId: 'rm_1',
        gameSlug: 'xuezhan',
        ticket: 'fresh-ticket',
        gameBaseUrl: 'https://game.example',
      })
    }
    gameAttempts++
    return gameAttempts === 1
      ? json({ error: { code: 'offline' } }, 503)
      : json({ matchId: 'mt_new', status: 'playing' })
  }, async () => {
    const client = new GamingClient('https://platform.example')
    client.token = 'player-token'
    client.roomId = 'rm_1'
    const room = { room: { roomId: 'rm_1', gameSlug: 'xuezhan', matchId: 'mt_new' } }

    assert.deepEqual(await synchronizeLiveRoomSession(client, room), {
      liveMatchId: 'mt_new',
      connected: false,
    })
    assert.equal(client.matchId, 'mt_new')
    assert.equal(client.ticket, undefined)
    assert.equal(client.gameBaseUrl, undefined)

    assert.deepEqual(await synchronizeLiveRoomSession(client, room), {
      liveMatchId: 'mt_new',
      connected: true,
    })
    assert.equal(matchReads, 2)
    assert.equal(gameAttempts, 2)
  })
})

test('empty recovery discovery is a normal one-shot result', { concurrency: false }, async () => {
  await withFetch(() => json({ matches: [] }), async () => {
    const client = new GamingClient('https://platform.example')
    client.token = 'player-token'
    assert.deepEqual(await discoverResumableMatches(client), { status: 'none', matches: [] })
  })
})

test('explicit play leave uses the platform room departure and clears the old game ticket', { concurrency: false }, async () => {
  const calls: Array<{ url: string; authorization: string | null }> = []
  await withFetch((url, init) => {
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') })
    return json({ ok: true, room: { roomId: 'rm_1', status: 'playing' }, game: 'queued' })
  }, async () => {
    const client = new GamingClient('https://platform.example')
    client.token = 'player-token'
    client.rememberMatch({ ...joinResponse, roomId: 'rm_1' })
    await leaveCurrentMatchThroughPlatform(client)
    assert.deepEqual(calls, [{
      url: 'https://platform.example/v1/rooms/rm_1/leave',
      authorization: 'Bearer player-token',
    }])
    assert.equal(client.ticket, undefined)
    assert.equal(client.roomId, undefined)
    assert.equal(client.matchId, undefined)
  })
})
