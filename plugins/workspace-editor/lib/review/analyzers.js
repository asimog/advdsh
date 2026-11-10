/**
 * Legal document analyzers for `ctx.docxModel.check` and `doc_analyze`.
 *
 * Pure functions over described blocks: no engine, no filesystem. Every finding
 * carries a stable `code`, a severity, a message and the affected block ids, so
 * a tool result can be compared, filtered and tested. Analyzers are conservative
 * on purpose: legal documents have long all-caps headings and many external
 * citations, so checks only report patterns they can prove from the text.
 */

/** Stable finding codes; `doc_analyze` returns the subset it finds. */
export const ANALYZER_CODES = Object.freeze({
  HEADING_LEVEL_SKIP: 'HEADING_LEVEL_SKIP',
  HEADING_EMPTY: 'HEADING_EMPTY',
  HEADING_DUPLICATE: 'HEADING_DUPLICATE',
  TOC_MISMATCH: 'TOC_MISMATCH',
  LIST_LEVEL_JUMP: 'LIST_LEVEL_JUMP',
  DEFINED_TERM_ORDER: 'DEFINED_TERM_ORDER',
  UNDEFINED_ABBREVIATION: 'UNDEFINED_ABBREVIATION',
  CROSS_REFERENCE_MISSING: 'CROSS_REFERENCE_MISSING',
  CITATION_SHAPE: 'CITATION_SHAPE',
  PLACEHOLDER_TEXT: 'PLACEHOLDER_TEXT',
  EMPTY_PARAGRAPH_RUN: 'EMPTY_PARAGRAPH_RUN',
  TABLE_HEADER_MISSING: 'TABLE_HEADER_MISSING',
})

/** Words that look like abbreviations but are ordinary all-caps prose or citation markers. */
const ABBREVIATION_STOPLIST = new Set([
  'THE', 'AND', 'FOR', 'ARE', 'BUT', 'NOT', 'ALL', 'ANY', 'HAS', 'WAS', 'ITS', 'HIS', 'HER',
  'COURT', 'PLAINTIFF', 'DEFENDANT', 'MOTION', 'ORDER', 'UNITED', 'STATES', 'DISTRICT',
  'BEFORE', 'UPON', 'THIS', 'THAT', 'WITH', 'FROM', 'HEREBY', 'SHALL', 'WILL', 'MAY', 'MUST',
  'SCC', 'AIR', 'SCR', 'CRI', 'CRL', 'LJ', 'BOM', 'KER', 'IPC', 'CPC', 'CRPC',
])

/** @param {unknown} value - candidate block text. @returns {string} */
function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/** @param {unknown} value - candidate blocks. @returns {Array<object>} described paragraph/table blocks. */
function blocksOf(value) {
  return Array.isArray(value) ? value.filter((block) => block && typeof block === 'object') : []
}

/** @param {number|undefined} value - heading level. @returns {number|undefined} normalized level. */
function headingLevel(block) {
  if (block.kind !== 'paragraph') return undefined
  if (Number.isFinite(block.level)) return block.level
  const style = typeof block.style === 'string' ? block.style : ''
  const match = /^heading\s*([1-9])$/i.exec(style)
  return match ? Number(match[1]) - 1 : undefined
}

/** @param {unknown} checks - requested codes (Set) or undefined for all. @param {string} code - finding code. */
function wanted(checks, code) {
  return checks === undefined || !(checks instanceof Set) || checks.has(code)
}

/** @param {Array<object>} findings - raw findings. @param {unknown} checks - requested codes. @returns {Array<object>} */
function select(findings, checks) {
  return findings.filter((finding) => wanted(checks, finding.code))
}

/** Normalize heading/citation text for comparisons. */
function normalize(value) {
  return textOf(value).replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Heading outline: level skips, empty headings and duplicate heading text.
 * @param {{ blocks: object[], checks?: Set<string> }} input - analysis input.
 * @returns {object[]} findings.
 */
function headingOutline({ blocks, checks }) {
  const findings = []
  let previous = null
  const seen = new Map()
  for (const block of blocksOf(blocks)) {
    const level = headingLevel(block)
    if (level === undefined) continue
    const text = textOf(block.text)
    if (text.trim() === '' && wanted(checks, ANALYZER_CODES.HEADING_EMPTY)) {
      findings.push({ code: ANALYZER_CODES.HEADING_EMPTY, severity: 'warning', message: 'heading has no text', blocks: [block.id] })
    } else if (text.trim() !== '') {
      const key = normalize(text)
      if (seen.has(key) && wanted(checks, ANALYZER_CODES.HEADING_DUPLICATE)) {
        findings.push({
          code: ANALYZER_CODES.HEADING_DUPLICATE,
          severity: 'info',
          message: `duplicate heading: ${text.trim().slice(0, 80)}`,
          blocks: [seen.get(key), block.id],
        })
      } else if (!seen.has(key)) {
        seen.set(key, block.id)
      }
    }
    if (previous !== null && level > previous + 1 && wanted(checks, ANALYZER_CODES.HEADING_LEVEL_SKIP)) {
      findings.push({
        code: ANALYZER_CODES.HEADING_LEVEL_SKIP,
        severity: 'warning',
        message: `heading level jumps from ${previous + 1} to ${level + 1}`,
        blocks: [block.id],
      })
    }
    if (level !== undefined) previous = level
  }
  return select(findings, checks)
}

/**
 * Table-of-contents entries that do not match any heading in the document.
 * @param {{ blocks: object[], checks?: Set<string> }} input - analysis input.
 * @returns {object[]} findings.
 */
function tocMismatch({ blocks, checks }) {
  const findings = []
  const described = blocksOf(blocks)
  const headings = new Set(described.filter((block) => headingLevel(block) !== undefined).map((block) => normalize(block.text)))
  let inToc = false
  for (const block of described) {
    const text = textOf(block.text)
    if (block.kind === 'paragraph' && /^table of contents$/i.test(text.trim())) {
      inToc = true
      continue
    }
    if (!inToc) continue
    const style = typeof block.style === 'string' ? block.style : ''
    const tocStyle = /^toc/i.test(style)
    const tocLike = /(\.{3,}|\t)\s*[ivxlcdm\d]+\s*$/i.test(text) || tocStyle
    if (!tocLike) {
      inToc = false
      continue
    }
    const entry = text.replace(/(\.{3,}|\t).*$/s, '').replace(/\s+/g, ' ').trim()
    if (entry === '') continue
    if (!headings.has(normalize(entry)) && wanted(checks, ANALYZER_CODES.TOC_MISMATCH)) {
      findings.push({
        code: ANALYZER_CODES.TOC_MISMATCH,
        severity: 'info',
        message: `table-of-contents entry has no matching heading: ${entry.slice(0, 80)}`,
        blocks: [block.id],
      })
    }
  }
  return select(findings, checks)
}

/**
 * Numbered list levels that jump more than one level between items.
 * @param {{ blocks: object[], checks?: Set<string> }} input - analysis input.
 * @returns {object[]} findings.
 */
function listLevels({ blocks, checks }) {
  const findings = []
  let previous = null
  for (const block of blocksOf(blocks)) {
    const numbering = block.numbering
    if (block.kind !== 'paragraph' || !numbering || !Number.isFinite(numbering.level)) {
      previous = null
      continue
    }
    if (previous !== null && numbering.level > previous + 1 && wanted(checks, ANALYZER_CODES.LIST_LEVEL_JUMP)) {
      findings.push({
        code: ANALYZER_CODES.LIST_LEVEL_JUMP,
        severity: 'info',
        message: `list level jumps from ${previous + 1} to ${numbering.level + 1}`,
        blocks: [block.id],
      })
    }
    previous = numbering.level
  }
  return select(findings, checks)
}

/** Find quoted terms that look like definitions. */
function definedTerms({ blocks, checks }) {
  const findings = []
  const described = blocksOf(blocks)
  const definitionPattern = /(?:hereinafter|means|\(the\s+["“]|\(["“])/i
  const quoted = /["“]([A-Z][^"”]{1,60})["”]/g
  const definitions = new Map()
  described.forEach((block, index) => {
    const text = textOf(block.text)
    if (!definitionPattern.test(text)) return
    for (const match of text.matchAll(quoted)) {
      const term = match[1].trim()
      if (term !== '' && !definitions.has(term.toLowerCase())) definitions.set(term.toLowerCase(), { id: block.id, index, text })
    }
  })
  if (definitions.size === 0) return findings
  described.forEach((block, index) => {
    const text = textOf(block.text)
    for (const match of text.matchAll(quoted)) {
      const term = match[1].trim().toLowerCase()
      const definition = definitions.get(term)
      if (definition === undefined || index >= definition.index) continue
      if (!wanted(checks, ANALYZER_CODES.DEFINED_TERM_ORDER)) continue
      findings.push({
        code: ANALYZER_CODES.DEFINED_TERM_ORDER,
        severity: 'info',
        message: `term used before its definition: ${match[1].trim().slice(0, 60)}`,
        blocks: [block.id, definition.id],
      })
      definitions.delete(term)
    }
  })
  return select(findings, checks)
}

/**
 * Abbreviations whose first use is not introduced in parentheses.
 * @param {{ blocks: object[], checks?: Set<string> }} input - analysis input.
 * @returns {object[]} findings.
 */
function abbreviations({ blocks, checks, knownAbbreviations }) {
  const findings = []
  const described = blocksOf(blocks)
  const firstUse = new Map()
  for (const [index, block] of described.entries()) {
    if (headingLevel(block) !== undefined) continue
    const text = textOf(block.text)
    if (isMostlyUppercase(text)) continue
    for (const match of text.matchAll(/\b[A-Z][A-Z0-9]{1,5}\b/g)) {
      const token = match[0]
      if (ABBREVIATION_STOPLIST.has(token)) continue
      if (knownAbbreviations.has(token)) continue
      const start = match.index ?? 0
      const before = text.slice(Math.max(0, start - 2), start)
      const after = text.slice(start + token.length, start + token.length + 2)
      const introduced = before === '("' || before === '“' || /\(\s*["“]?$/.test(text.slice(Math.max(0, start - 4), start))
        || after === '")' || after === '”'
      if (introduced) continue
      if (!firstUse.has(token)) firstUse.set(token, { block, index, introduced })
    }
  }
  for (const [token, use] of firstUse) {
    if (!wanted(checks, ANALYZER_CODES.UNDEFINED_ABBREVIATION)) continue
    findings.push({
      code: ANALYZER_CODES.UNDEFINED_ABBREVIATION,
      severity: 'info',
      message: `abbreviation used without an introduction: ${token}`,
      blocks: [use.block.id],
    })
  }
  return select(findings, checks)
}

/**
 * Whether a block is written in all caps (headings, party names, court titles),
 * where "abbreviation" tokens are ordinary words.
 * @param {string} text - block text.
 * @returns {boolean} true when the letters are mostly uppercase.
 */
function isMostlyUppercase(text) {
  const letters = text.replace(/[^A-Za-z]/g, '')
  if (letters.length < 8) return false
  const uppercase = (letters.match(/[A-Z]/g) ?? []).length
  return uppercase / letters.length > 0.85
}

/**
 * Internal references (Exhibit/Annexure/Schedule/paragraph) with no target.
 * @param {{ blocks: object[], checks?: Set<string> }} input - analysis input.
 * @returns {object[]} findings.
 */
function crossReferences({ blocks, checks }) {
  const findings = []
  const described = blocksOf(blocks)
  const headings = new Set(described.filter((block) => headingLevel(block) !== undefined).map((block) => normalize(block.text)))
  const startsWithLabel = described.filter((block) => headingLevel(block) === undefined).map((block) => normalize(block.text))
  const patterns = [
    { regex: /\bexhibit\s+([A-Z]\b|\d+)/gi, label: 'Exhibit' },
    { regex: /\bannexure\s+([IVXLCDM]+|\d+)/gi, label: 'Annexure' },
    { regex: /\bschedule\s+([IVXLCDM]+|\d+)/gi, label: 'Schedule' },
  ]
  for (const block of described) {
    const text = textOf(block.text)
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern.regex)) {
        const label = normalize(`${pattern.label} ${match[1]}`)
        const hasTarget = headings.has(label)
          || startsWithLabel.some((candidate) => candidate !== normalize(text) && candidate.startsWith(label))
        if (hasTarget) continue
        if (!wanted(checks, ANALYZER_CODES.CROSS_REFERENCE_MISSING)) continue
        findings.push({
          code: ANALYZER_CODES.CROSS_REFERENCE_MISSING,
          severity: 'info',
          message: `reference has no target: ${pattern.label} ${match[1]}`,
          blocks: [block.id],
        })
      }
    }
  }
  return select(findings, checks)
}

/**
 * Citation shapes that do not match the configured reporter pattern.
 * @param {{ blocks: object[], checks?: Set<string>, citationPatterns?: Array<{ name: string, marker: RegExp, valid: RegExp }> }} input - analysis input.
 * @returns {object[]} findings.
 */
function citations({ blocks, checks, citationPatterns }) {
  const findings = []
  const described = blocksOf(blocks)
  for (const block of described) {
    const text = textOf(block.text)
    for (const pattern of citationPatterns) {
      const markers = (text.match(new RegExp(pattern.name, 'g')) ?? []).length
      if (markers === 0) continue
      const valid = (text.match(pattern.valid) ?? []).length
      if (valid >= markers) continue
      if (!wanted(checks, ANALYZER_CODES.CITATION_SHAPE)) continue
      findings.push({
        code: ANALYZER_CODES.CITATION_SHAPE,
        severity: 'info',
        message: `citation does not match the ${pattern.name} reporter pattern`,
        blocks: [block.id],
      })
    }
  }
  return select(findings, checks)
}

/**
 * Placeholder text left in the document.
 * @param {{ blocks: object[], checks?: Set<string> }} input - analysis input.
 * @returns {object[]} findings.
 */
function placeholders({ blocks, checks }) {
  const findings = []
  const pattern = /\b(TBD|TODO|XXX|lorem ipsum|\[insert[^\]]*\]|<<[^>]*>>|\[(?:date|name|amount)\])/i
  for (const block of blocksOf(blocks)) {
    const match = pattern.exec(textOf(block.text))
    if (match === null) continue
    if (!wanted(checks, ANALYZER_CODES.PLACEHOLDER_TEXT)) continue
    findings.push({
      code: ANALYZER_CODES.PLACEHOLDER_TEXT,
      severity: 'warning',
      message: `placeholder text: ${match[0].slice(0, 60)}`,
      blocks: [block.id],
    })
  }
  return select(findings, checks)
}

/**
 * Runs of empty paragraphs (`EMPTY_PARAGRAPH_RUN`), ignoring single spacing lines.
 * @param {{ blocks: object[], checks?: Set<string> }} input - analysis input.
 * @returns {object[]} findings.
 */
function emptyParagraphRuns({ blocks, checks }) {
  const findings = []
  let run = []
  const flush = (nextBlock) => {
    if (run.length >= 3 && wanted(checks, ANALYZER_CODES.EMPTY_PARAGRAPH_RUN)) {
      findings.push({
        code: ANALYZER_CODES.EMPTY_PARAGRAPH_RUN,
        severity: 'info',
        message: `${run.length} consecutive empty paragraphs`,
        blocks: run.map((block) => block.id),
      })
    }
    run = []
    void nextBlock
  }
  for (const block of blocksOf(blocks)) {
    if (block.kind === 'paragraph' && textOf(block.text).trim() === '') run.push(block)
    else flush(block)
  }
  flush(undefined)
  return select(findings, checks)
}

/**
 * Tables whose first row is empty (no header row).
 * @param {{ blocks: object[], checks?: Set<string> }} input - analysis input.
 * @returns {object[]} findings.
 */
function tableHeaders({ blocks, checks }) {
  const findings = []
  for (const block of blocksOf(blocks)) {
    if (block.kind !== 'table' || !Array.isArray(block.tableRows) || block.tableRows.length === 0) continue
    const header = block.tableRows[0]
    const hasText = Array.isArray(header) && header.some((cell) => textOf(cell).trim() !== '')
    if (hasText) continue
    if (!wanted(checks, ANALYZER_CODES.TABLE_HEADER_MISSING)) continue
    findings.push({
      code: ANALYZER_CODES.TABLE_HEADER_MISSING,
      severity: 'info',
      message: 'table has no header row',
      blocks: [block.id],
    })
  }
  return select(findings, checks)
}

/** Default reporter patterns: Indian Supreme Court citations. */
const DEFAULT_CITATION_PATTERNS = Object.freeze([
  { name: 'SCC', marker: /\bSCC\b/, valid: /\(\d{4}\)\s*\d+\s*SCC\s*\d+/ },
  { name: 'AIR', marker: /\bAIR\b/, valid: /AIR\s+\d{4}\s+SC\s+\d+/ },
])

/**
 * Build the analyzer set the model registers.
 * @param {{ citationPatterns?: Array<{ name: string, marker: RegExp, valid: RegExp }>, knownAbbreviations?: string[] }} [config] - analyzer config.
 * @returns {Array<(input: object) => Array<object>|Promise<Array<object>>>} analyzers for `ctx.docxModel`.
 */
export function createLegalAnalyzers(config = {}) {
  const citationPatterns = Array.isArray(config.citationPatterns) && config.citationPatterns.length > 0
    ? config.citationPatterns
    : DEFAULT_CITATION_PATTERNS
  const knownAbbreviations = new Set(config.knownAbbreviations ?? [])
  return [
    (input) => headingOutline(input),
    (input) => tocMismatch(input),
    (input) => listLevels(input),
    (input) => definedTerms(input),
    (input) => abbreviations({ ...input, knownAbbreviations }),
    (input) => crossReferences(input),
    (input) => citations({ ...input, citationPatterns }),
    (input) => placeholders(input),
    (input) => emptyParagraphRuns(input),
    (input) => tableHeaders(input),
  ]
}

/** Codes this analyzer set can produce, for `doc_analyze` docs and tool schemas. */
export const LEGAL_ANALYZER_CODES = Object.values(ANALYZER_CODES)
