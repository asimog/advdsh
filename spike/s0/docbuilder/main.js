'use strict'

// S0 spike: run the official sdkjs Word Document Builder (word/apiBuilder.js)
// in a hidden Electron (Chromium) window and edit a real DOCX.
//
// The spike deliberately keeps the whole Euro-Office editor page: the builder
// API is a layer over the editor engine, and the editor is the exact runtime
// the plugin already ships. The window is hidden; all interaction is scripted.

const { app, BrowserWindow, ipcMain, protocol } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')

const SPIKE = __dirname
const REPO = path.resolve(SPIKE, '..', '..', '..')
const EO_ROOT = process.env.EO_ROOT || path.join(REPO, 'resources', 'euro-office')
const X2T_DIR = process.env.EO_X2T_DIR || path.join(REPO, 'resources', 'euro-office-lite-src', 'src-tauri', 'binaries')
const DOCX_PATH = path.resolve(process.argv.find((a) => a.startsWith('--docx='))?.slice(7) || path.join(REPO, 'workspace-test', 'TRO - Motion.docx'))
const OUT_PATH = path.resolve(process.argv.find((a) => a.startsWith('--out='))?.slice(6) || path.join(SPIKE, 'out', 'TRO-Motion-builder.docx'))
const WORK = path.join(SPIKE, 'temp')
const OUT_DIR = path.join(SPIKE, 'out')
const LOGS = path.join(SPIKE, 'logs')
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-')
const LOG_PATH = path.join(LOGS, `run-${RUN_ID}.log`)
const USER_DATA = path.join(WORK, 'electron-user-data')
const CRASH_LOG = path.join(LOGS, 'crash.log')

// A spike never blocks on a modal error dialog. Electron shows one for an
// uncaught main-process exception; replace that default handler and the stdout
// error path with a file log plus a non-zero exit, so the parent run can read
// the failure and rerun.
function writeCrash(kind, error) {
  const text = error && error.stack ? error.stack : String(error)
  try {
    fs.mkdirSync(LOGS, { recursive: true })
    fs.appendFileSync(CRASH_LOG, `${new Date().toISOString()} ${kind} ${text}\n`)
  } catch {}
}
for (const stream of [process.stdout, process.stderr]) {
  try { stream.on('error', () => {}) } catch {}
}
process.removeAllListeners('uncaughtException')
process.on('uncaughtException', (error) => {
  writeCrash('uncaughtException', error)
  try { app.exit(1) } catch {}
})
process.removeAllListeners('unhandledRejection')
process.on('unhandledRejection', (reason) => {
  writeCrash('unhandledRejection', reason)
  try { app.exit(1) } catch {}
})

// Chromium keeps a profile lock in userData. A stale profile from an earlier
// run makes the next instance exit during startup, so start clean each time.
try { fs.rmSync(USER_DATA, { recursive: true, force: true }) } catch {}

let server = null
let serverPort = 0
let mainWindow = null
let x2tCounter = 0
let workingDoc = null
const events = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function shutdown(code) {
  log('shutdown', { code })
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.removeAllListeners('close')
      mainWindow.destroy()
    }
  } catch {}
  app.exit(code)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function log(message, data) {
  const line = `${new Date().toISOString()} ${message}${data === undefined ? '' : ` ${safeJson(data)}`}`
  events.push({ at: Date.now(), message, data })
  try { fs.appendFileSync(LOG_PATH, `${line}\n`) } catch {}
  // The parent may close the pipe before the app exits; the file log is the
  // source of truth and a closed stdout must never become a crash dialog.
  try { console.log(line) } catch {}
}

function safeJson(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
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
  try { return fs.statSync(filePath).size } catch { return 0 }
}

function runX2t(input, output, formatTo, tempDir, tag) {
  return new Promise((resolve, reject) => {
    const paramsPath = path.join(tempDir, `x2t_params_${tag}_${process.pid}_${x2tCounter++}.xml`)
    fs.writeFileSync(paramsPath, paramsXml(input, output, formatTo, tempDir), 'utf8')
    const exe = path.join(X2T_DIR, 'x2t.exe')
    const started = Date.now()
    const child = spawn(exe, [paramsPath], {
      cwd: X2T_DIR,
      windowsHide: true,
      env: { ...process.env, APPLICATION_NAME: 'DocBuilder-Spike' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', (error) => {
      try { fs.rmSync(paramsPath, { force: true }) } catch {}
      reject(new Error(`x2t spawn failed: ${error.message}`))
    })
    child.once('close', (code) => {
      try { fs.rmSync(paramsPath, { force: true }) } catch {}
      const result = { code, ms: Date.now() - started, stdout: stdout.slice(-8000), stderr: stderr.slice(-8000) }
      log(`x2t ${tag}`, { code, ms: result.ms, output, stderr: result.stderr.slice(-2000) })
      if (code !== 0) reject(new Error(`x2t ${tag} exited ${code}: ${result.stderr.trim()}`))
      else resolve(result)
    })
  })
}

async function openDocument(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`document does not exist: ${filePath}`)
  const docId = `docbuilder-${Date.now()}`
  const tempDir = path.join(WORK, docId)
  const mediaDir = path.join(tempDir, 'media')
  await fsp.rm(tempDir, { recursive: true, force: true })
  await fsp.mkdir(mediaDir, { recursive: true })
  const binPath = path.join(tempDir, 'Editor.bin')
  const x2t = await runX2t(filePath, binPath, 8192, tempDir, 'open')
  const bytes = await fsp.readFile(binPath)
  if (bytes.length === 0) throw new Error('x2t open wrote a zero-byte Editor.bin')
  const mediaFiles = await fsp.readdir(mediaDir).catch(() => [])
  const result = {
    docId,
    docxPath: filePath,
    sourceBytes: fileSize(filePath),
    binBase64: bytes.toString('base64'),
    binBytes: bytes.length,
    mediaBase: `http://127.0.0.1:${serverPort}/media/${encodeURIComponent(docId)}`,
    mediaFiles: mediaFiles.length,
    x2tMs: x2t.ms,
  }
  log('opened DOCX through x2t', { docId, binBytes: bytes.length, mediaFiles: mediaFiles.length, x2tMs: x2t.ms })
  return result
}

async function saveDocument(binBase64, targetPath) {
  if (!workingDoc) throw new Error('save: no document has been opened')
  const tempDir = path.join(WORK, workingDoc.docId)
  const binPath = path.join(tempDir, 'Editor.bin')
  const bytes = Buffer.from(binBase64, 'base64')
  if (bytes.length === 0) throw new Error('save: empty Editor.bin from the document builder')
  await fsp.writeFile(binPath, bytes)
  const stagingDir = path.join(tempDir, 'save_output')
  await fsp.rm(stagingDir, { recursive: true, force: true })
  await fsp.mkdir(stagingDir, { recursive: true })
  const staged = path.join(stagingDir, path.basename(targetPath))
  const x2t = await runX2t(binPath, staged, 65, tempDir, 'save')
  if (fileSize(staged) === 0) throw new Error('x2t save wrote a zero-byte DOCX')
  await fsp.mkdir(path.dirname(targetPath), { recursive: true })
  const stagingTarget = `${targetPath}.staging-${process.pid}`
  await fsp.copyFile(staged, stagingTarget)
  await fsp.rm(targetPath, { force: true })
  await fsp.rename(stagingTarget, targetPath)
  const result = { targetPath, bytes: fileSize(targetPath), editorBinBytes: bytes.length, x2tMs: x2t.ms }
  log('saved DOCX through x2t', result)
  return result
}

// ---------------------------------------------------------------------------
// Static server: one origin for the spike page, web-apps, sdkjs, fonts, media.
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

function send(res, status, body, type) {
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
  if (!info || !info.isFile()) return send(res, 404, 'not found')
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.html' || ext === '.htm') {
    let html = await fsp.readFile(filePath, 'utf8')
    const bridgeTag = '<script src="/spike-frame-bridge.js"></script>'
    if (!html.includes('spike-frame-bridge.js')) {
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
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed')
        if (pathname === '/' || pathname === '/host.html') return serveFile(res, path.join(SPIKE, 'host.html'))
        if (pathname === '/spike-bridge.js') return serveFile(res, path.join(SPIKE, 'host-bridge.js'))
        if (pathname === '/spike-frame-bridge.js') return serveFile(res, path.join(SPIKE, 'frame-bridge.js'))
        if (pathname === '/font-patches.js') return serveFile(res, path.join(EO_ROOT, 'font-patches.js'))
        if (pathname === '/document_editor_service_worker.js') {
          return send(res, 200, 'self.addEventListener("install",function(){self.skipWaiting();});self.addEventListener("activate",function(){self.clients.claim();});', 'application/javascript; charset=utf-8')
        }
        if (pathname.startsWith('/media/')) {
          const rest = pathname.slice('/media/'.length)
          const slash = rest.indexOf('/')
          if (slash === -1) return send(res, 404, 'not found')
          const docId = rest.slice(0, slash)
          const name = rest.slice(slash + 1)
          if (!docId || !name || name.includes('..') || docId.includes('..')) return send(res, 400, 'bad path')
          return serveFile(res, path.join(WORK, docId, name))
        }
        const relative = pathname.replace(/^\/+/, '')
        const target = path.resolve(EO_ROOT, relative)
        if (!target.startsWith(path.resolve(EO_ROOT) + path.sep)) return send(res, 403, 'forbidden')
        return serveFile(res, target)
      } catch (error) {
        log('server error', { error: String(error && error.stack || error) })
        send(res, 500, 'server error')
      }
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port
      log('static server listening', { port: serverPort, eoRoot: EO_ROOT, x2tDir: X2T_DIR })
      resolve(serverPort)
    })
  })
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('db:config', () => ({ docxPath: DOCX_PATH, outPath: OUT_PATH, port: serverPort }))
  ipcMain.handle('db:open', async () => {
    workingDoc = await openDocument(DOCX_PATH)
    return workingDoc
  })
  ipcMain.handle('db:save', async (_event, payload) => saveDocument(payload.binBase64, OUT_PATH))
  ipcMain.handle('db:log', (_event, entry) => { log(`renderer:${entry.level || 'log'}`, entry); return true })
}

// ---------------------------------------------------------------------------
// Window and automation
// ---------------------------------------------------------------------------

async function waitFor(expression, timeoutMs, label) {
  const start = Date.now()
  let lastError = null
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await mainWindow.webContents.executeJavaScript(expression, true)
      if (value) return value
    } catch (error) {
      lastError = String(error && error.message || error)
    }
    await sleep(250)
  }
  throw new Error(`timeout after ${timeoutMs}ms waiting for ${label}${lastError ? ` (last error: ${lastError})` : ''}`)
}

function attachLogging() {
  mainWindow.webContents.on('console-message', (...args) => {
    let details
    if (args[0] && typeof args[0] === 'object' && 'message' in args[0]) {
      details = { level: args[0].level, message: args[0].message, line: args[0].lineNumber, source: args[0].sourceId }
    } else {
      details = { level: args[1], message: args[2], line: args[3], source: args[4] }
    }
    if (details.level === 'error' || details.level === 'warning') log('console', details)
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => log('did-fail-load', { code, description, url }))
  mainWindow.webContents.on('render-process-gone', (_e, details) => log('render-process-gone', details))
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => log('preload-error', { preloadPath, error: String(error) }))
}

async function runAutomation() {
  try {
    await waitFor("window.__db && window.__db.state === 'editor-app-ready'", 120000, 'editor-app-ready')
    log('editor app ready', await mainWindow.webContents.executeJavaScript('window.__db.timings', true))

    await mainWindow.webContents.executeJavaScript('window.__db.openConfigured()', true)
    await waitFor("window.__db && window.__db.state === 'document-ready'", 180000, 'document-ready')
    log('document ready', await mainWindow.webContents.executeJavaScript('window.__db.timings', true))

    const builder = await mainWindow.webContents.executeJavaScript('window.__db.runBuilderScript()', true)
    log('builder script finished', builder)

    const binBase64 = await mainWindow.webContents.executeJavaScript('window.__db.saveBase64()', true)
    if (typeof binBase64 !== 'string' || binBase64.length === 0) throw new Error('builder save returned no bytes')
    const saved = await saveDocument(binBase64, OUT_PATH)

    const result = {
      ok: true,
      runId: RUN_ID,
      runtime: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      headless: { windowShown: false, width: 1400, height: 900 },
      paths: { docx: DOCX_PATH, output: OUT_PATH, eoRoot: EO_ROOT, x2tDir: X2T_DIR },
      builder,
      save: saved,
      events,
    }
    ensureDir(OUT_DIR)
    const resultJson = JSON.stringify(result, null, 2)
    await fsp.writeFile(path.join(OUT_DIR, 'result.json'), resultJson, 'utf8')
    await fsp.writeFile(path.join(OUT_DIR, `result-${path.basename(OUT_PATH, path.extname(OUT_PATH))}.json`), resultJson, 'utf8')
    log('RESULT', { output: OUT_PATH, bytes: saved.bytes, replaced: builder.replacedIndex })
    await sleep(300)
    await shutdown(0)
  } catch (error) {
    log('AUTOMATION FAILED', { error: String(error && error.stack || error) })
    ensureDir(OUT_DIR)
    await fsp.writeFile(path.join(OUT_DIR, 'result.json'), JSON.stringify({ ok: false, error: String(error && error.stack || error), events }, null, 2), 'utf8')
    await sleep(300)
    await shutdown(1)
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(SPIKE, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })
  attachLogging()
  mainWindow.on('closed', () => log('window closed'))
  mainWindow.webContents.on('destroyed', () => log('webContents destroyed'))
  mainWindow.webContents.once('did-finish-load', () => {
    log('did-finish-load')
    runAutomation().catch((error) => log('automation rejected', String(error)))
  })
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/host.html`)
}

app.setName('DocBuilderSpike')
app.setPath('userData', USER_DATA)
app.on('window-all-closed', () => { log('window-all-closed'); app.quit() })
app.on('before-quit', () => log('before-quit'))
app.on('will-quit', () => log('will-quit'))

app.whenReady().then(async () => {
  ensureDir(LOGS)
  ensureDir(WORK)
  ensureDir(OUT_DIR)
  protocol.handle('ascdesktop', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'fonts') return new Response('not found', { status: 404 })
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (!name || name.includes('..')) return new Response('bad path', { status: 400 })
      const data = await fsp.readFile(path.join(EO_ROOT, 'fonts', name))
      return new Response(data, { status: 200, headers: { 'content-type': 'font/ttf' } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
  log('spike starting', { docx: DOCX_PATH, output: OUT_PATH, electron: process.versions.electron, chrome: process.versions.chrome })
  registerIpc()
  await startServer()
  createWindow()
}).catch((error) => {
  log('startup failed', { error: String(error && error.stack || error) })
  app.exit(1)
})
