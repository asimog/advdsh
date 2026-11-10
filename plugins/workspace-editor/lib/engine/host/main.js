'use strict'

// Hidden-Electron Document Builder sidecar for workspace-editor's ctx.docxEngine.
//
// The plugin manager spawns this app with an Electron binary and speaks one JSON
// object per line over stdin/stdout: {type:'request', id, method, params} in,
// {type:'response', id, ok, result|error} out. stderr is diagnostics only.
//
// Each engine session owns one hidden BrowserWindow loading the vendored
// Euro-Office Lite editor page; DOCX bytes arrive over the protocol, x2t turns
// them into Editor.bin, the official builder host page edits and serializes the
// document, and x2t turns Editor.bin back into DOCX on save. The sidecar never
// shows a modal dialog: crashes are written to the crash log and the process
// exits non-zero, which the manager reports and restarts.

const { app, BrowserWindow, ipcMain, protocol } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const HOST = __dirname
const PROTOCOL = 1
const TEST_HOOKS = process.argv.includes('--test-hooks')

function argValue(name, fallback) {
  const prefix = `--${name}=`
  const hit = process.argv.find((value) => value.startsWith(prefix))
  return hit === undefined ? fallback : hit.slice(prefix.length)
}

const EO_ROOT = path.resolve(argValue('eo-root', path.join(HOST, '..', '..', '..', '..', 'resources', 'euro-office')))
const X2T = path.resolve(argValue('x2t', path.join(process.env.LOCALAPPDATA || '', 'advodsh-eo', 'converter', 'x2t.exe')))
const X2T_DIR = path.dirname(X2T)
const TEMP_ROOT = path.resolve(argValue('temp-root', path.join(process.env.TEMP || process.cwd(), 'advodsh-docx-engine')))
const CRASH_LOG = path.resolve(argValue('crash-log', path.join(TEMP_ROOT, 'crash.log')))
const USER_DATA = path.join(TEMP_ROOT, 'electron-user-data')
/** RPC token for the local request/response channel; never leaves the parent. */
const TOKEN = crypto.randomBytes(24).toString('hex')

// stdout belongs to the protocol. Electron and libraries that want console.log
// must go to stderr, which the manager records.
console.log = (...args) => { try { console.error(...args) } catch (error) {} }
console.info = console.log
console.debug = console.log

for (const stream of [process.stdout, process.stderr]) {
  try { stream.on('error', () => {}) } catch (error) {}
}

function writeCrash(kind, error) {
  const text = error && error.stack ? error.stack : String(error)
  try {
    fs.mkdirSync(path.dirname(CRASH_LOG), { recursive: true })
    fs.appendFileSync(CRASH_LOG, `${new Date().toISOString()} ${kind} ${text}\n`)
  } catch (error) {}
}

process.removeAllListeners('uncaughtException')
process.on('uncaughtException', (error) => {
  writeCrash('uncaughtException', error)
  try { app.exit(1) } catch (error) {}
})
process.removeAllListeners('unhandledRejection')
process.on('unhandledRejection', (reason) => {
  writeCrash('unhandledRejection', reason)
  try { app.exit(1) } catch (error) {}
})

// One process-wide profile is enough; the manager gives every run its own temp
// root, so this always starts clean and never inherits a stale Chromium lock.
try { fs.rmSync(USER_DATA, { recursive: true, force: true }) } catch (error) {}
try { fs.mkdirSync(TEMP_ROOT, { recursive: true }) } catch (error) {}
app.setPath('userData', USER_DATA)

let server = null
let serverPort = 0
let shuttingDown = false
let x2tCounter = 0
let x2tQueue = Promise.resolve()

/** sessionId -> session record. One hidden window per engine session. */
const sessions = new Map()
/** webContents.id -> session, so page IPC resolves its own document. */
const senderSessions = new Map()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function log(message, data) {
  const line = `${new Date().toISOString()} [host] ${message}${data === undefined ? '' : ` ${safeJson(data)}`}`
  try { process.stderr.write(`${line}\n`) } catch (error) {}
}

function safeJson(value) {
  try { return JSON.stringify(value) } catch (error) { return String(value) }
}

function protocolError(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function cancelledError() {
  return protocolError('CANCELLED', 'request cancelled')
}

function checkAbort(signal) {
  if (signal && signal.aborted) throw cancelledError()
}

function send(message) {
  try { process.stdout.write(`${JSON.stringify(message)}\n`) } catch (error) {
    // A closed parent pipe means the manager is gone; exit without a dialog.
    try { app.exit(1) } catch (inner) {}
  }
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96) || 'session'
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function paramsXml(input, output, formatTo, tempDir) {
  return `<?xml version="1.0" encoding="utf-8"?>
<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                      xmlns:xsd="http://www.w3.org/2001/XMLSchema">
<m_sFileFrom>${xmlEscape(input.replace(/\\/g, '/'))}</m_sFileFrom>
<m_sFileTo>${xmlEscape(output.replace(/\\/g, '/'))}</m_sFileTo>
<m_nFormatTo>${formatTo}</m_nFormatTo>
<m_sTempDir>${xmlEscape(tempDir.replace(/\\/g, '/'))}</m_sTempDir>
<options>
<allowPrivateIP>false</allowPrivateIP>
<allowNetworkRequest>false</allowNetworkRequest>
</options>
</TaskQueueDataConvert>`
}

function fileSize(filePath) {
  try { return fs.statSync(filePath).size } catch (error) { return 0 }
}

async function runX2tNow(input, output, formatTo, tempDir, tag) {
  const paramsPath = path.join(tempDir, `x2t_params_${tag}_${process.pid}_${x2tCounter++}.xml`)
  await fsp.writeFile(paramsPath, paramsXml(input, output, formatTo, tempDir), 'utf8')
  const started = Date.now()
  const result = await new Promise((resolve) => {
    const child = spawn(X2T, [paramsPath], {
      cwd: X2T_DIR,
      windowsHide: true,
      env: { ...process.env, APPLICATION_NAME: 'Advodsh-DocxEngine' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', (error) => resolve({ code: -1, stdout, stderr: stderr + String(error) }))
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
  try { fs.rmSync(paramsPath, { force: true }) } catch (error) {}
  const ms = Date.now() - started
  log(`x2t ${tag}`, { code: result.code, ms, stderr: result.stderr.slice(-2000) })
  if (result.code !== 0) throw protocolError('X2T_FAILED', `x2t ${tag} exited ${result.code}: ${result.stderr.trim().slice(-4000)}`)
  return { ms, stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) }
}

/** One x2t conversion at a time: the converter is a single-job binary. */
function runX2t(input, output, formatTo, tempDir, tag) {
  const run = x2tQueue.then(() => runX2tNow(input, output, formatTo, tempDir, tag), () => runX2tNow(input, output, formatTo, tempDir, tag))
  x2tQueue = run.then(() => {}, () => {})
  return run
}

// ---------------------------------------------------------------------------
// Static server: one origin for the host page, web-apps, sdkjs, fonts, media.
// ---------------------------------------------------------------------------

const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject', '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}))

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'unsafe-inline' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: ascdesktop:",
  "font-src 'self' data: blob: ascdesktop:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob: ascdesktop:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

protocol.registerSchemesAsPrivileged([{
  scheme: 'ascdesktop',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}])

function sendText(res, status, body, type) {
  res.writeHead(status, {
    'content-type': type || 'text/plain; charset=utf-8',
    'content-security-policy': CSP,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

async function serveFile(res, filePath) {
  const info = await fsp.stat(filePath).catch(() => null)
  if (!info || !info.isFile()) return sendText(res, 404, 'not found')
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.html' || ext === '.htm') {
    let html = await fsp.readFile(filePath, 'utf8')
    const bridgeTag = '<script src="/engine-frame-bridge.js"></script>'
    if (!html.includes('engine-frame-bridge.js')) {
      const head = /<head[^>]*>/i.exec(html)
      const at = head ? head.index + head[0].length : 0
      html = html.slice(0, at) + bridgeTag + html.slice(at)
    }
    const body = Buffer.from(html, 'utf8')
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      'content-security-policy': CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
    return
  }
  res.writeHead(200, {
    'content-type': MIME.get(ext) || 'application/octet-stream',
    'content-length': info.size,
    'content-security-policy': CSP,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res)
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const pathname = decodeURIComponent(url.pathname)
        if (pathname === '/engine-rpc') return handleRpc(req, res)
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed')
        if (pathname === '/' || pathname === '/host.html') return serveFile(res, path.join(HOST, 'host.html'))
        if (pathname === '/engine-bridge.js') return serveFile(res, path.join(HOST, 'host-bridge.js'))
        if (pathname === '/engine-frame-bridge.js') return serveFile(res, path.join(HOST, 'frame-bridge.js'))
        if (pathname === '/font-patches.js') return serveFile(res, path.join(EO_ROOT, 'font-patches.js'))
        if (pathname === '/document_editor_service_worker.js') {
          return sendText(res, 200, 'self.addEventListener("install",function(){self.skipWaiting();});self.addEventListener("activate",function(){self.clients.claim();});', 'application/javascript; charset=utf-8')
        }
        if (pathname.startsWith('/media/')) {
          const rest = pathname.slice('/media/'.length)
          const slash = rest.indexOf('/')
          if (slash === -1) return sendText(res, 404, 'not found')
          const sessionId = rest.slice(0, slash)
          const name = rest.slice(slash + 1)
          const session = sessions.get(sessionId)
          if (!session || !name || name.includes('..') || sessionId.includes('..')) return sendText(res, 400, 'bad path')
          return serveFile(res, path.join(session.mediaDir, name))
        }
        const relative = pathname.replace(/^\/+/, '')
        const target = path.resolve(EO_ROOT, relative)
        if (!target.startsWith(path.resolve(EO_ROOT) + path.sep)) return sendText(res, 403, 'forbidden')
        return serveFile(res, target)
      } catch (error) {
        log('server error', { error: String(error && error.stack || error) })
        sendText(res, 500, 'server error')
      }
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port
      log('static server listening', { port: serverPort, eoRoot: EO_ROOT, x2t: X2T })
      resolve(serverPort)
    })
  })
}

// ---------------------------------------------------------------------------
// Session windows
// ---------------------------------------------------------------------------

function attachLogging(window, session) {
  const webContents = window.webContents
  webContents.on('console-message', (...args) => {
    let details
    if (args[0] && typeof args[0] === 'object' && 'message' in args[0]) {
      details = { level: args[0].level, message: args[0].message, line: args[0].lineNumber, source: args[0].sourceId }
    } else {
      details = { level: args[1], message: args[2], line: args[3], source: args[4] }
    }
    if (details.level === 'error' || details.level === 'warning') log('page console', { session: session.sessionId, ...details })
  })
  webContents.on('did-fail-load', (_event, code, description, url) => log('did-fail-load', { session: session.sessionId, code, description, url }))
  webContents.on('render-process-gone', (_event, details) => {
    log('render-process-gone', { session: session.sessionId, details })
    writeCrash('render-process-gone', JSON.stringify({ session: session.sessionId, details }))
  })
  webContents.on('preload-error', (_event, preloadPath, error) => log('preload-error', { session: session.sessionId, preloadPath, error: String(error) }))
}

async function exec(session, expression) {
  const window = session.window
  if (!window || window.isDestroyed()) throw protocolError('SESSION_LOST', 'session window is gone')
  return window.webContents.executeJavaScript(expression, true)
}

async function waitFor(session, expression, timeoutMs, label, signal) {
  const start = Date.now()
  let lastError = null
  while (Date.now() - start < timeoutMs) {
    checkAbort(signal)
    try {
      const value = await exec(session, expression)
      if (value) return value
    } catch (error) {
      lastError = String(error && error.message || error)
    }
    await sleep(200)
  }
  throw protocolError('TIMEOUT', `timeout after ${timeoutMs}ms waiting for ${label}${lastError ? ` (last error: ${lastError})` : ''}`)
}

async function createSessionWindow(session) {
  return new Promise((resolve, reject) => {
    const window = new BrowserWindow({
      width: 1400,
      height: 900,
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: path.join(HOST, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    })
    const senderId = window.webContents.id
    session.window = window
    session.senderId = senderId
    senderSessions.set(senderId, session)
    attachLogging(window, session)
    window.on('closed', () => {
      senderSessions.delete(senderId)
      log('window closed', { session: session.sessionId })
    })
    window.webContents.once('did-finish-load', () => resolve(window))
    window.webContents.once('did-fail-load', (_event, code, description, url) => {
      reject(protocolError('PAGE_LOAD_FAILED', `editor page failed to load: ${code} ${description} ${url}`))
    })
    window.loadURL(`http://127.0.0.1:${serverPort}/host.html`)
  })
}

function requireSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') throw protocolError('BAD_REQUEST', 'sessionId is required')
  const session = sessions.get(sessionId)
  if (!session) throw protocolError('SESSION_NOT_FOUND', `unknown session: ${sessionId}`)
  return session
}

// ---------------------------------------------------------------------------
// Protocol methods
// ---------------------------------------------------------------------------

async function openSession(params, signal) {
  const sessionId = params.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') throw protocolError('BAD_REQUEST', 'sessionId is required')
  if (sessions.has(sessionId)) throw protocolError('SESSION_EXISTS', `session already open: ${sessionId}`)
  const docx = Buffer.from(String(params.docxBase64 || ''), 'base64')
  if (docx.length === 0) throw protocolError('BAD_REQUEST', 'open requires DOCX bytes')
  const dir = path.join(TEMP_ROOT, safeName(sessionId))
  const mediaDir = path.join(dir, 'media')
  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.mkdir(mediaDir, { recursive: true })
  const sourcePath = path.join(dir, 'source.docx')
  const binPath = path.join(dir, 'Editor.bin')
  await fsp.writeFile(sourcePath, docx)
  checkAbort(signal)
  const x2t = await runX2t(sourcePath, binPath, 8192, dir, 'open')
  checkAbort(signal)
  if (fileSize(binPath) === 0) throw protocolError('X2T_FAILED', 'x2t open wrote a zero-byte Editor.bin')
  const session = {
    sessionId,
    name: typeof params.name === 'string' && params.name !== '' ? params.name : 'document.docx',
    author: typeof params.author === 'string' && params.author !== '' ? params.author : 'agent:docx-engine',
    dir,
    mediaDir,
    sourcePath,
    binPath,
    window: null,
    senderId: null,
  }
  sessions.set(sessionId, session)
  try {
    await createSessionWindow(session)
    await waitFor(session, "window.__dbx && window.__dbx.state === 'editor-app-ready'", 120000, 'editor-app-ready', signal)
    // The font shaper loads asynchronously after the app; opening before it is
    // ready fails with `AscFonts.HB_StartString is not a function`.
    await waitFor(session, 'window.__dbx.fontsReady()', 60000, 'fonts-ready', signal)
    await exec(session, 'window.__dbx.openConfigured()')
    await waitFor(session, "window.__dbx.state === 'document-ready'", 180000, 'document-ready', signal)
  } catch (error) {
    await closeSession(sessionId).catch(() => {})
    throw error
  }
  return {
    sessionId,
    sourceBytes: docx.length,
    editorBinBytes: fileSize(binPath),
    x2tMs: x2t.ms,
    mediaBase: `http://127.0.0.1:${serverPort}/media/${encodeURIComponent(sessionId)}`,
    author: session.author,
  }
}

async function describeSession(params) {
  const session = requireSession(params.sessionId)
  const description = await exec(session, 'window.__dbx.describe()')
  return description
}

async function applySession(params) {
  const session = requireSession(params.sessionId)
  const op = params.op
  if (!op || typeof op !== 'object' || typeof op.type !== 'string') throw protocolError('BAD_REQUEST', 'apply requires an op with a type')
  const result = await exec(session, `window.__dbx.applyOp(${JSON.stringify(op)})`)
  if (!result || typeof result !== 'object') throw protocolError('OP_FAILED', 'builder host returned no result')
  if (result.ok === false) throw protocolError(result.code || 'OP_FAILED', result.message || 'operation failed')
  return result
}

async function saveSession(params) {
  const session = requireSession(params.sessionId)
  const binBase64 = await exec(session, 'window.__dbx.saveBinBase64()')
  if (typeof binBase64 !== 'string' || binBase64.length === 0) throw protocolError('SAVE_FAILED', 'builder returned no Editor.bin')
  const bytes = Buffer.from(binBase64, 'base64')
  if (bytes.length === 0) throw protocolError('SAVE_FAILED', 'builder returned empty Editor.bin')
  await fsp.writeFile(session.binPath, bytes)
  const stagingDir = path.join(session.dir, 'save_output')
  await fsp.rm(stagingDir, { recursive: true, force: true })
  await fsp.mkdir(stagingDir, { recursive: true })
  const staged = path.join(stagingDir, 'document.docx')
  const x2t = await runX2t(session.binPath, staged, 65, session.dir, 'save')
  if (fileSize(staged) === 0) throw protocolError('SAVE_FAILED', 'x2t save wrote a zero-byte DOCX')
  const docx = await fsp.readFile(staged)
  return { docxBase64: docx.toString('base64'), size: docx.length, editorBinBytes: bytes.length, x2tMs: x2t.ms }
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) return { sessionId, closed: true }
  sessions.delete(sessionId)
  if (session.senderId !== null) senderSessions.delete(session.senderId)
  try {
    if (session.window && !session.window.isDestroyed()) {
      session.window.removeAllListeners('closed')
      session.window.destroy()
    }
  } catch (error) {}
  await fsp.rm(session.dir, { recursive: true, force: true }).catch(() => {})
  log('session closed', { sessionId })
  return { sessionId, closed: true }
}

async function debugSleep(params, signal) {
  if (!TEST_HOOKS) throw protocolError('TEST_HOOKS_DISABLED', 'debug hooks are disabled')
  const ms = Math.max(0, Math.min(Number(params.ms) || 0, 10000))
  const end = Date.now() + ms
  while (Date.now() < end) {
    checkAbort(signal)
    await sleep(50)
  }
  return { sleptMs: ms }
}

async function shutdown() {
  if (shuttingDown) return { ok: true }
  shuttingDown = true
  for (const sessionId of Array.from(sessions.keys())) {
    await closeSession(sessionId).catch(() => {})
  }
  log('shutdown')
  setTimeout(() => {
    try { if (server) server.close() } catch (error) {}
    try { app.exit(0) } catch (error) {}
  }, 100)
  return { ok: true }
}

const methods = {
  ping: async () => ({ pong: Date.now(), pid: process.pid, protocol: PROTOCOL }),
  open: (params, signal) => openSession(params, signal),
  describe: (params) => describeSession(params),
  apply: (params) => applySession(params),
  save: (params) => saveSession(params),
  close: (params) => closeSession(params.sessionId),
  shutdown: () => shutdown(),
  'debug.sleep': (params, signal) => debugSleep(params, signal),
  'debug.exit': async () => {
    if (!TEST_HOOKS) throw protocolError('TEST_HOOKS_DISABLED', 'debug hooks are disabled')
    log('debug.exit requested')
    writeCrash('debug.exit', 'test hook exited the sidecar')
    setImmediate(() => { try { app.exit(7) } catch (error) {} })
    await new Promise(() => {})
  },
}

/**
 * One JSON request/response over a local HTTP POST. The parent aborts the
 * fetch on timeout/cancel, which closes this request and aborts the method.
 */
async function handleRpc(req, res) {
  if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
  if (req.headers['x-engine-token'] !== TOKEN) return sendText(res, 403, 'forbidden')
  let body = ''
  try {
    for await (const chunk of req) {
      body += chunk.toString('utf8')
      if (body.length > 96 * 1024 * 1024) throw new Error('request body is too large')
    }
  } catch (error) {
    return sendText(res, 413, 'request body is too large')
  }
  let message
  try { message = JSON.parse(body) } catch (error) {
    return sendText(res, 400, 'invalid JSON')
  }
  const controller = new AbortController()
  const onClose = () => { try { controller.abort() } catch (error) {} }
  req.on('close', onClose)
  const method = methods[message && message.method]
  try {
    if (!method) throw protocolError('UNKNOWN_METHOD', `unknown engine method: ${message && message.method}`)
    const result = await method(message.params || {}, controller.signal)
    if (!res.writableEnded) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ id: message.id, ok: true, result: result === undefined ? null : result }))
    }
  } catch (error) {
    const cancelled = controller.signal.aborted
    if (!res.writableEnded) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        id: message && message.id,
        ok: false,
        error: {
          code: cancelled ? 'CANCELLED' : (error && error.code) || 'SIDECAR_ERROR',
          message: String(error && error.message || error),
        },
      }))
    }
  } finally {
    req.off('close', onClose)
  }
}

function registerIpc() {
  ipcMain.handle('dbx:config', (event) => {
    const session = senderSessions.get(event.sender.id)
    if (!session) throw protocolError('SESSION_NOT_FOUND', 'page has no engine session')
    return { sessionId: session.sessionId, name: session.name, author: session.author }
  })
  ipcMain.handle('dbx:open', async (event) => {
    const session = senderSessions.get(event.sender.id)
    if (!session) throw protocolError('SESSION_NOT_FOUND', 'page has no engine session')
    const bin = await fsp.readFile(session.binPath)
    return {
      docId: session.sessionId,
      binBase64: bin.toString('base64'),
      mediaBase: `http://127.0.0.1:${serverPort}/media/${encodeURIComponent(session.sessionId)}`,
    }
  })
  ipcMain.handle('dbx:save', async () => ({ saved: false }))
  ipcMain.handle('dbx:log', (event, entry) => {
    const session = senderSessions.get(event.sender.id)
    log(`page:${entry && entry.level || 'log'}`, { session: session ? session.sessionId : undefined, entry })
    return true
  })
}

// The request channel is the local HTTP RPC route; stdout carries only the one
// ready frame. stdin is not reliable for an Electron child on Windows.
registerIpc()

app.on('window-all-closed', () => {
  // Sessions are manager-owned; the sidecar stays alive between windows.
})
app.on('before-quit', () => {
  if (!shuttingDown) log('before-quit')
})
app.on('will-quit', () => log('will-quit'))

app.whenReady().then(async () => {
  protocol.handle('ascdesktop', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'fonts') return new Response('not found', { status: 404 })
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (!name || name.includes('..')) return new Response('bad path', { status: 400 })
      const data = await fsp.readFile(path.join(EO_ROOT, 'fonts', name))
      return new Response(data, { status: 200, headers: { 'content-type': 'font/ttf' } })
    } catch (error) {
      return new Response('not found', { status: 404 })
    }
  })
  await startServer()
  log('sidecar ready', { protocol: PROTOCOL, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, testHooks: TEST_HOOKS })
  send({ type: 'ready', protocol: PROTOCOL, port: serverPort, token: TOKEN, pid: process.pid, electron: process.versions.electron, chrome: process.versions.chrome })
}).catch((error) => {
  log('startup failed', { error: String(error && error.stack || error) })
  writeCrash('startup', error)
  try { app.exit(1) } catch (inner) {}
})
