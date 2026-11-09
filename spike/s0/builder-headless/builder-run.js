/**
 * Headless Document Builder spike driver.
 *
 * Runs inside the host page after boot.js opens TRO - Motion.docx in the
 * Euro-Office Lite editor (headless Chromium). It reaches into the editor
 * frame, takes the official sdkjs Document Builder API
 * (`AscBuilder.Word.Api`, the same object `Asc.editor.getJsApi()` returns),
 * edits a paragraph, inserts a numbered list item, inserts a table row,
 * serializes Editor.bin with `asc_nativeGetFile()` and posts the evidence to
 * the spike server. The server converts Editor.bin back to DOCX with x2t and
 * writes result.json.
 */
(function () {
  'use strict'

  var API = '/workspace-editor/api'
  var startStamp = Date.now()
  var result = {
    status: 'FAIL',
    apiSurface: {},
    steps: [],
    error: null,
    totalMs: 0,
  }

  function log(message) {
    try { console.log('[builder-headless] ' + message) } catch (e) {}
    try { fetch(API + '/log', { method: 'POST', body: String(message), keepalive: true }) } catch (e) {}
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms) })
  }

  function findEditorWindow(win, depth) {
    if (depth > 6 || !win) return null
    try {
      if (win.AscCommon && win.Asc && win.Asc.editor) return win
    } catch (e) {}
    var frames = []
    try { frames = win.frames } catch (e) { return null }
    for (var i = 0; i < frames.length; i += 1) {
      var found = findEditorWindow(frames[i], depth + 1)
      if (found !== null) return found
    }
    return null
  }

  /** Wait until the editor frame carries the builder API and an open document. */
  async function waitForBuilder(deadlineMs) {
    var started = Date.now()
    while (Date.now() - started < deadlineMs) {
      var ew = findEditorWindow(window, 0)
      if (ew !== null) {
        try {
          var editor = ew.Asc.editor
          var logic = editor.WordControl && editor.WordControl.m_oLogicDocument
          var builder = ew.AscBuilder && ew.AscBuilder.Word && ew.AscBuilder.Word.Api
          if (logic && builder) return { ew: ew, editor: editor, api: builder }
        } catch (e) {}
      }
      await sleep(100)
    }
    throw new Error('editor frame never exposed AscBuilder.Word.Api with an open document')
  }

  /** Wait until the loaded document is queryable and stable. */
  async function waitForContent(api, deadlineMs) {
    var started = Date.now()
    var previous = -1
    var stable = 0
    while (Date.now() - started < deadlineMs) {
      try {
        var count = api.GetDocument().GetAllParagraphs().length
        if (count > 3 && count === previous) stable += 1
        else stable = 0
        previous = count
        if (stable >= 3) return count
      } catch (e) {}
      await sleep(100)
    }
    throw new Error('document content did not become queryable in time')
  }

  /** sdkjs returns an ASCII string (header + base64 body) for Editor.bin. */
  function toBytes(data) {
    if (typeof data === 'string') {
      var bytes = new Uint8Array(data.length)
      for (var i = 0; i < data.length; i += 1) bytes[i] = data.charCodeAt(i) & 0xFF
      return bytes
    }
    var copy = new Uint8Array(data.length)
    for (var j = 0; j < data.length; j += 1) copy[j] = data[j]
    return copy
  }

  function step(name, value) {
    var elapsed = Date.now() - startStamp
    result.steps.push({ name: name, ms: elapsed, value: value })
    log(name + ': ' + JSON.stringify(value))
  }

  function stepValue(name) {
    for (var i = 0; i < result.steps.length; i += 1) {
      if (result.steps[i].name === name) return result.steps[i].value
    }
    return null
  }

  async function postResult() {
    result.totalMs = Date.now() - startStamp
    window.__builderResult = result
    try {
      await fetch(API + '/result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(result),
      })
    } catch (e) {}
    log('RESULT ' + JSON.stringify(result).slice(0, 4000))
  }

  async function run() {
    try {
      var opened = await waitForBuilder(120000)
      var ew = opened.ew
      var editor = opened.editor
      var api = opened.api
      step('builder-api-found', {
        hasAscBuilder: typeof ew.AscBuilder === 'object',
        hasWord: !!(ew.AscBuilder && ew.AscBuilder.Word),
        sameAsEditorJsApi: editor.getJsApi() === api,
      })

      result.apiSurface = {
        GetDocument: typeof api.GetDocument,
        CreateParagraph: typeof api.CreateParagraph,
        CreateTable: typeof api.CreateTable,
        CreateNumbering: typeof api.CreateNumbering,
        Save: typeof api.Save,
        documentCreateNumbering: typeof api.GetDocument().CreateNumbering,
        paragraphSetNumbering: typeof api.CreateParagraph().SetNumbering,
        tableAddRow: typeof api.CreateTable(1, 1).AddRow,
        asc_nativeGetFile: typeof editor.asc_nativeGetFile,
      }
      step('api-surface', result.apiSurface)

      var paragraphs = await waitForContent(api, 60000)
      step('content-ready', { paragraphs: paragraphs })

      // --- 1. edit one paragraph -------------------------------------------
      var doc = api.GetDocument()
      var allParas = doc.GetAllParagraphs()
      var target = null
      for (var i = 0; i < allParas.length; i += 1) {
        if (allParas[i].GetText && allParas[i].GetText().indexOf('seeks entry') !== -1) { target = allParas[i]; break }
      }
      if (target === null) target = allParas[Math.min(2, allParas.length - 1)]
      var textBefore = target.GetText()
      target.AddText(' [BUILDER-HEADLESS-EDIT]')
      step('paragraph-edited', {
        before: textBefore.slice(0, 90),
        after: target.GetText().slice(0, 130),
        containsMarker: target.GetText().indexOf('BUILDER-HEADLESS-EDIT') !== -1,
      })

      // --- 2. insert a numbered list item ----------------------------------
      var numbering = doc.CreateNumbering('ArabicPeriod')
      var item = api.CreateParagraph()
      item.AddText('BUILDER-HEADLESS-LIST-ITEM')
      var numberingSet = item.SetNumbering(numbering.GetLevel(0))
      var pushed = doc.Push(item)
      step('list-item-inserted', {
        numberingCreated: numbering !== null && numbering !== undefined,
        numberingSet: numberingSet,
        pushed: pushed,
        text: item.GetText(),
        hasNumbering: item.GetNumbering() !== null,
      })

      // --- 3. insert a row into the existing table -------------------------
      var tables = doc.GetAllTables()
      var tableRows = null
      if (tables.length > 0) {
        var table = tables[0]
        var rowsBefore = table.GetRowsCount()
        var addedRow = table.AddRow()
        var cell = addedRow.GetCell(0)
        var cellPara = cell.GetContent().GetElement(0)
        cellPara.AddText('BUILDER-HEADLESS-TABLE-ROW')
        tableRows = {
          rowsBefore: rowsBefore,
          rowsAfter: table.GetRowsCount(),
          rowText: cellPara.GetText(),
          inserted: table.GetRowsCount() === rowsBefore + 1,
        }
      } else {
        tableRows = { error: 'no table found in source document' }
      }
      step('table-row-inserted', tableRows)

      // --- 4. serialize Editor.bin and save through x2t --------------------
      var raw = editor.asc_nativeGetFile()
      var bytes = toBytes(raw)
      step('serialized', { rawType: typeof raw, bytes: bytes.length })
      var saveResponse = await fetch(API + '/save', { method: 'POST', body: bytes })
      var saved = saveResponse.ok ? await saveResponse.json() : { error: await saveResponse.text() }
      step('saved', saved)

      var apiFound = stepValue('builder-api-found') || {}
      var surface = stepValue('api-surface') || {}
      var edited = stepValue('paragraph-edited') || {}
      var list = stepValue('list-item-inserted') || {}
      var rows = stepValue('table-row-inserted') || {}
      var save = stepValue('saved') || {}
      result.status = (
        apiFound.sameAsEditorJsApi === true
        && surface.paragraphSetNumbering === 'function'
        && surface.tableAddRow === 'function'
        && edited.containsMarker === true
        && list.hasNumbering === true
        && rows.inserted === true
        && save.path !== undefined
      ) ? 'PASS' : 'FAIL'

      await postResult()
    } catch (error) {
      result.error = {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? (error.stack || '').slice(0, 2000) : '',
      }
      result.status = 'FAIL'
      log('FAIL ' + result.error.message)
      await postResult()
    }
  }

  if (document.readyState === 'complete') setTimeout(run, 0)
  else window.addEventListener('load', function () { setTimeout(run, 0) })
})()
