import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from './client.ts'
import { asJson, mapToolError, readyLocalError, requireLogin } from './auth-gate.ts'

test('no token is not_logged_in', () => {
  const out = requireLogin({})
  assert.equal(out?.error, 'not_logged_in')
  assert.match(String(out?.message), /gamer_account/)
})

test('token present passes requireLogin', () => {
  assert.equal(requireLogin({ token: 't' }), undefined)
})

test('logged in without roomId is missing_room_id, not not_logged_in', () => {
  const out = readyLocalError({ token: 't' })
  assert.deepEqual(out, { ok: false, error: 'missing_room_id' })
})

test('unlogged ready is not_logged_in before missing_room_id', () => {
  const out = readyLocalError({})
  assert.equal(out?.error, 'not_logged_in')
})

test('ready with token and roomId has no local error', () => {
  assert.equal(readyLocalError({ token: 't', roomId: 'r1' }), undefined)
  assert.equal(readyLocalError({ token: 't' }, { roomId: 'r2' }), undefined)
})

test('ApiError 401 maps to not_logged_in', () => {
  const out = mapToolError(new ApiError(401, { error: { code: 'unauthorized', message: 'unauthorized' } }))
  assert.equal(out.error, 'not_logged_in')
  assert.equal(out.status, 401)
  assert.equal(out.ok, false)
})

test('non-401 ApiError keeps status and body', () => {
  const out = mapToolError(new ApiError(409, {
    error: { code: 'already_in_game' },
    token: 'server-token',
    nested: { password: 'echoed-password', credentialRef: 'INTERNAL_REF' },
  }))
  assert.equal(out.status, 409)
  assert.equal(out.error?.error?.code, 'already_in_game')
  assert.doesNotMatch(JSON.stringify(out), /server-token|echoed-password|INTERNAL_REF/)
})

test('all agent output recursively omits tickets, tokens, passwords, and credential references', () => {
  const out = asJson({
    ok: true,
    ticket: 'match-ticket',
    nested: { accessToken: 'player-token', password: 'secret', credentialRef: 'ref', safe: 1 },
  })
  assert.deepEqual(out, { ok: true, nested: { safe: 1 } })
})
