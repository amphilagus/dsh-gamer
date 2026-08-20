import assert from 'node:assert/strict'
import test from 'node:test'
import { looksLikeNetworkOrUrlCommand } from './shell-net.ts'

test('allows local shell without network', () => {
  assert.equal(looksLikeNetworkOrUrlCommand('ls'), false)
  assert.equal(looksLikeNetworkOrUrlCommand('pwd'), false)
  assert.equal(looksLikeNetworkOrUrlCommand('date'), false)
  assert.equal(looksLikeNetworkOrUrlCommand('wc -l notes.md'), false)
  assert.equal(looksLikeNetworkOrUrlCommand('pnpm test'), false)
  assert.equal(looksLikeNetworkOrUrlCommand('open notes.md'), false)
})

test('rejects curl wget and bare URLs', () => {
  assert.equal(looksLikeNetworkOrUrlCommand('curl http://127.0.0.1:8792/v1/view'), true)
  assert.equal(looksLikeNetworkOrUrlCommand('wget https://example.com/board'), true)
  assert.equal(looksLikeNetworkOrUrlCommand('https://127.0.0.1:8792/spectate/m1'), true)
  assert.equal(looksLikeNetworkOrUrlCommand('aria2c http://x'), true)
})

test('rejects open/browser and pwsh web cmdlets', () => {
  assert.equal(looksLikeNetworkOrUrlCommand('open https://127.0.0.1:8787/rooms/r1'), true)
  assert.equal(looksLikeNetworkOrUrlCommand('xdg-open http://localhost:8787'), true)
  assert.equal(looksLikeNetworkOrUrlCommand('Invoke-WebRequest https://x'), true)
  assert.equal(looksLikeNetworkOrUrlCommand('curl.exe https://x'), true)
})

test('rejects script one-liners that fetch', () => {
  assert.equal(looksLikeNetworkOrUrlCommand('python3 -c "import urllib; urllib.request.urlopen(\'http://x\')"'), true)
  assert.equal(looksLikeNetworkOrUrlCommand('node -e "fetch(\'https://x\')"'), true)
})
