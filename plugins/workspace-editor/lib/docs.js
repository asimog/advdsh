/**
 * Document store for the editor plugin: one temp folder per open document, an
 * Editor.bin the editor works on, and DOCX/PDF written back through x2t.
 *
 * The temp layout mirrors the desktop host this borrows from: a per-document
 * folder holding `Editor.bin`, `media/` for inserted images, and `x2t/` for the
 * converter scratch. Media must live beside the document, because sdkjs
 * resolves inserted images against the document's media address.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { convert, FORMAT_BIN, FORMAT_DOCX, FORMAT_PDF, X2tError } from './x2t.js'

const EXTENSIONS = { '.docx': 'word', '.doc': 'word', '.pdf': 'pdf' }

/** An editor-session failure the routes report as a named HTTP error. */
export class DocError extends Error {
  /**
   * @param {string} message - operator-facing failure.
   * @param {{ status?: number, cause?: unknown }} [details] - HTTP status and cause.
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'DocError'
    this.status = details.status ?? 500
  }
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
 * Write Editor.bin bytes back to a DOCX path, atomically.
 * @param {Uint8Array} bytes - the editor's package bytes.
 * @param {string} target - destination DOCX.
 * @param {string} tempDir - per-document temp folder.
 */
async function binToDocx(bytes, target, tempDir) {
  const binPath = path.join(tempDir, 'save.bin')
  const outPath = path.join(tempDir, 'save.docx')
  await writeFile(binPath, bytes)
  await convert({ from: binPath, to: outPath, format: FORMAT_DOCX, tempDir: path.join(tempDir, 'x2t') })
  const info = await stat(outPath).catch(() => undefined)
  if (info === undefined || info.size < 1024) throw new DocError(`x2t produced no DOCX for ${target}`)
  // Rename over the target so a failed conversion never truncates the document.
  await rename(outPath, target)
}

/** Keep one store per plugin activation. */
export function createDocStore() {
  /** @type {Map<string, { id: string, path: string, name: string, kind: string, tempDir: string, binPath: string, modifiedAt: number }>} */
  const docs = new Map()

  /**
   * Open a document: convert DOCX to Editor.bin (PDF opens as-is), then hand
   * the editor its identity.
   * @param {string} file - absolute path to a .docx, .doc or .pdf.
   * @returns {Promise<{ id: string, name: string, kind: string }>} the opened document.
   */
  async function open(file) {
    const absolute = path.resolve(file)
    const kind = EXTENSIONS[path.extname(absolute).toLowerCase()]
    if (kind === undefined) throw new DocError(`unsupported document type: ${path.extname(absolute)}`, { status: 400 })
    const info = await stat(absolute).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new DocError(`no such file: ${absolute}`, { status: 404 })

    const id = createHash('sha1').update(absolute).digest('hex').slice(0, 12)
    const existing = docs.get(id)
    if (existing !== undefined) return { id, name: existing.name, kind: existing.kind }

    const tempDir = path.join(tmpdir(), 'workspace-editor', id)
    await mkdir(path.join(tempDir, 'media'), { recursive: true })
    const name = path.basename(absolute)
    const doc = { id, path: absolute, name, kind, tempDir, binPath: '', modifiedAt: info.mtimeMs }
    if (kind === 'word') doc.binPath = await docxToBin(absolute, tempDir)
    docs.set(id, doc)
    return { id, name, kind }
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
   * Bytes the editor opens: Editor.bin for Word documents, the PDF file itself otherwise.
   * @param {string} id - document id.
   * @returns {Promise<Buffer>} document bytes.
   */
  async function bytes(id) {
    const doc = get(id)
    return doc.kind === 'word' ? await readFile(doc.binPath) : await readFile(doc.path)
  }

  /**
   * Persist editor bytes to the document's own path.
   * @param {string} id - document id.
   * @param {Uint8Array} content - bytes from the editor.
   */
  async function save(id, content) {
    const doc = get(id)
    if (doc.kind === 'word') {
      await binToDocx(content, doc.path, doc.tempDir)
    } else {
      const temp = path.join(doc.tempDir, 'save.pdf')
      await writeFile(temp, content)
      await rename(temp, doc.path)
    }
    const info = await stat(doc.path)
    doc.modifiedAt = info.mtimeMs
    return { path: doc.path, mtimeMs: doc.modifiedAt }
  }

  /**
   * Save As to another path, leaving the open document where it is.
   * @param {string} id - document id.
   * @param {Uint8Array} content - bytes from the editor.
   * @param {string} target - destination path.
   */
  async function saveAs(id, content, target) {
    const doc = get(id)
    const absolute = path.resolve(target)
    await mkdir(path.dirname(absolute), { recursive: true })
    if (doc.kind === 'word') {
      await binToDocx(content, absolute, doc.tempDir)
    } else {
      await writeFile(absolute, content)
    }
    return { path: absolute }
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

  /** Close a document and clear its temp folder. */
  async function close(id) {
    const doc = docs.get(id)
    if (doc === undefined) return
    docs.delete(id)
    await rm(doc.tempDir, { recursive: true, force: true }).catch(() => {})
  }

  /** Forget every document (plugin disposal). */
  async function disposeAll() {
    for (const id of [...docs.keys()]) await close(id)
  }

  return { open, get, bytes, save, saveAs, exportPdf, close, disposeAll }
}

export { X2tError }
