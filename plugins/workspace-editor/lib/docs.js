/**
 * Document store for the editor plugin: one temp folder per open document, an
 * Editor.bin the editor works on, and DOCX/PDF written back through x2t.
 *
 * The store is also the revision authority. Every document has a SHA-256
 * content revision; writes carry an optional base revision and are refused with
 * `DOC_STALE_BASE` when the file moved, or `DOC_EDITOR_DIRTY` when the open tab
 * holds unsaved changes. All document writes go through an
 * `editorDocumentsStore` seam, so a versioned adapter can replace the default
 * in-place local store. The temp layout mirrors the desktop host this borrows
 * from: a per-document folder holding `Editor.bin`, `media/` for inserted
 * images, and `x2t/` for the converter scratch.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ERROR_CODES } from './errors.js'
import { resolveDocumentPath } from './scope.js'
import { convert, FORMAT_BIN, FORMAT_DOCX, FORMAT_PDF, X2tError } from './x2t.js'

const EXTENSIONS = { '.docx': 'word', '.doc': 'word', '.pdf': 'pdf' }
const DEFAULT_BACKUP_RETENTION = 20

/** Default `wait` deadline; a caller can shorten or extend it per call. */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000
/** How often a pending wait re-reads the file to notice a write outside this store. */
const WAIT_POLL_MS = 500

/** An editor-session failure the routes report as a named HTTP error. */
export class DocError extends Error {
  /**
   * @param {string} message - operator-facing failure.
   * @param {{ status?: number, code?: string, cause?: unknown }} [details] - HTTP status, failure code and cause.
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'DocError'
    this.status = details.status ?? 500
    this.code = details.code
  }
}

/** @param {Uint8Array} bytes - content bytes. @returns {string} lowercase hex SHA-256. */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** @param {string} revision - a content revision. @returns {string} the short form used in messages. */
function shortRevision(revision) {
  return typeof revision === 'string' ? revision.slice(0, 12) : String(revision)
}

/** @param {string} file - absolute path. @returns {string} the document ID from the spec. */
function documentId(file) {
  return createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 12)
}

/** @param {string} value - candidate. @returns {string} required non-empty string. */
function requiredBase(value) {
  if (typeof value === 'string' && value !== '') return value
  throw new DocError('a base revision is required', { status: 400, code: ERROR_CODES.BASE_REQUIRED })
}

/** @param {string} message - operator text. @param {string} code - public code. @param {number} status - HTTP status. */
function storeError(message, code, status) {
  return new DocError(message, { status, code })
}

/** A stale write: the file is not the revision the caller read. */
function staleBase(file, base, current) {
  return new DocError(
    `document changed since revision ${shortRevision(base)}`
      + (current === undefined ? '' : ` (now ${shortRevision(current)})`),
    { status: 409, code: 'DOC_STALE_BASE' },
  )
}

/** Missing-file failures become the routes' 404 instead of an internal error. */
async function statOr404(store, file) {
  try {
    return await store.stat(file)
  } catch (error) {
    if (error instanceof DocError) throw error
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      throw new DocError(`no such file: ${file}`, { status: 404 })
    }
    throw error
  }
}

/**
 * Default store: writes the file in place through a same-directory temp file
 * and hashes content for revisions. It caches a revision by file mtime and size
 * so repeated status reads do not re-hash a large document.
 * @returns {{ stat: Function, write: Function }} the local store seam.
 */
export function createLocalStore() {
  /** @type {Map<string, { revision: string, mtimeMs: number, size: number }>} */
  const cache = new Map()

  /** @param {string} file - absolute path. */
  async function read(file) {
    const bytes = await readFile(file)
    const info = await stat(file)
    const revision = sha256(bytes)
    cache.set(file, { revision, mtimeMs: info.mtimeMs, size: info.size })
    return { bytes, revision, mtimeMs: info.mtimeMs, size: info.size }
  }

  /** @param {string} file - absolute path. */
  async function statRevision(file) {
    const info = await stat(file)
    const cached = cache.get(file)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return { revision: cached.revision, mtimeMs: info.mtimeMs, size: info.size }
    }
    const fresh = await read(file)
    return { revision: fresh.revision, mtimeMs: fresh.mtimeMs, size: fresh.size }
  }

  /**
   * @param {string} file - absolute path.
   * @param {Uint8Array} bytes - new content.
   * @param {{ baseRevision?: string }} [options] - expected current revision.
   */
  async function write(file, bytes, options = {}) {
    const absolute = path.resolve(file)
    if (options.baseRevision !== undefined) {
      const current = await statRevision(absolute).catch((error) => {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined
        throw error
      })
      if (current === undefined || current.revision !== options.baseRevision) {
        throw staleBase(absolute, options.baseRevision, current?.revision)
      }
    }
    await mkdir(path.dirname(absolute), { recursive: true })
    const temp = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${randomUUID()}.tmp`)
    await writeFile(temp, bytes)
    try {
      await rename(temp, absolute)
    } finally {
      await rm(temp, { force: true }).catch(() => {})
    }
    const revision = sha256(bytes)
    const info = await stat(absolute)
    cache.set(absolute, { revision, mtimeMs: info.mtimeMs, size: info.size })
    return { revision, mtimeMs: info.mtimeMs, size: info.size }
  }

  return { stat: statRevision, write, read }
}

/**
 * The `editorDocumentsStore` seam: the default local store, or the provided
 * adapter after its required members are checked. The adapter owns revision
 * reads (`stat`) and every document write (`write`); a bad adapter fails plugin
 * activation instead of surfacing later as a lost write.
 * @param {unknown} candidate - `ctx.get('editorDocumentsStore')`.
 */
function resolveStore(candidate) {
  if (candidate === undefined || candidate === null) return createLocalStore()
  for (const member of ['stat', 'write']) {
    if (typeof /** @type {Record<string, unknown>} */ (candidate)[member] !== 'function') {
      throw new Error(`editorDocumentsStore must provide ${member}()`)
    }
  }
  return /** @type {{ stat: Function, write: Function }} */ (candidate)
}

/**
 * Convert a DOCX to the editor's binary form.
 * @param {string} file - absolute DOCX path.
 * @param {string} tempDir - per-document temp folder.
 * @returns {Promise<string>} path of the produced Editor.bin.
 */
async function docxToBin(file, tempDir) {
  const binPath = path.join(tempDir, 'Editor.bin')
  await convert({ from: file, to: binPath, format: FORMAT_BIN, tempDir: path.join(tempDir, 'x2t') })
  const info = await stat(binPath).catch(() => undefined)
  if (info === undefined || info.size === 0) throw new DocError(`x2t produced no Editor.bin for ${file}`)
  return binPath
}

/**
 * Convert the editor's package bytes to DOCX bytes in the doc's temp folder;
 * the caller writes them through the store.
 * @param {Uint8Array} bytes - the editor's package bytes.
 * @param {string} tempDir - per-document temp folder.
 * @returns {Promise<Buffer>} new DOCX bytes.
 */
async function binToDocxBytes(bytes, tempDir) {
  const binPath = path.join(tempDir, 'save.bin')
  const outPath = path.join(tempDir, 'save.docx')
  await writeFile(binPath, bytes)
  await convert({ from: binPath, to: outPath, format: FORMAT_DOCX, tempDir: path.join(tempDir, 'x2t') })
  const info = await stat(outPath).catch(() => undefined)
  if (info === undefined || info.size < 1024) throw new DocError('x2t produced no DOCX')
  return readFile(outPath)
}

/**
 * Convert committed DOCX bytes to an Editor.bin in the doc's temp folder,
 * before the document write. An unconvertible document then fails the commit
 * without touching the document; the caller renames the result over Editor.bin.
 * @param {Uint8Array} bytes - new DOCX bytes.
 * @param {string} tempDir - per-document temp folder.
 * @returns {Promise<string>} path of the produced Editor.bin.
 */
async function docxBytesToBin(bytes, tempDir) {
  const source = path.join(tempDir, `apply-${randomUUID()}.docx`)
  const binPath = path.join(tempDir, `apply-${randomUUID()}.bin`)
  await writeFile(source, bytes)
  await convert({ from: source, to: binPath, format: FORMAT_BIN, tempDir: path.join(tempDir, 'x2t') })
  const info = await stat(binPath).catch(() => undefined)
  if (info === undefined || info.size === 0) throw new DocError('x2t produced no Editor.bin for the committed bytes')
  return binPath
}

/**
 * Replace a file through a same-directory temp file. Used for Editor.bin, the
 * editor's derived scratch copy, not for the document itself.
 * @param {string} file - destination path.
 * @param {Uint8Array} bytes - new content.
 */
async function writeAtomically(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, bytes)
  try {
    await rename(temp, file)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

/** Keep one store per plugin activation. */
export function createDocStore(options = {}) {
  const store = resolveStore(options.store)
  const workspaceRoot = typeof options.workspaceRoot === 'string' ? path.resolve(options.workspaceRoot) : undefined
  const configuredRoots = Array.isArray(options.allowedRoots) ? options.allowedRoots : []
  const backupRetention = Number.isInteger(options.backupRetention) && options.backupRetention >= 0
    ? options.backupRetention
    : DEFAULT_BACKUP_RETENTION
  /** Host-side observer: document/editor/saved/conflict facts, broadcast by `lib/index.js`. */
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
  /**
   * @type {Map<string, {
   *   id: string, path: string, name: string, kind: string, tempDir: string,
   *   binPath: string, binRevision: string, revision: string, mtimeMs: number,
   *   modified: boolean, loadedRevision: string, lastCommand?: string,
   * }>}
   */
  const docs = new Map()
  /** Case-insensitive absolute path to open document, for path-keyed writes. */
  const byPath = new Map()
  /** @type {Set<{ file: string, baseline: string, resolve: Function, timer: NodeJS.Timeout }>} */
  const waiters = new Set()
  /** @type {NodeJS.Timeout | undefined} */
  let pollTimer
  let disposed = false

  /** @param {Record<string, unknown>} event - one store fact for the host observer. */
  function notify(event) {
    if (disposed) return
    try {
      onEvent(event)
    } catch {
      // A host observer is not allowed to fail a completed store operation.
    }
  }

  /** @param {string} file - document path. @param {string} [cwd] - session root. @returns {Promise<string>} confined path. */
  async function confine(file, cwd) {
    const base = typeof cwd === 'string' && cwd !== '' ? cwd : workspaceRoot
    if (base === undefined) return path.resolve(file)
    return resolveDocumentPath(file, { cwd: base, roots: configuredRoots })
  }

  /** @param {string} file - absolute document path. @returns {string} backup directory. */
  function backupDirectory(file) {
    return path.join(workspaceRoot ?? path.dirname(file), '.workspace-editor', 'backups', documentId(file))
  }

  /** @param {string} file - document path. @returns {Promise<{ bytes: Buffer, revision: string } | undefined>} current backup source. */
  async function currentBytes(file) {
    let current
    try {
      current = await store.stat(file)
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined
      throw error
    }
    const value = typeof store.read === 'function' ? await store.read(file) : await readFile(file)
    const bytes = Buffer.isBuffer(value) ? value : value.bytes
    return { bytes, revision: current.revision }
  }

  /** Remove backups beyond the retention count, newest first. @param {string} directory - backup directory. */
  async function pruneBackups(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return
      throw error
    }
    const files = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const file = path.join(directory, entry.name)
      const info = await stat(file)
      files.push({ file, name: entry.name, mtimeMs: info.mtimeMs })
    }
    files.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name))
    for (const entry of files.slice(backupRetention)) await unlink(entry.file)
  }

  /**
   * Call the adapter's backup or write the local copy of the previous bytes.
   * @param {string} file - document path.
   * @param {{ bytes: Buffer, revision: string }} previous - bytes being replaced.
   */
  async function backupPrevious(file, previous) {
    if (typeof store.backup === 'function') {
      await store.backup(file, previous.bytes, previous.revision)
      return
    }
    const directory = backupDirectory(file)
    await mkdir(directory, { recursive: true })
    const name = `${previous.revision}${path.extname(file)}`
    await writeFile(path.join(directory, name), previous.bytes)
    await pruneBackups(directory)
  }

  /** @param {string} file - document path. */
  async function backupBeforeOverwrite(file) {
    const previous = await currentBytes(file)
    if (previous !== undefined) await backupPrevious(file, previous)
  }

  /** @param {string} file - document path. @returns {Promise<string[]>} earlier revisions, oldest first. */
  async function historyOf(file) {
    if (typeof store.history === 'function') return await store.history(file)
    const directory = backupDirectory(file)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return []
      throw error
    }
    const files = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const filePath = path.join(directory, entry.name)
      const info = await stat(filePath)
      files.push({ file: filePath, name: entry.name, mtimeMs: info.mtimeMs })
    }
    files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name))
    return files.map((entry) => path.basename(entry.name, path.extname(entry.name)))
  }

  /** @param {any} doc - open document record. */
  function view(doc) {
    return {
      id: doc.id,
      name: doc.name,
      kind: doc.kind,
      path: doc.path,
      revision: doc.revision,
      mtimeMs: doc.mtimeMs,
      modified: doc.modified,
      loadedRevision: doc.loadedRevision,
      ownerSessionId: doc.ownerSessionId ?? '',
    }
  }

  /** @param {string} file - absolute path. @returns {string} map key. */
  function pathKey(file) {
    return file.toLowerCase()
  }

  /** @param {any} doc - open document record; re-reads its on-disk revision. */
  async function refresh(doc) {
    const current = await statOr404(store, doc.path)
    doc.revision = current.revision
    doc.mtimeMs = current.mtimeMs
    return doc
  }

  /**
   * Bytes the editor opens. Re-converts a stale `Editor.bin` when the DOCX
   * moved since the last conversion, so a controlled reload never shows an old
   * revision.
   * @param {any} doc - open document record.
   * @returns {Promise<Buffer>} document bytes.
   */
  async function editorBytes(doc) {
    if (doc.kind !== 'word') return readFile(doc.path)
    if (doc.binPath !== '' && doc.binRevision === doc.revision) return readFile(doc.binPath)
    doc.binPath = await docxToBin(doc.path, doc.tempDir)
    doc.binRevision = doc.revision
    return readFile(doc.binPath)
  }

  /**
   * Open a document: convert DOCX to Editor.bin (PDF opens as-is), then hand
   * the editor its identity and revision.
   * @param {string} file - absolute path to a .docx, .doc or .pdf.
   * @param {{ cwd?: string }} [openOptions] - session root for confinement.
   * @returns {Promise<object>} the opened document view.
   */
  async function open(file, openOptions = {}) {
    const absolute = await confine(file, openOptions.cwd)
    const kind = EXTENSIONS[path.extname(absolute).toLowerCase()]
    if (kind === undefined) throw new DocError(`unsupported document type: ${path.extname(absolute)}`, { status: 400 })
    const current = await statOr404(store, absolute)

    const existing = byPath.get(pathKey(absolute))
    if (existing !== undefined) {
      await refresh(existing)
      return view(existing)
    }

    const id = createHash('sha1').update(absolute).digest('hex').slice(0, 12)
    // Unique per activation: a plugin reload disposes the previous store
    // asynchronously, and a shared folder would race that cleanup.
    const tempDir = path.join(tmpdir(), 'workspace-editor', `${id}-${randomUUID().slice(0, 8)}`)
    await mkdir(path.join(tempDir, 'media'), { recursive: true })
    /** @type {any} */
    const doc = {
      id,
      path: absolute,
      name: path.basename(absolute),
      kind,
      tempDir,
      binPath: '',
      binRevision: '',
      revision: current.revision,
      mtimeMs: current.mtimeMs,
      modified: false,
      loadedRevision: current.revision,
      ownerSessionId: typeof openOptions.sessionId === 'string' ? openOptions.sessionId : '',
    }
    if (kind === 'word') {
      doc.binPath = await docxToBin(absolute, tempDir)
      doc.binRevision = current.revision
    }
    docs.set(id, doc)
    byPath.set(pathKey(absolute), doc)
    notify({ type: 'document', source: 'open', document: view(doc), reload: false })
    return view(doc)
  }

  /**
   * @param {string} id - document id from open().
   */
  function get(id) {
    const doc = docs.get(id)
    if (doc === undefined) throw new DocError(`unknown document ${id}`, { status: 404 })
    return doc
  }

  /**
   * Current state of one open document.
   * @param {string} id - document id.
   * @returns {Promise<object>} document view.
   */
  async function info(id) {
    const doc = await refresh(get(id))
    return view(doc)
  }

  /** @returns {object[]} every open document view. */
  function list() {
    return [...docs.values()].map(view)
  }

  /**
   * Bytes the editor opens: Editor.bin for Word documents, the PDF file itself otherwise.
   * @param {string} id - document id.
   * @returns {Promise<{ bytes: Buffer, revision: string, kind: string }>} document bytes and their revision.
   */
  async function readBytes(id) {
    const doc = get(id)
    await refresh(doc)
    const bytes = await editorBytes(doc)
    return { bytes, revision: doc.revision, kind: doc.kind }
  }

  /**
   * Write document bytes (already DOCX/PDF, never Editor.bin) at a path, with
   * the lease's two refusals: a dirty open editor and a stale base revision.
   * This is the agent commit path; the editor reloads from the new bytes.
   * @param {string} file - absolute document path.
   * @param {Uint8Array} bytes - new document bytes.
   * @param {{ baseRevision?: string, allowDirty?: boolean, source?: string }} [writeOptions] - lease terms.
   * @returns {Promise<object>} path, new revision and the document view when the tab is open.
   */
  async function applyBytes(file, bytes, writeOptions = {}) {
    const absolute = await confine(file, writeOptions.cwd)
    const base = requiredBase(writeOptions.baseRevision)
    const doc = byPath.get(pathKey(absolute))
    if (doc !== undefined) {
      await refresh(doc)
      if (doc.modified && writeOptions.allowDirty !== true) {
        notify({ type: 'conflict', path: absolute, base, current: doc.revision, code: 'DOC_EDITOR_DIRTY' })
        throw new DocError('the editor has unsaved changes', { status: 409, code: 'DOC_EDITOR_DIRTY' })
      }
      if (base !== doc.revision) {
        notify({ type: 'conflict', path: absolute, base, current: doc.revision, code: 'DOC_STALE_BASE' })
        throw staleBase(absolute, base, doc.revision)
      }
    }

    /** @type {{ revision: string, mtimeMs: number }} */
    let written
    // Convert before the write: an unconvertible document fails the commit
    // without touching the file, so "failed commit writes nothing" holds.
    const preparedBin = doc !== undefined && doc.kind === 'word'
      ? await docxBytesToBin(bytes, doc.tempDir)
      : undefined
    await backupBeforeOverwrite(absolute)
    try {
      written = await store.write(absolute, bytes, { baseRevision: base })
    } catch (error) {
      if (error instanceof DocError && error.code === 'DOC_STALE_BASE') {
        const current = await statOr404(store, absolute).catch(() => undefined)
        notify({ type: 'conflict', path: absolute, base, current: current?.revision, code: error.code })
      }
      throw error
    }

    if (doc !== undefined) {
      doc.revision = written.revision
      doc.mtimeMs = written.mtimeMs
      if (preparedBin !== undefined) {
        await rename(preparedBin, doc.binPath)
        doc.binRevision = written.revision
      }
      notify({
        type: 'document',
        source: writeOptions.source ?? 'applyBytes',
        document: view(doc),
        reload: true,
      })
    } else {
      notify({
        type: 'document',
        source: writeOptions.source ?? 'applyBytes',
        document: { path: absolute, revision: written.revision, mtimeMs: written.mtimeMs },
        reload: false,
      })
    }
    notify({ type: 'saved', path: absolute, revision: written.revision })
    settleWaiters()
    return {
      path: absolute,
      revision: written.revision,
      applied: true,
      document: doc === undefined ? undefined : view(doc),
    }
  }

  /**
   * Earlier store revisions of one document, oldest first.
   * @param {string} id - document id.
   * @returns {Promise<string[]>} revisions.
   */
  async function history(id) {
    return historyOf(get(id).path)
  }

  /**
   * Persist editor bytes to the document's own path. The bytes are Editor.bin
   * for Word documents and PDF bytes otherwise.
   * @param {string} id - document id.
   * @param {Uint8Array} content - bytes from the editor.
   * @param {{ base?: string }} [saveOptions] - the revision the tab loaded.
   * @returns {Promise<object>} path, revision and file time.
   */
  async function save(id, content, saveOptions = {}) {
    const doc = get(id)
    await refresh(doc)
    const base = requiredBase(saveOptions.base)
    if (base !== doc.revision) {
      notify({ type: 'conflict', path: doc.path, base, current: doc.revision, code: 'DOC_STALE_BASE' })
      throw staleBase(doc.path, base, doc.revision)
    }
    const documentBytes = doc.kind === 'word' ? await binToDocxBytes(content, doc.tempDir) : content
    let written
    try {
      await backupBeforeOverwrite(doc.path)
      written = await store.write(doc.path, documentBytes, { baseRevision: base })
    } catch (error) {
      if (error instanceof DocError && error.code === 'DOC_STALE_BASE') {
        const current = await statOr404(store, doc.path).catch(() => undefined)
        notify({ type: 'conflict', path: doc.path, base, current: current?.revision, code: error.code })
      }
      throw error
    }
    doc.revision = written.revision
    doc.mtimeMs = written.mtimeMs
    doc.modified = false
    doc.loadedRevision = written.revision
    if (doc.kind === 'word') {
      // Keep the opened copy equal to what was saved, so a later export or
      // reload does not re-convert these bytes again.
      await writeAtomically(doc.binPath, content)
      doc.binRevision = written.revision
    }
    notify({ type: 'document', source: 'save', document: view(doc), reload: false })
    notify({ type: 'saved', path: doc.path, revision: written.revision })
    settleWaiters()
    return { path: doc.path, revision: written.revision, mtimeMs: written.mtimeMs, modified: false }
  }

  /**
   * Save As to another path, leaving the open document where it is.
   * @param {string} id - document id.
   * @param {Uint8Array} content - bytes from the editor.
   * @param {string} target - destination path.
   * @param {{ base?: string }} [saveOptions] - the revision the tab loaded.
   * @returns {Promise<{ path: string, revision: string }>} written path and revision.
   */
  async function saveAs(id, content, target, saveOptions = {}) {
    const doc = get(id)
    await refresh(doc)
    const absolute = await confine(target, saveOptions.cwd)
    if (path.extname(absolute).toLowerCase() !== path.extname(doc.path).toLowerCase()) {
      throw storeError(`save-as target must keep the ${path.extname(doc.path)} type`, ERROR_CODES.INVALID_TARGET, 400)
    }
    let existing
    try {
      existing = await store.stat(absolute)
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    }
    if (existing !== undefined && saveOptions.overwrite !== true) {
      throw storeError('save-as target exists; pass overwrite=true to replace it', ERROR_CODES.TARGET_EXISTS, 409)
    }
    const base = typeof saveOptions.base === 'string' && saveOptions.base !== '' ? saveOptions.base : undefined
    if (base !== undefined && base !== doc.revision) {
      notify({ type: 'conflict', path: doc.path, base, current: doc.revision, code: 'DOC_STALE_BASE' })
      throw staleBase(doc.path, base, doc.revision)
    }
    const documentBytes = doc.kind === 'word' ? await binToDocxBytes(content, doc.tempDir) : content
    if (existing !== undefined) await backupBeforeOverwrite(absolute)
    const written = await store.write(absolute, documentBytes, existing === undefined ? {} : { baseRevision: existing.revision })
    notify({ type: 'saved', path: absolute, revision: written.revision })
    return { path: absolute, revision: written.revision }
  }

  /**
   * Report the editor's own state (unsaved changes and the revision it loaded).
   * @param {string} id - document id.
   * @param {{ modified?: boolean, revision?: string, command?: string, ok?: boolean }} patch - editor report.
   * @returns {object} document view.
   */
  function setEditorState(id, patch) {
    const doc = get(id)
    const nextModified = typeof patch.modified === 'boolean' ? patch.modified : doc.modified
    const loadedRevision = typeof patch.revision === 'string' && patch.revision !== ''
      ? patch.revision
      : doc.loadedRevision
    const changed = doc.modified !== nextModified || doc.loadedRevision !== loadedRevision
    doc.modified = nextModified
    doc.loadedRevision = loadedRevision
    if (typeof patch.command === 'string') doc.lastCommand = patch.command
    if (changed || patch.command !== undefined) {
      notify({
        type: 'editor',
        document: view(doc),
        command: patch.command,
        ok: patch.ok === true,
      })
    }
    return view(doc)
  }

  /**
   * Wait until a document's revision moves away from `since`.
   * @param {string} target - document id or absolute path.
   * @param {{ since?: string, timeoutMs?: number }} [waitOptions] - baseline revision and deadline.
   * @returns {Promise<{ path: string, revision: string, changed: boolean, timedOut: boolean }>}
   */
  async function wait(target, waitOptions = {}) {
    const known = docs.get(target)
    const doc = known ?? byPath.get(pathKey(path.resolve(target)))
    const file = doc !== undefined ? doc.path : path.resolve(target)
    const timeoutMs = Number.isFinite(waitOptions.timeoutMs)
      ? Math.max(1, /** @type {number} */ (waitOptions.timeoutMs))
      : DEFAULT_WAIT_TIMEOUT_MS
    const baseline = typeof waitOptions.since === 'string' && waitOptions.since !== ''
      ? waitOptions.since
      : doc?.revision
    const current = await statOr404(store, file)
    if (baseline === undefined) {
      return { path: file, revision: current.revision, changed: false, timedOut: false }
    }
    if (current.revision !== baseline) {
      return { path: file, revision: current.revision, changed: true, timedOut: false }
    }
    return new Promise((resolve) => {
      /** @type {any} */
      const entry = { file, baseline, resolve, timer: undefined }
      entry.timer = setTimeout(() => {
        finish(entry, { path: entry.file, revision: entry.baseline, changed: false, timedOut: true })
      }, timeoutMs)
      waiters.add(entry)
      ensurePoll()
    })
  }

  /** Settle one waiting call and stop the poll when nothing waits. */
  function finish(entry, result) {
    if (!waiters.delete(entry)) return
    clearTimeout(entry.timer)
    if (waiters.size === 0) stopPoll()
    entry.resolve(result)
  }

  /** Re-read each waited document once and settle the ones that moved. */
  function settleWaiters() {
    for (const entry of [...waiters]) {
      void statOr404(store, entry.file).then((current) => {
        if (current.revision !== entry.baseline) {
          finish(entry, { path: entry.file, revision: current.revision, changed: true, timedOut: false })
        }
      }, () => {
        // A vanished file is not a revision change the caller can use; the
        // deadline reports the timeout instead of a false success.
      })
    }
  }

  /** Keep a low-frequency poll only while a call waits on an external write. */
  function ensurePoll() {
    if (pollTimer !== undefined) return
    pollTimer = setInterval(settleWaiters, WAIT_POLL_MS)
    pollTimer.unref?.()
  }

  function stopPoll() {
    if (pollTimer === undefined) return
    clearInterval(pollTimer)
    pollTimer = undefined
  }

  /**
   * Export the document to PDF.
   * @param {string} id - document id.
   * @returns {Promise<{ path: string, bytes: Buffer }>} the rendered PDF.
   */
  async function exportPdf(id) {
    const doc = get(id)
    const pdfPath = path.join(doc.tempDir, `${path.basename(doc.path, path.extname(doc.path))}.pdf`)
    if (doc.kind === 'word') {
      await convert({ from: doc.path, to: pdfPath, format: FORMAT_PDF, tempDir: path.join(doc.tempDir, 'x2t'), pdf: true })
    } else {
      throw new DocError('PDF export applies to Word documents', { status: 400 })
    }
    const bytes = await readFile(pdfPath)
    return { path: pdfPath, bytes }
  }

  /** Close a document and clear its temp folder. Idempotent. */
  async function close(id) {
    const doc = docs.get(id)
    if (doc === undefined) return
    docs.delete(id)
    byPath.delete(pathKey(doc.path))
    notify({ type: 'document', source: 'close', document: view(doc), reload: false, closed: true })
    await rm(doc.tempDir, { recursive: true, force: true }).catch(() => {})
  }

  /** Close every editor document opened by one disposed DSH session. @param {string} ownerSessionId - DSH session. */
  async function closeOwner(ownerSessionId) {
    for (const doc of [...docs.values()]) {
      if (doc.ownerSessionId === ownerSessionId) await close(doc.id)
    }
  }

  /** Forget every document, waiter and timer (plugin disposal). */
  async function disposeAll() {
    disposed = true
    stopPoll()
    for (const entry of [...waiters]) {
      finish(entry, { path: entry.file, revision: entry.baseline, changed: false, timedOut: true })
    }
    const ids = [...docs.keys()]
    for (const id of ids) {
      const doc = docs.get(id)
      if (doc === undefined) continue
      docs.delete(id)
      byPath.delete(pathKey(doc.path))
      await rm(doc.tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return {
    open,
    get,
    info,
    list,
    readBytes,
    applyBytes,
    save,
    saveAs,
    history,
    setEditorState,
    wait,
    exportPdf,
    close,
    closeOwner,
    disposeAll,
  }
}

export { X2tError }
