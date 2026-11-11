/**
 * Scope contract tests: DSH session facts, the route `session` query, allowed
 * roots, real-path confinement and missing save-as targets.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  allowedRoots,
  cwdOf,
  resolveDocumentPath,
  resolveDocumentPathSync,
  sessionFacts,
  sessionIdFromRequest,
  sessionIdOf,
} from '../lib/scope.js'

test('sessionFacts reads the tool and prompt-context identities', () => {
  const exec = { agent: { session: { header: { id: 'S1', cwd: 'C:/work', delegationDepth: 2 } } } }
  assert.deepEqual(sessionFacts(exec), { id: 'S1', cwd: 'C:/work', delegationDepth: 2 })
  assert.equal(sessionIdOf(exec), 'S1')
  assert.equal(cwdOf({ agent: { session: { header: { cwd: 'C:/other' } } } }), 'C:/other')
  assert.deepEqual(sessionFacts({}), {})
  assert.equal(sessionIdOf(undefined), undefined)
})

test('the route session query is explicit and optional', () => {
  assert.equal(sessionIdFromRequest({ url: '/workspace-editor/events?session=S2' }), 'S2')
  assert.equal(sessionIdFromRequest({ url: '/workspace-editor/api/info?id=D&session=S2' }), 'S2')
  assert.equal(sessionIdFromRequest({ url: '/workspace-editor/api/info?id=D' }), undefined)
  assert.equal(sessionIdFromRequest({}), undefined)
})

test('allowed roots are the workspace plus the configured list, deduplicated', () => {
  assert.deepEqual(allowedRoots('C:/work', ['C:/shared', 'C:/work']), [path.resolve('C:/work'), path.resolve('C:/shared')])
  assert.deepEqual(allowedRoots('C:/work'), [path.resolve('C:/work')])
  assert.throws(() => allowedRoots(''), (error) => error.code === 'DOC_INVALID_ARGS')
})

test('document paths resolve inside the workspace and refuse a sibling', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'workspace-scope-'))
  const work = path.join(base, 'work')
  const sibling = path.join(base, 'sibling')
  try {
    await mkdir(work)
    await mkdir(sibling)
    await writeFile(path.join(work, 'a.docx'), 'a')
    await writeFile(path.join(sibling, 'x.docx'), 'x')

    const inside = await resolveDocumentPath(path.join(work, 'a.docx'), { cwd: work })
    assert.equal(inside, await (await import('node:fs/promises')).realpath(path.join(work, 'a.docx')))
    assert.equal((await resolveDocumentPath('a.docx', { cwd: work })).endsWith('a.docx'), true)
    assert.equal((await resolveDocumentPath(path.join(work, 'new.docx'), { cwd: work })).endsWith('new.docx'), true)
    await assert.rejects(
      resolveDocumentPath(path.join(sibling, 'x.docx'), { cwd: work }),
      (error) => error.code === 'DOC_OUTSIDE_WORKSPACE',
    )
    await assert.rejects(
      resolveDocumentPath(path.join(sibling, 'new.docx'), { cwd: work }),
      (error) => error.code === 'DOC_OUTSIDE_WORKSPACE',
    )
    assert.equal((await resolveDocumentPath(path.join(sibling, 'x.docx'), { cwd: work, roots: [sibling] })).endsWith('x.docx'), true)
    assert.equal(resolveDocumentPathSync('a.docx', { cwd: work }).endsWith('a.docx'), true)
    assert.throws(() => resolveDocumentPathSync(path.join(sibling, 'x.docx'), { cwd: work }), (error) => error.code === 'DOC_OUTSIDE_WORKSPACE')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a directory link is resolved before the root check', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'workspace-scope-link-'))
  const work = path.join(base, 'work')
  const outside = path.join(base, 'outside')
  try {
    await mkdir(work)
    await mkdir(outside)
    await writeFile(path.join(outside, 'x.docx'), 'x')
    const link = path.join(work, 'out')
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`directory links are unavailable: ${error.code ?? error.message}`)
      return
    }
    await assert.rejects(
      resolveDocumentPath(path.join(link, 'x.docx'), { cwd: work }),
      (error) => error.code === 'DOC_OUTSIDE_WORKSPACE',
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
