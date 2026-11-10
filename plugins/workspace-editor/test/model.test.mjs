/**
 * Unit tests for `ctx.docxModel` (`lib/model/model.js`) over a fake engine and a
 * fake document store: no Electron, x2t or DSH context.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { MODEL_CODES, ModelError } from '../lib/model/model.js'

import { DOCX, PATH, createFakeDocuments, createFakeEngine, createModel } from './fixtures.mjs'

test('open returns a handle, content hash and read mode', async () => {
  const { model } = createModel()
  const opened = await model.open(PATH)
  assert.match(opened.handle, /^doc-[0-9a-f]{10}$/)
  assert.equal(opened.path, path.resolve(PATH))
  assert.equal(opened.contentHash.length, 64)
  assert.equal(opened.readMode, 'full')
  assert.equal(opened.blocks, 4)
  assert.equal(opened.paragraphs, 3)
  assert.equal(opened.tables, 1)
  assert.equal(opened.outline.length, 1)
})

test('open reuses a session for the same path and content, and mints a new one for new bytes', async () => {
  let bytes = DOCX
  const { model, readFile } = createModel({ readFile: async () => bytes })
  const first = await model.open(PATH)
  const second = await model.open(PATH)
  assert.equal(second.handle, first.handle)
  bytes = Buffer.from('changed-docx-bytes')
  readFile.refs = 0
  const third = await model.open(PATH)
  assert.notEqual(third.handle, first.handle)
})

test('full read enforces the token budget and points at the other modes', async () => {
  const { model } = createModel({ limits: { fullReadTokens: 5, fullReadParagraphs: 1 } })
  const opened = await model.open(PATH)
  assert.equal(opened.readMode, 'large')
  await assert.rejects(
    () => model.read(opened.handle, { mode: 'full' }),
    (error) => error instanceof ModelError && error.code === MODEL_CODES.TOO_LARGE,
  )
  const auto = await model.read(opened.handle, { mode: 'auto' })
  assert.equal(auto.mode, 'outline')
  assert.equal(auto.outline.length, 1)
  const outline = await model.read(opened.handle, { mode: 'outline' })
  assert.match(outline.text, /\[p:1\] IN THE UNITED STATES DISTRICT COURT/)
})

test('range, search and context reads are bounded and annotated', async () => {
  const { model } = createModel()
  const opened = await model.open(PATH)
  const range = await model.read(opened.handle, { mode: 'range', from: 1, to: 2 })
  assert.deepEqual(range.blocks.map((block) => block.id), ['p:2', 't:1'])
  assert.equal(range.truncated, false)
  const search = await model.read(opened.handle, { mode: 'search', query: 'temporary restraining' })
  assert.equal(search.matches.length, 1)
  assert.equal(search.matches[0].id, 'p:2')
  const context = await model.read(opened.handle, { mode: 'context', blockId: 'p:2', before: 1, after: 1 })
  assert.deepEqual(context.blocks.map((block) => block.id), ['p:1', 'p:2', 't:1'])
  assert.equal(context.focus.id, 'p:2')
})

test('edit applies one tracked op with an expected-text check and records the inverse', async () => {
  const { model, engine } = createModel()
  const opened = await model.open(PATH)
  const result = await model.edit(opened.handle, { type: 'replace_paragraph', blockId: 'p:2', text: 'The Court should enjoin Defendant.' })
  assert.equal(result.tracked, true)
  assert.equal(result.changed, 1)
  assert.equal(result.affected[0].id, 'p:2')
  const applied = engine.calls.find((call) => call.method === 'apply')
  assert.equal(applied.op.expectedText, 'Plaintiff seeks entry of an ex parte temporary restraining order.')
  const undone = await model.undo(opened.handle)
  assert.equal(undone.undone, 'replace_paragraph')
  const after = await model.read(opened.handle, { mode: 'full' })
  assert.match(after.text, /ex parte temporary restraining order/)
})

test('edit refuses an unsupported op and a missing target with stable codes', async () => {
  const { model } = createModel()
  const opened = await model.open(PATH)
  await assert.rejects(
    () => model.edit(opened.handle, { type: 'apply_style', blockId: 'p:2', style: 'Quote' }),
    (error) => error.code === MODEL_CODES.INVALID_OP && String(error.message).includes('unsupported edit op'),
  )
  await assert.rejects(
    () => model.edit(opened.handle, { type: 'replace_paragraph', blockId: 'p:missing', text: 'x' }),
    (error) => error.code === MODEL_CODES.TARGET_NOT_FOUND,
  )
})

test('a stale target from the engine becomes DOC_STALE_TARGET', async () => {
  const engine = createFakeEngine()
  engine.apply = async () => {
    throw Object.assign(new Error('target changed'), { code: 'ENGINE_STALE_TARGET' })
  }
  const { model } = createModel({ engine })
  const opened = await model.open(PATH)
  await assert.rejects(
    () => model.edit(opened.handle, { type: 'replace_paragraph', blockId: 'p:2', text: 'x' }),
    (error) => error.code === MODEL_CODES.STALE_TARGET,
  )
})

test('writes are refused when the gate is off; commit needs the shared store', async () => {
  const documents = createFakeDocuments()
  const gated = createModel({ documents, writeEnabled: false })
  const opened = await gated.model.open(PATH)
  await assert.rejects(
    () => gated.model.edit(opened.handle, { type: 'replace_paragraph', blockId: 'p:2', text: 'x' }),
    (error) => error.code === MODEL_CODES.WRITE_DISABLED,
  )
  const noStore = createModel()
  const openedAgain = await noStore.model.open(PATH)
  const edited = await noStore.model.edit(openedAgain.handle, { type: 'replace_paragraph', blockId: 'p:2', text: 'x' })
  assert.equal(edited.changed, 1, 'working-state edits do not need a store')
  await assert.rejects(
    () => noStore.model.commit(openedAgain.handle),
    (error) => error.code === MODEL_CODES.WRITE_UNAVAILABLE,
  )
})

test('commit refuses a dirty editor and a stale base, then writes through the store', async () => {
  const documents = createFakeDocuments()
  const { model, engine } = createModel({ documents })
  const opened = await model.open(PATH)
  await model.edit(opened.handle, { type: 'replace_paragraph', blockId: 'p:2', text: 'Edited text.' })

  documents.state.modified = true
  await assert.rejects(
    () => model.commit(opened.handle),
    (error) => error.code === MODEL_CODES.EDITOR_DIRTY,
  )
  documents.state.modified = false
  documents.state.revision = 'r-9'
  await assert.rejects(
    () => model.commit(opened.handle),
    (error) => error.code === MODEL_CODES.STALE_BASE,
  )

  documents.state.revision = 'r-1'
  await model.reload(opened.handle)
  await model.edit(opened.handle, { type: 'replace_paragraph', blockId: 'p:2', text: 'Edited text.' })
  const committed = await model.commit(opened.handle)
  assert.equal(committed.applied, true)
  assert.equal(committed.revision, 'r-2')
  assert.equal(documents.state.applied.length, 1)
  assert.equal(documents.state.applied[0].options.baseRevision, 'r-1')
  assert.ok(engine.openCount >= 2, 'the engine rebases on the committed bytes')
  const revisions = await model.revisions(opened.handle)
  assert.equal(revisions.pending.ops, 0)
  assert.equal(revisions.commits.length, 1)
  const noop = await model.commit(opened.handle)
  assert.equal(noop.applied, false)
})

test('a human save marks the session stale until reload', async () => {
  const documents = createFakeDocuments()
  const { model } = createModel({ documents })
  const opened = await model.open(PATH)
  model.noteSaved(PATH, 'r-human')
  documents.state.revision = 'r-human'
  const status = model.status()
  assert.equal(status[0].stale, true)
  await assert.rejects(
    () => model.commit(opened.handle, { force: true }),
    (error) => error.code === MODEL_CODES.STALE_BASE,
  )
  const reloaded = await model.reload(opened.handle)
  assert.equal(reloaded.baseRevision, 'r-human')
  assert.equal(model.status()[0].stale, false)
})

test('check reports pending revisions and registered analyzer findings', async () => {
  const analyzer = ({ blocks }) => (blocks.some((block) => /temporary restraining/.test(block.text))
    ? [{ code: 'PLACEHOLDER_TEXT', severity: 'warning', message: 'boilerplate detected', blocks: ['p:2'] }]
    : [])
  const { model } = createModel({ analyzers: [analyzer] })
  const opened = await model.open(PATH)
  await model.edit(opened.handle, { type: 'replace_paragraph', blockId: 'p:3', text: 'Dated: 10 November 2026.' })
  const checked = await model.check(opened.handle)
  assert.equal(checked.ok, false)
  assert.deepEqual(checked.codes.sort(), ['PENDING_REVISIONS', 'PLACEHOLDER_TEXT'])
  assert.equal(checked.findings.length, 2)
})

test('status lines and close are per-session and idempotent', async () => {
  const { model } = createModel()
  const opened = await model.open(PATH)
  const lines = model.statusLines('C:/docs')
  assert.equal(lines.length, 1)
  assert.ok(lines[0].startsWith(`${opened.handle} ${path.resolve(PATH)} rev=0`), lines[0])
  assert.equal(model.statusLines('C:/elsewhere').length, 0)
  assert.equal((await model.close(opened.handle)).closed, true)
  assert.equal((await model.close(opened.handle)).closed, true)
  assert.equal(model.status().length, 0)
  await assert.rejects(() => model.describe(opened.handle), (error) => error.code === MODEL_CODES.SESSION_NOT_FOUND)
})

test('dispose closes every engine session', async () => {
  const { model, engine } = createModel()
  await model.open(PATH)
  await model.open({ path: 'C:/docs/Other.docx' })
  await model.dispose()
  assert.equal(model.status().length, 0)
  assert.equal(engine.calls.filter((call) => call.method === 'close').length, 2)
})

test('fork isolates the working state and a fork cannot commit', async () => {
  const documents = createFakeDocuments()
  const { model } = createModel({ documents })
  const opened = await model.open(PATH)
  await model.edit(opened.handle, { type: 'replace_paragraph', blockId: 'p:2', text: 'Parent edit.' })
  const fork = await model.fork(opened.handle, { label: 'task-a' })
  assert.match(fork.handle, /^fork-/)
  assert.equal(fork.forkedFrom, opened.handle)
  assert.equal(fork.label, 'task-a')
  const forkedRead = await model.read(fork.handle, { mode: 'full' })
  assert.match(forkedRead.text, /Parent edit\./, 'the fork starts from the parent working state')
  await model.edit(fork.handle, { type: 'replace_paragraph', blockId: 'p:3', text: 'Fork edit.' })
  const parentRead = await model.read(opened.handle, { mode: 'full' })
  assert.match(parentRead.text, /Respectfully submitted\./)
  assert.doesNotMatch(parentRead.text, /Fork edit/)
  await assert.rejects(
    () => model.commit(fork.handle, { force: true }),
    (error) => error.code === MODEL_CODES.FORKED_COMMIT,
  )
})

test('merge applies non-conflicting fork changes to the parent by block id', async () => {
  const documents = createFakeDocuments()
  const { model } = createModel({ documents })
  const opened = await model.open(PATH)
  const fork = await model.fork(opened.handle, { label: 'rewrite-p3' })
  await model.edit(fork.handle, { type: 'replace_paragraph', blockId: 'p:3', text: 'Filed on 10 November 2026.' })
  const merged = await model.merge(opened.handle, [fork.handle])
  assert.equal(merged.conflicts.length, 0)
  assert.equal(merged.applied, 1)
  assert.equal(merged.changed, true)
  const parentRead = await model.read(opened.handle, { mode: 'full' })
  assert.match(parentRead.text, /Filed on 10 November 2026\./)
  const committed = await model.commit(opened.handle)
  assert.equal(committed.applied, true)
})

test('merge returns a conflict for different changes to one block', async () => {
  const { model } = createModel()
  const opened = await model.open(PATH)
  const first = await model.fork(opened.handle, { label: 'first' })
  const second = await model.fork(opened.handle, { label: 'second' })
  await model.edit(first.handle, { type: 'replace_paragraph', blockId: 'p:2', text: 'First version.' })
  await model.edit(first.handle, { type: 'replace_paragraph', blockId: 'p:3', text: 'First closing.' })
  await model.edit(second.handle, { type: 'replace_paragraph', blockId: 'p:2', text: 'Second version.' })
  const merged = await model.merge(opened.handle, [first.handle, second.handle])
  assert.equal(merged.conflicts.length, 1)
  assert.equal(merged.conflicts[0].id, 'p:2')
  assert.equal(merged.conflicts[0].candidates.length, 2)
  assert.deepEqual(merged.conflicts[0].candidates.map((candidate) => candidate.task).sort(), ['first', 'second'])
  assert.equal(merged.applied, 1, 'the non-conflicting closing change still applies')
  const parentRead = await model.read(opened.handle, { mode: 'full' })
  assert.match(parentRead.text, /First closing\./)
  assert.match(parentRead.text, /Plaintiff seeks entry/, 'the conflicted block keeps the parent text')
})

test('merge keeps fork order for insertions at one anchor and applies deletions', async () => {
  const { model } = createModel()
  const opened = await model.open(PATH)
  const first = await model.fork(opened.handle, { label: 'first' })
  const second = await model.fork(opened.handle, { label: 'second' })
  await model.edit(first.handle, { type: 'insert_paragraph', index: 4, text: 'FIRST-INSERT' })
  await model.edit(second.handle, { type: 'insert_paragraph', index: 4, text: 'SECOND-INSERT' })
  await model.edit(second.handle, { type: 'delete_paragraph', blockId: 'p:1', expectedText: 'IN THE UNITED STATES DISTRICT COURT' })
  const merged = await model.merge(opened.handle, [first.handle, second.handle])
  assert.equal(merged.conflicts.length, 0)
  assert.equal(merged.applied, 3)
  const parentRead = await model.read(opened.handle, { mode: 'full' })
  assert.match(parentRead.text, /FIRST-INSERT\n\[.*\] SECOND-INSERT/, 'insertions keep fork order')
  assert.doesNotMatch(parentRead.text, /UNITED STATES DISTRICT COURT/)
})

test('merge refuses a handle that is not a fork of the parent', async () => {
  const { model } = createModel()
  const opened = await model.open(PATH)
  const other = await model.open({ path: 'C:/docs/Other.docx' })
  await assert.rejects(
    () => model.merge(opened.handle, [other.handle]),
    (error) => error.code === MODEL_CODES.INVALID_OP,
  )
})
