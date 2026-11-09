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
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      const params = info?.tab?.navigation?.params
      const wanted = (params && typeof params.path === 'string' && params.path !== '' ? params.path : '') || lastPath || readLastPath()

      const [doc, setDoc] = react.useState(undefined)
      const [failure, setFailure] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [reloadToken, setReloadToken] = react.useState(0)
      const [loadedMtime, setLoadedMtime] = react.useState(0)
      const docRef = react.useRef(undefined)

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
            setDoc(opened)
            setLoadedMtime(state.mtimeMs ?? 0)
            setReloadToken((value) => value + 1)
          })
          .catch((error) => { if (live) setFailure(error instanceof Error ? error.message : String(error)) })
          .finally(() => { if (live) setBusy(false) })
        return () => { live = false }
      }, [wanted])

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
                setReloadToken((value) => value + 1)
              }
            })
            .catch(() => {})
        }, 4000)
        return () => { clearInterval(timer) }
      }, [doc, loadedMtime])

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

    exports.inject = ['sidebarRightTabs', 'slots', 'locale', 'sidebarRight']

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
      ctx.effect(() => ctx.locale.register(NAMESPACE, { en, hi }), 'workspace-editor.copy')
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
