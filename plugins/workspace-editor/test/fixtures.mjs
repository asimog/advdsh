/**
 * Shared fixtures for the model and tool unit tests: a described-document
 * fixture, an in-memory engine with the real request/response shapes, and a fake
 * editorDocuments service. No Electron, x2t or DSH context.
 */
import { diffBlocks } from '../lib/engine/diff.js'
import { createDocxModel } from '../lib/model/model.js'

export const DOCX = Buffer.from('fake-docx-bytes')

/** @returns {Array<object>} a small described-document fixture. */
export function initialBlocks() {
  return [
    { id: 'p:1', index: 0, kind: 'paragraph', text: 'IN THE UNITED STATES DISTRICT COURT', style: 'heading1', level: 0 },
    { id: 'p:2', index: 1, kind: 'paragraph', text: 'Plaintiff seeks entry of an ex parte temporary restraining order.' },
    { id: 't:1', index: 2, kind: 'table', text: '', rows: 1, tableRows: [['A', 'B']] },
    { id: 'p:3', index: 3, kind: 'paragraph', text: 'Respectfully submitted.' },
  ]
}

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
 * A minimal in-memory engine with the real engine's request/response shapes.
 * @param {Array<object>} blocks - starting document.
 */
export function createFakeEngine(blocks = initialBlocks()) {
  const sessions = new Map()
  let counter = 0
  let serial = 0
  const calls = []
  return {
    calls,
    get openCount() { return calls.filter((call) => call.method === 'open').length },
    async open(input, options) {
      calls.push({ method: 'open', input, options })
      const sessionId = `s${++serial}`
      let starting = blocks
      if (input && input.bytes !== undefined) {
        try {
          const parsed = JSON.parse(Buffer.from(input.bytes).toString('utf8'))
          if (Array.isArray(parsed)) starting = parsed
        } catch (error) {
          // Not a fixture snapshot: open the fixture document instead.
        }
      }
      const copy = starting.map((block) => ({ ...block }))
      sessions.set(sessionId, { blocks: copy, base: copy.map((block) => ({ ...block })), revision: 0 })
      const description = describePayload(copy)
      return {
        sessionId,
        name: input.name,
        author: options?.author,
        blocks: description.blocks.length,
        paragraphs: description.paragraphCount,
        tables: description.tableCount,
      }
    },
    async describe(sessionId) {
      calls.push({ method: 'describe', sessionId })
      const session = sessions.get(sessionId)
      if (session === undefined) throw Object.assign(new Error('no session'), { code: 'ENGINE_SESSION_NOT_FOUND' })
      return describePayload(session.blocks)
    },
    async apply(sessionId, op) {
      calls.push({ method: 'apply', sessionId, op })
      const session = sessions.get(sessionId)
      if (session === undefined) throw Object.assign(new Error('no session'), { code: 'ENGINE_SESSION_NOT_FOUND' })
      const blocksNow = session.blocks
      if (op.type === 'replace_paragraph') {
        const index = op.blockId !== undefined ? blocksNow.findIndex((block) => block.id === op.blockId) : op.index
        const target = blocksNow[index]
        if (target === undefined) throw Object.assign(new Error('target missing'), { code: 'ENGINE_STALE_TARGET' })
        if (op.expectedText !== undefined && target.text !== op.expectedText) {
          throw Object.assign(new Error('stale'), { code: 'ENGINE_STALE_TARGET' })
        }
        const textBefore = target.text
        target.text = op.text
        return {
          revision: ++session.revision,
          tracked: op.track !== false,
          affected: [{ id: target.id, index, kind: target.kind, textBefore, textAfter: target.text }],
        }
      }
      if (op.type === 'insert_paragraph' || op.type === 'insert_list_item') {
        const block = {
          id: `p:x${++counter}`,
          index: 0,
          kind: 'paragraph',
          text: op.text,
          ...(op.type === 'insert_list_item' ? { numbering: { level: op.level ?? 0 } } : {}),
        }
        const at = Number.isFinite(op.index) ? Math.max(0, Math.min(op.index, blocksNow.length)) : blocksNow.length
        blocksNow.splice(at, 0, block)
        return {
          revision: ++session.revision,
          tracked: op.track !== false,
          affected: [{ id: block.id, index: at, kind: 'paragraph', textBefore: null, textAfter: block.text }],
        }
      }
      if (op.type === 'delete_paragraph') {
        const index = op.blockId !== undefined ? blocksNow.findIndex((block) => block.id === op.blockId) : op.index
        const target = blocksNow[index]
        if (target === undefined) throw Object.assign(new Error('target missing'), { code: 'ENGINE_STALE_TARGET' })
        blocksNow.splice(index, 1)
        return {
          revision: ++session.revision,
          tracked: op.track !== false,
          affected: [{ id: target.id, index, kind: target.kind, textBefore: target.text, textAfter: null }],
        }
      }
      if (op.type === 'insert_table_row') {
        const table = blocksNow.find((block) => block.kind === 'table')
        if (table === undefined) throw Object.assign(new Error('no table'), { code: 'ENGINE_TARGET_NOT_FOUND' })
        const rowsBefore = table.rows
        table.rows += 1
        table.tableRows = [...(table.tableRows ?? []), op.cells ?? []]
        return { revision: ++session.revision, tracked: op.track !== false, tableIndex: table.index, tableId: table.id, rowsBefore, rowsAfter: table.rows, affected: [] }
      }
      if (op.type === 'delete_table_row') {
        const table = blocksNow.find((block) => block.id === op.blockId || block.kind === 'table')
        if (table === undefined) throw Object.assign(new Error('no table'), { code: 'ENGINE_STALE_TARGET' })
        table.rows -= 1
        return { revision: ++session.revision, tracked: op.track !== false, tableId: table.id, rowIndex: op.rowIndex, rowsAfter: table.rows, affected: [] }
      }
      throw Object.assign(new Error(`unsupported ${op.type}`), { code: 'ENGINE_INVALID_OP' })
    },
    async diff(sessionId) {
      const session = sessions.get(sessionId)
      const result = diffBlocks(session.base, session.blocks.map((block, index) => ({ ...block, index })))
      return { ...result, baseHash: 'base-hash' }
    },
    async save(sessionId, options) {
      calls.push({ method: 'save', sessionId, options })
      const session = sessions.get(sessionId)
      const bytes = Buffer.from(JSON.stringify(session.blocks), 'utf8')
      return { bytes, path: options?.targetPath, size: bytes.length, sha256: 'saved-hash', revision: ++session.revision }
    },
    async close(sessionId) {
      calls.push({ method: 'close', sessionId })
      sessions.delete(sessionId)
      return { closed: true }
    },
  }
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
    async open(file) {
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
