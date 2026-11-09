'use strict';

// Host page half of the S0 Document Builder spike.
//
// It supplies the small AscDesktopEditor surface the web-apps editor expects,
// mounts the real editor in a hidden Electron window, opens the Editor.bin that
// x2t produced, and then calls the official sdkjs builder API
// (AscBuilder.Word.Api) inside the editor frame. The binary is saved with the
// editor's own serializer (asc_nativeGetFile) and converted back by x2t in the
// main process.

(function () {
  const REPLACED = 'DBSPIKE-REPLACED-PARAGRAPH'
  const LIST_ITEM = 'DBSPIKE-LIST-ITEM'
  const TABLE_ROW = 'DBSPIKE-TABLE-ROW'

  const state = {
    state: 'loading',
    config: null,
    docId: null,
    lastSave: null,
    timings: {},
    calls: [],
  }

  function log(level, message, data) {
    const entry = { at: Date.now(), level, message, data }
    state.calls.push(entry)
    if (state.calls.length > 500) state.calls.splice(0, state.calls.length - 500)
    try { window.dbHost.log(entry) } catch (error) {}
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

  const desktopApi = {
    IsLocalFile: () => true,
    GetEditorId: () => 'docbuilder-spike',
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
    LocalFileSave: async function () {
      const source = await saveBase64()
      const result = await window.dbHost.save({ binBase64: source })
      state.lastSave = result
      return result
    },
    LocalFileGetSaved: () => false,
    LocalFileGetModified: () => !!desktopApi._isModified,
    LocalFileSetModified: (modified) => { desktopApi._isModified = !!modified },
    LocalFileSaveChanges: () => undefined,
    OnSave: () => undefined,
    LocalFileGetOpenChangesCount: () => 0,
    LocalFileGetSourcePath: () => '',
    LocalFileRecents: () => undefined,
    GetOpenedFile: () => null,
    CheckUserId: () => 'local-user',
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

  function findFrameOrFail() {
    const frame = findEditorFrame() || desktopApi._editorWindow
    if (!frame) throw new Error('editor iframe with Asc/AscCommon not found')
    return frame
  }

  async function openBin(result) {
    const frame = findFrameOrFail()
    state.docId = result.docId
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
    log('info', 'openDocument called with Editor.bin', { docId: result.docId, binBytes: bytes.length })
  }

  async function openConfigured() {
    try {
      state.config = await window.dbHost.getConfig()
      state.timings.openRequested = performance.now()
      const result = await window.dbHost.open()
      await openBin(result)
      return true
    } catch (error) {
      log('error', 'open failed', String(error && error.stack || error))
      setState('error')
      throw error
    }
  }

  function apiSummary(Api) {
    const names = ['GetDocument', 'CreateParagraph', 'CreateTable', 'CreateRun', 'CreateRange']
    const methods = {}
    for (const name of names) methods[name] = typeof Api[name] === 'function'
    return methods
  }

  function runBuilderScript() {
    const frame = findFrameOrFail()
    const Api = frame.AscBuilder && frame.AscBuilder.Word && frame.AscBuilder.Word.Api
    if (!Api) throw new Error('AscBuilder.Word.Api is missing in the editor frame')
    const editor = frame.Asc.editor
    const used = []
    const mark = (name) => used.push(name)
    const result = {
      api: 'AscBuilder.Word.Api',
      available: apiSummary(Api),
      steps: [],
    }

    // The builder service brackets a script with these two editor hooks so the
    // engine treats the whole script as one history action.
    let builderHooks = false
    try {
      builderHooks = typeof editor.canRunBuilderScript === 'function' && editor.canRunBuilderScript()
    } catch (error) {
      log('warn', 'canRunBuilderScript failed', String(error && error.message || error))
    }
    result.steps.push({ step: 'canRunBuilderScript', value: builderHooks })

    try {
      const doc = Api.GetDocument()
      mark('Api.GetDocument')
      result.steps.push({ step: 'GetDocument', classType: doc.GetClassType() })

      const paragraphs = doc.GetAllParagraphs()
      mark('ApiDocument.GetAllParagraphs')
      const texts = paragraphs.map((p) => {
        mark('ApiParagraph.GetText')
        return p.GetText({ Numbering: false, Math: false })
      })
      result.paragraphsBefore = texts.length
      result.textsBefore = texts

      let replacedIndex = texts.findIndex((text) => text.includes('seeks entry of an ex parte'))
      if (replacedIndex === -1) replacedIndex = texts.reduce((best, text, index) => (text.length > texts[best].length ? index : best), 0)
      if (replacedIndex === -1 || paragraphs.length === 0) throw new Error('no paragraph available to replace')
      const target = paragraphs[replacedIndex]
      result.replacedIndex = replacedIndex
      result.replacedTextBefore = texts[replacedIndex]

      target.RemoveAllElements()
      mark('ApiParagraph.RemoveAllElements')
      target.AddText(REPLACED)
      mark('ApiParagraph.AddText')
      result.replacedTextAfter = target.GetText({ Numbering: false, Math: false })
      result.steps.push({ step: 'replaceParagraph', index: replacedIndex })

      // Insert a bulleted list item at the end of the document. The numbering
      // definition is created through the public builder API so it serializes
      // into word/numbering.xml.
      const numbering = doc.CreateNumbering('bullet')
      mark('ApiDocument.CreateNumbering')
      const level = numbering.GetLevel(0)
      mark('ApiNumbering.GetLevel')
      const item = Api.CreateParagraph()
      mark('Api.CreateParagraph')
      item.AddText(LIST_ITEM)
      mark('ApiParagraph.AddText')
      item.SetNumbering(level)
      mark('ApiParagraph.SetNumbering')
      const pushed = doc.Push(item)
      mark('ApiDocumentContent.Push')
      result.list = { pushed, text: item.GetText({ Numbering: false, Math: false }) }
      result.steps.push({ step: 'insertListItem', pushed })

      // Add one row to the fixture's existing table (or create a table if the
      // document has none) and write text into its first cell.
      let tables = doc.GetAllTables()
      mark('ApiDocumentContent.GetAllTables')
      let table = tables[0]
      let createdTable = false
      if (!table) {
        table = Api.CreateTable(2, 1)
        mark('Api.CreateTable')
        doc.Push(table)
        createdTable = true
      }
      result.tablesBefore = tables.map((t) => t.GetRowsCount())
      const rowsBefore = table.GetRowsCount()
      const row = table.AddRow()
      mark('ApiTable.AddRow')
      const rowIndex = table.GetRowsCount() - 1
      const cell = row.GetCell(0)
      mark('ApiTableRow.GetCell')
      const cellParagraph = cell.GetContent().GetElement(0)
      mark('ApiTableCell.GetContent')
      mark('ApiDocumentContent.GetElement')
      if (cellParagraph) {
        cellParagraph.AddText(TABLE_ROW)
        mark('ApiParagraph.AddText')
      }
      result.table = {
        createdTable,
        rowsBefore,
        rowsAfter: table.GetRowsCount(),
        rowIndex,
        cellText: cellParagraph ? cellParagraph.GetText({ Numbering: false, Math: false }) : null,
      }
      result.steps.push({ step: 'insertTableRow', rowsBefore, rowsAfter: result.table.rowsAfter })

      result.paragraphsAfter = doc.GetAllParagraphs().length
      result.tablesAfter = doc.GetAllTables().map((t) => t.GetRowsCount())
      result.markers = { replaced: REPLACED, list: LIST_ITEM, tableRow: TABLE_ROW }
      result.usedMethods = Array.from(new Set(used))
    } finally {
      try {
        if (typeof editor.onEndBuilderScript === 'function') {
          editor.onEndBuilderScript(function (change) {
            result.steps.push({ step: 'onEndBuilderScript', change: change === undefined ? null : String(change) })
          })
          builderHooks = true
        }
      } catch (error) {
        log('warn', 'onEndBuilderScript failed', String(error && error.message || error))
      }
      result.builderHooks = builderHooks
      setState('edited')
      log('info', 'builder script complete', { replacedIndex: result.replacedIndex, usedMethods: result.usedMethods })
    }
    return result
  }

  function saveBase64() {
    const frame = findFrameOrFail()
    const data = frame.Asc.editor.asc_nativeGetFile()
    if (!data) throw new Error('asc_nativeGetFile returned no data')
    const bytes = toBytes(data)
    log('info', 'serialized document', {
      bytes: bytes.length,
      type: typeof data,
      valueLength: typeof data === 'string' || (data && typeof data.length === 'number') ? data.length : null,
    })
    return bytesToBase64(bytes)
  }

  function createEditor() {
    const config = {
      type: 'desktop',
      width: '100%',
      height: '100%',
      documentType: 'word',
      document: {
        title: 'TRO-Motion.docx',
        url: '_offline_',
        fileType: 'docx',
        key: 'docbuilder-' + Date.now(),
        permissions: { edit: true, download: true, print: true },
      },
      editorConfig: {
        mode: 'edit',
        lang: 'en',
        targetApp: 'desktop',
        user: { id: 'local-user', name: 'Local User' },
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
    log('info', 'DocEditor constructed')
  }

  window.addEventListener('error', (event) => {
    log('error', 'window.error', { message: event.message, filename: event.filename, line: event.lineno })
  })
  window.addEventListener('unhandledrejection', (event) => {
    log('error', 'unhandledrejection', String((event.reason && (event.reason.stack || event.reason.message)) || event.reason))
  })

  window.__db = {
    get state() { return state.state },
    get timings() { return state.timings },
    get calls() { return state.calls },
    openConfigured,
    runBuilderScript,
    saveBase64,
    findEditorFrame,
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createEditor)
  } else {
    createEditor()
  }
})()
