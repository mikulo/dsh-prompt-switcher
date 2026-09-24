/**
 * dsh-prompt-switcher — Browser half (plain module-loader artifact, no build).
 *
 * 1. Settings → "提示词模板" page
 *    - menu option: pin the templates above the built-in `/` commands (default on);
 *    - global prompt: on/off, a `.md` file from the list (named after the file)
 *      or a custom text named by the user; bound to every new conversation,
 *      with `/` templates appended after it;
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
    const VERSION = '__PLUGIN_VERSION__'
    const NS = 'prompt-switcher'
    const API = '/api/dsh-prompt-switcher'
    const COMMAND_NAME = 'prompt-template'
    const SECTION_ID = 'prompt-switcher'
    /** Trigger-source orders: built-in commands use 0 and skills 2. */
    const ORDER_PINNED = -100
    const ORDER_UNPINNED = 100
    const POLL_MS = 2000
    /** Must equal HOST_PROTOCOL in index.js; a mismatch means `dsh web` still runs an older Host half. */
    const HOST_PROTOCOL = 5
    /** Select value for a global-prompt file outside the current template folder. */
    const EXTERNAL_FILE = '\u0000external'

    const zh = {
      nav: '提示词模板',
      title: '提示词模板',
      intro: '选择一个本地目录，插件会读取该目录（不含子目录）下所有 .md 文件作为提示词模板。激活后，在新对话中输入 / 即可选择模板；模板的约束力等同于 AGENTS.md，并对该对话的所有后续轮次持续生效。还可以设置一个全局提示词，让之后新建的每个对话都遵守它。',
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
      // global prompt
      globalGroup: '全局提示词',
      globalTitle: '启用全局提示词',
      globalDesc: '开启后，之后新建的每个对话都会遵守全局提示词（约束力等同于 AGENTS.md）。在新对话中用 / 选择的模板会追加在全局提示词之后，而不是替换它。已开始的对话不受影响。',
      globalSource: '来源',
      globalSourceFile: '模板文件',
      globalSourceCustom: '自定义文本',
      globalFileLabel: '选择一个 .md 文件（以文件名作为全局提示词名称）',
      globalFilePlaceholder: '请选择 .md 文件…',
      globalFileExternal: '{file}（不在当前模板目录）',
      globalFileNoDir: '请先在下方配置模板目录，再从中选择文件。',
      globalNameLabel: '名称',
      globalNamePlaceholder: '为全局提示词取一个名字（必填）',
      globalContentPlaceholder: '在这里输入全局提示词（Markdown）…',
      globalSave: '保存',
      globalSaving: '保存中…',
      globalDiscard: '放弃修改',
      globalDirty: '未保存',
      globalSaved: '已保存',
      globalActive: '生效中：「{name}」，将注入之后新建的每个对话。',
      globalInactive: '未启用。',
      globalBroken: '全局提示词未生效：{error}',
      globalCustomNote: '点击“保存”后写入模板目录，并用于之后新建的对话。',
      globalSaveTarget: '保存为：{path}',
      globalSaveNoDir: '请先在下方配置模板目录：自定义全局提示词会保存为该目录下的“名称.md”。',
      globalOverwrite: '模板目录中已存在同名文件“{file}”。\n\n是否用当前内容覆盖该文件？',
      menuDescriptionGlobal: '提示词模板 · 追加在全局提示词「{name}」之后',
      // tabs
      tabPrompts: '提示词设置',
      tabWebdav: 'WebDAV 云同步',
      // WebDAV
      davIntro: '通过 WebDAV 在多台设备之间同步提示词模板（模板目录第一层的 .md 文件，不含子目录）。',
      davServer: '服务器',
      davUrl: '地址',
      davUrlPlaceholder: 'https://dav.example.com/dav/prompts/',
      davUrlHint: '填写存放提示词模板的 WebDAV 目录地址。',
      davUser: '用户名',
      davPassword: '密码',
      davPasswordSaved: '已保存（留空则保持不变）',
      davPasswordPlaceholder: '密码或应用专用密码',
      davClearPassword: '清除已保存的密码',
      davProxy: '代理',
      davProxyTitle: '通过代理连接',
      davProxyDesc: '默认关闭。开启后，测试连接和同步都经过此代理。',
      davProxyType: '类型',
      davProxyAddress: '代理地址',
      davProxyAddressHint: '格式：主机:端口，默认 {address}',
      davTest: '测试连接',
      davTesting: '测试中…',
      davSave: '保存配置',
      davSaving: '保存中…',
      davDiscard: '放弃修改',
      davDirty: '未保存',
      davSaved: '已保存',
      davSavedAt: '配置已保存（{time}）',
      davSync: '同步',
      davPullTitle: '云端 → 本地',
      davPullDesc: '列出云端目录中的 .md 模板，选择后下载到本地模板目录。',
      davPull: '同步到本地…',
      davPushTitle: '本地 → 云端',
      davPushDesc: '列出本地模板目录中的 .md 模板，选择后上传到云端目录。',
      davPush: '同步到云端…',
      davListing: '读取中…',
      davNeedUrl: '请先填写并保存 WebDAV 地址。',
      davNeedSave: '配置有未保存的修改，请先保存再同步。',
      davNeedDir: '请先在“提示词设置”中配置模板目录。',
      davPanelPull: '同步到本地',
      davPanelPush: '同步到云端',
      davFrom: '从：{from}',
      davTo: '到：{to}',
      davSelectAll: '全选',
      davUnselectAll: '取消全选',
      davSelected: '已选 {count} / {total}',
      davEmptyRemote: '云端目录中没有 .md 文件。',
      davEmptyLocal: '本地模板目录中没有 .md 文件。',
      davRemoteMissing: '云端目录还不存在，同步时会自动创建。',
      davConflictLocal: '本地已有同名文件',
      davConflictRemote: '云端已有同名文件',
      davCancel: '取消',
      davRunPull: '同步到本地（{count}）',
      davRunPush: '同步到云端（{count}）',
      davRunning: '同步中…',
      davAskPull: '本地模板目录中已存在“{name}”。是否用云端文件覆盖本地文件？',
      davAskPush: '云端目录中已存在“{name}”。是否用本地文件覆盖云端文件？',
      davAskProgress: '同名文件 {index} / {total}',
      davOverwrite: '覆盖',
      davSkip: '跳过',
      davOverwriteAll: '全部覆盖',
      davSkipAll: '全部跳过',
      davAbort: '取消同步',
      davSummary: '完成：新增 {created} 个，覆盖 {overwritten} 个，跳过 {skipped} 个，失败 {failed} 个。',
      davStatusCreated: '已新增',
      davStatusOverwritten: '已覆盖',
      davStatusSkipped: '已跳过',
      davStatusError: '失败',
      davDone: '完成',
      davRelist: '重新读取列表',
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
      globalGroup: 'Global prompt',
      globalTitle: 'Enable the global prompt',
      globalDesc: 'When on, every conversation started afterwards obeys the global prompt (AGENTS.md-level authority). A template picked with / in a new conversation is appended after the global prompt instead of replacing it. Conversations already started are not affected.',
      globalSource: 'Source',
      globalSourceFile: 'Template file',
      globalSourceCustom: 'Custom text',
      globalFileLabel: 'Pick a .md file (its file name becomes the prompt name)',
      globalFilePlaceholder: 'Choose a .md file…',
      globalFileExternal: '{file} (outside the current template folder)',
      globalFileNoDir: 'Configure the template folder below first, then pick a file from it.',
      globalNameLabel: 'Name',
      globalNamePlaceholder: 'Name this global prompt (required)',
      globalContentPlaceholder: 'Write the global prompt (Markdown) here…',
      globalSave: 'Save',
      globalSaving: 'Saving…',
      globalDiscard: 'Discard changes',
      globalDirty: 'Unsaved',
      globalSaved: 'Saved',
      globalActive: 'Active: "{name}" is injected into every new conversation.',
      globalInactive: 'Off.',
      globalBroken: 'The global prompt is not applied: {error}',
      globalCustomNote: 'Save writes it into the template folder and uses it for conversations started afterwards.',
      globalSaveTarget: 'Saved as: {path}',
      globalSaveNoDir: 'Configure the template folder below first: the custom prompt is saved there as "name.md".',
      globalOverwrite: 'The template folder already has a file named "{file}".\n\nOverwrite it with this text?',
      menuDescriptionGlobal: 'Prompt template · appended after the global prompt "{name}"',
      tabPrompts: 'Prompts',
      tabWebdav: 'WebDAV sync',
      davIntro: 'Sync prompt templates between devices over WebDAV (the .md files directly inside the template folder).',
      davServer: 'Server',
      davUrl: 'URL',
      davUrlPlaceholder: 'https://dav.example.com/dav/prompts/',
      davUrlHint: 'The WebDAV folder that holds your prompt templates.',
      davUser: 'Username',
      davPassword: 'Password',
      davPasswordSaved: 'Saved (leave empty to keep it)',
      davPasswordPlaceholder: 'Password or app password',
      davClearPassword: 'Clear saved password',
      davProxy: 'Proxy',
      davProxyTitle: 'Connect through a proxy',
      davProxyDesc: 'Off by default. When on, the connection test and every sync go through this proxy.',
      davProxyType: 'Type',
      davProxyAddress: 'Proxy address',
      davProxyAddressHint: 'Format host:port, default {address}',
      davTest: 'Test connection',
      davTesting: 'Testing…',
      davSave: 'Save settings',
      davSaving: 'Saving…',
      davDiscard: 'Discard changes',
      davDirty: 'Unsaved',
      davSaved: 'Saved',
      davSavedAt: 'Settings saved ({time})',
      davSync: 'Sync',
      davPullTitle: 'Cloud → local',
      davPullDesc: 'List the .md templates in the WebDAV folder and download the chosen ones into the template folder.',
      davPull: 'Sync to local…',
      davPushTitle: 'Local → cloud',
      davPushDesc: 'List the .md templates in the template folder and upload the chosen ones to the WebDAV folder.',
      davPush: 'Sync to cloud…',
      davListing: 'Loading…',
      davNeedUrl: 'Enter and save the WebDAV URL first.',
      davNeedSave: 'Save the changed settings before syncing.',
      davNeedDir: 'Configure the template folder under "Prompts" first.',
      davPanelPull: 'Sync to local',
      davPanelPush: 'Sync to cloud',
      davFrom: 'From: {from}',
      davTo: 'To: {to}',
      davSelectAll: 'Select all',
      davUnselectAll: 'Unselect all',
      davSelected: '{count} / {total} selected',
      davEmptyRemote: 'No .md files in the WebDAV folder.',
      davEmptyLocal: 'No .md files in the template folder.',
      davRemoteMissing: 'The WebDAV folder does not exist yet; it is created on sync.',
      davConflictLocal: 'Exists locally',
      davConflictRemote: 'Exists in the cloud',
      davCancel: 'Cancel',
      davRunPull: 'Sync to local ({count})',
      davRunPush: 'Sync to cloud ({count})',
      davRunning: 'Syncing…',
      davAskPull: '"{name}" already exists in the template folder. Overwrite the local file with the cloud file?',
      davAskPush: '"{name}" already exists in the WebDAV folder. Overwrite the cloud file with the local file?',
      davAskProgress: 'Same-name file {index} of {total}',
      davOverwrite: 'Overwrite',
      davSkip: 'Skip',
      davOverwriteAll: 'Overwrite all',
      davSkipAll: 'Skip all',
      davAbort: 'Cancel sync',
      davSummary: 'Done: {created} added, {overwritten} overwritten, {skipped} skipped, {failed} failed.',
      davStatusCreated: 'Added',
      davStatusOverwritten: 'Overwritten',
      davStatusSkipped: 'Skipped',
      davStatusError: 'Failed',
      davDone: 'Done',
      davRelist: 'Reload list',
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
    /** Name of the global prompt new conversations bind (menu rows mention it), if any. */
    let menuGlobal
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
          menuGlobal = value?.global?.effective === true && typeof value.global.name === 'string' ? value.global.name : undefined
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

    /** Last settings tab shown ('prompts' | 'webdav'), kept per page load. */
    let lastTab = 'prompts'

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
        color: tone === 'error'
          ? 'var(--dsw-alias-state-error-primary, #d93026)'
          : tone === 'ok'
            ? 'var(--dsw-alias-state-success-primary, #1a7f37)'
            : tone === 'warn' ? 'var(--dsw-alias-state-warning-primary, #b26a00)' : 'var(--dsw-alias-label-primary)',
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
      // tabs
      tabs: { display: 'flex', gap: 4, borderBottom: border, marginTop: 2 },
      tab: (selected) => ({
        appearance: 'none', background: 'transparent', border: 'none', cursor: 'pointer',
        padding: '8px 12px', marginBottom: -1, fontSize: 14, fontWeight: selected ? 600 : 400,
        color: selected ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
        borderBottom: selected ? '2px solid var(--dsw-alias-state-business-primary, #4d6bfe)' : '2px solid transparent',
      }),
      // WebDAV forms
      formBody: { display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 14px' },
      field: { display: 'flex', alignItems: 'flex-start', gap: 12 },
      fieldLabel: { flex: 'none', width: 84, fontSize: 13, lineHeight: '32px', color: 'var(--dsw-alias-label-secondary, inherit)' },
      fieldControl: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
      segmented: { display: 'flex', gap: 6, alignItems: 'center', minHeight: 32 },
      actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' },
      checkRow: { display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, cursor: 'pointer' },
      checkbox: { width: 16, height: 16, flex: 'none', margin: 0, accentColor: 'var(--dsw-alias-state-business-primary, #4d6bfe)' },
      resultTag: (status) => ({
        flex: 'none', fontSize: 12, padding: '1px 8px', borderRadius: 999, border,
        color: status === 'error'
          ? 'var(--dsw-alias-state-error-primary, #d93026)'
          : status === 'skipped' ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-state-success-primary, #1a7f37)',
      }),
      // global prompt card
      globalRow: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 14px' },
      globalBody: { display: 'flex', flexDirection: 'column', gap: 8 },
      select: {
        width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', fontSize: 13,
      },
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

    // ─────────────────────────────────────────────── global prompt

    /**
     * Global prompt card: on/off, source (template file | custom text), the
     * file picker or the name + text editor, and the live status.
     * @param accept - adopts a fresh `state` answer from the Host.
     */
    function GlobalSection({ t, state, accept }) {
      const global = state?.global
      const [name, setName] = useState('')
      const [content, setContent] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(undefined)
      const [focused, setFocused] = useState(false)
      const alive = useRef(true)
      const synced = useRef(undefined) // last Host values of the custom fields
      useEffect(() => () => { alive.current = false }, [])

      // Adopt Host values unless the user has unsaved edits against the previous ones.
      const hostName = global?.customName
      const hostContent = global?.customContent
      useEffect(() => {
        if (hostName === undefined) return
        const prev = synced.current
        setName(current => (prev === undefined || current === prev.name ? hostName : current))
        setContent(current => (prev === undefined || current === prev.content ? hostContent : current))
        synced.current = { name: hostName, content: hostContent }
      }, [hostName, hostContent])

      if (!global) return null
      const dirty = name !== global.customName || content !== global.customContent
      // Text kept inline by 1.2.0 still has to be written to its file.
      const unsaved = dirty || (!global.customFile && global.customName !== '')
      const custom = global.source === 'custom'
      const trimmedName = name.trim()
      const separator = (state.directory ?? '').includes('\\') ? '\\' : '/'
      const savePath = state.directory && trimmedName !== ''
        ? `${state.directory.replace(/[\\/]+$/, '')}${separator}${trimmedName}.md`
        : ''

      const send = async (body) => {
        setBusy(true)
        setError(undefined)
        try {
          let next
          try {
            next = await call('global', body)
          } catch (cause) {
            // Saving the custom text would replace another file of the same name: ask first.
            if (cause?.status !== 409 || cause.payload?.conflict !== 'file-exists') throw cause
            if (!window.confirm(t('globalOverwrite', { file: cause.payload.file }))) return
            next = await call('global', { ...body, overwrite: true })
          }
          if (alive.current) accept(next)
        } catch (cause) {
          if (alive.current) setError(errorText(cause))
        } finally {
          if (alive.current) setBusy(false)
        }
      }
      // Enabling a custom prompt saves the draft in the same request.
      const toggle = (enabled) => send(enabled && custom && unsaved
        ? { enabled, customName: name, customContent: content }
        : { enabled })
      const saveCustom = () => send({ customName: name, customContent: content })
      const discardCustom = () => {
        setName(global.customName)
        setContent(global.customContent)
      }

      const templates = state.templates ?? []
      let fileValue = ''
      if (global.filePath) fileValue = global.inDirectory ? global.file : EXTERNAL_FILE

      let status
      if (!global.enabled) status = h('span', { style: styles.muted }, t('globalInactive'))
      else if (global.effective) status = h('span', { style: styles.muted }, t('globalActive', { name: global.name }))
      else status = h('span', { style: styles.error }, t('globalBroken', { error: global.error ?? '' }))

      const sourceButton = (value, label) => h(Button, {
        size: 'sm',
        variant: global.source === value ? 'primary' : 'outline',
        disabled: busy,
        'aria-pressed': global.source === value,
        onClick: () => { if (global.source !== value) send({ source: value }) },
      }, label)

      let body
      if (!custom) {
        body = h('div', { style: styles.globalBody },
          h('span', { style: styles.muted }, t('globalFileLabel')),
          state.directory
            ? h('select', {
              value: fileValue,
              disabled: busy,
              style: styles.select,
              'aria-label': t('globalFileLabel'),
              onChange: (event) => {
                const value = event.target.value
                if (value !== EXTERNAL_FILE) send({ file: value })
              },
            },
            h('option', { value: '' }, t('globalFilePlaceholder')),
            fileValue === EXTERNAL_FILE
              ? h('option', { value: EXTERNAL_FILE }, t('globalFileExternal', { file: global.file }))
              : null,
            templates.map(tpl => h('option', { key: tpl.file, value: tpl.file }, tpl.file)))
            : h('span', { style: styles.muted }, t('globalFileNoDir')),
          global.filePath ? h('span', { style: styles.path, title: global.filePath }, global.filePath) : null)
      } else {
        body = h('div', { style: styles.globalBody },
          h('label', { style: styles.muted }, t('globalNameLabel')),
          h(Input, {
            value: name,
            placeholder: t('globalNamePlaceholder'),
            spellCheck: false,
            maxLength: 80,
            disabled: busy,
            onChange: (event) => setName(event.target.value),
            style: { width: '100%' },
          }),
          h('textarea', {
            value: content,
            disabled: busy,
            spellCheck: false,
            placeholder: t('globalContentPlaceholder'),
            'aria-label': t('globalGroup'),
            style: { ...styles.textarea(focused), height: 220, minHeight: 120 },
            onFocus: () => setFocused(true),
            onBlur: () => setFocused(false),
            onChange: (event) => setContent(event.target.value),
            onKeyDown: (event) => {
              if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
                event.preventDefault()
                if (unsaved && state.directory) saveCustom()
              }
            },
          }),
          h('span', { style: styles.path, title: savePath }, savePath
            ? t('globalSaveTarget', { path: savePath })
            : t('globalSaveNoDir')),
          h('div', { style: styles.toolbar },
            h('span', { style: styles.status(unsaved) }, unsaved ? t('globalDirty') : t('globalSaved')),
            h('span', { style: { ...styles.muted, flex: 1 } }, t('globalCustomNote')),
            h(Button, { variant: 'outline', size: 'sm', disabled: !dirty || busy, onClick: discardCustom }, t('globalDiscard')),
            h(Button, { variant: 'primary', size: 'sm', disabled: !unsaved || busy || !state.directory, onClick: saveCustom },
              busy ? t('globalSaving') : t('globalSave'))))
      }

      return h('div', { style: styles.card },
        h('div', { style: styles.optionRow },
          h('div', { style: styles.itemText },
            h('span', { style: { fontSize: 14 } }, t('globalTitle')),
            h('span', { style: styles.muted }, t('globalDesc'))),
          h(Switch, {
            checked: global.enabled === true,
            disabled: busy,
            label: t('globalTitle'),
            onChange: toggle,
          })),
        h('div', { style: { ...styles.optionRow, borderTop: border } },
          h('span', { style: { fontSize: 14, flex: 'none' } }, t('globalSource')),
          sourceButton('file', t('globalSourceFile')),
          sourceButton('custom', t('globalSourceCustom'))),
        h('div', { style: { ...styles.globalRow, borderTop: border } }, body),
        h('div', { style: { ...styles.globalRow, borderTop: border } },
          status,
          error ? h('p', { style: styles.error, role: 'alert' }, error) : null))
    }

    // ─────────────────────────────────────────────── WebDAV sync view

    const formFrom = (webdav) => ({
      url: webdav.url,
      username: webdav.username,
      password: '',
      proxyEnabled: webdav.proxyEnabled === true,
      proxyType: webdav.proxyType === 'socks5' ? 'socks5' : 'http',
      proxyAddress: webdav.proxyAddress || webdav.defaultProxyAddress,
    })
    const formDirty = (form, webdav) => form.url.trim() !== webdav.url ||
      form.username !== webdav.username ||
      form.password !== '' ||
      form.proxyEnabled !== webdav.proxyEnabled ||
      form.proxyType !== webdav.proxyType ||
      (form.proxyAddress.trim() || webdav.defaultProxyAddress) !== webdav.proxyAddress
    const formatTime = (ms) => (typeof ms === 'number' ? new Date(ms).toLocaleString() : '')

    /** One labelled form row: label column + control column. */
    function Field({ label, hint, children }) {
      return h('div', { style: styles.field },
        h('span', { style: styles.fieldLabel }, label),
        h('div', { style: styles.fieldControl }, children, hint ? h('span', { style: styles.muted }, hint) : null))
    }

    /** Segmented choice (two or more small buttons). */
    function Segmented({ value, options, disabled, onChange }) {
      return h('div', { style: styles.segmented, role: 'radiogroup' }, options.map(option => h(Button, {
        key: option.value,
        size: 'sm',
        variant: value === option.value ? 'primary' : 'outline',
        disabled,
        role: 'radio',
        'aria-checked': value === option.value,
        onClick: () => { if (value !== option.value) onChange(option.value) },
      }, option.label)))
    }

    /**
     * Selection list for one sync direction, the same-name confirmation flow,
     * and the per-file results.
     * @param mode - 'pull' (cloud → local) or 'push' (local → cloud).
     */
    function SyncPanel({ t, mode, listing, onClose, onReload, onSynced }) {
      const selectable = useMemo(() => listing.files.filter(f => !f.invalid).map(f => f.name), [listing])
      const [selected, setSelected] = useState(() => new Set(selectable))
      const [ask, setAsk] = useState(undefined) // { queue: string[], index, overwrite: string[] }
      const [running, setRunning] = useState(false)
      const [results, setResults] = useState(undefined)
      const [error, setError] = useState(undefined)
      const alive = useRef(true)
      useEffect(() => () => { alive.current = false }, [])

      const pull = mode === 'pull'
      const allSelected = selectable.length > 0 && selectable.every(name => selected.has(name))
      const chosen = selectable.filter(name => selected.has(name))
      const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectable))
      const toggleOne = (name, on) => setSelected((prev) => {
        const next = new Set(prev)
        if (on) next.add(name)
        else next.delete(name)
        return next
      })

      const perform = async (overwrite) => {
        setAsk(undefined)
        setRunning(true)
        setError(undefined)
        try {
          const value = await call(pull ? 'webdav/pull' : 'webdav/push', { files: chosen, overwrite })
          if (!alive.current) return
          setResults(value.results ?? [])
          onSynced()
        } catch (cause) {
          if (alive.current) setError(errorText(cause))
        } finally {
          if (alive.current) setRunning(false)
        }
      }
      const start = () => {
        const conflicts = listing.files.filter(f => f.conflict && selected.has(f.name)).map(f => f.name)
        if (conflicts.length === 0) perform([])
        else setAsk({ queue: conflicts, index: 0, overwrite: [] })
      }
      /** Answer the current same-name question; `all` applies it to the remaining ones. */
      const answer = (overwriteIt, all) => {
        const rest = ask.queue.slice(ask.index)
        const overwrite = [...ask.overwrite]
        if (all) {
          if (overwriteIt) overwrite.push(...rest)
          perform(overwrite)
          return
        }
        if (overwriteIt) overwrite.push(ask.queue[ask.index])
        if (ask.index + 1 >= ask.queue.length) perform(overwrite)
        else setAsk({ ...ask, index: ask.index + 1, overwrite })
      }

      const title = pull ? t('davPanelPull') : t('davPanelPush')
      const from = pull ? listing.url : listing.directory
      const to = pull ? listing.directory : listing.url

      let content
      if (results) {
        const count = (status) => results.filter(r => r.status === status).length
        content = h('div', { style: styles.globalBody },
          h('p', { style: styles.notice, role: 'status' }, t('davSummary', {
            created: count('created'), overwritten: count('overwritten'), skipped: count('skipped'), failed: count('error'),
          })),
          h('ul', { style: styles.list }, results.map((r, index) => h('li', {
            key: r.name,
            style: index === 0 ? { ...styles.item, ...styles.itemFirst } : styles.item,
          },
          h('div', { style: styles.itemText },
            h('span', { style: styles.itemName, title: r.name }, r.name),
            r.message ? h('span', { style: styles.error }, r.message) : null),
          h('span', { style: styles.resultTag(r.status) }, t({
            created: 'davStatusCreated', overwritten: 'davStatusOverwritten', skipped: 'davStatusSkipped', error: 'davStatusError',
          }[r.status] ?? 'davStatusError'))))),
          h('div', { style: styles.actions },
            h(Button, { variant: 'outline', size: 'sm', onClick: onReload }, t('davRelist')),
            h(Button, { variant: 'primary', size: 'sm', onClick: onClose }, t('davDone'))))
      } else {
        const rows = listing.files.length === 0
          ? h('p', { style: styles.empty }, pull ? t('davEmptyRemote') : t('davEmptyLocal'))
          : h('ul', { style: { ...styles.list, maxHeight: 360, overflowY: 'auto' } }, listing.files.map((file, index) => h('li', {
            key: file.name,
            style: index === 0 ? { ...styles.item, ...styles.itemFirst } : styles.item,
          },
          h('label', { style: styles.checkRow, title: file.invalid ?? file.name },
            h('input', {
              type: 'checkbox',
              checked: selected.has(file.name),
              disabled: Boolean(file.invalid) || running || ask !== undefined,
              onChange: (event) => toggleOne(file.name, event.target.checked),
              style: styles.checkbox,
            }),
            h('div', { style: styles.itemText },
              h('span', { style: styles.itemName },
                file.name,
                file.conflict ? h('span', { style: styles.tag }, pull ? t('davConflictLocal') : t('davConflictRemote')) : null),
              h('span', { style: file.invalid ? styles.error : styles.muted }, file.invalid
                ?? [typeof file.size === 'number' ? formatSize(file.size) : '', formatTime(file.mtime)].filter(Boolean).join(' · ')))))))

        let question = null
        if (ask) {
          const name = ask.queue[ask.index]
          const remaining = ask.queue.length - ask.index
          question = h('div', { style: styles.banner('warn'), role: 'alertdialog' },
            h('div', { style: { ...styles.bannerText, display: 'flex', flexDirection: 'column', gap: 2 } },
              h('span', null, pull ? t('davAskPull', { name }) : t('davAskPush', { name })),
              ask.queue.length > 1 ? h('span', { style: styles.muted }, t('davAskProgress', { index: ask.index + 1, total: ask.queue.length })) : null),
            h(Button, { size: 'sm', variant: 'primary', onClick: () => answer(true, false) }, t('davOverwrite')),
            h(Button, { size: 'sm', variant: 'outline', onClick: () => answer(false, false) }, t('davSkip')),
            remaining > 1 ? h(Button, { size: 'sm', variant: 'outline', onClick: () => answer(true, true) }, t('davOverwriteAll')) : null,
            remaining > 1 ? h(Button, { size: 'sm', variant: 'outline', onClick: () => answer(false, true) }, t('davSkipAll')) : null,
            h(Button, { size: 'sm', variant: 'ghost', onClick: () => setAsk(undefined) }, t('davAbort')))
        }

        content = h('div', { style: styles.globalBody },
          !pull && listing.remoteMissing ? h('p', { style: styles.notice }, t('davRemoteMissing')) : null,
          h('div', { style: styles.listHead },
            h(Button, { variant: 'outline', size: 'sm', disabled: selectable.length === 0 || running || ask !== undefined, onClick: toggleAll },
              allSelected ? t('davUnselectAll') : t('davSelectAll')),
            h('span', { style: styles.muted }, t('davSelected', { count: chosen.length, total: selectable.length }))),
          rows,
          question,
          error ? h('p', { style: styles.error, role: 'alert' }, error) : null,
          h('div', { style: styles.actions },
            h(Button, { variant: 'outline', size: 'sm', disabled: running, onClick: onClose }, t('davCancel')),
            h(Button, {
              variant: 'primary',
              size: 'sm',
              disabled: chosen.length === 0 || running || ask !== undefined,
              onClick: start,
            }, running ? t('davRunning') : pull ? t('davRunPull', { count: chosen.length }) : t('davRunPush', { count: chosen.length }))))
      }

      return h('div', { style: styles.card },
        h('div', { style: { ...styles.globalRow, gap: 2 } },
          h('span', { style: { fontSize: 14, fontWeight: 600 } }, title),
          h('span', { style: styles.path, title: from }, t('davFrom', { from })),
          h('span', { style: styles.path, title: to }, t('davTo', { to }))),
        h('div', { style: { ...styles.globalRow, borderTop: border } }, content))
    }

    /** The “WebDAV 云同步” tab: connection settings, proxy, test, and both sync directions. */
    function WebdavView({ t, onTemplatesChanged }) {
      const [info, setInfo] = useState(undefined) // { directory, webdav }
      const [form, setForm] = useState(undefined)
      const [busy, setBusy] = useState(undefined) // 'load' | 'save' | 'test' | 'pull' | 'push'
      const [notice, setNotice] = useState(undefined) // { tone, text }
      const [test, setTest] = useState(undefined) // { ok, warning?, message }
      const [sync, setSync] = useState(undefined) // { mode, listing, key }
      const alive = useRef(true)
      useEffect(() => () => { alive.current = false }, [])

      const adopt = useCallback((value) => {
        setInfo({ directory: value.directory, webdav: value.webdav })
        setForm(formFrom(value.webdav))
      }, [])

      useEffect(() => {
        setBusy('load')
        call('webdav').then(
          (value) => { if (alive.current) adopt(value) },
          (cause) => { if (alive.current) setNotice({ tone: 'error', text: errorText(cause) }) },
        ).finally(() => { if (alive.current) setBusy(undefined) })
      }, [adopt])

      if (!info || !form) {
        return notice
          ? h('p', { style: styles.error, role: 'alert' }, notice.text)
          : h('p', { style: styles.empty }, t('loading'))
      }

      const webdav = info.webdav
      const dirty = formDirty(form, webdav)
      const update = (patch) => {
        setForm(prev => ({ ...prev, ...patch }))
        setTest(undefined)
      }
      const task = async (kind, job) => {
        setBusy(kind)
        setNotice(undefined)
        try {
          await job()
        } catch (cause) {
          if (alive.current) setNotice({ tone: 'error', text: errorText(cause) })
        } finally {
          if (alive.current) setBusy(undefined)
        }
      }
      const save = (extra) => task('save', async () => {
        const value = await call('webdav', { ...form, ...extra })
        if (!alive.current) return
        adopt(value)
        setNotice({ tone: 'info', text: t('davSavedAt', { time: new Date().toLocaleTimeString() }) })
      })
      const runTest = () => task('test', async () => {
        const result = await call('webdav/test', form)
        if (alive.current) setTest(result)
      })
      const openSync = (mode) => task(mode, async () => {
        const listing = await call(mode === 'pull' ? 'webdav/remote-list' : 'webdav/local-list', {})
        if (alive.current) setSync({ mode, listing, key: Date.now() })
      })

      const blocked = !webdav.url ? t('davNeedUrl') : dirty ? t('davNeedSave') : !info.directory ? t('davNeedDir') : undefined
      const locked = busy !== undefined

      const testBanner = test
        ? h('div', { style: styles.banner(test.ok ? (test.warning ? 'warn' : 'ok') : 'error'), role: test.ok ? 'status' : 'alert' },
          h('span', { style: styles.bannerText }, `${test.ok ? (test.warning ? '⚠ ' : '✓ ') : '✗ '}${test.message}`))
        : null

      return h('div', { style: styles.section },
        h('p', { style: styles.intro }, t('davIntro')),

        h('h3', { style: styles.groupTitle }, t('davServer')),
        h('div', { style: styles.card },
          h('div', { style: styles.formBody },
            h(Field, { label: t('davUrl'), hint: t('davUrlHint') },
              h(Input, {
                value: form.url,
                placeholder: t('davUrlPlaceholder'),
                spellCheck: false,
                autoComplete: 'off',
                onChange: (event) => update({ url: event.target.value }),
                style: { width: '100%' },
              })),
            h(Field, { label: t('davUser') },
              h(Input, {
                value: form.username,
                spellCheck: false,
                autoComplete: 'off',
                onChange: (event) => update({ username: event.target.value }),
                style: { width: '100%' },
              })),
            h(Field, { label: t('davPassword') },
              h('div', { style: styles.dirRow },
                h('div', { style: styles.dirInput },
                  h(Input, {
                    type: 'password',
                    value: form.password,
                    placeholder: webdav.hasPassword ? t('davPasswordSaved') : t('davPasswordPlaceholder'),
                    autoComplete: 'new-password',
                    onChange: (event) => update({ password: event.target.value }),
                    style: { width: '100%' },
                  })),
                webdav.hasPassword
                  ? h(Button, { variant: 'ghost', size: 'sm', disabled: locked, onClick: () => save({ password: '', clearPassword: true }) }, t('davClearPassword'))
                  : null)))),

        h('h3', { style: styles.groupTitle }, t('davProxy')),
        h('div', { style: styles.card },
          h('div', { style: styles.optionRow },
            h('div', { style: styles.itemText },
              h('span', { style: { fontSize: 14 } }, t('davProxyTitle')),
              h('span', { style: styles.muted }, t('davProxyDesc'))),
            h(Switch, {
              checked: form.proxyEnabled,
              label: t('davProxyTitle'),
              onChange: (next) => update({ proxyEnabled: next, proxyAddress: form.proxyAddress.trim() || webdav.defaultProxyAddress }),
            })),
          form.proxyEnabled
            ? h('div', { style: { ...styles.formBody, borderTop: border } },
              h(Field, { label: t('davProxyType') },
                h(Segmented, {
                  value: form.proxyType,
                  options: [{ value: 'http', label: 'HTTP' }, { value: 'socks5', label: 'SOCKS5' }],
                  onChange: (proxyType) => update({ proxyType }),
                })),
              h(Field, { label: t('davProxyAddress'), hint: t('davProxyAddressHint', { address: webdav.defaultProxyAddress }) },
                h(Input, {
                  value: form.proxyAddress,
                  placeholder: webdav.defaultProxyAddress,
                  spellCheck: false,
                  onChange: (event) => update({ proxyAddress: event.target.value }),
                  style: { width: '100%' },
                })))
            : null),

        h('div', { style: styles.actions },
          h('span', { style: styles.status(dirty) }, dirty ? t('davDirty') : t('davSaved')),
          h('span', { style: { flex: 1 } }),
          h(Button, { variant: 'outline', disabled: locked || form.url.trim() === '', onClick: runTest },
            busy === 'test' ? t('davTesting') : t('davTest')),
          h(Button, { variant: 'outline', disabled: locked || !dirty, onClick: () => { setForm(formFrom(webdav)); setTest(undefined) } }, t('davDiscard')),
          h(Button, { variant: 'primary', disabled: locked || !dirty, onClick: () => save() },
            busy === 'save' ? t('davSaving') : t('davSave'))),
        testBanner,
        notice ? h('div', { style: styles.banner(notice.tone), role: notice.tone === 'error' ? 'alert' : 'status' },
          h('span', { style: styles.bannerText }, notice.text)) : null,

        h('h3', { style: styles.groupTitle }, t('davSync')),
        sync
          ? h(SyncPanel, {
            key: sync.key,
            t,
            mode: sync.mode,
            listing: sync.listing,
            onClose: () => setSync(undefined),
            onReload: () => openSync(sync.mode),
            onSynced: () => { if (sync.mode === 'pull') onTemplatesChanged() },
          })
          : h('div', { style: styles.card },
            h('div', { style: styles.optionRow },
              h('div', { style: styles.itemText },
                h('span', { style: { fontSize: 14 } }, t('davPullTitle')),
                h('span', { style: styles.muted }, t('davPullDesc'))),
              h(Button, { variant: 'outline', disabled: locked || blocked !== undefined, title: blocked, onClick: () => openSync('pull') },
                busy === 'pull' ? t('davListing') : t('davPull'))),
            h('div', { style: { ...styles.optionRow, borderTop: border } },
              h('div', { style: styles.itemText },
                h('span', { style: { fontSize: 14 } }, t('davPushTitle')),
                h('span', { style: styles.muted }, t('davPushDesc'))),
              h(Button, { variant: 'outline', disabled: locked || blocked !== undefined, title: blocked, onClick: () => openSync('push') },
                busy === 'push' ? t('davListing') : t('davPush'))),
            blocked ? h('div', { style: { ...styles.globalRow, borderTop: border } }, h('span', { style: styles.muted }, blocked)) : null))
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
        const [tab, setTabState] = useState(() => lastTab) // 'prompts' | 'webdav'
        const setTab = (next) => {
          lastTab = next
          setTabState(next)
        }
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

        const header = [
          h('h2', { key: 'title', style: styles.heading }, t('title'), h('span', { style: { ...styles.muted, fontWeight: 400, marginLeft: 8 } }, `v${VERSION}`)),
          hostOutdated ? h('div', { key: 'outdated', style: styles.banner('error'), role: 'alert' }, h('span', { style: styles.bannerText }, t('hostOutdated'))) : null,
          h('div', { key: 'tabs', style: styles.tabs, role: 'tablist' },
            [['prompts', t('tabPrompts')], ['webdav', t('tabWebdav')]].map(([id, label]) => h('button', {
              key: id,
              type: 'button',
              role: 'tab',
              'aria-selected': tab === id,
              style: styles.tab(tab === id),
              onClick: () => setTab(id),
            }, label))),
        ]

        if (tab === 'webdav') {
          return h('div', { style: styles.section },
            ...header,
            h(WebdavView, {
              t,
              // Pulled files change the template list (and possibly the global prompt).
              onTemplatesChanged: () => run('refresh', async () => accept(await call('state'))),
            }))
        }

        return h('div', { style: styles.section },
          ...header,
          h('p', { style: styles.intro }, t('intro')),

          h('h3', { style: styles.groupTitle }, t('globalGroup')),
          state?.global ? h(GlobalSection, { t, state, accept }) : h('p', { style: styles.empty }, t('loading')),

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
            description: menuGlobal ? t('menuDescriptionGlobal', { name: menuGlobal }) : t('menuDescription'),
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
