/**
 * Verification harness for `ctx.docxEngine` (not part of the Cordis row).
 *
 * Proves the full sidecar path on a real fixture: open → describe → tracked
 * replace → list item → table row → diff → save → x2t DOCX → zip/OOXML checks
 * → reopen. Also exercises timeout/cancel, crash log/restart and the awaited
 * exit on dispose when the sidecar test hooks are enabled.
 *
 * Run from the repo root:
 *   node plugins/workspace-editor/lib/engine/verify.mjs \
 *     --docx "workspace-test/TRO - Motion.docx" \
 *     --out plugins/workspace-editor/lib/engine/out/verified.docx
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { createDocxEngine } from './manager.js'
import { createNodeRuntime } from './manager.js'
import { resolveEngineConfig } from './locate.js'

const engineDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(engineDir, '..', '..', '..', '..')

function arg(name, fallback) {
  const prefix = `--${name}=`
  const hit = process.argv.find((value) => value.startsWith(prefix))
  return hit === undefined ? fallback : hit.slice(prefix.length)
}

const DOCX = path.resolve(arg('docx', path.join(repoRoot, 'workspace-test', 'TRO - Motion.docx')))
const OUT_DIR = path.resolve(arg('out-dir', path.join(engineDir, 'out')))
const OUT_DOCX = path.resolve(arg('out', path.join(OUT_DIR, 'verified.docx')))
const REPORT = path.resolve(arg('report', path.join(OUT_DIR, 'verification.json')))
const WITH_HOOKS = process.argv.includes('--with-hooks')
const AUTHOR = arg('author', `agent:verify-${Date.now()}`)

const checks = {}
const facts = {}

function check(name, value, detail) {
  checks[name] = value === true
  if (value !== true) console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`)
  return value === true
}

function log(message) {
  console.error(`[verify] ${message}`)
}

/** Minimal ZIP reader: central directory, stored/deflate entries, full CRCs via inflate. */
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
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null
    if (data === null) throw new Error(`unsupported compression method ${method} for ${name}`)
    entries.set(name, data)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function verifyDocx(buffer, author) {
  const entries = readZip(buffer)
  const documentXml = entries.get('word/document.xml')
  const text = documentXml ? documentXml.toString('utf8') : ''
  const markers = {
    replaced: text.includes('DBSPIKE-REPLACED-PARAGRAPH'),
    list: text.includes('DBSPIKE-LIST-ITEM'),
    tableRow: text.includes('DBSPIKE-TABLE-ROW'),
  }
  const listParagraph = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g
  let listNumbered = false
  for (const match of text.matchAll(listParagraph)) {
    if (match[0].includes('DBSPIKE-LIST-ITEM') && match[0].includes('<w:numPr>')) listNumbered = true
  }
  const insMatches = text.match(/<w:ins\s/g) ?? []
  const delMatches = text.match(/<w:del\s/g) ?? []
  const authorMatches = text.match(/w:author="([^"]*)"/g) ?? []
  const authors = Array.from(new Set(authorMatches.map((value) => value.slice('w:author="'.length, -1))))
  return {
    bytes: buffer.length,
    entries: entries.size,
    hasContentTypes: entries.has('[Content_Types].xml'),
    hasDocumentXml: entries.has('word/document.xml'),
    markers,
    originalSentenceRemoved: !text.includes('seeks entry of an ex parte'),
    listNumbered,
    tableRows: (text.match(/<w:tr(?:\s[^>]*)?>/g) ?? []).length,
    insertions: insMatches.length,
    deletions: delMatches.length,
    authors,
    trackedAuthorPresent: authors.includes(author),
    documentXmlBytes: documentXml ? documentXml.length : 0,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  await rm(REPORT, { force: true })
  await rm(OUT_DOCX, { force: true })
  if (!existsSync(DOCX)) throw new Error(`fixture is missing: ${DOCX}`)

  const config = resolveEngineConfig({
    logDir: path.join(OUT_DIR, 'logs'),
    tempRoot: path.join(OUT_DIR, 'temp'),
  })
  facts.config = { electron: config.electron, eoRoot: config.eoRoot, x2t: config.x2t, missing: config.missing }
  check('config_paths_present', config.missing.length === 0, config.missing)
  if (config.missing.length > 0) throw new Error(`engine is not configured: ${config.missing.join('; ')}`)

  const runtime = createNodeRuntime()
  const engine = createDocxEngine(config, { runtime })
  /** The test-hook engine is separate so the main one can be disposed first. */
  let hooked = null
  facts.author = AUTHOR

  try {
    // --- cancelled open ------------------------------------------------------
    const aborted = new AbortController()
    aborted.abort()
    try {
      await engine.open({ path: DOCX }, { signal: aborted.signal })
      check('cancelled_open_rejected', false)
    } catch (error) {
      check('cancelled_open_rejected', error && error.code === 'ENGINE_CANCELLED', error && error.code)
    }

    // --- open → describe -----------------------------------------------------
    const opened = await engine.open({ path: DOCX }, { author: AUTHOR })
    facts.open = opened
    check('open_session', typeof opened.sessionId === 'string' && opened.sessionId.startsWith('docx-'))
    check('open_has_blocks', opened.blocks > 0 && opened.paragraphs > 0, { blocks: opened.blocks, paragraphs: opened.paragraphs })
    check('open_author', opened.author === AUTHOR)

    const base = await engine.describe(opened.sessionId)
    facts.describe = { blocks: base.blocks.length, paragraphs: base.paragraphCount, tables: base.tableCount }
    const target = base.blocks.find((block) => block.kind === 'paragraph' && block.text.includes('seeks entry of an ex parte'))
    check('describe_finds_sentence', target !== undefined)
    if (!target) throw new Error('fixture sentence not found; cannot prove replace')
    facts.target = { id: target.id, index: target.index, text: target.text }

    // --- tracked replace (run-level) → list item → table row -----------------
    const replaced = await engine.apply(opened.sessionId, {
      type: 'replace_paragraph',
      blockId: target.id,
      expectedText: target.text,
      text: 'DBSPIKE-REPLACED-PARAGRAPH',
    })
    facts.replace = replaced
    check('apply_replace_tracked', replaced.revision === 1 && replaced.tracked === true)

    const stale = await engine.apply(opened.sessionId, {
      type: 'replace_paragraph',
      blockId: target.id,
      expectedText: 'this text is not there',
      text: 'should not apply',
    }).then(() => null, (error) => error)
    check('apply_stale_target', stale && stale.code === 'ENGINE_STALE_TARGET', stale && stale.code)

    await engine.apply(opened.sessionId, { type: 'insert_list_item', text: 'DBSPIKE-LIST-ITEM' })
    await engine.apply(opened.sessionId, { type: 'insert_table_row', cells: ['DBSPIKE-TABLE-ROW'] })

    const working = await engine.describe(opened.sessionId)
    facts.working = { blocks: working.blocks.length, paragraphs: working.paragraphCount, tables: working.tableCount }
    check('working_has_markers', working.blocks.some((block) => block.text.includes('DBSPIKE-LIST-ITEM')))

    // --- diff ----------------------------------------------------------------
    const diff = await engine.diff(opened.sessionId)
    facts.diff = diff.counts
    check('diff_reports_changes', diff.changed === true && diff.counts.total >= 2, diff.counts)

    // --- save → x2t DOCX -----------------------------------------------------
    const saved = await engine.save(opened.sessionId, { targetPath: OUT_DOCX })
    facts.save = { path: saved.path, size: saved.size, revision: saved.revision, sha256: saved.sha256 }
    check('save_wrote_docx', existsSync(OUT_DOCX) && saved.size > 0)
    const verified = verifyDocx(await readFile(OUT_DOCX), AUTHOR)
    facts.docx = verified
    check('zip_entries_readable', verified.entries > 0 && verified.hasContentTypes && verified.hasDocumentXml)
    check('marker_replace', verified.markers.replaced)
    check('marker_list', verified.markers.list)
    check('marker_table_row', verified.markers.tableRow)
    check('original_sentence_removed', verified.originalSentenceRemoved)
    check('list_item_numbered', verified.listNumbered)
    check('table_row_inserted', verified.tableRows >= 2, { rows: verified.tableRows })
    check('tracked_insertions_present', verified.insertions > 0)
    check('tracked_deletions_present', verified.deletions > 0)
    check('tracked_author_present', verified.trackedAuthorPresent, { authors: verified.authors })

    // --- reopen the saved DOCX ----------------------------------------------
    const reopened = await engine.open({ path: OUT_DOCX }, { author: AUTHOR })
    const reopenedDescription = await engine.describe(reopened.sessionId)
    const reopenedTarget = reopenedDescription.blocks.find((block) => block.text.includes('DBSPIKE-REPLACED-PARAGRAPH'))
    check('reopen_saved_docx', reopenedTarget !== undefined)
    facts.reopenTarget = reopenedTarget === undefined
      ? null
      : { id: reopenedTarget.id, paraId: reopenedTarget.paraId, baseId: target.id, baseParaId: target.paraId }
    check('reopen_ids_stable', reopenedTarget !== undefined && reopenedTarget.id === target.id, facts.reopenTarget)
    await engine.close(reopened.sessionId)
    await engine.close(opened.sessionId)
    check('close_idempotent', (await engine.close(opened.sessionId)).closed === true)

    // --- dispose awaits exit -------------------------------------------------
    await engine.dispose()
    facts.exit = engine.status().lastExit
    check('dispose_awaits_exit', engine.status().running === false && facts.exit !== null && facts.exit.exitCode === 0, facts.exit)

    // --- crash log/restart, timeout/cancel (test hooks) ----------------------
    if (WITH_HOOKS) {
      hooked = createDocxEngine(resolveEngineConfig({
        logDir: path.join(OUT_DIR, 'logs'),
        tempRoot: path.join(OUT_DIR, 'temp'),
        testHooks: true,
      }), { runtime })
      // Start first: `pid` is null until the sidecar is spawned, so the crash
      // driver must remember the pid of a sidecar that actually ran.
      await hooked.start()
      const deadPid = hooked.status().pid
      const crash = await hooked.debugExit().then(() => null, (error) => error)
      check('crash_reported', crash && crash.code === 'ENGINE_CRASHED', crash && crash.code)
      // `running` turns true when the replacement process is spawned; `ready`
      // only when its RPC listener answers. Wait for a NEW pid that is ready, so
      // timeout/cancel talk to a usable sidecar instead of the dead port.
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        const status = hooked.status()
        if (status.ready === true && status.pid !== null && status.pid !== deadPid) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const restarted = hooked.status()
      check('crash_restart', restarted.ready === true && restarted.pid !== null && restarted.pid !== deadPid, restarted)
      const crashLog = path.join(OUT_DIR, 'logs', 'crash.log')
      const crashText = existsSync(crashLog) ? await readFile(crashLog, 'utf8') : ''
      check('crash_log_written', crashText.includes('sidecar-exit') && crashText.includes('debug.exit'))
      const timeout = await hooked.request('debug.sleep', { ms: 5000 }, { timeoutMs: 400, methodLabel: 'debug.sleep' }).then(() => null, (error) => error)
      check('request_timeout', timeout && timeout.code === 'ENGINE_TIMEOUT', timeout && timeout.code)
      try {
        const afterTimeout = await hooked.debugSleep(1)
        check('sidecar_survives_cancel', afterTimeout && afterTimeout.sleptMs === 1)
      } catch (error) {
        check('sidecar_survives_cancel', false, String(error && error.message || error))
      }
      await hooked.dispose()
      check('test_sidecar_disposed', hooked.status().running === false)
      hooked = null
    }
  } finally {
    await engine.dispose().catch(() => {})
    if (hooked !== null) await hooked.dispose().catch(() => {})
  }

  const ok = Object.values(checks).every(Boolean)
  const report = { ok, at: new Date().toISOString(), docx: DOCX, output: OUT_DOCX, author: AUTHOR, checks, facts }
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ok, output: OUT_DOCX, report: REPORT, checks }, null, 2))
  if (!ok) process.exitCode = 1
}

main().catch(async (error) => {
  const report = { ok: false, at: new Date().toISOString(), error: String(error && error.stack || error), checks, facts }
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => {})
  console.error(String(error && error.stack || error))
  process.exitCode = 1
})
