/**
 * Host page contract tests: the File panel notice, the conflict path filter,
 * the review acknowledgement's change count and the state report retry, run by
 * evaluating `lib/editor/shim.js` against stub browser objects (WD-010, WD-064,
 * WD-073, WD-074).
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const SOURCE_URL = new URL('../lib/editor/shim.js', import.meta.url)
const DOC_ID = 'doc-1'
const DOC_PATH = 'C:/docs/A.docx'

/** @returns {object} one element stub with the members the shim uses. */
function elementStub() {
  return {
    textContent: '',
    title: '',
    style: {},
    classList: { add() {}, remove() {}, contains() { return false } },
    addEventListener() {},
    appendChild(node) { this.textContent += node.textContent },
  }
}

/**
 * Evaluate the host page script with stub browser objects.
 * @param {{ fetchImpl?: Function }} [options] - fetch answer.
 * @returns {Promise<object>} stubs and recorded requests.
 */
async function loadHostPage(options = {}) {
  const source = await readFile(SOURCE_URL, 'utf8')
  const requests = []
  const fetchImpl = options.fetchImpl ?? (async () => ({ ok: true, json: async () => ({}) }))
  const fetchStub = async (url, init) => {
    const record = { url: String(url), method: (init && init.method) || 'GET', body: init && init.body }
    requests.push(record)
    return fetchImpl(record)
  }
  const status = elementStub()
  const documentStub = {
    readyState: 'complete',
    getElementById: (id) => (id === 'status' ? status : null),
    createElement: () => elementStub(),
    addEventListener() {},
  }
  const eventSources = []
  class FakeEventSource {
    constructor(url) { this.url = url; eventSources.push(this) }
    addEventListener() {}
    close() {}
  }
  const windowStub = {
    location: {
      search: `?doc=${DOC_ID}&session=s1&path=${encodeURIComponent(DOC_PATH)}`,
      origin: 'http://app.test',
      reload() { windowStub.reloaded = true },
    },
    parent: { postMessage(message) { windowStub.posted = [...(windowStub.posted ?? []), message] } },
    posted: [],
    addEventListener() {},
  }
  new Function('window', 'document', 'fetch', 'EventSource', 'console', source)(
    windowStub, documentStub, fetchStub, FakeEventSource, { error() {}, log() {}, warn() {} },
  )
  return { window: windowStub, status, requests, eventSources }
}

/** @param {number} ms - wait. @returns {Promise<void>} resolves after ms. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('File > Open and Ctrl+O name the DSH file panel (WD-074)', async () => {
  const host = await loadHostPage()
  host.window._wsFileOpenNotice()
  assert.equal(host.status.textContent, 'Open documents from the DSH file panel.')
  assert.equal(host.window.AscDesktopEditor.LocalFileOpen(), undefined)
  assert.equal(host.status.textContent, 'Open documents from the DSH file panel.', 'the menu action shows the same notice')
})

test('a conflict frame for another path is ignored (WD-073)', async () => {
  const host = await loadHostPage()
  const source = host.eventSources[0]
  assert.equal(typeof source.onmessage, 'function')
  source.onmessage({ data: JSON.stringify({ type: 'conflict', path: 'C:/docs/B.docx', message: 'B.docx changed' }) })
  assert.equal(host.status.textContent, '')
  source.onmessage({ data: JSON.stringify({ type: 'conflict', path: DOC_PATH, message: 'A.docx changed' }) })
  assert.equal(host.status.textContent, 'A.docx changed Reload to work on the current revision.')
})

test('a review command acknowledgement carries the tracked change count (WD-064)', async () => {
  const host = await loadHostPage()
  host.window.AscDesktopEditor._editorWindow = {
    AscCommon: {},
    Asc: {
      editor: {
        asc_AcceptAllChanges() {},
        asc_GetTrackRevisionsReportByAuthors() { return { fixture: [{}, {}] } },
      },
    },
  }
  host.eventSources[0].onmessage({
    data: JSON.stringify({ type: 'command', id: DOC_ID, command: 'acceptAll', requestId: 'r-1' }),
  })
  let ack
  for (let index = 0; index < 30 && ack === undefined; index += 1) {
    await sleep(20)
    const post = host.requests.find((request) => request.url.includes('/api/editor') && request.method === 'POST')
    if (post !== undefined) ack = JSON.parse(post.body)
  }
  assert.deepEqual(ack, {
    id: DOC_ID,
    revision: '',
    command: 'acceptAll',
    ok: true,
    requestId: 'r-1',
    changeCount: 2,
  })
})

test('a failed editor state report is retried until it lands (WD-010)', async () => {
  let attempts = 0
  const host = await loadHostPage({
    fetchImpl: async (request) => {
      if (!request.url.includes('/api/editor')) return { ok: true, json: async () => ({}) }
      attempts += 1
      return attempts < 3 ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => ({}) }
    },
  })
  host.window.AscDesktopEditor.onDocumentModifiedChanged(true)
  for (let index = 0; index < 40 && attempts < 3; index += 1) await sleep(50)
  assert.ok(attempts >= 3, `the report was attempted ${attempts} time(s)`)
  const posts = host.requests.filter((request) => request.url.includes('/api/editor') && request.method === 'POST')
  assert.equal(JSON.parse(posts[posts.length - 1].body).modified, true)
})
