/**
 * Agent-side DOCX editing for the editor plugin.
 *
 * These are text-level edits on the package: they rewrite the `w:t` runs that
 * hold the requested text, append a paragraph, or replace one paragraph. They
 * keep the archive's other parts untouched, so the result reopens in the
 * editor and in Word.
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { DocError } from './docs.js'

const decodeXml = (text) => text
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&')

const encodeXml = (text) => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

const squash = (text) => text.replace(/\s+/g, ' ').trim()

const runText = (xml) => (xml.match(/<w:t(?: [^>]*)?>[\s\S]*?<\/w:t>/g) ?? [])
  .map((node) => decodeXml(node.replace(/<[^>]+>/g, '')))
  .join('')

const paragraphPattern = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g

/**
 * Read the visible text of a DOCX.
 * @param {string} file - absolute .docx path.
 * @returns {Promise<string>} the body text.
 */
export async function readDocumentText(file) {
  const zip = await JSZip.loadAsync(await readFile(file))
  const documentXml = await zip.file('word/document.xml')?.async('string')
  if (documentXml === undefined) throw new DocError(`${file} is not a Word document`)
  return squash(runText(documentXml))
}

/**
 * Apply one text edit to a DOCX, then write it back in place.
 * @param {string} file - absolute .docx path.
 * @param {{ find?: string, replace?: string, append?: string, setParagraph?: { index: number, text: string } }} edit - the requested change.
 * @returns {Promise<{ path: string, paragraphs: number }>} outcome.
 */
export async function editDocument(file, edit) {
  const absolute = path.resolve(file)
  const zip = await JSZip.loadAsync(await readFile(absolute))
  const entry = zip.file('word/document.xml')
  if (entry === null) throw new DocError(`${absolute} is not a Word document`)
  let xml = await entry.async('string')
  let changed = false

  if (edit.find !== undefined && edit.replace !== undefined) {
    const needle = edit.find
    if (needle === '') throw new DocError('find must not be empty', { status: 400 })
    const pattern = new RegExp(`(<w:t(?: [^>]*)?>)([\\s\\S]*?)(</w:t>)`, 'g')
    xml = xml.replace(pattern, (whole, open, text, close) => {
      if (!decodeXml(text).includes(needle)) return whole
      changed = true
      return open + encodeXml(decodeXml(text).split(needle).join(edit.replace)) + close
    })
    if (!changed) {
      throw new DocError(`text not found in a single run: "${needle}". Read the document first and match one run exactly.`, { status: 400 })
    }
  }

  if (edit.setParagraph !== undefined) {
    const { index, text } = edit.setParagraph
    if (!Number.isInteger(index) || index < 0) throw new DocError('set_paragraph.index must be a non-negative integer', { status: 400 })
    let seen = -1
    xml = xml.replace(paragraphPattern, (paragraph) => {
      seen += 1
      if (seen !== index) return paragraph
      changed = true
      // Keep the paragraph's properties, replace only its runs.
      const properties = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(paragraph)?.[0] ?? ''
      const runProperties = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(paragraph)?.[0] ?? ''
      return `<w:p>${properties}<w:r>${runProperties}<w:t xml:space="preserve">${encodeXml(text)}</w:t></w:r></w:p>`
    })
    if (!changed) throw new DocError(`no paragraph at index ${index}`, { status: 400 })
  }

  if (edit.append !== undefined) {
    const closeBody = xml.lastIndexOf('</w:body>')
    if (closeBody === -1) throw new DocError('document has no body', { status: 500 })
    const section = xml.lastIndexOf('<w:sectPr')
    const insertAt = section !== -1 && section < closeBody ? section : closeBody
    const paragraph = `<w:p><w:r><w:t xml:space="preserve">${encodeXml(edit.append)}</w:t></w:r></w:p>`
    xml = xml.slice(0, insertAt) + paragraph + xml.slice(insertAt)
    changed = true
  }

  if (!changed) throw new DocError('no edit was requested', { status: 400 })

  zip.file('word/document.xml', xml)
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const temp = `${absolute}.${process.pid}.tmp`
  await writeFile(temp, bytes)
  await rename(temp, absolute)
  const paragraphs = (xml.match(/<w:p(?:\s[^>]*)?>/g) ?? []).length
  return { path: absolute, paragraphs }
}
