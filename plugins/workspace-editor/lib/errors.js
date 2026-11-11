/**
 * One error vocabulary for the workspace document tools.
 *
 * The specification fixes the wire forms: a tool failure is
 * `Error: <CODE>: <message>`, and a route failure is
 * `{ "error": "<message>", "code": "<CODE>" }`. This module owns the code list,
 * the route statuses, the sidecar-to-engine map and the engine-to-tool map so a
 * new mapping cannot be added in two places.
 */

/** Public failure codes from the specification. */
export const ERROR_CODES = Object.freeze({
  STALE_BASE: 'DOC_STALE_BASE',
  EDITOR_DIRTY: 'DOC_EDITOR_DIRTY',
  BASE_REQUIRED: 'DOC_BASE_REQUIRED',
  OUTSIDE_WORKSPACE: 'DOC_OUTSIDE_WORKSPACE',
  TARGET_EXISTS: 'DOC_TARGET_EXISTS',
  INVALID_TARGET: 'DOC_INVALID_TARGET',
  INVALID_ARGS: 'DOC_INVALID_ARGS',
  SESSION_NOT_FOUND: 'DOC_SESSION_NOT_FOUND',
  TARGET_NOT_FOUND: 'DOC_TARGET_NOT_FOUND',
  AMBIGUOUS_TARGET: 'DOC_AMBIGUOUS_TARGET',
  STALE_TARGET: 'DOC_STALE_TARGET',
  INVALID_OP: 'DOC_INVALID_OP',
  UNSUPPORTED_EDIT: 'DOC_UNSUPPORTED_EDIT',
  TOO_LARGE: 'DOC_TOO_LARGE',
  WRITE_DISABLED: 'DOC_WRITE_DISABLED',
  FORKED_COMMIT: 'DOC_FORKED_COMMIT',
  UNDO_UNAVAILABLE: 'DOC_UNDO_UNAVAILABLE',
  COMMIT_FAILED: 'DOC_COMMIT_FAILED',
  EDITOR_NOT_OPEN: 'DOC_EDITOR_NOT_OPEN',
  REVIEW_NOT_AUTHORIZED: 'DOC_REVIEW_NOT_AUTHORIZED',
  FANOUT_DEPTH: 'DOC_FANOUT_DEPTH',
  APPLIER_ONLY: 'DOC_APPLIER_ONLY',
  OUTSIDE_CHUNK: 'DOC_OUTSIDE_CHUNK',
  REVIEW_REQUIRED: 'DOC_REVIEW_REQUIRED',
  ENGINE_TIMEOUT: 'DOC_ENGINE_TIMEOUT',
  ENGINE_UNAVAILABLE: 'DOC_ENGINE_UNAVAILABLE',
  CLOSED: 'DOC_CLOSED',
  ABORTED: 'ABORTED',
})

/** HTTP status for route failures. Unknown codes still answer 400 or 500. */
export const ERROR_STATUS = Object.freeze({
  DOC_STALE_BASE: 409,
  DOC_EDITOR_DIRTY: 409,
  DOC_BASE_REQUIRED: 400,
  DOC_OUTSIDE_WORKSPACE: 403,
  DOC_TARGET_EXISTS: 409,
  DOC_INVALID_TARGET: 400,
  DOC_INVALID_ARGS: 400,
  DOC_SESSION_NOT_FOUND: 404,
  DOC_ENGINE_UNAVAILABLE: 503,
  DOC_ENGINE_TIMEOUT: 504,
})

/** One public failure with a stable code and optional details. */
export class WorkspaceError extends Error {
  /**
   * @param {string} code - one of `ERROR_CODES`.
   * @param {string} message - operator-facing message without the code prefix.
   * @param {{ details?: unknown, cause?: unknown }} [options] - extra facts.
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
    if (options.details !== undefined) this.details = options.details
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/** Sidecar code to engine code. One row per public mapping. */
const SIDECAR_TO_ENGINE = Object.freeze({
  TARGET_NOT_FOUND: 'ENGINE_TARGET_NOT_FOUND',
  AMBIGUOUS_TARGET: 'ENGINE_AMBIGUOUS_TARGET',
  STALE_TARGET: 'ENGINE_STALE_TARGET',
  WRONG_KIND: 'ENGINE_INVALID_OP',
  BAD_OP: 'ENGINE_INVALID_OP',
  UNKNOWN_OP: 'ENGINE_INVALID_OP',
  UNSUPPORTED: 'ENGINE_UNSUPPORTED',
  TIMEOUT: 'ENGINE_TIMEOUT',
  CANCELLED: 'ENGINE_CANCELLED',
  SAVE_FAILED: 'ENGINE_SAVE_FAILED',
  SESSION_NOT_FOUND: 'ENGINE_SESSION_NOT_FOUND',
  SESSION_LOST: 'ENGINE_SESSION_LOST',
})

/** Engine code to tool code. One row per public mapping. */
const ENGINE_TO_TOOL = Object.freeze({
  ENGINE_TARGET_NOT_FOUND: 'DOC_TARGET_NOT_FOUND',
  ENGINE_AMBIGUOUS_TARGET: 'DOC_AMBIGUOUS_TARGET',
  ENGINE_STALE_TARGET: 'DOC_STALE_TARGET',
  ENGINE_INVALID_OP: 'DOC_INVALID_OP',
  ENGINE_UNSUPPORTED: 'DOC_UNSUPPORTED_EDIT',
  ENGINE_TIMEOUT: 'DOC_ENGINE_TIMEOUT',
  ENGINE_CANCELLED: 'ABORTED',
  ENGINE_CRASHED: 'DOC_ENGINE_UNAVAILABLE',
  ENGINE_START_FAILED: 'DOC_ENGINE_UNAVAILABLE',
  ENGINE_UNAVAILABLE: 'DOC_ENGINE_UNAVAILABLE',
  ENGINE_DISPOSED: 'DOC_ENGINE_UNAVAILABLE',
  ENGINE_SESSION_LOST: 'DOC_CLOSED',
  ENGINE_SESSION_NOT_FOUND: 'DOC_CLOSED',
  ENGINE_SAVE_FAILED: 'DOC_COMMIT_FAILED',
  ENGINE_PROTOCOL: 'DOC_INVALID_OP',
})

/** @param {unknown} value - candidate failure. @returns {string | undefined} stable code. */
export function codeOf(value) {
  return value && typeof value === 'object' && typeof value.code === 'string' && value.code !== ''
    ? value.code
    : undefined
}

/** @param {unknown} value - candidate failure. @returns {string} operator message. */
export function messageOf(value) {
  if (value instanceof Error) return value.message
  if (value && typeof value === 'object' && typeof value.message === 'string') return value.message
  return String(value)
}

/** @param {string} code - sidecar code. @returns {string} engine code. */
export function engineCodeForSidecar(code) {
  return SIDECAR_TO_ENGINE[code] ?? 'ENGINE_PROTOCOL'
}

/** @param {string} code - engine code. @returns {string} tool code. */
export function toolCodeForEngine(code) {
  return ENGINE_TO_TOOL[code] ?? 'DOC_INVALID_OP'
}

/** @param {string} code - public or engine code. @param {number} [fallback] - default status. */
export function statusFor(code, fallback = 400) {
  return ERROR_STATUS[code] ?? fallback
}

/** Strip a leading `<CODE>: ` so formatting is idempotent. @param {string} code - prefix. @param {string} message - text. */
function withoutPrefix(code, message) {
  const prefix = `${code}: `
  return message.startsWith(prefix) ? message.slice(prefix.length) : message
}

/**
 * Build the tool failure the DSH executor renders as `Error: <CODE>: <message>`.
 * @param {unknown} value - thrown value with an optional `code`.
 * @param {string} [fallback] - code for an uncoded failure.
 * @returns {Error & { code: string, cause?: unknown }} formatted failure.
 */
export function formatToolError(value, fallback = ERROR_CODES.INVALID_ARGS) {
  const code = codeOf(value) ?? fallback
  const message = withoutPrefix(code, messageOf(value))
  const error = new Error(`${code}: ${message}`)
  error.code = code
  if (value !== undefined) error.cause = value
  return error
}

/**
 * Build the route body. A route must never include the code inside `error`.
 * @param {unknown} value - thrown value with an optional `code`.
 * @returns {{ error: string, code: string }} route body.
 */
export function routeErrorBody(value) {
  const code = codeOf(value) ?? ERROR_CODES.INVALID_ARGS
  return { error: withoutPrefix(code, messageOf(value)), code }
}
