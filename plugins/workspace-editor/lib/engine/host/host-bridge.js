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
      // `w14:paraId` is the stable identity the design asks for: it survives a
      // save/reopen round trip, unlike sdkjs's session-scoped internal id.
      info.id = info.paraId
        ? 'w14:' + info.paraId
        : (internalId !== null && internalId !== undefined ? 'p:' + internalId : 'i:' + index)
      try { info.text = element.GetText({ Numbering: false, Math: false }) } catch (error) { info.text = '' }
      try {
        const pr = element.GetParaPr()
        const style = pr && pr.GetStyle()
        if (style && typeof style.GetName === 'function') info.style = style.GetName()
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
              if (cellParagraph) text = cellParagraph.GetText({ Numbering: false, Math: false })
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
    for (let i = 0; i < count; i++) {
      const element = doc.GetElement(i)
      if (!element) {
        blocks.push({ index: i, kind: 'unknown', id: 'i:' + i, text: '' })
        continue
      }
      blocks.push(elementInfo(element, i))
    }
    return {
      blocks,
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
      for (let i = 0; i < doc.GetElementsCount(); i++) {
        const element = doc.GetElement(i)
        if (!element) continue
        if (elementInfo(element, i).id === op.blockId) return { element, index: i }
      }
      return null
    }
    if (typeof op.index === 'number' && op.index >= 0 && op.index < doc.GetElementsCount()) {
      return { element: doc.GetElement(op.index), index: op.index }
    }
    return null
  }

  function paragraphText(element) {
    try { return element.GetText({ Numbering: false, Math: false }) } catch (error) { return '' }
  }

  /**
   * Replace a paragraph's text with run-level operations: the old text is
   * deleted through an ApiRange (a tracked w:del) and the new text is added as
   * a run (a tracked w:ins) so formatting and revision history survive.
   */
  function replaceParagraphText(paragraph, text) {
    const before = paragraphText(paragraph)
    if (before.length > 0) {
      let range = null
      try { range = paragraph.GetRange(0, before.length) } catch (error) {}
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

  function runOp(doc, op) {
    const Api = getApi()
    const type = op.type
    if (type === 'replace_paragraph') {
      const target = findTarget(doc, op)
      if (!target) return opError('TARGET_NOT_FOUND', 'replace_paragraph: target block not found')
      if (target.element.GetClassType() !== 'paragraph') return opError('WRONG_KIND', 'replace_paragraph: target is not a paragraph')
      if (op.expectedText !== undefined && paragraphText(target.element) !== op.expectedText) {
        return opError('STALE_TARGET', 'replace_paragraph: target text does not match expectedText')
      }
      if (typeof op.text !== 'string') return opError('BAD_OP', 'replace_paragraph: text must be a string')
      const before = replaceParagraphText(target.element, op.text)
      return { type, targetId: elementInfo(target.element, target.index).id, textBefore: before, textAfter: paragraphText(target.element) }
    }
    if (type === 'insert_paragraph') {
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
      if (!table) {
        if (op.create === false) return opError('TARGET_NOT_FOUND', 'insert_table_row: no table in document')
        const cells = Array.isArray(op.cells) && op.cells.length > 0 ? op.cells.length : 1
        table = Api.CreateTable(1, cells)
        doc.Push(table)
        tableIndex = doc.GetElementsCount() - 1
      }
      const rowsBefore = table.GetRowsCount()
      const row = table.AddRow()
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
      if (!target) return opError('TARGET_NOT_FOUND', 'delete_table_row: target block not found')
      if (target.element.GetClassType() !== 'table') return opError('WRONG_KIND', 'delete_table_row: target is not a table')
      const rowIndex = typeof op.rowIndex === 'number' ? op.rowIndex : target.element.GetRowsCount() - 1
      const row = target.element.GetRow(rowIndex)
      if (!row) return opError('TARGET_NOT_FOUND', 'delete_table_row: row not found')
      row.Remove()
      return { type, tableId: op.blockId || null, rowIndex, rowsAfter: target.element.GetRowsCount() }
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
