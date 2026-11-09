/**
 * Base-vs-working block diff for `ctx.docxEngine.diff`.
 *
 * Base blocks come from the description captured at open; working blocks come
 * from the live builder state. Blocks are matched by the session-stable ID the
 * builder host reports, then compared by text/table-row signature. Pure and
 * synchronous so a unit test can cover it without an engine.
 */

/**
 * @param {Array<{ id: string, kind?: string, text?: string, rows?: number|null, style?: string|null }>} baseBlocks
 * @param {Array<{ id: string, kind?: string, text?: string, rows?: number|null, style?: string|null }>} currentBlocks
 * @returns {{ changes: object[], counts: { added: number, removed: number, changed: number, total: number }, changed: boolean }}
 */
export function diffBlocks(baseBlocks, currentBlocks) {
  const base = Array.isArray(baseBlocks) ? baseBlocks : []
  const current = Array.isArray(currentBlocks) ? currentBlocks : []
  const baseById = new Map()
  for (const block of base) {
    if (block && typeof block.id === 'string') baseById.set(block.id, block)
  }
  const currentById = new Map()
  for (const block of current) {
    if (block && typeof block.id === 'string') currentById.set(block.id, block)
  }

  const changes = []
  for (const block of current) {
    const prior = block && typeof block.id === 'string' ? baseById.get(block.id) : undefined
    if (prior === undefined) {
      changes.push({ type: 'added', id: block.id, kind: block.kind, index: block.index, after: block })
      continue
    }
    if (signature(prior) !== signature(block)) {
      changes.push({ type: 'changed', id: block.id, kind: block.kind, index: block.index, before: prior, after: block })
    }
  }
  for (const block of base) {
    if (!block || typeof block.id !== 'string') continue
    if (!currentById.has(block.id)) changes.push({ type: 'removed', id: block.id, kind: block.kind, index: block.index, before: block })
  }
  changes.sort((left, right) => (left.index ?? 0) - (right.index ?? 0))

  const counts = { added: 0, removed: 0, changed: 0, total: changes.length }
  for (const change of changes) counts[change.type] += 1
  return { changes, counts, changed: changes.length > 0 }
}

/**
 * What makes two descriptions of one block different.
 * @param {{ kind?: string, text?: string, rows?: number|null, style?: string|null }} block - one described block.
 * @returns {string} comparison signature.
 */
function signature(block) {
  return [
    block.kind ?? '',
    block.text ?? '',
    block.rows === undefined || block.rows === null ? '' : String(block.rows),
    block.style ?? '',
  ].join('\u0000')
}
