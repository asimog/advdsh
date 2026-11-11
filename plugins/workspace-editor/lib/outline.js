/** Heading outline shared by the engine and the model. @param {object[]} blocks - described blocks. @returns {object[]} outline entries. */
export function outlineOf(blocks) {
  const outline = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block.kind !== 'paragraph') continue
    const style = typeof block.style === 'string' ? block.style : ''
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
