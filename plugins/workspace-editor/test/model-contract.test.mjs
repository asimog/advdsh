/**
 * Model-session contract: one record per owner and file, the open base, the
 * content hash, the pending op log, the diff-seen marker, fork labels and the
 * commit decision.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { PATH, createFakeDocuments, createModel } from './fixtures.mjs'

test('one model session per DSH session and file, with distinct handles', async () => {
  const { model } = createModel()
  const one = await model.open(PATH, { sessionId: 'S1' })
  const two = await model.open(PATH, { sessionId: 'S2' })
  assert.notEqual(one.handle, two.handle)
  assert.equal(model.contract(one.handle).ownerSessionId, 'S1')
  assert.equal(model.contract(two.handle).ownerSessionId, 'S2')
  assert.equal(model.status(undefined, 'S1').length, 1)
  assert.equal(model.status(undefined, 'S2').length, 1)
  assert.equal(model.status(undefined, 'S3').length, 0)
  const anonymous = await model.open(PATH, { sessionId: '' })
  assert.equal(model.contract(anonymous.handle).ownerSessionId, '')
})

test('the open base and content hash stay fixed while edits accumulate', async () => {
  const { model } = createModel()
  const opened = await model.open(PATH, { sessionId: 'S1' })
  const before = model.contract(opened.handle)
  assert.equal(before.openBlocks, 4)
  assert.equal(before.pendingOps, 0)
  assert.match(before.contentHash, /^[0-9a-f]{64}$/)
  await model.edit(opened.handle, { type: 'replace_paragraph', blockId: 'p:2', text: 'Changed.' })
  const after = model.contract(opened.handle)
  assert.equal(after.openBlocks, 4)
  assert.equal(after.contentHash, before.contentHash)
  assert.equal(after.pendingOps, 1)
  assert.equal(after.diffPending, 1)
})

test('the op log keeps before and after text and the diff marker gates a commit', async () => {
  const { model } = createModel({ documents: createFakeDocuments() })
  const opened = await model.open(PATH, { sessionId: 'S1' })
  await model.edit(opened.handle, { type: 'replace_paragraph', blockId: 'p:2', text: 'Changed.' })
  const operations = model.pendingOperations(opened.handle)
  assert.equal(operations.length, 1)
  assert.equal(operations[0].type, 'replace_paragraph')
  assert.equal(operations[0].affected[0].id, 'p:2')
  assert.match(operations[0].affected[0].textBefore, /Plaintiff seeks/)
  assert.equal(operations[0].affected[0].textAfter, 'Changed.')
  assert.deepEqual(model.commitEligibility(opened.handle), {
    eligible: false,
    code: 'DOC_REVIEW_REQUIRED',
    reason: 'diff-not-seen',
  })

  await model.diff(opened.handle)
  assert.equal(model.contract(opened.handle).diffSeenOps, 1)
  assert.equal(model.contract(opened.handle).diffPending, 0)
  assert.deepEqual(model.commitEligibility(opened.handle), { eligible: true, code: null, reason: 'ready' })
  await model.edit(opened.handle, { type: 'insert_paragraph', index: 4, text: 'Next.' })
  assert.equal(model.commitEligibility(opened.handle).code, 'DOC_REVIEW_REQUIRED')
})

test('a fork records its task label and never becomes commit-eligible', async () => {
  const { model } = createModel({ documents: createFakeDocuments() })
  const opened = await model.open(PATH, { sessionId: 'S1' })
  const fork = await model.fork(opened.handle, { label: 'task-a' })
  const contract = model.contract(fork.handle)
  assert.equal(contract.taskLabel, 'task-a')
  assert.equal(contract.forkParent, opened.handle)
  assert.equal(contract.ownerSessionId, 'S1')
  assert.deepEqual(model.commitEligibility(fork.handle), {
    eligible: false,
    code: 'DOC_FORKED_COMMIT',
    reason: 'fork',
  })
})

test('a stale session and a session with no changes report their commit reason', async () => {
  const { model } = createModel({ documents: createFakeDocuments() })
  const opened = await model.open(PATH, { sessionId: 'S1' })
  assert.deepEqual(model.commitEligibility(opened.handle), { eligible: false, code: null, reason: 'no-changes' })
  model.noteSaved(PATH, 'r-human')
  assert.deepEqual(model.commitEligibility(opened.handle), {
    eligible: false,
    code: 'DOC_STALE_BASE',
    reason: 'stale',
  })
})
