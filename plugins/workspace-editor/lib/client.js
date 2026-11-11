/**
 * Client half of the workspace editor plugin (hand-authored dynamic bundle).
 *
 * Stage 3's empty tab becomes the Stage 6 document editor: a right-sidebar tab
 * that keeps the Euro-Office editor mounted in an iframe, an Edit action on
 * .docx/.pdf preview tabs, and a reload that picks up agent edits.
 */
window.__ModuleLoader__.load({
  id: 'workspace-editor',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    const NAMESPACE = 'workspaceEditor'
    const KIND = 'workspace-editor'
    const ROUTE = '/workspace-editor'
    const en = {
      'tab.title': 'Editor',
      'guide.title': 'Editor',
      'guide.description': 'Open a Word document or PDF for editing',
      empty: 'No document open',
      edit: 'Edit',
      reload: 'Reload',
      'exportPdf': 'Export PDF',
      'markup': 'Markup',
      'markup.loading': 'Reading markup...',
      'markup.failed': 'Cannot read markup',
      'conflict.text': 'This document changed on disk. Your unsaved changes are kept.',
      'conflict.saveCopy': 'Save as copy',
      'conflict.reload': 'Reload',
      'conflict.dismiss': 'Dismiss',
      opening: 'Opening document...',
      failed: 'Cannot open document',
      'waiting': 'Open a .docx or .pdf preview and choose Edit.',
      'menu.sendToChat': 'Send to chat',
      'menu.askAgent': 'Ask agent',
      'menu.copy': 'Copy',
      'menu.failed': 'The menu action could not be completed.',
      'stage.source': 'From `{path}` at revision {revision}.',
      'stage.dirty': '(editor has unsaved changes)',
      'stage.unavailable': 'This chat is not available right now.',
      'stage.failed': 'The composer is busy; the selection was not staged.',
      'copy.failed': 'Could not copy the selection.',
    }
    const hi = {
      'tab.title': 'संपादक',
      'guide.title': 'संपादक',
      'guide.description': 'संपादन के लिए वर्ड दस्तावेज़ या पीडीएफ़ खोलें',
      empty: 'कोई दस्तावेज़ खुला नहीं है',
      edit: 'संपादित करें',
      reload: 'फिर लोड करें',
      'exportPdf': 'पीडीएफ़ निर्यात',
      'markup': 'मार्कअप',
      'markup.loading': 'मार्कअप पढ़ा जा रहा है...',
      'markup.failed': 'मार्कअप नहीं पढ़ा जा सका',
      'conflict.text': 'यह दस्तावेज़ डिस्क पर बदल गया है। आपके सहेजे न गए बदलाव रखे गए हैं।',
      'conflict.saveCopy': 'प्रतिलिपि के रूप में सहेजें',
      'conflict.reload': 'फिर लोड करें',
      'conflict.dismiss': 'खारिज करें',
      opening: 'दस्तावेज़ खुल रहा है...',
      failed: 'दस्तावेज़ नहीं खुल सका',
      'waiting': '.docx या .pdf पूर्वावलोकन खोलें और संपादित करें चुनें।',
      'menu.sendToChat': 'चैट में भेजें',
      'menu.askAgent': 'एजेंट से पूछें',
      'menu.copy': 'कॉपी करें',
      'menu.failed': 'मेनू कार्रवाई पूरी नहीं हो सकी।',
      'stage.source': '`{path}` से संशोधन {revision} पर।',
      'stage.dirty': '(संपादक में सहेजे न गए बदलाव हैं)',
      'stage.unavailable': 'यह चैट अभी उपलब्ध नहीं है।',
      'stage.failed': 'कंपोज़र व्यस्त है; चयन जमा नहीं किया गया।',
      'copy.failed': 'चयन कॉपी नहीं हो सका।',
    }

    /** Host document id per tab address, so closing one tab closes only its document. */
    const docIds = new Map()

    /** @param {string} path - absolute document path. @returns {string} resource address. */
    const toAddress = (path) => `dsh-resource://file/absolute/${String(path).replace(/\\/g, '/')}`
    /** @param {string} address - resource address. @returns {string} absolute document path. */
    const pathFromAddress = (address) => {
      const prefix = 'dsh-resource://file/absolute/'
      return typeof address === 'string' && address.startsWith(prefix) ? address.slice(prefix.length) : ''
    }

    /**
     * Validate one message from the editor iframe and return the selection to
     * stage, or null when the message must be ignored: only this tab's own
     * iframe, its own origin, real text, finite points and a known store
     * revision open the selection menu (WD-075, WD-135).
     * @param {{ message: object, frameWindow: object | null, origin: string, revision: string, path: string }} input - one window message.
     * @returns {{ path: string, revision: string, text: string, dirty: boolean, x: number, y: number } | null} staged selection.
     */
    function selectionMessage(input) {
      const message = input && input.message
      if (message === null || typeof message !== 'object') return null
      if (input.frameWindow === null || input.frameWindow === undefined) return null
      if (message.source !== input.frameWindow) return null
      if (message.origin !== input.origin) return null
      const data = message.data
      if (data === null || typeof data !== 'object') return null
      if (data.type !== 'workspace-editor/selection') return null
      if (typeof data.text !== 'string' || data.text.trim() === '') return null
      if (typeof data.x !== 'number' || typeof data.y !== 'number') return null
      if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return null
      if (typeof input.revision !== 'string' || input.revision === '') return null
      return {
        path: typeof input.path === 'string' ? input.path : '',
        revision: input.revision,
        text: data.text,
        dirty: data.dirty === true,
        x: data.x,
        y: data.y,
      }
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: '160px' },
      bar: {
        display: 'flex', gap: '6px', alignItems: 'center', padding: '4px 8px',
        fontSize: '12px', color: 'var(--dsw-alias-label-secondary)',
        borderBottom: '1px solid var(--dsw-alias-border-secondary)',
      },
      name: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      button: {
        padding: '2px 8px', border: '1px solid var(--dsw-alias-border-secondary)',
        borderRadius: '4px', background: 'transparent', color: 'inherit',
        font: 'inherit', cursor: 'pointer',
      },
      frame: { flex: 1, width: '100%', border: '0', background: '#1e1e2e' },
      frameBox: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
      banner: {
        display: 'flex', gap: '6px', alignItems: 'center', padding: '6px 8px',
        fontSize: '12px', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-warning, #4a3a12)',
        borderBottom: '1px solid var(--dsw-alias-border-secondary)',
      },
      message: { display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, padding: '16px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center' },
      markup: {
        maxHeight: '45%', overflow: 'auto', padding: '6px 8px', fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-secondary, #181825)',
        borderBottom: '1px solid var(--dsw-alias-border-secondary)', fontFamily: 'monospace',
      },
      markupRow: { margin: '0 0 4px 0' },
      markupId: { color: 'var(--dsw-alias-label-tertiary)', marginRight: '6px' },
      markupRun: { marginRight: '2px' },
      markupInserted: { textDecoration: 'underline' },
      markupDeleted: { textDecoration: 'line-through', opacity: 0.7 },
    }

    /** @param {unknown} response - fetch result. */
    async function readJson(response) {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`)
      return body
    }

    /**
     * Read-only markup inspector shown outside the editor iframe. It renders the
     * markup view of the open document as text: no input, select or editable
     * element exists in this pane.
     * @param {{ t?: Function, view?: object, error?: string }} props - view or error.
     */
    function MarkupPane(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      if (typeof props.error === 'string' && props.error !== '') {
        return react.createElement('div', { style: styles.markup, 'data-workspace-editor-markup': 'error' },
          react.createElement('div', null, `${t('markup.failed')}: ${props.error}`))
      }
      const view = props.view
      if (view === undefined || view === null) {
        return react.createElement('div', { style: styles.markup, 'data-workspace-editor-markup': 'loading' },
          react.createElement('div', null, t('markup.loading')))
      }
      const nodes = Array.isArray(view.nodes) ? view.nodes : []
      const rows = nodes.map((node, position) => {
        const key = `${node.kind}:${node.id ?? node.index ?? position}`
        if (node.kind === 'paragraph') {
          const runs = Array.isArray(node.runs) ? node.runs : []
          return react.createElement('div', {
            key, style: styles.markupRow, 'data-node-kind': 'paragraph', 'data-block-id': node.id,
          },
          react.createElement('span', { style: styles.markupId }, `${node.index} ${node.id}`),
          runs.length === 0
            ? react.createElement('span', null, node.text)
            : runs.map((run, index) => react.createElement('span', {
              key: `run:${index}`,
              'data-run-index': run.runIndex,
              'data-inserted': run.inserted === true ? 'true' : undefined,
              'data-deleted': run.deleted === true ? 'true' : undefined,
              style: {
                ...styles.markupRun,
                ...(run.inserted === true ? styles.markupInserted : {}),
                ...(run.deleted === true ? styles.markupDeleted : {}),
              },
            }, typeof run.text === 'string' ? run.text : '')))
        }
        if (node.kind === 'table') {
          const rowsOfTable = Array.isArray(node.rows) ? node.rows : []
          return react.createElement('div', {
            key, style: styles.markupRow, 'data-node-kind': 'table', 'data-block-id': node.id,
          },
          react.createElement('span', { style: styles.markupId }, `${node.index} ${node.id}`),
          rowsOfTable.map((row, rowIndex) => react.createElement('div', { key: `row:${rowIndex}` },
            (Array.isArray(row.cells) ? row.cells : [])
              .map((cell) => (typeof cell.text === 'string' ? cell.text : ''))
              .join(' | '))))
        }
        if (node.kind === 'section') {
          return react.createElement('div', {
            key, style: styles.markupRow, 'data-node-kind': 'section',
          },
          react.createElement('span', { style: styles.markupId }, `section ${node.index}`),
          node.props && node.props.orientation ? String(node.props.orientation) : '')
        }
        return react.createElement('div', {
          key, style: styles.markupRow, 'data-node-kind': String(node.kind),
        },
        react.createElement('span', { style: styles.markupId }, String(node.id ?? node.index ?? position)),
        String(node.type ?? node.kind ?? 'opaque'))
      })
      return react.createElement('div', {
        'data-workspace-editor-markup': String(view.schema ?? 1),
        role: 'region',
        'aria-label': t('markup'),
        style: styles.markup,
      }, rows)
    }

    /** Editor tab body: toolbar, status, and the host page in an iframe. */
    function EditorBody(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const openSelectionMenu = typeof props.openSelectionMenu === 'function' ? props.openSelectionMenu : undefined
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      const address = (info?.tab?.navigation?.address ?? info?.tab?.contentId) || ''
      const wanted = pathFromAddress(address)
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const routeUrl = (suffix) => sessionId === ''
        ? `${ROUTE}${suffix}`
        : `${ROUTE}${suffix}${suffix.includes('?') ? '&' : '?'}session=${encodeURIComponent(sessionId)}`

      const [doc, setDoc] = react.useState(undefined)
      const [failure, setFailure] = react.useState('')
      const [conflict, setConflict] = react.useState(undefined)
      const [busy, setBusy] = react.useState(false)
      const [reloadToken, setReloadToken] = react.useState(0)
      const [loadedMtime, setLoadedMtime] = react.useState(0)
      const [loadedRevision, setLoadedRevision] = react.useState('')
      const [markupOpen, setMarkupOpen] = react.useState(false)
      const [markupView, setMarkupView] = react.useState(undefined)
      const [markupError, setMarkupError] = react.useState('')
      const docRef = react.useRef(undefined)
      const frameRef = react.useRef(null)

      react.useEffect(() => {
        if (wanted === '') return
        let live = true
        setBusy(true)
        setFailure('')
        setConflict(undefined)
        fetch(routeUrl('/api/open'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: wanted }),
        })
          .then(readJson)
          .then(async (opened) => {
            if (!live) return
            docRef.current = opened
            docIds.set(address, opened.id)
            const state = await readJson(await fetch(routeUrl(`/api/info?id=${encodeURIComponent(opened.id)}`)))
            if (!live) return
            setDoc({ ...opened, path: typeof state.path === 'string' && state.path !== '' ? state.path : wanted })
            setLoadedMtime(state.mtimeMs ?? 0)
            setLoadedRevision(typeof state.revision === 'string' ? state.revision : '')
            setReloadToken((value) => value + 1)
          })
          .catch((error) => { if (live) setFailure(error instanceof Error ? error.message : String(error)) })
          .finally(() => { if (live) setBusy(false) })
        return () => { live = false }
      }, [wanted])

      // Right-click in the editor iframe: verify the sender, map the point to
      // this window, and open the shared DSH menu for the selection.
      react.useEffect(() => {
        if (doc === undefined || openSelectionMenu === undefined) return undefined
        const onMessage = (event) => {
          const frame = frameRef.current
          if (frame === null) return
          const staged = selectionMessage({
            message: event,
            frameWindow: frame.contentWindow,
            origin: window.location.origin,
            revision: loadedRevision,
            path: typeof doc.path === 'string' && doc.path !== '' ? doc.path : wanted,
          })
          if (staged === null) return
          const rect = frame.getBoundingClientRect()
          openSelectionMenu({
            path: staged.path,
            revision: staged.revision,
            text: staged.text,
            dirty: staged.dirty,
          }, { x: rect.left + staged.x, y: rect.top + staged.y })
        }
        window.addEventListener('message', onMessage)
        return () => { window.removeEventListener('message', onMessage) }
      }, [doc, wanted, loadedMtime, loadedRevision, openSelectionMenu])

      // Pick up agent edits: reload only while the editor holds no unsaved work.
      react.useEffect(() => {
        if (doc === undefined) return undefined
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          fetch(routeUrl(`/api/info?id=${encodeURIComponent(doc.id)}`))
            .then(readJson)
            .then((state) => {
              if (state.modified === true) return
              if (state.mtimeMs !== loadedMtime) {
                setLoadedMtime(state.mtimeMs)
                setLoadedRevision(typeof state.revision === 'string' ? state.revision : '')
                setReloadToken((value) => value + 1)
              }
            })
            .catch(() => {})
        }, 4000)
        return () => { clearInterval(timer) }
      }, [doc, loadedMtime])

      // The shared events channel is the primary revision signal: reload on an
      // apply-world document reload frame for this path and surface conflicts.
      // The poll above stays as the fallback when EventSource is unavailable.
      react.useEffect(() => {
        if (doc === undefined || typeof EventSource !== 'function') return undefined
        let source = null
        try {
          source = new EventSource(`${ROUTE}/events`)
        } catch (error) {
          return undefined
        }
        const onFrame = (event) => {
          let frame
          try {
            frame = JSON.parse(event.data)
          } catch (error) {
            return
          }
          if (frame === null || typeof frame !== 'object') return
          const framePath = frame.type === 'conflict'
            ? (typeof frame.path === 'string' ? frame.path : '')
            : (frame.document && typeof frame.document.path === 'string' ? frame.document.path : '')
          if (framePath !== '' && framePath.toLowerCase() !== String(doc.path || '').toLowerCase()) return
          if (frame.type === 'conflict') {
            setConflict({ code: typeof frame.code === 'string' ? frame.code : 'conflict', path: framePath })
            return
          }
          if (frame.type !== 'document' || frame.reload !== true) return
          fetch(routeUrl(`/api/info?id=${encodeURIComponent(doc.id)}`))
            .then(readJson)
            .then((state) => {
              if (state.modified === true) return
              setLoadedMtime(state.mtimeMs ?? 0)
              setLoadedRevision(typeof state.revision === 'string' ? state.revision : '')
              setFailure('')
              setReloadToken((value) => value + 1)
            })
            .catch(() => {})
        }
        source.addEventListener('message', onFrame)
        return () => { try { source.close() } catch (error) {} }
      }, [doc])

      // The Markup button reads the markup view of the shown bytes; a new store
      // revision replaces it so the pane never describes an older revision.
      react.useEffect(() => {
        if (!markupOpen || doc === undefined) return undefined
        let live = true
        setMarkupError('')
        fetch(routeUrl(`/api/markup?id=${encodeURIComponent(doc.id)}`))
          .then(readJson)
          .then((body) => { if (live) setMarkupView(body.view) })
          .catch((error) => {
            if (!live) return
            setMarkupView(undefined)
            setMarkupError(error instanceof Error ? error.message : String(error))
          })
        return () => { live = false }
      }, [markupOpen, doc, loadedRevision])

      const reloadNow = () => {
        setConflict(undefined)
        setFailure('')
        setMarkupView(undefined)
        setReloadToken((value) => value + 1)
      }
      /** Keep the unsaved buffer: the editor writes it to a copy next to the file. */
      const saveAsCopy = () => {
        const frame = frameRef.current
        if (frame === null || frame.contentWindow === null || doc === undefined) return
        const source = typeof doc.path === 'string' && doc.path !== '' ? doc.path : wanted
        const dot = source.lastIndexOf('.')
        const target = dot > source.lastIndexOf('/') && dot > source.lastIndexOf('\\')
          ? `${source.slice(0, dot)} (copy)${source.slice(dot)}`
          : `${source} (copy)`
        frame.contentWindow.postMessage({ type: 'workspace-editor/save-as-copy', path: target }, window.location.origin)
      }
      const banner = conflict === undefined ? null : react.createElement(
        'div',
        { style: styles.banner, 'data-workspace-editor-conflict': conflict.code },
        react.createElement('span', { style: styles.name }, t('conflict.text')),
        react.createElement('button', { type: 'button', style: styles.button, onClick: saveAsCopy }, t('conflict.saveCopy')),
        react.createElement('button', { type: 'button', style: styles.button, onClick: reloadNow }, t('conflict.reload')),
        react.createElement('button', { type: 'button', style: styles.button, onClick: () => setConflict(undefined) }, t('conflict.dismiss')),
      )

      const header = react.createElement(
        'div',
        { style: styles.bar },
        react.createElement('span', { style: styles.name }, doc === undefined ? wanted : doc.name),
        doc === undefined ? null : react.createElement('button', {
          type: 'button',
          style: styles.button,
          'data-workspace-editor-markup-toggle': markupOpen ? 'on' : 'off',
          onClick: () => { setMarkupOpen((open) => !open) },
        }, t('markup')),
        doc === undefined ? null : react.createElement('button', {
          type: 'button',
          style: styles.button,
          onClick: reloadNow,
        }, t('reload')),
        doc === undefined ? null : react.createElement('a', {
          style: styles.button,
          href: routeUrl(`/api/pdf?id=${encodeURIComponent(doc.id)}`),
          target: '_blank',
          rel: 'noreferrer',
        }, t('exportPdf')),
      )

      let body
      if (failure !== '') {
        body = react.createElement('div', { style: styles.message }, `${t('failed')}: ${failure}`)
      } else if (doc === undefined) {
        body = react.createElement('div', { style: styles.message }, busy ? t('opening') : t('waiting'))
      } else {
        const frame = react.createElement('iframe', {
          key: `${doc.id}:${reloadToken}`,
          ref: frameRef,
          src: routeUrl(`/host.html?doc=${encodeURIComponent(doc.id)}&rev=${reloadToken}&path=${encodeURIComponent(doc.path)}`),
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads',
          style: styles.frame,
          title: doc.name,
        })
        body = markupOpen
          ? react.createElement('div', { style: styles.frameBox },
            react.createElement(MarkupPane, { t, view: markupView, error: markupError }),
            frame)
          : frame
      }

      return react.createElement('div', { 'data-workspace-editor': doc === undefined ? 'empty' : doc.kind, style: styles.root }, header, banner, body)
    }

    /** Edit action shown on .docx and .pdf preview tabs. */
    function makeEditAction(openEditor) {
      return function EditAction(props) {
        const t = typeof props.t === 'function' ? props.t : (key) => key
        const path = typeof props.absolutePath === 'string' ? props.absolutePath : ''
        const files = ['.docx', '.doc', '.pdf']
        const supported = files.some((suffix) => path.toLowerCase().endsWith(suffix))
        if (!supported) return null
        return react.createElement('button', {
          type: 'button',
          style: { ...styles.button, marginRight: '6px' },
          title: `${t('edit')} ${path}`,
          onClick: () => { openEditor(path) },
        }, t('edit'))
      }
    }

    exports.inject = ['sidebarRightTabs', 'slots', 'locale', 'sidebarRight', 'sessions', 'contextMenus']

    function apply(ctx) {
      const t = ctx.locale.bind(NAMESPACE)
      /** Open a document tab in the session that is on screen (the Edit action). */
      const openEditor = (path) => {
        try {
          ctx.sidebarRight.openResource(toAddress(path))
        } catch (error) {
          console.error('[workspace-editor] open failed', error)
        }
      }
      /**
       * Open a document tab in one DSH session, not in the visible one. The
       * sidebar can only place a tab in a session whose layout it has adopted;
       * a request for a session that is not shown yet stays queued on the host
       * until that session is on screen.
       * @param {string} sessionId - calling DSH session.
       * @param {string} path - absolute document path.
       * @returns {boolean} true when the tab was opened and may be acknowledged.
       */
      const openEditorIn = (sessionId, path) => {
        const open = ctx.sidebarRight.openResourceIn
        if (typeof open !== 'function' || typeof sessionId !== 'string' || sessionId === '') return false
        const mounted = ctx.sidebarRight.mounted?.getSnapshot?.()
        const adopted = typeof ctx.sidebarRight.tabsIn === 'function' ? ctx.sidebarRight.tabsIn(sessionId) : []
        if (mounted !== sessionId && adopted.length === 0) return false
        try {
          open.call(ctx.sidebarRight, sessionId, toAddress(path))
          return true
        } catch (error) {
          console.error('[workspace-editor] open in session failed', error)
          return false
        }
      }
      const EditAction = makeEditAction(openEditor)

      const quoteLimit = 8000
      const truncate = (text) => text.length <= quoteLimit ? text : `${text.slice(0, quoteLimit)}…`
      const quoteFor = (value) => {
        const body = truncate(value.text).split('\n').map((line) => `> ${line}`).join('\n')
        const source = t('stage.source', { path: value.path, revision: String(value.revision) })
        return `${body}\n\n${source}${value.dirty ? ` ${t('stage.dirty')}` : ''}\n`
      }
      /** Stage one selection in the tab's own chat through the apply-world input face. */
      const stage = (value, submit) => {
        const scope = ctx.sessions.scope(value.sessionId)
        if (scope === undefined) { ctx.contextMenus.notify(t('stage.unavailable')); return }
        const conversation = scope.get('conversation')
        if (conversation === undefined) { ctx.contextMenus.notify(t('stage.unavailable')); return }
        const input = conversation.input.for(scope)
        if (!input.insertQuote(quoteFor(value))) { input.notify('error', t('stage.failed')); return }
        if (submit) input.submit()
        input.focus()
      }
      const copy = (text) => {
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
        if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
          ctx.contextMenus.notify(t('copy.failed'))
          return
        }
        void clipboard.writeText(text).catch(() => { ctx.contextMenus.notify(t('copy.failed')) })
      }
      const openSelectionMenu = (sessionId, selection, point) => {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return
        ctx.contextMenus.open({
          kind: 'eurooffice',
          value: {
            sessionId,
            path: typeof selection.path === 'string' ? selection.path : '',
            revision: typeof selection.revision === 'string'
              ? selection.revision
              : typeof selection.revision === 'number' ? String(selection.revision) : '',
            text: typeof selection.text === 'string' ? selection.text : '',
            dirty: selection.dirty === true,
          },
        }, point)
      }

      ctx.effect(() => ctx.locale.register(NAMESPACE, { en, hi }), 'workspace-editor.copy')
      ctx.effect(() => ctx.contextMenus.register({
        id: 'workspace-editor.selection',
        target: 'eurooffice',
        order: 100,
        resolve: (target) => {
          // The registry passes the target value; accept a whole target too.
          const value = target !== null && typeof target === 'object' && 'value' in target ? target.value : target
          if (value === null || typeof value !== 'object') return []
          const sessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
          const text = typeof value.text === 'string' ? value.text : ''
          if (sessionId === '' || text.trim() === '') return []
          const selection = {
            sessionId,
            path: typeof value.path === 'string' ? value.path : '',
            revision: typeof value.revision === 'string'
              ? value.revision
              : typeof value.revision === 'number' ? String(value.revision) : '',
            text,
            dirty: value.dirty === true,
          }
          return [
            {
              id: 'workspace-editor.selection.send',
              label: t('menu.sendToChat'),
              failureLabel: t('menu.failed'),
              run: () => { stage(selection, false) },
            },
            {
              id: 'workspace-editor.selection.ask',
              label: t('menu.askAgent'),
              failureLabel: t('menu.failed'),
              run: () => { stage(selection, true) },
            },
            {
              id: 'workspace-editor.selection.copy',
              label: t('menu.copy'),
              failureLabel: t('menu.failed'),
              run: () => { copy(selection.text) },
            },
          ]
        },
      }), 'workspace-editor.selection-menu')
      ctx.effect(() => {
        const timers = new Map()
        const poll = (sessionId) => {
          if (timers.has(sessionId)) return
          const tick = async () => {
            try {
              const query = `session=${encodeURIComponent(sessionId)}`
              const response = await fetch(`${ROUTE}/api/pending-open?${query}`)
              if (!response.ok) return
              const body = await response.json()
              const acked = []
              for (const path of Array.isArray(body.paths) ? body.paths : []) {
                if (typeof path === 'string' && path !== '' && openEditorIn(sessionId, path)) acked.push(path)
              }
              if (acked.length === 0) return
              await fetch(`${ROUTE}/api/pending-open-ack?${query}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ paths: acked }),
              })
            } catch {}
          }
          void tick()
          timers.set(sessionId, setInterval(() => { void tick() }, 1500))
        }
        const stop = (sessionId) => {
          const timer = timers.get(sessionId)
          if (timer !== undefined) clearInterval(timer)
          timers.delete(sessionId)
        }
        // Only the session on screen can receive a tab, so only that session's
        // tab requests are polled; the rest stay queued until the user shows it.
        const mounted = ctx.sidebarRight?.mounted
        let shown = ''
        const sync = () => {
          const sessionId = typeof mounted?.getSnapshot === 'function' ? mounted.getSnapshot() : undefined
          const next = typeof sessionId === 'string' ? sessionId : ''
          if (next === shown) return
          if (shown !== '') stop(shown)
          shown = next
          if (shown !== '') poll(shown)
        }
        const unsubscribe = typeof mounted?.subscribe === 'function' ? mounted.subscribe(sync) : undefined
        sync()
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe()
          for (const sessionId of [...timers.keys()]) stop(sessionId)
        }
      }, 'workspace-editor.open-stream')
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: KIND,
        kind: KIND,
        keepMounted: true,
        patterns: ['dsh-resource://file/**'],
        canOpen: (address) => /\.(docx?|pdf)$/i.test(pathFromAddress(address)),
        title: (address) => {
          const file = pathFromAddress(address)
          return file === '' ? t('tab.title') : file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1)
        },
        guide: [{
          id: 'workspace-editor.open',
          order: 40,
          title: () => t('guide.title'),
          description: () => t('guide.description'),
        }],
      }), 'workspace-editor.type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: KIND,
        locale: NAMESPACE,
        inject: (sessionId) => ({
          sessionId,
          openSelectionMenu: (selection, point) => { openSelectionMenu(sessionId, selection, point) },
        }),
      }, EditorBody)), 'workspace-editor.body')
      ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
        name: 'sidebar.right.tab.document.actions',
        id: 'workspace-editor-edit',
        locale: NAMESPACE,
      }, EditAction)), 'workspace-editor.action')
      // Closing the tab frees the Host session: Editor.bin, media and temp files.
      ctx.effect(() => ctx.sidebarRight.registerCloseHandler(KIND, (_sessionId, tab) => {
        const address = (tab && (tab.contentId ?? tab.navigation?.address)) || ''
        const id = docIds.get(address) ?? ''
        docIds.delete(address)
        if (id !== '') {
          void fetch(`${ROUTE}/api/close?id=${encodeURIComponent(id)}&session=${encodeURIComponent(_sessionId ?? '')}`, { method: 'POST' }).catch(() => {})
        }
      }), 'workspace-editor.close')
    }

    /** Pure tab guards; the unit test drives them without a browser. */
    exports.__guards = { selectionMessage, pathFromAddress, toAddress }
    exports.apply = apply
    return module.exports
  },
})


