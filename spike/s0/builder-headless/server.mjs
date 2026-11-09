/**
 * Headless Document Builder spike server.
 *
 * Serves the vendored Euro-Office Lite frontend (resources/euro-office), the
 * plugin's host page/shim/boot trio, and the small api the host page needs:
 * DOCX -> Editor.bin through x2t before the editor opens, Editor.bin -> DOCX
 * after the builder script saves. Writes nothing outside this spike folder
 * except the x2t scratch under tmp/.
 *
 * Run: node spike/s0/builder-headless/server.mjs   (PORT defaults to 8791)
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const FRONTEND = path.join(REPO, 'resources', 'euro-office')
const FONT_FALLBACK = path.join(FRONTEND, 'fonts')
const CONVERTER = process.env.X2T_DIR ?? path.join(process.env.LOCALAPPDATA ?? '', 'advodsh-eo', 'converter')
const X2T = path.join(CONVERTER, 'x2t.exe')
const FONTDATA = path.join(process.env.LOCALAPPDATA ?? '', 'advodsh-eo', 'fontdata')
const GENERATED_ALLFONTS = path.join(FONTDATA, 'AllFonts.js')
const INPUT = process.env.SPIKE_DOCX === undefined
  ? path.join(HERE, 'input', 'TRO - Motion.docx')
  : path.resolve(process.env.SPIKE_DOCX)
const SAVE_NAME = process.env.SPIKE_SAVE_NAME ?? 'TRO - Motion.builder.docx'
const TAG = process.env.SPIKE_TAG ?? 'tro-motion'
const OUT = path.join(HERE, 'out')
const TMP = path.join(HERE, 'tmp')
const PORT = Number(process.env.PORT ?? 8791)
const FORMAT_DOCX = 65
const FORMAT_BIN = 8192

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.eot', 'application/vnd.ms-fontobject'],
  ['.wasm', 'application/wasm'],
  ['.map', 'application/json; charset=utf-8'],
  ['.bin', 'application/octet-stream'],
])

function log(message) {
  console.log(`[builder-headless] ${message}`)
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8')
}

function within(root, relative) {
  const target = path.resolve(root, '.' + path.sep + relative)
  const rootWithSep = path.resolve(root) + path.sep
  return target.startsWith(rootWithSep) ? target : undefined
}

async function serveFile(res, file, cacheControl = 'no-cache') {
  const info = await stat(file).catch(() => undefined)
  if (info === undefined || !info.isFile()) {
    send(res, 404, 'not found')
    return
  }
  const type = CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'cache-control': cacheControl })
  res.end(await readFile(file))
}

async function readBody(req, limit = 256 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJsonBody(req) {
  const body = await readBody(req, 1024 * 1024)
  return body.length === 0 ? {} : JSON.parse(body.toString('utf8'))
}

const xmlEscape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const slashes = (value) => value.replaceAll('\\', '/')

function paramsXml(job) {
  return `<?xml version="1.0" encoding="utf-8"?>
<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                      xmlns:xsd="http://www.w3.org/2001/XMLSchema">
<m_sFileFrom>${xmlEscape(slashes(job.from))}</m_sFileFrom>
<m_sFileTo>${xmlEscape(slashes(job.to))}</m_sFileTo>
<m_nFormatTo>${job.format}</m_nFormatTo>
<m_sTempDir>${xmlEscape(slashes(job.tempDir))}</m_sTempDir>
<options>
<allowPrivateIP>false</allowPrivateIP>
<allowNetworkRequest>false</allowNetworkRequest>
</options></TaskQueueDataConvert>`
}

let queue = Promise.resolve()

/** One x2t job at a time; x2t is a single-job process. */
function convert(job) {
  const run = queue.then(() => runNow(job), () => runNow(job))
  queue = run.then(() => {}, () => {})
  return run
}

async function runNow(job) {
  const info = await stat(X2T).catch(() => undefined)
  if (info === undefined) throw new Error(`x2t is missing at ${X2T}`)
  await rm(job.tempDir, { recursive: true, force: true })
  await mkdir(job.tempDir, { recursive: true })
  const paramsPath = path.join(job.tempDir, 'params.xml')
  await writeFile(paramsPath, paramsXml(job))
  const started = Date.now()
  const result = await new Promise((resolve) => {
    const child = spawn(X2T, [paramsPath], {
      cwd: CONVERTER,
      env: { ...process.env, APPLICATION_NAME: 'Advocate-Spike' },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: stderr + String(error) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  const ms = Date.now() - started
  if (result.code !== 0) {
    throw new Error(`x2t exited ${result.code} -> format ${job.format}: ${result.stderr.slice(0, 2000)}`)
  }
  return { ...result, ms }
}

/** One document: source DOCX on disk, Editor.bin the editor opens, output path. */
async function openDoc() {
  const id = TAG
  const tempDir = path.join(TMP, id)
  await mkdir(path.join(tempDir, 'media'), { recursive: true })
  await mkdir(OUT, { recursive: true })
  const binPath = path.join(tempDir, 'Editor.bin')
  const conv = await convert({ from: INPUT, to: binPath, format: FORMAT_BIN, tempDir: path.join(tempDir, 'x2t') })
  const binInfo = await stat(binPath).catch(() => undefined)
  if (binInfo === undefined || binInfo.size === 0) throw new Error('x2t produced no Editor.bin')
  log(`docx -> bin in ${conv.ms} ms (${binInfo.size} bytes)`)
  return {
    id,
    name: path.basename(INPUT),
    kind: 'word',
    tempDir,
    binPath,
    binBytes: binInfo.size,
    source: INPUT,
    savePath: path.join(OUT, SAVE_NAME),
  }
}

let doc = null

async function ensureDoc() {
  if (doc === null) doc = await openDoc()
  return doc
}

/** Editor.bin bytes -> DOCX at `target` through x2t. */
async function saveDoc(bytes, target) {
  const current = await ensureDoc()
  const binPath = path.join(current.tempDir, 'save.bin')
  const outPath = path.join(current.tempDir, 'save.docx')
  await writeFile(binPath, bytes)
  const conv = await convert({ from: binPath, to: outPath, format: FORMAT_DOCX, tempDir: path.join(current.tempDir, 'x2t') })
  const info = await stat(outPath).catch(() => undefined)
  if (info === undefined || info.size < 1024) throw new Error('x2t produced no DOCX')
  await rename(outPath, target)
  log(`bin -> docx in ${conv.ms} ms (${info.size} bytes) -> ${target}`)
  return { path: target, size: info.size, ms: conv.ms }
}

function requireDoc() {
  if (doc === null) throw new Error('no document opened: visit /start first')
  return doc
}

async function route(req, res) {
  const url = new URL(req.url, 'http://local')
  const pathname = decodeURIComponent(url.pathname)

  if (pathname === '/start') {
    await ensureDoc()
    const page = url.searchParams.get('page') === 'reopen' ? 'reopen.html' : 'host.html'
    res.writeHead(302, { location: `/workspace-editor/${page}?doc=${doc.id}` })
    res.end()
    return
  }
  if (pathname === '/workspace-editor/host.html') return serveFile(res, path.join(HERE, 'host.html'))
  if (pathname === '/workspace-editor/reopen.html') return serveFile(res, path.join(HERE, 'reopen.html'))
  if (pathname === '/workspace-editor/shim.js') return serveFile(res, path.join(HERE, 'shim.js'))
  if (pathname === '/workspace-editor/boot.js') return serveFile(res, path.join(HERE, 'boot.js'))
  if (pathname === '/workspace-editor/builder-run.js') return serveFile(res, path.join(HERE, 'builder-run.js'))

  if (pathname.startsWith('/workspace-editor/app/')) {
    const relative = pathname.slice('/workspace-editor/app/'.length)
    if (relative === 'sdkjs/common/AllFonts.js') {
      const generated = await stat(GENERATED_ALLFONTS).catch(() => undefined)
      if (generated !== undefined) return serveFile(res, GENERATED_ALLFONTS)
    }
    const file = within(FRONTEND, relative)
    if (file === undefined) return send(res, 403, 'outside frontend root')
    const bundled = await stat(file).catch(() => undefined)
    if (bundled === undefined && relative.startsWith('fonts/')) {
      const fallback = within(FONT_FALLBACK, relative.slice('fonts/'.length))
      if (fallback !== undefined) return serveFile(res, fallback, 'public, max-age=31536000, immutable')
    }
    return serveFile(res, file, 'public, max-age=31536000, immutable')
  }

  if (pathname === '/workspace-editor/api/info') {
    const current = requireDoc()
    return sendJson(res, 200, { id: current.id, name: current.name, kind: current.kind })
  }
  if (pathname === '/workspace-editor/api/bin') {
    const current = requireDoc()
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(await readFile(current.binPath))
    return
  }
  if (pathname === '/workspace-editor/api/save' && req.method === 'POST') {
    const current = requireDoc()
    const bytes = await readBody(req)
    log(`save request: ${bytes.length} bytes of Editor.bin`)
    const result = await saveDoc(bytes, current.savePath)
    return sendJson(res, 200, result)
  }
  if (pathname === '/workspace-editor/api/log' && req.method === 'POST') {
    const body = await readBody(req, 64 * 1024)
    if (body.length > 0) log(`page: ${body.toString('utf8').slice(0, 4000)}`)
    res.writeHead(204)
    res.end()
    return
  }
  if (pathname === '/workspace-editor/api/modified') {
    return sendJson(res, 200, { modified: true })
  }
  if (pathname === '/workspace-editor/api/result' && req.method === 'POST') {
    const body = await readBody(req, 4 * 1024 * 1024)
    const file = path.join(HERE, 'result.json')
    await writeFile(file, body)
    log(`result written to ${file}`)
    const parsed = JSON.parse(body.toString('utf8'))
    const current = doc
    let saved = null
    if (current !== null) {
      const info = await stat(current.savePath).catch(() => undefined)
      saved = info === undefined ? null : { path: current.savePath, size: info.size }
    }
    return sendJson(res, 200, { ok: true, result: parsed, saved })
  }
  if (pathname === '/workspace-editor/api/font') {
    const requested = url.searchParams.get('path')
    if (requested === null || requested === '') return send(res, 400, 'path is required')
    const absolute = path.resolve(requested.replace(/^[/\\]\?[/\\]?/, '').replaceAll('/', path.sep))
    if (!/\.(ttf|otf|ttc)$/i.test(absolute)) return send(res, 400, 'not a font file')
    return serveFile(res, absolute)
  }

  return send(res, 404, `not found: ${pathname}`)
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    log(`route failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    try { send(res, 500, String(error instanceof Error ? error.message : error)) } catch (e) {}
  })
})

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT}`)
  log(`frontend: ${FRONTEND}`)
  log(`converter: ${X2T}`)
  log(`open: http://127.0.0.1:${PORT}/start`)
})
