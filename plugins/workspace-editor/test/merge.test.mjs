/**
 * Merge contract tests (specification section 12): the result fields of a
 * three-way merge, its conflict reasons and the rollback that keeps the parent
 * text unchanged. The fake engine and the fake document store run the real
 * model, so no Electron or x2t is needed.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createFakeDocuments, createFakeEngine, createModel, fixtureBlocks } from './fixtures.mjs'

/** @param {string} name - fixture name. @returns {{ model: object, engine: object }} model over that fixture. */
function cleanModel(name = 'F-CLEAN') {
  const engine = createFakeEngine(fixtureBlocks(name).blocks)
  return { model: createModel({ engine }).model, engine }
}

/** @param {object} model - model. @param {string} handle - session handle. @returns {Promise<string[]>} block texts in order. */
async function blockTexts(model, handle) {
  const read = await model.read(handle, { mode: 'full' })
  return read.blocks.map((block) => block.text)
}

test('a refused apply is a conflict and the merge result has no failed field (WD-043)', async () => {
  const { model, engine } = cleanModel()
  const opened = await model.open('C:/docs/F-CLEAN.docx')
  const fork = await model.fork(opened.handle, { label: 'a' })
  await model.edit(fork.handle, { type: 'replace_paragraph', blockId: 'w14:2', text: 'TWO-A' })
  // Refuse only the merge's adoption of that change.
  const apply = engine.apply.bind(engine)
  engine.apply = async (sessionId, op, options) => {
    if (op.type === 'replace_paragraph' && op.text === 'TWO-A') {
      throw Object.assign(new Error('block changed'), { code: 'ENGINE_STALE_TARGET' })
    }
    return apply(sessionId, op, options)
  }
  const merged = await model.merge(opened.handle, [fork.handle])
  assert.equal(Object.hasOwn(merged, 'failed'), false, 'the merge result has no failed field')
  assert.equal(merged.applied, 0)
  assert.equal(merged.changed, false)
  assert.equal(merged.conflicts.length, 1)
  assert.equal(merged.conflicts[0].id, 'w14:2')
  assert.equal(merged.conflicts[0].reason, 'apply-failed')
  assert.deepEqual(await blockTexts(model, opened.handle), ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'])
})

test('a second adoption op that is refused rolls the first one back (WD-044)', async () => {
  const { model, engine } = cleanModel()
  const opened = await model.open('C:/docs/F-CLEAN.docx')
  const fork = await model.fork(opened.handle, { label: 'a' })
  await model.edit(fork.handle, { type: 'replace_paragraph', blockId: 'w14:2', text: 'TWO-A' })
  await model.edit(fork.handle, { type: 'replace_paragraph', blockId: 'w14:3', text: 'THREE-A' })
  const apply = engine.apply.bind(engine)
  let adoptions = 0
  engine.apply = async (sessionId, op, options) => {
    if (op.type === 'replace_paragraph') {
      adoptions += 1
      if (adoptions === 2) throw Object.assign(new Error('refused'), { code: 'ENGINE_STALE_TARGET' })
    }
    return apply(sessionId, op, options)
  }
  const merged = await model.merge(opened.handle, [fork.handle])
  assert.equal(merged.applied, 0)
  assert.equal(merged.conflicts[0].reason, 'apply-failed')
  assert.deepEqual(await blockTexts(model, opened.handle), ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'])
})

test('a delete in one fork and an edit in another is delete-vs-edit (WD-045)', async () => {
  const { model } = cleanModel()
  const opened = await model.open('C:/docs/F-CLEAN.docx')
  const deleter = await model.fork(opened.handle, { label: 'a' })
  const editor = await model.fork(opened.handle, { label: 'b' })
  await model.edit(deleter.handle, { type: 'delete_paragraph', blockId: 'w14:2', expectedText: 'TWO' })
  await model.edit(editor.handle, { type: 'replace_paragraph', blockId: 'w14:2', text: 'TWO-B' })
  const merged = await model.merge(opened.handle, [deleter.handle, editor.handle])
  assert.equal(merged.applied, 0)
  assert.equal(merged.conflicts.length, 1)
  assert.equal(merged.conflicts[0].id, 'w14:2')
  assert.equal(merged.conflicts[0].reason, 'delete-vs-edit')
  assert.deepEqual(merged.conflicts[0].candidates.map((candidate) => candidate.task), ['a', 'b'])
  assert.equal(merged.conflicts[0].candidates.find((candidate) => candidate.task === 'a').text, null)
  assert.equal(merged.conflicts[0].candidates.find((candidate) => candidate.task === 'b').text, 'TWO-B')
})

test('a fork change with no logged op is not-derived and the parent keeps its text (WD-127)', async () => {
  const engine = createFakeEngine(fixtureBlocks('F-CLEAN').blocks)
  const describe = engine.describe.bind(engine)
  const model = createModel({ engine }).model
  const parent = await model.open('C:/docs/F-CLEAN.docx')
  const fork = await model.fork(parent.handle)
  // A side-effect change has no op in the fork log: the merge must not adopt it.
  // One edit and its undo bump the revision, so the model describes the fork again.
  await model.edit(fork.handle, { type: 'insert_paragraph', index: 5, text: 'TEMP' })
  await model.undo(fork.handle)
  engine.describe = async (sessionId, options) => {
    const raw = await describe(sessionId, options)
    const blocks = raw.blocks.map((block) => (block.id === 'w14:2'
      ? { ...block, text: 'SIDE-EFFECT', runs: [{ text: 'SIDE-EFFECT', inserted: true, deleted: false }] }
      : block))
    return { ...raw, blocks }
  }
  const merged = await model.merge(parent.handle, [fork.handle])
  assert.equal(merged.applied, 0)
  assert.equal(merged.conflicts.length, 1)
  assert.equal(merged.conflicts[0].id, 'w14:2')
  assert.equal(merged.conflicts[0].reason, 'not-derived')
  assert.deepEqual(await blockTexts(model, parent.handle), ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'])
})

test('merge reports the task label on every adopted operation (WD-046)', async () => {
  const engine = createFakeEngine(fixtureBlocks('F-CLEAN').blocks)
  const model = createModel({ engine, documents: createFakeDocuments() }).model
  const opened = await model.open('C:/docs/F-CLEAN.docx')
  const fork = await model.fork(opened.handle, { label: 'task-a' })
  await model.edit(fork.handle, { type: 'replace_paragraph', blockId: 'w14:2', text: 'TWO-A' })
  const merged = await model.merge(opened.handle, [fork.handle])
  assert.equal(merged.operations[0].task, 'task-a')
  await model.diff(opened.handle)
  const committed = await model.commit(opened.handle)
  assert.deepEqual(committed.contributors, ['task-a'])
})
