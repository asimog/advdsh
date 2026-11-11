/**
 * Real DOCX fixtures for the ten documents named in the specification.
 *
 * Each fixture is a complete OOXML package: content types, package and document
 * relationships, styles, numbering, an optional image part and the document body.
 * The body is explicit so the fixture carries the exact `w14:paraId` values,
 * tracked runs, tables, drawing and paragraph count the acceptance tests expect.
 * Tests build into a temporary directory; nothing here writes into the repository.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'

export const FIXTURE_NAMES = Object.freeze([
  'F-CLEAN',
  'F-TRACKED',
  'F-NOID',
  'F-DUPID',
  'F-TABLES',
  'F-SPLIT',
  'F-BOLD',
  'F-DRAWING',
  'F-WORDS',
  'F-LARGE',
])

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml'
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture'

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/** @param {string} text - XML text. @returns {string} escaped text. */
function xml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** @param {number} value - decimal paragraph id. @returns {string} eight hex digits. */
function paraId(value) {
  return value.toString(16).toUpperCase().padStart(8, '0')
}

/** @param {string} text - run text. @param {{ bold?: boolean, italic?: boolean }} [props] - run properties. */
function run(text, props = {}) {
  const properties = props.bold === true
    ? '<w:rPr><w:b/></w:rPr>'
    : props.italic === true
      ? '<w:rPr><w:i/></w:rPr>'
      : ''
  return `<w:r>${properties}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`
}

/**
 * @param {{ paraId?: number, style?: string, runs?: string, text?: string }} spec - paragraph content.
 * @returns {string} one paragraph.
 */
function paragraph(spec) {
  const id = spec.paraId === undefined ? '' : ` w14:paraId="${paraId(spec.paraId)}"`
  const style = spec.style === undefined ? '' : `<w:pPr><w:pStyle w:val="${xml(spec.style)}"/></w:pPr>`
  const runs = spec.runs ?? run(spec.text ?? '')
  return `<w:p${id}>${style}${runs}</w:p>`
}

/** @param {number} id - revision id. @param {string} author - revision author. @returns {string} attributes. */
function revision(id, author = 'fixture') {
  return `w:id="${id}" w:author="${xml(author)}" w:date="2026-01-01T00:00:00Z"`
}

/** @param {number} id - revision id. @param {string} text - deleted text. @returns {string} tracked deletion. */
function deletedRun(id, text) {
  return `<w:del ${revision(id)}><w:r><w:delText xml:space="preserve">${xml(text)}</w:delText></w:r></w:del>`
}

/** @param {number} id - revision id. @param {string} text - inserted text. @returns {string} tracked insertion. */
function insertedRun(id, text) {
  return `<w:ins ${revision(id)}><w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:ins>`
}

/** @param {string[]} cells - cell texts. @returns {string} one table row. */
function tableRow(cells) {
  const width = 2400
  return `<w:tr>${cells.map((text) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${paragraph({ text })}</w:tc>`).join('')}</w:tr>`
}

/** @param {string[]} cells - header row cells. @returns {string} one one-row table. */
function table(cells) {
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>`
    + `<w:tblGrid>${cells.map(() => '<w:gridCol w:w="2400"/>').join('')}</w:tblGrid>`
    + `${tableRow(cells)}</w:tbl>`
}

/** @returns {string} one inline drawing with a 1x1 image. */
function drawing() {
  return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
    + '<wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Picture 1"/>'
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="pixel.png"/><pic:cNvPicPr/></pic:nvPicPr>'
    + '<pic:blipFill><a:blip r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
    + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm>'
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>'
    + '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
}

/** @param {string} body - body XML without the section properties. @returns {string} document XML. */
function documentXml(body) {
  return `${XML_HEAD}<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:w14="${W14}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}">`
    + `<w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>`
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'
}

/** @param {string} name - fixture name. @returns {{ body: string, description: object }} body and test facts. */
function bodyFor(name) {
  if (name === 'F-CLEAN') {
    const texts = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE']
    return {
      body: texts.map((text, index) => paragraph({ paraId: index + 1, text })).join(''),
      description: { liveText: texts, paraIds: [1, 2, 3, 4, 5], tables: 0, runs: [] },
    }
  }
  if (name === 'F-TRACKED') {
    return {
      body: paragraph({
        paraId: 1,
        runs: run('Paid to the ') + deletedRun(1, 'r') + insertedRun(2, 'R') + run('espondent.'),
      }),
      description: { liveText: ['Paid to the Respondent.'], deletedText: 'r', paraIds: [1], tables: 0 },
    }
  }
  if (name === 'F-NOID') {
    const texts = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE']
    return {
      body: texts.map((text) => paragraph({ text })).join(''),
      description: { liveText: texts, paraIds: [], tables: 0 },
    }
  }
  if (name === 'F-DUPID') {
    return {
      body: paragraph({ paraId: 7, text: 'ALPHA' }) + paragraph({ paraId: 7, text: 'BETA' }),
      description: { liveText: ['ALPHA', 'BETA'], paraIds: [7, 7], tables: 0 },
    }
  }
  if (name === 'F-TABLES') {
    return {
      body: paragraph({ paraId: 1, text: 'INTRO' }) + table(['A', 'B']) + table(['A', 'B']),
      description: { liveText: ['INTRO'], paraIds: [1], tables: 2, tableRows: [[['A', 'B']], [['A', 'B']]] },
    }
  }
  if (name === 'F-SPLIT') {
    return {
      body: paragraph({ paraId: 1, runs: run('The Agree') + run('ment.') }),
      description: { liveText: ['The Agreement.'], paraIds: [1], tables: 0, runTexts: ['The Agree', 'ment.'] },
    }
  }
  if (name === 'F-BOLD') {
    return {
      body: paragraph({
        paraId: 1,
        style: 'BodyText',
        runs: run('plain ') + run('BOLD', { bold: true }),
      }),
      description: { liveText: ['plain BOLD'], paraIds: [1], tables: 0, style: 'Body Text', runTexts: ['plain ', 'BOLD'], bold: [false, true] },
    }
  }
  if (name === 'F-DRAWING') {
    return {
      body: paragraph({ paraId: 1, text: 'BEFORE' }) + paragraph({ paraId: 2, runs: drawing() }) + paragraph({ paraId: 3, text: 'AFTER' }),
      description: { liveText: ['BEFORE', '', 'AFTER'], paraIds: [1, 2, 3], tables: 0, drawingAt: 1 },
    }
  }
  if (name === 'F-WORDS') {
    return {
      body: paragraph({ paraId: 1, text: 'The seller shall deliver the goods.' }),
      description: { liveText: ['The seller shall deliver the goods.'], paraIds: [1], tables: 0 },
    }
  }
  if (name === 'F-LARGE') {
    const paragraphs = []
    for (let index = 1; index <= 500; index++) paragraphs.push(paragraph({ paraId: index, text: `PARA ${index}` }))
    return {
      body: paragraphs.join(''),
      description: { liveText: paragraphs.length, paraIds: [], tables: 0, paragraphs: 500 },
    }
  }
  throw new Error(`unknown fixture: ${name}`)
}

/** @param {string} name - fixture name. @returns {object} build facts. */
export function fixtureSpec(name) {
  if (!FIXTURE_NAMES.includes(name)) throw new Error(`unknown fixture: ${name}`)
  return bodyFor(name)
}

/**
 * Build one fixture package.
 * @param {string} name - one of `FIXTURE_NAMES`.
 * @param {string} [directory] - destination directory; defaults to the current directory.
 * @returns {Promise<{ name: string, path: string, description: object }>} written file and facts.
 */
export async function buildFixture(name, directory = process.cwd()) {
  const spec = fixtureSpec(name)
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '</Types>')
  zip.file('_rels/.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>')
  zip.file('word/document.xml', documentXml(spec.body))
  zip.file('word/styles.xml', `${XML_HEAD}<w:styles xmlns:w="${W}">`
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/></w:style>'
    + '</w:styles>')
  zip.file('word/numbering.xml', `${XML_HEAD}<w:numbering xmlns:w="${W}">`
    + '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>'
    + '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>'
    + '<w:pPr><w:ind w:left="720"/></w:pPr></w:lvl></w:abstractNum>'
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>')
  zip.file('word/_rels/document.xml.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pixel.png"/>'
    + '</Relationships>')
  zip.file('word/media/pixel.png', PIXEL_PNG)
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, `${name.toLowerCase()}.docx`)
  await writeFile(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  return { name, path: file, description: spec.description }
}

/**
 * Build every fixture into one directory.
 * @param {string} directory - destination directory.
 * @returns {Promise<Array<{ name: string, path: string, description: object }>>} built fixtures.
 */
export async function buildFixtures(directory) {
  const built = []
  for (const name of FIXTURE_NAMES) built.push(await buildFixture(name, directory))
  return built
}
