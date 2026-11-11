/**
 * Shared fixtures for the model and tool unit tests: described-document
 * fixtures for the ten specification documents, an in-memory engine with the
 * real request/response shapes (including tracked text, run/markup data,
 * tables, duplicate ids, delayed calls, failure injection and cancellation),
 * and a fake editorDocuments service. No Electron, x2t or DSH context.
 */
import { createHash } from 'node:crypto'
import { diffBlocks } from '../lib/engine/diff.js'
import { createDocxModel } from '../lib/model/model.js'
import { resolveDocumentPath } from '../lib/scope.js'

export const DOCX = Buffer.from('fake-docx-bytes')

/** @returns {Array<object>} the legacy small described-document fixture. */
export function initialBlocks() {
  return [
    { id: 'p:1', index: 0, kind: 'paragraph', text: 'IN THE UNITED STATES DISTRICT COURT', style: 'heading1', level: 0 },
    { id: 'p:2', index: 1, kind: 'paragraph', text: 'Plaintiff seeks entry of an ex parte temporary restraining order.' },
    { id: 't:1', index: 2, kind: 'table', text: '', rows: 1, tableRows: [['A', 'B']] },
    { id: 'p:3', index: 3, kind: 'paragraph', text: 'Respectfully submitted.' },
  ]
}

const TABLE_HASH = 'a1b2c3d4'

/** @param {Array<object>} blocks - described blocks. @returns {object} describe payload. */
export function describePayload(blocks) {
  return {
    blocks: blocks.map((block, index) => ({ ...block, index })),
    paragraphCount: blocks.filter((block) => block.kind === 'paragraph').length,
    tableCount: blocks.filter((block) => block.kind === 'table').length,
    elementsCount: blocks.length,
  }
}

/**
 * A described-block fixture for one specification document.
 * @param {string} name - `F-CLEAN`, `F-TRACKED`, `F-NOID`, `F-DUPID`, `F-TABLES`,
 * `F-SPLIT`, `F-BOLD`, `F-DRAWING`, `F-WORDS` or `F-LARGE`.
 * @returns {{ blocks: Array<object>, sections: Array<object> }} fixture document.
 */
export function fixtureBlocks(name) {
  const clean = () => ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'].map((text, index) => ({
    id: `w14:${index + 1}`,
    index,
    kind: 'paragraph',
    text,
  }))
  if (name === 'F-CLEAN') {
    return {
      blocks: clean(),
      sections: [{ index: 0, kind: 'section', props: { pageWidth: 12240, pageHeight: 15840, orientation: 'portrait' } }],
    }
  }
  if (name === 'F-TRACKED') {
    return {
      blocks: [{
        id: 'w14:1',
        index: 0,
        kind: 'paragraph',
        text: 'Paid to the Respondent.',
        deletedText: 'Paid to the rRespondent.',
        runs: [
          { runIndex: 0, text: 'Paid to the ', props: {}, inserted: false, deleted: false, author: null },
          { runIndex: 1, text: 'r', props: {}, inserted: false, deleted: true, author: 'fixture' },
          { runIndex: 2, text: 'R', props: {}, inserted: true, deleted: false, author: 'fixture' },
          { runIndex: 3, text: 'espondent.', props: {}, inserted: false, deleted: false, author: null },
        ],
      }],
      sections: [],
    }
  }
  if (name === 'F-NOID') {
    return { blocks: clean().map((block, index) => ({ ...block, id: `p:${index + 1}` })), sections: [] }
  }
  if (name === 'F-DUPID') {
    return {
      blocks: [
        { id: 'w14:7', index: 0, kind: 'paragraph', text: 'ALPHA' },
        { id: 'w14:7', index: 1, kind: 'paragraph', text: 'BETA' },
      ],
      sections: [],
    }
  }
  if (name === 'F-TABLES') {
    return {
      blocks: [
        { id: 'w14:1', index: 0, kind: 'paragraph', text: 'INTRO' },
        { id: `t:${TABLE_HASH}`, index: 1, kind: 'table', text: 'A\tB', rows: 1, tableRows: [['A', 'B']] },
        { id: `t:${TABLE_HASH}#2`, index: 2, kind: 'table', text: 'A\tB', rows: 1, tableRows: [['A', 'B']] },
      ],
      sections: [],
    }
  }
  if (name === 'F-SPLIT') {
    return {
      blocks: [{
        id: 'w14:1',
        index: 0,
        kind: 'paragraph',
        text: 'The Agreement.',
        runs: [
          { runIndex: 0, text: 'The Agree', props: {}, inserted: false, deleted: false, author: null },
          { runIndex: 1, text: 'ment.', props: {}, inserted: false, deleted: false, author: null },
        ],
      }],
      sections: [],
    }
  }
  if (name === 'F-BOLD') {
    return {
      blocks: [{
        id: 'w14:1',
        index: 0,
        kind: 'paragraph',
        text: 'plain BOLD',
        style: 'Body Text',
        props: { style: 'Body Text', align: 'left' },
        runs: [
          { runIndex: 0, text: 'plain ', props: { bold: false }, inserted: false, deleted: false, author: null },
          { runIndex: 1, text: 'BOLD', props: { bold: true }, inserted: false, deleted: false, author: null },
        ],
      }],
      sections: [],
    }
  }
  if (name === 'F-DRAWING') {
    return {
      blocks: [
        { id: 'w14:1', index: 0, kind: 'paragraph', text: 'BEFORE' },
        {
          id: 'w14:2',
          index: 1,
          kind: 'paragraph',
          text: '',
          runs: [{ kind: 'opaque', runIndex: 0, type: 'drawing' }],
        },
        { id: 'w14:3', index: 2, kind: 'paragraph', text: 'AFTER' },
      ],
      sections: [],
    }
  }
  if (name === 'F-WORDS') {
    return {
      blocks: [{ id: 'w14:1', index: 0, kind: 'paragraph', text: 'The seller shall deliver the goods.' }],
      sections: [],
    }
  }
  if (name === 'F-LARGE') {
    return {
      blocks: Array.from({ length: 500 }, (_, index) => ({
        id: `w14:${index + 1}`,
        index,
        kind: 'paragraph',
        text: `PARA ${index + 1}`,
      })),
      sections: [],
    }
  }
  throw new Error(`unknown fixture: ${name}`)
}

/** @param {string} code - engine error code. @param {string} message - operator text. */
function engineError(code, message) {
  return Object.assign(new Error(message), { code })
}

/** @param {Array<object>} blocks - current blocks. @param {object} target - id or index. */
function findOne(blocks, target) {
  if (typeof target === 'string') {
    const hits = blocks.filter((block) => block.id === target)
    if (hits.length > 1) throw engineError('ENGINE_AMBIGUOUS_TARGET', `block id is not unique: ${target}`)
    return hits[0]
  }
  if (typeof target === 'number') return blocks.find((block) => block.index === target)
  return undefined
}

/** @param {object} block - paragraph block. @returns {string} live text from runs. */
function liveTextOf(block) {
  if (!Array.isArray(block.runs)) return typeof block.text === 'string' ? block.text : ''
  return block.runs.filter((run) => run.deleted !== true).map((run) => run.text ?? '').join('')
}

/**
 * A minimal in-memory engine with the real engine's request/response shapes.
 * @param {Array<object>} blocks - starting document.
 * @param {{ delayMs?: number, failOn?: Record<string, { code: string, message?: string, times?: number }> }} [options] - test controls.
 */
export function createFakeEngine(blocks = initialBlocks(), options = {}) {
  const sessions = new Map()
  let counter = 0
  let serial = 0
  const calls = []
  const controls = {
    delayMs: Number.isFinite(options.delayMs) ? options.delayMs : 0,
    failures: new Map(),
    applied: 0,
  }
  for (const [method, failure] of Object.entries(options.failOn ?? {})) {
    controls.failures.set(method, { times: failure.times ?? 1, code: failure.code, message: failure.message })
  }

  /** Wait, honour cancellation, then fail once when a failure was queued. */
  async function gate(method, signal) {
    if (signal && signal.aborted) throw engineError('ENGINE_CANCELLED', `${method} was cancelled`)
    if (controls.delayMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, controls.delayMs)
        const onAbort = () => {
          clearTimeout(timer)
          reject(engineError('ENGINE_CANCELLED', `${method} was cancelled`))
        }
        if (signal) signal.addEventListener('abort', onAbort, { once: true })
        setTimeout(() => signal && signal.removeEventListener('abort', onAbort), controls.delayMs + 5).unref?.()
      })
    }
    if (signal && signal.aborted) throw engineError('ENGINE_CANCELLED', `${method} was cancelled`)
    const failure = controls.failures.get(method)
    if (failure !== undefined) {
      failure.times -= 1
      if (failure.times <= 0) controls.failures.delete(method)
      throw engineError(failure.code, failure.message ?? `${method} injected failure`)
    }
  }

  /** @param {string} sessionId - engine session. */
  function sessionOf(sessionId) {
    const session = sessions.get(sessionId)
    if (session === undefined) throw engineError('ENGINE_SESSION_NOT_FOUND', 'no session')
    return session
  }

  /** @param {object} session - engine session. */
  function reindex(session) {
    session.blocks.forEach((block, index) => { block.index = index })
  }

  const engine = {
    calls,
    controls,
    get openCount() { return calls.filter((call) => call.method === 'open').length },
    /** @param {number} ms - delay before every method. */
    setDelay(ms) { controls.delayMs = Number.isFinite(ms) && ms > 0 ? ms : 0 },
    /** @param {string} method - method to fail once. @param {string} code - error code. @param {number} [times] - failures. */
    failNext(method, code, times = 1) {
      controls.failures.set(method, { times, code, message: `${method} injected failure` })
    },
    async open(input, openOptions) {
      calls.push({ method: 'open', input, options: openOptions })
      const sessionId = `s${++serial}`
      let starting = blocks
      let sections = []
      if (input && input.bytes !== undefined) {
        try {
          const parsed = JSON.parse(Buffer.from(input.bytes).toString('utf8'))
          if (Array.isArray(parsed)) starting = parsed
          else if (parsed && Array.isArray(parsed.blocks)) {
            starting = parsed.blocks
            sections = Array.isArray(parsed.sections) ? parsed.sections : []
          }
        } catch (error) {
          // Not a fixture snapshot: open the fixture document instead.
        }
      }
      const copy = JSON.parse(JSON.stringify(starting))
      reindex({ blocks: copy })
      sessions.set(sessionId, {
        blocks: copy,
        base: JSON.parse(JSON.stringify(copy)),
        sections: JSON.parse(JSON.stringify(sections)),
        revision: 0,
      })
      const description = describePayload(copy)
      return {
        sessionId,
        name: input && input.name,
        author: openOptions && openOptions.author,
        blocks: description.blocks.length,
        paragraphs: description.paragraphCount,
        tables: description.tableCount,
      }
    },
    async describe(sessionId, describeOptions = {}) {
      calls.push({ method: 'describe', sessionId })
      await gate('describe', describeOptions.signal)
      const session = sessionOf(sessionId)
      return { ...describePayload(session.blocks), sections: session.sections }
    },
    async apply(sessionId, op, applyOptions = {}) {
      calls.push({ method: 'apply', sessionId, op })
      await gate('apply', applyOptions.signal)
      const session = sessionOf(sessionId)
      const blocksNow = session.blocks
      const result = applyOp(session, op)
      controls.applied += 1
      reindex(session)
      return { revision: ++session.revision, tracked: op.track !== false, ...result }
    },
    async diff(sessionId, diffOptions = {}) {
      calls.push({ method: 'diff', sessionId })
      await gate('diff', diffOptions && diffOptions.signal)
      const session = sessionOf(sessionId)
      const result = diffBlocks(session.base, session.blocks.map((block, index) => ({ ...block, index })))
      return { ...result, baseHash: 'base-hash' }
    },
    async save(sessionId, saveOptions = {}) {
      calls.push({ method: 'save', sessionId, options: saveOptions })
      await gate('save', saveOptions.signal)
      const session = sessionOf(sessionId)
      const bytes = Buffer.from(JSON.stringify({ blocks: session.blocks, sections: session.sections }), 'utf8')
      return {
        bytes,
        path: saveOptions.targetPath,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        revision: ++session.revision,
      }
    },
    async close(sessionId) {
      calls.push({ method: 'close', sessionId })
      sessions.delete(sessionId)
      return { closed: true }
    },
  }

  /** Apply one op against the session's mutable blocks. */
  function applyOp(session, op) {
    const blocksNow = session.blocks
    if (!op || typeof op.type !== 'string') throw engineError('ENGINE_BAD_OP', 'op needs a type')
    if (op.type === 'replace_paragraph') {
      const target = findOne(blocksNow, op.blockId ?? op.index)
      if (target === undefined) throw engineError('ENGINE_TARGET_NOT_FOUND', 'target missing')
      if (target.kind !== 'paragraph') throw engineError('ENGINE_WRONG_KIND', 'target is not a paragraph')
      if (op.expectedText !== undefined && liveTextOf(target) !== op.expectedText) {
        throw engineError('ENGINE_STALE_TARGET', 'stale')
      }
      const textBefore = liveTextOf(target)
      if (typeof op.text !== 'string') throw engineError('ENGINE_BAD_OP', 'text must be a string')
      target.text = op.text
      if (op.track !== false && textBefore !== op.text) target.deletedText = textBefore
      if (Array.isArray(target.runs)) {
        const props = target.runs[0] && target.runs[0].props ? target.runs[0].props : {}
        target.runs = [
          ...(textBefore === '' ? [] : [{ runIndex: 0, text: textBefore, props, inserted: false, deleted: true, author: 'agent' }]),
          ...(op.text === '' ? [] : [{ runIndex: textBefore === '' ? 0 : 1, text: op.text, props, inserted: true, deleted: false, author: 'agent' }]),
        ]
      }
      return {
        affected: [{ id: target.id, index: target.index, kind: target.kind, textBefore, textAfter: op.text }],
      }
    }
    if (op.type === 'replace_text') {
      if (typeof op.find !== 'string' || op.find === '') throw engineError('ENGINE_BAD_OP', 'find must be a non-empty string')
      if (typeof op.replace !== 'string') throw engineError('ENGINE_BAD_OP', 'replace must be a string')
      const targets = op.blockId === undefined
        ? blocksNow
        : [findOne(blocksNow, op.blockId)].filter(Boolean)
      if (targets.length === 0) throw engineError('ENGINE_TARGET_NOT_FOUND', 'target missing')
      const affected = []
      let replacements = 0
      for (const block of targets) {
        const before = liveTextOf(block)
        const parts = before.split(op.find)
        if (parts.length === 1) continue
        const count = parts.length - 1
        replacements += count
        block.text = parts.join(op.replace)
        block.deletedText = before
        const oldRuns = Array.isArray(block.runs) ? block.runs : []
        const props = oldRuns[0] && oldRuns[0].props ? oldRuns[0].props : {}
        block.runs = [
          { runIndex: 0, text: before, props, inserted: false, deleted: true, author: 'agent' },
          { runIndex: 1, text: block.text, props, inserted: true, deleted: false, author: 'agent' },
        ]
        affected.push({ id: block.id, index: block.index, kind: block.kind, textBefore: before, textAfter: block.text })
      }
      return { replacements, affected }
    }
    if (op.type === 'insert_paragraph' || op.type === 'insert_list_item') {
      if (typeof op.text !== 'string') throw engineError('ENGINE_BAD_OP', 'text must be a string')
      let at = Number.isFinite(op.index) ? Math.max(0, Math.min(op.index, blocksNow.length)) : blocksNow.length
      if (typeof op.afterBlockId === 'string') {
        const anchor = findOne(blocksNow, op.afterBlockId)
        if (anchor === undefined) throw engineError('ENGINE_TARGET_NOT_FOUND', 'anchor missing')
        at = anchor.index + 1
      } else if (typeof op.beforeBlockId === 'string') {
        const anchor = findOne(blocksNow, op.beforeBlockId)
        if (anchor === undefined) throw engineError('ENGINE_TARGET_NOT_FOUND', 'anchor missing')
        at = anchor.index
      }
      const block = {
        id: `p:x${++counter}`,
        index: at,
        kind: 'paragraph',
        text: op.text,
        ...(op.type === 'insert_list_item' ? { numbering: { level: op.level ?? 0 }, style: 'ListParagraph' } : {}),
        ...(op.style === undefined ? {} : { style: op.style }),
      }
      blocksNow.splice(at, 0, block)
      reindex(session)
      return {
        affected: [{ id: block.id, index: block.index, kind: 'paragraph', textBefore: null, textAfter: block.text }],
      }
    }
    if (op.type === 'delete_paragraph') {
      const target = findOne(blocksNow, op.blockId ?? op.index)
      if (target === undefined) throw engineError('ENGINE_TARGET_NOT_FOUND', 'target missing')
      if (op.expectedText !== undefined && liveTextOf(target) !== op.expectedText) {
        throw engineError('ENGINE_STALE_TARGET', 'stale')
      }
      blocksNow.splice(target.index, 1)
      return { affected: [{ id: target.id, index: target.index, kind: target.kind, textBefore: liveTextOf(target), textAfter: null }] }
    }
    if (op.type === 'insert_table_row') {
      const table = findTable(blocksNow, op)
      if (table === undefined) {
        if (op.create !== true) throw engineError('ENGINE_TARGET_NOT_FOUND', 'no table in document')
        const created = {
          id: `t:${TABLE_HASH}`,
          index: blocksNow.length,
          kind: 'table',
          text: '',
          rows: 1,
          tableRows: [Array.isArray(op.cells) ? op.cells : []],
        }
        blocksNow.push(created)
        return { affected: [], tableId: created.id, rowsBefore: 0, rowsAfter: 1 }
      }
      const rowsBefore = table.rows
      table.tableRows = [...(table.tableRows ?? []), Array.isArray(op.cells) ? op.cells : []]
      table.rows = table.tableRows.length
      table.text = table.tableRows.map((cells) => cells.join('\t')).join('\n')
      return { affected: [], tableId: table.id, rowsBefore, rowsAfter: table.rows }
    }
    if (op.type === 'delete_table_row') {
      const table = findTable(blocksNow, op)
      if (table === undefined) throw engineError('ENGINE_TARGET_NOT_FOUND', 'no table')
      const rowIndex = Number.isFinite(op.rowIndex) ? op.rowIndex : (table.tableRows ?? []).length - 1
      if (rowIndex < 0 || rowIndex >= (table.tableRows ?? []).length) throw engineError('ENGINE_TARGET_NOT_FOUND', 'row missing')
      table.tableRows.splice(rowIndex, 1)
      table.rows = table.tableRows.length
      table.text = table.tableRows.map((cells) => cells.join('\t')).join('\n')
      return { affected: [], tableId: table.id, rowIndex, rowsAfter: table.rows }
    }
    if (op.type === 'insert_table_column') {
      const table = findTable(blocksNow, op)
      if (table === undefined) throw engineError('ENGINE_TARGET_NOT_FOUND', 'no table')
      const cells = Array.isArray(op.cells) ? op.cells : []
      const at = Number.isFinite(op.columnIndex) ? op.columnIndex : (table.tableRows[0] ?? []).length
      table.tableRows = table.tableRows.map((row, index) => {
        const copy = [...row]
        copy.splice(at, 0, cells[index] ?? cells[0] ?? '')
        return copy
      })
      table.text = table.tableRows.map((row) => row.join('\t')).join('\n')
      return { affected: [], tableId: table.id, columnIndex: at }
    }
    if (op.type === 'delete_table_column') {
      const table = findTable(blocksNow, op)
      if (table === undefined) throw engineError('ENGINE_TARGET_NOT_FOUND', 'no table')
      const at = Number.isFinite(op.columnIndex) ? op.columnIndex : (table.tableRows[0] ?? []).length - 1
      table.tableRows = table.tableRows.map((row) => {
        const copy = [...row]
        copy.splice(at, 1)
        return copy
      })
      table.text = table.tableRows.map((row) => row.join('\t')).join('\n')
      return { affected: [], tableId: table.id, columnIndex: at }
    }
    if (op.type === 'set_cell_text') {
      const table = findTable(blocksNow, op)
      if (table === undefined) throw engineError('ENGINE_TARGET_NOT_FOUND', 'no table')
      const row = table.tableRows[op.rowIndex]
      if (row === undefined) throw engineError('ENGINE_TARGET_NOT_FOUND', 'row missing')
      const before = row[op.columnIndex]
      if (before === undefined) throw engineError('ENGINE_TARGET_NOT_FOUND', 'cell missing')
      if (op.expectedText !== undefined && before !== op.expectedText) throw engineError('ENGINE_STALE_TARGET', 'stale')
      row[op.columnIndex] = op.text
      table.text = table.tableRows.map((cells) => cells.join('\t')).join('\n')
      return {
        affected: [{
          id: table.id,
          index: table.index,
          kind: 'table',
          textBefore: before,
          textAfter: op.text,
        }],
      }
    }
    if (op.type === 'set_run_text' || op.type === 'set_run_props' || op.type === 'split_run' || op.type === 'merge_runs') {
      return runOp(blocksNow, op)
    }
    if (op.type === 'set_paragraph_props') {
      const target = findOne(blocksNow, op.blockId ?? op.index)
      if (target === undefined) throw engineError('ENGINE_TARGET_NOT_FOUND', 'target missing')
      if (op.expectedText !== undefined && liveTextOf(target) !== op.expectedText) {
        throw engineError('ENGINE_STALE_TARGET', 'stale')
      }
      target.props = { ...(target.props ?? {}), ...(op.props ?? {}) }
      if (typeof op.props?.style === 'string') target.style = op.props.style
      return { affected: [{ id: target.id, index: target.index, kind: target.kind, textBefore: target.text, textAfter: target.text }] }
    }
    if (op.type === 'set_section_props') {
      const sections = session.sections
      const at = Number.isFinite(op.sectionIndex) ? op.sectionIndex : 0
      if (sections[at] === undefined) sections[at] = { index: at, kind: 'section', props: {} }
      sections[at].props = { ...(sections[at].props ?? {}), ...(op.props ?? {}) }
      return { affected: [], sectionIndex: at }
    }
    const hasOpaque = blocksNow.some((block) => (block.runs ?? []).some((run) => run.kind === 'opaque'))
    if (hasOpaque) throw engineError('ENGINE_UNSUPPORTED', `the engine cannot express ${op.type}`)
    throw engineError('ENGINE_INVALID_OP', `unsupported ${op.type}`)
  }

  /** Resolve a table by id or the first table. */
  function findTable(blocksNow, op) {
    if (typeof op.tableBlockId === 'string' || typeof op.blockId === 'string') {
      const id = op.tableBlockId ?? op.blockId
      return blocksNow.find((block) => block.kind === 'table' && block.id === id)
    }
    if (Number.isFinite(op.tableIndex)) {
      const block = blocksNow[op.tableIndex]
      return block && block.kind === 'table' ? block : undefined
    }
    return blocksNow.find((block) => block.kind === 'table')
  }

  /** Apply one run-level op. */
  function runOp(blocksNow, op) {
    const target = findOne(blocksNow, op.blockId ?? op.index)
    if (target === undefined) throw engineError('ENGINE_TARGET_NOT_FOUND', 'target missing')
    if (!Array.isArray(target.runs)) throw engineError('ENGINE_WRONG_KIND', 'block has no runs')
    const run = target.runs.find((entry) => entry.runIndex === op.runIndex)
    if (run === undefined) throw engineError('ENGINE_TARGET_NOT_FOUND', 'run missing')
    if (run.kind === 'opaque') throw engineError('ENGINE_UNSUPPORTED', 'opaque run cannot be edited')
    if (op.expectedText !== undefined && run.text !== op.expectedText) throw engineError('ENGINE_STALE_TARGET', 'stale')
    if (op.type === 'set_run_text') {
      run.text = op.text
    } else if (op.type === 'set_run_props') {
      run.props = { ...(run.props ?? {}), ...(op.props ?? {}) }
    } else if (op.type === 'split_run') {
      const offset = Number.isFinite(op.offset) ? Math.max(0, Math.min(op.offset, run.text.length)) : 0
      const left = { ...run, text: run.text.slice(0, offset) }
      const right = { ...run, text: run.text.slice(offset) }
      const at = target.runs.indexOf(run)
      target.runs.splice(at, 1, left, right)
      target.runs.forEach((entry, index) => { entry.runIndex = index })
    } else {
      const next = target.runs[target.runs.indexOf(run) + 1]
      if (next === undefined) throw engineError('ENGINE_TARGET_NOT_FOUND', 'no following run')
      const same = JSON.stringify(run.props ?? {}) === JSON.stringify(next.props ?? {})
      if (!same) throw engineError('ENGINE_INVALID_OP', 'run properties differ')
      run.text += next.text
      target.runs.splice(target.runs.indexOf(next), 1)
      target.runs.forEach((entry, index) => { entry.runIndex = index })
    }
    target.text = liveTextOf(target)
    return { affected: [{ id: target.id, index: target.index, kind: target.kind, textBefore: op.expectedText ?? '', textAfter: target.text }] }
  }

  return engine
}

/**
 * A fake `editorDocuments` service with a settable revision and dirty flag.
 * @param {{ revision?: string, modified?: boolean }} [initial] - starting lease facts.
 */
export function createFakeDocuments(initial = {}) {
  const state = {
    revision: initial.revision ?? 'r-1',
    modified: initial.modified === true,
    applied: [],
    path: undefined,
  }
  let serial = 1
  return {
    state,
    async open(file, options = {}) {
      if (typeof options.cwd === 'string' && options.cwd !== '') file = await resolveDocumentPath(file, { cwd: options.cwd, roots: options.roots ?? [] })
      state.path = file
      return { id: 'd1', path: file, revision: state.revision, modified: state.modified, edited: false }
    },
    async info(id) {
      return { id, path: state.path, revision: state.revision, modified: state.modified }
    },
    async applyBytes(file, bytes, options) {
      if (state.modified) throw Object.assign(new Error('editor dirty'), { code: 'DOC_EDITOR_DIRTY' })
      if (options?.baseRevision !== state.revision) throw Object.assign(new Error('stale base'), { code: 'DOC_STALE_BASE' })
      state.revision = `r-${++serial}`
      state.applied.push({ file, bytes, options })
      return { path: file, revision: state.revision, applied: true }
    },
  }
}

/** @returns {{ model: object, engine: object, documents: object, readFile: Function }} a wired model. */
export function createModel(options = {}) {
  const engine = options.engine ?? createFakeEngine()
  const documents = options.documents
  const readFile = options.readFile ?? (async () => DOCX)
  const model = createDocxModel({
    engine,
    documents,
    readFile,
    writeEnabled: options.writeEnabled !== false,
    limits: options.limits,
    analyzers: options.analyzers,
  })
  return { model, engine, documents, readFile }
}

export const PATH = 'C:/docs/TRO - Motion.docx'
