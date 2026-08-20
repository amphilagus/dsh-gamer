import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_PLATFORM_URL, LOCAL_PLATFORM_URL, resolvePlatformUrl } from './config.ts'

test('platform URL prefers explicit config over environment and hosted default', () => {
  assert.equal(
    resolvePlatformUrl({ platformUrl: 'https://explicit.example' }, { DSH_GAMING_PLATFORM_URL: 'https://env.example' }),
    'https://explicit.example',
  )
  assert.equal(
    resolvePlatformUrl({}, { DSH_GAMING_PLATFORM_URL: 'https://env.example' }),
    'https://env.example',
  )
  assert.equal(
    resolvePlatformUrl({}, { DSH_GAMING_PLATFORM_URL: LOCAL_PLATFORM_URL }),
    LOCAL_PLATFORM_URL,
  )
  assert.equal(resolvePlatformUrl({}, {}), DEFAULT_PLATFORM_URL)
})
