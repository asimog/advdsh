/**
 * Described-block and markup-view helpers.
 *
 * The engine describes live text plus optional runs, deleted text, table rows
 * and opaque constructs. The markup view is the read-only schema the model and
 * the inspector share; it uses the same live-text rule as search and merge.
 */

/** @param {unknown} value - candidate text. @returns {string} text without a CRLF artifact. */
function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '').replace(/\n$/, '') : ''
}

/** @param {unknown} value - candidate props. @returns {object} object props. */
function propsOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}
}

/**
 * Live text of a described block: non-deleted runs in order, or the block text.
 * @param {{ text?: string, runs?: Array<object> }} block - described block.
 * @returns {string} live text without the paragraph end mark.
 */
export function liveText(block) {
  if (Array.isArray(block && block.runs)) {
    return cleanText(block.runs
      .filter((run) => run && run.deleted !== true && run.kind !== 'opaque')
      .map((run) => (typeof run.text === 'string' ? run.text : ''))
      .join(''))
  }
  return cleanText(block && block.text)
}

/** @param {object} run - described run. @param {number} index - fallback run index. */
function normalizeRun(run, index) {
  if (run && run.kind === 'opaque') {
    return { kind: 'opaque', runIndex: Number.isInteger(run.runIndex) ? run.runIndex : index, type: String(run.type ?? 'unknown') }
  }
  return {
    kind: 'run',
    runIndex: Number.isInteger(run && run.runIndex) ? run.runIndex : index,
    text: typeof run?.text === 'string' ? run.text : '',
    props: propsOf(run?.props),
    inserted: run?.inserted === true,
    deleted: run?.deleted === true,
    author: run?.author ?? null,
  }
}

/** @param {object} block - described block. @param {string} defaultAlign - paragraph align default. */
function paragraphNode(block, defaultAlign) {
  const props = propsOf(block.props)
  if (props.align === undefined) props.align = defaultAlign
  return {
    kind: 'paragraph',
    id: block.id,
    index: block.index,
    text: liveText(block),
    props,
    runs: Array.isArray(block.runs) ? block.runs.map((run, index) => normalizeRun(run, index)) : [],
  }
}

/** @param {object} block - described table. */
function tableNode(block) {
  const rows = Array.isArray(block.tableRows)
    ? block.tableRows.map((cells) => ({
      cells: (Array.isArray(cells) ? cells : []).map((text) => ({ text: cleanText(text), paragraphs: [] })),
    }))
    : []
  return { kind: 'table', id: block.id, index: block.index, rows }
}

/** @param {object} block - unknown described block. */
function opaqueNode(block) {
  return { kind: 'opaque', id: block.id, index: block.index, type: String(block.type ?? block.kind ?? 'unknown') }
}

/** @param {object} section - described section. @param {number} index - fallback index. */
function sectionNode(section, index) {
  return { kind: 'section', index: Number.isInteger(section.index) ? section.index : index, props: propsOf(section.props) }
}

/** @param {object} node - markup node. @returns {number} approximate tokens. */
function nodeTokens(node) {
  try {
    return Math.max(1, Math.ceil(JSON.stringify(node).length / 4))
  } catch (error) {
    return 1
  }
}

/**
 * How many markup nodes one node stands for: a paragraph and each of its runs, a
 * table and each of its cells and their paragraphs and runs, one for the rest.
 * @param {object} node - markup node.
 * @returns {number} node count.
 */
function nestedNodeCount(node) {
  if (node.kind === 'paragraph') return 1 + (Array.isArray(node.runs) ? node.runs.length : 0)
  if (node.kind === 'table') {
    let count = 1
    for (const row of Array.isArray(node.rows) ? node.rows : []) {
      for (const cell of Array.isArray(row.cells) ? row.cells : []) {
        count += 1
        for (const paragraph of Array.isArray(cell.paragraphs) ? cell.paragraphs : []) count += nestedNodeCount(paragraph)
      }
    }
    return count
  }
  return 1
}

/**
 * Build the markup view for one described document.
 * @param {{ blocks?: Array<object>, sections?: Array<object> }} description - engine description.
 * @param {{ from?: number, to?: number, limitNodes?: number, limitTokens?: number }} [options] - range and limits.
 * @returns {{ schema: 1, nodes: object[], truncated: boolean, next: number | null }} view.
 */
export function buildMarkupView(description, options = {}) {
  const blocks = Array.isArray(description?.blocks) ? description.blocks : []
  const sections = Array.isArray(description?.sections) ? description.sections : []
  const limitNodes = Number.isInteger(options.limitNodes) && options.limitNodes > 0 ? options.limitNodes : 400
  const limitTokens = Number.isInteger(options.limitTokens) && options.limitTokens > 0 ? options.limitTokens : 20_000
  const from = Number.isInteger(options.from) ? Math.max(0, options.from) : 0
  const to = Number.isInteger(options.to) ? options.to : Number.MAX_SAFE_INTEGER
  const candidates = []
  for (const block of blocks) {
    if (!Number.isInteger(block.index) || block.index < from || block.index > to) continue
    if (block.kind === 'paragraph') candidates.push(paragraphNode(block, 'left'))
    else if (block.kind === 'table') candidates.push(tableNode(block))
    else candidates.push(opaqueNode(block))
  }
  for (const [index, section] of sections.entries()) candidates.push(sectionNode(section, index))

  const nodes = []
  let tokens = 0
  let used = 0
  let next = null
  for (const node of candidates) {
    const cost = nodeTokens(node)
    const count = nestedNodeCount(node)
    if (used + count > limitNodes || tokens + cost > limitTokens) {
      next = Number.isInteger(node.index) ? node.index : nodes.length
      break
    }
    nodes.push(node)
    used += count
    tokens += cost
  }
  return { schema: 1, nodes, truncated: next !== null, next }
}
