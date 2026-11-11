'use strict';

// Page half of the Document Builder sidecar.
//
// The sidecar main process serves this hidden page, hands it the Editor.bin x2t
// produced, and drives the official sdkjs builder API (AscBuilder.Word.Api)
// through window.__dbx. Every edit runs in one tracked-change block: change
// tracking is switched on for the op and the sidecar editor user is the agent
// author, so a saved revision carries the agent name. Prefer run-level text
// edits (ApiRange.Delete + ApiParagraph.AddText) over RemoveAllElements so the
// paragraph's formatting survives.

(function () {
  const state = {
    state: 'loading',
    config: null,
    docId: null,
    mediaBase: null,
    timings: {},
    calls: [],
  }

  function log(level, message, data) {
    const entry = { at: Date.now(), level, message, data }
    state.calls.push(entry)
    if (state.calls.length > 500) state.calls.splice(0, state.calls.length - 500)
    try { window.dbEngine.log(entry) } catch (error) {}
  }

  function setState(name) {
    state.state = name
  }

  function findEditorFrame() {
    const frames = document.querySelectorAll('iframe')
    for (let i = 0; i < frames.length; i++) {
      try {
        const frame = frames[i].contentWindow
        if (frame && frame.Asc && frame.Asc.editor && frame.AscCommon) return frame
      } catch (error) {}
    }
    return null
  }

  function findFrameOrFail() {
    const frame = findEditorFrame() || desktopApi._editorWindow
    if (!frame) throw new Error('editor iframe with Asc/AscCommon not found')
    return frame
  }

  /**
   * The font shaper (harfbuzz wasm) loads after the editor app; opening a
   * document before it lands throws AscFonts.HB_StartString is not a function.
   * @returns {boolean} true when the editor frame can shape text.
   */
  function fontsReady() {
    const frame = findEditorFrame() || desktopApi._editorWindow
    if (!frame) return false
    try {
      return !!(frame.AscFonts && typeof frame.AscFonts.HB_StartString === 'function')
    } catch (error) {
      return false
    }
  }

  function toBytes(data) {
    if (!data) return new Uint8Array(0)
    if (typeof data === 'string') {
      const bytes = new Uint8Array(data.length)
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff
      return bytes
    }
    if (data instanceof Uint8Array) return data
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    try { return new Uint8Array(data) } catch (error) { return new Uint8Array(0) }
  }

  function bytesToBase64(bytes) {
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    }
    return btoa(binary)
  }

  function base64ToBytes(base64) {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  // The small AscDesktopEditor surface web-apps expects in desktop mode.
  const desktopApi = {
    IsLocalFile: () => true,
    GetEditorId: () => 'docx-engine',
    CheckNeedWheel: () => true,
    GetSupportedScaleValues: () => [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3],
    GetEncryptedHeader: () => 'ENCRYPTED;',
    GetInstallPlugins: () => JSON.stringify([{ url: '', pluginsData: [] }, { url: '', pluginsData: [] }]),
    execCommand: () => undefined,
    SetDocumentName: () => undefined,
    getFontsSprite: (suffix) => '../../../../sdkjs/common/Images/fonts_thumbnail' + (suffix || '') + '.png',
    isSupportBinaryFontsSprite: false,
    _editorWindow: null,
    _currentDocType: 'word',
    _isModified: false,

    CreateEditorApi: function () {
      const frame = findEditorFrame()
      if (frame) desktopApi._editorWindow = frame
      log('info', 'CreateEditorApi', { found: !!frame })
    },
    LocalStartOpen: function () {},
    LocalFileOpen: async function () { await openConfigured() },
    // The engine drives saves through __dbx; an editor-side save is a no-op.
    LocalFileSave: async function () { return { saved: false } },
    LocalFileGetSaved: () => false,
    LocalFileGetModified: () => !!desktopApi._isModified,
    LocalFileSetModified: (modified) => { desktopApi._isModified = !!modified },
    LocalFileSaveChanges: () => undefined,
    OnSave: () => undefined,
    LocalFileGetOpenChangesCount: () => 0,
    LocalFileGetSourcePath: () => '',
    LocalFileRecents: () => undefined,
    GetOpenedFile: () => null,
    CheckUserId: () => 'docx-engine',
    LocalFileGetImageUrl: function (url) {
      if (!url) return url
      if (/^(data:|blob:|https?:)/i.test(url)) return url
      if (state.mediaBase) return state.mediaBase + '/' + String(url).replace(/^\.?\//, '')
      return url
    },
    onDocumentModifiedChanged: function (modified) {
      desktopApi._isModified = !!modified
    },
  }

  window.AscDesktopEditor = new Proxy(desktopApi, {
    get(target, property) {
      if (property in target) return target[property]
      return undefined
    },
    set(target, property, value) {
      target[property] = value
      return true
    },
  })

  async function openConfigured() {
    try {
      state.config = await window.dbEngine.getConfig()
      state.timings.openRequested = performance.now()
      const result = await window.dbEngine.open()
      await openBin(result)
      return true
    } catch (error) {
      log('error', 'open failed', String(error && error.stack || error))
      setState('error')
      throw error
    }
  }

  async function openBin(result) {
    const frame = findFrameOrFail()
    state.docId = result.docId || state.config.sessionId
    state.mediaBase = result.mediaBase
    const common = frame.AscCommon
    if (common && common.g_oDocumentUrls) {
      const urls = common.g_oDocumentUrls
      const base = result.mediaBase
      urls.documentUrl = base
      const originalGetImageUrl = urls.getImageUrl
      urls.getImageUrl = function (value) {
        if (!value) return value
        if (/^(data:|blob:|https?:)/i.test(value)) return value
        try {
          if (typeof originalGetImageUrl === 'function') {
            const resolved = originalGetImageUrl.call(this, value)
            if (resolved && resolved !== value) return resolved
          }
        } catch (error) {}
        return base + '/' + String(value).replace(/^\.?\//, '')
      }
    }
    const bytes = base64ToBytes(result.binBase64)
    const file = new common.OpenFileResult()
    file.data = bytes
    file.bSerFormat = true
    frame.Asc.editor.openDocument(file)
    if (common.History) common.History.UserSaveMode = true
    state.timings.openCalled = performance.now()
    setState('opening-document')
    log('info', 'openDocument called with Editor.bin', { binBytes: bytes.length })
  }

  function getApi() {
    const frame = findFrameOrFail()
    const Api = frame.AscBuilder && frame.AscBuilder.Word && frame.AscBuilder.Word.Api
    if (!Api) throw new Error('AscBuilder.Word.Api is missing in the editor frame')
    return Api
  }

  function getDocument() {
    return getApi().GetDocument()
  }

  /**
   * Deterministic 32-bit FNV-1a hash for ids that must be equal across editor
   * sessions and save/reopen round trips.
   * @param {string} text - hash input.
   * @returns {string} eight hex digits.
   */
  function stableHash(text) {
    let hash = 0x811c9dc5
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
  }

  /** Monotonic `w14:paraId` allocator for paragraphs opened without one. */
  let nextParaId = 0x10000000
  function allocateParaId() {
    if (nextParaId >= 0x7fffffff) nextParaId = 0x10000000
    return nextParaId++
  }

  /** Session-stable ID for one body element; paraId is exposed separately. */
  function elementInfo(element, index) {
    const info = { index: index, kind: 'unknown', id: null, text: '', style: null, paraId: null, rows: null }
    let kind = 'unknown'
    try { kind = element.GetClassType() } catch (error) {}
    info.kind = kind
    let internalId = null
    try {
      if (typeof element.GetInternalId === 'function') internalId = element.GetInternalId()
    } catch (error) {}
    if (kind === 'paragraph') {
      try { info.paraId = element.GetParaId() || null } catch (error) {}
      if (!info.paraId && typeof element.SetParaId === 'function') {
        try {
          const minted = allocateParaId()
          element.SetParaId(minted)
          info.paraId = minted
        } catch (error) {}
      }
      // `w14:paraId` is the stable identity the design asks for: it survives a
      // save/reopen round trip, unlike sdkjs's session-scoped internal id.
      info.id = info.paraId
        ? 'w14:' + info.paraId
        : (internalId !== null && internalId !== undefined ? 'p:' + internalId : 'i:' + index)
      info.runs = paragraphRuns(element)
      info.text = info.runs.length === 0 ? cleanText(rawParagraphText(element)) : paragraphText(element)
      info.deletedText = deletedText(element)
      try {
        const pr = element.GetParaPr()
        const style = pr && pr.GetStyle()
        if (style && typeof style.GetName === 'function') {
          info.style = style.GetName()
          info.props = { ...(info.props ?? {}), style: info.style }
        }
        if (pr && typeof pr.GetJc === 'function') {
          const align = pr.GetJc()
          if (align !== undefined) info.props = { ...(info.props ?? {}), align }
        }
        if (pr && typeof pr.GetOutlineLvl === 'function') {
          const level = pr.GetOutlineLvl()
          if (level !== undefined && level !== null) info.level = level
        }
      } catch (error) {}
      try {
        const numbering = element.GetNumbering()
        if (numbering) info.numbering = { level: numbering.GetLevelIndex() }
      } catch (error) {}
    } else if (kind === 'table') {
      const rows = []
      try {
        const count = element.GetRowsCount()
        info.rows = count
        for (let r = 0; r < count; r++) {
          const row = element.GetRow(r)
          const cells = []
          const cellsCount = row ? row.GetCellsCount() : 0
          for (let c = 0; c < cellsCount; c++) {
            let text = ''
            try {
              const cellParagraph = row.GetCell(c).GetContent().GetElement(0)
              if (cellParagraph) text = paragraphText(cellParagraph)
            } catch (error) {}
            cells.push(text)
          }
          rows.push(cells)
        }
      } catch (error) {}
      info.cells = null
      info.text = rows.map((cells) => cells.join('\t')).join('\n')
      info.tableRows = rows
      // Tables have no w14:paraId. Key the id on the header row and column count
      // so it survives save/reopen and row insertions, which is what fork/merge
      // matches on; identical tables in one document share an id by design.
      const header = rows[0] ?? []
      info.id = 't:' + stableHash(`${header.join('\u0001')}\u0002${header.length}`)
    } else {
      info.id = internalId !== null && internalId !== undefined ? 'e:' + internalId : 'i:' + index
      try { info.text = element.GetText ? String(element.GetText({ Numbering: false, Math: false })) : '' } catch (error) {}
    }
    return info
  }

  function describeDocument() {
    const doc = getDocument()
    const count = doc.GetElementsCount()
    const blocks = []
    const tableCounts = new Map()
    for (let i = 0; i < count; i++) {
      const element = doc.GetElement(i)
      if (!element) {
        blocks.push({ index: i, kind: 'unknown', id: 'i:' + i, text: '' })
        continue
      }
      const info = elementInfo(element, i)
      if (info.kind === 'table' && typeof info.id === 'string') {
        const seen = (tableCounts.get(info.id) ?? 0) + 1
        tableCounts.set(info.id, seen)
        if (seen > 1) info.id = `${info.id}#${seen}`
      }
      blocks.push(info)
    }
    const sections = []
    try {
      const section = doc.GetFinalSection()
      if (section) {
        sections.push({
          index: 0,
          kind: 'section',
          props: {
            pageWidth: section.GetPageWidth(),
            pageHeight: section.GetPageHeight(),
            orientation: section.GetPageWidth() > section.GetPageHeight() ? 'landscape' : 'portrait',
          },
        })
      }
    } catch (error) {}
    return {
      blocks,
      sections,
      paragraphCount: blocks.filter((block) => block.kind === 'paragraph').length,
      tableCount: blocks.filter((block) => block.kind === 'table').length,
      elementsCount: count,
    }
  }

  function opError(code, message) {
    return { ok: false, code, message }
  }

  function findTarget(doc, op) {
    if (op.blockId !== undefined && op.blockId !== null && op.blockId !== '') {
      const matches = describeDocument().blocks.filter((block) => block.id === op.blockId)
      if (matches.length > 1) return { ambiguous: true, id: op.blockId, count: matches.length }
      if (matches.length === 0) return null
      const index = matches[0].index
      return { element: doc.GetElement(index), index }
    }
    if (typeof op.index === 'number' && op.index >= 0 && op.index < doc.GetElementsCount()) {
      return { element: doc.GetElement(op.index), index: op.index }
    }
    return null
  }

  function rawParagraphText(element) {
    try { return element.GetText({ Numbering: false, Math: false }) } catch (error) { return '' }
  }

  /** @param {string} value - raw text. @returns {string} text without the paragraph end mark. */
  function cleanText(value) {
    return typeof value === 'string' ? value.replace(/\r\n?/g, '').replace(/\n$/, '') : ''
  }

  /** @param {object} run - ApiRun. @returns {{ inserted: boolean, deleted: boolean, author: string | null }} review facts. */
  function reviewOf(run) {
    try {
      const type = run.Run && typeof run.Run.GetReviewType === 'function' ? run.Run.GetReviewType() : 0
      const info = run.Run && run.Run.ReviewInfo !== undefined ? run.Run.ReviewInfo : run.ReviewInfo
      return {
        inserted: type === 2,
        deleted: type === 1,
        author: info && typeof info.GetUserName === 'function' ? String(info.GetUserName() ?? '') || null : null,
      }
    } catch (error) {
      return { inserted: false, deleted: false, author: null }
    }
  }

  /** @param {object} run - ApiRun. @returns {object} run properties. */
  function runProps(run) {
    const props = {}
    try {
      const pr = typeof run.GetTextPr === 'function' ? run.GetTextPr() : null
      if (!pr) return props
      const read = (name) => {
        try {
          const value = typeof pr[name] === 'function' ? pr[name]() : undefined
          if (value !== undefined && value !== null) return value
        } catch (error) {}
        return undefined
      }
      const bold = read('GetBold')
      const italic = read('GetItalic')
      const underline = read('GetUnderline')
      const size = read('GetFontSize')
      const font = read('GetFontFamily')
      const color = read('GetColor')
      const highlight = read('GetHighlight')
      props.bold = bold === true
      props.italic = italic === true
      props.underline = underline === true || (underline !== undefined && underline !== 'none')
      if (size !== undefined) props.size = size
      if (font !== undefined) props.font = font
      if (color !== undefined) props.color = color
      if (highlight !== undefined) props.highlight = highlight
    } catch (error) {}
    return props
  }

  /** @param {object} run - ApiRun. @returns {boolean} whether the run holds a drawing. */
  function hasDrawing(run) {
    try {
      if (!run.Run || typeof run.Run.GetAllDrawingObjects !== 'function') return false
      const drawings = []
      run.Run.GetAllDrawingObjects(drawings)
      return drawings.length > 0
    } catch (error) {
      return false
    }
  }

  /** @param {object} element - ApiParagraph. @returns {object[]} run nodes. */
  function paragraphRuns(element) {
    const runs = []
    let count = 0
    try { count = typeof element.GetElementsCount === 'function' ? element.GetElementsCount() : 0 } catch (error) { count = 0 }
    for (let index = 0; index < count; index++) {
      let item = null
      try { item = element.GetElement(index) } catch (error) { item = null }
      if (!item) continue
      let kind = ''
      try { kind = item.GetClassType() } catch (error) {}
      if (kind === 'run') {
        if (hasDrawing(item)) {
          runs.push({ kind: 'opaque', runIndex: runs.length, type: 'drawing' })
          continue
        }
        let text = ''
        try { text = cleanText(item.GetText({ NewLineSeparator: '', TabSymbol: '\t' })) } catch (error) { text = '' }
        runs.push({
          kind: 'run',
          runIndex: runs.length,
          text,
          props: runProps(item),
          ...reviewOf(item),
        })
      } else if (kind === 'hyperlink' || kind === 'drawing') {
        runs.push({ kind: 'opaque', runIndex: runs.length, type: kind })
      }
    }
    return runs
  }

  /** @param {object} element - ApiParagraph. @returns {string} live text. */
  function paragraphText(element) {
    const runs = paragraphRuns(element)
    if (runs.length === 0) return cleanText(rawParagraphText(element))
    return runs.filter((run) => run.kind !== 'opaque' && run.deleted !== true).map((run) => run.text).join('')
  }

  /** @param {object} element - ApiParagraph. @returns {string} deleted text. */
  function deletedText(element) {
    return paragraphRuns(element).filter((run) => run.deleted === true).map((run) => run.text).join('')
  }

  /**
   * Replace a paragraph's text with run-level operations: the old text is
   * deleted through an ApiRange (a tracked w:del) and the new text is added as
   * a run (a tracked w:ins) so formatting and revision history survive.
   */
  function replaceParagraphText(paragraph, text) {
    const raw = rawParagraphText(paragraph)
    const before = paragraphText(paragraph)
    if (raw.length > 0) {
      let range = null
      try { range = paragraph.GetRange(0, raw.length) } catch (error) {}
      if (!range) {
        try {
          paragraph.Select()
          range = getDocument().GetRangeBySelect()
        } catch (error) {}
      }
      if (range) {
        try { range.Delete() } catch (error) { range = null }
      }
      if (!range) {
        // Last resort for a paragraph whose range cannot be built.
        paragraph.RemoveAllElements()
      }
    }
    if (text !== '') paragraph.AddText(text)
    return before
  }

  /** Apply text properties to one ApiRun. @param {object} run - ApiRun. @param {object} props - properties. */
  function applyRunProps(run, props) {
    if (!run || typeof props !== 'object' || props === null) return
    const setters = {
      bold: 'SetBold', italic: 'SetItalic', underline: 'SetUnderline',
      size: 'SetFontSize', font: 'SetFontFamily', color: 'SetColor', highlight: 'SetHighlight',
    }
    for (const [key, method] of Object.entries(setters)) {
      if (props[key] === undefined || typeof run[method] !== 'function') continue
      try { run[method](props[key]) } catch (error) {}
    }
  }

  /** Rebuild a paragraph from run facts. @param {object} paragraph - ApiParagraph. @param {object[]} runs - run facts. */
  function rebuildParagraph(paragraph, runs) {
    paragraph.RemoveAllElements()
    for (const entry of runs) {
      if (entry.kind === 'opaque') continue
      const run = paragraph.AddText(entry.text ?? '')
      applyRunProps(run, entry.props ?? {})
    }
    // RemoveAllElements can leave one empty run at the start.
    for (let guard = 0; guard < 4; guard++) {
      const first = paragraph.GetElement(0)
      if (!first) break
      let text = ''
      try { text = cleanText(first.GetText({ NewLineSeparator: '', TabSymbol: '\\\\t' })) } catch (error) { break }
      if (text !== '') break
      try { first.Delete() } catch (error) { break }
    }
  }

  /** @param {object} paragraph - ApiParagraph. @returns {object[]} editable run facts. */
  function editableRuns(paragraph) {
    return paragraphRuns(paragraph).filter((run) => {
      if (run.kind === 'opaque') throw new Error('the paragraph contains an opaque run')
      return run.text !== ''
    })
  }
  function runOp(doc, op) {
    const Api = getApi()
    const type = op.type
    if (type === 'replace_paragraph') {
      const target = findTarget(doc, op)
      if (target && target.ambiguous) return opError('AMBIGUOUS_TARGET', `replace_paragraph: ${target.count} blocks have id ${target.id}`)
      if (!target) return opError('TARGET_NOT_FOUND', 'replace_paragraph: target block not found')
      if (target.element.GetClassType() !== 'paragraph') return opError('WRONG_KIND', 'replace_paragraph: target is not a paragraph')
      if (op.expectedText !== undefined && paragraphText(target.element) !== op.expectedText) {
        return opError('STALE_TARGET', 'replace_paragraph: target text does not match expectedText')
      }
      if (typeof op.text !== 'string') return opError('BAD_OP', 'replace_paragraph: text must be a string')
      const before = replaceParagraphText(target.element, op.text)
      return { type, targetId: elementInfo(target.element, target.index).id, textBefore: before, textAfter: paragraphText(target.element) }
    }
    if (type === 'set_run_props' || type === 'set_run_text' || type === 'split_run' || type === 'merge_runs') {
      const target = findTarget(doc, op)
      if (target && target.ambiguous) return opError('AMBIGUOUS_TARGET', `${type}: ${target.count} blocks have id ${target.id}`)
      if (!target) return opError('TARGET_NOT_FOUND', `${type}: target block not found`)
      if (target.element.GetClassType() !== 'paragraph') return opError('WRONG_KIND', `${type}: target is not a paragraph`)
      const runs = editableRuns(target.element)
      const run = runs.find((entry) => entry.runIndex === op.runIndex)
      if (!run) return opError('TARGET_NOT_FOUND', `${type}: run not found`)
      if (op.expectedText !== undefined && run.text !== op.expectedText) {
        return opError('STALE_TARGET', `${type}: run text does not match expectedText`)
      }
      if (type === 'set_run_props') {
        applyRunProps(target.element.GetElement(op.runIndex), op.props ?? {})
      } else if (type === 'set_run_text') {
        if (typeof op.text !== 'string') return opError('BAD_OP', 'set_run_text: text must be a string')
        run.text = op.text
        rebuildParagraph(target.element, runs)
      } else if (type === 'split_run') {
        const offset = Number.isFinite(op.offset) ? Math.max(0, Math.min(op.offset, run.text.length)) : 0
        const at = runs.indexOf(run)
        runs.splice(at, 1, { ...run, text: run.text.slice(0, offset) }, { ...run, text: run.text.slice(offset) })
        rebuildParagraph(target.element, runs)
      } else {
        const at = runs.indexOf(run)
        const next = runs[at + 1]
        if (!next) return opError('TARGET_NOT_FOUND', 'merge_runs: no following run')
        if (JSON.stringify(run.props ?? {}) !== JSON.stringify(next.props ?? {})) return opError('BAD_OP', 'merge_runs: run properties differ')
        run.text += next.text
        runs.splice(at + 1, 1)
        rebuildParagraph(target.element, runs)
      }
      return { type, targetId: elementInfo(target.element, target.index).id, textBefore: op.expectedText ?? '', textAfter: paragraphText(target.element) }
    }
    if (type === 'set_paragraph_props') {
      const target = findTarget(doc, op)
      if (target && target.ambiguous) return opError('AMBIGUOUS_TARGET', `${type}: ${target.count} blocks have id ${target.id}`)
      if (!target) return opError('TARGET_NOT_FOUND', `${type}: target block not found`)
      if (target.element.GetClassType() !== 'paragraph') return opError('WRONG_KIND', `${type}: target is not a paragraph`)
      const props = op.props ?? {}
      const pr = target.element.GetParaPr()
      if (typeof props.style === 'string') {
        const style = doc.GetStyle(props.style)
        if (!style) return opError('TARGET_NOT_FOUND', `set_paragraph_props: style not found: ${props.style}`)
        pr.SetStyle(style)
      }
      if (typeof props.align === 'string') pr.SetJc(props.align)
      if (Number.isFinite(props.spacingAfter)) pr.SetSpacingAfter(props.spacingAfter)
      return { type, targetId: elementInfo(target.element, target.index).id, textBefore: '', textAfter: paragraphText(target.element) }
    }
    if (type === 'replace_text') {
      const target = findTarget(doc, op)
      if (target && target.ambiguous) return opError('AMBIGUOUS_TARGET', `replace_text: ${target.count} blocks have id ${target.id}`)
      if (!target) return opError('TARGET_NOT_FOUND', 'replace_text: target block not found')
      if (target.element.GetClassType() !== 'paragraph') return opError('WRONG_KIND', 'replace_text: target is not a paragraph')
      const before = paragraphText(target.element)
      if (op.expectedText !== undefined && before !== op.expectedText) return opError('STALE_TARGET', 'replace_text: text does not match expectedText')
      if (typeof op.find !== 'string' || op.find === '') return opError('BAD_OP', 'replace_text: find must be a non-empty string')
      const count = before.split(op.find).length - 1
      const after = typeof op.replace === 'string' ? before.split(op.find).join(op.replace) : before
      if (count > 0) replaceParagraphText(target.element, after)
      return { type, targetId: elementInfo(target.element, target.index).id, replacements: count, textBefore: before, textAfter: after }
    }    if (type === 'insert_paragraph') {
      if (typeof op.text !== 'string') return opError('BAD_OP', 'insert_paragraph: text must be a string')
      const paragraph = Api.CreateParagraph()
      if (op.text !== '') paragraph.AddText(op.text)
      let index = typeof op.index === 'number' ? op.index : doc.GetElementsCount()
      if (index < 0) index = 0
      if (index > doc.GetElementsCount()) index = doc.GetElementsCount()
      const pushed = doc.AddElement(index, paragraph)
      if (!pushed) return opError('OP_FAILED', 'insert_paragraph: AddElement failed')
      const element = doc.GetElement(index)
      return { type, index, targetId: element ? elementInfo(element, index).id : null, textAfter: op.text }
    }
    if (type === 'delete_paragraph') {
      const target = findTarget(doc, op)
      if (target && target.ambiguous) return opError('AMBIGUOUS_TARGET', `delete_paragraph: ${target.count} blocks have id ${target.id}`)
      if (!target) return opError('TARGET_NOT_FOUND', 'delete_paragraph: target block not found')
      if (target.element.GetClassType() !== 'paragraph') return opError('WRONG_KIND', 'delete_paragraph: target is not a paragraph')
      if (op.expectedText !== undefined && paragraphText(target.element) !== op.expectedText) {
        return opError('STALE_TARGET', 'delete_paragraph: target text does not match expectedText')
      }
      const before = paragraphText(target.element)
      target.element.Delete()
      return { type, targetId: op.blockId || null, index: target.index, textBefore: before }
    }
    if (type === 'insert_list_item') {
      if (typeof op.text !== 'string') return opError('BAD_OP', 'insert_list_item: text must be a string')
      const numbering = doc.CreateNumbering(op.numbering || 'bullet')
      const level = numbering.GetLevel(typeof op.level === 'number' ? op.level : 0)
      const item = Api.CreateParagraph()
      item.AddText(op.text)
      item.SetNumbering(level)
      let index = typeof op.index === 'number' ? op.index : doc.GetElementsCount()
      if (index < 0) index = 0
      if (index > doc.GetElementsCount()) index = doc.GetElementsCount()
      const pushed = doc.AddElement(index, item) || doc.Push(item)
      if (!pushed) return opError('OP_FAILED', 'insert_list_item: push failed')
      const element = doc.GetElement(index)
      return { type, index, targetId: element ? elementInfo(element, index).id : null, textAfter: op.text }
    }
    if (type === 'insert_table_row') {
      let table = null
      let tableIndex = -1
      if (op.tableBlockId !== undefined && op.tableBlockId !== null && op.tableBlockId !== '') {
        for (let i = 0; i < doc.GetElementsCount(); i++) {
          const element = doc.GetElement(i)
          if (element && element.GetClassType() === 'table' && elementInfo(element, i).id === op.tableBlockId) {
            table = element
            tableIndex = i
            break
          }
        }
      } else if (typeof op.tableIndex === 'number') {
        const element = doc.GetElement(op.tableIndex)
        if (element && element.GetClassType() === 'table') {
          table = element
          tableIndex = op.tableIndex
        }
      } else {
        for (let i = 0; i < doc.GetElementsCount(); i++) {
          const element = doc.GetElement(i)
          if (element && element.GetClassType() === 'table') { table = element; tableIndex = i; break }
        }
      }
      let created = false
      if (!table) {
        if (op.create !== true) return opError('TARGET_NOT_FOUND', 'insert_table_row: no table in document')
        const cells = Array.isArray(op.cells) && op.cells.length > 0 ? op.cells.length : 1
        table = Api.CreateTable(1, cells)
        doc.Push(table)
        tableIndex = doc.GetElementsCount() - 1
        created = true
      }
      const rowsBefore = table.GetRowsCount()
      const row = created ? table.GetRow(0) : table.AddRow()
      const cells = Array.isArray(op.cells) ? op.cells : []
      for (let c = 0; c < cells.length; c++) {
        try {
          const cellParagraph = row.GetCell(c).GetContent().GetElement(0)
          if (cellParagraph) cellParagraph.AddText(String(cells[c]))
        } catch (error) {}
      }
      return {
        type,
        tableIndex,
        rowsBefore,
        rowsAfter: table.GetRowsCount(),
        tableId: elementInfo(table, tableIndex).id,
      }
    }
    if (type === 'delete_table_row') {
      const target = findTarget(doc, op)
      if (target && target.ambiguous) return opError('AMBIGUOUS_TARGET', `delete_table_row: ${target.count} blocks have id ${target.id}`)
      if (!target) return opError('TARGET_NOT_FOUND', 'delete_table_row: target block not found')
      if (target.element.GetClassType() !== 'table') return opError('WRONG_KIND', 'delete_table_row: target is not a table')
      const rowIndex = typeof op.rowIndex === 'number' ? op.rowIndex : target.element.GetRowsCount() - 1
      const row = target.element.GetRow(rowIndex)
      if (!row) return opError('TARGET_NOT_FOUND', 'delete_table_row: row not found')
      row.Remove()
      return { type, tableId: op.blockId || null, rowIndex, rowsAfter: target.element.GetRowsCount() }
    }
    if (type === 'set_cell_text' || type === 'insert_table_column' || type === 'delete_table_column') {
      let table = null
      for (let i = 0; i < doc.GetElementsCount(); i++) {
        const element = doc.GetElement(i)
        if (!element || element.GetClassType() !== 'table') continue
        const id = elementInfo(element, i).id
        if (op.tableBlockId === undefined || op.tableBlockId === id) { table = element; break }
      }
      if (!table) return opError('TARGET_NOT_FOUND', `${type}: table not found`)
      if (type === 'set_cell_text') {
        const row = table.GetRow(op.rowIndex)
        if (!row) return opError('TARGET_NOT_FOUND', 'set_cell_text: row not found')
        const cell = row.GetCell(op.columnIndex)
        if (!cell) return opError('TARGET_NOT_FOUND', 'set_cell_text: cell not found')
        const paragraph = cell.GetContent().GetElement(0)
        if (!paragraph) return opError('TARGET_NOT_FOUND', 'set_cell_text: cell paragraph not found')
        if (op.expectedText !== undefined && paragraphText(paragraph) !== op.expectedText) {
          return opError('STALE_TARGET', 'set_cell_text: cell text does not match expectedText')
        }
        if (typeof op.text !== 'string') return opError('BAD_OP', 'set_cell_text: text must be a string')
        const before = replaceParagraphText(paragraph, op.text)
        return { type, textBefore: before, textAfter: paragraphText(paragraph) }
      }
      const column = Number.isFinite(op.columnIndex) ? op.columnIndex : table.GetRow(0).GetCellsCount() - 1
      const cell = table.GetRow(0).GetCell(Math.max(0, column))
      if (!cell) return opError('TARGET_NOT_FOUND', `${type}: column not found`)
      if (type === 'insert_table_column') {
        table.AddColumn(cell, false)
        if (Array.isArray(op.cells)) {
          for (let row = 0; row < table.GetRowsCount(); row++) {
            const target = table.GetRow(row).GetCell(column + 1)
            const paragraph = target && target.GetContent().GetElement(0)
            if (paragraph && typeof op.cells[row] === 'string') replaceParagraphText(paragraph, op.cells[row])
          }
        }
      } else {
        table.RemoveColumn(cell)
      }
      return { type, columnIndex: column }
    }
    if (type === 'set_section_props') {
      const section = doc.GetFinalSection()
      if (!section) return opError('TARGET_NOT_FOUND', 'set_section_props: no final section')
      const props = op.props ?? {}
      if (Number.isFinite(props.pageWidth) && Number.isFinite(props.pageHeight)) {
        section.SetPageSize(props.pageWidth, props.pageHeight, props.orientation !== 'landscape')
      }
      if (Number.isFinite(props.marginLeft) || Number.isFinite(props.marginTop) || Number.isFinite(props.marginRight) || Number.isFinite(props.marginBottom)) {
        section.SetPageMargins(
          Number.isFinite(props.marginLeft) ? props.marginLeft : section.GetPageMarginLeft(),
          Number.isFinite(props.marginTop) ? props.marginTop : section.GetPageMarginTop(),
          Number.isFinite(props.marginRight) ? props.marginRight : section.GetPageMarginRight(),
          Number.isFinite(props.marginBottom) ? props.marginBottom : section.GetPageMarginBottom(),
        )
      }
      return { type }
    }
    return opError('UNKNOWN_OP', 'unsupported operation type: ' + String(type))
  }

  function snapshotMap() {
    const doc = getDocument()
    const map = new Map()
    const count = doc.GetElementsCount()
    for (let i = 0; i < count; i++) {
      const element = doc.GetElement(i)
      if (!element) continue
      const info = elementInfo(element, i)
      map.set(info.id, info)
    }
    return map
  }

  function applyOp(op) {
    if (!op || typeof op !== 'object' || typeof op.type !== 'string' || op.type === '') {
      return opError('BAD_OP', 'op must be an object with a type')
    }
    const doc = getDocument()
    const track = op.track !== false
    const before = snapshotMap()
    let result
    try {
      if (track && typeof doc.SetTrackRevisions === 'function') doc.SetTrackRevisions(true)
      result = runOp(doc, op)
    } catch (error) {
      return opError('OP_FAILED', String(error && error.message || error))
    } finally {
      if (track) {
        try { if (typeof doc.SetTrackRevisions === 'function') doc.SetTrackRevisions(false) } catch (error) {}
      }
    }
    if (!result || result.ok === false) return result || opError('OP_FAILED', 'no result')
    try {
      const after = snapshotMap()
      const affected = []
      for (const [id, info] of after) {
        const prior = before.get(id)
        if (!prior || prior.text !== info.text || prior.rows !== info.rows) {
          affected.push({
            id,
            index: info.index,
            kind: info.kind,
            textBefore: prior ? prior.text : null,
            textAfter: info.text,
          })
        }
      }
      for (const [id, info] of before) {
        if (!after.has(id)) affected.push({ id, index: info.index, kind: info.kind, textBefore: info.text, textAfter: null })
      }
      result.affected = affected
      result.tracked = track
    } catch (error) {
      result.affected = []
    }
    return result
  }

  function saveBinBase64() {
    const frame = findFrameOrFail()
    const data = frame.Asc.editor.asc_nativeGetFile()
    if (!data) throw new Error('asc_nativeGetFile returned no data')
    const bytes = toBytes(data)
    if (bytes.length === 0) throw new Error('asc_nativeGetFile returned zero bytes')
    log('info', 'serialized document', { bytes: bytes.length })
    return bytesToBase64(bytes)
  }

  function createEditor() {
    const config = {
      type: 'desktop',
      width: '100%',
      height: '100%',
      documentType: 'word',
      document: {
        title: (state.config && state.config.name) || 'document.docx',
        url: '_offline_',
        fileType: 'docx',
        key: 'docx-engine-' + Date.now(),
        permissions: { edit: true, download: true, print: true },
      },
      editorConfig: {
        mode: 'edit',
        lang: 'en',
        targetApp: 'desktop',
        user: {
          id: (state.config && state.config.author) || 'agent:docx-engine',
          name: (state.config && state.config.author) || 'agent:docx-engine',
        },
        customization: { about: false, feedback: false, macros: false },
      },
      events: {
        onAppReady: function () {
          state.timings.appReady = performance.now()
          setState('editor-app-ready')
          log('info', 'onAppReady')
        },
        onDocumentReady: function () {
          state.timings.documentReady = performance.now()
          setState('document-ready')
          log('info', 'onDocumentReady')
        },
        onError: function (event) { log('error', 'editor onError', event && event.data ? event.data : null) },
        onWarning: function (event) { log('warn', 'editor onWarning', event && event.data ? event.data : null) },
      },
    }
    state.timings.scriptLoaded = performance.now()
    state.editor = new window.DocsAPI.DocEditor('placeholder', config)
    log('info', 'DocEditor constructed', { author: config.editorConfig.user })
  }

  window.addEventListener('error', (event) => {
    log('error', 'window.error', { message: event.message, filename: event.filename, line: event.lineno })
  })
  window.addEventListener('unhandledrejection', (event) => {
    log('error', 'unhandledrejection', String((event.reason && (event.reason.stack || event.reason.message)) || event.reason))
  })

  window.__dbx = {
    get state() { return state.state },
    get timings() { return state.timings },
    get calls() { return state.calls },
    openConfigured,
    describe: describeDocument,
    applyOp,
    saveBinBase64,
    findEditorFrame,
    fontsReady,
  }

  async function boot() {
    try {
      state.config = await window.dbEngine.getConfig()
    } catch (error) {
      log('error', 'config failed', String(error && error.message || error))
    }
    createEditor()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void boot() })
  } else {
    void boot()
  }
})()

