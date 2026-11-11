/**
 * Route contract tests: path confinement, the session query on document routes
 * and the session-filtered SSE snapshot. The host row is applied to a fake
 * Cordis context and its routes are served by a real loopback HTTP server.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply as applyHost } from '../lib/index.js'
import { createModel } from './fixtures.mjs'

/** @param {string} base - server origin. @param {string} route - path. @param {RequestInit} [init] - fetch init. */
async function call(base, route, init) {
  return fetch(`${base}${route}`, init)
}

/** @param {string} root - workspace root. @param {object} model - docx model service. */
function createHost(root, model) {
  const routes = []
  const ctx = {
    get(name) {
      if (name === 'docxModel') return model
      if (name === 'workspaceRoot') return root
      return undefined
    },
    provide() { return () => {} },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    emit() {},
    on() {},
    webServer: { register(route) { routes.push(route); return () => {} } },
    tools: { register() { return () => {} } },
  }
  applyHost(ctx)
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://local')
    const route = routes.find((entry) => entry.kind === 'exact' && entry.path === url.pathname)
      ?? routes.find((entry) => entry.kind === 'prefix' && url.pathname.startsWith(entry.path))
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(route.handler(req, res)).catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(error), code: 'TEST' }))
    })
  })
  return { server, routes }
}

test('document routes refuse a path outside the workspace and a foreign session (WD-080, WD-086)', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'workspace-routes-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'work')
  const sibling = path.join(base, 'sibling')
  await mkdir(root)
  await mkdir(sibling)
  const inside = path.join(root, 'a.pdf')
  const outside = path.join(sibling, 'x.pdf')
  await writeFile(inside, 'A')
  await writeFile(outside, 'X')
  const { model } = createModel()
  await model.open(inside, { sessionId: 'S1', cwd: root })
  const { server } = createHost(root, model)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`

  const denied = await call(origin, '/workspace-editor/api/open?session=S1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: outside }),
  })
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).code, 'DOC_OUTSIDE_WORKSPACE')

  const opened = await call(origin, '/workspace-editor/api/open?session=S1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: inside }),
  })
  assert.equal(opened.status, 200)
  const document = await opened.json()
  const own = await call(origin, `/workspace-editor/api/info?id=${document.id}&session=S1`)
  assert.equal(own.status, 200)
  const foreign = await call(origin, `/workspace-editor/api/info?id=${document.id}&session=S2`)
  assert.equal(foreign.status, 404)
  assert.equal((await foreign.json()).code, 'DOC_SESSION_NOT_FOUND')
})

test('the events snapshot is filtered by the DSH session (WD-085)', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-routes-sse-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const one = path.join(root, 'one.pdf')
  const two = path.join(root, 'two.pdf')
  await writeFile(one, '1')
  await writeFile(two, '2')
  const { model } = createModel()
  await model.open(one, { sessionId: 'S1', cwd: root })
  await model.open(two, { sessionId: 'S2', cwd: root })
  const { server } = createHost(root, model)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  for (const file of [one, two]) {
    const response = await call(origin, '/workspace-editor/api/open?session=' + (file === one ? 'S1' : 'S2'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file }),
    })
    assert.equal(response.status, 200)
  }
  const eventResponse = await call(origin, '/workspace-editor/events?session=S1')
  assert.equal(eventResponse.status, 200)
  const reader = eventResponse.body.getReader()
  let text = ''
  while (!text.includes('\n\n')) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += new TextDecoder().decode(chunk.value)
  }
  await reader.cancel()
  const line = text.split('\n').find((entry) => entry.startsWith('data: '))
  assert.ok(line)
  const snapshot = JSON.parse(line.slice('data: '.length))
  assert.equal(snapshot.type, 'snapshot')
  assert.equal(snapshot.documents.length, 1)
  assert.equal(snapshot.documents[0].path, await (await import('node:fs/promises')).realpath(one))
})
test('routes enforce methods, parse errors and unknown fields (WD-088, WD-089, WD-090)', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-routes-hygiene-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'a.pdf')
  await writeFile(file, 'A')
  const { model } = createModel()
  await model.open(file, { sessionId: 'S1', cwd: root })
  const { server } = createHost(root, model)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`

  const wrongMethod = await call(origin, '/workspace-editor/api/open?session=S1')
  assert.equal(wrongMethod.status, 405)
  assert.equal((await wrongMethod.json()).code, 'DOC_INVALID_ARGS')

  const badJson = await call(origin, '/workspace-editor/api/open?session=S1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  })
  assert.equal(badJson.status, 400)
  assert.equal((await badJson.json()).code, 'DOC_INVALID_ARGS')

  const unknown = await call(origin, '/workspace-editor/api/open?session=S1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: file, extra: true }),
  })
  assert.equal(unknown.status, 400)
  assert.match((await unknown.json()).error, /unknown field: extra/)
})
test('editor open queues one pending tab request for its session (WD-065)', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-routes-open-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'a.pdf')
  await writeFile(file, 'A')
  const { model } = createModel()
  await model.open(file, { sessionId: 'S1', cwd: root })
  const { server } = createHost(root, model)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const opened = await call(origin, '/workspace-editor/api/open?session=S1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: file }),
  })
  assert.equal(opened.status, 200)
  const pending = await call(origin, '/workspace-editor/api/pending-open?session=S1')
  assert.equal(pending.status, 200)
  const body = await pending.json()
  assert.equal(body.paths.length, 0, 'route open is not an editor-tool open')
  assert.equal((await (await call(origin, '/workspace-editor/api/pending-open?session=S1')).json()).paths.length, 0)
})
