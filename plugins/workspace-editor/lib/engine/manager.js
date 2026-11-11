/**
 * Managed hidden-Electron Document Builder sidecar behind `ctx.docxEngine`.
 *
 * One child Electron process speaks newline-delimited JSON over stdin/stdout.
 * The manager owns request ids, per-request timeouts and cancellation, the
 * session map, the working/base block snapshots, DOCX byte file IO and the
 * disposal ladder (shutdown request, terminate, awaited exit).
 *
 * The process is spawned through the DSH `ctx.subprocess` seam when available;
 * the Node `child_process` fallback exists so the same code can be exercised
 * outside a Cordis context (the verification harness passes it explicitly).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { diffBlocks } from './diff.js'
import { ENGINE_CODES, EngineError } from './errors.js'
import { engineCodeForSidecar } from '../errors.js'

const PROTOCOL_VERSION = 1

/** Spawn a child with Node's `child_process`, shaped like the DSH subprocess handle. */
export function createNodeRuntime() {
  return {
    /**
     * @param {{ argv: string[], cwd: string, env?: Record<string, string|undefined>, stdio?: object }} spec - spawn spec.
     * @returns {object} subprocess-handle subset the manager needs.
     */
    spawn(spec) {
      const env = { ...process.env }
      for (const [key, value] of Object.entries(spec.env ?? {})) {
        if (value === undefined) delete env[key]
        else env[key] = value
      }
      const child = nodeSpawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const done = new Promise((resolve) => {
        let settled = false
        const finish = (outcome) => {
          if (settled) return
          settled = true
          resolve(outcome)
        }
        child.once('error', (error) => finish({ exitCode: null, signal: null, error: error }))
        child.once('close', (code, signal) => finish({ exitCode: code, signal: signal }))
      })
      return {
        pid: child.pid,
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        done: done,
        terminate() {
          try { child.kill('SIGKILL') } catch (error) {}
        },
        async waitForExit() {
          try { await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5000))]) } catch (error) {}
          return child.exitCode !== null || child.signalCode !== null
        },
      }
    },
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout(promise, ms, onTimeout) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { reject(onTimeout()) }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function normalizeBytes(value) {
  if (value === undefined || value === null) return undefined
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value, 'base64')
  throw new EngineError(ENGINE_CODES.INVALID_OP, 'bytes must be a Buffer, Uint8Array, ArrayBuffer or base64 string')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The stable shape of a describe block the manager exposes to callers. */
function normalizeBlock(block, index) {
  const source = block && typeof block === 'object' ? block : {}
  const normalized = {
    id: typeof source.id === 'string' && source.id !== '' ? source.id : `i:${index}`,
    index: Number.isInteger(source.index) ? source.index : index,
    kind: typeof source.kind === 'string' && source.kind !== '' ? source.kind : 'unknown',
    text: typeof source.text === 'string' ? source.text : '',
  }
  if (typeof source.style === 'string' && source.style !== '') normalized.style = source.style
  if (Number.isFinite(source.paraId) && source.paraId > 0) normalized.paraId = source.paraId
  if (Number.isFinite(source.level)) normalized.level = source.level
  if (source.numbering && Number.isFinite(source.numbering.level)) normalized.numbering = { level: source.numbering.level }
  if (Number.isFinite(source.rows)) normalized.rows = source.rows
  if (Array.isArray(source.tableRows)) normalized.tableRows = source.tableRows
  if (typeof source.deletedText === 'string' && source.deletedText !== '') normalized.deletedText = source.deletedText
  if (Array.isArray(source.runs)) {
    normalized.runs = source.runs.map((run, runIndex) => {
      const entry = run && typeof run === 'object' ? run : {}
      return {
        kind: entry.kind === 'opaque' ? 'opaque' : 'run',
        runIndex: Number.isInteger(entry.runIndex) ? entry.runIndex : runIndex,
        ...(entry.kind === 'opaque'
          ? { type: typeof entry.type === 'string' ? entry.type : 'unknown' }
          : {
            text: typeof entry.text === 'string' ? entry.text : '',
            props: entry.props && typeof entry.props === 'object' ? entry.props : {},
            inserted: entry.inserted === true,
            deleted: entry.deleted === true,
            author: entry.author ?? null,
          }),
      }
    })
  }
  if (source.props && typeof source.props === 'object') normalized.props = source.props
  if (Array.isArray(source.rowsDetail)) normalized.rowsDetail = source.rowsDetail
  return normalized
}

/** Outline rows derived from heading-level paragraphs. */
function outlineOf(blocks) {
  const outline = []
  for (const block of blocks) {
    if (block.kind !== 'paragraph') continue
    const style = block.style ?? ''
    let level = Number.isFinite(block.level) ? block.level : undefined
    if (level === undefined) {
      const match = /^heading\s*([1-9])$/i.exec(style)
      if (match) level = Number(match[1]) - 1
    }
    if (level === undefined) continue
    outline.push({ id: block.id, index: block.index, level, text: block.text })
  }
  return outline
}

export class DocxEngineSidecar {
  /**
   * @param {object} config - `resolveEngineConfig()` output (or a test override).
   * @param {{ runtime?: { spawn(spec: object): object }, log?: (level: string, message: string, data?: unknown) => void }} [options] - injected runtime and logger.
   */
  constructor(config, options = {}) {
    this.config = config
    this.runtime = options.runtime ?? createNodeRuntime()
    this.logSink = options.log
    this.sessions = new Map()
    this.pending = new Map()
    this.nextRequestId = 1
    this.process = null
    this.rpc = null
    this.starting = null
    this.disposing = null
    this.stopping = false
    this.restartCount = 0
    this.broken = null
    this.lastExit = null
    this.runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
    this.logFile = null
    this.crashFile = null
    this.stderrTail = []
  }

  // --- logging ---------------------------------------------------------------

  /** Append one manager log line to stderr and the per-run log file. */
  log(level, message, data) {
    const line = `${new Date().toISOString()} [${level}] ${message}${data === undefined ? '' : ` ${safeJson(data)}`}`
    try { console.error(`[workspace-docx-engine] ${message}${data === undefined ? '' : ` ${safeJson(data)}`}`) } catch (error) {}
    try {
      if (this.logFile !== null) appendFileSync(this.logFile, `${line}\n`)
      else this.logSink?.(level, message, data)
    } catch (error) {}
  }

  #ensureLogPaths() {
    if (this.logFile !== null) return
    try {
      mkdirSync(this.config.logDir, { recursive: true })
      this.logFile = path.join(this.config.logDir, `engine-${this.runId}.log`)
      this.crashFile = path.join(this.config.logDir, 'crash.log')
      writeFileSync(this.logFile, `${new Date().toISOString()} [info] engine run ${this.runId}\n`, { flag: 'a' })
    } catch (error) {
      this.logFile = null
      this.crashFile = null
    }
  }

  #writeCrash(kind, details) {
    this.#ensureLogPaths()
    if (this.crashFile === null) return
    try {
      appendFileSync(this.crashFile, `${new Date().toISOString()} ${kind} ${safeJson(details)}\n`)
    } catch (error) {}
  }

  // --- process lifecycle -----------------------------------------------------

  get running() {
    return this.process !== null
  }

  /** Start the sidecar unless it is already running; shares one startup among callers. */
  async start() {
    if (this.disposing !== null) throw new EngineError(ENGINE_CODES.DISPOSED, 'docxEngine has been disposed')
    if (this.broken !== null) {
      throw new EngineError(ENGINE_CODES.UNAVAILABLE, this.broken, { details: { logFile: this.logFile } })
    }
    if (this.process !== null) return this.process
    if (this.starting !== null) return this.starting
    this.starting = this.#start().finally(() => { this.starting = null })
    return this.starting
  }

  async #start() {
    this.#ensureLogPaths()
    const config = this.config
    const missing = config.missing ?? []
    if (missing.length > 0) {
      throw new EngineError(
        ENGINE_CODES.UNAVAILABLE,
        `docx engine sidecar is not configured: ${missing.join('; ')}. Set WORKSPACE_EDITOR_ENGINE_ELECTRON, WORKSPACE_EDITOR_ENGINE_EO_ROOT and WORKSPACE_EDITOR_X2T.`,
        { details: { missing: missing } },
      )
    }
    mkdirSync(config.tempRoot, { recursive: true })
    const runTemp = path.join(config.tempRoot, this.runId)
    mkdirSync(runTemp, { recursive: true })
    const crashLog = path.join(config.logDir, 'crash.log')
    const args = [
      config.hostDir,
      `--eo-root=${config.eoRoot}`,
      `--x2t=${config.x2t}`,
      `--temp-root=${runTemp}`,
      `--crash-log=${crashLog}`,
    ]
    if (config.testHooks === true) args.push('--test-hooks')
    this.stderrTail = []
    this.log('info', 'starting sidecar', { electron: config.electron, host: config.hostDir, eoRoot: config.eoRoot, x2t: config.x2t, runId: this.runId })

    let handle
    try {
      handle = this.runtime.spawn({
        argv: [config.electron, ...args],
        cwd: config.hostDir,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 5000,
        env: {
          ELECTRON_RUN_AS_NODE: undefined,
          ELECTRON_NO_ATTACH_CONSOLE: undefined,
          APPLICATION_NAME: 'Advodsh-DocxEngine',
        },
      })
    } catch (error) {
      throw new EngineError(ENGINE_CODES.START_FAILED, `could not spawn the docx engine sidecar: ${error instanceof Error ? error.message : error}`, { cause: error })
    }

    let readyResolve
    let readyReject
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    const onReady = () => readyResolve(handle)
    const onReadyError = (error) => readyReject(error)

    const stdout = handle.stdout
    if (stdout) {
      const reader = readline.createInterface({ input: stdout })
      reader.on('line', (line) => {
        const text = line.trim()
        if (text === '') return
        let message
        try { message = JSON.parse(text) } catch (error) {
          this.log('warn', 'sidecar noise on stdout', { text: text.slice(0, 300) })
          return
        }
        if (message.type === 'ready') {
          if (message.protocol !== PROTOCOL_VERSION) {
            onReadyError(new EngineError(ENGINE_CODES.PROTOCOL, `sidecar protocol ${message.protocol} does not match ${PROTOCOL_VERSION}`))
            return
          }
          if (!Number.isInteger(message.port) || message.port <= 0 || typeof message.token !== 'string' || message.token === '') {
            onReadyError(new EngineError(ENGINE_CODES.PROTOCOL, 'sidecar ready frame is missing its RPC port/token'))
            return
          }
          this.rpc = { port: message.port, token: message.token }
          onReady()
          return
        }
        if (message.type === 'event') this.log('info', `sidecar event ${message.event}`, message.data)
      })
    }
    if (handle.stderr) {
      const reader = readline.createInterface({ input: handle.stderr })
      reader.on('line', (line) => {
        const text = line.trim()
        if (text === '') return
        this.stderrTail.push(text)
        if (this.stderrTail.length > 40) this.stderrTail.shift()
        if (this.logFile !== null) {
          try { appendFileSync(this.logFile, `${text}\n`) } catch (error) {}
        }
      })
    }
    handle.done.then((outcome) => {
      onReadyError(new EngineError(
        ENGINE_CODES.START_FAILED,
        `docx engine sidecar exited before it was ready (code ${String(outcome && outcome.exitCode)}${outcome && outcome.signal ? `, signal ${outcome.signal}` : ''})`,
        { details: { stderr: this.stderrTail.slice(-20) } },
      ))
      this.#handleExit(handle, outcome, null)
    }, (error) => {
      onReadyError(new EngineError(ENGINE_CODES.START_FAILED, `docx engine sidecar failed: ${error instanceof Error ? error.message : error}`, { cause: error }))
      this.#handleExit(handle, null, error)
    })
    this.process = handle

    try {
      await withTimeout(ready, config.timeouts.startupMs, () => new EngineError(
        ENGINE_CODES.START_FAILED,
        `docx engine sidecar did not become ready within ${config.timeouts.startupMs}ms`,
        { details: { stderr: this.stderrTail.slice(-20) } },
      ))
    } catch (error) {
      this.process = null
      try { handle.terminate() } catch (inner) {}
      if (error instanceof EngineError) {
        this.#writeCrash('start-failed', { message: error.message, stderr: this.stderrTail.slice(-20) })
        throw error
      }
      throw new EngineError(ENGINE_CODES.START_FAILED, `docx engine sidecar failed to start: ${error instanceof Error ? error.message : error}`, { cause: error })
    }
    this.restartCount = 0
    this.log('info', 'sidecar ready', { pid: handle.pid ?? null, protocol: PROTOCOL_VERSION })
    return handle
  }

  #handleExit(handle, outcome, error) {
    if (this.process !== handle) {
      this.log('warn', 'stale sidecar exit ignored', { outcome: outcome, error: error ? String(error) : undefined })
      return
    }
    this.process = null
    this.rpc = null
    const exitCode = outcome && outcome.exitCode !== undefined ? outcome.exitCode : null
    const signal = outcome && outcome.signal !== undefined ? outcome.signal : null
    this.lastExit = { exitCode, signal, at: new Date().toISOString(), expected: this.stopping }
    const crash = new EngineError(
      ENGINE_CODES.CRASHED,
      `docx engine sidecar exited unexpectedly (code ${String(exitCode)}${signal ? `, signal ${signal}` : ''})`,
      { details: { exitCode, signal, stderr: this.stderrTail.slice(-20), logFile: this.logFile } },
    )
    for (const [id, pending] of this.pending) {
      this.#settle(id, { error: crash })
    }
    for (const session of this.sessions.values()) session.alive = false
    this.log('error', 'sidecar exited', { exitCode, signal, expected: this.stopping, stderr: this.stderrTail.slice(-10) })
    if (!this.stopping) {
      this.#writeCrash('sidecar-exit', { exitCode, signal, stderr: this.stderrTail.slice(-20), sessions: Array.from(this.sessions.keys()) })
      this.restartCount += 1
      const maxRestarts = 10
      if (this.restartCount > maxRestarts) {
        this.broken = `docx engine sidecar crashed ${this.restartCount} times; last exit code ${String(exitCode)}. See ${this.logFile ?? this.config.logDir}.`
        this.log('error', 'restart limit reached', { restarts: this.restartCount })
        return
      }
      const delay = Math.min(250 * this.restartCount, 5000)
      this.log('info', 'restarting sidecar', { attempt: this.restartCount, delayMs: delay })
      setTimeout(() => {
        if (this.process !== null || this.starting !== null || this.disposing !== null) return
        this.start().catch((restartError) => {
          this.log('error', 'sidecar restart failed', { error: restartError instanceof Error ? restartError.message : String(restartError) })
        })
      }, delay).unref?.()
    }
  }

  /** Reject or resolve one pending request exactly once. */
  #settle(id, { error, result } = {}) {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    if (pending.removeAbort !== undefined) {
      try { pending.removeAbort() } catch (error) {}
    }
    if (error !== undefined) pending.reject(error)
    else pending.resolve(result)
  }

  /** Map one sidecar error payload to an EngineError with the public code. */
  #errorFromSidecar(method, raw) {
    const source = raw && typeof raw === 'object' ? raw : {}
    const code = typeof source.code === 'string' ? source.code : 'SIDECAR_ERROR'
    const mapped = engineCodeForSidecar(code)
    return new EngineError(mapped, `${method}: ${source.message ?? 'sidecar request failed'}`, {
      details: { sidecarCode: code, method },
    })
  }

  /**
   * One JSON POST to the sidecar's loopback RPC listener. stdout carries only
   * the ready frame, so browser console noise can never corrupt the channel.
   * @param {string} method - sidecar method.
   * @param {object} params - method params.
   * @param {{ id?: number, signal?: AbortSignal }} [options] - request id and abort signal.
   * @returns {Promise<unknown>} sidecar result.
   */
  async #rpcFetch(method, params, options = {}) {
    const rpc = this.rpc
    if (rpc === null) throw new EngineError(ENGINE_CODES.CRASHED, 'docx engine sidecar is not running')
    const response = await fetch(`http://127.0.0.1:${rpc.port}/engine-rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-engine-token': rpc.token },
      body: JSON.stringify({ id: options.id ?? -1, method, params }),
      signal: options.signal,
    })
    if (!response.ok) {
      throw new EngineError(ENGINE_CODES.PROTOCOL, `docx engine sidecar RPC rejected the request with HTTP ${response.status}`)
    }
    const payload = await response.json()
    if (!payload || payload.ok !== true) throw this.#errorFromSidecar(method, payload && payload.error)
    return payload.result
  }

  /**
   * Send one request over the loopback RPC channel and wait for its response.
   * @param {string} method - sidecar method.
   * @param {object} params - method params.
   * @param {{ timeoutMs?: number, signal?: AbortSignal, methodLabel?: string }} [options] - deadline and cancellation.
   * @returns {Promise<unknown>} sidecar result.
   */
  request(method, params, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.config.timeouts.requestMs
    return new Promise((resolve, reject) => {
      if (this.disposing !== null) {
        reject(new EngineError(ENGINE_CODES.DISPOSED, 'docxEngine has been disposed'))
        return
      }
      if (this.process === null || this.rpc === null) {
        reject(new EngineError(ENGINE_CODES.CRASHED, 'docx engine sidecar is not running'))
        return
      }
      const id = this.nextRequestId++
      const pending = { id, method: options.methodLabel ?? method, resolve, reject, timer: undefined, removeAbort: undefined }
      this.pending.set(id, pending)
      const controller = new AbortController()
      let settled = false
      const finish = (error, result) => {
        if (settled) return
        settled = true
        if (error !== undefined) {
          this.#settle(id, { error })
          try { controller.abort() } catch (inner) {}
        } else {
          this.#settle(id, { result })
        }
      }
      pending.timer = setTimeout(() => {
        finish(new EngineError(ENGINE_CODES.TIMEOUT, `${pending.method} timed out after ${timeoutMs}ms`, { details: { timeoutMs } }))
      }, timeoutMs)
      pending.timer.unref?.()
      const signal = options.signal
      if (signal !== undefined) {
        if (signal.aborted) {
          this.#settle(id, { error: new EngineError(ENGINE_CODES.CANCELLED, `${pending.method} was cancelled before it started`) })
          return
        }
        const onAbort = () => finish(new EngineError(ENGINE_CODES.CANCELLED, `${pending.method} was cancelled`))
        signal.addEventListener('abort', onAbort, { once: true })
        pending.removeAbort = () => signal.removeEventListener('abort', onAbort)
      }
      this.#rpcFetch(method, params, { id, signal: controller.signal }).then(
        (result) => finish(undefined, result),
        (error) => {
          if (settled) return
          if (error instanceof EngineError) {
            finish(error)
            return
          }
          if (error && error.name === 'AbortError') {
            finish(new EngineError(ENGINE_CODES.CANCELLED, `${pending.method} was cancelled`))
            return
          }
          finish(new EngineError(
            ENGINE_CODES.CRASHED,
            `${pending.method} failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error, details: { stderr: this.stderrTail.slice(-10) } },
          ))
        },
      )
    })
  }

  // --- public engine API -----------------------------------------------------

  /** Start (or restart) the sidecar explicitly; used by the verification harness. */
  async restart() {
    if (this.disposing !== null) throw new EngineError(ENGINE_CODES.DISPOSED, 'docxEngine has been disposed')
    this.broken = null
    this.restartCount = 0
    await this.#stopProcess()
    return this.start()
  }

  /** Engine status for the `docxEngine.status()` extension. */
  status() {
    return {
      running: this.process !== null,
      ready: this.rpc !== null,
      pid: this.process?.pid ?? null,
      broken: this.broken,
      restarts: this.restartCount,
      lastExit: this.lastExit,
      logFile: this.logFile,
      sessions: Array.from(this.sessions.values()).map((session) => ({
        sessionId: session.sessionId,
        name: session.name,
        path: session.path,
        author: session.author,
        alive: session.alive === true,
        revision: session.revision,
        dirty: session.dirty,
        sourceBytes: session.sourceBytes,
      })),
      config: {
        electron: this.config.electron ?? null,
        eoRoot: this.config.eoRoot ?? null,
        x2t: this.config.x2t ?? null,
        missing: this.config.missing ?? [],
      },
    }
  }

  /**
   * Open one DOCX as an engine session.
   * @param {{ path?: string, bytes?: Buffer|Uint8Array|ArrayBuffer|string, name?: string }} input - document source.
   * @param {{ author?: string, timeoutMs?: number, signal?: AbortSignal }} [options] - tracked-change author and deadline.
   * @returns {Promise<object>} session facts.
   */
  async open(input, options = {}) {
    await this.#ensureProcess(options)
    const source = input && typeof input === 'object' ? input : {}
    let bytes
    let filePath
    if (source.bytes !== undefined) {
      bytes = normalizeBytes(source.bytes)
    } else if (typeof source.path === 'string' && source.path !== '') {
      filePath = path.resolve(source.path)
      bytes = await readFile(filePath)
    }
    if (!bytes || bytes.length === 0) throw new EngineError(ENGINE_CODES.INVALID_OP, 'open requires a path or non-empty bytes')
    const sessionId = `docx-${randomUUID()}`
    const name = typeof source.name === 'string' && source.name !== ''
      ? source.name
      : filePath !== undefined ? path.basename(filePath) : 'document.docx'
    const author = typeof options.author === 'string' && options.author !== '' ? options.author : `agent:${sessionId}`
    const openResult = await this.request('open', {
      sessionId,
      name,
      author,
      docxBase64: bytes.toString('base64'),
    }, { timeoutMs: options.timeoutMs ?? this.config.timeouts.openMs, signal: options.signal, methodLabel: 'open' })
    const session = {
      sessionId,
      name,
      path: filePath ?? null,
      author,
      sourceBytes: bytes.length,
      sourceHash: sha256(bytes),
      revision: 0,
      dirty: false,
      alive: true,
      baseBlocks: [],
      baseDescription: null,
      lastSavedPath: null,
      openFacts: openResult,
    }
    this.sessions.set(sessionId, session)
    try {
      const description = await this.describe(sessionId, { signal: options.signal })
      session.baseBlocks = description.blocks
      session.baseDescription = { paragraphCount: description.paragraphCount, tableCount: description.tableCount, outline: description.outline }
      session.revision = description.revision
      return {
        sessionId,
        name,
        path: filePath ?? null,
        author,
        sourceBytes: bytes.length,
        sourceHash: session.sourceHash,
        editorBinBytes: openResult && openResult.editorBinBytes,
        paragraphs: description.paragraphCount,
        tables: description.tableCount,
        blocks: description.blocks.length,
        revision: session.revision,
      }
    } catch (error) {
      await this.close(sessionId).catch(() => {})
      throw error
    }
  }

  #requireSession(sessionId) {
    const session = this.sessions.get(sessionId)
    if (session === undefined) {
      throw new EngineError(ENGINE_CODES.SESSION_NOT_FOUND, `unknown engine session: ${String(sessionId)}`)
    }
    if (session.alive !== true) {
      throw new EngineError(ENGINE_CODES.SESSION_LOST, `engine session ${sessionId} was lost when the sidecar exited; reopen the document`, { details: { sessionId } })
    }
    return session
  }

  /**
   * Describe a session: stable block IDs, text, style/numbering facts, outline.
   * @param {string} sessionId - session to describe.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - deadline.
   * @returns {Promise<object>} description.
   */
  async describe(sessionId, options = {}) {
    const session = this.#requireSession(sessionId)
    const raw = await this.request('describe', { sessionId }, { timeoutMs: options.timeoutMs ?? this.config.timeouts.requestMs, signal: options.signal, methodLabel: 'describe' })
    const source = raw && typeof raw === 'object' ? raw : {}
    const blocks = Array.isArray(source.blocks) ? source.blocks.map((block, index) => normalizeBlock(block, index)) : []
    return {
      sessionId,
      revision: session.revision,
      hash: session.sourceHash,
      blocks,
      outline: outlineOf(blocks),
      paragraphCount: blocks.filter((block) => block.kind === 'paragraph').length,
      tableCount: blocks.filter((block) => block.kind === 'table').length,
      elementsCount: Number.isFinite(source.elementsCount) ? source.elementsCount : blocks.length,
    }
  }

  /**
   * Apply one curated op; tracked changes are on unless `op.track === false`.
   * @param {string} sessionId - session to edit.
   * @param {object} op - operation, see the engine README/AGENTS report.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - deadline.
   * @returns {Promise<object>} affected blocks and new revision.
   */
  async apply(sessionId, op, options = {}) {
    const session = this.#requireSession(sessionId)
    if (!op || typeof op !== 'object' || typeof op.type !== 'string' || op.type === '') {
      throw new EngineError(ENGINE_CODES.INVALID_OP, 'apply requires an op object with a type')
    }
    const raw = await this.request('apply', { sessionId, op }, { timeoutMs: options.timeoutMs ?? this.config.timeouts.requestMs, signal: options.signal, methodLabel: `apply(${op.type})` })
    const result = raw && typeof raw === 'object' ? raw : {}
    session.revision += 1
    session.dirty = true
    return {
      sessionId,
      revision: session.revision,
      op: op.type,
      tracked: result.tracked !== false,
      affected: Array.isArray(result.affected) ? result.affected : [],
      facts: result,
    }
  }

  /**
   * Diff the immutable open-time base against the current working state.
   * @param {string} sessionId - session to diff.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - deadline.
   * @returns {Promise<object>} change set.
   */
  async diff(sessionId, options = {}) {
    const session = this.#requireSession(sessionId)
    if (!Array.isArray(session.baseBlocks)) {
      throw new EngineError(ENGINE_CODES.SESSION_LOST, `session ${sessionId} has no base snapshot`)
    }
    const current = await this.describe(sessionId, options)
    const diff = diffBlocks(session.baseBlocks, current.blocks)
    return {
      sessionId,
      baseRevision: 0,
      revision: session.revision,
      baseHash: session.sourceHash,
      changes: diff.changes,
      counts: diff.counts,
      changed: diff.changed,
    }
  }

  /**
   * Serialize the working state through the editor and x2t.
   * @param {string} sessionId - session to save.
   * @param {{ targetPath?: string, timeoutMs?: number, signal?: AbortSignal }} [options] - destination; defaults to the opened path.
   * @returns {Promise<object>} saved bytes and revision.
   */
  async save(sessionId, options = {}) {
    const session = this.#requireSession(sessionId)
    const targetPath = typeof options.targetPath === 'string' && options.targetPath !== ''
      ? path.resolve(options.targetPath)
      : session.path
    const raw = await this.request('save', { sessionId }, { timeoutMs: options.timeoutMs ?? this.config.timeouts.saveMs, signal: options.signal, methodLabel: 'save' })
    const source = raw && typeof raw === 'object' ? raw : {}
    const bytes = Buffer.from(String(source.docxBase64 ?? ''), 'base64')
    if (bytes.length === 0) throw new EngineError(ENGINE_CODES.SAVE_FAILED, 'engine save returned no DOCX bytes')
    if (targetPath !== null && targetPath !== undefined) {
      await this.#writeAtomic(targetPath, bytes)
    }
    session.dirty = false
    session.revision += 1
    session.sourceHash = sha256(bytes)
    session.lastSavedPath = targetPath ?? null
    return {
      sessionId,
      path: targetPath ?? null,
      targetPath: targetPath ?? null,
      bytes,
      size: bytes.length,
      sha256: session.sourceHash,
      revision: session.revision,
      editorBinBytes: source.editorBinBytes,
    }
  }

  /** Write a file atomically: staging file in the same directory, then rename. */
  async #writeAtomic(targetPath, bytes) {
    const directory = path.dirname(targetPath)
    await mkdir(directory, { recursive: true })
    const staging = path.join(directory, `.${path.basename(targetPath)}.engine-${process.pid}-${Date.now()}`)
    await writeFile(staging, bytes)
    try {
      if (existsSync(targetPath)) await rm(targetPath, { force: true })
      await rename(staging, targetPath)
    } catch (error) {
      await rm(staging, { force: true }).catch(() => {})
      throw new EngineError(ENGINE_CODES.SAVE_FAILED, `could not write ${targetPath}: ${error instanceof Error ? error.message : error}`, { cause: error })
    }
  }

  /**
   * Close a session; idempotent.
   * @param {string} sessionId - session to close.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - deadline.
   * @returns {Promise<{ sessionId: string, closed: boolean }>} close fact.
   */
  async close(sessionId, options = {}) {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return { sessionId, closed: true }
    if (session.alive === true && this.process !== null) {
      try {
        await this.request('close', { sessionId }, { timeoutMs: options.timeoutMs ?? 15_000, signal: options.signal, methodLabel: 'close' })
      } catch (error) {
        this.log('warn', 'sidecar close failed; dropping session locally', { error: error instanceof Error ? error.message : String(error) })
      }
    }
    this.sessions.delete(sessionId)
    return { sessionId, closed: true }
  }

  // --- disposal --------------------------------------------------------------

  async #ensureProcess(options) {
    if (this.disposing !== null) throw new EngineError(ENGINE_CODES.DISPOSED, 'docxEngine has been disposed')
    await this.start()
    if (this.process === null) throw new EngineError(ENGINE_CODES.CRASHED, 'docx engine sidecar is not running')
  }

  async #stopProcess() {
    const handle = this.process
    if (handle === null) return
    this.stopping = true
    const crash = new EngineError(ENGINE_CODES.DISPOSED, 'docxEngine is stopping')
    for (const [id] of this.pending) this.#settle(id, { error: crash })
    const timeoutMs = this.config.timeouts.shutdownMs
    if (this.rpc !== null) {
      try {
        await withTimeout(this.#rpcFetch('shutdown', {}, { id: this.nextRequestId++ }), Math.min(timeoutMs, 10_000), () => null)
      } catch (error) {
        this.log('warn', 'sidecar shutdown request failed', { error: error instanceof Error ? error.message : String(error) })
      }
    }
    let exited = false
    try {
      exited = await withTimeout(Promise.resolve(handle.waitForExit ? handle.waitForExit() : handle.done), timeoutMs, () => false)
    } catch (error) {
      exited = false
    }
    if (!exited) {
      this.log('warn', 'sidecar did not exit gracefully; terminating', { timeoutMs })
      try { handle.terminate() } catch (error) {}
      try {
        await withTimeout(Promise.resolve(handle.waitForExit ? handle.waitForExit() : handle.done), 10_000, () => false)
      } catch (error) {}
    }
    if (this.process === handle) this.process = null
    this.stopping = false
  }

  /**
   * Stop the sidecar and await its exit. Idempotent; every later call rejects
   * with ENGINE_DISPOSED.
   * @returns {Promise<void>} settles after the process range is gone.
   */
  dispose() {
    if (this.disposing !== null) return this.disposing
    this.disposing = (async () => {
      this.log('info', 'disposing engine', { sessions: this.sessions.size, running: this.running })
      await this.#stopProcess()
      this.sessions.clear()
      this.log('info', 'engine disposed', { lastExit: this.lastExit })
    })()
    return this.disposing
  }

  // --- test-only hooks -------------------------------------------------------

  /** Test hook: ask the sidecar to crash, exercising crash log and restart. */
  async debugExit() {
    await this.start()
    return this.request('debug.exit', {}, { timeoutMs: 10_000, methodLabel: 'debug.exit' })
  }

  /** Test hook: hold a sidecar request open, exercising timeout and cancellation. */
  async debugSleep(ms) {
    await this.start()
    return this.request('debug.sleep', { ms }, { timeoutMs: 10_000, methodLabel: 'debug.sleep' })
  }
}

/**
 * Create one engine manager.
 * @param {object} config - `resolveEngineConfig()` output.
 * @param {{ runtime?: object, log?: Function }} [options] - injected runtime/logger.
 * @returns {DocxEngineSidecar} manager.
 */
export function createDocxEngine(config, options = {}) {
  return new DocxEngineSidecar(config, options)
}

/** True when a path looks like the engine host app directory. */
export function isHostDir(dir) {
  try { return statSync(path.join(dir, 'main.js')).isFile() } catch (error) { return false }
}

function safeJson(value) {
  try { return JSON.stringify(value) } catch (error) { return String(value) }
}
