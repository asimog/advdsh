/**
 * Unit tests for the `doc_fanout` tool over the real model, a fake engine and a
 * fake subagent manager: fork per task, caller delivery, bounded concurrency,
 * failure isolation, merge by block id and teardown.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply as applyFanout } from '../lib/fanout/index.js'
import { createModel, PATH } from './fixtures.mjs'

/** Minimal output-schema check for the canonical value. */
function assertSchema(value, schema, at = 'value') {
  if (schema === undefined) return
  if (schema.type === 'object') {
    assert.equal(typeof value, 'object')
    assert.notEqual(value, null)
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${at}.${key} is required`)
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) assertSchema(value[key], property, `${at}.${key}`)
    }
    return
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value))
    for (const [index, item] of value.entries()) assertSchema(item, schema.items, `${at}[${index}]`)
    return
  }
  if (schema.type === 'string') assert.equal(typeof value, 'string', `${at} must be a string`)
  if (schema.type === 'number') assert.ok(Number.isFinite(value), `${at} must be a number`)
  if (schema.type === 'boolean') assert.equal(typeof value, 'boolean', `${at} must be a boolean`)
}

/** @param {string} prompt - child prompt. @returns {string|undefined} fork handle. */
function forkOf(prompt) {
  const text = Array.isArray(prompt) ? prompt.map((block) => block.text ?? '').join('\n') : ''
  return /Fork handle: (fork-[0-9a-f]+)/.exec(text)?.[1]
}

/** A fake subagent manager that runs `onTask` and records the start specs. */
function createFakeSubagents({ onTask, depthLimit = true } = {}) {
  const state = { starts: [], maxActive: 0, active: 0, disposed: 0, resolveMaxDepth: [] }
  const subagents = {
    state,
    getProvider: (name) => (name === 'spawn'
      ? { name, capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit } }
      : undefined),
    resolveMaxDepth: (value) => {
      state.resolveMaxDepth.push(value)
      return value
    },
    async startActivation(spec) {
      state.starts.push(spec)
      state.active += 1
      state.maxActive = Math.max(state.maxActive, state.active)
      let result
      try {
        if (onTask) await onTask(spec)
        result = { stopReason: 'completed', output: [{ type: 'text', text: 'edited the fork' }] }
      } catch (error) {
        result = { stopReason: 'error', output: [], diagnostic: error instanceof Error ? error.message : String(error) }
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
      state.active -= 1
      return {
        childId: `child-${state.starts.length}`,
        messageId: `msg-${state.starts.length}`,
        result: Promise.resolve(result),
        dispose: async () => {
          state.disposed += 1
        },
      }
    },
  }
  return subagents
}

/** @param {object} model - document model. @param {object} subagents - fake subagent manager. */
function createFakeCtx(model, subagents) {
  const tools = new Map()
  const disposers = []
  const ctx = {
    docxModel: model,
    subagents,
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
  }
  applyFanout(ctx)
  return { tools, disposers }
}

/** @param {object} handle - fork handle. @param {object} model - document model. */
async function editFork(model, handle, op) {
  return model.edit(handle, op)
}

/** @param {object} [options] - request facts override. */
function execFacts(overrides = {}) {
  return {
    signal: new AbortController().signal,
    agent: { session: { header: { id: 'parent-session', cwd: 'C:/docs', delegationDepth: 0, ...overrides } } },
  }
}

test('doc_fanout forks per task, runs caller children, merges and closes forks', async () => {
  const { model } = createModel()
  const opened = await model.open(PATH)
  const subagents = createFakeSubagents({
    onTask: async (spec) => {
      const fork = forkOf(spec.request.prompt)
      const label = spec.label
      if (label === 'opening') await editFork(model, fork, { type: 'replace_paragraph', blockId: 'p:2', text: 'Opening edited.' })
      else await editFork(model, fork, { type: 'replace_paragraph', blockId: 'p:3', text: 'Closing edited.' })
    },
  })
  const { tools } = createFakeCtx(model, subagents)
  const tool = tools.get('doc_fanout')
  assert.ok(tool, 'doc_fanout is registered')
  const value = await tool.execute({
    doc: opened.handle,
    tasks: [
      { label: 'opening', prompt: 'Rewrite the opening paragraph.' },
      { label: 'closing', prompt: 'Rewrite the closing paragraph.' },
    ],
    concurrency: 2,
  }, execFacts())
  assertSchema(value, tool.output.schema)
  assert.equal(value.forks.length, 2)
  assert.deepEqual(value.forks.map((fork) => fork.status), ['completed', 'completed'])
  assert.equal(value.merged.applied, 2)
  assert.equal(value.merged.conflicts.length, 0)
  assert.equal(subagents.state.starts.length, 2)
  assert.equal(subagents.state.starts[0].provider, 'spawn')
  assert.equal(subagents.state.starts[0].delivery, 'caller')
  assert.equal(subagents.state.starts[0].request.maxDepth, 1)
  assert.equal(subagents.state.starts[0].request.cwd, 'C:/docs')
  assert.match(subagents.state.starts[0].request.prompt[0].text, /isolated fork/)
  assert.equal(subagents.state.disposed, 2)
  const parentRead = await model.read(opened.handle, { mode: 'full' })
  assert.match(parentRead.text, /Opening edited\./)
  assert.match(parentRead.text, /Closing edited\./)
  assert.equal(model.status().length, 1, 'forks are closed after the merge')
  const rendered = tool.output.render({}, value)
  assert.match(rendered[0].text, /merged 2 change/)
})

test('a failing child is isolated and only completed forks merge', async () => {
  const { model } = createModel()
  const opened = await model.open(PATH)
  const subagents = createFakeSubagents({
    onTask: async (spec) => {
      if (spec.label === 'bad') throw new Error('child failed')
      const fork = forkOf(spec.request.prompt)
      await editFork(model, fork, { type: 'replace_paragraph', blockId: 'p:3', text: 'Good edit.' })
    },
  })
  const { tools } = createFakeCtx(model, subagents)
  const value = await tools.get('doc_fanout').execute({
    doc: opened.handle,
    tasks: [
      { label: 'bad', prompt: 'Break something.' },
      { label: 'good', prompt: 'Edit the closing.' },
    ],
    concurrency: 2,
  }, execFacts())
  assert.equal(value.forks.find((fork) => fork.label === 'bad').status, 'error')
  assert.equal(value.forks.find((fork) => fork.label === 'good').status, 'completed')
  assert.equal(value.merged.applied, 1)
  const parentRead = await model.read(opened.handle, { mode: 'full' })
  assert.match(parentRead.text, /Good edit\./)
})

test('concurrency bounds how many children run at once', async () => {
  const { model } = createModel()
  const opened = await model.open(PATH)
  const subagents = createFakeSubagents({
    onTask: async (spec) => {
      const fork = forkOf(spec.request.prompt)
      await editFork(model, fork, { type: 'replace_paragraph', blockId: 'p:3', text: `Edit ${spec.label}.` })
    },
  })
  const { tools } = createFakeCtx(model, subagents)
  const tasks = ['a', 'b', 'c', 'd'].map((label) => ({ label, prompt: `Edit ${label}.` }))
  await tools.get('doc_fanout').execute({ doc: opened.handle, tasks, concurrency: 2 }, execFacts())
  assert.ok(subagents.state.maxActive <= 2, `max active ${subagents.state.maxActive}`)
  assert.equal(subagents.state.maxActive, 2)
})

test('doc_fanout is not registered when writes are off', () => {
  const previous = process.env.WORKSPACE_DOCX_WRITE
  process.env.WORKSPACE_DOCX_WRITE = 'off'
  try {
    const { model } = createModel()
    const { tools } = createFakeCtx(model, createFakeSubagents())
    assert.equal(tools.has('doc_fanout'), false)
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_DOCX_WRITE
    else process.env.WORKSPACE_DOCX_WRITE = previous
  }
})

test('a missing spawn provider fails the call and leaves the parent open', async () => {
  const { model } = createModel()
  const opened = await model.open(PATH)
  const subagents = {
    getProvider: () => undefined,
    async startActivation() { throw new Error('unused') },
  }
  const { tools } = createFakeCtx(model, subagents)
  await assert.rejects(
    () => tools.get('doc_fanout').execute({ doc: opened.handle, tasks: [{ label: 'a', prompt: 'x' }] }, execFacts()),
    /not registered/,
  )
  assert.equal(model.status().length, 1)
})

test('no depth cap is requested when the provider has no depthLimit', async () => {
  const { model } = createModel()
  const opened = await model.open(PATH)
  const subagents = createFakeSubagents({
    depthLimit: false,
    onTask: async (spec) => {
      const fork = forkOf(spec.request.prompt)
      await editFork(model, fork, { type: 'replace_paragraph', blockId: 'p:3', text: 'No depth.' })
    },
  })
  const { tools } = createFakeCtx(model, subagents)
  await tools.get('doc_fanout').execute({ doc: opened.handle, tasks: [{ label: 'a', prompt: 'x' }] }, execFacts())
  assert.equal(Object.hasOwn(subagents.state.starts[0].request, 'maxDepth'), false)
})

test('disposing the row unregisters the tool and disposes activations', async () => {
  const { model } = createModel()
  const subagents = createFakeSubagents()
  const { tools, disposers } = createFakeCtx(model, subagents)
  assert.ok(tools.has('doc_fanout'))
  for (const dispose of disposers) dispose()
  assert.equal(tools.has('doc_fanout'), false)
})
