/**
 * Sidecar process contract tests: the crash and restart limit, dead sessions
 * after an exit, temp cleanup on dispose, the required spawn arguments and the
 * loopback RPC token (WD-097, WD-098, WD-099, WD-100, WD-136).
 *
 * A stub runtime supplies the child process and a loopback RPC server, so the
 * lifecycle runs without the real Electron app; the token and argument tests
 * use the real installed sidecar because they are about the real host app.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createDocxEngine } from '../lib/engine/manager.js'
import { resolveEngineConfig } from '../lib/engine/locate.js'

const PROTOCOL = 1

/**
 * One fake sidecar child: a ready frame on stdout and a loopback RPC server
 * that answers the methods the manager calls. Created synchronously because the
 * manager spawns it synchronously; the ready frame follows the listen callback.
 * @returns {{ handle: object, crash: Function }} child handle and exit trigger.
 */
function createStubChild() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new PassThrough()
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const token = 'stub-token'
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      if (request.headers['x-engine-token'] !== token) {
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN' } }))
        return
      }
      let payload
      try { payload = JSON.parse(body) } catch { payload = {} }
      const method = payload.method
      let result = {}
      if (method === 'describe') {
        result = {
          revision: 1,
          paragraphCount: 1,
          tableCount: 0,
          outline: [],
          blocks: [{ id: 'w14:1', index: 0, kind: 'paragraph', text: 'STUB', runs: [{ text: 'STUB', inserted: false, deleted: false }] }],
        }
      } else if (method === 'open') {
        result = { editorBinBytes: 1 }
      } else if (method === 'diff') {
        result = { baseHash: 'h', counts: { added: 0, removed: 0, changed: 0, total: 0 }, changes: [] }
      } else if (method === 'save') {
        result = { bytesBase64: Buffer.from('DOCX').toString('base64'), sha256: 'hash', revision: 1 }
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, result }))
    })
  })
  const handle = {
    pid: 4242,
    stdin,
    stdout,
    stderr,
    done,
    terminate() {
      settle({ exitCode: 0, signal: null })
      server.closeAllConnections?.()
      server.close()
      stdout.end()
      stderr.end()
      stdin.end()
    },
    async waitForExit() {
      await done
      return true
    },
  }
  let crashed = false
  server.listen(0, '127.0.0.1', () => {
    if (crashed) return
    stdout.write(`${JSON.stringify({ type: 'ready', protocol: PROTOCOL, port: server.address().port, token })}\n`)
  })
  return {
    handle,
    /** Make the child exit as a crash would. */
    crash() {
      crashed = true
      settle({ exitCode: 3, signal: null })
      stdout.end()
      stderr.end()
      stdin.end()
      server.closeAllConnections?.()
      server.close()
    },
  }
}

/** @param {string} root - test directory. @returns {object} engine config for the stub. */
function stubConfig(root) {
  return {
    electron: 'stub-electron',
    hostDir: path.join(root, 'host'),
    eoRoot: path.join(root, 'eo'),
    x2t: path.join(root, 'x2t.exe'),
    tempRoot: path.join(root, 'temp'),
    logDir: path.join(root, 'log'),
    missing: [],
    testHooks: false,
    timeouts: { startupMs: 5000, requestMs: 5000, openMs: 5000, saveMs: 5000, closeMs: 5000, disposeMs: 5000, shutdownMs: 200 },
  }
}

test('an exiting sidecar leaves no live engine session (WD-098)', { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-engine-rpc-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const children = []
  const engine = createDocxEngine(stubConfig(root), {
    runtime: { spawn() { const child = createStubChild(); children.push(child); return child.handle } },
    log: () => {},
  })
  t.after(() => engine.dispose().catch(() => {}))
  const opened = await engine.open({ bytes: Buffer.from('DOCX'), name: 'stub.docx' })
  assert.equal(engine.status().sessions.length, 1)
  assert.equal(engine.status().sessions[0].sessionId, opened.sessionId)
  engine.stopping = true
  children[0].crash()
  for (let i = 0; i < 50 && engine.status().sessions.length > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(engine.status().sessions, [])
  assert.equal(engine.status().running, false)
})

test('eleven crashed sidecars break the engine and refuse a new open (WD-097)', { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-engine-limit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const children = []
  const engine = createDocxEngine(stubConfig(root), {
    runtime: { spawn() { const child = createStubChild(); children.push(child); return child.handle } },
    log: () => {},
  })
  t.after(() => engine.dispose().catch(() => {}))
  await engine.open({ bytes: Buffer.from('DOCX'), name: 'stub.docx' })
  // Ten crashes already happened; the eleventh exceeds the limit.
  engine.restartCount = 10
  children[0].crash()
  for (let i = 0; i < 100 && engine.status().broken === null; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(typeof engine.status().broken, 'string')
  assert.match(engine.status().broken, /crashed 11 times/)
  await assert.rejects(
    () => engine.open({ bytes: Buffer.from('DOCX'), name: 'stub.docx' }),
    (error) => error.code === 'ENGINE_UNAVAILABLE',
  )
})

test('disposing the engine removes its run temp folder (WD-099)', { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-engine-temp-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const engine = createDocxEngine(stubConfig(root), {
    runtime: { spawn() { return createStubChild().handle } },
    log: () => {},
  })
  await engine.open({ bytes: Buffer.from('DOCX'), name: 'stub.docx' })
  const runTemp = engine.runTemp
  assert.equal(typeof runTemp, 'string')
  await engine.dispose()
  await assert.rejects(() => readdir(runTemp), (error) => error.code === 'ENOENT')
})

test('the sidecar host refuses to start without its arguments (WD-100)', { timeout: 120000 }, async (t) => {
  const config = resolveEngineConfig({})
  if (config.missing.length > 0) return t.skip(`sidecar not installed: ${config.missing.join('; ')}`)
  const hostDir = path.resolve(import.meta.dirname, '..', 'lib', 'engine', 'host')
  // The manager spawns the host app as an app, not as Node; a harness process
  // may carry ELECTRON_RUN_AS_NODE, which would change what the binary is.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  const child = spawn(config.electron, [hostDir], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const exitCode = await new Promise((resolve) => child.once('close', (code) => resolve(code)))
  assert.equal(exitCode, 2)
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim() !== '')
  assert.equal(lines[lines.length - 1].trim(), 'missing argument --eo-root')
})

test('the sidecar RPC rejects a wrong token with 403 (WD-136)', { timeout: 180000 }, async (t) => {
  const config = resolveEngineConfig({})
  if (config.missing.length > 0) return t.skip(`sidecar not installed: ${config.missing.join('; ')}`)
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-engine-token-'))
  const engine = createDocxEngine({ ...config, tempRoot: path.join(root, 'temp'), logDir: path.join(root, 'log') }, { log: () => {} })
  try {
    await engine.start()
    const rpc = engine.rpc
    assert.equal(typeof rpc.port, 'number')
    const response = await fetch(`http://127.0.0.1:${rpc.port}/engine-rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-engine-token': 'wrong' },
      body: JSON.stringify({ id: 1, method: 'status', params: {} }),
    })
    await response.body?.cancel()
    assert.equal(response.status, 403)
  } finally {
    await engine.dispose().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
