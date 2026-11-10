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

    /** Last document requested through the Edit action; page params are the fallback. */
    let lastPath = ''
    /** Document the mounted tab currently shows, so closing it can free the Host session. */
    let currentDocId = ''
    const LAST_PATH_KEY = 'workspace-editor.lastPath'

    const readLastPath = () => {
      try { return window.localStorage.getItem(LAST_PATH_KEY) ?? '' } catch { return '' }
    }
    const rememberPath = (path) => {
      try { window.localStorage.setItem(LAST_PATH_KEY, path) } catch {}
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
      message: { display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, padding: '16px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center' },
    }

    /** @param {unknown} response - fetch result. */
    async function readJson(response) {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`)
      return body
    }

    /** Editor tab body: toolbar, status, and the host page in an iframe. */
    function EditorBody(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const openSelectionMenu = typeof props.openSelectionMenu === 'function' ? props.openSelectionMenu : undefined
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      const params = info?.tab?.navigation?.params
      const wanted = (params && typeof params.path === 'string' && params.path !== '' ? params.path : '') || lastPath || readLastPath()

      const [doc, setDoc] = react.useState(undefined)
      const [failure, setFailure] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [reloadToken, setReloadToken] = react.useState(0)
      const [loadedMtime, setLoadedMtime] = react.useState(0)
      const [loadedRevision, setLoadedRevision] = react.useState('')
      const docRef = react.useRef(undefined)
      const frameRef = react.useRef(null)

      react.useEffect(() => {
        if (wanted === '') return
        let live = true
        setBusy(true)
        setFailure('')
        fetch(`${ROUTE}/api/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: wanted }),
        })
          .then(readJson)
          .then(async (opened) => {
            if (!live) return
            docRef.current = opened
            currentDocId = opened.id
            rememberPath(wanted)
            const state = await readJson(await fetch(`${ROUTE}/api/info?id=${encodeURIComponent(opened.id)}`))
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
          if (frame === null || event.source !== frame.contentWindow) return
          if (event.origin !== window.location.origin) return
          const data = event.data
          if (data === null || typeof data !== 'object') return
          if (data.type !== 'workspace-editor/selection') return
          if (typeof data.text !== 'string' || data.text.trim() === '') return
          if (typeof data.x !== 'number' || typeof data.y !== 'number') return
          if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return
          const rect = frame.getBoundingClientRect()
          openSelectionMenu({
            path: typeof doc.path === 'string' && doc.path !== '' ? doc.path : wanted,
            revision: loadedRevision !== '' ? loadedRevision : loadedMtime,
            text: data.text,
            dirty: data.dirty === true,
          }, { x: rect.left + data.x, y: rect.top + data.y })
        }
        window.addEventListener('message', onMessage)
        return () => { window.removeEventListener('message', onMessage) }
      }, [doc, wanted, loadedMtime, loadedRevision, openSelectionMenu])

      // Pick up agent edits: reload only while the editor holds no unsaved work.
      react.useEffect(() => {
        if (doc === undefined) return undefined
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          fetch(`${ROUTE}/api/info?id=${encodeURIComponent(doc.id)}`)
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
            setFailure(typeof frame.code === 'string' ? frame.code : 'conflict')
            return
          }
          if (frame.type !== 'document' || frame.reload !== true) return
          fetch(`${ROUTE}/api/info?id=${encodeURIComponent(doc.id)}`)
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

      const header = react.createElement(
        'div',
        { style: styles.bar },
        react.createElement('span', { style: styles.name }, doc === undefined ? (wanted || t('waiting')) : doc.name),
        doc === undefined ? null : react.createElement('button', {
          type: 'button',
          style: styles.button,
          onClick: () => { setReloadToken((value) => value + 1) },
        }, t('reload')),
        doc === undefined ? null : react.createElement('a', {
          style: styles.button,
          href: `${ROUTE}/api/pdf?id=${encodeURIComponent(doc.id)}`,
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
        body = react.createElement('iframe', {
          key: `${doc.id}:${reloadToken}`,
          ref: frameRef,
          src: `${ROUTE}/host.html?doc=${encodeURIComponent(doc.id)}&rev=${reloadToken}`,
          style: styles.frame,
          title: doc.name,
        })
      }

      return react.createElement('div', { 'data-workspace-editor': doc === undefined ? 'empty' : doc.kind, style: styles.root }, header, body)
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
      const openEditor = (path) => {
        lastPath = path
        try {
          ctx.sidebarRight.openTab(KIND, { params: { path } })
        } catch (error) {
          console.error('[workspace-editor] open failed', error)
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
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: KIND,
        kind: KIND,
        keepMounted: true,
        title: () => t('tab.title'),
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
          openSelectionMenu: (selection, point) => { openSelectionMenu(sessionId, selection, point) },
        }),
      }, EditorBody)), 'workspace-editor.body')
      ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
        name: 'sidebar.right.tab.document.actions',
        id: 'workspace-editor-edit',
        locale: NAMESPACE,
      }, EditAction)), 'workspace-editor.action')
      // Closing the tab frees the Host session: Editor.bin, media and temp files.
      ctx.effect(() => ctx.sidebarRight.registerCloseHandler(KIND, () => {
        const id = currentDocId
        currentDocId = ''
        if (id !== '') {
          void fetch(`${ROUTE}/api/close?id=${encodeURIComponent(id)}`, { method: 'POST' }).catch(() => {})
        }
      }), 'workspace-editor.close')
    }

    exports.apply = apply
    return module.exports
  },
})
