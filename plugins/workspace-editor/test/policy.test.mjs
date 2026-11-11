/**
 * Host-page policy checks: CSP header, iframe sandbox and sidecar navigation guard.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the host page sets a content security policy (WD-076)', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(source.includes("\"default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'\""), 'exact CSP of section 14.1')
  assert.ok(source.includes("res.setHeader('x-content-type-options', 'nosniff')"), 'nosniff header')
})

test('the editor iframe is sandboxed (WD-077)', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(source.includes("sandbox: 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads',"), 'exact sandbox value of section 14.1')
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

test('no plugin source file starts with a byte-order mark', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const nodePath = await import('node:path')
  const root = nodePath.resolve(import.meta.dirname, '..')
  const marked = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'out') continue
      const file = nodePath.join(directory, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (/\.(js|cjs|mjs|json|md|yml|html)$/.test(entry.name)) {
        const bytes = await readFile(file)
        if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) marked.push(nodePath.relative(root, file))
      }
    }
  }
  await walk(root)
  assert.deepEqual(marked, [])
})
