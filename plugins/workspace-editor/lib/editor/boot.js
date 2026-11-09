/**
 * Boot one document in the editor: mount DocsAPI.DocEditor in desktop mode and
 * hand the editor the bytes the host prepared (Editor.bin for Word documents).
 */
(function () {
  'use strict'

  var params = new URLSearchParams(window.location.search)
  var docId = params.get('doc') || ''
  var API = '/workspace-editor/api'
  var status = document.getElementById('status')

  function log(message) {
    if (typeof window._wsLog === 'function') window._wsLog(message)
  }

  function show(message) {
    if (!status) return
    status.textContent = message
    status.classList.add('active')
  }

  function hide() {
    if (!status) return
    status.textContent = ''
    status.classList.remove('active')
  }

  window.addEventListener('error', function (event) {
    log('page error: ' + (event && event.message ? event.message : 'unknown'))
  })
  window.addEventListener('unhandledrejection', function (event) {
    log('unhandled rejection: ' + (event && event.reason ? event.reason : 'unknown'))
  })

  function findEditorWindow() {
    var frames = document.querySelectorAll('iframe')
    for (var i = 0; i < frames.length; i += 1) {
      try {
        var ew = frames[i].contentWindow
        if (ew && ew.AscCommon) return ew
      } catch (e) {}
    }
    return null
  }

  /**
   * sdkjs loads font bytes from the desktop host's custom protocol
   * (`ascdesktop://fonts/<id>`). Serve them over HTTP instead: bundled names
   * from the frontend fonts folder, absolute paths from the system font file.
   */
  function patchFonts(win) {
    var fonts = win.AscFonts
    if (!fonts || !fonts.CFontFileLoader) return false
    var proto = fonts.CFontFileLoader.prototype

    proto.LoadFontAsync = function (basePath, callback) {
      this.callback = callback
      if (this.Status !== -1) return true
      this.Status = 2
      var id = String(this.Id).replace(/^[/\\]\?[/\\]?/, '')
      var bare = /^[^\\/]+$/.test(id)
      var url = bare
        ? '/workspace-editor/app/fonts/' + encodeURIComponent(id)
        : '/workspace-editor/api/font?path=' + encodeURIComponent(id)
      var xhr = new win.XMLHttpRequest()
      xhr.fontFile = this
      xhr.open('GET', url, true)
      xhr.responseType = 'arraybuffer'
      xhr.onload = function () {
        if (this.status !== 200) {
          this.fontFile.Status = 1
          return
        }
        this.fontFile.Status = 0
        var data = new Uint8Array(this.response)
        var streams = fonts.g_fonts_streams
        var index = streams.length
        streams[index] = new fonts.FontStream(data, data.length)
        this.fontFile.SetStreamIndex(index)
        if (this.fontFile.callback != null) this.fontFile.callback()
        if (this.fontFile.externalCallback) this.fontFile.externalCallback()
      }
      xhr.send(null)
      return false
    }
    proto['LoadFontAsync'] = proto.LoadFontAsync

    var files = fonts.g_font_files || []
    log('fonts patched: ' + files.length + ' entries (loaded on demand)')
    return true
  }

  /**
   * Wait until the editor frame exposes AscCommon and its document URLs, which
   * is the point the release build can accept `openDocument`.
   */
  function waitForEditor(deadline) {
    return new Promise(function (resolve, reject) {
      var started = Date.now()
      var timer = setInterval(function () {
        var ew = findEditorWindow()
        if (ew && ew.Asc && ew.Asc.editor && ew.AscCommon && ew.AscCommon.g_oDocumentUrls) {
          clearInterval(timer)
          resolve(ew)
          return
        }
        if (Date.now() - started > deadline) {
          clearInterval(timer)
          reject(new Error('editor frame did not become ready'))
        }
      }, 100)
    })
  }

  /**
   * sdkjs reads AscDesktopEditor from the editor frame it runs in, not from this
   * page, so the same object is placed on every descendant frame as it appears.
   * The object answers unknown members itself, which a shallow copy would lose.
   */
  /**
   * sdkjs asks the desktop host for font bytes over its own protocol
   * (`ascdesktop://fonts/<id>`). Rewrite those requests to this plugin's HTTP
   * routes, in whichever frame issues them, for both frontend builds.
   */
  function mapProtocolUrl(url) {
    if (url.indexOf('ascdesktop://') !== 0) return url
    var rest = url.slice('ascdesktop://'.length)
    if (rest.indexOf('fonts/') === 0) {
      var id = rest.slice('fonts/'.length).replace(/^[/\\]\?[/\\]?/, '')
      if (/^[A-Za-z]:[\\/]/.test(id) || id.charAt(0) === '/') {
        return '/workspace-editor/api/font?path=' + encodeURIComponent(id)
      }
      return '/workspace-editor/app/fonts/' + encodeURIComponent(id)
    }
    if (rest.indexOf('abs/') === 0) {
      return '/workspace-editor/api/font?path=' + encodeURIComponent(rest.slice(4))
    }
    return url
  }

  function patchProtocol(win) {
    try {
      var proto = win.XMLHttpRequest && win.XMLHttpRequest.prototype
      if (!proto || proto.__wsProtocolPatched) return
      var open = proto.open
      proto.open = function (method, url) {
        var args = Array.prototype.slice.call(arguments)
        args[1] = mapProtocolUrl(String(url))
        return open.apply(this, args)
      }
      proto.__wsProtocolPatched = true
    } catch (e) {}
  }

  /** The editor API lives in one frame; this page reaches it across same-origin frames. */
  function editorApi() {
    try {
      var ew = (window.AscDesktopEditor && window.AscDesktopEditor._editorWindow) || findEditorWindow(window)
      if (ew && ew.Asc && ew.Asc.editor && typeof ew.Asc.editor.asc_GetSelectedText === 'function') {
        return { win: ew, api: ew.Asc.editor }
      }
    } catch (e) {}
    return null
  }

  /**
   * Translate a frame-viewport point into the host page's viewport: add each
   * ancestor frame's border-box origin while walking up to this window.
   */
  function toHostPoint(win, x, y) {
    var point = { x: x, y: y }
    var cursor = win
    for (var depth = 0; depth < 16; depth += 1) {
      if (!cursor || cursor === window) break
      var frame = null
      try { frame = cursor.frameElement } catch (e) { break }
      if (!frame) break
      var rect = frame.getBoundingClientRect()
      point.x += rect.left
      point.y += rect.top
      cursor = cursor.parent
    }
    return point
  }

  /**
   * Relay a non-empty selection to the host page. Empty selections keep
   * EuroOffice's native menu.
   */
  function onContextMenu(win, event) {
    var found = editorApi()
    if (!found) return
    var text = ''
    try { text = found.api.asc_GetSelectedText(false) } catch (e) { return }
    if (typeof text !== 'string' || text.trim() === '') return
    event.preventDefault()
    var dirty = false
    try {
      dirty = !!(window.AscDesktopEditor && window.AscDesktopEditor._isModified)
      if (!dirty && typeof found.api.isDocumentModified === 'function') {
        dirty = found.api.isDocumentModified() === true
      }
    } catch (e) {}
    var point = toHostPoint(win, event.clientX, event.clientY)
    try {
      window.parent.postMessage({
        type: 'workspace-editor/selection',
        x: point.x,
        y: point.y,
        text: text,
        dirty: dirty,
      }, window.location.origin)
    } catch (e) {}
  }

  /** One listener per frame document; `injectInto` revisits the same frames. */
  function installSelectionListener(win) {
    var doc = null
    try { doc = win.document } catch (e) { return }
    if (!doc || doc.__wsSelectionBound) return
    doc.__wsSelectionBound = true
    doc.addEventListener('contextmenu', function (event) {
      onContextMenu(win, event)
    }, true)
  }

  function injectInto(win) {
    try {
      if (win && !win.AscDesktopEditor) win.AscDesktopEditor = window.AscDesktopEditor
      if (win && !win.RendererProcessVariable) win.RendererProcessVariable = window.RendererProcessVariable
      patchProtocol(win)
      if (win && win.document) installSelectionListener(win)
    } catch (e) {}
    var frames = []
    try { frames = win.frames } catch (e) { return }
    for (var i = 0; i < frames.length; i += 1) {
      try { injectInto(frames[i]) } catch (e) {}
    }
  }

  /** Watch one iframe from creation until its document has finished loading. */
  function watchFrame(element) {
    var timer = setInterval(function () {
      try {
        if (element.contentWindow) injectInto(element.contentWindow)
        if (element.contentDocument && element.contentDocument.readyState === 'complete') clearInterval(timer)
      } catch (e) {
        clearInterval(timer)
      }
    }, 10)
    setTimeout(function () { clearInterval(timer) }, 60000)
    element.addEventListener('load', function () {
      try { injectInto(element.contentWindow) } catch (e) {}
    })
  }

  function installFrameBridge() {
    var create = document.createElement.bind(document)
    document.createElement = function (tag) {
      var element = create(tag)
      if (String(tag).toLowerCase() === 'iframe') watchFrame(element)
      return element
    }
    // Frames appear during start-up only; stop polling once the editor settled.
    var timer = setInterval(function () { injectInto(window) }, 250)
    setTimeout(function () { clearInterval(timer) }, 30000)
  }

  installFrameBridge()

  async function openDocument() {
    show('Opening document...')
    var infoResponse = await fetch(API + '/info?id=' + encodeURIComponent(docId))
    if (!infoResponse.ok) throw new Error('cannot read document info: ' + (await infoResponse.text()))
    var info = await infoResponse.json()

    var bytesResponse = await fetch(API + '/bin?id=' + encodeURIComponent(docId))
    if (!bytesResponse.ok) throw new Error('cannot read document bytes: ' + (await bytesResponse.text()))
    var bytes = new Uint8Array(await bytesResponse.arrayBuffer())

    var ew = await waitForEditor(30000)
    window.AscDesktopEditor._editorWindow = ew
    window.AscDesktopEditor._currentDocType = info.kind
    patchFonts(ew)

    // Images inserted into this document resolve against its own media folder.
    try {
      if (ew.AscCommon && ew.AscCommon.g_oDocumentUrls) {
        ew.AscCommon.g_oDocumentUrls.documentUrl = API + '/media/' + encodeURIComponent(docId)
      }
    } catch (e) {
      log('document media url unavailable: ' + e.message)
    }

    var file = new ew.AscCommon.OpenFileResult()
    file.data = bytes
    file.bSerFormat = info.kind === 'word'
    // The release build builds its drawing document during start-up; a first
    // attempt can land before that, so retry briefly instead of failing open.
    var attempt = 0
    for (;;) {
      try {
        ew.Asc.editor.openDocument(file)
        break
      } catch (error) {
        attempt += 1
        if (attempt > 20) throw error
        await new Promise(function (resolve) { setTimeout(resolve, 150) })
      }
    }
    log('document opened: ' + info.name + ' (' + bytes.length + ' bytes, attempt ' + (attempt + 1) + ')')
    hide()
  }

  async function start() {
    try {
      var infoResponse = await fetch(API + '/info?id=' + encodeURIComponent(docId))
      var info = await infoResponse.json()
      var fileType = info.kind === 'pdf' ? 'pdf' : 'docx'
      window.AscDesktopEditor._currentDocType = info.kind
      document.title = info.name

      new DocsAPI.DocEditor('placeholder', {
        type: 'desktop',
        width: '100%',
        height: '100%',
        documentType: info.kind === 'pdf' ? 'pdf' : 'word',
        document: {
          title: info.name,
          url: '_offline_',
          fileType: fileType,
          key: 'local-' + docId + '-' + Date.now(),
          permissions: { edit: true, download: true, print: true },
        },
        editorConfig: {
          mode: 'edit',
          lang: 'en',
          targetApp: 'desktop',
          user: { id: 'local-user', name: 'Advocate' },
          customization: { about: false, feedback: false, macros: false },
        },
        events: {
          onAppReady: function () {
            log('app ready')
            openDocument().catch(function (error) { log('open failed: ' + error.message); show('Cannot open document: ' + error.message) })
          },
          onDocumentReady: function () {
            log('document ready')
            hide()
          },
          onError: function (event) {
            log('editor error: ' + JSON.stringify(event && event.data ? event.data : {}))
            show('Editor error: ' + (event && event.data && event.data.message ? event.data.message : 'unknown'))
          },
          onWarning: function (event) {
            log('editor warning: ' + JSON.stringify(event && event.data ? event.data : {}))
          },
        },
      })
    } catch (error) {
      log('boot failed: ' + error.message)
      show('Cannot start editor: ' + error.message)
    }
  }

  start()
})()
