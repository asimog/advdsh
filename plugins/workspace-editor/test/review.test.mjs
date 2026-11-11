/**
 * Unit tests for the legal analyzers and the `workspace-legal-review` row:
 * planted defects, stable codes, code filtering, analyzer registration and the
 * `doc_analyze` tool over a fake model.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply as applyReview } from '../lib/review/index.js'
import { ANALYZER_CODES, createLegalAnalyzers } from '../lib/review/analyzers.js'
import { PATH, createModel } from './fixtures.mjs'

/** @param {string} id - block id. @param {number} index - block index. @param {string} text - block text. @param {object} [extra] - extra block fields. */
function paragraph(id, index, text, extra = {}) {
  return { id, index, kind: 'paragraph', text, ...extra }
}

/** A document with one planted defect per analyzer. */
function defectiveBlocks() {
  return [
    paragraph('p:1', 0, 'MEMORANDUM OF LAW', { style: 'heading1', level: 0 }),
    paragraph('p:2', 1, 'Introduction', { style: 'heading2', level: 1 }),
    paragraph('p:3', 2, 'Deep Heading', { style: 'heading4', level: 3 }),
    paragraph('p:4', 3, '   ', { style: 'heading2', level: 1 }),
    paragraph('p:5', 4, 'Statement of Facts', { style: 'heading2', level: 1 }),
    paragraph('p:6', 5, 'Statement of Facts', { style: 'heading2', level: 1 }),
    paragraph('p:7', 6, 'TABLE OF CONTENTS'),
    paragraph('p:8', 7, 'Introduction....... 1'),
    paragraph('p:9', 8, 'Missing Section....... 2'),
    paragraph('p:10', 9, 'The "Agreement" is dated 1 January 2026.', {}),
    paragraph('p:11', 10, 'This Agreement (the "Agreement") is made between the parties.', {}),
    paragraph('p:12', 11, 'First item', { numbering: { level: 0 } }),
    paragraph('p:13', 12, 'Deep item', { numbering: { level: 2 } }),
    paragraph('p:14', 13, 'The NDA applies to all disclosures.', {}),
    paragraph('p:15', 14, 'See Exhibit Z and Exhibit A.', {}),
    paragraph('p:16', 15, 'Authority: (2020) 5 SCC 12 and 2021 SCC 7.', {}),
    paragraph('p:17', 16, 'TODO: insert the amount'),
    paragraph('p:18', 17, ''),
    paragraph('p:19', 18, ''),
    paragraph('p:20', 19, ''),
    paragraph('p:21', 20, 'Exhibit A'),
    paragraph('p:22', 21, 'Defined ("RTI") below.', {}),
    { id: 't:1', index: 22, kind: 'table', text: '', rows: 2, tableRows: [['', ''], ['a', 'b']] },
  ]
}

/** @param {Array<object>} findings - analyzer findings. @returns {Set<string>} codes. */
function codesOf(findings) {
  return new Set(findings.map((finding) => finding.code))
}

test('every analyzer reports its planted defect with a stable code', async () => {
  const blocks = defectiveBlocks()
  const analyzers = createLegalAnalyzers()
  const findings = []
  for (const analyzer of analyzers) {
    const input = { blocks, diff: { changed: false, counts: { total: 0 } } }
    findings.push(...(await analyzer(input)))
  }
  const codes = codesOf(findings)
  for (const code of [
    ANALYZER_CODES.HEADING_LEVEL_SKIP,
    ANALYZER_CODES.HEADING_EMPTY,
    ANALYZER_CODES.HEADING_DUPLICATE,
    ANALYZER_CODES.TOC_MISMATCH,
    ANALYZER_CODES.LIST_LEVEL_JUMP,
    ANALYZER_CODES.DEFINED_TERM_ORDER,
    ANALYZER_CODES.UNDEFINED_ABBREVIATION,
    ANALYZER_CODES.CROSS_REFERENCE_MISSING,
    ANALYZER_CODES.CITATION_SHAPE,
    ANALYZER_CODES.PLACEHOLDER_TEXT,
    ANALYZER_CODES.EMPTY_PARAGRAPH_RUN,
    ANALYZER_CODES.TABLE_HEADER_MISSING,
  ]) {
    assert.ok(codes.has(code), `missing ${code}; found ${[...codes].join(', ')}`)
  }
  const cross = findings.find((finding) => finding.code === ANALYZER_CODES.CROSS_REFERENCE_MISSING)
  assert.deepEqual(cross.blocks, ['p:15'])
  const abbreviation = findings.find((finding) => finding.code === ANALYZER_CODES.UNDEFINED_ABBREVIATION)
  assert.deepEqual(abbreviation.blocks, ['p:14'])
  const toc = findings.find((finding) => finding.code === ANALYZER_CODES.TOC_MISMATCH)
  assert.deepEqual(toc.blocks, ['p:9'])
  assert.ok(findings.every((finding) => typeof finding.code === 'string' && typeof finding.severity === 'string'))
})

test('analyzers honour an explicit code filter', async () => {
  const analyzers = createLegalAnalyzers()
  const checks = new Set([ANALYZER_CODES.PLACEHOLDER_TEXT])
  const findings = []
  for (const analyzer of analyzers) findings.push(...(await analyzer({ blocks: defectiveBlocks(), diff: { changed: false, counts: { total: 0 } }, checks })))
  assert.deepEqual([...codesOf(findings)], [ANALYZER_CODES.PLACEHOLDER_TEXT])
})

test('a clean document produces no findings', async () => {
  const blocks = [
    paragraph('p:1', 0, 'MEMORANDUM OF LAW', { style: 'heading1', level: 0 }),
    paragraph('p:2', 1, 'Introduction', { style: 'heading2', level: 1 }),
    paragraph('p:3', 2, 'The parties agree as follows.', {}),
  ]
  const findings = []
  for (const analyzer of createLegalAnalyzers()) findings.push(...(await analyzer({ blocks, diff: { changed: false, counts: { total: 0 } } })))
  assert.deepEqual(findings, [])
})

/** @param {object} model - model with `check`/`addAnalyzer`. */
function createFakeReviewCtx(model) {
  const tools = new Map()
  const analyzers = []
  const skills = []
  const disposers = []
  const ctx = {
    docxModel: {
      addAnalyzer: (analyzer) => {
        analyzers.push(analyzer)
        return () => {
          const at = analyzers.indexOf(analyzer)
          if (at !== -1) analyzers.splice(at, 1)
        }
      },
      check: model.check,
    },
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    provide: () => {},
    inject: (keys, callback) => {
      if (keys.includes('skills')) callback({ ...ctx, skills: { register: (entry) => { skills.push(entry); return () => {} } } })
    },
  }
  applyReview(ctx)
  return { tools, analyzers, skills, disposers }
}

test('the review row registers analyzers, the doc_analyze tool and the skill', async () => {
  const fake = createFakeReviewCtx({
    check: async () => ({
      handle: 'doc-1',
      ok: false,
      codes: ['PENDING_REVISIONS', ANALYZER_CODES.PLACEHOLDER_TEXT],
      findings: [
        { code: 'PENDING_REVISIONS', severity: 'info', message: '2 uncommitted changes' },
        { code: ANALYZER_CODES.PLACEHOLDER_TEXT, severity: 'warning', message: 'placeholder text: TODO', blocks: ['p:17'] },
      ],
    }),
  })
  assert.equal(fake.analyzers.length, 10)
  assert.equal(fake.skills.length, 1)
  assert.equal(fake.skills[0].name, 'legal-document-review')
  assert.equal(fake.skills[0].source, 'runtime')
  assert.match(fake.skills[0].content, /doc_analyze/)
  const tool = fake.tools.get('doc_analyze')
  assert.ok(tool, 'doc_analyze is registered')
  const value = await tool.execute({ doc: 'doc-1', checks: [ANALYZER_CODES.PLACEHOLDER_TEXT] })
  assert.equal(value.doc, 'doc-1')
  assert.equal(value.ok, false)
  assert.deepEqual(value.codes, [ANALYZER_CODES.PLACEHOLDER_TEXT])
  assert.equal(value.findings.length, 1, 'pending revisions are not a legal finding')
  assert.deepEqual(value.findings[0].blocks, ['p:17'])
  const rendered = tool.output.render({}, value)
  assert.match(rendered[0].text, /PLACEHOLDER_TEXT/)
})

test('analyzers registered on the model feed model.check', async () => {
  const { model } = createModel()
  const opened = await model.open(PATH)
  const cleanCheck = await model.check(opened.handle)
  assert.equal(cleanCheck.ok, true)
  const dispose = model.addAnalyzer(() => [{ code: 'PLANTED', severity: 'warning', message: 'planted defect', blocks: ['p:2'] }])
  const planted = await model.check(opened.handle)
  assert.equal(planted.ok, false)
  assert.deepEqual(planted.codes, ['PLANTED'])
  dispose()
  assert.equal((await model.check(opened.handle)).ok, true)
})
test('the citation analyzer counts every valid citation in a block (WD-106)', async () => {
  const findings = []
  for (const analyzer of createLegalAnalyzers()) {
    findings.push(...await analyzer({ blocks: [{ id: 'w14:1', index: 0, kind: 'paragraph', text: 'See (2019) 5 SCC 1 and (2020) 3 SCC 45.' }] }))
  }
  assert.deepEqual(findings, [])
})
