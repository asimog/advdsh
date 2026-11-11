/**
 * `workspace-docx-engine` row: the deterministic document engine behind
 * `ctx.docxEngine`, implemented as a managed hidden-Electron Document Builder
 * sidecar.
 *
 * The sidecar runs the official sdkjs Word Document Builder in the vendored
 * Euro-Office Lite editor page; x2t converts DOCXâ†”Editor.bin. The manager owns
 * one child process, request ids, per-request timeout/cancel, a crash log and
 * restart, and an awaited exit on dispose. Every method rejects with an
 * `EngineError` carrying a stable `code`; automation never shows a modal dialog.
 *
 * Work only in `plugins/workspace-editor/lib/engine/`: the row, manager, block
 * diff, path resolution, the sidecar host app and the verification harness live
 * there.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { EngineError, EngineUnavailableError } from './errors.js'
import { resolveEngineConfig } from './locate.js'
import { createDocxEngine } from './manager.js'

export { EngineError, EngineUnavailableError, ENGINE_CODES } from './errors.js'
export { createDocxEngine } from './manager.js'
export { resolveEngineConfig } from './locate.js'
export { diffBlocks } from './diff.js'

export const name = 'workspace-docx-engine'
/** The sidecar is spawned through the DSH subprocess seam. */
export const inject = ['subprocess']

/**
 * Provide the engine as `ctx.docxEngine` and own the sidecar lifetime.
 *
 * The provided service is the six-method surface the stub declared:
 * `open`, `describe`, `apply`, `diff`, `save`, `close`. `status()` is an
 * additional read-only fact for the `editor` tool; the manager itself is not
 * exposed.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the row's Cordis context.
 */
export function apply(ctx) {
  const config = resolveEngineConfig()
  const hostFrontend = process.env.WORKSPACE_EDITOR_FRONTEND
  const frontendProblem = hostFrontend === undefined || hostFrontend === ''
    ? null
    : !existsSync(path.join(hostFrontend, 'sdkjs', 'word', 'apiBuilder.js'))
      ? `frontend mismatch: ${hostFrontend} has no sdkjs/word/apiBuilder.js`
      : config.eoRoot !== undefined && path.resolve(config.eoRoot) !== path.resolve(hostFrontend)
        ? `frontend mismatch: host serves ${hostFrontend} but engine uses ${config.eoRoot}`
        : null
  const engine = createDocxEngine(config, { runtime: ctx.subprocess })
  const missing = config.missing ?? []
  if (missing.length > 0) {
    console.error(`[workspace-docx-engine] sidecar not configured: ${missing.join('; ')}`)
  }

  /** Teardown the process before the service disappears. */
  ctx.effect(() => () => engine.dispose(), 'workspace-editor.docxEngine.lifecycle')

  const service = {
    /**
     * Open a DOCX path or byte buffer.
     * @param {{ path?: string, bytes?: Buffer|Uint8Array|ArrayBuffer|string, name?: string }} input - document source.
     * @param {{ author?: string, timeoutMs?: number, signal?: AbortSignal }} [options] - tracked-change author and deadline.
     */
    open: (input, options) => {
      if (frontendProblem !== null) return Promise.reject(new EngineUnavailableError('open', frontendProblem))
      return engine.open(input, options)
    },
    /** @param {string} sessionId - engine session. @param {object} [options] - deadline/cancel. */
    describe: (sessionId, options) => engine.describe(sessionId, options),
    /** @param {string} sessionId - engine session. @param {object} op - curated op. @param {object} [options] - deadline/cancel. */
    apply: (sessionId, op, options) => engine.apply(sessionId, op, options),
    /** @param {string} sessionId - engine session. @param {object} [options] - deadline/cancel. */
    diff: (sessionId, options) => engine.diff(sessionId, options),
    /** @param {string} sessionId - engine session. @param {{ targetPath?: string }} [options] - save destination. */
    save: (sessionId, options) => engine.save(sessionId, options),
    /** @param {string} sessionId - engine session. @param {object} [options] - deadline/cancel. */
    close: (sessionId, options) => engine.close(sessionId, options),
    /** Read-only engine sidecar facts. */
    status: () => engine.status(),
  }

  ctx.effect(() => ctx.provide('docxEngine', service), 'workspace-editor.docxEngine.service')
}
