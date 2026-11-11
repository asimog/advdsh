/**
 * Real-engine describe contract: the sidecar's live text, tracked runs, table
 * ids, ambiguous targets, expected-text errors and opaque drawing runs.
 * Requires the installed Electron, Euro-Office and x2t used by the verifier.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildFixture } from './fixtures-docx.mjs'
import { createDocxEngine, createNodeRuntime } from '../lib/engine/manager.js'
import { resolveEngineConfig } from '../lib/engine/locate.js'

async function withEngine(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workspace-engine-test-'))
  const engine = createDocxEngine(resolveEngineConfig({}), { runtime: createNodeRuntime() })
  try {
    return await fn({ directory, engine })
  } finally {
    await engine.dispose().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
}

test('the real engine describes live text, runs, tables and opaque nodes', { timeout: 180000 }, async () => {
  await withEngine(async ({ directory, engine }) => {
    const tracked = await buildFixture('F-TRACKED', directory)
    const opened = await engine.open({ path: tracked.path, name: tracked.name })
    const described = await engine.describe(opened.sessionId)
    assert.equal(described.blocks[0].text, 'Paid to the Respondent.')
    assert.equal(described.blocks[0].deletedText, 'r')
    assert.deepEqual(
      described.blocks[0].runs.map((run) => [run.text, run.inserted, run.deleted]),
      [['Paid to the ', false, false], ['r', false, true], ['R', true, false], ['espondent.', false, false]],
    )
    await engine.close(opened.sessionId)

    const tables = await buildFixture('F-TABLES', directory)
    const tableDoc = await engine.open({ path: tables.path, name: tables.name })
    const tableDescription = await engine.describe(tableDoc.sessionId)
    const tableIds = tableDescription.blocks.filter((block) => block.kind === 'table').map((block) => block.id)
    assert.equal(tableIds.length, 2)
    assert.match(tableIds[0], /^t:[0-9a-f]{8}$/)
    assert.equal(tableIds[1], `${tableIds[0]}#2`)
    await engine.close(tableDoc.sessionId)

    const bold = await buildFixture('F-BOLD', directory)
    const boldDoc = await engine.open({ path: bold.path, name: bold.name })
    const boldDescription = await engine.describe(boldDoc.sessionId)
    assert.deepEqual(boldDescription.blocks[0].runs.map((run) => run.text), ['plain ', 'BOLD'])
    assert.equal(boldDescription.blocks[0].runs[0].props.bold, false)
    assert.equal(boldDescription.blocks[0].runs[1].props.bold, true)
    await engine.close(boldDoc.sessionId)

    const drawing = await buildFixture('F-DRAWING', directory)
    const drawingDoc = await engine.open({ path: drawing.path, name: drawing.name })
    const drawingDescription = await engine.describe(drawingDoc.sessionId)
    assert.deepEqual(drawingDescription.blocks[1].runs[0], { kind: 'opaque', runIndex: 0, type: 'drawing' })
    await engine.close(drawingDoc.sessionId)
  })
})

test('the real engine reports ambiguous and stale targets', { timeout: 180000 }, async () => {
  await withEngine(async ({ directory, engine }) => {
    const duplicate = await buildFixture('F-DUPID', directory)
    const duplicateDoc = await engine.open({ path: duplicate.path, name: duplicate.name })
    await assert.rejects(
      engine.apply(duplicateDoc.sessionId, { type: 'replace_paragraph', blockId: 'w14:7', text: 'X' }),
      (error) => error.code === 'ENGINE_AMBIGUOUS_TARGET',
    )
    await engine.close(duplicateDoc.sessionId)

    const clean = await buildFixture('F-CLEAN', directory)
    const cleanDoc = await engine.open({ path: clean.path, name: clean.name })
    await assert.rejects(
      engine.apply(cleanDoc.sessionId, {
        type: 'replace_paragraph',
        blockId: 'w14:2',
        expectedText: 'WRONG',
        text: 'TWO-A',
      }),
      (error) => error.code === 'ENGINE_STALE_TARGET',
    )
    const applied = await engine.apply(cleanDoc.sessionId, {
      type: 'replace_paragraph',
      blockId: 'w14:2',
      expectedText: 'TWO',
      text: 'TWO-A',
    })
    assert.equal(applied.affected[0].textBefore, 'TWO')
    const after = await engine.describe(cleanDoc.sessionId)
    assert.equal(after.blocks[1].text, 'TWO-A')
    assert.equal(after.blocks[1].deletedText, 'TWO')
    await engine.close(cleanDoc.sessionId)
  })
})
test('the real engine mints stable paragraph ids and never writes a caller target', { timeout: 180000 }, async () => {
  await withEngine(async ({ directory, engine }) => {
    const noid = await buildFixture('F-NOID', directory)
    const opened = await engine.open({ path: noid.path, name: noid.name })
    const first = await engine.describe(opened.sessionId)
    assert.equal(first.blocks.length, 5)
    assert.equal(first.blocks.every((block) => /^w14:[0-9]+$/.test(block.id)), true)
    const target = path.join(directory, 'must-not-exist.docx')
    const saved = await engine.save(opened.sessionId, { targetPath: target })
    assert.ok(saved.bytes.length > 0)
    await assert.rejects(stat(target), (error) => error.code === 'ENOENT')
    const reopened = await engine.open({ bytes: saved.bytes, name: noid.name })
    const second = await engine.describe(reopened.sessionId)
    assert.deepEqual(second.blocks.map((block) => block.id), first.blocks.map((block) => block.id))
    await engine.close(reopened.sessionId)
    await engine.close(opened.sessionId)

    const clean = await buildFixture('F-CLEAN', directory)
    const tableDoc = await engine.open({ path: clean.path, name: clean.name })
    await assert.rejects(
      engine.apply(tableDoc.sessionId, { type: 'insert_table_row', cells: ['A'] }),
      (error) => error.code === 'ENGINE_TARGET_NOT_FOUND',
    )
    const created = await engine.apply(tableDoc.sessionId, { type: 'insert_table_row', cells: ['A', 'B'], create: true })
    assert.equal(created.facts.tableId !== undefined, true)
    const tableDescription = await engine.describe(tableDoc.sessionId)
    assert.equal(tableDescription.tableCount, 1)
    await engine.close(tableDoc.sessionId)
  })
})
test('the real engine applies run, paragraph, cell and section ops', { timeout: 180000 }, async () => {
  await withEngine(async ({ directory, engine }) => {
    const bold = await buildFixture('F-BOLD', directory)
    const boldDoc = await engine.open({ path: bold.path, name: bold.name })
    await engine.apply(boldDoc.sessionId, { type: 'set_run_props', blockId: 'w14:1', runIndex: 1, expectedText: 'BOLD', props: { bold: false } })
    const boldAfter = await engine.describe(boldDoc.sessionId)
    assert.equal(boldAfter.blocks[0].runs[1].props.bold, false)
    await engine.apply(boldDoc.sessionId, { type: 'set_run_text', blockId: 'w14:1', runIndex: 1, expectedText: 'BOLD', text: 'BOLDER' })
    assert.match((await engine.describe(boldDoc.sessionId)).blocks[0].text, /BOLDER/)
    await engine.close(boldDoc.sessionId)

    const split = await buildFixture('F-SPLIT', directory)
    const splitDoc = await engine.open({ path: split.path, name: split.name })
    await engine.apply(splitDoc.sessionId, { type: 'split_run', blockId: 'w14:1', runIndex: 0, expectedText: 'The Agree', offset: 3 })
    assert.deepEqual((await engine.describe(splitDoc.sessionId)).blocks[0].runs.map((run) => run.text), ['The', ' Agree', 'ment.'])
    await engine.apply(splitDoc.sessionId, { type: 'merge_runs', blockId: 'w14:1', runIndex: 0, expectedText: 'The' })
    assert.deepEqual((await engine.describe(splitDoc.sessionId)).blocks[0].runs.map((run) => run.text), ['The Agree', 'ment.'])
    await engine.close(splitDoc.sessionId)

    const clean = await buildFixture('F-CLEAN', directory)
    const cleanDoc = await engine.open({ path: clean.path, name: clean.name })
    await engine.apply(cleanDoc.sessionId, { type: 'set_paragraph_props', blockId: 'w14:1', props: { align: 'center' } })
    assert.equal((await engine.describe(cleanDoc.sessionId)).blocks[0].props.align, 'center')
    await engine.apply(cleanDoc.sessionId, { type: 'set_section_props', props: { pageWidth: 15840, pageHeight: 12240, orientation: 'landscape' } })
    const section = (await engine.describe(cleanDoc.sessionId)).sections[0]
    assert.equal(section.props.orientation, 'landscape')
    await engine.close(cleanDoc.sessionId)

    const tables = await buildFixture('F-TABLES', directory)
    const tableDoc = await engine.open({ path: tables.path, name: tables.name })
    const tableId = (await engine.describe(tableDoc.sessionId)).blocks.find((block) => block.kind === 'table').id
    await engine.apply(tableDoc.sessionId, { type: 'set_cell_text', tableBlockId: tableId, rowIndex: 0, columnIndex: 1, expectedText: 'B', text: 'C' })
    const rows = (await engine.describe(tableDoc.sessionId)).blocks.find((block) => block.kind === 'table').tableRows
    assert.deepEqual(rows[0], ['A', 'C'])
    await engine.close(tableDoc.sessionId)
  })
})
