/**
 * Unit tests for `ctx.docxModel` (`lib/model/model.js`) over a fake engine and a
 * fake document store: no Electron, x2t or DSH context.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { MODEL_CODES, ModelError } from '../lib/model/model.js'

import { DOCX, PATH, createFakeDocuments, createFakeEngine, createModel, fixtureBlocks } from './fixtures.mjs'

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

test('a redline read annotates tracked runs and a plain read does not (WD-112)', async () => {
  const engine = createFakeEngine(fixtureBlocks('F-TRACKED').blocks)
  const { model } = createModel({ engine })
  const opened = await model.open('C:/docs/F-TRACKED.docx')
  const plain = await model.read(opened.handle, { mode: 'full' })
  assert.equal(plain.text, '[w14:1] Paid to the Respondent.')
  const redline = await model.read(opened.handle, { mode: 'full', redline: true })
  assert.equal(redline.text, '[w14:1] Paid to the <del>r</del><ins>R</ins>espondent.')
})

test('commit refuses a dirty editor and a stale base, then writes through the store', async () => {
  const documents = createFakeDocuments()
  const { model, engine } = createModel({ documents })
  const opened = await model.open(PATH)
  await model.edit(opened.handle, { type: 'replace_paragraph', blockId: 'p:2', text: 'Edited text.' })
  await model.diff(opened.handle)

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
  await model.diff(opened.handle)
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
  await model.diff(opened.handle)
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
test('a commit clears stale and moves the content hash (WD-011, WD-012)', async () => {
  const documents = createFakeDocuments()
  const { model } = createModel({ documents })
  const opened = await model.open(PATH)
  await model.edit(opened.handle, { type: 'replace_paragraph', blockId: 'p:2', text: 'Committed.' })
  await model.diff(opened.handle)
  const before = model.status()[0].contentHash
  const committed = await model.commit(opened.handle)
  const status = model.status()[0]
  assert.equal(status.stale, false)
  assert.notEqual(status.contentHash, before)
  assert.equal(status.contentHash, committed.sha256)
  assert.equal(model.rehydrate(status.contentHash).handle, opened.handle)
  assert.throws(() => model.rehydrate(before), (error) => error.code === MODEL_CODES.SESSION_NOT_FOUND)
  await model.edit(opened.handle, { type: 'replace_paragraph', blockId: 'p:2', text: 'Again.' })
  await model.diff(opened.handle)
  const second = await model.commit(opened.handle)
  assert.equal(second.applied, true)
  assert.equal(documents.state.applied.length, 2)
})
test('merge inserts before FIVE after another fork deletes ONE (WD-039)', async () => {
  const engine = createFakeEngine(fixtureBlocks('F-CLEAN').blocks)
  const { model } = createModel({ engine })
  const opened = await model.open('C:/docs/F-CLEAN.docx')
  const inserter = await model.fork(opened.handle, { label: 'inserter' })
  const deleter = await model.fork(opened.handle, { label: 'deleter' })
  await model.edit(inserter.handle, { type: 'insert_paragraph', index: 4, text: 'INSERT-A' })
  await model.edit(deleter.handle, { type: 'delete_paragraph', blockId: 'w14:1', expectedText: 'ONE' })
  const merged = await model.merge(opened.handle, [inserter.handle, deleter.handle])
  assert.equal(merged.conflicts.length, 0)
  const read = await model.read(opened.handle, { mode: 'full' })
  assert.doesNotMatch(read.text, /ONE/)
  const order = ['TWO', 'THREE', 'FOUR', 'INSERT-A', 'FIVE'].map((text) => read.text.indexOf(text))
  assert.equal(order.every((index) => index >= 0), true)
  assert.deepEqual([...order].sort((left, right) => left - right), order)
})

test('merge adopts a fork table row and a fork-created table (WD-040, WD-041)', async () => {
  const engine = createFakeEngine(fixtureBlocks('F-TABLES').blocks)
  const { model } = createModel({ engine })
  const opened = await model.open('C:/docs/F-TABLES.docx')
  const fork = await model.fork(opened.handle, { label: 'table-task' })
  await model.edit(fork.handle, { type: 'insert_table_row', tableBlockId: 't:a1b2c3d4', cells: ['C', 'D'] })
  const merged = await model.merge(opened.handle, [fork.handle])
  assert.equal(merged.conflicts.length, 0, JSON.stringify(merged.conflicts))
  const read = await model.read(opened.handle, { mode: 'full' })
  assert.match(read.text, /\(table, 2 rows\)/)

  const cleanEngine = createFakeEngine(fixtureBlocks('F-CLEAN').blocks)
  const second = createModel({ engine: cleanEngine }).model
  const cleanOpened = await second.open('C:/docs/F-CLEAN.docx')
  const creator = await second.fork(cleanOpened.handle, { label: 'new-table' })
  await second.edit(creator.handle, { type: 'insert_table_row', cells: ['X', 'Y'], create: true })
  const cleanMerged = await second.merge(cleanOpened.handle, [creator.handle])
  assert.equal(cleanMerged.conflicts.length, 0)
  const diff = await second.diff(cleanOpened.handle)
  assert.equal(diff.changes.some((change) => change.kind === 'table'), true)
})

test('merge adopts a fork-created list item (WD-042)', async () => {
  const engine = createFakeEngine(fixtureBlocks('F-CLEAN').blocks)
  const { model } = createModel({ engine })
  const opened = await model.open('C:/docs/F-CLEAN.docx')
  const fork = await model.fork(opened.handle, { label: 'list-task' })
  await model.edit(fork.handle, { type: 'insert_list_item', afterBlockId: 'w14:5', text: 'ITEM', numbering: 'decimal', level: 0 })
  const merged = await model.merge(opened.handle, [fork.handle])
  assert.equal(merged.conflicts.length, 0)
  assert.equal(merged.operations.some((operation) => operation.op === 'insert_list_item'), true)
  const read = await model.read(opened.handle, { mode: 'full' })
  assert.match(read.text, /ITEM/)
})

test('a failed merge op rolls back this call and reports apply-failed (WD-043, WD-044)', async () => {
  const documents = createFakeDocuments()
  const engine = createFakeEngine()
  const { model } = createModel({ engine, documents })
  const opened = await model.open(PATH)
  const fork = await model.fork(opened.handle, { label: 'failing' })
  await model.edit(fork.handle, { type: 'replace_paragraph', blockId: 'p:2', text: 'First.' })
  await model.edit(fork.handle, { type: 'replace_paragraph', blockId: 'p:3', text: 'Second.' })
  const original = engine.apply
  let replacements = 0
  engine.apply = async (...args) => {
    if (args[1] && args[1].type === 'replace_paragraph' && ++replacements === 2) {
      throw Object.assign(new Error('injected'), { code: 'ENGINE_INVALID_OP' })
    }
    return original(...args)
  }
  const merged = await model.merge(opened.handle, [fork.handle])
  assert.equal(merged.applied, 0)
  assert.equal(merged.conflicts.some((conflict) => conflict.reason === 'apply-failed'), true)
  const read = await model.read(opened.handle, { mode: 'full' })
  assert.doesNotMatch(read.text, /First\./)
  assert.match(read.text, /Respectfully submitted\./)
})

test('commit contributors name the fork task label (WD-046)', async () => {
  const documents = createFakeDocuments()
  const { model } = createModel({ documents })
  const opened = await model.open(PATH)
  const fork = await model.fork(opened.handle, { label: 'contributor-task' })
  await model.edit(fork.handle, { type: 'replace_paragraph', blockId: 'p:3', text: 'Contributed.' })
  await model.merge(opened.handle, [fork.handle])
  await model.diff(opened.handle)
  const committed = await model.commit(opened.handle)
  assert.equal(committed.applied, true)
  const revisions = await model.revisions(opened.handle)
  assert.deepEqual(revisions.commits[0].contributors, ['contributor-task'])
})
test('a commit without a preceding diff writes nothing (WD-126)', async () => {
  const documents = createFakeDocuments()
  const { model } = createModel({ documents })
  const opened = await model.open(PATH)
  await model.edit(opened.handle, { type: 'replace_paragraph', blockId: 'p:2', text: 'Unseen.' })
  await assert.rejects(
    () => model.commit(opened.handle),
    (error) => error.code === MODEL_CODES.REVIEW_REQUIRED,
  )
  assert.equal(documents.state.applied.length, 0)
  await model.diff(opened.handle)
  const committed = await model.commit(opened.handle)
  assert.equal(committed.applied, true)
  assert.equal(documents.state.applied.length, 1)
})
