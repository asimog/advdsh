/**
 * Store contract tests: the mandatory base revision, save-as target checks,
 * backups, retention, the adapter backup/history seam and local history.
 * PDF fixtures avoid x2t so this file stays a unit test.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createDocStore } from '../lib/docs.js'

/** @param {Uint8Array} bytes - content. @returns {string} SHA-256. */
function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** @param {string} file - absolute path. @returns {string} document ID. */
function docId(file) {
  return createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 12)
}

/** @param {string} root - workspace root. @param {string} file - document path. @returns {string} backup directory. */
function backupDirectory(root, file) {
  return path.join(root, '.workspace-editor', 'backups', docId(file))
}

/** @param {string} directory - directory. @returns {Promise<string[]>} file names. */
async function names(directory) {
  return (await readdir(directory).catch(() => [])).sort()
}

test('a base revision is mandatory for save and applyBytes (WD-007, WD-008)', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'a.pdf')
  await writeFile(file, 'A')
  const store = createDocStore({ workspaceRoot: root })
  const opened = await store.open(file)
  await assert.rejects(store.applyBytes(file, Buffer.from('B')), (error) => error.code === 'DOC_BASE_REQUIRED')
  await assert.rejects(store.save(opened.id, Buffer.from('B')), (error) => error.code === 'DOC_BASE_REQUIRED')
  assert.equal(hash(await readFile(file)), hash(Buffer.from('A')))
  await store.disposeAll()
})

test('save-as refuses an existing target and a different file type (WD-005, WD-006)', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-store-as-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'a.pdf')
  const existing = path.join(root, 'b.pdf')
  const fresh = path.join(root, 'c.pdf')
  const wrong = path.join(root, 'd.docx')
  await writeFile(source, 'A')
  await writeFile(existing, 'B')
  const store = createDocStore({ workspaceRoot: root })
  const opened = await store.open(source)

  await assert.rejects(
    store.saveAs(opened.id, Buffer.from('A2'), existing, { base: opened.revision }),
    (error) => error.code === 'DOC_TARGET_EXISTS' && error.status === 409,
  )
  assert.equal(hash(await readFile(existing)), hash(Buffer.from('B')))

  const saved = await store.saveAs(opened.id, Buffer.from('A2'), fresh, { base: opened.revision })
  assert.equal(saved.path, fresh)
  assert.equal(hash(await readFile(fresh)), hash(Buffer.from('A2')))
  await assert.rejects(
    store.saveAs(opened.id, Buffer.from('A3'), wrong, { base: opened.revision }),
    (error) => error.code === 'DOC_INVALID_TARGET' && error.status === 400,
  )
  await assert.rejects(readFile(wrong), (error) => error.code === 'ENOENT')

  await store.saveAs(opened.id, Buffer.from('B2'), existing, { base: opened.revision, overwrite: true })
  assert.equal(hash(await readFile(existing)), hash(Buffer.from('B2')))
  const backups = await names(backupDirectory(root, existing))
  assert.equal(backups.length, 1)
  assert.equal(backups[0], `${hash(Buffer.from('B'))}.pdf`)
  await store.disposeAll()
})

test('each overwrite backs up the previous revision and keeps the newest (WD-091, WD-092)', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-store-backup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'a.pdf')
  await writeFile(file, 'A')
  const store = createDocStore({ workspaceRoot: root, backupRetention: 2 })
  const opened = await store.open(file)
  const r0 = opened.revision

  const one = await store.applyBytes(file, Buffer.from('B'), { baseRevision: r0 })
  const two = await store.applyBytes(file, Buffer.from('C'), { baseRevision: one.revision })
  const three = await store.applyBytes(file, Buffer.from('D'), { baseRevision: two.revision })
  assert.equal(hash(await readFile(file)), three.revision)

  const directory = backupDirectory(root, file)
  assert.deepEqual(await names(directory), [`${one.revision}.pdf`, `${two.revision}.pdf`].sort())
  const backupBytes = await readFile(path.join(directory, `${one.revision}.pdf`))
  assert.equal(hash(backupBytes), one.revision)
  assert.equal(r0 === one.revision, false)
  await store.disposeAll()
})

test('local history lists earlier revisions oldest first (WD-137 source)', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-store-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'a.pdf')
  await writeFile(file, 'A')
  const store = createDocStore({ workspaceRoot: root })
  const opened = await store.open(file)
  const r0 = opened.revision
  const one = await store.applyBytes(file, Buffer.from('B'), { baseRevision: r0 })
  const two = await store.applyBytes(file, Buffer.from('C'), { baseRevision: one.revision })
  assert.deepEqual(await store.history(opened.id), [r0, one.revision])
  assert.equal(two.revision, hash(Buffer.from('C')))
  await store.disposeAll()
})

test('the adapter backup and history seam receives every overwrite (WD-093)', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-store-adapter-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'a.pdf')
  await writeFile(file, 'A')
  const backups = []
  const writes = []
  const adapter = {
    async stat(target) {
      const bytes = await readFile(target)
      return { revision: hash(bytes), mtimeMs: 1, size: bytes.length }
    },
    async write(target, bytes, options = {}) {
      writes.push({ target, baseRevision: options.baseRevision })
      await writeFile(target, bytes)
      return { revision: hash(bytes), mtimeMs: 2, size: bytes.length }
    },
    async read(target) {
      const bytes = await readFile(target)
      return { bytes, revision: hash(bytes) }
    },
    async backup(target, bytes, revision) {
      backups.push({ target, bytes: Buffer.from(bytes), revision })
    },
    async history() {
      return backups.map((entry) => entry.revision)
    },
  }
  const store = createDocStore({ store: adapter, workspaceRoot: root })
  const opened = await store.open(file)
  const r0 = opened.revision
  const one = await store.applyBytes(file, Buffer.from('B'), { baseRevision: r0 })
  const two = await store.applyBytes(file, Buffer.from('C'), { baseRevision: one.revision })

  assert.deepEqual(backups.map((entry) => entry.revision), [r0, one.revision])
  assert.deepEqual(writes.map((entry) => entry.baseRevision), [r0, one.revision])
  assert.deepEqual(await store.history(opened.id), [r0, one.revision])
  assert.equal(two.revision, hash(Buffer.from('C')))
  await store.disposeAll()
})

test('a dirty editor refuses the agent write but permits the human save (WD-130)', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-store-dirty-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'a.pdf')
  await writeFile(file, 'A')
  const store = createDocStore({ workspaceRoot: root })
  const opened = await store.open(file)
  store.setEditorState(opened.id, { modified: true })
  await assert.rejects(
    store.applyBytes(file, Buffer.from('B'), { baseRevision: opened.revision }),
    (error) => error.code === 'DOC_EDITOR_DIRTY',
  )
  const saved = await store.save(opened.id, Buffer.from('C'), { base: opened.revision })
  assert.equal(saved.modified, false)
  assert.equal(hash(await readFile(file)), saved.revision)
  await store.disposeAll()
})

test('a failed adapter write leaves the old bytes and no temporary file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-store-fail-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'a.pdf')
  await writeFile(file, 'A')
  const adapter = {
    async stat(target) {
      const bytes = await readFile(target)
      return { revision: hash(bytes), mtimeMs: 1, size: bytes.length }
    },
    async read(target) {
      const bytes = await readFile(target)
      return { bytes, revision: hash(bytes) }
    },
    async write() {
      throw new Error('write refused')
    },
  }
  const store = createDocStore({ store: adapter, workspaceRoot: root })
  const opened = await store.open(file)
  await assert.rejects(store.applyBytes(file, Buffer.from('B'), { baseRevision: opened.revision }), /write refused/)
  assert.equal(hash(await readFile(file)), opened.revision)
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), [])
  await store.disposeAll()
})
