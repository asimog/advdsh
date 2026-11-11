/**
 * Client tab guards: the selection message rule and the tab address mapping.
 * The browser bundle is loaded with a stub window and a stub `react`, so the
 * pure guards run here without a DOM (WD-068, WD-069, WD-075, WD-135).
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/** @returns {Promise<object>} the bundle's exported guards. */
async function loadGuards() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let captured
  const windowStub = {
    __ModuleLoader__: { load(spec) { captured = spec } },
    location: { origin: 'http://app.test' },
  }
  new Function('window', source)(windowStub)
  const module = captured.factory((name) => {
    if (name === 'react') return {}
    throw new Error(`unexpected module request: ${name}`)
  })
  return module.__guards
}

test('a restored tab derives its own document path from its own address (WD-068, WD-069)', async () => {
  const guards = await loadGuards()
  assert.equal(guards.pathFromAddress('dsh-resource://file/absolute/C:/docs/A.docx'), 'C:/docs/A.docx')
  assert.equal(guards.pathFromAddress('dsh-resource://file/absolute/C:/docs/B.docx'), 'C:/docs/B.docx')
  assert.equal(guards.pathFromAddress('sidebar://workspace-editor'), '', 'a page tab has no document address')
  assert.equal(guards.pathFromAddress(undefined), '')
  assert.equal(guards.toAddress('C:\\docs\\A.docx'), 'dsh-resource://file/absolute/C:/docs/A.docx')
})

test('a selection message opens the menu only from this tab own iframe and origin (WD-135)', async () => {
  const guards = await loadGuards()
  const frameWindow = {}
  const otherWindow = {}
  const base = { origin: 'http://app.test', revision: 'r1', path: 'C:/docs/A.docx' }
  const message = {
    source: frameWindow,
    origin: 'http://app.test',
    data: { type: 'workspace-editor/selection', text: 'clause 4', x: 12, y: 34, dirty: false },
  }
  assert.deepEqual(guards.selectionMessage({ ...base, message, frameWindow }), {
    path: 'C:/docs/A.docx', revision: 'r1', text: 'clause 4', dirty: false, x: 12, y: 34,
  })
  assert.equal(guards.selectionMessage({ ...base, message, frameWindow: otherWindow }), null, 'a foreign window cannot stage a quote')
  assert.equal(guards.selectionMessage({ ...base, message: { ...message, source: otherWindow }, frameWindow }), null)
  assert.equal(guards.selectionMessage({ ...base, message: { ...message, origin: 'http://evil.test' }, frameWindow }), null)
  assert.equal(guards.selectionMessage({
    ...base,
    frameWindow,
    message: { ...message, data: { type: 'workspace-editor/selection', text: 'SPOOF', x: 1, y: 2 } },
  }) === null, false, 'a real message from the iframe passes')
  assert.equal(guards.selectionMessage({
    ...base,
    frameWindow,
    message: { source: frameWindow, origin: 'http://app.test', data: { type: 'workspace-editor/other', text: 'SPOOF', x: 1, y: 2 } },
  }), null)
  assert.equal(guards.selectionMessage({
    ...base,
    frameWindow,
    message: { source: frameWindow, origin: 'http://app.test', data: { type: 'workspace-editor/selection', text: '   ', x: 1, y: 2 } },
  }), null, 'empty text is not a selection')
  assert.equal(guards.selectionMessage({
    ...base,
    frameWindow,
    message: { source: frameWindow, origin: 'http://app.test', data: { type: 'workspace-editor/selection', text: 'x', x: Number.NaN, y: 2 } },
  }), null)
})

test('no selection menu while the tab has no store revision (WD-075)', async () => {
  const guards = await loadGuards()
  const frameWindow = {}
  const message = {
    source: frameWindow,
    origin: 'http://app.test',
    data: { type: 'workspace-editor/selection', text: 'clause 4', x: 12, y: 34, dirty: true },
  }
  assert.equal(guards.selectionMessage({ message, frameWindow, origin: 'http://app.test', revision: '', path: 'C:/docs/A.docx' }), null)
  const staged = guards.selectionMessage({ message, frameWindow, origin: 'http://app.test', revision: 'r1', path: 'C:/docs/A.docx' })
  assert.equal(staged.dirty, true)
  assert.equal(staged.revision, 'r1')
})
