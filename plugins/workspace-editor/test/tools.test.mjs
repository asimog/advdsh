/**
 * Unit tests for the `doc_*` tool row over the real model with fake engine and
 * store fixtures: schemas, canonical values, write gating, runtime context and
 * the replayable presenters.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply as applyTools } from '../lib/tools/index.js'
import { engineCodeForSidecar, formatToolError, routeErrorBody, toolCodeForEngine } from '../lib/errors.js'
import { PATH, createFakeDocuments, createModel } from './fixtures.mjs'

/** @param {unknown} value - canonical tool value. @param {object} schema - output.schema. @param {string} at - path for messages. */
function assertSchema(value, schema, at = 'value') {
  if (schema === undefined) return
  if (Array.isArray(schema.oneOf)) {
    const failures = []
    for (const branch of schema.oneOf) {
      try {
        assertSchema(value, branch, at)
        return
      } catch (error) {
        failures.push(error)
      }
    }
    assert.fail(`${at} matches no oneOf branch`)
  }
  if (schema.type === 'null') {
    assert.equal(value, null, `${at} must be null`)
    return
  }
  if (schema.type === 'object') {
    assert.equal(typeof value, 'object', `${at} must be an object`)
    assert.notEqual(value, null, `${at} must not be null`)
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${at}.${key} is required`)
    const declared = schema.properties ?? {}
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(Object.hasOwn(declared, key), `${at}.${key} is not a declared property`)
      }
    }
    for (const [key, property] of Object.entries(declared)) {
      if (!Object.hasOwn(value, key)) continue
      assertSchema(value[key], property, `${at}.${key}`)
    }
    return
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${at} must be an array`)
    for (const [index, item] of value.entries()) assertSchema(item, schema.items, `${at}[${index}]`)
    return
  }
  if (schema.type === 'string') assert.equal(typeof value, 'string', `${at} must be a string`)
  if (schema.type === 'number') assert.ok(typeof value === 'number' && Number.isFinite(value), `${at} must be a number`)
  if (schema.type === 'boolean') assert.equal(typeof value, 'boolean', `${at} must be a boolean`)
}

/** Wrap the fake store in the `editorDocuments` surface the editor tool consumes. */
function withEditorSurface(documents) {
  const commands = []
  return {
    ...documents,
    commands,
    list: () => [{ id: 'd1', path: PATH, revision: documents.state.revision, modified: false }],
    command: (request) => {
      commands.push(request)
      return { delivered: 1, command: request.command, executed: true, changeCount: 2 }
    },
    wait: async () => ({ path: PATH, revision: documents.state.revision, changed: false, timedOut: true }),
    exportPdf: async () => ({ path: 'C:/docs/TRO - Motion.pdf', bytes: Buffer.from('pdf') }),
  }
}

/** @param {object} [options] - fixture options. */
function boot(options = {}) {
  const documents = options.documents === true ? withEditorSurface(createFakeDocuments()) : undefined
  const built = createModel({ ...options, documents })
  /** @type {Map<string, object>} */
  const tools = new Map()
  /** @type {object[]} */
  const contexts = []
  /** @type {Function[]} */
  const disposers = []
  const services = new Map()
  const ctx = {
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    systemPrompt: { context: (entry) => { contexts.push(entry) } },
    provide: (name, value) => { services.set(name, value); return () => services.delete(name) },
    get: (name) => services.get(name),
    on: () => {},
    docxModel: built.model,
    editorDocuments: documents,
    docxEngine: options.engine ?? { status: () => ({ running: true, ready: true, pid: 1 }) },
  }
  applyTools(ctx)
  return { ...built, ctx, tools, contexts, disposers }
}

/** @param {object} tool - registered definition. @param {object} args - model-produced args. @param {object} [exec] - execution facts. */
async function run(tool, args, exec = { signal: new AbortController().signal }) {
  const value = await tool.execute(args, exec)
  assertSchema(value, tool.output.schema)
  const content = tool.output.render(args, value)
  assert.ok(Array.isArray(content) && content.length > 0, 'render returns content blocks')
  assert.equal(content[0].type, 'text')
  return value
}

test('registers every read tool, the write tools and the runtime context', () => {
  const { tools, contexts } = boot({ documents: true })
  assert.deepEqual([...tools.keys()].sort(), [
    'doc_check', 'doc_commit', 'doc_diff', 'doc_edit', 'doc_open', 'doc_read',
    'doc_search', 'doc_state', 'doc_undo', 'editor',
  ])
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].name, 'document-model:open')
  assert.equal(contexts[0].order, 130)
  assert.equal(contexts[0].text({}), '')
})

test('the write gate removes doc_edit, doc_commit and doc_undo from the tool set', () => {
  const previous = process.env.WORKSPACE_DOCX_WRITE
  process.env.WORKSPACE_DOCX_WRITE = 'off'
  try {
    const { tools } = boot({ documents: true })
    assert.equal(tools.has('doc_edit'), false)
    assert.equal(tools.has('doc_commit'), false)
    assert.equal(tools.has('doc_undo'), false)
    assert.equal(tools.has('doc_read'), true)
    assert.equal(tools.has('document_edit'), false)
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_DOCX_WRITE
    else process.env.WORKSPACE_DOCX_WRITE = previous
  }
})

test('the write gate refuses write review commands but permits display commands', async () => {
  const previous = process.env.WORKSPACE_DOCX_WRITE
  process.env.WORKSPACE_DOCX_WRITE = 'off'
  try {
    const booted = boot({ documents: true })
    await assert.rejects(
      () => booted.tools.get('editor').execute({ action: 'review', doc: 'd1', command: 'acceptAll', userInstruction: 'accept' }),
      (error) => error.code === 'DOC_WRITE_DISABLED',
    )
    assert.equal(booted.documents.commands.length, 0)
    const display = await run(booted.tools.get('editor'), { action: 'review', doc: 'd1', command: 'displayMode', args: 'final' })
    assert.equal(display.command, 'displayMode')
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_DOCX_WRITE
    else process.env.WORKSPACE_DOCX_WRITE = previous
  }
})

test('doc_undo reverts the last pending edit', async () => {
  const booted = boot({ documents: true })
  const opened = await run(booted.tools.get('doc_open'), { path: PATH })
  await run(booted.tools.get('doc_edit'), { doc: opened.handle, type: 'replace_paragraph', blockId: 'p:2', text: 'Changed.' })
  const undone = await run(booted.tools.get('doc_undo'), { doc: opened.handle })
  assert.equal(undone.undone, 'replace_paragraph')
  assert.equal(undone.pendingOps, 0)
  const status = await run(booted.tools.get('doc_state'), { action: 'status' })
  assert.equal(status.sessions[0].pendingOps, 0)
})

test('doc_open, doc_read and doc_search round trip with annotated blocks', async () => {
  const booted = boot()
  const opened = await run(booted.tools.get('doc_open'), { path: PATH }, { agent: { session: { header: { id: 'session-1' } } } })
  assert.equal(opened.path, path.resolve(PATH))
  assert.match(opened.handle, /^doc-/)
  assert.equal(booted.engine.calls[0].options.author, 'agent:session-1')
  const read = await run(booted.tools.get('doc_read'), { doc: opened.handle, mode: 'full' })
  assert.match(read.text, /\[p:2\] Plaintiff seeks entry/)
  const found = await run(booted.tools.get('doc_search'), { doc: opened.handle, query: 'temporary restraining' })
  assert.equal(found.matches.length, 1)
  assert.equal(found.matches[0].id, 'p:2')
})

test('doc_edit, doc_diff, doc_check and doc_commit form the edit flow', async () => {
  const booted = boot({ documents: true })
  const opened = await run(booted.tools.get('doc_open'), { path: PATH })
  const edited = await run(booted.tools.get('doc_edit'), {
    doc: opened.handle,
    type: 'replace_paragraph',
    blockId: 'p:2',
    text: 'The Court should enjoin Defendant.',
  })
  assert.equal(edited.op, 'replace_paragraph')
  assert.equal(edited.tracked, true)
  assert.equal(edited.changed, 1)
  assert.equal(edited.path, path.resolve(PATH))
  const diff = await run(booted.tools.get('doc_diff'), { doc: opened.handle })
  assert.equal(diff.changed, true)
  assert.equal(diff.counts.changed, 1)
  const checked = await run(booted.tools.get('doc_check'), { doc: opened.handle })
  assert.equal(checked.ok, false)
  assert.ok(checked.codes.includes('PENDING_REVISIONS'))
  const committed = await run(booted.tools.get('doc_commit'), { doc: opened.handle })
  assert.equal(committed.applied, true)
  assert.equal(booted.documents.state.applied.length, 1)
  assert.equal(booted.documents.state.applied[0].options.baseRevision, 'r-1')
})

test('insert ops report a null before text inside the strict output schema', async () => {
  const booted = boot()
  const opened = await run(booted.tools.get('doc_open'), { path: PATH })
  const inserted = await run(booted.tools.get('doc_edit'), {
    doc: opened.handle,
    type: 'insert_paragraph',
    index: 4,
    text: 'Inserted line.',
  })
  assert.equal(inserted.affected[0].textBefore, null)
  assert.equal(inserted.affected[0].textAfter, 'Inserted line.')
  const diff = await run(booted.tools.get('doc_diff'), { doc: opened.handle })
  assert.equal(diff.changed, true)
})

test('doc_edit maps a stale target and an unsupported op to stable codes', async () => {  const booted = boot()
  const opened = await run(booted.tools.get('doc_open'), { path: PATH })
  await assert.rejects(
    () => booted.tools.get('doc_edit').execute({ doc: opened.handle, type: 'replace_paragraph', blockId: 'p:missing', text: 'x' }),
    (error) => {
      assert.equal(error.code, 'DOC_TARGET_NOT_FOUND')
      assert.match(error.message, /^DOC_TARGET_NOT_FOUND: /)
      assert.match(`Error: ${error.message}`, /^Error: DOC_TARGET_NOT_FOUND: /)
      return true
    },
  )
  await assert.rejects(
    () => booted.tools.get('doc_edit').execute({ doc: opened.handle, type: 'apply_style', blockId: 'p:2' }),
    (error) => error.code === 'DOC_INVALID_OP',
  )
})

test('the error contract has one sidecar map, one engine map and the wire formats', () => {
  assert.equal(engineCodeForSidecar('TARGET_NOT_FOUND'), 'ENGINE_TARGET_NOT_FOUND')
  assert.equal(engineCodeForSidecar('AMBIGUOUS_TARGET'), 'ENGINE_AMBIGUOUS_TARGET')
  assert.equal(engineCodeForSidecar('WRONG_KIND'), 'ENGINE_INVALID_OP')
  assert.equal(engineCodeForSidecar('SOMETHING_NEW'), 'ENGINE_PROTOCOL')
  assert.equal(toolCodeForEngine('ENGINE_TARGET_NOT_FOUND'), 'DOC_TARGET_NOT_FOUND')
  assert.equal(toolCodeForEngine('ENGINE_UNSUPPORTED'), 'DOC_UNSUPPORTED_EDIT')
  assert.equal(toolCodeForEngine('ENGINE_SESSION_LOST'), 'DOC_CLOSED')

  const formatted = formatToolError(Object.assign(new Error('block not found'), { code: 'DOC_TARGET_NOT_FOUND' }))
  assert.equal(formatted.code, 'DOC_TARGET_NOT_FOUND')
  assert.equal(formatted.message, 'DOC_TARGET_NOT_FOUND: block not found')
  assert.deepEqual(routeErrorBody(formatted), { error: 'block not found', code: 'DOC_TARGET_NOT_FOUND' })
})

test('doc_state reports sessions, revisions and closes them', async () => {
  const booted = boot({ documents: true })
  const opened = await run(booted.tools.get('doc_open'), { path: PATH })
  const status = await run(booted.tools.get('doc_state'), { action: 'status' })
  assert.equal(status.sessions.length, 1)
  assert.equal(status.sessions[0].handle, opened.handle)
  const revisions = await run(booted.tools.get('doc_state'), { action: 'revisions', doc: opened.handle })
  assert.ok(revisions.revisions)
  const closed = await run(booted.tools.get('doc_state'), { action: 'close', doc: opened.handle })
  assert.equal(closed.closed, true)
  assert.equal((await run(booted.tools.get('doc_state'), { action: 'status' })).sessions.length, 0)
})

test('the editor tool reports status and dispatches review commands without editing text', async () => {
  const booted = boot({ documents: true })
  const status = await run(booted.tools.get('editor'), { action: 'status' })
  assert.equal(status.engine.ready, true)
  assert.equal(status.documents.length, 1)
  const review = await run(booted.tools.get('editor'), { action: 'review', doc: 'd1', command: 'acceptAll', userInstruction: 'accept all' })
  assert.equal(review.command, 'acceptAll')
  assert.equal(booted.documents.commands.length, 1)
  assert.equal(booted.documents.commands[0].command, 'acceptAll')
  assert.equal(booted.documents.commands[0].awaitAck, true)
  assert.equal(review.executed, true)
  assert.equal(review.changeCount, 2)
  const pdf = await run(booted.tools.get('editor'), { action: 'export_pdf', doc: 'd1' })
  assert.equal(pdf.pdf, 'C:/docs/TRO - Motion.pdf')
})

test('the runtime context lists open documents under the agent cwd', async () => {
  const booted = boot()
  const opened = await run(booted.tools.get('doc_open'), { path: PATH })
  const text = booted.contexts[0].text({ agent: { session: { header: { cwd: 'C:/docs' } } } })
  assert.match(text, /Open agent documents/)
  assert.match(text, new RegExp(opened.handle))
  assert.match(text, /TRO - Motion\.docx/)
})

test('presenters render replayable cards from persisted metadata only', async () => {
  const booted = boot({ documents: true })
  const opened = await run(booted.tools.get('doc_open'), { path: PATH })
  const edit = booted.tools.get('doc_edit')
  const edited = await run(edit, { doc: opened.handle, type: 'replace_paragraph', blockId: 'p:2', text: 'New text.' })
  const meta = edit.output.presentationMeta({}, edited)
  const card = edit.presentResult({}, { content: [], isError: false, meta })
  assert.equal(card.card, 'diff')
  assert.equal(card.diffs[0].path, edited.path)
  assert.match(card.diffs[0].newText, /New text\./)

  const diffTool = booted.tools.get('doc_diff')
  const diff = await run(diffTool, { doc: opened.handle })
  const diffCard = diffTool.presentResult({}, { content: [], isError: false, meta: diffTool.output.presentationMeta({}, diff) })
  assert.equal(diffCard.card, 'diff')

  const commitTool = booted.tools.get('doc_commit')
  const committed = await run(commitTool, { doc: opened.handle })
  const commitMeta = commitTool.output.presentationMeta({}, committed)
  const commitCard = commitTool.presentResult({}, { content: [], isError: false, meta: commitMeta })
  assert.equal(commitCard.card, 'generic')
  assert.match(commitCard.title, /Committed/)
  assert.doesNotThrow(() => diffTool.presentResult({}, { content: [], isError: true }))
})

test('tool registration is disposed with the row', () => {
  const booted = boot()
  for (const dispose of booted.disposers) dispose()
  assert.equal(booted.tools.size, 0)
})
test('doc_open and editor open refuse a path outside the session root (WD-079)', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'workspace-tools-scope-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'work')
  const sibling = path.join(base, 'sibling')
  await mkdir(root)
  await mkdir(sibling)
  const outside = path.join(sibling, 'X.docx')
  await writeFile(outside, 'X')
  const booted = boot({ documents: true })
  const exec = { agent: { session: { header: { id: 'S1', cwd: root } } }, signal: new AbortController().signal }
  await assert.rejects(
    () => booted.tools.get('doc_open').execute({ path: outside }, exec),
    (error) => error.code === 'DOC_OUTSIDE_WORKSPACE',
  )
  await assert.rejects(
    () => booted.tools.get('editor').execute({ action: 'open', path: outside }, exec),
    (error) => error.code === 'DOC_OUTSIDE_WORKSPACE',
  )
  assert.equal((await run(booted.tools.get('doc_state'), { action: 'status' }, exec)).sessions.length, 0)
})
test('handles, status and the runtime context are scoped by DSH session (WD-082, WD-083, WD-084)', async () => {
  const booted = boot({ documents: true })
  const one = { agent: { session: { header: { id: 'S1', cwd: path.dirname(PATH) } } } }
  const two = { agent: { session: { header: { id: 'S2', cwd: path.dirname(PATH) } } } }
  const first = await booted.tools.get('doc_open').execute({ path: PATH }, one)
  const second = await booted.tools.get('doc_open').execute({ path: PATH }, two)
  assert.notEqual(first.handle, second.handle)
  await assert.rejects(
    () => booted.tools.get('doc_read').execute({ doc: first.handle, mode: 'full' }, two),
    (error) => error.code === 'DOC_SESSION_NOT_FOUND',
  )
  const status = await booted.tools.get('doc_state').execute({ action: 'status' }, two)
  assert.deepEqual(status.sessions.map((session) => session.handle), [second.handle])
  const contextOne = booted.contexts.find((entry) => entry.name === 'document-model:open').text(one)
  assert.match(contextOne, /FIXTURE|TRO|doc-/, 'the runtime context lists the session document')
  assert.doesNotMatch(contextOne, new RegExp(second.handle))
})
test('editor rejects legacy and unauthorized commands and missing arguments (WD-059, WD-060, WD-063)', async () => {
  const booted = boot({ documents: true })
  await assert.rejects(
    () => booted.tools.get('editor').execute({ action: 'review', doc: 'd1', command: 'accept_all', userInstruction: 'x' }),
    (error) => error.code === 'DOC_INVALID_ARGS' && error.message === 'DOC_INVALID_ARGS: unknown review command accept_all',
  )
  await assert.rejects(
    () => booted.tools.get('editor').execute({ action: 'review', doc: 'd1', command: 'acceptAll' }),
    (error) => error.code === 'DOC_REVIEW_NOT_AUTHORIZED',
  )
  await assert.rejects(
    () => booted.tools.get('editor').execute({ action: 'open' }),
    (error) => error.code === 'DOC_INVALID_ARGS',
  )
  assert.equal(booted.documents.commands.length, 0)
})

test('doc_state close fails for an unknown handle (WD-058)', async () => {
  const booted = boot({ documents: true })
  await assert.rejects(
    () => booted.tools.get('doc_state').execute({ action: 'close', doc: 'doc-missing' }),
    (error) => error.code === 'DOC_SESSION_NOT_FOUND',
  )
})

test('editor status names the four engine states (WD-066)', async () => {
  const notStarted = boot({ documents: true, engine: { status: () => ({ running: false, ready: false }) } })
  const status = await run(notStarted.tools.get('editor'), { action: 'status' })
  assert.equal(status.engine.state, 'not-started')
  assert.match(notStarted.tools.get('editor').output.render({ action: 'status' }, status)[0].text, /engine not-started/)
})
test('only an applier child may edit, and only inside its chunk (WD-116, WD-117, WD-119)', async () => {
  const booted = boot({ documents: true })
  const root = { agent: { session: { header: { id: 'root-session', cwd: path.dirname(PATH) } } } }
  const child = { agent: { session: { header: { id: 'child-1', cwd: path.dirname(PATH) } } } }
  const rootDoc = await booted.tools.get('doc_open').execute({ path: PATH }, root)
  const childDoc = await booted.tools.get('doc_open').execute({ path: PATH }, child)
  const roles = booted.ctx.get('docxRoles')
  roles.registerApplier('child-1', { blockIds: ['p:2'], changeIds: ['c1'] })
  await assert.rejects(
    () => booted.tools.get('doc_edit').execute({ doc: rootDoc.handle, type: 'replace_paragraph', blockId: 'p:2', text: 'X' }, root),
    (error) => error.code === 'DOC_APPLIER_ONLY',
  )
  await assert.rejects(
    () => booted.tools.get('doc_edit').execute({ doc: childDoc.handle, type: 'replace_paragraph', blockId: 'p:3', text: 'X' }, child),
    (error) => error.code === 'DOC_OUTSIDE_CHUNK',
  )
  const edited = await booted.tools.get('doc_edit').execute({ doc: childDoc.handle, type: 'replace_paragraph', blockId: 'p:2', text: 'X' }, child)
  assert.equal(edited.pendingOps, 1)
  await assert.rejects(
    () => booted.tools.get('doc_read').execute({ doc: rootDoc.handle, mode: 'markup' }, root),
    (error) => error.code === 'DOC_APPLIER_ONLY',
  )
  const markup = await booted.tools.get('doc_read').execute({ doc: childDoc.handle, mode: 'markup' }, child)
  assert.ok(Array.isArray(markup.nodes))
})

/** Collect schema nodes whose `required` names a property that is not declared. */
function schemaViolations(schema, where, out = []) {
  if (schema === null || typeof schema !== 'object') return out
  if (Array.isArray(schema.required) && schema.properties && typeof schema.properties === 'object') {
    for (const name of schema.required) {
      if (!Object.hasOwn(schema.properties, name)) out.push(`${where}: required "${name}" is not in properties`)
    }
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [name, child] of Object.entries(schema.properties)) schemaViolations(child, `${where}.${name}`, out)
  }
  if (schema.items) schemaViolations(schema.items, `${where}[]`, out)
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(schema[key])) schema[key].forEach((child, index) => schemaViolations(child, `${where}.${key}[${index}]`, out))
  }
  return out
}

test('every tool schema lists only declared properties as required', () => {
  const { tools } = boot({ documents: true })
  const violations = []
  for (const [name, definition] of tools) {
    schemaViolations(definition.parameters, `${name}.parameters`, violations)
    schemaViolations(definition.output?.schema, `${name}.output`, violations)
  }
  assert.deepEqual(violations, [])
})

test('doc_open resolves a relative path against the session workspace root (WD-079)', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'workspace-tools-relative-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'work')
  await mkdir(root)
  await writeFile(path.join(root, 'B.docx'), 'B')
  const booted = boot()
  const exec = { agent: { session: { header: { id: 'S1', cwd: root } } }, signal: new AbortController().signal }
  const opened = await booted.tools.get('doc_open').execute({ path: 'B.docx' }, exec)
  const { realpath } = await import('node:fs/promises')
  assert.equal(await realpath(opened.path), await realpath(path.join(root, 'B.docx')))
})
