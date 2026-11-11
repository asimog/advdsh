/**
 * DSH session facts and document-path confinement.
 *
 * A tool call belongs to `exec.agent.session.header`; a route request names its
 * session in `?session=`. A document path is allowed only inside that session's
 * working directory plus the configured `allowedRoots`, after both the file and
 * the roots are resolved through links. These helpers own that decision so the
 * model, the store and the routes cannot grow different checks.
 */
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { ERROR_CODES, WorkspaceError } from './errors.js'

/** @param {string} candidate - absolute path. @returns {string} comparison form. */
function comparable(candidate) {
  const resolved = path.resolve(candidate)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** @param {string} root - allowed root. @param {string} target - real target. @returns {boolean} inside. */
function isInside(root, target) {
  const relative = path.relative(comparable(root), comparable(target))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Read the fields the tool facts and prompt context expose.
 * @param {unknown} value - tool `exec`, assembly context, or a session header.
 * @returns {{ id?: string, cwd?: string, delegationDepth?: number }} facts.
 */
export function sessionFacts(value) {
  try {
    const agent = value && typeof value === 'object' ? value.agent : undefined
    const session = agent && typeof agent === 'object' ? agent.session : undefined
    const header = session && typeof session === 'object' && session.header !== undefined
      ? session.header
      : (session ?? value)
    if (header === undefined || header === null || typeof header !== 'object') return {}
    const facts = {}
    if (typeof header.id === 'string' && header.id !== '') facts.id = header.id
    if (typeof header.cwd === 'string' && header.cwd !== '') facts.cwd = header.cwd
    if (Number.isInteger(header.delegationDepth)) facts.delegationDepth = header.delegationDepth
    return facts
  } catch (error) {
    return {}
  }
}

/** @param {unknown} value - tool exec or assembly context. @returns {string | undefined} DSH session ID. */
export function sessionIdOf(value) {
  return sessionFacts(value).id
}

/** @param {unknown} value - tool exec or assembly context. @returns {string | undefined} DSH session cwd. */
export function cwdOf(value) {
  return sessionFacts(value).cwd
}

/**
 * Read the `session` query parameter of a route request.
 * @param {{ url?: string } | undefined} request - HTTP request.
 * @returns {string | undefined} DSH session ID, or undefined when absent.
 */
export function sessionIdFromRequest(request) {
  if (request === undefined || typeof request.url !== 'string') return undefined
  try {
    const value = new URL(request.url, 'http://127.0.0.1').searchParams.get('session')
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch (error) {
    return undefined
  }
}

/** @param {unknown} value - candidate. @returns {string} non-empty string or a stable error. */
function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkspaceError(ERROR_CODES.INVALID_ARGS, `${name} must be a non-empty string`)
  }
  return value
}

/**
 * The allowed roots of one session: its workspace root plus the configured list.
 * @param {string} cwd - session workspace root.
 * @param {readonly string[]} [extra] - configured `allowedRoots`.
 * @returns {string[]} unique absolute roots, workspace first.
 */
export function allowedRoots(cwd, extra = []) {
  const roots = []
  const seen = new Set()
  for (const root of [requireString(cwd, 'cwd'), ...(Array.isArray(extra) ? extra : [])]) {
    if (typeof root !== 'string' || root.trim() === '') continue
    const resolved = path.resolve(root)
    const key = comparable(resolved)
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(resolved)
  }
  return roots
}

/** Resolve the nearest existing ancestor and append the missing tail. @param {string} target - absolute target. */
async function realTarget(target) {
  try {
    return await realpath(target)
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error
  }
  const tail = []
  let current = target
  while (true) {
    const parent = path.dirname(current)
    if (parent === current) return target
    tail.unshift(path.basename(current))
    current = parent
    try {
      const realParent = await realpath(current)
      return path.join(realParent, ...tail)
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error
    }
  }
}

/**
 * Resolve one document path and prove it is inside an allowed root.
 * @param {string} candidate - absolute or cwd-relative path.
 * @param {{ cwd: string, roots?: readonly string[] }} options - session facts.
 * @returns {Promise<string>} the resolved target path.
 */
export async function resolveDocumentPath(candidate, options) {
  const file = requireString(candidate, 'path')
  const cwd = requireString(options && options.cwd, 'cwd')
  const target = path.resolve(cwd, file)
  const real = await realTarget(target)
  const roots = []
  for (const root of allowedRoots(cwd, options.roots ?? [])) {
    roots.push(await realTarget(root))
  }
  if (!roots.some((root) => isInside(root, real))) {
    throw new WorkspaceError(ERROR_CODES.OUTSIDE_WORKSPACE, `path is outside the workspace: ${target}`, {
      details: { path: target, roots },
    })
  }
  return real
}

/**
 * The synchronous form for a path that already exists and is already absolute;
 * callers that can await should use `resolveDocumentPath` so links are resolved.
 * @param {string} candidate - path.
 * @param {{ cwd: string, roots?: readonly string[] }} options - session facts.
 * @returns {string} normalized target.
 */
export function resolveDocumentPathSync(candidate, options) {
  const file = requireString(candidate, 'path')
  const cwd = requireString(options && options.cwd, 'cwd')
  const target = path.resolve(cwd, file)
  const roots = allowedRoots(cwd, options.roots ?? [])
  if (!roots.some((root) => isInside(root, target))) {
    throw new WorkspaceError(ERROR_CODES.OUTSIDE_WORKSPACE, `path is outside the workspace: ${target}`, {
      details: { path: target, roots },
    })
  }
  return target
}
