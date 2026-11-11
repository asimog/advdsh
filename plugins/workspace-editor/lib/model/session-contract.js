/**
 * Model-session contract: one record per owner and file, the immutable open
 * facts, the pending op log, the diff-seen marker and commit eligibility.
 * The model keeps the live record; this module owns the public shape so tools,
 * tests and the runtime context read the same fields.
 */
import { ERROR_CODES } from '../errors.js'

/**
 * The commit decision for one session.
 * @param {object} session - model session.
 * @param {{ force?: boolean }} [options] - explicit force.
 * @returns {{ eligible: boolean, code: string | null, reason: string }} decision.
 */
export function commitEligibility(session, options = {}) {
  if (session.fork !== undefined) return { eligible: false, code: ERROR_CODES.FORKED_COMMIT, reason: 'fork' }
  if (session.stale === true) return { eligible: false, code: ERROR_CODES.STALE_BASE, reason: 'stale' }
  const pending = Array.isArray(session.opLog) ? session.opLog.length : 0
  const seen = Number.isInteger(session.diffSeenOps) ? session.diffSeenOps : 0
  if (pending > 0 && seen < pending && options.force !== true) {
    return { eligible: false, code: ERROR_CODES.REVIEW_REQUIRED, reason: 'diff-not-seen' }
  }
  if (pending === 0 && options.force !== true) return { eligible: false, code: null, reason: 'no-changes' }
  return { eligible: true, code: null, reason: 'ready' }
}

/**
 * Mark every pending op as seen by a `doc_diff` read.
 * @param {object} session - model session.
 * @param {number} [at] - clock for the marker.
 */
export function markDiffSeen(session, at = Date.now()) {
  session.diffSeenOps = Array.isArray(session.opLog) ? session.opLog.length : 0
  session.diffSeenAt = new Date(at).toISOString()
}

/**
 * Invalidate the diff marker after an op log change.
 * @param {object} session - model session.
 */
export function noteDiffInvalidated(session) {
  const pending = Array.isArray(session.opLog) ? session.opLog.length : 0
  const seen = Number.isInteger(session.diffSeenOps) ? session.diffSeenOps : 0
  session.diffSeenOps = Math.min(seen, pending)
}

/**
 * Public shape of one model session.
 * @param {object} session - model session.
 * @param {{ revision?: string, editorDirty?: boolean, conflict?: string | null }} [lease] - file lease.
 * @returns {object} contract fields.
 */
export function sessionContract(session, lease) {
  const pending = Array.isArray(session.opLog) ? session.opLog.length : 0
  const seen = Number.isInteger(session.diffSeenOps) ? session.diffSeenOps : 0
  const decision = commitEligibility(session)
  return {
    handle: session.handle,
    ownerSessionId: typeof session.ownerSessionId === 'string' ? session.ownerSessionId : '',
    path: session.path,
    name: session.name,
    contentHash: session.contentHash,
    baseRevision: session.baseRevision,
    storeRevision: typeof lease?.revision === 'string' ? lease.revision : session.baseRevision,
    openBlocks: Number.isInteger(session.blocksAtOpen) ? session.blocksAtOpen : undefined,
    pendingOps: pending,
    taskLabel: typeof session.taskLabel === 'string' ? session.taskLabel : null,
    forkParent: session.fork && typeof session.fork.parent === 'string' ? session.fork.parent : null,
    diffSeenOps: seen,
    diffPending: Math.max(0, pending - seen),
    editorDirty: lease?.editorDirty === true,
    conflict: lease?.conflict ?? null,
    stale: session.stale === true,
    commitEligible: decision.eligible,
    commitReason: decision.reason,
  }
}

/**
 * One op-log entry in the public shape.
 * @param {object} entry - live op entry.
 * @returns {object} public entry.
 */
export function operationContract(entry) {
  return {
    seq: entry.seq,
    type: entry.type,
    task: typeof entry.task === 'string' ? entry.task : null,
    tracked: entry.tracked === true,
    affected: Array.isArray(entry.affected)
      ? entry.affected.map((item) => ({
        id: item.id,
        index: item.index,
        kind: item.kind,
        textBefore: item.textBefore ?? null,
        textAfter: item.textAfter ?? null,
      }))
      : [],
  }
}
