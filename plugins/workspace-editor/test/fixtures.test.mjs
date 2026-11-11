/**
 * Wave 0 fixture tests: the ten real DOCX packages and the fake engine's
 * tracked-text, duplicate-id, table, run, delay, failure and cancellation
 * behaviour. These tests do not need Electron or the real sidecar.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { buildFixture, buildFixtures, FIXTURE_NAMES } from './fixtures-docx.mjs'
import { createFakeEngine, fixtureBlocks } from './fixtures.mjs'

/** @param {string} file - DOCX path. @returns {Promise<string>} document.xml. */
async function documentXml(file) {
  const zip = await JSZip.loadAsync(await readFile(file))
  return zip.file('word/document.xml').async('string')
}

test('the ten specification fixtures build as valid DOCX packages', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workspace-editor-fixtures-'))
  try {
    const built = await buildFixtures(directory)
    assert.deepEqual(built.map((entry) => entry.name), [...FIXTURE_NAMES])
    for (const entry of built) {
      const zip = await JSZip.loadAsync(await readFile(entry.path))
      assert.ok(zip.file('[Content_Types].xml'), `${entry.name} has content types`)
      assert.ok(zip.file('word/document.xml'), `${entry.name} has document.xml`)
      assert.ok(zip.file('word/styles.xml'), `${entry.name} has styles.xml`)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('F-CLEAN, F-NOID and F-DUPID carry the specified paragraph identities', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workspace-editor-fixtures-'))
  try {
    const clean = await documentXml((await buildFixture('F-CLEAN', directory)).path)
    assert.equal((clean.match(/<w:p[ >]/g) ?? []).length, 5)
    assert.deepEqual(
      ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'].every((text) => clean.includes(`>${text}</w:t>`)),
      true,
    )
    assert.equal((clean.match(/w14:paraId=/g) ?? []).length, 5)

    const noid = await documentXml((await buildFixture('F-NOID', directory)).path)
    assert.equal((noid.match(/w14:paraId=/g) ?? []).length, 0)

    const dupid = await documentXml((await buildFixture('F-DUPID', directory)).path)
    assert.equal((dupid.match(/w14:paraId="00000007"/g) ?? []).length, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('F-TRACKED, F-SPLIT, F-BOLD, F-TABLES, F-DRAWING and F-LARGE carry their structures', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workspace-editor-fixtures-'))
  try {
    const tracked = await documentXml((await buildFixture('F-TRACKED', directory)).path)
    assert.ok(tracked.includes('<w:del '))
    assert.ok(tracked.includes('<w:ins '))
    assert.ok(tracked.includes('<w:delText xml:space="preserve">r</w:delText>'))
    assert.ok(tracked.includes('>Paid to the <'))
    assert.ok(tracked.includes('>espondent.<'))

    const split = await documentXml((await buildFixture('F-SPLIT', directory)).path)
    assert.ok(split.includes('>The Agree</w:t>'))
    assert.ok(split.includes('>ment.</w:t>'))

    const bold = await documentXml((await buildFixture('F-BOLD', directory)).path)
    assert.ok(bold.includes('<w:pStyle w:val="BodyText"/>'))
    assert.ok(bold.includes('<w:b/>'))

    const tables = await documentXml((await buildFixture('F-TABLES', directory)).path)
    assert.equal((tables.match(/<w:tbl[ >]/g) ?? []).length, 2)
    assert.equal((tables.match(/>A<\/w:t>/g) ?? []).length, 2)
    assert.equal((tables.match(/>B<\/w:t>/g) ?? []).length, 2)

    const drawing = await documentXml((await buildFixture('F-DRAWING', directory)).path)
    assert.ok(drawing.includes('<w:drawing>'))
    assert.ok(drawing.includes('r:embed="rId3"'))

    const large = await documentXml((await buildFixture('F-LARGE', directory)).path)
    assert.equal((large.match(/<w:p[ >]/g) ?? []).length, 500)
    assert.ok(large.includes('>PARA 1</w:t>'))
    assert.ok(large.includes('>PARA 500</w:t>'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('fixtureBlocks covers the ten described documents', () => {
  for (const name of FIXTURE_NAMES) {
    const fixture = fixtureBlocks(name)
    assert.ok(Array.isArray(fixture.blocks), `${name} has blocks`)
    if (name === 'F-LARGE') assert.equal(fixture.blocks.length, 500)
    else assert.ok(fixture.blocks.length > 0, `${name} has at least one block`)
  }
  const tracked = fixtureBlocks('F-TRACKED').blocks[0]
  assert.equal(tracked.text, 'Paid to the Respondent.')
  assert.equal(tracked.deletedText, 'Paid to the rRespondent.')
  const duplicate = fixtureBlocks('F-DUPID').blocks
  assert.deepEqual(duplicate.map((block) => block.id), ['w14:7', 'w14:7'])
  const tables = fixtureBlocks('F-TABLES').blocks.filter((block) => block.kind === 'table')
  assert.deepEqual(tables.map((block) => block.id), ['t:a1b2c3d4', 't:a1b2c3d4#2'])
  assert.equal(fixtureBlocks('F-DRAWING').blocks[1].runs[0].type, 'drawing')
})

test('the fake engine keeps the replaced text as deleted text (WD-109)', async () => {
  const engine = createFakeEngine(fixtureBlocks('F-CLEAN').blocks)
  const opened = await engine.open({ bytes: Buffer.from('not-json'), name: 'F-CLEAN.docx' })
  await engine.apply(opened.sessionId, { type: 'replace_paragraph', blockId: 'w14:2', text: 'TWO-A' })
  const described = await engine.describe(opened.sessionId)
  const block = described.blocks.find((entry) => entry.id === 'w14:2')
  assert.equal(block.text, 'TWO-A')
  assert.equal(block.deletedText, 'TWO')
})

test('the fake engine refuses a duplicate block id (WD-024)', async () => {
  const engine = createFakeEngine(fixtureBlocks('F-DUPID').blocks)
  const opened = await engine.open({ bytes: Buffer.from('not-json'), name: 'F-DUPID.docx' })
  await assert.rejects(
    engine.apply(opened.sessionId, { type: 'replace_paragraph', blockId: 'w14:7', text: 'X' }),
    (error) => error.code === 'ENGINE_AMBIGUOUS_TARGET',
  )
})

test('the fake engine supports table, run and list operations', async () => {
  const tables = createFakeEngine(fixtureBlocks('F-TABLES').blocks)
  const tableSession = (await tables.open({ bytes: Buffer.from('not-json'), name: 'F-TABLES.docx' })).sessionId
  await tables.apply(tableSession, {
    type: 'set_cell_text',
    blockId: 't:a1b2c3d4',
    rowIndex: 0,
    columnIndex: 1,
    expectedText: 'B',
    text: 'C',
  })
  await tables.apply(tableSession, {
    type: 'insert_table_column',
    blockId: 't:a1b2c3d4',
    columnIndex: 2,
    cells: ['D'],
  })
  const tableDescription = await tables.describe(tableSession)
  assert.deepEqual(tableDescription.blocks.find((block) => block.id === 't:a1b2c3d4').tableRows[0], ['A', 'C', 'D'])

  const bold = createFakeEngine(fixtureBlocks('F-BOLD').blocks)
  const boldSession = (await bold.open({ bytes: Buffer.from('not-json'), name: 'F-BOLD.docx' })).sessionId
  await bold.apply(boldSession, { type: 'split_run', blockId: 'w14:1', runIndex: 1, expectedText: 'BOLD', offset: 2 })
  const boldDescription = await bold.describe(boldSession)
  assert.deepEqual(boldDescription.blocks[0].runs.map((entry) => entry.text), ['plain ', 'BO', 'LD'])

  const clean = createFakeEngine(fixtureBlocks('F-CLEAN').blocks)
  const cleanSession = (await clean.open({ bytes: Buffer.from('not-json'), name: 'F-CLEAN.docx' })).sessionId
  await clean.apply(cleanSession, {
    type: 'insert_list_item',
    afterBlockId: 'w14:5',
    text: 'ITEM',
    numbering: 'decimal',
    level: 0,
  })
  const cleanDescription = await clean.describe(cleanSession)
  assert.equal(cleanDescription.blocks.at(-1).numbering.level, 0)
})

test('the fake engine supports delay, failure injection and cancellation', async () => {
  const delayed = createFakeEngine(fixtureBlocks('F-CLEAN').blocks)
  const delayedSession = (await delayed.open({ bytes: Buffer.from('not-json'), name: 'F-CLEAN.docx' })).sessionId
  delayed.setDelay(300)
  const controller = new AbortController()
  const pending = delayed.apply(
    delayedSession,
    { type: 'replace_paragraph', blockId: 'w14:2', text: 'X' },
    { signal: controller.signal },
  )
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(pending, (error) => error.code === 'ENGINE_CANCELLED')
  const afterCancel = await delayed.describe(delayedSession)
  assert.equal(afterCancel.blocks.find((block) => block.id === 'w14:2').text, 'TWO')

  const failing = createFakeEngine(fixtureBlocks('F-CLEAN').blocks)
  const failingSession = (await failing.open({ bytes: Buffer.from('not-json'), name: 'F-CLEAN.docx' })).sessionId
  failing.failNext('apply', 'ENGINE_STALE_TARGET')
  await assert.rejects(
    failing.apply(failingSession, { type: 'replace_paragraph', blockId: 'w14:2', text: 'X' }),
    (error) => error.code === 'ENGINE_STALE_TARGET',
  )
})

test('the fake engine refuses a run op on an opaque drawing (WD-027/WD-028)', async () => {
  const engine = createFakeEngine(fixtureBlocks('F-DRAWING').blocks)
  const opened = await engine.open({ bytes: Buffer.from('not-json'), name: 'F-DRAWING.docx' })
  await assert.rejects(
    engine.apply(opened.sessionId, {
      type: 'set_run_text',
      blockId: 'w14:2',
      runIndex: 0,
      expectedText: '',
      text: 'X',
    }),
    (error) => error.code === 'ENGINE_UNSUPPORTED',
  )
})
