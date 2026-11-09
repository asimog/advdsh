/**
 * AscDesktopEditor for the workspace editor: the members sdkjs calls in a
 * desktop host, answered over the plugin's HTTP routes instead of Tauri.
 *
 * Loaded before web-apps/apps/api/documents/api.js. Every other member
 * resolves to a no-op promise and never rejects, because sdkjs calls some of
 * them on every keystroke.
 */
(function () {
  'use strict'

  var params = new URLSearchParams(window.location.search)
  var docId = params.get('doc') || ''
  var API = '/workspace-editor/api'
  var eventState = { dirty: false }

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
    window.AscDesktopEditor._isModified = modified
    try {
      fetch(API + '/modified?id=' + encodeURIComponent(docId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modified: modified }),
      })
    } catch (e) {}
  }

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
      var url = API + (isSaveAs ? '/save-as?id=' : '/save?id=') + encodeURIComponent(docId)
      var response = await fetch(url, { method: 'POST', body: bytes })
      if (!response.ok) {
        log('save failed: ' + response.status + ' ' + (await response.text().catch(function () { return '' })))
        return
      }
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
})()
