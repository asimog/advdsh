/**
 * Engine describe contract: the markup view shape, live text, runs, tables,
 * sections, opaque nodes and the node limit.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMarkupView, liveText } from '../lib/model/blocks.js'
import { describePayload, fixtureBlocks } from './fixtures.mjs'

/** @param {string} name - fixture name. @returns {object} markup view. */
function view(name) {
  const fixture = fixtureBlocks(name)
  return buildMarkupView({ blocks: describePayload(fixture.blocks).blocks, sections: fixture.sections })
}

test('live text excludes deleted runs and the paragraph end mark', () => {
  assert.equal(liveText(fixtureBlocks('F-TRACKED').blocks[0]), 'Paid to the Respondent.')
  assert.equal(liveText({ text: 'ONE\r\n' }), 'ONE')
  assert.equal(liveText({ text: 'ONE\n' }), 'ONE')
})

test('the markup view reports paragraph runs and properties (WD-026)', () => {
  const bold = view('F-BOLD')
  assert.equal(bold.schema, 1)
  assert.equal(bold.nodes[0].kind, 'paragraph')
  assert.equal(bold.nodes[0].props.style, 'Body Text')
  assert.deepEqual(bold.nodes[0].runs.map((run) => run.text), ['plain ', 'BOLD'])
  assert.equal(bold.nodes[0].runs[0].props.bold, false)
  assert.equal(bold.nodes[0].runs[1].props.bold, true)

  const tracked = view('F-TRACKED')
  assert.equal(tracked.nodes[0].text, 'Paid to the Respondent.')
  assert.deepEqual(tracked.nodes[0].runs.map((run) => [run.text, run.inserted, run.deleted]), [
    ['Paid to the ', false, false],
    ['r', false, true],
    ['R', true, false],
    ['espondent.', false, false],
  ])
})

test('the markup view reports a drawing as an opaque run (WD-027)', () => {
  const drawing = view('F-DRAWING')
  assert.deepEqual(drawing.nodes[1].runs[0], { kind: 'opaque', runIndex: 0, type: 'drawing' })
  assert.equal(drawing.nodes[1].text, '')
})

test('the markup view reports tables, cells and sections', () => {
  const tables = view('F-TABLES')
  assert.equal(tables.nodes[1].kind, 'table')
  assert.deepEqual(tables.nodes[1].rows[0].cells.map((cell) => cell.text), ['A', 'B'])
  assert.equal(tables.nodes[2].id, 't:a1b2c3d4#2')

  const clean = view('F-CLEAN')
  assert.equal(clean.nodes.at(-1).kind, 'section')
  assert.equal(clean.nodes.at(-1).props.orientation, 'portrait')
})

test('the markup view truncates at the node limit and reports next (WD-029)', () => {
  // A markup node counts as one node per paragraph and one per run: F-LARGE has
  // 500 one-run paragraphs, so 400 nodes are 200 paragraphs and next is 200.
  const large = describePayload(fixtureBlocks('F-LARGE').blocks).blocks
    .map((block) => ({ ...block, runs: [{ text: block.text }] }))
  const limited = buildMarkupView({ blocks: large }, { limitNodes: 400 })
  assert.equal(limited.nodes.length, 200)
  assert.equal(limited.truncated, true)
  assert.equal(limited.next, 200)
  const tail = buildMarkupView({ blocks: large }, { from: 400, limitNodes: 200 })
  assert.equal(tail.nodes.length, 100)
  assert.equal(tail.nodes[0].index, 400)
  assert.equal(tail.truncated, false)
  assert.equal(tail.next, null)
})
