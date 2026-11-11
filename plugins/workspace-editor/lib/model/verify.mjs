/**
 * Verification harness for `ctx.docxModel` (not part of the Cordis row).
 *
 * Proves the model over the real `ctx.docxEngine` and the real `editorDocuments`
 * store on a working copy of the fixture: open â†’ outline/search/context reads â†’
 * one tracked replace + list item â†’ diff â†’ check â†’ lease-checked commit â†’ OOXML
 * checks â†’ reload â†’ dirty-editor and stale-base refusals â†’ idempotent close.
 *
 * Run from the repo root:
 *   node plugins/workspace-editor/lib/model/verify.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { createDocStore } from '../docs.js'
import { createDocxEngine, createNodeRuntime } from '../engine/manager.js'
import { resolveEngineConfig } from '../engine/locate.js'
import { createLegalAnalyzers } from '../review/analyzers.js'
import { createDocxModel, MODEL_CODES } from './model.js'

const modelDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(modelDir, '..', '..', '..', '..')
const OUT_DIR = path.join(modelDir, 'out')
const SOURCE = path.join(repoRoot, 'workspace-test', 'TRO - Motion.docx')
const WORKING = path.join(OUT_DIR, 'TRO - Motion.docx')
const REPORT = path.join(OUT_DIR, 'verification.json')
const AUTHOR = `agent:verify-${Date.now()}`

const checks = {}
const facts = {}

/** @param {string} name - check name. @param {boolean} value - result. @param {unknown} [detail] - failure facts. */
function check(name, value, detail) {
  checks[name] = value === true
  if (value !== true) console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`)
  return value === true
}

/** @param {string} message - progress line. */
function log(message) {
  console.error(`[model-verify] ${message}`)
}

/** Minimal ZIP reader: central directory, stored/deflate entries. */
function readZip(buffer) {
  const entries = new Map()
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 65536; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd === -1) throw new Error('not a zip (no end of central directory)')
  const count = buffer.readUInt16LE(eocd + 10)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  let offset = cdOffset
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory entry')
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`bad local header for ${name}`)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    entries.set(name, method === 0 ? raw : inflateRawSync(raw))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** @param {Buffer} buffer - saved DOCX bytes. @param {string} author - expected revision author. */
function verifySavedDocx(buffer, author) {
  const entries = readZip(buffer)
  const documentXml = entries.get('word/document.xml') ?? Buffer.alloc(0)
  const text = documentXml.toString('utf8')
  const authors = Array.from(new Set((text.match(/w:author="([^"]*)"/g) ?? [])
    .map((value) => value.slice('w:author="'.length, -1))))
  return {
    bytes: buffer.length,
    entries: entries.size,
    hasDocumentXml: entries.has('word/document.xml'),
    replacements: text.includes('DOCMODEL-REPLACED'),
    removedOriginal: !text.includes('seeks entry of an ex parte'),
    listItem: text.includes('DOCMODEL-LIST-ITEM'),
    insertions: (text.match(/<w:ins\s/g) ?? []).length,
    deletions: (text.match(/<w:del\s/g) ?? []).length,
    authors,
    authorPresent: authors.includes(author),
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

/** Build the small `editorDocuments` surface the model consumes from a real doc store. */
function documentsFromStore(store) {
  return {
    open: (file) => store.open(file),
    info: (id) => store.info(id),
    applyBytes: (file, bytes, options) => store.applyBytes(file, bytes, options),
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  await rm(REPORT, { force: true })
  if (!existsSync(SOURCE)) throw new Error(`fixture is missing: ${SOURCE}`)
  await copyFile(SOURCE, WORKING)

  const config = resolveEngineConfig({
    logDir: path.join(OUT_DIR, 'logs'),
    tempRoot: path.join(OUT_DIR, 'temp'),
  })
  facts.config = { electron: config.electron, eoRoot: config.eoRoot, x2t: config.x2t, missing: config.missing }
  check('config_paths_present', config.missing.length === 0, config.missing)
  if (config.missing.length > 0) throw new Error(`engine is not configured: ${config.missing.join('; ')}`)

  const engine = createDocxEngine(config, { runtime: createNodeRuntime() })
  const store = createDocStore({ workspaceRoot: OUT_DIR })
  const model = createDocxModel({
    engine,
    documents: documentsFromStore(store),
    analyzers: createLegalAnalyzers(),
    log: (level, message, data) => log(`${level} ${message}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`),
  })
  /** @type {string|undefined} */
  let handle

  try {
    // --- open and read modes -------------------------------------------------
    const opened = await model.open(WORKING, { author: AUTHOR })
    handle = opened.handle
    facts.open = opened
    check('open_session', typeof opened.handle === 'string' && opened.handle.startsWith('doc-'))
    check('open_blocks', opened.blocks >= 10 && opened.paragraphs > 0, { blocks: opened.blocks })
    check('open_read_mode', opened.readMode === 'full' || opened.readMode === 'large', opened.readMode)
    check('open_content_hash', typeof opened.contentHash === 'string' && opened.contentHash.length === 64)

    const outline = await model.read(handle, { mode: 'outline' })
    check('read_outline', Array.isArray(outline.outline))
    const search = await model.read(handle, { mode: 'search', query: 'temporary restraining' })
    check('read_search', search.matches.length > 0, { matches: search.matches.length })
    const target = search.matches[0]
    facts.target = target
    const context = await model.read(handle, { mode: 'context', blockId: target.id, before: 1, after: 2 })
    check('read_context', context.blocks.some((block) => block.id === target.id))

    // --- legal analyzers over the real fixture ------------------------------
    const analyzed = await model.check(handle)
    facts.analysis = { codes: analyzed.codes, findings: analyzed.findings.length }
    check('analyze_ran', Array.isArray(analyzed.codes) && Array.isArray(analyzed.findings))

    // --- one tracked replace + list item ------------------------------------
    const replaced = await model.edit(handle, {
      type: 'replace_paragraph',
      blockId: target.id,
      text: 'DOCMODEL-REPLACED',
    })
    facts.replace = replaced
    check('edit_replace_tracked', replaced.tracked === true && replaced.changed === 1)
    const listed = await model.edit(handle, { type: 'insert_list_item', text: 'DOCMODEL-LIST-ITEM' })
    check('edit_list_item', listed.changed >= 1)
    const diff = await model.diff(handle)
    facts.diff = diff.counts
    check('diff_reports_changes', diff.changed === true && diff.counts.total >= 2, diff.counts)
    const checked = await model.check(handle)
    check('check_pending', checked.codes.includes('PENDING_REVISIONS'), checked.codes)

    // --- commit through the shared store ------------------------------------
    await model.diff(handle)
    const committed = await model.commit(handle)
    facts.commit = { revision: committed.revision, size: committed.size, previousRevision: committed.previousRevision }
    check('commit_applied', committed.applied === true)
    check('commit_revision_moved', committed.revision !== committed.previousRevision)
    const savedBytes = await readFile(WORKING)
    const docx = verifySavedDocx(savedBytes, AUTHOR)
    facts.docx = docx
    check('docx_saved', existsSync(WORKING) && docx.bytes > 1024)
    check('docx_document_xml', docx.hasDocumentXml)
    check('docx_replacement', docx.replacements)
    check('docx_original_removed', docx.removedOriginal)
    check('docx_list_item', docx.listItem)
    check('docx_tracked_insertions', docx.insertions > 0, { insertions: docx.insertions })
    check('docx_tracked_deletions', docx.deletions > 0, { deletions: docx.deletions })
    check('docx_agent_author', docx.authorPresent, { authors: docx.authors })
    const afterCommit = await model.diff(handle)
    check('diff_clean_after_commit', afterCommit.changed === false, afterCommit.counts)
    const noop = await model.commit(handle)
    check('commit_noop_without_edits', noop.applied === false)

    // --- fork, edit the fork, merge into the parent -------------------------
    const fork = await model.fork(handle, { label: 'verify-fork' })
    facts.fork = { handle: fork.handle, label: fork.label }
    check('fork_created', fork.handle.startsWith('fork-') && fork.forkedFrom === handle)
    const beforeMerge = await model.read(handle, { mode: 'search', query: 'DOCMODEL-FORK-EDIT' })
    check('fork_isolated', beforeMerge.matches.length === 0)
    const forkTarget = (await model.read(fork.handle, { mode: 'search', query: 'DOCMODEL-REPLACED' })).matches[0]
    check('fork_reads_parent_state', forkTarget !== undefined)
    if (forkTarget) {
      await model.edit(fork.handle, { type: 'replace_paragraph', blockId: forkTarget.id, text: 'DOCMODEL-FORK-EDIT' })
    }
    const merged = await model.merge(handle, [fork.handle])
    facts.merge = { applied: merged.applied, conflicts: merged.conflicts.length, failed: merged.failed.length }
    check('merge_applied', merged.applied === 1 && merged.conflicts.length === 0, facts.merge)
    const mergedView = await model.read(handle, { mode: 'search', query: 'DOCMODEL-FORK-EDIT' })
    check('parent_has_merged_text', mergedView.matches.length > 0)
    const forkCommit = await model.commit(fork.handle, { force: true }).then(() => null, (error) => error)
    check('fork_cannot_commit', forkCommit !== null && forkCommit.code === MODEL_CODES.FORKED_COMMIT, forkCommit && forkCommit.code)
    await model.diff(handle)
    const afterMergeCommit = await model.commit(handle)
    check('commit_after_merge', afterMergeCommit.applied === true)
    await model.close(fork.handle)

    // --- lease refusals ------------------------------------------------------
    await model.reload(handle)
    const afterReload = await model.read(handle, { mode: 'search', query: 'DOCMODEL-FORK-EDIT' })
    facts.reloadTarget = {
      before: target.id,
      after: afterReload.matches[0]?.id ?? null,
      sameId: afterReload.matches[0]?.id === target.id,
    }
    check('reload_finds_committed_text', afterReload.matches.length > 0)
    check('reload_block_id_stable', afterReload.matches[0]?.id === target.id, facts.reloadTarget)
    const secondTarget = afterReload.matches[0]
    if (!secondTarget) throw new Error('committed replacement text is not readable after reload')
    await model.edit(handle, { type: 'replace_paragraph', blockId: secondTarget.id, text: 'DOCMODEL-SECOND-EDIT' })
    const info = store.list()[0]
    facts.editorDocument = info
    store.setEditorState(info.id, { modified: true })
    await model.diff(handle)
    const dirty = await model.commit(handle).then(() => null, (error) => error)
    check('commit_refuses_dirty_editor', dirty !== null && dirty.code === MODEL_CODES.EDITOR_DIRTY, dirty && dirty.code)
    store.setEditorState(info.id, { modified: false })
    await writeFile(WORKING, await readFile(SOURCE))
    await model.diff(handle)
    const stale = await model.commit(handle).then(() => null, (error) => error)
    check('commit_refuses_stale_base', stale !== null && stale.code === MODEL_CODES.STALE_BASE, stale && stale.code)
    const reloaded = await model.reload(handle)
    check('reload_after_conflict', typeof reloaded.baseRevision === 'string' && reloaded.baseRevision.length === 64)
    const status = model.status()
    check('status_reports_session', status.length === 1 && status[0].handle === handle, status)

    // --- leave a committed, tracked artifact for the Word-open sweep --------
    const wordTarget = (await model.read(handle, { mode: 'search', query: 'temporary restraining' })).matches[0]
    check('word_target_found', wordTarget !== undefined)
    if (wordTarget) {
      await model.edit(handle, {
        type: 'replace_paragraph',
        blockId: wordTarget.id,
        text: 'DOCMODEL-WORD-CHECK',
      })
      await model.diff(handle)
      const finalCommit = await model.commit(handle)
      facts.finalCommit = { applied: finalCommit.applied, revision: finalCommit.revision, size: finalCommit.size }
      check('final_commit_for_word', finalCommit.applied === true)
    }
  } finally {
    if (handle !== undefined) await model.close(handle).catch(() => {})
    await model.dispose().catch(() => {})
    await engine.dispose().catch(() => {})
    await store.disposeAll().catch(() => {})
  }

  const ok = Object.values(checks).every(Boolean)
  const report = { ok, at: new Date().toISOString(), source: SOURCE, working: WORKING, author: AUTHOR, checks, facts }
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ok, report: REPORT, checks }, null, 2))
  if (!ok) process.exitCode = 1
}

main().catch(async (error) => {
  const report = { ok: false, at: new Date().toISOString(), error: String(error && error.stack || error), checks, facts }
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => {})
  console.error(String(error && error.stack || error))
  process.exitCode = 1
})

