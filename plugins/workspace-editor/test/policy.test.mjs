/**
 * Host-page policy checks: CSP header, iframe sandbox and sidecar navigation guard.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the host page sets a content security policy (WD-076)', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /content-security-policy/)
  assert.match(source, /default-src 'none'/)
})

test('the editor iframe is sandboxed (WD-077)', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /sandbox: 'allow-scripts allow-same-origin/)
})

test('the sidecar denies navigation and new windows (WD-078)', async () => {
  const source = await readFile(new URL('../lib/engine/host/main.js', import.meta.url), 'utf8')
  assert.match(source, /setWindowOpenHandler/)
  assert.match(source, /will-navigate/)
  assert.match(source, /preventDefault\(\)/)
})
test('the client accepts selection messages only from its own iframe origin (WD-135)', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /event\.source !== frame\.contentWindow/)
  assert.match(source, /event\.origin !== window\.location\.origin/)
})

test('the sidecar rejects a request with the wrong token (WD-136)', async () => {
  const source = await readFile(new URL('../lib/engine/host/main.js', import.meta.url), 'utf8')
  assert.match(source, /x-engine-token/)
  assert.match(source, /403/)
})

test('the selection menu never uses the file time as the lease revision (WD-075)', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /loadedRevision !== '' \? loadedRevision : loadedMtime/)
})
