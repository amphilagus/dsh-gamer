import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePlatformUrl } from './config.ts'

test('platform URL prefers explicit config over environment and local default', () => {
  assert.equal(
    resolvePlatformUrl({ platformUrl: 'https://explicit.example' }, { DSH_GAMING_PLATFORM_URL: 'https://env.example' }),
    'https://explicit.example',
  )
  assert.equal(
    resolvePlatformUrl({}, { DSH_GAMING_PLATFORM_URL: 'https://env.example' }),
    'https://env.example',
  )
  assert.equal(resolvePlatformUrl({}, {}), 'http://127.0.0.1:8787')
})
