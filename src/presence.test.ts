import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, GamingClient } from './client.ts'
import { PresenceConnection, reconnectBackoffMs } from './presence.ts'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function streamResponse(events: string) {
  return new Response(events, { headers: { 'content-type': 'text/event-stream' } })
}

async function withFetch(impl: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try { await run() } finally { globalThis.fetch = original }
}

const probes = [
  { leaseId: 'lease_one', sequence: 1, sentAt: '2026-01-01T00:00:00.000Z' },
  { leaseId: 'lease_one', sequence: 2, sentAt: '2026-01-01T00:00:02.000Z' },
]

test('SSE probes are processed single-flight and ACKed immediately in order', async () => {
  const calls: Array<{ url: string; headers: Headers; body?: string }> = []
  let running = 0
  let maxRunning = 0
  await withFetch(async (input, init) => {
    const url = String(input)
    calls.push({ url, headers: new Headers(init?.headers), body: init?.body ? String(init.body) : undefined })
    if (url.endsWith('/v1/presence/stream')) {
      return streamResponse(probes.map((probe) => `event: probe\ndata: ${JSON.stringify(probe)}\n\n`).join(''))
    }
    return jsonResponse({ ok: true })
  }, async () => {
    const client = new GamingClient('https://platform.example')
    client.token = 'player-token'
    const connection = new PresenceConnection(client, async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await Promise.resolve()
      running--
      return { agentStatus: 'idle', wakeFailures: 0 }
    })
    assert.equal(await connection.connectOnce(), 2)
    assert.equal(maxRunning, 1)
    assert.equal(calls[0].headers.get('accept'), 'text/event-stream')
    assert.equal(calls[0].headers.get('dsh-gaming-protocol'), '0.3')
    assert.deepEqual(calls.slice(1).map((call) => JSON.parse(String(call.body)).sequence), [1, 2])
    assert.ok(calls.slice(1).every((call) => call.url.endsWith('/v1/presence/ack')))
  })
})

test('accepted agent_unresponsive logout clears all local state', async () => {
  await withFetch(async (input) => {
    if (String(input).endsWith('/v1/presence/stream')) {
      return streamResponse(`event: probe\ndata: ${JSON.stringify(probes[0])}\n\n`)
    }
    return jsonResponse({ ok: true, logoutAccepted: true })
  }, async () => {
    const client = new GamingClient('https://platform.example')
    client.token = 'player-token'
    client.ticket = 'ticket'
    client.roomId = 'room'
    const connection = new PresenceConnection(client, async () => ({
      agentStatus: 'idle',
      wakeFailures: 5,
      logoutRequest: { reason: 'agent_unresponsive' },
    }))
    assert.equal(await connection.connectOnce(), 1)
    assert.equal(client.token, undefined)
    assert.equal(client.ticket, undefined)
    assert.equal(client.roomId, undefined)
  })
})

test('stream or ACK 401 clears local state while 5xx preserves it', async () => {
  await withFetch(async () => jsonResponse({ error: { code: 'unauthorized' } }, 401), async () => {
    const client = new GamingClient('https://platform.example')
    client.token = 'expired-token'
    const connection = new PresenceConnection(client, async () => ({ agentStatus: 'idle', wakeFailures: 0 }))
    await assert.rejects(connection.connectOnce(), (error: unknown) => error instanceof ApiError && error.status === 401)
    assert.equal(client.token, undefined)
  })

  let ackCall = false
  await withFetch(async (input) => {
    if (String(input).endsWith('/v1/presence/stream')) {
      return streamResponse(`event: probe\ndata: ${JSON.stringify(probes[0])}\n\n`)
    }
    ackCall = true
    return jsonResponse({ error: { code: 'unauthorized' } }, 401)
  }, async () => {
    const client = new GamingClient('https://platform.example')
    client.token = 'expired-during-stream'
    const connection = new PresenceConnection(client, async () => ({ agentStatus: 'idle', wakeFailures: 0 }))
    assert.equal(await connection.connectOnce(), 1)
    assert.equal(ackCall, true)
    assert.equal(client.token, undefined)
  })

  await withFetch(async () => jsonResponse({ error: { code: 'unavailable' } }, 503), async () => {
    const client = new GamingClient('https://platform.example')
    client.token = 'player-token'
    const connection = new PresenceConnection(client, async () => ({ agentStatus: 'idle', wakeFailures: 0 }))
    await assert.rejects(connection.connectOnce(), (error: unknown) => error instanceof ApiError && error.status === 503)
    assert.equal(client.token, 'player-token')
  })
})

test('activity is explicit and reconnect backoff caps at thirty seconds', async () => {
  const calls: Array<{ url: string; body?: string }> = []
  await withFetch(async (input, init) => {
    calls.push({ url: String(input), body: init?.body ? String(init.body) : undefined })
    return jsonResponse({ ok: true })
  }, async () => {
    const client = new GamingClient('https://platform.example')
    client.token = 'player-token'
    assert.equal(await client.reportActivity(), true)
  })
  assert.deepEqual(calls, [{
    url: 'https://platform.example/v1/presence/activity',
    body: JSON.stringify({ kind: 'gamer_tool' }),
  }])
  assert.equal(reconnectBackoffMs(1), 1000)
  assert.equal(reconnectBackoffMs(5), 16_000)
  assert.equal(reconnectBackoffMs(20), 30_000)
})
