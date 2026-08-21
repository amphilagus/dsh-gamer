import assert from 'node:assert/strict'
import test from 'node:test'
import {
  STALL_IDLE_MS,
  STALL_REPEAT_MS,
  advanceStallClock,
  deliverWake,
  isNewTicket,
  initialWakeFailureState,
  recordModelOutput,
  recordWakeAttempt,
  routeWake,
  settleUnansweredWake,
  shouldRequestAgentLogout,
  shouldStall,
  viewIsYourTurn,
} from './wakeup.ts'

test('idle new ticket without start/end does not wake', () => {
  assert.equal(routeWake({ status: 'idle', freshKinds: [] }), 'none')
})

test('idle fresh match_started followup', () => {
  assert.equal(routeWake({ status: 'idle', freshKinds: ['match_started'] }), 'followup')
})

test('idle fresh match_ended followup', () => {
  assert.equal(routeWake({ status: 'idle', freshKinds: ['match_ended'] }), 'followup')
})

test('idle without start/end does not followup', () => {
  assert.equal(routeWake({ status: 'idle', freshKinds: [] }), 'none')
  assert.equal(routeWake({ status: 'idle', freshKinds: ['other'] }), 'none')
})

test('running start/end inject and do not followup', () => {
  assert.equal(routeWake({
    status: 'running',
    freshKinds: ['match_started', 'match_ended'],
  }), 'inject')
})

test('running with no start/end does nothing', () => {
  assert.equal(routeWake({ status: 'running', freshKinds: [] }), 'none')
  assert.equal(routeWake({ status: 'running', freshKinds: ['other'] }), 'none')
})

test('isNewTicket is the ticket appearance or replacement', () => {
  assert.equal(isNewTicket(undefined, 't1'), true)
  assert.equal(isNewTicket('t1', 't1'), false)
  assert.equal(isNewTicket('t1', 't2'), true)
  assert.equal(isNewTicket('t1', undefined), false)
})

test('idle deliverWake followups once then injects the rest', () => {
  const followup: string[] = []
  const injected: string[] = []
  const action = deliverWake(
    {
      status: 'idle',
      followup: (message: string) => { followup.push(message) },
      inject: (message: string) => { injected.push(message) },
    },
    ['started', 'ended'],
  )
  assert.equal(action, 'followup')
  assert.deepEqual(followup, ['started'])
  assert.deepEqual(injected, ['ended'])
})

test('running deliverWake injects all and never followups', () => {
  const followup: string[] = []
  const injected: string[] = []
  const action = deliverWake(
    {
      status: 'running',
      followup: (message: string) => { followup.push(message) },
      inject: (message: string) => { injected.push(message) },
    },
    ['started', 'ended'],
  )
  assert.equal(action, 'inject')
  assert.deepEqual(followup, [])
  assert.deepEqual(injected, ['started', 'ended'])
})

test('stall clock starts on idle seated live and clears on running', () => {
  const now = 1_000
  const started = advanceStallClock({}, 'idle', true, now)
  assert.equal(started.idleSince, now)
  const kept = advanceStallClock(started, 'idle', true, now + 5_000)
  assert.equal(kept.idleSince, now)
  const cleared = advanceStallClock(kept, 'running', true, now + 6_000)
  assert.deepEqual(cleared, {})
  assert.deepEqual(advanceStallClock(started, 'idle', false, now + 7_000), {})
})

test('viewIsYourTurn requires playing and yourTurn', () => {
  assert.equal(viewIsYourTurn({ yourTurn: true, status: 'playing' }), true)
  assert.equal(viewIsYourTurn({ yourTurn: false, status: 'playing' }), false)
  assert.equal(viewIsYourTurn({ yourTurn: true, status: 'ended' }), false)
  assert.equal(viewIsYourTurn(null), false)
})

test('stall repeats only after the reminder interval while idle', () => {
  const idleSince = 1_000
  const clock = { idleSince }
  assert.equal(shouldStall(clock, idleSince + STALL_IDLE_MS - 1, false), false)
  assert.equal(shouldStall(clock, idleSince + STALL_IDLE_MS, false), true)
  assert.equal(shouldStall(clock, idleSince + STALL_IDLE_MS, true), false)
  const nudged = { idleSince, lastStallAt: idleSince + STALL_IDLE_MS }
  assert.equal(shouldStall(nudged, idleSince + STALL_IDLE_MS + STALL_REPEAT_MS - 1, false), false)
  assert.equal(shouldStall(nudged, idleSince + STALL_IDLE_MS + STALL_REPEAT_MS, false), true)
})

test('five unanswered wake attempts request logout, output resets the count', () => {
  let state = initialWakeFailureState()
  for (let i = 0; i < 4; i++) {
    state = recordWakeAttempt(state)
    assert.equal(settleUnansweredWake(state, 'running').failures, i)
    state = settleUnansweredWake(state, 'idle')
    assert.equal(shouldRequestAgentLogout(state), false)
  }
  state = recordWakeAttempt(state)
  state = settleUnansweredWake(state, 'idle')
  assert.equal(state.failures, 5)
  assert.equal(shouldRequestAgentLogout(state), true)
  assert.deepEqual(recordModelOutput(state), initialWakeFailureState())
})
