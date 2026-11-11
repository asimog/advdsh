/**
 * Real-engine describe contract: the sidecar's live text, tracked runs, table
 * ids, ambiguous targets, expected-text errors and opaque drawing runs.
 * Requires the installed Electron, Euro-Office and x2t used by the verifier.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
