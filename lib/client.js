/*! @mikulo/dsh-prompt-switcher v1.1.0 | MIT | generated from src/client.js by scripts/build.mjs — edit src/, not lib/ */
/**
 * dsh-prompt-switcher — Browser half (plain module-loader artifact, no build).
 *
 * 1. Settings → "提示词模板" page
 *    - menu option: pin the templates above the built-in `/` commands (default on);
 *    - template directory (folder dialog or typed path) and a Refresh button;
 *    - one row per `.md` template: activation switch + "编辑" button;
 *    - editor view: large monospace editor with save / discard, Ctrl+S,
 *      conflict detection, live sync with changes made in an external editor,
 *      and a "用其他程序打开…" button that shows the OS "open with" chooser.
 * 2. A `/` input-trigger source listing the ACTIVE templates by their `.md`
 *    file name. Picking one claims the composer (`/代码审查 ` + hint); Enter
 *    submits `/prompt-template <id> <message>` to the Host, which binds the
 *    template to a brand-new conversation (see index.js).
 */
window.__ModuleLoader__.load({
  id: '@mikulo/dsh-prompt-switcher',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    let primitives = {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      /* fall back to native controls below */
    }

    /** Package version, stamped by scripts/build.mjs (shown on the settings page). */
    const VERSION = '1.1.0'
    const NS = 'prompt-switcher'
    const API = '/api/dsh-prompt-switcher'
    const COMMAND_NAME = 'prompt-template'
    const SECTION_ID = 'prompt-switcher'
    /** Trigger-source orders: built-in commands use 0 and skills 2. */
    const ORDER_PINNED = -100
    const ORDER_UNPINNED = 100
    const POLL_MS = 2000
    /** Must equal HOST_PROTOCOL in index.js; a mismatch means `dsh web` still runs an older Host half. */
    const HOST_PROTOCOL = 3

    const zh = {
      nav: '提示词模板',
      title: '提示词模板',
      intro: '选择一个本地目录，插件会读取该目录（不含子目录）下所有 .md 文件作为提示词模板。激活后，在新对话中输入 / 即可选择模板；模板的约束力等同于 AGENTS.md，并对该对话的所有后续轮次持续生效。',
      menuGroup: '菜单',
      pinTitle: '在 / 菜单中置顶提示词模板',
      pinDesc: '开启后，输入 / 时已激活的提示词模板显示在 Harness 自带指令之前。',
      dirLabel: '模板目录',
      dirPlaceholder: '点击“选择文件夹”，或输入目录的绝对路径后按回车',
      choose: '选择文件夹',
      choosing: '等待选择…',
      apply: '应用',
      refresh: '刷新',
      refreshing: '刷新中…',
      listTitle: '已读取的提示词模板（{count}）',
      activeCount: '已激活 {count} 个',
      noDir: '尚未配置模板目录。',
      empty: '该目录下没有 .md 文件。',
      loading: '加载中…',
      toggle: '激活模板 {name}',
      edit: '编辑',
      editAria: '编辑模板 {name}',
      draftTag: '有未保存草稿',
      pickerUnsupported: '当前环境无法弹出文件夹选择框，请在输入框中手动填写目录的绝对路径后按回车。',
      menuDescription: '提示词模板 · 仅新对话首条消息生效',
      hint: '输入第一条消息，发送后模板将约束整个对话',
      commandUnavailable: '提示词模板命令不可用，请确认插件已启用并刷新页面。',
      // editor
      back: '返回列表',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      openWith: '用其他程序打开…',
      openWithTitle: '弹出系统“打开方式”对话框，自行选择编辑器',
      openWithOpened: '已弹出系统“打开方式”对话框（可能在浏览器窗口后面）。选择编辑器并在其中保存后，这里会自动同步。',
      hostOutdated: '插件的服务端仍是旧版本：更新插件后需要重启 dsh web（停止后重新运行 dsh web），然后刷新页面。',
      statusSaved: '已保存',
      statusDirty: '未保存',
      statusLoading: '读取中…',
      stats: '{lines} 行 · {chars} 字符',
      footerHint: 'Ctrl+S 保存 · Tab 缩进 · 修改只影响之后新建的对话',
      confirmLeave: '有未保存的修改，确定放弃修改并返回列表吗？',
      confirmDiscard: '确定放弃所有未保存的修改吗？',
      restored: '已恢复上次未保存的草稿。',
      synced: '已同步外部编辑器中的修改。',
      savedAt: '已保存（{time}）',
      conflict: '文件在打开后已被其他程序修改，未保存。',
      externalChanged: '磁盘上的文件已被修改（可能来自外部编辑器），而这里还有未保存的修改。',
      loadDisk: '载入磁盘版本',
      overwrite: '仍然覆盖保存',
      keepMine: '保留我的修改',
      missing: '文件已不存在或已移出模板目录。',
      editorPlaceholder: '在这里编写提示词模板（Markdown）…',
    }
    const en = {
      nav: 'Prompt templates',
      title: 'Prompt templates',
      intro: 'Pick a local folder; every .md file directly inside it (subfolders are ignored) becomes a prompt template. Active templates appear when you type / in a new conversation and bind the whole conversation with AGENTS.md-level authority.',
      menuGroup: 'Menu',
      pinTitle: 'Pin templates to the top of the / menu',
      pinDesc: 'When on, active templates are listed before the built-in Harness commands.',
      dirLabel: 'Template folder',
      dirPlaceholder: 'Click "Choose folder", or type an absolute path and press Enter',
      choose: 'Choose folder',
      choosing: 'Waiting…',
      apply: 'Apply',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      listTitle: 'Templates found ({count})',
      activeCount: '{count} active',
      noDir: 'No template folder configured yet.',
      empty: 'No .md files in this folder.',
      loading: 'Loading…',
      toggle: 'Activate template {name}',
      edit: 'Edit',
      editAria: 'Edit template {name}',
      draftTag: 'Unsaved draft',
      pickerUnsupported: 'A folder dialog is not available here; type the absolute folder path and press Enter.',
      menuDescription: 'Prompt template · first message of a new conversation only',
      hint: 'Type the first message; the template will bind the whole conversation',
      commandUnavailable: 'The prompt-template command is unavailable; make sure the plugin is enabled and reload.',
      back: 'Back to list',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard changes',
      openWith: 'Open with…',
      openWithTitle: 'Show the system "Open with" dialog and pick any editor',
      openWithOpened: 'The system "Open with" dialog is open (it may be behind the browser). Changes saved in the chosen editor sync here automatically.',
      hostOutdated: 'The plugin host half is outdated: restart dsh web after updating the plugin (stop it and run dsh web again), then reload this page.',
      statusSaved: 'Saved',
      statusDirty: 'Unsaved',
      statusLoading: 'Loading…',
      stats: '{lines} lines · {chars} chars',
      footerHint: 'Ctrl+S to save · Tab indents · edits only affect conversations started later',
      confirmLeave: 'Discard unsaved changes and go back to the list?',
      confirmDiscard: 'Discard all unsaved changes?',
      restored: 'Restored your unsaved draft.',
      synced: 'Synced changes made in the external editor.',
      savedAt: 'Saved ({time})',
      conflict: 'The file was changed by another program after it was opened; not saved.',
      externalChanged: 'The file changed on disk (maybe in an external editor) while you have unsaved edits here.',
      loadDisk: 'Load disk version',
      overwrite: 'Overwrite anyway',
      keepMine: 'Keep my edits',
      missing: 'The file no longer exists or left the template folder.',
      editorPlaceholder: 'Write the prompt template (Markdown) here…',
    }

    // ─────────────────────────────────────────────── Host API

    /** Localized text for Host-level failures; bound in apply(). */
    let hostText = (key) => key

    async function call(path, body) {
      const response = await fetch(`${API}/${path}`, body === undefined
        ? { method: 'GET', cache: 'no-store' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      // Our routes only answer 200/400/403/405/409. A 404 (no route) or 401 (the
      // web shell's authenticated fallback) means the running Host half lacks
      // this route — `dsh web` has not been restarted since the plugin changed.
      if (response.status === 404 || response.status === 401) {
        throw Object.assign(new Error(hostText('hostOutdated')), { status: response.status, code: 'host-outdated' })
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status })
      }
      if (!response.ok) throw Object.assign(new Error(payload?.error ?? `HTTP ${response.status}`), { status: response.status, payload })
      return payload
    }
    const fileQuery = (file, meta) => `file?file=${encodeURIComponent(file)}${meta ? '&meta=1' : ''}`

    // ─────────────────────────────────────────────── shared client state

    /** Pin preference, mirrored from the Host; the `/` source re-registers on change. */
    const pin = { value: true, listeners: new Set() }
    function setPinned(next) {
      if (typeof next !== 'boolean' || next === pin.value) return
      pin.value = next
      for (const listener of [...pin.listeners]) {
        try { listener(next) } catch (error) { console.error('[dsh-prompt-switcher] pin listener failed:', error) }
      }
    }

    /** Active-template cache for the `/` menu (short TTL; dropped on every settings change). */
    let menuCache = { at: 0, promise: undefined, settled: undefined }
    const MENU_TTL_MS = 3000
    function invalidateMenu() {
      menuCache = { at: 0, promise: undefined, settled: menuCache.settled }
    }
    function loadMenuTemplates() {
      const now = Date.now()
      if (menuCache.promise && now - menuCache.at < MENU_TTL_MS) return menuCache.promise
      const promise = call('templates').then(
        (value) => {
          const list = Array.isArray(value?.templates) ? value.templates : []
          if (menuCache.promise === promise) menuCache.settled = list
          setPinned(value?.pinTop !== false)
          return list
        },
        (error) => {
          if (menuCache.promise === promise) menuCache.promise = undefined
          throw error
        },
      )
      menuCache = { at: now, promise, settled: menuCache.settled }
      return promise
    }

    /** Unsaved editor drafts survive closing the Settings dialog (per page load). */
    const drafts = new Map() // file -> { draft, base: { content, mtime } }

    // ─────────────────────────────────────────────── primitives + styles

    const Button = primitives.Button ?? ((props) => h('button', { type: 'button', ...props }))
    const Input = primitives.Input ?? ((props) => h('input', props))
    const Switch = primitives.Switch ?? (({ checked, onChange, label, disabled }) => h('input', {
      type: 'checkbox', checked, disabled, 'aria-label': label, onChange: (event) => onChange(event.target.checked),
    }))
    const rankByName = primitives.rankByName ?? ((items, query) => {
      const q = String(query ?? '').toLowerCase()
      return q === '' ? items : items.filter(item => `${item.name}`.toLowerCase().includes(q))
    })

    const border = '0.5px solid var(--dsw-alias-border-l2)'
    const styles = {
      section: { maxWidth: 760, color: 'var(--dsw-alias-label-primary)', display: 'flex', flexDirection: 'column', gap: 12 },
      editorSection: { maxWidth: 960, color: 'var(--dsw-alias-label-primary)', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 },
      heading: { margin: 0, fontSize: 18, fontWeight: 600 },
      intro: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' },
      groupTitle: { margin: '6px 0 0', fontSize: 15, fontWeight: 600, lineHeight: '22px' },
      card: { border, borderRadius: 10, overflow: 'hidden' },
      optionRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' },
      dirRow: { display: 'flex', gap: 8, alignItems: 'center' },
      dirInput: { flex: 1, minWidth: 0 },
      listHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6 },
      muted: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
      list: { listStyle: 'none', margin: 0, padding: 0, border, borderRadius: 10, overflow: 'hidden' },
      item: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: border },
      itemFirst: { borderTop: 'none' },
      itemText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
      itemName: { fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      tag: { marginLeft: 8, fontSize: 11, padding: '1px 6px', borderRadius: 6, border, color: 'var(--dsw-alias-label-secondary, inherit)', verticalAlign: 1 },
      empty: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' },
      error: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-state-error-primary, #d93026)', whiteSpace: 'pre-wrap' },
      notice: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary, inherit)' },
      // editor view
      toolbar: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      titleBox: { flex: 1, minWidth: 160, display: 'flex', flexDirection: 'column', gap: 2 },
      titleLine: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      editorTitle: { margin: 0, fontSize: 17, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      status: (dirty) => ({
        flex: 'none', fontSize: 11, padding: '1px 7px', borderRadius: 999, border,
        color: dirty ? 'var(--dsw-alias-state-warning-primary, #b26a00)' : 'var(--dsw-alias-label-tertiary)',
      }),
      path: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      banner: (tone) => ({
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px', borderRadius: 8, fontSize: 13, border,
        color: tone === 'error' ? 'var(--dsw-alias-state-error-primary, #d93026)' : 'var(--dsw-alias-label-primary)',
        background: tone === 'error' ? 'var(--dsw-alias-state-error-bg, transparent)' : 'var(--dsw-alias-interactive-bg-hover, transparent)',
      }),
      bannerText: { flex: 1, minWidth: 200 },
      textarea: (focused) => ({
        display: 'block', width: '100%', boxSizing: 'border-box',
        height: 'min(62vh, 760px)', minHeight: 280, resize: 'vertical',
        padding: '12px 14px', borderRadius: 10,
        border: focused ? '1px solid var(--dsw-alias-state-business-primary, #4d6bfe)' : '1px solid var(--dsw-alias-border-l2)',
        outline: 'none', background: 'transparent', color: 'inherit',
        fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei Mono", monospace)',
        fontSize: 13, lineHeight: 1.65, tabSize: 2, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
      }),
      footer: { display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
    }

    function formatSize(bytes) {
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }
    const errorText = (cause) => (cause instanceof Error ? cause.message : String(cause))

    // ─────────────────────────────────────────────── open with…

    /** One button: the Host shows the OS "open with" chooser; the user picks the editor. */
    function OpenWithButton({ t, file, onOpened, onError }) {
      const [busy, setBusy] = useState(false)
      const open = async () => {
        setBusy(true)
        try {
          await call('open-external', { file })
          onOpened()
        } catch (cause) {
          onError(errorText(cause))
        } finally {
          setBusy(false)
        }
      }
      return h(Button, { variant: 'outline', disabled: busy, title: t('openWithTitle'), onClick: open }, t('openWith'))
    }

    // ─────────────────────────────────────────────── editor view

    function EditorView({ t, file, name, onBack }) {
      const [doc, setDoc] = useState(undefined) // { content, mtime, path }
      const [draft, setDraft] = useState('')
      const [saving, setSaving] = useState(false)
      const [focused, setFocused] = useState(false)
      const [banner, setBanner] = useState(undefined) // { tone, text, actions? }
      const [conflictMtime, setConflictMtime] = useState(undefined)
      const [externalMtime, setExternalMtime] = useState(undefined)
      const areaRef = useRef(null)
      const live = useRef(true)
      const docRef = useRef(doc)
      const draftRef = useRef(draft)
      docRef.current = doc
      draftRef.current = draft
      const dirty = doc !== undefined && draft !== doc.content

      useEffect(() => () => { live.current = false }, [])

      // Keep an unsaved draft when the dialog closes or the view unmounts.
      useEffect(() => () => {
        const current = docRef.current
        if (current && draftRef.current !== current.content) {
          drafts.set(file, { draft: draftRef.current, base: { content: current.content, mtime: current.mtime } })
        } else {
          drafts.delete(file)
        }
      }, [file])

      const load = useCallback(async (mode) => {
        const value = await call(fileQuery(file))
        if (!live.current) return
        const next = { content: value.content, mtime: value.mtime, path: value.path }
        setDoc(next)
        setConflictMtime(undefined)
        setExternalMtime(undefined)
        const saved = mode === 'initial' ? drafts.get(file) : undefined
        if (saved && saved.draft !== value.content) {
          setDraft(saved.draft)
          if (saved.base.mtime !== value.mtime) {
            setExternalMtime(value.mtime)
          } else {
            setBanner({ tone: 'info', text: t('restored') })
          }
        } else {
          setDraft(value.content)
          if (mode === 'sync') setBanner({ tone: 'info', text: t('synced') })
        }
        drafts.delete(file)
      }, [file, t])

      useEffect(() => {
        load('initial').catch(cause => { if (live.current) setBanner({ tone: 'error', text: errorText(cause) }) })
        requestAnimationFrame(() => areaRef.current?.focus())
      }, [load])

      // Follow edits made on disk (external editor): poll the file version while visible.
      useEffect(() => {
        let stopped = false
        const check = async () => {
          const current = docRef.current
          if (stopped || !current || saving || document.visibilityState !== 'visible') return
          try {
            const meta = await call(fileQuery(file, true))
            if (stopped || !live.current) return
            const base = docRef.current
            if (!base || Math.abs(meta.mtime - base.mtime) <= 1) return
            if (draftRef.current === base.content) await load('sync')
            else setExternalMtime(meta.mtime)
          } catch (cause) {
            if (!stopped && live.current && cause?.status === 400) setBanner({ tone: 'error', text: t('missing') })
          }
        }
        const timer = setInterval(check, POLL_MS)
        const onFocus = () => { check() }
        window.addEventListener('focus', onFocus)
        return () => {
          stopped = true
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
        }
      }, [file, load, saving, t])

      const save = useCallback(async (force) => {
        const base = docRef.current
        if (!base || saving) return
        const content = draftRef.current
        setSaving(true)
        try {
          const result = await call('file', { file, content, baseMtime: base.mtime, force: force === true })
          if (!live.current) return
          setDoc({ ...base, content, mtime: result.mtime })
          setConflictMtime(undefined)
          setExternalMtime(undefined)
          drafts.delete(file)
          invalidateMenu()
          setBanner({ tone: 'info', text: t('savedAt', { time: new Date().toLocaleTimeString() }) })
        } catch (cause) {
          if (!live.current) return
          if (cause?.status === 409) setConflictMtime(cause.payload?.mtime ?? Date.now())
          else setBanner({ tone: 'error', text: errorText(cause) })
        } finally {
          if (live.current) setSaving(false)
        }
      }, [file, saving, t])

      const discard = () => {
        if (!dirty || window.confirm(t('confirmDiscard'))) {
          setDraft(doc?.content ?? '')
          setExternalMtime(undefined)
          setBanner(undefined)
        }
      }
      const back = () => {
        if (dirty && !window.confirm(t('confirmLeave'))) return
        setDraft(doc?.content ?? '') // unmount must not keep a draft the user discarded
        draftRef.current = doc?.content ?? ''
        onBack()
      }
      const loadDisk = () => {
        load('reload').catch(cause => setBanner({ tone: 'error', text: errorText(cause) }))
        setBanner(undefined)
      }

      const onKeyDown = (event) => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
          event.preventDefault()
          save(false)
          return
        }
        if (event.target === areaRef.current && event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent?.isComposing) {
          event.preventDefault()
          const area = areaRef.current
          area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end')
          setDraft(area.value)
        }
      }

      const stats = useMemo(() => ({
        lines: draft === '' ? 0 : draft.split('\n').length,
        chars: [...draft].length,
      }), [draft])

      let notice = null
      if (conflictMtime !== undefined) {
        notice = h('div', { style: styles.banner('error'), role: 'alert' },
          h('span', { style: styles.bannerText }, t('conflict')),
          h(Button, { size: 'sm', variant: 'outline', onClick: loadDisk }, t('loadDisk')),
          h(Button, { size: 'sm', variant: 'primary', onClick: () => save(true) }, t('overwrite')))
      } else if (externalMtime !== undefined) {
        notice = h('div', { style: styles.banner('warn'), role: 'status' },
          h('span', { style: styles.bannerText }, t('externalChanged')),
          h(Button, { size: 'sm', variant: 'outline', onClick: loadDisk }, t('loadDisk')),
          h(Button, {
            size: 'sm',
            variant: 'ghost',
            // Keep the edits; the next save overwrites the disk version on purpose.
            onClick: () => {
              setDoc(d => d && { ...d, mtime: externalMtime })
              setExternalMtime(undefined)
            },
          }, t('keepMine')))
      } else if (banner) {
        notice = h('div', { style: styles.banner(banner.tone), role: banner.tone === 'error' ? 'alert' : 'status' },
          h('span', { style: styles.bannerText }, banner.text))
      }

      return h('div', { style: styles.editorSection, onKeyDown },
        h('div', { style: styles.toolbar },
          h(Button, { variant: 'ghost', size: 'sm', onClick: back, title: t('back') }, `← ${t('back')}`),
          h('div', { style: styles.titleBox },
            h('div', { style: styles.titleLine },
              h('h2', { style: styles.editorTitle, title: file }, name),
              h('span', { style: styles.status(dirty) },
                doc === undefined ? t('statusLoading') : dirty ? t('statusDirty') : t('statusSaved'))),
            h('span', { style: styles.path, title: doc?.path ?? file }, doc?.path ?? file)),
          h(OpenWithButton, {
            t,
            file,
            onOpened: () => setBanner({ tone: 'info', text: t('openWithOpened') }),
            onError: (text) => setBanner({ tone: 'error', text }),
          }),
          h(Button, { variant: 'outline', disabled: !dirty || saving, onClick: discard }, t('discard')),
          h(Button, { variant: 'primary', disabled: !dirty || saving || doc === undefined, onClick: () => save(false) },
            saving ? t('saving') : t('save'))),
        notice,
        h('textarea', {
          ref: areaRef,
          value: draft,
          disabled: doc === undefined,
          spellCheck: false,
          placeholder: t('editorPlaceholder'),
          'aria-label': name,
          style: styles.textarea(focused),
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          onChange: (event) => setDraft(event.target.value),
        }),
        h('div', { style: styles.footer },
          h('span', null, t('stats', stats)),
          h('span', null, t('footerHint'))))
    }

    // ─────────────────────────────────────────────── list view + page

    function makePage(t) {
      return function PromptTemplatesSection() {
        const [state, setState] = useState(undefined)
        const [draft, setDraft] = useState('')
        const [busy, setBusy] = useState(undefined) // 'load' | 'pick' | 'refresh' | 'dir' | 'toggle' | 'pin'
        const [error, setError] = useState(undefined)
        const [notice, setNotice] = useState(undefined)
        const [editing, setEditing] = useState(undefined) // { file, name }
        const alive = useRef(true)
        useEffect(() => () => { alive.current = false }, [])

        const accept = useCallback((next) => {
          if (!alive.current) return
          setState(next)
          setDraft(next.directory ?? '')
          setError(next.error)
          setPinned(next.pinTop !== false)
          invalidateMenu()
        }, [])

        const run = useCallback(async (kind, task) => {
          setBusy(kind)
          setError(undefined)
          setNotice(undefined)
          try {
            await task()
          } catch (cause) {
            if (alive.current) setError(errorText(cause))
          } finally {
            if (alive.current) setBusy(undefined)
          }
        }, [])

        useEffect(() => {
          run('load', async () => accept(await call('state')))
        }, [run, accept])

        if (editing) {
          return h(EditorView, {
            t,
            file: editing.file,
            name: editing.name,
            onBack: () => {
              setEditing(undefined)
              run('refresh', async () => accept(await call('state'))) // sizes changed
            },
          })
        }

        const applyDirectory = (directory) => run('dir', async () => accept(await call('directory', { directory })))
        const refresh = () => run('refresh', async () => accept(await call('refresh', {})))
        const pick = () => run('pick', async () => {
          const result = await call('pick', {})
          if (result.unsupported) {
            if (alive.current) setNotice(t('pickerUnsupported'))
            return
          }
          if (typeof result.path === 'string' && result.path !== '') accept(await call('directory', { directory: result.path }))
        })
        const toggle = (file, active) => {
          setState(prev => prev && { ...prev, templates: prev.templates.map(tpl => (tpl.file === file ? { ...tpl, active } : tpl)) })
          run('toggle', async () => accept(await call('active', { file, active })))
        }
        const togglePin = (next) => {
          setState(prev => prev && { ...prev, pinTop: next })
          run('pin', async () => accept(await call('settings', { pinTop: next })))
        }

        const templates = state?.templates ?? []
        const activeCount = templates.filter(tpl => tpl.active).length
        const disabled = busy !== undefined && busy !== 'toggle' && busy !== 'pin'

        let listBody
        if (state === undefined) listBody = h('p', { style: styles.empty }, t('loading'))
        else if (!state.directory) listBody = h('p', { style: styles.empty }, t('noDir'))
        else if (templates.length === 0) listBody = h('p', { style: styles.empty }, t('empty'))
        else {
          listBody = h('ul', { style: styles.list }, templates.map((tpl, index) => h('li', {
            key: tpl.file,
            style: index === 0 ? { ...styles.item, ...styles.itemFirst } : styles.item,
          },
          h('div', { style: styles.itemText },
            h('span', { style: styles.itemName, title: tpl.file },
              tpl.name,
              drafts.has(tpl.file) ? h('span', { style: styles.tag }, t('draftTag')) : null),
            h('span', { style: styles.muted }, `${tpl.file} · ${formatSize(tpl.size)}`)),
          h(Button, {
            variant: 'ghost',
            size: 'sm',
            'aria-label': t('editAria', { name: tpl.name }),
            disabled: state.hostProtocol !== HOST_PROTOCOL,
            title: state.hostProtocol !== HOST_PROTOCOL ? t('hostOutdated') : undefined,
            onClick: () => setEditing({ file: tpl.file, name: tpl.name }),
          }, t('edit')),
          h(Switch, {
            checked: tpl.active === true,
            label: t('toggle', { name: tpl.name }),
            title: tpl.file,
            onChange: (next) => toggle(tpl.file, next),
          }))))
        }

        const hostOutdated = state !== undefined && state.hostProtocol !== HOST_PROTOCOL

        return h('div', { style: styles.section },
          h('h2', { style: styles.heading }, t('title'), h('span', { style: { ...styles.muted, fontWeight: 400, marginLeft: 8 } }, `v${VERSION}`)),
          h('p', { style: styles.intro }, t('intro')),
          hostOutdated ? h('div', { style: styles.banner('error'), role: 'alert' }, h('span', { style: styles.bannerText }, t('hostOutdated'))) : null,

          h('h3', { style: styles.groupTitle }, t('menuGroup')),
          h('div', { style: styles.card },
            h('div', { style: styles.optionRow },
              h('div', { style: styles.itemText },
                h('span', { style: { fontSize: 14 } }, t('pinTitle')),
                h('span', { style: styles.muted }, t('pinDesc'))),
              h(Switch, {
                checked: state ? state.pinTop !== false : true,
                disabled: state === undefined,
                label: t('pinTitle'),
                onChange: togglePin,
              }))),

          h('h3', { style: styles.groupTitle }, t('dirLabel')),
          h('div', { style: styles.dirRow },
            h('div', { style: styles.dirInput },
              h(Input, {
                value: draft,
                placeholder: t('dirPlaceholder'),
                spellCheck: false,
                disabled: busy === 'dir' || busy === 'pick',
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.nativeEvent?.isComposing) {
                    event.preventDefault()
                    applyDirectory(draft)
                  }
                },
                style: { width: '100%' },
              })),
            draft !== (state?.directory ?? '')
              ? h(Button, { variant: 'outline', disabled, onClick: () => applyDirectory(draft) }, t('apply'))
              : null,
            h(Button, { variant: 'primary', disabled, onClick: pick }, busy === 'pick' ? t('choosing') : t('choose'))),
          error ? h('p', { style: styles.error, role: 'alert' }, error) : null,
          notice ? h('p', { style: styles.notice }, notice) : null,

          h('div', { style: styles.listHead },
            h('div', null,
              h('h3', { style: { ...styles.groupTitle, margin: 0 } }, t('listTitle', { count: templates.length })),
              templates.length > 0 ? h('span', { style: styles.muted }, t('activeCount', { count: activeCount })) : null),
            h(Button, { variant: 'outline', size: 'sm', disabled: disabled || !state?.directory, onClick: refresh },
              busy === 'refresh' ? t('refreshing') : t('refresh'))),
          listBody)
      }
    }

    // ─────────────────────────────────────────────── `/` trigger source

    /**
     * @param commands - `remote.commands`, reachable only through a context
     *   that injected it (Cordis refuses undeclared service properties).
     */
    function makeSource(commands, t) {
      /** Claim the composer for one template: `/名称 ` then the first message. */
      const claimFor = (template, session) => ({
        claim: {
          name: COMMAND_NAME,
          token: `/${template.name} `,
          hint: t('hint'),
          attachments: true,
          async submit(args, _actx, attachments) {
            const result = await commands.execute(session.sessionId, `/${COMMAND_NAME} ${template.id} ${args}`, attachments ?? [])
            if (!result?.ok) throw new Error(`command.execute failed: ${result?.error?.code ?? ''}: ${result?.error?.message ?? ''}`)
            if (result.value === undefined) return { kind: 'error', text: t('commandUnavailable') }
            invalidateMenu()
            const outcome = result.value.result
            // A blank session does not render command rows, so surface refusals in the composer.
            return outcome?.kind === 'error' ? { kind: 'error', text: outcome.text } : { kind: 'success' }
          },
        },
      })

      const leadingName = (line) => {
        const match = /^\/(\S+)/.exec(line ?? '')
        return match ? match[1] : undefined
      }
      const byToken = (list, token) => list.find(tpl => tpl.name === token)

      return {
        trigger: '/',
        name: 'prompt-template',
        async candidates(session, request) {
          if (request.position !== 'leading') return []
          let list
          try {
            list = await loadMenuTemplates()
          } catch {
            return []
          }
          if (request.signal?.aborted) return []
          const rows = list.map(tpl => ({
            name: tpl.name,
            label: tpl.name,
            description: t('menuDescription'),
            hint: t('hint'),
            value: tpl.id,
          }))
          return rankByName(rows, request.query ?? '')
        },
        warm() {
          loadMenuTemplates().catch(() => {})
        },
        onPick({ candidate, session }) {
          const list = menuCache.settled ?? []
          const template = list.find(tpl => tpl.id === candidate.value) ?? { id: candidate.value, name: candidate.name }
          return claimFor(template, session)
        },
        matchSpace(session, token) {
          const name = leadingName(token)
          const template = name && byToken(menuCache.settled ?? [], name)
          return template ? claimFor(template, session) : undefined
        },
        async matchEnter(session, line) {
          const name = leadingName(line)
          if (!name) return undefined
          let list
          try {
            list = await loadMenuTemplates()
          } catch {
            return undefined
          }
          const template = byToken(list, name)
          return template ? claimFor(template, session) : undefined
        },
      }
    }

    // ─────────────────────────────────────────────── plugin

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-prompt-switcher: dictionaries')
        const t = ctx.locale.bind(NS)
        hostText = t
        const Page = makePage(t)

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 25,
          label: () => t('nav'),
          locale: NS,
        }, Page))

        // The `/` source needs the trigger pipeline and the Host command RPC.
        // Declaring `remote.commands` here is what makes `tctx.remote.commands`
        // readable (the official command source injects the same names).
        ctx.inject(['inputTriggers', 'remote', 'remote.commands'], (tctx) => {
          const base = makeSource(tctx.remote.commands, t)
          let unregister
          const register = () => {
            unregister?.()
            unregister = tctx.inputTriggers.registerSource({ ...base, order: pin.value ? ORDER_PINNED : ORDER_UNPINNED })
          }
          register()
          pin.listeners.add(register)
          tctx.effect(() => () => {
            pin.listeners.delete(register)
            unregister?.()
            unregister = undefined
          }, 'dsh-prompt-switcher: / source')
          // Learn the saved pin preference (re-registers only when it differs).
          loadMenuTemplates().catch(() => {})
        })
      },
    }
  },
})
