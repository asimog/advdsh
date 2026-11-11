/**
 * Composition tests: the whole bundle (six Cordis rows) applied to one context.
 * The context supplies the DSH services a headless composition has, so the
 * assertions are about what the composed bundle offers the model and the client
 * (WD-001, WD-002, WD-003, WD-076, WD-107, WD-111).
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { apply as applyHost } from '../lib/index.js'
import { apply as applyEngine } from '../lib/engine/index.js'
import { apply as applyModel } from '../lib/model/index.js'
import { apply as applyTools } from '../lib/tools/index.js'
import { apply as applyFanout } from '../lib/fanout/index.js'
import { apply as applyReview } from '../lib/review/index.js'
import { formatToolError } from '../lib/errors.js'
import { createFakeDocuments } from './fixtures.mjs'

/** The eight read tools of WD-002, alphabetical. */
const READ_TOOLS = ['doc_analyze', 'doc_check', 'doc_diff', 'doc_open', 'doc_read', 'doc_search', 'doc_state', 'editor']

/**
 * Apply the six rows of the bundle to one fake DSH composition context.
 * @param {{ write?: 'on'|'off' }} [options] - write gate.
 * @returns {{ ctx: object, tools: Map<string, object>, routes: object[] }} composition.
 */
function compose(options = {}) {
  const tools = new Map()
  const routes = []
  const services = new Map()
  const contexts = []
  const disposers = []
  const previousWrite = process.env.WORKSPACE_DOCX_WRITE
  if (options.write === 'off') process.env.WORKSPACE_DOCX_WRITE = 'off'
  else delete process.env.WORKSPACE_DOCX_WRITE
  const subagents = {
    getProvider: (name) => (name === 'spawn' ? { name, capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: true } } : undefined),
    resolveMaxDepth: (value) => value ?? 3,
    async startActivation() { throw new Error('the composition test does not start children') },
  }
  const documents = createFakeDocuments()
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    systemPrompt: { context: (entry) => { contexts.push(entry); return () => {} } },
    effect: (fn) => { const disposer = fn(); if (typeof disposer === 'function') disposers.push(disposer); return () => {} },
    // A real Cordis row reads its injected services as context properties.
    provide: (name, value) => {
      services.set(name, value)
      ctx[name] = value
      return () => { services.delete(name); delete ctx[name] }
    },
    get: (name) => services.get(name),
    // A row that contributes to another service calls `inject`; the fake context
    // has every service already, so the callback runs once and its disposers are kept.
    inject: (names, callback) => {
      const run = typeof names === 'function' ? names : callback
      const result = run(ctx)
      if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
        const cleanup = []
        for (let step = result.next(); step.done !== true; step = result.next()) {
          if (typeof step.value === 'function') cleanup.push(step.value)
        }
        return () => { for (const dispose of cleanup) dispose() }
      }
      return typeof result === 'function' ? result : () => {}
    },
    on: () => {},
    skills: { register: () => () => {} },
    subagents,
    subprocess: { spawn: () => { throw new Error('the composition test does not start the sidecar') } },
  }
  // The host row reads the model service and the model service reads the store,
  // so the rows load in their declared order.
  applyEngine(ctx)
  applyHost(ctx)
  applyModel(ctx)
  applyTools(ctx)
  applyFanout(ctx)
  applyReview(ctx)
  void documents
  if (previousWrite === undefined) delete process.env.WORKSPACE_DOCX_WRITE
  else process.env.WORKSPACE_DOCX_WRITE = previousWrite
  return { ctx, tools, routes, services, contexts, disposers }
}

test('the bundle registers no document_edit and every tool result is declared (WD-001)', () => {
  for (const write of ['off', 'on']) {
    const { tools } = compose({ write })
    assert.equal(tools.has('document_edit'), false, `document_edit must not be registered (WRITE=${write})`)
    for (const [name, definition] of tools) {
      assert.equal(typeof definition.execute, 'function', `${name} has an executor`)
      assert.equal(typeof definition.output.render, 'function', `${name} renders its result`)
    }
  }
})

test('with WORKSPACE_DOCX_WRITE=off the bundle registers only the read tools (WD-002)', () => {
  const { tools } = compose({ write: 'off' })
  assert.deepEqual([...tools.keys()].sort(), READ_TOOLS)
})

test('with WORKSPACE_DOCX_WRITE=off a changing review command is refused (WD-003)', async () => {
  const { tools } = compose({ write: 'off' })
  const editor = tools.get('editor')
  await assert.rejects(
    () => editor.execute({ action: 'review', command: 'acceptAll', userInstruction: 'accept all changes', path: 'C:/docs/A.docx' }, {}),
    (error) => {
      assert.equal(error.code, 'DOC_WRITE_DISABLED')
      const rendered = formatToolError(error)
      assert.equal(rendered.message, `DOC_WRITE_DISABLED: ${rendered.message.slice('DOC_WRITE_DISABLED: '.length)}`)
      assert.ok(rendered.message.startsWith('DOC_WRITE_DISABLED:'), rendered.message)
      return true
    },
  )
})

test('the composed bundle provides no legalReview service (WD-107)', () => {
  const { services } = compose()
  assert.equal(services.has('legalReview'), false)
})

test('the composed host page route serves the section 14.1 policy (WD-076)', async (t) => {
  const { routes } = compose()
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://local')
    const route = routes.find((entry) => entry.kind === 'exact' && entry.path === url.pathname)
      ?? routes.find((entry) => entry.kind === 'prefix' && url.pathname.startsWith(entry.path))
    if (route === undefined) { response.writeHead(404); response.end(); return }
    Promise.resolve(route.handler(request, response)).catch(() => { response.writeHead(500); response.end() })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const response = await fetch(`${origin}/workspace-editor/host.html`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-security-policy'), "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'")
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  await response.body?.cancel()
})
