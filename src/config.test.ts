import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUILTIN_PLATFORMS,
  COMMUNITY_PLATFORM_URL,
  LOCAL_PLATFORM_URL,
  resolvePlatforms,
} from './config.ts'

test('platform registry starts with community and local and has no selected default', () => {
  assert.deepEqual(resolvePlatforms({}), BUILTIN_PLATFORMS)
  assert.equal(BUILTIN_PLATFORMS[0].url, COMMUNITY_PLATFORM_URL)
  assert.equal(BUILTIN_PLATFORMS[1].url, LOCAL_PLATFORM_URL)
})

test('trusted config overrides built-ins by id and appends custom platforms', () => {
  const rows = resolvePlatforms({
    platforms: [
      { id: 'community', name: 'Private mirror', url: 'https://mirror.example/base/' },
      { id: 'lan', name: 'LAN', url: 'http://192.168.1.20:8787' },
    ],
  })
  assert.deepEqual(rows.map((row) => row.id), ['community', 'local', 'lan'])
  assert.deepEqual(rows[0], {
    id: 'community',
    name: 'Private mirror',
    url: 'https://mirror.example/base',
    builtIn: false,
  })
})

test('invalid, duplicate, and legacy platform configuration fails explicitly', () => {
  assert.throws(() => resolvePlatforms({ platforms: [
    { id: 'Bad ID', name: 'Bad', url: 'https://example.com' },
  ] }), /platform id/)
  assert.throws(() => resolvePlatforms({ platforms: [
    { id: 'one', name: 'One', url: 'file:///tmp/platform' },
  ] }), /http or https/)
  assert.throws(() => resolvePlatforms({ platforms: [
    { id: 'one', name: 'One', url: 'https://u:p@example.com' },
  ] }), /must not contain credentials/)
  assert.throws(() => resolvePlatforms({ platforms: [
    { id: 'one', name: 'One', url: 'https://one.example' },
    { id: 'one', name: 'Other', url: 'https://other.example' },
  ] }), /duplicate configured platform/)
  assert.throws(() => resolvePlatforms({ platformUrl: 'https://legacy.example' } as never), /platformUrl was removed/)
})
