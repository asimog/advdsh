/**
 * Applier-role registry for fan-out children.
 *
 * A child that owns an `apply` task is the only caller allowed to edit the fork,
 * and only inside the block chunk of that task. The registry is a service owned
 * by the tools row; fan-out registers a child when its activation starts and
 * removes it when the activation is disposed.
 */

/**
 * @returns {{
 *   registerApplier(sessionId: string, facts: { blockIds?: string[], changeIds?: string[] }): void,
 *   removeApplier(sessionId: string): void,
 *   isEnforced(): boolean,
 *   isApplier(sessionId: string): boolean,
 *   chunk(sessionId: string): Set<string> | undefined,
 *   changes(sessionId: string): Set<string> | undefined,
 *   clear(): void,
 * }} registry
 */
export function createRoleRegistry() {
  /** @type {Map<string, { blockIds: Set<string>, changeIds: Set<string> }>} */
  const appliers = new Map()
  let enforced = false
  return {
    registerApplier(sessionId, facts = {}) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      enforced = true
      appliers.set(sessionId, {
        blockIds: new Set(Array.isArray(facts.blockIds) ? facts.blockIds.filter((id) => typeof id === 'string') : []),
        changeIds: new Set(Array.isArray(facts.changeIds) ? facts.changeIds.filter((id) => typeof id === 'string') : []),
      })
    },
    removeApplier(sessionId) {
      appliers.delete(sessionId)
    },
    isEnforced() {
      return enforced
    },
    isApplier(sessionId) {
      return appliers.has(sessionId)
    },
    chunk(sessionId) {
      return appliers.get(sessionId)?.blockIds
    },
    changes(sessionId) {
      return appliers.get(sessionId)?.changeIds
    },
    clear() {
      appliers.clear()
      enforced = false
    },
  }
}
