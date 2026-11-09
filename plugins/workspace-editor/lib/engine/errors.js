/**
 * Errors `ctx.docxEngine` raises. Every rejection carries a stable `code` so a
 * tool result can tell a stale target from a broken sidecar without parsing the
 * message.
 */

/** One engine failure with a stable code and optional structured details. */
export class EngineError extends Error {
  /**
   * @param {string} code - stable machine code, see `ENGINE_CODES`.
   * @param {string} message - operator-facing message.
   * @param {{ cause?: unknown, details?: unknown }} [options] - extra facts.
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'EngineError'
    /** Stable code for tool results and tests. */
    this.code = code
    if (options.cause !== undefined) this.cause = options.cause
    if (options.details !== undefined) this.details = options.details
  }
}

/** Kept for callers of the previous stub: the engine could not start. */
export class EngineUnavailableError extends EngineError {
  /**
   * @param {string} [operation] - engine method that was called.
   * @param {string} [message] - override message.
   * @param {{ details?: unknown }} [options] - missing paths and similar facts.
   */
  constructor(operation, message, options = {}) {
    super(
      'ENGINE_UNAVAILABLE',
      message ?? `docxEngine.${operation ?? 'open'} is unavailable: the Document Builder sidecar is not configured`,
      options,
    )
    this.name = 'EngineUnavailableError'
    this.operation = operation
  }
}

export const ENGINE_CODES = Object.freeze({
  UNAVAILABLE: 'ENGINE_UNAVAILABLE',
  START_FAILED: 'ENGINE_START_FAILED',
  CRASHED: 'ENGINE_CRASHED',
  DISPOSED: 'ENGINE_DISPOSED',
  TIMEOUT: 'ENGINE_TIMEOUT',
  CANCELLED: 'ENGINE_CANCELLED',
  PROTOCOL: 'ENGINE_PROTOCOL',
  SESSION_NOT_FOUND: 'ENGINE_SESSION_NOT_FOUND',
  SESSION_LOST: 'ENGINE_SESSION_LOST',
  INVALID_OP: 'ENGINE_INVALID_OP',
  STALE_TARGET: 'ENGINE_STALE_TARGET',
  SAVE_FAILED: 'ENGINE_SAVE_FAILED',
})
