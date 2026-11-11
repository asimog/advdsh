/**
 * Sidecar identity checks and the shared outline helper.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { resolveEngineConfig } from '../lib/engine/locate.js'

test('a configured converter hash mismatch refuses the engine config (WD-101)', () => {
  const previous = process.env.WORKSPACE_EDITOR_X2T_SHA256
  process.env.WORKSPACE_EDITOR_X2T_SHA256 = '0'.repeat(64)
  try {
    assert.throws(() => resolveEngineConfig(), (error) => error.code === 'ENGINE_UNAVAILABLE' && /x2t hash mismatch/.test(error.message))
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_EDITOR_X2T_SHA256
    else process.env.WORKSPACE_EDITOR_X2T_SHA256 = previous
  }
})

test('the outline helper is defined once (WD-104)', async () => {
  const manager = await readFile(new URL('../lib/engine/manager.js', import.meta.url), 'utf8')
  const model = await readFile(new URL('../lib/model/model.js', import.meta.url), 'utf8')
  assert.doesNotMatch(manager, /function outlineOf/)
  assert.doesNotMatch(model, /function outlineOf/)
  assert.match(manager, /from '\.\.\/outline\.js'/)
  assert.match(model, /from '\.\.\/outline\.js'/)
})
test('the TaskQueueDataConvert XML is built once (WD-105)', async () => {
  const x2t = await readFile(new URL('../lib/x2t.js', import.meta.url), 'utf8')
  const main = await readFile(new URL('../lib/engine/host/main.js', import.meta.url), 'utf8')
  assert.doesNotMatch(x2t, /<TaskQueueDataConvert/)
  assert.doesNotMatch(main, /<TaskQueueDataConvert/)
  assert.match(x2t, /taskQueue\.taskQueueXml/)
  assert.match(main, /taskQueueXml\(/)
})
