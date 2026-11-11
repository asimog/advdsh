/**
 * AscDesktopEditor for the workspace editor: the members sdkjs calls in a
 * desktop host, answered over the plugin's HTTP routes instead of Tauri.
 *
 * The same file is the host-page bridge: it reports editor state (unsaved
 * changes, loaded revision) to `POST /api/editor`, carries the base revision on
 * saves, executes review commands the host sends over
 * `GET /workspace-editor/events` or `postMessage`, and reloads a clean editor
 * when `ctx.editorDocuments` publishes a new revision.
 *
 * Loaded before web-apps/apps/api/documents/api.js. Every other AscDesktopEditor
 * member resolves to a no-op promise and never rejects, because sdkjs calls
 * some of them on every keystroke.
 */
(function () {
  'use strict'

  var params = new URLSearchParams(window.location.search)
  var docId = params.get('doc') || ''
  var sessionId = params.get('session') || ''
  var hostPath = params.get('path') || ''
  function sessionQuery() { return sessionId === '' ? '' : '?session=' + encodeURIComponent(sessionId) }
  function sessionAmp() { return sessionId === '' ? '' : '&session=' + encodeURIComponent(sessionId) }
  var API = '/workspace-editor/api'
  var EVENTS = '/workspace-editor/events'
  var eventState = { dirty: false }
  /** Facts the host page and the save path share: open path, loaded revision, unsaved changes. */
  var hostState = { docId: docId, path: '', revision: '', dirty: false, saving: false }
  window.__wsHost = hostState

  function log(message) {
    try { console.log('[workspace-editor] ' + message) } catch (e) {}
    try {
      fetch(API + '/log', { method: 'POST', body: String(message), keepalive: true })
    } catch (e) {}
  }

  window._wsLog = log

  /** Host facts sdkjs reads synchronously (`nativevars`); the browser owns the rest. */
  window.RendererProcessVariable = {
    theme: { system: 'light' },
    localthemes: [],
    defaultPrinterName: '',
    isRtl: false,
  }

  function findEditorWindow(win) {
    try { if (win.AscCommon) return win } catch (e) {}
    for (var i = 0; i < win.frames.length; i += 1) {
      var found = findEditorWindow(win.frames[i])
      if (found) return found
    }
    return null
  }

  function getEditor() {
    var ew = window.AscDesktopEditor._editorWindow || findEditorWindow(window)
    if (ew) window.AscDesktopEditor._editorWindow = ew
    return { ew: ew, editor: ew && ew.Asc && ew.Asc.editor }
  }

  /** Report the state the open tab claims; `setEditorState` broadcasts an editor frame on change. */
  function reportState(attempt) {
    if (docId === '') return
    var tries = typeof attempt === 'number' ? attempt : 0
    try {
      fetch(API + '/editor' + sessionQuery(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: docId, modified: eventState.dirty, revision: hostState.revision }),
      }).then(function (response) {
        if (!response.ok && tries < 3) {
          setTimeout(function () { reportState(tries + 1) }, 250 * (tries + 1))
        }
      }).catch(function () {
        if (tries < 3) setTimeout(function () { reportState(tries + 1) }, 250 * (tries + 1))
      })
    } catch (e) {}
  }

  /** Read the open document's path and revision once; the tab cannot save without a base. */
  function refreshInfo() {
    if (docId === '') return Promise.resolve(undefined)
    return fetch(API + '/info?id=' + encodeURIComponent(docId) + sessionAmp())
      .then(function (response) {
        return response.ok ? response.json() : undefined
      })
      .then(function (info) {
        if (!info) return undefined
        if (typeof info.path === 'string') hostState.path = info.path
        if (typeof info.revision === 'string') hostState.revision = info.revision
        if (typeof info.modified === 'boolean') hostState.dirty = info.modified
        reportState()
        return info
      })
      .catch(function () { return undefined })
  }

  function toBytes(data) {
    // sdkjs hands over a binary string: one char per byte, not base64.
    if (typeof data === 'string') {
      var bytes = new Uint8Array(data.length)
      for (var i = 0; i < data.length; i += 1) bytes[i] = data.charCodeAt(i) & 0xFF
      return bytes
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    var copy = new Uint8Array(data.length)
    for (var j = 0; j < data.length; j += 1) copy[j] = data[j]
    return copy
  }

  function reportModified(modified) {
    eventState.dirty = modified
    hostState.dirty = modified
    window.AscDesktopEditor._isModified = modified
    reportState()
  }

  /** Show a host-page banner; a conflict banner reloads the new revision on click. */
  function showStatus(message, action) {
    var status = document.getElementById('status')
    if (!status) return
    status.textContent = ''
    var text = document.createElement('div')
    text.textContent = message
    status.appendChild(text)
    status.classList.add('active')
    status.style.cursor = action === undefined ? 'default' : 'pointer'
    if (action !== undefined) {
      status.title = action.label
      status.addEventListener('click', action.run, { once: true })
    }
  }

  function hideStatus() {
    var status = document.getElementById('status')
    if (!status) return
    status.textContent = ''
    status.classList.remove('active')
  }

  function reportConflict(message) {
    log('conflict: ' + message)
    try {
      window.parent.postMessage({ type: 'workspace-editor/conflict', message: message }, window.location.origin)
    } catch (e) {}
    showStatus(message + ' Reload to work on the current revision.', {
      label: 'Reload',
      run: function () { window.location.reload() },
    })
  }

  /**
   * Execute one review command through the editor API. Accept/reject commands
   * change the editor buffer; the lawyer saves through the normal save path.
   */
  var DISPLAY_MODES = { final: 'Final', original: 'Original', simple: 'Simple', edit: 'Edit' }
  function execReviewCommand(command, args) {
    var ref = getEditor()
    if (!ref.editor) return { ok: false, error: 'editor API is not ready' }
    var editor = ref.editor
    try {
      if (command === 'acceptAll') editor.asc_AcceptAllChanges()
      else if (command === 'rejectAll') editor.asc_RejectAllChanges()
      else if (command === 'acceptSelection') editor.asc_AcceptChangesBySelection()
      else if (command === 'rejectSelection') editor.asc_RejectChangesBySelection()
      else if (command === 'nextChange') editor.asc_GetNextRevisionsChange()
      else if (command === 'prevChange') editor.asc_GetPrevRevisionsChange()
      else if (command === 'trackChanges') editor.asc_SetTrackRevisions(args !== false)
      else if (command === 'displayMode') {
        var mode = DISPLAY_MODES[String(args)]
        var Asc = ref.ew && ref.ew.Asc
        if (mode === undefined || !Asc || !Asc.c_oAscDisplayModeInReview) {
          return { ok: false, error: 'unknown display mode: ' + String(args) }
        }
        editor.asc_SetDisplayModeInReview(Asc.c_oAscDisplayModeInReview[mode])
      } else if (command === 'save') {
        if (typeof window.AscDesktopEditor.LocalFileSave === 'function') window.AscDesktopEditor.LocalFileSave('')
      } else if (command === 'reload') {
        window.location.reload()
        return { ok: true }
      } else {
        return { ok: false, error: 'unknown command: ' + String(command) }
      }
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) }
    }
    return { ok: true }
  }

  /** One command from the events channel or the parent tab. */
  function handleCommand(frame) {
    if (frame === null || typeof frame !== 'object') return
    if (typeof frame.id === 'string' && frame.id !== '' && frame.id !== docId) return
    if (typeof frame.path === 'string' && frame.path !== '' && hostState.path !== '' && frame.path !== hostState.path) return
    var result = execReviewCommand(frame.command, frame.args)
    if (!result.ok) log('review command failed: ' + result.error)
    try {
      fetch(API + '/editor' + sessionQuery(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: docId, revision: hostState.revision, command: frame.command, ok: result.ok, requestId: frame.requestId, changeCount: 0 }),
      })
    } catch (e) {}
  }

  /** A published document revision: reload only while the editor holds no unsaved work. */
  function handleDocument(frame) {
    var doc = frame.document
    if (!doc || (typeof doc.id === 'string' && doc.id !== docId)) return
    if (frame.source === 'close') return
    if (typeof doc.revision !== 'string') return
    if (doc.revision === hostState.revision) return
    if (frame.reload !== true) {
      // Our own save: the response and this frame race, so the reply may not
      // have updated the base yet. Any other write without a reload leaves the
      // open buffer stale, which a save must not overwrite.
      if (hostState.saving && frame.source === 'save') {
        hostState.revision = doc.revision
        return
      }
      if (frame.source === 'open') return
      reportConflict('The document was saved by another writer.')
      return
    }
    if (hostState.dirty || window.AscDesktopEditor._isModified) {
      showStatus('The document changed on disk; the editor has unsaved changes. Save, then reload.', {
        label: 'Reload',
        run: function () { window.location.reload() },
      })
      return
    }
    window.location.reload()
  }

  /** Editor state reports change the dirty flag only; the base stays what this tab loaded. */
  function handleEditor(frame) {
    var doc = frame.document
    if (!doc || (typeof doc.id === 'string' && doc.id !== docId)) return
    if (typeof doc.modified === 'boolean') hostState.dirty = doc.modified
  }

  function subscribeEvents() {
    if (typeof EventSource !== 'function' || docId === '') return
    var source = new EventSource(EVENTS + sessionQuery())
    source.onmessage = function (event) {
      var frame
      try { frame = JSON.parse(event.data) } catch (e) { return }
      if (frame === null || typeof frame !== 'object') return
      if (frame.type === 'snapshot') {
        var documents = Array.isArray(frame.documents) ? frame.documents : []
        for (var i = 0; i < documents.length; i += 1) handleEditor({ document: documents[i] })
        return
      }
      if (frame.type === 'command') handleCommand(frame)
      else if (frame.type === 'document') handleDocument(frame)
      else if (frame.type === 'editor') handleEditor(frame)
      else if (frame.type === 'conflict') {
        var framePath = typeof frame.path === 'string' ? frame.path : ''
        if (hostPath !== '' && framePath !== '' && framePath.toLowerCase() !== hostPath.toLowerCase()) return
        reportConflict(frame.message || 'The document changed on disk.')
      }
    }
    // EventSource reconnects on its own; the snapshot frame follows every new connection.
    source.onerror = function () {}
  }

  // The tab may also address this frame directly, without the HTTP round trip.
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return
    if (event.origin !== window.location.origin) return
    var data = event.data
    if (data === null || typeof data !== 'object' || data.type !== 'workspace-editor/command') return
    handleCommand({ id: docId, command: data.command, args: data.args })
  })

  var shim = {
    _editorWindow: null,
    _currentDocType: 'word',
    _isModified: false,

    IsLocalFile: function () { return true },
    LocalFileGetSourcePath: function () { return '' },
    CheckUserId: function () { return 'local-user' },
    getViewportSettings: function () { return { widgetType: 'window' } },
    isSupportBinaryFontsSprite: false,

    CreateEditorApi: function () {
      try {
        var frames = document.querySelectorAll('iframe')
        for (var i = 0; i < frames.length; i += 1) {
          try {
            if (frames[i].contentWindow && frames[i].contentWindow.Asc) {
              window.AscDesktopEditor._editorWindow = frames[i].contentWindow
              break
            }
          } catch (e) {}
        }
      } catch (e) {}
    },

    /** The host page opens the document itself, in boot.js. */
    LocalStartOpen: function () {},

    /** One document per tab: an open request from inside the editor is refused. */
    LocalFileOpen: function () {
      log('open is not available inside a document tab')
    },

    LocalFileSave: async function (param) {
      var isSaveAs = typeof param === 'string' && param.indexOf('saveas=true') !== -1
      var ref = getEditor()
      if (!ref.editor) {
        log('save aborted: editor API not found')
        return
      }
      var bytes = toBytes(ref.editor.asc_nativeGetFile())
      if (bytes.length === 0) {
        log('save aborted: editor returned no bytes')
        return
      }
      var base = hostState.revision
      var url = API + (isSaveAs ? '/save-as?id=' : '/save?id=') + encodeURIComponent(docId)
      if (base !== '') url += '&base=' + encodeURIComponent(base)
      hostState.saving = true
      var response
      try {
        response = await fetch(url, { method: 'POST', body: bytes })
      } catch (error) {
        hostState.saving = false
        log('save failed: ' + String(error && error.message ? error.message : error))
        return
      }
      if (!response.ok) {
        hostState.saving = false
        var failure = await response.json().catch(function () { return {} })
        var detail = typeof failure.error === 'string' ? failure.error : 'save failed (' + response.status + ')'
        if (response.status === 409) reportConflict(detail)
        else log(detail)
        return
      }
      var saved = await response.json().catch(function () { return {} })
      hostState.saving = false
      // Save As writes another file: the open document keeps its own revision.
      if (!isSaveAs && typeof saved.revision === 'string') hostState.revision = saved.revision
      hideStatus()
      reportModified(false)
    },

    LocalFileGetSaved: function () { return true },
    LocalFileGetModified: function () { return window.AscDesktopEditor._isModified },
    LocalFileSetModified: function (modified) { reportModified(!!modified) },
    LocalFileGetOpenChangesCount: function () { return 0 },
    LocalFileSaveChanges: function () {},

    /** Inserted images resolve against this document's own media folder. */
    LocalFileGetImageUrl: function (url) {
      if (typeof url !== 'string' || url.length === 0) return url
      if (url.indexOf('data:') === 0 || url.indexOf('blob:') === 0) return url
      if (url.indexOf('/workspace-editor/api/media/') === 0) return url
      return API + '/media/' + encodeURIComponent(docId) + '/' + encodeURIComponent(url.replace(/^.*[\\/]/, ''))
    },

    onDocumentModifiedChanged: function (modified) { reportModified(!!modified) },
    SetDocumentName: function () {},
    execCommand: function () {},
    getDocumentModified: function () { return eventState.dirty },

    // Synchronous probes sdkjs reads during startup; a promise here breaks
    // JSON parsing and mode selection.
    GetInstallPlugins: function () {
      return JSON.stringify([{ url: '', pluginsData: [] }, { url: '', pluginsData: [] }])
    },
    IsSignaturesSupport: function () { return false },
    IsProtectionSupport: function () { return false },
    IsSupportNativePrint: function () { return true },
    // No host scale list: sdkjs would apply its DPI correction to an empty
    // list, which is the "leave the CSS scale alone" outcome we want.
    GetSupportedScaleValues: function () { return [] },
    isBlockchainSupport: function () { return false },
    PreloadCryptoImage: function () { return '' },
    LoadFontBase64: function () { return null },
    Print: function () {},
    _pendingPrinter: null,
  }

  // Unknown members are harmless no-ops: sdkjs probes optional desktop APIs.
  window.AscDesktopEditor = new Proxy(shim, {
    get: function (target, property) {
      if (property in target) return target[property]
      if (typeof property === 'symbol') return undefined
      return function () { return Promise.resolve(undefined) }
    },
  })

  // The host page runs after this script (api.js and boot.js follow), so the
  // subscription and the revision read start at load, after the document exists.
  function startHostBridge() {
    refreshInfo()
    subscribeEvents()
  }
  if (document.readyState === 'complete') startHostBridge()
  else window.addEventListener('load', startHostBridge)
  window._wsExecReviewCommand = execReviewCommand
  window._wsGetEditor = getEditor
})()
