/**
 * `workspace-docx-engine` row: the deterministic document engine seam.
 *
 * Placeholder until the S1 engine is chosen (sdkjs Document Builder, or the
 * reduced model with x2t). Every method rejects with `EngineUnavailableError`,
 * so a consumer fails loud instead of editing nothing. The module has no
 * imports on purpose: it must load before the model, tools, fan-out and review
 * rows, and it must never pull in a writer or a native binary by itself.
 */

/** Rejection of every `docxEngine` method until an engine implementation replaces this stub. */
export class EngineUnavailableError extends Error {
  /**
   * @param operation — the engine method that was called.
   */
  constructor(operation) {
    super(`docxEngine.${operation} is unavailable: no DOCX engine is wired`)
    this.name = 'EngineUnavailableError'
    /** Stable code for tool results and tests. */
    this.code = 'ENGINE_UNAVAILABLE'
    /** The engine method that rejected. */
    this.operation = operation
  }
}

export const name = 'workspace-docx-engine'

/**
 * Provide the stub engine as `ctx.docxEngine`.
 *
 * The row declares no injection, so it loads without the filesystem, subprocess
 * or editor services and unloads by dropping the provided service.
 *
 * @param ctx — the row's Cordis context; only `provide` is used.
 */
export function apply(ctx) {
  ctx.provide('docxEngine', {
    /** Open a path or byte buffer as an engine session. */
    async open() {
      throw new EngineUnavailableError('open')
    },
    /** Describe an open session: blocks, IDs, outline and revision facts. */
    async describe() {
      throw new EngineUnavailableError('describe')
    },
    /** Apply one atomic operation to a session. */
    async apply() {
      throw new EngineUnavailableError('apply')
    },
    /** Diff the immutable base against the working state. */
    async diff() {
      throw new EngineUnavailableError('diff')
    },
    /** Serialize the working state, tracked when requested. */
    async save() {
      throw new EngineUnavailableError('save')
    },
    /** Close a session; idempotent once implemented. */
    async close() {
      throw new EngineUnavailableError('close')
    },
  })
}
