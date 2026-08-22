import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_WAIT_TIMEOUT_SECONDS,
  MAX_WAIT_TIMEOUT_SECONDS,
  normalizeWaitTimeoutSeconds,
} from './polling.ts'

test('compatibility polling defaults to eight seconds and is capped at fifteen', () => {
  assert.equal(normalizeWaitTimeoutSeconds(undefined), DEFAULT_WAIT_TIMEOUT_SECONDS)
  assert.equal(normalizeWaitTimeoutSeconds(1), 1)
  assert.equal(normalizeWaitTimeoutSeconds(15), MAX_WAIT_TIMEOUT_SECONDS)
  assert.equal(normalizeWaitTimeoutSeconds(30), MAX_WAIT_TIMEOUT_SECONDS)
  assert.equal(normalizeWaitTimeoutSeconds(0), 1)
})
