/**
 * `ctx.docxModel` core: agent document sessions over `ctx.docxEngine`.
 *
 * Sessions are keyed by absolute path + content hash, so a reopen after a human
 * save or an engine restart either reuses the session or mints a new one. Each
 * session keeps the immutable open-time description (the diff base), the working
 * description, the one-op edit log with its inverse, and the lease facts a
 * commit needs. Writes go through the shared `editorDocuments` store, so the
 * agent and the open editor never race: a stale base or a dirty editor is
 * refused, never overwritten.
 *
 * The engine is injected, so this module runs and is unit-tested without
 * Electron, x2t or a DSH context.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ERROR_CODES, toolCodeForEngine } from '../errors.js'
import { commitEligibility, markDiffSeen, noteDiffInvalidated, operationContract, sessionContract } from './session-contract.js'

/** Stable codes for tool results; the message is for the operator. */
export const MODEL_CODES = Object.freeze({
  SESSION_NOT_FOUND: ERROR_CODES.SESSION_NOT_FOUND,
  CLOSED: ERROR_CODES.CLOSED,
  TOO_LARGE: ERROR_CODES.TOO_LARGE,
  INVALID_OP: ERROR_CODES.INVALID_OP,
  TARGET_NOT_FOUND: ERROR_CODES.TARGET_NOT_FOUND,
  AMBIGUOUS_TARGET: ERROR_CODES.AMBIGUOUS_TARGET,
  STALE_TARGET: ERROR_CODES.STALE_TARGET,
  UNSUPPORTED_EDIT: ERROR_CODES.UNSUPPORTED_EDIT,
  STALE_BASE: ERROR_CODES.STALE_BASE,
  BASE_REQUIRED: ERROR_CODES.BASE_REQUIRED,
  EDITOR_DIRTY: ERROR_CODES.EDITOR_DIRTY,
  OUTSIDE_WORKSPACE: ERROR_CODES.OUTSIDE_WORKSPACE,
  WRITE_DISABLED: ERROR_CODES.WRITE_DISABLED,
  WRITE_UNAVAILABLE: 'DOC_WRITE_UNAVAILABLE',
  COMMIT_FAILED: ERROR_CODES.COMMIT_FAILED,
  FORKED_COMMIT: ERROR_CODES.FORKED_COMMIT,
  UNDO_UNAVAILABLE: ERROR_CODES.UNDO_UNAVAILABLE,
  OPEN_FAILED: 'DOC_OPEN_FAILED',
})

/** One model failure with a stable code, optional details and a cause. */
export class ModelError extends Error {
  /**
   * @param {string} code - one of `MODEL_CODES`.
   * @param {string} message - operator-facing message.
   * @param {{ details?: unknown, cause?: unknown }} [options] - extra facts.
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'ModelError'
    this.code = code
    if (options.details !== undefined) this.details = options.details
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/** Write ops the engine expresses today; anything else is refused, not guessed. */
export const SUPPORTED_OPS = Object.freeze([
  'replace_paragraph',
  'insert_paragraph',
  'delete_paragraph',
  'insert_list_item',
  'insert_table_row',
  'delete_table_row',
])

/** Read modes `doc_read` accepts. */
export const READ_MODES = Object.freeze(['auto', 'full', 'outline', 'range', 'search', 'context'])

const OP_FIELDS = Object.freeze({
  replace_paragraph: { text: 'string', blockId: 'string', index: 'number', expectedText: 'string' },
  insert_paragraph: { text: 'string', index: 'number' },
  delete_paragraph: { blockId: 'string', index: 'number', expectedText: 'string' },
  insert_list_item: { text: 'string', numbering: 'string', level: 'number', index: 'number' },
  insert_table_row: { tableBlockId: 'string', tableIndex: 'number', cells: 'array', create: 'boolean' },
  delete_table_row: { blockId: 'string', index: 'number', rowIndex: 'number' },
})

/** @param {unknown} value - candidate bytes. @returns {Buffer} */
function toBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value, 'base64')
  throw new ModelError(MODEL_CODES.INVALID_OP, 'document bytes must be a Buffer, Uint8Array, ArrayBuffer or base64 string')
}

/** @param {Buffer|Uint8Array} bytes - document bytes. @returns {string} */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** @param {string} file - absolute path. @returns {string} */
function pathKey(file) {
  return path.resolve(file).toLowerCase()
}

/** @param {unknown} value - number-like input. @param {number} fallback - default. @returns {number} */
function positiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/** @param {string} text - block text. @returns {number} approximate token count. */
function estimateTokens(text) {
  return Math.ceil((typeof text === 'string' ? text.length : 0) / 4)
}

/** @param {string} text - block text. @param {number} limit - character cap. @returns {string} */
function clip(text, limit = 500) {
  const value = typeof text === 'string' ? text : ''
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/** Heading rows derived from paragraph style/level. */
function outlineOf(blocks) {
  const outline = []
  for (const block of blocks) {
    if (block.kind !== 'paragraph') continue
    const style = typeof block.style === 'string' ? block.style : ''
    let level = Number.isFinite(block.level) ? block.level : undefined
    if (level === undefined) {
      const match = /^heading\s*([1-9])$/i.exec(style)
      if (match) level = Number(match[1]) - 1
    }
    if (level === undefined) continue
    outline.push({ id: block.id, index: block.index, level, text: block.text })
  }
  return outline
}

/** One annotated block line for model reads. */
function formatBlock(block) {
  if (block.kind === 'table') {
    const rows = Number.isFinite(block.rows) ? block.rows : 0
    const cells = Array.isArray(block.tableRows?.[0]) ? block.tableRows[0].join(' | ') : ''
    return `[${block.id}] (table, ${rows} row${rows === 1 ? '' : 's'})${cells === '' ? '' : ` ${cells}`}`
  }
  return `[${block.id}] ${block.text}`
}

/**
 * Comparison signature for the three-way merge: kind, normalized text and table
 * extent. Whitespace runs collapse so a reflow is not a semantic change.
 * @param {object} block - described block.
 * @returns {string} comparison signature.
 */
function blockSignature(block) {
  const rows = Array.isArray(block.tableRows)
    ? block.tableRows.map((cells) => (Array.isArray(cells) ? cells.join('\u0001') : '')).join('\u0002')
    : ''
  return [
    block.kind ?? '',
    String(block.text ?? '').replace(/\s+/g, ' ').trim(),
    block.rows ?? '',
    rows,
  ].join('\u0000')
}

/** @param {Array<object>} blocks - described blocks. @returns {{ tokens: number, paragraphs: number, tables: number }} */
function countBlocks(blocks) {
  let tokens = 0
  let paragraphs = 0
  let tables = 0
  for (const block of blocks) {
    tokens += estimateTokens(block.text)
    if (block.kind === 'paragraph') paragraphs += 1
    if (block.kind === 'table') tables += 1
  }
  return { tokens, paragraphs, tables }
}

/** @param {Array<object>} blocks - described blocks. @param {string|number} target - block id or index. @returns {object|undefined} */
function findBlock(blocks, target) {
  if (target === undefined || target === null || target === '') return undefined
  if (typeof target === 'number') return blocks.find((block) => block.index === target)
  return blocks.find((block) => block.id === target)
}

/**
 * Validate one model edit and produce the engine op.
 * @param {object} op - caller op.
 * @returns {{ type: string, engineOp: object }} normalized op.
 */
export function validateOp(op) {
  if (!op || typeof op !== 'object' || typeof op.type !== 'string' || op.type === '') {
    throw new ModelError(MODEL_CODES.INVALID_OP, 'doc_edit needs an op object with a type', {
      details: { supported: SUPPORTED_OPS },
    })
  }
  const fields = OP_FIELDS[op.type]
  if (fields === undefined) {
    throw new ModelError(MODEL_CODES.INVALID_OP, `unsupported edit op: ${op.type}`, {
      details: { supported: SUPPORTED_OPS },
    })
  }
  const engineOp = { type: op.type }
  for (const [field, kind] of Object.entries(fields)) {
    const value = op[field]
    if (value === undefined) continue
    if (kind === 'string' && typeof value !== 'string') {
      throw new ModelError(MODEL_CODES.INVALID_OP, `${op.type}.${field} must be a string`)
    }
    if (kind === 'number' && !Number.isFinite(value)) {
      throw new ModelError(MODEL_CODES.INVALID_OP, `${op.type}.${field} must be a number`)
    }
    if (kind === 'array' && (!Array.isArray(value) || value.some((cell) => typeof cell !== 'string'))) {
      throw new ModelError(MODEL_CODES.INVALID_OP, `${op.type}.${field} must be an array of strings`)
    }
    if (kind === 'boolean' && typeof value !== 'boolean') {
      throw new ModelError(MODEL_CODES.INVALID_OP, `${op.type}.${field} must be a boolean`)
    }
    engineOp[field] = value
  }
  if (op.type === 'replace_paragraph' && typeof engineOp.text !== 'string') {
    throw new ModelError(MODEL_CODES.INVALID_OP, 'replace_paragraph needs text')
  }
  if (op.type === 'insert_paragraph' && typeof engineOp.text !== 'string') {
    throw new ModelError(MODEL_CODES.INVALID_OP, 'insert_paragraph needs text')
  }
  if (op.type === 'insert_list_item' && typeof engineOp.text !== 'string') {
    throw new ModelError(MODEL_CODES.INVALID_OP, 'insert_list_item needs text')
  }
  if (engineOp.blockId === undefined && engineOp.index === undefined
    && ['replace_paragraph', 'delete_paragraph', 'delete_table_row'].includes(op.type)) {
    throw new ModelError(MODEL_CODES.INVALID_OP, `${op.type} needs blockId or index`)
  }
  return { type: op.type, engineOp }
}

/**
 * Create one document model over the injected engine and document store.
 *
 * @param {{
 *   engine: object,
 *   documents?: object,
 *   writeEnabled?: boolean,
 *   analyzers?: Array<(input: object) => object[]|Promise<object[]>>,
 *   log?: (level: string, message: string, data?: unknown) => void,
 *   now?: () => Date,
 *   limits?: { fullReadTokens?: number, fullReadParagraphs?: number, maxRangeBlocks?: number, maxSearchMatches?: number },
 *   readFile?: (file: string) => Promise<Buffer>,
 *   tempRoot?: () => Promise<string>,
 *   removeFile?: (file: string) => Promise<void>,
 * }} options - engine, optional document store and bounds.
 * @returns {object} the `ctx.docxModel` service.
 */
export function createDocxModel(options) {
  if (!options || !options.engine) throw new Error('createDocxModel requires an engine')
  const engine = options.engine
  const documents = options.documents ?? undefined
  const writeEnabled = options.writeEnabled !== false
  const analyzers = Array.isArray(options.analyzers) ? [...options.analyzers] : []
  const log = typeof options.log === 'function' ? options.log : () => {}
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const readFileImpl = options.readFile ?? ((file) => readFile(file))
  const limits = {
    fullReadTokens: positiveInt(options.limits?.fullReadTokens ?? process.env.DOC_FULL_READ_TOKENS, 20_000),
    fullReadParagraphs: positiveInt(options.limits?.fullReadParagraphs ?? process.env.DOC_FULL_READ_PARAGRAPHS, 400),
    maxRangeBlocks: positiveInt(options.limits?.maxRangeBlocks, 200),
    maxSearchMatches: positiveInt(options.limits?.maxSearchMatches, 40),
  }

  /** @type {Map<string, object>} handle -> session */
  const sessions = new Map()
  /** @type {Map<string, string>} path+hash -> handle */
  const byKey = new Map()
  /** @type {Map<string, object>} path key -> lease facts */
  const leases = new Map()
  let disposeOnce = null
  let tempRootOnce = null

  /** Resolve a session or refuse with the stable code. */
  function requireSession(handle) {
    const session = sessions.get(String(handle))
    if (session === undefined) {
      throw new ModelError(MODEL_CODES.SESSION_NOT_FOUND, `unknown document session: ${String(handle)}. Call doc_open first.`)
    }
    return session
  }

  /** Refuse when the write gate is off. Working-state edits obey the same gate. */
  function assertWritesAllowed() {
    if (!writeEnabled) {
      throw new ModelError(MODEL_CODES.WRITE_DISABLED, 'document writes are disabled (WORKSPACE_DOCX_WRITE=off)')
    }
  }

  /** Commit needs the shared document store; working-state edits do not. */
  function assertCommitStore() {
    assertWritesAllowed()
    if (documents === undefined) {
      throw new ModelError(MODEL_CODES.WRITE_UNAVAILABLE, 'no document store is available; the editor host row must be loaded')
    }
  }

  /** @returns {Promise<string>} a per-activation temp root for commit serialization. */
  async function tempRoot() {
    if (tempRootOnce === null) {
      tempRootOnce = (async () => mkdtemp(path.join(os.tmpdir(), 'advodsh-docx-model-')))()
    }
    return tempRootOnce
  }

  /** Invalidate the cached description after a working-state change. */
  function invalidate(session) {
    session.cached = undefined
  }

  /** Fetch (and cache) the engine description for the current revision. */
  async function describeSession(session, engineOptions = {}) {
    if (session.cached !== undefined && session.cached.revision === session.revision) return session.cached
    const raw = await engine.describe(session.engineSessionId, engineOptions)
    const blocks = Array.isArray(raw.blocks) ? raw.blocks : []
    const counts = countBlocks(blocks)
    session.cached = {
      revision: session.revision,
      blocks,
      outline: outlineOf(blocks),
      ...counts,
    }
    return session.cached
  }

  /** Summary row for `doc_open` and status lines. */
  function summary(session) {
    const cached = session.cached
    const blocks = cached?.blocks.length ?? session.openFacts.blocks ?? 0
    const tokens = cached?.tokens ?? session.tokensAtOpen
    return {
      handle: session.handle,
      path: session.path,
      name: session.name,
      contentHash: session.contentHash,
      revision: session.revision,
      baseRevision: session.baseRevision,
      readMode: session.readMode,
      blocks,
      paragraphs: cached?.paragraphs ?? session.paragraphsAtOpen,
      tables: cached?.tables ?? session.tablesAtOpen,
      tokens,
      outline: cached?.outline ?? session.outlineAtOpen,
      author: session.author,
    }
  }

  /** One runtime-context line for the open sessions under the agent's cwd. */
  function statusLine(session) {
    const lease = leases.get(pathKey(session.path))
    const state = session.stale
      ? 'stale'
      : lease?.conflict !== undefined && lease.conflict !== null
        ? `conflict:${lease.conflict}`
        : lease?.editorDirty === true ? 'editor-dirty' : 'clean'
    const pending = session.opLog.length
    return `${session.handle} ${session.path} rev=${session.revision} base=${session.baseRevision.slice(0, 12)} `
      + `blocks=${session.cached?.blocks.length ?? session.openFacts.blocks ?? 0} read=${session.readMode} `
      + `editor=${state} pending=${pending}`
  }

  /** Map one engine error to a model error, preserving the stable code. */
  function mapEngineError(error, fallback) {
    if (error instanceof ModelError) return error
    const code = error && typeof error.code === 'string' ? error.code : undefined
    const mapped = code === undefined ? fallback : toolCodeForEngine(code)
    if (mapped === MODEL_CODES.STALE_TARGET) {
      return new ModelError(mapped, 'the target block changed since it was read; describe the document again', {
        cause: error,
        details: { engineCode: code },
      })
    }
    if (mapped === MODEL_CODES.CLOSED) {
      return new ModelError(mapped, 'the engine session is gone; reload the document', { cause: error, details: { engineCode: code } })
    }
    return new ModelError(mapped, error instanceof Error ? error.message : String(error), {
      cause: error,
      details: code === undefined ? undefined : { engineCode: code },
    })
  }

  /** Fill expectedText from the current description when the caller targeted a block id. */
  async function expectedTextFor(session, engineOp) {
    if (engineOp.expectedText !== undefined) return engineOp.expectedText
    if (engineOp.blockId === undefined && engineOp.index === undefined) return undefined
    const description = await describeSession(session)
    const block = findBlock(description.blocks, engineOp.blockId ?? engineOp.index)
    if (block === undefined) {
      throw new ModelError(MODEL_CODES.TARGET_NOT_FOUND, `block not found: ${String(engineOp.blockId ?? engineOp.index)}`, {
        details: { blockId: engineOp.blockId, index: engineOp.index },
      })
    }
    return block.text
  }

  /** Best-effort inverse of one applied op, used by `undo`; undefined cannot be undone. */
  function inverseOf(type, engineOp, result, description) {
    const affected = Array.isArray(result.affected) ? result.affected : []
    const target = affected.find((entry) => entry.textBefore !== null && entry.textBefore !== undefined)
      ?? affected[0]
    if (type === 'replace_paragraph' && target !== undefined) {
      return { type: 'replace_paragraph', blockId: target.id, expectedText: target.textAfter ?? '', text: target.textBefore ?? '', track: false }
    }
    if (type === 'insert_paragraph') {
      const inserted = affected.find((entry) => entry.textBefore === null || entry.textBefore === undefined)
      if (inserted !== undefined) {
        return { type: 'delete_paragraph', blockId: inserted.id, expectedText: inserted.textAfter ?? '', track: false }
      }
      return undefined
    }
    if (type === 'insert_list_item') {
      const inserted = affected.find((entry) => entry.textBefore === null || entry.textBefore === undefined)
      if (inserted !== undefined) {
        return { type: 'delete_paragraph', blockId: inserted.id, expectedText: inserted.textAfter ?? '', track: false }
      }
      return undefined
    }
    if (type === 'delete_paragraph' && typeof engineOp.index === 'number') {
      return { type: 'insert_paragraph', index: engineOp.index, text: affected[0]?.textBefore ?? '', track: false }
    }
    if (type === 'insert_table_row') {
      const tableId = result.tableId
      const rowIndex = Number.isFinite(result.rowsAfter) ? result.rowsAfter - 1 : undefined
      if (typeof tableId === 'string' && rowIndex !== undefined) {
        return { type: 'delete_table_row', blockId: tableId, rowIndex, track: false }
      }
      return undefined
    }
    return undefined
  }

  /** Re-open the engine session from committed bytes so the diff base is the new revision. */
  async function rebase(session, bytes) {
    await engine.close(session.engineSessionId).catch(() => {})
    const reopened = await engine.open({ bytes, name: session.name }, { author: session.author })
    session.engineSessionId = reopened.sessionId
    session.revision = 0
    session.opLog = []
    session.diffSeenOps = 0
    session.diffSeenAt = null
    invalidate(session)
    const description = await describeSession(session)
    session.baseBlocks = description.blocks
    return reopened
  }

  const model = {
    limits,

    /**
     * Register one analyzer for `check`; analyzers are injected by the review row
     * so the model does not depend on legal code.
     * @param {(input: object) => object[]|Promise<object[]>} analyzer - analyzer function.
     * @returns {() => void} the removal disposer.
     */
    addAnalyzer(analyzer) {
      if (typeof analyzer !== 'function') throw new ModelError(MODEL_CODES.INVALID_OP, 'analyzer must be a function')
      analyzers.push(analyzer)
      return () => {
        const at = analyzers.indexOf(analyzer)
        if (at !== -1) analyzers.splice(at, 1)
      }
    },

    /**
     * Open a DOCX path or byte buffer as an agent session.
     * @param {string|{ path?: string, bytes?: Buffer|Uint8Array|ArrayBuffer|string, name?: string }} input - source.
     * @param {{ author?: string }} [openOptions] - tracked-change author.
     * @returns {Promise<object>} handle, path, content hash, revision, mode, outline and token count.
     */
    async open(input, openOptions = {}) {
      let absolute
      let bytes
      let name
      if (typeof input === 'string') {
        absolute = path.resolve(input)
      } else if (input && typeof input === 'object') {
        if (typeof input.path === 'string' && input.path !== '') absolute = path.resolve(input.path)
        if (input.bytes !== undefined) bytes = toBytes(input.bytes)
        if (typeof input.name === 'string' && input.name !== '') name = input.name
      }
      if (absolute === undefined && bytes === undefined) {
        throw new ModelError(MODEL_CODES.INVALID_OP, 'doc_open needs a path or bytes')
      }
      let docView
      if (documents !== undefined && absolute !== undefined) docView = await documents.open(absolute)
      if (bytes === undefined) {
        bytes = await readFileImpl(docView?.path ?? absolute)
      }
      const contentHash = sha256(bytes)
      const ownerSessionId = typeof openOptions.sessionId === 'string' && openOptions.sessionId !== ''
        ? openOptions.sessionId
        : (typeof openOptions.ownerSessionId === 'string' ? openOptions.ownerSessionId : '')
      const key = `${ownerSessionId}\n${pathKey(absolute ?? name ?? 'document')}\n${contentHash}`
      const existingHandle = byKey.get(key)
      if (existingHandle !== undefined) {
        const existing = sessions.get(existingHandle)
        if (existing !== undefined) return summary(existing)
      }
      const handle = `doc-${sha256(key).slice(0, 10)}`
      const fileName = name ?? (absolute === undefined ? 'document.docx' : path.basename(absolute))
      const author = typeof openOptions.author === 'string' && openOptions.author !== '' ? openOptions.author : `agent:${handle}`
      let opened
      try {
        opened = await engine.open({ bytes, name: fileName }, { author })
      } catch (error) {
        throw mapEngineError(error, MODEL_CODES.OPEN_FAILED)
      }
      const session = {
        handle,
        ownerSessionId,
        path: absolute ?? fileName,
        name: fileName,
        contentHash,
        author,
        engineSessionId: opened.sessionId,
        documentId: docView?.id,
        revision: 0,
        baseRevision: typeof docView?.revision === 'string' ? docView.revision : contentHash,
        openFacts: opened,
        blocksAtOpen: opened.blocks,
        paragraphsAtOpen: opened.paragraphs,
        tablesAtOpen: opened.tables,
        tokensAtOpen: opened.tokens ?? estimateTokens(''),
        outlineAtOpen: [],
        readMode: 'full',
        baseBlocks: [],
        opLog: [],
        revisions: [],
        stale: false,
        cached: undefined,
        forkChildren: new Set(),
        fork: undefined,
        taskLabel: null,
        diffSeenOps: 0,
        diffSeenAt: null,
      }
      byKey.set(key, handle)
      sessions.set(handle, session)
      try {
        const description = await describeSession(session)
        session.baseBlocks = description.blocks
        session.outlineAtOpen = description.outline
        session.tokensAtOpen = description.tokens
        session.readMode = description.tokens > limits.fullReadTokens || description.paragraphs > limits.fullReadParagraphs
          ? 'large'
          : 'full'
      } catch (error) {
        sessions.delete(handle)
        byKey.delete(key)
        await engine.close(session.engineSessionId).catch(() => {})
        throw mapEngineError(error, MODEL_CODES.OPEN_FAILED)
      }
      const leasePath = pathKey(session.path)
      leases.set(leasePath, {
        path: session.path,
        revision: session.baseRevision,
        editorDirty: docView?.modified === true,
        conflict: null,
        holder: handle,
        updatedAt: now().toISOString(),
      })
      log('info', 'opened document', { handle, path: session.path, revision: session.revision, readMode: session.readMode })
      return summary(session)
    },

    /** @param {string} handle - session handle. @returns {Promise<object>} description. */
    async describe(handle) {
      const session = requireSession(handle)
      const description = await describeSession(session)
      return {
        ...summary(session),
        blocks: description.blocks,
        outline: description.outline,
        paragraphCount: description.paragraphs,
        tableCount: description.tables,
        tokens: description.tokens,
      }
    },

    /**
     * Read in one mode: auto, full, outline, range, search or context.
     * @param {string} handle - session handle.
     * @param {{ mode?: string, from?: number, to?: number, ids?: string[], query?: string, limit?: number, caseSensitive?: boolean, blockId?: string, index?: number, before?: number, after?: number }} [readOptions] - read request.
     * @returns {Promise<object>} annotated text, blocks and bounds.
     */
    async read(handle, readOptions = {}) {
      const session = requireSession(handle)
      const mode = typeof readOptions.mode === 'string' && readOptions.mode !== '' ? readOptions.mode : 'auto'
      if (!READ_MODES.includes(mode)) {
        throw new ModelError(MODEL_CODES.INVALID_OP, `unknown read mode: ${mode}`, { details: { modes: READ_MODES } })
      }
      const description = await describeSession(session)
      const blocks = description.blocks
      const base = {
        handle: session.handle,
        path: session.path,
        revision: session.revision,
        contentHash: session.contentHash,
        mode,
        totalBlocks: blocks.length,
        tokens: description.tokens,
      }
      const oversized = description.tokens > limits.fullReadTokens || description.paragraphs > limits.fullReadParagraphs
      if (mode === 'auto') {
        if (oversized) {
          return {
            ...base,
            mode: 'outline',
            blocks: [],
            text: '',
            outline: description.outline,
            truncated: false,
            hint: `document is large (${description.tokens} tokens, ${description.paragraphs} paragraphs); use outline, range, search or context`,
          }
        }
        return { ...base, mode: 'full', blocks, text: blocks.map(formatBlock).join('\n'), truncated: false }
      }
      if (mode === 'full') {
        if (oversized) {
          throw new ModelError(
            MODEL_CODES.TOO_LARGE,
            `document is too large for a full read: ${description.tokens} tokens, ${description.paragraphs} paragraphs`,
            { details: { tokens: description.tokens, paragraphs: description.paragraphs, limits, modes: ['outline', 'range', 'search', 'context'] } },
          )
        }
        return { ...base, blocks, text: blocks.map(formatBlock).join('\n'), truncated: false }
      }
      if (mode === 'outline') {
        return {
          ...base,
          blocks: [],
          outline: description.outline,
          text: description.outline.map((row) => `[${row.id}] ${'  '.repeat(row.level)}${row.text}`).join('\n'),
          truncated: false,
        }
      }
      if (mode === 'range') {
        const ids = Array.isArray(readOptions.ids) ? readOptions.ids : undefined
        let from = Number.isFinite(readOptions.from) ? Math.max(0, Math.floor(readOptions.from)) : 0
        let to = Number.isFinite(readOptions.to) ? Math.floor(readOptions.to) : blocks.length - 1
        let selection
        if (ids !== undefined) {
          selection = blocks.filter((block) => ids.includes(block.id))
        } else {
          to = Math.min(to, blocks.length - 1)
          selection = blocks.filter((block) => block.index >= from && block.index <= to)
        }
        const truncated = selection.length > limits.maxRangeBlocks
        const kept = selection.slice(0, limits.maxRangeBlocks)
        return {
          ...base,
          blocks: kept,
          text: kept.map(formatBlock).join('\n'),
          truncated,
          range: { from, to, returned: kept.length, total: selection.length },
        }
      }
      if (mode === 'search') {
        const query = typeof readOptions.query === 'string' ? readOptions.query : ''
        if (query === '') throw new ModelError(MODEL_CODES.INVALID_OP, 'search needs a query')
        const limit = positiveInt(readOptions.limit, limits.maxSearchMatches)
        const needle = readOptions.caseSensitive === true ? query : query.toLowerCase()
        const matches = []
        for (const block of blocks) {
          const haystack = readOptions.caseSensitive === true ? block.text : block.text.toLowerCase()
          const at = haystack.indexOf(needle)
          if (at === -1) continue
          const start = Math.max(0, at - 90)
          matches.push({
            id: block.id,
            index: block.index,
            kind: block.kind,
            snippet: clip(`${start > 0 ? '…' : ''}${block.text.slice(start, start + 220)}`, 240),
          })
          if (matches.length >= limit) break
        }
        return {
          ...base,
          blocks: matches.map((match) => blocks.find((block) => block.id === match.id)).filter(Boolean),
          matches,
          text: matches.map((match) => `[${match.id}] ${match.snippet}`).join('\n'),
          truncated: matches.length >= limit,
        }
      }
      // mode === 'context'
      const target = findBlock(blocks, readOptions.blockId ?? readOptions.index)
      if (target === undefined) {
        throw new ModelError(MODEL_CODES.TARGET_NOT_FOUND, `block not found: ${String(readOptions.blockId ?? readOptions.index)}`)
      }
      const before = positiveInt(readOptions.before, 2)
      const after = positiveInt(readOptions.after, 2)
      const from = Math.max(0, target.index - before)
      const to = Math.min(blocks.length - 1, target.index + after)
      const selection = blocks.filter((block) => block.index >= from && block.index <= to)
      return {
        ...base,
        mode: 'context',
        blocks: selection,
        text: selection.map(formatBlock).join('\n'),
        truncated: false,
        focus: { id: target.id, index: target.index },
      }
    },

    /**
     * Apply one atomic edit; the target is re-checked by text before it changes.
     * @param {string} handle - session handle.
     * @param {object} op - one op, see `SUPPORTED_OPS`.
     * @param {{ signal?: AbortSignal }} [editOptions] - cancellation.
     * @returns {Promise<object>} revision, tracked flag and affected blocks.
     */
    async edit(handle, op, editOptions = {}) {
      const session = requireSession(handle)
      assertWritesAllowed()

      const normalized = validateOp(op)
      const engineOp = { ...normalized.engineOp }
      // Only ops that target an existing block carry the expected-text guard;
      // for insert ops `index` is the insertion point, not a target.
      if (engineOp.expectedText === undefined && (normalized.type === 'replace_paragraph' || normalized.type === 'delete_paragraph')) {
        const expected = await expectedTextFor(session, engineOp)
        if (expected !== undefined) engineOp.expectedText = expected
      }
      let result
      try {
        result = await engine.apply(session.engineSessionId, engineOp, { signal: editOptions.signal })
      } catch (error) {
        throw mapEngineError(error, MODEL_CODES.INVALID_OP)
      }
      session.revision = Number.isFinite(result.revision) ? result.revision : session.revision + 1
      const affected = (Array.isArray(result.affected) ? result.affected : []).map((entry) => ({
        id: entry.id,
        index: entry.index,
        kind: entry.kind,
        textBefore: entry.textBefore === null || entry.textBefore === undefined ? null : clip(entry.textBefore),
        textAfter: entry.textAfter === null || entry.textAfter === undefined ? null : clip(entry.textAfter),
      }))
      const description = await describeSession(session).catch(() => undefined)
      const entry = {
        seq: session.opLog.length + 1,
        type: normalized.type,
        engineOp,
        affected,
        tracked: result.tracked !== false,
        revision: session.revision,
        at: now().toISOString(),
        inverse: inverseOf(normalized.type, engineOp, result, description),
      }
      session.opLog.push(entry)
      noteDiffInvalidated(session)
      invalidate(session)
      return {
        handle: session.handle,
        revision: session.revision,
        op: normalized.type,
        tracked: entry.tracked,
        affected,
        changed: affected.length,
      }
    },

    /**
     * Revert the last edit in the working state. Tracked revisions already in the
     * working document are not removed; the inverse op itself is untracked.
     * @param {string} handle - session handle.
     * @returns {Promise<object>} the reverted op and its affected blocks.
     */
    async undo(handle) {
      const session = requireSession(handle)
      assertWritesAllowed()

      const entry = [...session.opLog].reverse().find((candidate) => candidate.inverse !== undefined)
      if (entry === undefined) {
        throw new ModelError(MODEL_CODES.UNDO_UNAVAILABLE, 'no reversible edit in this session', {
          details: { pending: session.opLog.length },
        })
      }
      let result
      try {
        result = await engine.apply(session.engineSessionId, entry.inverse, {})
      } catch (error) {
        throw mapEngineError(error, MODEL_CODES.UNDO_UNAVAILABLE)
      }
      session.opLog = session.opLog.filter((candidate) => candidate !== entry)
      noteDiffInvalidated(session)
      session.revision = Number.isFinite(result.revision) ? result.revision : session.revision + 1
      invalidate(session)
      return {
        handle: session.handle,
        revision: session.revision,
        undone: entry.type,
        affected: Array.isArray(result.affected) ? result.affected : [],
        remaining: session.opLog.length,
      }
    },

    /** @param {string} handle - session handle. @returns {Promise<object>} base-vs-working change set. */
    async diff(handle) {
      const session = requireSession(handle)
      let raw
      try {
        raw = await engine.diff(session.engineSessionId)
      } catch (error) {
        throw mapEngineError(error, MODEL_CODES.CLOSED)
      }
      const changes = (Array.isArray(raw.changes) ? raw.changes : []).map((change) => ({
        type: change.type,
        id: change.id,
        index: change.index,
        kind: change.kind,
        before: change.before === undefined ? null : clip(change.before.text ?? ''),
        after: change.after === undefined ? null : clip(change.after.text ?? ''),
      }))
      markDiffSeen(session)
      return {
        handle: session.handle,
        path: session.path,
        revision: session.revision,
        baseHash: raw.baseHash ?? session.contentHash,
        baseRevision: session.baseRevision,
        changes,
        counts: raw.counts,
        changed: raw.changed === true,
        pendingOps: session.opLog.length,
      }
    },

    /**
     * Check the working document: pending revisions plus any registered analyzers.
     * @param {string} handle - session handle.
     * @param {{ checks?: string[] }} [checkOptions] - analyzer selection.
     * @returns {Promise<{ handle: string, ok: boolean, findings: object[], codes: string[] }>} findings.
     */
    async check(handle, checkOptions = {}) {
      const session = requireSession(handle)
      const description = await describeSession(session)
      let diff
      try {
        diff = await engine.diff(session.engineSessionId)
      } catch (error) {
        throw mapEngineError(error, MODEL_CODES.CLOSED)
      }
      const findings = []
      if (diff.changed === true) {
        findings.push({
          code: 'PENDING_REVISIONS',
          severity: 'info',
          message: `${diff.counts.total} uncommitted change${diff.counts.total === 1 ? '' : 's'} in the working document`,
          blocks: (diff.changes ?? []).map((change) => change.id).filter(Boolean),
        })
      }
      const wanted = Array.isArray(checkOptions.checks) ? new Set(checkOptions.checks) : undefined
      for (const analyzer of analyzers) {
        if (typeof analyzer !== 'function') continue
        try {
          const produced = await analyzer({ session: summary(session), blocks: description.blocks, diff, checks: wanted })
          if (Array.isArray(produced)) findings.push(...produced)
        } catch (error) {
          log('warn', 'analyzer failed', { error: error instanceof Error ? error.message : String(error) })
        }
      }
      const codes = [...new Set(findings.map((finding) => finding.code).filter((code) => typeof code === 'string'))]
      return { handle: session.handle, ok: findings.length === 0, findings, codes }
    },

    /** @param {string} handle - session handle. @returns {Promise<object>} pending changes and commit history. */
    async revisions(handle) {
      const session = requireSession(handle)
      let diff
      try {
        diff = await engine.diff(session.engineSessionId)
      } catch (error) {
        diff = { counts: { added: 0, removed: 0, changed: 0, total: 0 }, changed: false }
      }
      return {
        handle: session.handle,
        path: session.path,
        revision: session.revision,
        baseRevision: session.baseRevision,
        editorRevision: leases.get(pathKey(session.path))?.revision ?? null,
        editorDirty: leases.get(pathKey(session.path))?.editorDirty === true,
        stale: session.stale,
        pending: { changes: diff.counts, ops: session.opLog.length },
        commits: session.revisions,
      }
    },

    /**
     * Serialize the working document and write it through the shared store under
     * the lease's base-revision check. A stale base or a dirty editor writes
     * nothing and is refused.
     * @param {string} handle - session handle.
     * @param {{ force?: boolean }} [commitOptions] - write even with no pending ops.
     * @returns {Promise<object>} the applied revision and hash.
     */
    async commit(handle, commitOptions = {}) {
      const session = requireSession(handle)
      assertCommitStore()
      if (session.fork !== undefined) {
        throw new ModelError(MODEL_CODES.FORKED_COMMIT, 'a forked document cannot commit; merge the fork into its parent and commit there')
      }

      if (session.stale) {
        throw new ModelError(MODEL_CODES.STALE_BASE, 'the document changed on disk since this session opened; reload it before committing', {
          details: { baseRevision: session.baseRevision },
        })
      }
      if (session.opLog.length === 0 && commitOptions.force !== true) {
        return { handle: session.handle, path: session.path, applied: false, changed: false, revision: session.baseRevision }
      }
      if (typeof session.documentId !== 'string' || session.documentId === '') {
        throw new ModelError(MODEL_CODES.WRITE_UNAVAILABLE, 'this session was opened from bytes; open it by path to commit')
      }
      let view
      try {
        view = await documents.info(session.documentId)
      } catch (error) {
        throw new ModelError(MODEL_CODES.COMMIT_FAILED, 'could not read the document lease', { cause: error })
      }
      if (view.modified === true) {
        throw new ModelError(MODEL_CODES.EDITOR_DIRTY, 'the editor has unsaved changes; save or reload it before the agent commits', {
          details: { path: session.path, editorRevision: view.revision },
        })
      }
      const base = session.baseRevision
      if (view.revision !== base) {
        session.stale = true
        throw new ModelError(MODEL_CODES.STALE_BASE, 'the document changed on disk since this session opened; reload it before committing', {
          details: { baseRevision: base, currentRevision: view.revision },
        })
      }
      const directory = await tempRoot()
      const staged = path.join(directory, `commit-${randomUUID()}.docx`)
      let saved
      try {
        saved = await engine.save(session.engineSessionId, { targetPath: staged })
      } catch (error) {
        throw mapEngineError(error, MODEL_CODES.COMMIT_FAILED)
      } finally {
        await rm(staged, { force: true }).catch(() => {})
      }
      if (!saved || !saved.bytes || saved.bytes.length === 0) {
        throw new ModelError(MODEL_CODES.COMMIT_FAILED, 'the engine returned no DOCX bytes')
      }
      let applied
      try {
        applied = await documents.applyBytes(session.path, saved.bytes, { baseRevision: base, source: 'docx-model/commit' })
      } catch (error) {
        const code = error && typeof error.code === 'string' ? error.code : undefined
        if (code === 'DOC_STALE_BASE') {
          session.stale = true
          throw new ModelError(MODEL_CODES.STALE_BASE, 'the document changed on disk since this session opened; reload it before committing', {
            cause: error,
            details: { baseRevision: base },
          })
        }
        if (code === 'DOC_EDITOR_DIRTY') {
          throw new ModelError(MODEL_CODES.EDITOR_DIRTY, 'the editor has unsaved changes; save or reload it before the agent commits', { cause: error })
        }
        throw new ModelError(MODEL_CODES.COMMIT_FAILED, 'the document write failed', { cause: error, details: { code } })
      }
      const record = {
        revision: applied.revision,
        previousRevision: base,
        baseRevision: base,
        at: now().toISOString(),
        size: saved.bytes.length,
        sha256: saved.sha256 ?? sha256(saved.bytes),
        engineRevision: saved.revision,
        ops: session.opLog.length,
      }
      session.revisions.push(record)
      session.baseRevision = applied.revision
      const lease = leases.get(pathKey(session.path))
      if (lease !== undefined) {
        lease.revision = applied.revision
        lease.updatedAt = now().toISOString()
      }
      await rebase(session, saved.bytes)
      log('info', 'committed document', { handle: session.handle, path: session.path, revision: applied.revision, size: record.size })
      return {
        handle: session.handle,
        path: session.path,
        applied: true,
        changed: true,
        revision: applied.revision,
        previousRevision: base,
        size: record.size,
        sha256: record.sha256,
        changedBlocks: record.ops,
      }
    },

    /**
     * Fork the current working state into an isolated engine session. A fork
     * cannot commit; the parent merges it by stable block id.
     * @param {string} handle - parent session handle.
     * @param {{ label?: string }} [forkOptions] - task label for the fork and its findings.
     * @returns {Promise<object>} fork summary with `forkedFrom` and `label`.
     */
    async fork(handle, forkOptions = {}) {
      const parent = requireSession(handle)
      assertWritesAllowed()
      const description = await describeSession(parent)
      const directory = await tempRoot()
      const staged = path.join(directory, `fork-${randomUUID()}.docx`)
      let saved
      try {
        saved = await engine.save(parent.engineSessionId, { targetPath: staged })
      } catch (error) {
        throw mapEngineError(error, MODEL_CODES.COMMIT_FAILED)
      } finally {
        await rm(staged, { force: true }).catch(() => {})
      }
      const label = typeof forkOptions.label === 'string' && forkOptions.label !== ''
        ? forkOptions.label
        : `fork-${parent.forkChildren.size + 1}`
      const forkHandle = `fork-${sha256(`${parent.handle}\n${label}\n${randomUUID()}`).slice(0, 10)}`
      const author = `agent:${forkHandle}`
      let opened
      try {
        opened = await engine.open({ bytes: saved.bytes, name: parent.name }, { author })
      } catch (error) {
        throw mapEngineError(error, MODEL_CODES.OPEN_FAILED)
      }
      const baseBlocks = description.blocks.map((block) => ({ ...block }))
      const session = {
        handle: forkHandle,
        ownerSessionId: parent.ownerSessionId ?? '',
        path: parent.path,
        name: parent.name,
        contentHash: sha256(saved.bytes),
        author,
        engineSessionId: opened.sessionId,
        documentId: undefined,
        revision: 0,
        baseRevision: parent.baseRevision,
        openFacts: opened,
        blocksAtOpen: opened.blocks,
        paragraphsAtOpen: opened.paragraphs,
        tablesAtOpen: opened.tables,
        tokensAtOpen: description.tokens,
        outlineAtOpen: description.outline,
        readMode: parent.readMode,
        baseBlocks,
        opLog: [],
        revisions: [],
        stale: false,
        cached: undefined,
        forkChildren: new Set(),
        fork: { parent: parent.handle, label, baseBlocks },
        taskLabel: label,
        diffSeenOps: 0,
        diffSeenAt: null,
      }
      sessions.set(forkHandle, session)
      parent.forkChildren.add(forkHandle)
      const forkDescription = await describeSession(session).catch(() => undefined)
      if (forkDescription !== undefined) {
        session.baseBlocks = forkDescription.blocks
        session.cached = forkDescription
      }
      log('info', 'forked document', { fork: forkHandle, parent: parent.handle, label })
      return { ...summary(session), forkedFrom: parent.handle, label }
    },

    /**
     * Three-way merge one or more forks of the same parent by stable block id.
     *
     * Unchanged-in-a-fork takes the other side; a change present in one fork (or
     * identical changes in several) applies to the parent; a different change on
     * both sides, delete-vs-edit, or distinct changes to one block become a
     * conflict returned to the caller. Non-conflicting changes still apply.
     * @param {string} handle - parent session handle.
     * @param {string[]} forkHandles - forks of this parent.
     * @returns {Promise<object>} applied count, conflicts and the parent revision.
     */
    async merge(handle, forkHandles) {
      const parent = requireSession(handle)
      assertWritesAllowed()
      const forks = []
      for (const forkHandle of Array.isArray(forkHandles) ? forkHandles : []) {
        const fork = sessions.get(String(forkHandle))
        if (fork === undefined || fork.fork === undefined || fork.fork.parent !== parent.handle) {
          throw new ModelError(MODEL_CODES.INVALID_OP, `not a fork of ${parent.handle}: ${String(forkHandle)}`)
        }
        forks.push(fork)
      }
      if (forks.length === 0) throw new ModelError(MODEL_CODES.INVALID_OP, 'merge needs at least one fork')
      const parentDescription = await describeSession(parent)
      const parentById = new Map(parentDescription.blocks.map((block) => [block.id, block]))
      const baseById = new Map()
      for (const fork of forks) {
        for (const block of fork.fork.baseBlocks) baseById.set(block.id, block)
      }
      const forkDescriptions = await Promise.all(forks.map((fork) => describeSession(fork)))
      const forkByIds = forkDescriptions.map((description) => new Map(description.blocks.map((block) => [block.id, block])))
      const ids = new Set([
        ...baseById.keys(),
        ...parentById.keys(),
        ...forkByIds.flatMap((map) => [...map.keys()]),
      ])
      const conflicts = []
      const replacements = []
      const deletions = []
      const insertions = []
      for (const id of ids) {
        const base = baseById.get(id)
        const parentBlock = parentById.get(id)
        const candidates = []
        for (let index = 0; index < forks.length; index++) {
          const forkBlock = forkByIds[index].get(id)
          const changed = base === undefined
            ? forkBlock !== undefined
            : forkBlock === undefined ? true : blockSignature(forkBlock) !== blockSignature(base)
          if (changed) candidates.push({ forkIndex: index, label: forks[index].fork.label, block: forkBlock })
        }
        if (candidates.length === 0) continue
        const parentChanged = base === undefined
          ? parentBlock !== undefined
          : parentBlock === undefined ? true : blockSignature(parentBlock) !== blockSignature(base)
        const distinct = new Map()
        for (const candidate of candidates) {
          const signature = candidate.block === undefined ? '<deleted>' : blockSignature(candidate.block)
          if (!distinct.has(signature)) distinct.set(signature, candidate)
        }
        if (parentChanged) {
          const parentSignature = parentBlock === undefined ? '<deleted>' : blockSignature(parentBlock)
          if (distinct.has(parentSignature)) continue
          conflicts.push({
            id,
            base: base === undefined ? null : clip(base.text, 300),
            parent: parentBlock === undefined ? null : clip(parentBlock.text, 300),
            candidates: candidates.map((candidate) => ({
              task: candidate.label,
              text: candidate.block === undefined ? null : clip(candidate.block.text, 300),
            })),
          })
          continue
        }
        if (distinct.size > 1) {
          conflicts.push({
            id,
            base: base === undefined ? null : clip(base.text, 300),
            parent: parentBlock === undefined ? null : clip(parentBlock.text, 300),
            candidates: [...distinct.values()].map((candidate) => ({
              task: candidate.label,
              text: candidate.block === undefined ? null : clip(candidate.block.text, 300),
            })),
          })
          continue
        }
        const only = [...distinct.values()][0]
        const block = only.block
        if (block === undefined) {
          deletions.push({ id, expectedText: parentBlock === undefined ? '' : parentBlock.text })
          continue
        }
        if (base === undefined) {
          const forkBlocks = forkDescriptions[only.forkIndex].blocks
          const forkIndex = forkBlocks.findIndex((candidate) => candidate.id === id)
          // Anchor on the nearest preceding block that exists in the base or the
          // parent, so a fork that deleted a preceding block still inserts in the
          // same gap as a fork that kept it (task order at one anchor).
          let anchor = -1
          for (let index = forkIndex - 1; index >= 0; index--) {
            const priorId = forkBlocks[index].id
            const prior = parentById.get(priorId) ?? baseById.get(priorId)
            if (prior !== undefined) { anchor = prior.index; break }
          }
          insertions.push({ anchor: anchor + 1, order: only.forkIndex, text: block.text ?? '' })
          continue
        }
        replacements.push({ id, expectedText: parentBlock === undefined ? '' : parentBlock.text, text: block.text ?? '' })
      }
      const applied = []
      const failed = []
      for (const deletion of deletions) {
        try {
          await model.edit(parent.handle, { type: 'delete_paragraph', blockId: deletion.id, expectedText: deletion.expectedText })
          applied.push({ op: 'delete_paragraph', id: deletion.id })
        } catch (error) {
          failed.push({ id: deletion.id, code: error && error.code ? error.code : 'DOC_MERGE_FAILED' })
        }
      }
      for (const replacement of replacements) {
        try {
          await model.edit(parent.handle, {
            type: 'replace_paragraph',
            blockId: replacement.id,
            expectedText: replacement.expectedText,
            text: replacement.text,
          })
          applied.push({ op: 'replace_paragraph', id: replacement.id })
        } catch (error) {
          failed.push({ id: replacement.id, code: error && error.code ? error.code : 'DOC_MERGE_FAILED' })
        }
      }
      insertions.sort((left, right) => left.anchor - right.anchor || left.order - right.order)
      const shifted = new Map()
      for (const insertion of insertions) {
        const offset = shifted.get(insertion.anchor) ?? 0
        shifted.set(insertion.anchor, offset + 1)
        try {
          await model.edit(parent.handle, {
            type: 'insert_paragraph',
            index: insertion.anchor + offset,
            text: insertion.text,
          })
          applied.push({ op: 'insert_paragraph', index: insertion.anchor + offset })
        } catch (error) {
          failed.push({ index: insertion.anchor + offset, code: error && error.code ? error.code : 'DOC_MERGE_FAILED' })
        }
      }
      return {
        doc: parent.handle,
        forks: forks.map((fork) => ({ handle: fork.handle, label: fork.fork.label })),
        applied: applied.length,
        operations: applied,
        conflicts,
        failed,
        revision: parent.revision,
        changed: applied.length > 0,
      }
    },

    /**
     * Reload the session from the current file revision (after a human save or a
     * conflict) and reset the diff base.
     * @param {string} handle - session handle.
     * @returns {Promise<object>} the refreshed summary.
     */
    async reload(handle) {
      const session = requireSession(handle)
      let view = null
      if (documents !== undefined) view = await documents.open(session.path)
      const bytes = await readFileImpl(session.path)
      session.baseRevision = typeof view?.revision === 'string' ? view.revision : sha256(bytes)
      session.stale = false
      session.revisions = session.revisions
      await rebase(session, bytes)
      const lease = leases.get(pathKey(session.path))
      if (lease !== undefined) {
        lease.revision = session.baseRevision
        lease.editorDirty = view?.modified === true
        lease.conflict = null
        lease.updatedAt = now().toISOString()
      }
      return { ...summary(session), reloaded: true }
    },

    /** @param {string} handle - session handle. @returns {Promise<{ handle: string, closed: boolean }>} close fact; idempotent. */
    async close(handle) {
      const session = sessions.get(String(handle))
      if (session === undefined) return { handle: String(handle), closed: true }
      sessions.delete(session.handle)
      for (const [key, value] of byKey) {
        if (value === session.handle) byKey.delete(key)
      }
      const lease = leases.get(pathKey(session.path))
      if (lease !== undefined && lease.holder === session.handle) leases.delete(pathKey(session.path))
      await engine.close(session.engineSessionId).catch(() => {})
      log('info', 'closed document', { handle: session.handle })
      return { handle: session.handle, closed: true }
    },

    /**
     * Rehydrate a session by content hash. Process-local sessions are not
     * persisted; this only finds a session already open in this activation.
     * @param {string} contentHash - full content hash. @returns {object} summary or a not-found error.
     */
    rehydrate(contentHash) {
      for (const session of sessions.values()) {
        if (session.contentHash === contentHash) return summary(session)
      }
      throw new ModelError(MODEL_CODES.SESSION_NOT_FOUND, `no open session for content hash ${contentHash}; open the path again`)
    },

    /** @param {string} handle - session handle. @returns {object} the public session contract. */
    contract(handle) {
      const session = requireSession(handle)
      return sessionContract(session, leases.get(pathKey(session.path)))
    },

    /** @param {string} handle - session handle. @param {{ force?: boolean }} [options] - commit options. */
    commitEligibility(handle, options = {}) {
      return commitEligibility(requireSession(handle), options)
    },

    /** @param {string} handle - session handle. @returns {object[]} public op-log entries. */
    pendingOperations(handle) {
      return requireSession(handle).opLog.map(operationContract)
    },

    /** @param {string} [cwd] - restrict to documents under this directory. @param {string} [ownerSessionId] - restrict to one DSH session. @returns {object[]} session facts. */
    status(cwd, ownerSessionId) {
      const rows = []
      for (const session of sessions.values()) {
        if (typeof ownerSessionId === 'string' && ownerSessionId !== '' && session.ownerSessionId !== ownerSessionId) continue
        if (typeof cwd === 'string' && cwd !== '') {
          const resolved = path.resolve(cwd)
          if (session.path !== resolved && !session.path.startsWith(`${resolved}${path.sep}`)) continue
        }
        const lease = leases.get(pathKey(session.path))
        rows.push({
          handle: session.handle,
          ownerSessionId: session.ownerSessionId ?? '',
          path: session.path,
          name: session.name,
          revision: session.revision,
          baseRevision: session.baseRevision,
          contentHash: session.contentHash,
          readMode: session.readMode,
          stale: session.stale,
          pendingOps: session.opLog.length,
          taskLabel: session.taskLabel ?? null,
          diffSeenOps: session.diffSeenOps ?? 0,
          editorDirty: lease?.editorDirty === true,
          conflict: lease?.conflict ?? null,
        })
      }
      return rows
    },

    /** @param {string} [cwd] - restrict to documents under this directory. @param {string} [ownerSessionId] - restrict to one DSH session. @returns {string[]} runtime-context lines. */
    statusLines(cwd, ownerSessionId) {
      const lines = []
      for (const session of sessions.values()) {
        if (typeof ownerSessionId === 'string' && ownerSessionId !== '' && session.ownerSessionId !== ownerSessionId) continue
        if (typeof cwd === 'string' && cwd !== '') {
          const resolved = path.resolve(cwd)
          if (session.path !== resolved && !session.path.startsWith(`${resolved}${path.sep}`)) continue
        }
        lines.push(statusLine(session))
      }
      return lines
    },

    /**
     * Record a human/editor save: the new file revision makes an agent session
     * stale until it reloads.
     * @param {string} file - document path. @param {string} revision - new revision hash.
     */
    noteSaved(file, revision) {
      const key = pathKey(file)
      const lease = leases.get(key)
      if (lease !== undefined) {
        lease.revision = revision
        lease.editorDirty = false
        lease.conflict = null
        lease.updatedAt = now().toISOString()
      }
      for (const session of sessions.values()) {
        if (pathKey(session.path) !== key) continue
        if (session.baseRevision !== revision) session.stale = true
      }
    },

    /** @param {string} file - document path. @param {string} code - conflict code. */
    noteConflict(file, code) {
      const lease = leases.get(pathKey(file))
      if (lease !== undefined) {
        lease.conflict = typeof code === 'string' ? code : 'DOC_CONFLICT'
        lease.updatedAt = now().toISOString()
      }
    },

    /** @param {string} file - document path. @param {boolean} dirty - editor dirty flag. */
    noteEditorDirty(file, dirty) {
      const lease = leases.get(pathKey(file))
      if (lease !== undefined) {
        lease.editorDirty = dirty === true
        lease.updatedAt = now().toISOString()
      }
    },

    /** Stop every engine session; idempotent. */
    dispose() {
      if (disposeOnce !== null) return disposeOnce
      disposeOnce = (async () => {
        for (const session of sessions.values()) {
          await engine.close(session.engineSessionId).catch(() => {})
        }
        sessions.clear()
        byKey.clear()
        leases.clear()
        if (tempRootOnce !== null) {
          const root = await tempRootOnce.catch(() => undefined)
          tempRootOnce = null
          if (typeof root === 'string') await rm(root, { recursive: true, force: true }).catch(() => {})
        }
      })()
      return disposeOnce
    },
  }

  return model
}
