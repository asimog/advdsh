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
  assert.match(source, /message\.source !== input\.frameWindow/)
  assert.match(source, /message\.origin !== input\.origin/)
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

test('no plugin source file holds text that was decoded with the wrong encoding', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const nodePath = await import('node:path')
  const root = nodePath.resolve(import.meta.dirname, '..')
  // UTF-8 punctuation read as Windows-1252: an ellipsis becomes one character
  // from E2 80 A6 decoded byte by byte; a two-byte letter such as e-acute
  // becomes a Cyrillic-looking A-tilde pair. The pattern is built from code
  // points so this file does not itself hold the damaged text.
  const misread = new RegExp('\u00E2\u20AC|\u00C3[\u0080-\u00BF]|\u00C2\u00A0')
  const damaged = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'out') continue
      const file = nodePath.join(directory, entry.name)
      if (entry.isDirectory()) { await walk(file); continue }
      if (!/\.(js|cjs|mjs|json|md|yml|html)$/.test(entry.name)) continue
      const text = await readFile(file, 'utf8')
      const match = misread.exec(text)
      if (match !== null) {
        const line = text.slice(0, match.index).split('\n').length
        damaged.push(`${nodePath.relative(root, file)}:${line}: ${JSON.stringify(match[0])}`)
      }
    }
  }
  await walk(root)
  assert.deepEqual(damaged, [], 'text decoded with the wrong encoding (a damaged ellipsis or accented letter)')
})
