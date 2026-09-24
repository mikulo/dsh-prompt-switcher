/**
 * dsh-prompt-switcher — Host half.
 *
 * - Settings store: `$DSH_HOME/dsh-prompt-switcher.json` holds the template
 *   directory and the per-file activation switches. It is independent of the
 *   Harness settings document, so it behaves the same on every 0.1.7 build.
 * - Template scan: only the top level of the directory, only `*.md` files.
 * - HTTP routes under `/api/dsh-prompt-switcher/*` (loopback-only) feed the
 *   Browser half: settings page state, folder dialog, activation switches and
 *   the list of active templates for the `/` menu.
 * - Slash command `/prompt-template <id> <message>`: the Browser half submits
 *   it when the user picks a template row. It is accepted only on the FIRST
 *   message of a brand-new conversation; it binds the template to the session
 *   and sends the message.
 * - Binding: the template text enters the session log as one sourced
 *   `user/message` wrapped in `<system-reminder>`, exactly the channel and
 *   authority AGENTS.md uses (dsh-agent-instructions). A session projection
 *   folds that message from the full log, so the binding survives resume and
 *   fork; a pre-step hook re-injects the same snapshot whenever compaction has
 *   dropped it from the model-visible history, so every later turn obeys it.
 *
 * Plain ESM, no dependencies: only `node:` built-ins and duck-typed Harness
 * services, so no install-time build or registry access is required.
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'dsh-prompt-switcher'

/** Package version, stamped by scripts/build.mjs. */
export const version = '__PLUGIN_VERSION__'

/** `webServer` serves the settings routes; `sessionProjections` restores bindings from the log. */
export const inject = ['webServer', 'sessionProjections']

/** Message source kind that marks the injected template (never a shared kind). */
export const SOURCE_KIND = 'prompt-switcher'
/** Session projection key (unique across the composition). */
const PROJECTION_KEY = 'promptSwitcher'
/** The one host command the Browser half submits. */
export const COMMAND_NAME = 'prompt-template'
/**
 * Route-protocol version shared with client.js. The browser half hot-reloads
 * on its own, while a changed Host half needs a `dsh web` restart; the client
 * compares this value to tell the user so instead of failing obscurely.
 */
export const HOST_PROTOCOL = 3
/** HTTP route family. */
const API = '/api/dsh-prompt-switcher'
/** Cap on one template file (1 MiB, the same per-file cap agent-instructions uses). */
const MAX_TEMPLATE_BYTES = 1024 * 1024
/** Cap on JSON request bodies. */
const MAX_BODY_BYTES = 64 * 1024

// ───────────────────────────────────────────────────────────── settings store

/** Absolute path of the settings file. */
function storePath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'dsh-prompt-switcher.json')
}

/** Read the settings file; a missing or malformed file reads as empty settings. */
async function readStore() {
  try {
    const raw = JSON.parse(await readFile(storePath(), 'utf8'))
    return {
      directory: typeof raw?.directory === 'string' ? raw.directory : '',
      active: raw?.active && typeof raw.active === 'object' && !Array.isArray(raw.active) ? { ...raw.active } : {},
      // Pin the templates above the built-in `/` commands (default on).
      pinTop: raw?.pinTop !== false,
    }
  } catch {
    return { directory: '', active: {}, pinTop: true }
  }
}

/** Serialize writes so two quick toggles cannot interleave. */
let writeChain = Promise.resolve()

/** Atomically persist the settings file (temp file + rename). */
function writeStore(store) {
  const run = async () => {
    const file = storePath()
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8')
    await rename(tmp, file)
  }
  const next = writeChain.then(run, run)
  writeChain = next.catch(() => {})
  return next
}

// ───────────────────────────────────────────────────────────── template scan

/** Stable template id derived from its file name (safe for the command line). */
function templateId(file) {
  return 't' + createHash('sha1').update(file, 'utf8').digest('hex').slice(0, 10)
}

/**
 * List the `.md` files directly inside `directory` (no recursion).
 * @returns {{ templates: Array<{id,name,file,size,mtime}>, error?: string }}
 */
async function scanDirectory(directory) {
  if (typeof directory !== 'string' || directory.trim() === '') return { templates: [] }
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    return { templates: [], error: `无法读取目录：${error?.code ?? ''} ${error?.message ?? error}`.trim() }
  }
  const templates = []
  for (const entry of entries) {
    if (extname(entry.name).toLowerCase() !== '.md') continue
    const full = join(directory, entry.name)
    let info
    try {
      // Follow symlinks so a linked file counts, but never descend into a directory.
      info = await stat(full)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    templates.push({
      id: templateId(entry.name),
      name: basename(entry.name, extname(entry.name)),
      file: entry.name,
      size: info.size,
      mtime: info.mtimeMs,
    })
  }
  templates.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
  return { templates }
}

/** Settings page state: directory, every template with its switch, and any scan error. */
async function describeState() {
  const store = await readStore()
  const scan = await scanDirectory(store.directory)
  return {
    hostProtocol: HOST_PROTOCOL,
    directory: store.directory,
    pinTop: store.pinTop,
    error: scan.error,
    templates: scan.templates.map(t => ({ ...t, active: store.active[t.file] === true })),
  }
}

/**
 * Resolve a client-supplied file name to a template currently listed in the
 * configured directory. Only names the scan itself produced are accepted, so
 * no client value can reach a path outside the directory.
 */
async function resolveListedFile(file) {
  if (typeof file !== 'string' || file === '') throw new Error('缺少模板文件名。')
  const store = await readStore()
  const { templates, error } = await scanDirectory(store.directory)
  if (error) throw new Error(error)
  const found = templates.find(t => t.file === file)
  if (!found) throw new Error(`模板文件不存在或已被移除：${file}`)
  return { ...found, path: join(store.directory, found.file) }
}

/** Read one template file for the editor, remembering its BOM and line endings. */
async function readTemplateFile(file) {
  const found = await resolveListedFile(file)
  if (found.size > MAX_TEMPLATE_BYTES) throw new Error(`文件超过 1 MiB，请使用外部编辑器编辑：${file}`)
  const raw = await readFile(found.path, 'utf8')
  const info = await stat(found.path)
  const bom = raw.startsWith('\uFEFF')
  const text = bom ? raw.slice(1) : raw
  const crlf = /\r\n/.test(text)
  return {
    file: found.file,
    name: found.name,
    path: found.path,
    content: text.replace(/\r\n/g, '\n'),
    mtime: info.mtimeMs,
    size: info.size,
    eol: crlf ? 'crlf' : 'lf',
    bom,
  }
}

/** Save editor content, refusing when the file changed since `baseMtime` unless `force`. */
async function writeTemplateFile(file, content, baseMtime, force) {
  if (typeof content !== 'string') throw new Error('缺少文件内容。')
  const found = await resolveListedFile(file)
  const current = await stat(found.path)
  if (!force && typeof baseMtime === 'number' && Math.abs(current.mtimeMs - baseMtime) > 1) {
    const conflict = new Error('文件在打开后已被其他程序修改。')
    conflict.status = 409
    conflict.mtime = current.mtimeMs
    throw conflict
  }
  // Keep the file's own conventions: BOM and CRLF survive a browser round trip.
  const existing = await readFile(found.path, 'utf8')
  const bom = existing.startsWith('\uFEFF')
  const crlf = /\r\n/.test(existing)
  let text = content.replace(/\r\n/g, '\n')
  if (crlf) text = text.replace(/\n/g, '\r\n')
  if (Buffer.byteLength(text, 'utf8') > MAX_TEMPLATE_BYTES) throw new Error('内容超过 1 MiB，未保存。')
  // In-place write keeps symlinks, hard links and ACLs of the user's file intact.
  await writeFile(found.path, (bom ? '\uFEFF' : '') + text, 'utf8')
  const info = await stat(found.path)
  return { file: found.file, mtime: info.mtimeMs, size: info.size }
}

/** Active templates only (what the `/` menu offers). */
async function activeTemplates() {
  const state = await describeState()
  return state.templates.filter(t => t.active)
}

/**
 * Resolve an active template by id, name, or file name, and read its text.
 * @returns the template with `content`, or an error string.
 */
async function loadActiveTemplate(key) {
  const store = await readStore()
  const { templates, error } = await scanDirectory(store.directory)
  if (error) return { error }
  const found = templates.find(t => t.id === key || t.name === key || t.file === key)
  if (!found) return { error: `找不到提示词模板“${key}”，请在 设置 → 提示词模板 中刷新。` }
  if (store.active[found.file] !== true) return { error: `提示词模板“${found.name}”未激活。` }
  if (found.size > MAX_TEMPLATE_BYTES) return { error: `提示词模板“${found.name}”超过 1 MiB，已拒绝加载。` }
  const content = (await readFile(join(store.directory, found.file), 'utf8')).replace(/^\uFEFF/, '')
  if (content.trim() === '') return { error: `提示词模板“${found.name}”内容为空。` }
  return { template: { ...found, content } }
}

// ───────────────────────────────────────────────────────────── model message

/** Keep template text from closing the plugin-owned frame (same rule as agent-instructions). */
function escapeFrame(text) {
  return text.replace(/<\/system-reminder>/gi, '<\\/system-reminder>')
}

/** Model-visible text of a bound template: AGENTS.md framing and authority. */
function renderTemplate(name, file, content) {
  return [
    '<system-reminder>',
    `The user started this conversation with the prompt template "${escapeFrame(name)}". ` +
      'Treat it exactly like workspace instructions from AGENTS.md: it applies to this entire conversation, ' +
      'including every later turn, until the conversation ends. It does not override system, developer, or direct user instructions.',
    '',
    `Instructions from prompt template: ${escapeFrame(file)}`,
    '',
    escapeFrame(content.trim()),
    '</system-reminder>',
  ].join('\n')
}

/** Deep-freeze plain data (the shape `createUserMessage` produces). */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

/** Build one user message exactly like `@deepseek-ai/dsh-llm` `createUserMessage`. */
function userMessage(content, source) {
  return deepFreeze(structuredClone({ content, source, role: 'user', id: randomUUID() }))
}

/** The sourced template message; the text is the durable snapshot. */
function templateMessage(binding) {
  return userMessage([{ type: 'text', text: binding.text }], {
    kind: SOURCE_KIND,
    form: 'instructions',
    template: binding.name,
    file: binding.file,
    digest: binding.digest,
  })
}

/** Whether a message is this plugin's template message. */
function isTemplateMessage(message) {
  return message?.role === 'user' && message?.source?.kind === SOURCE_KIND
}

/** Plain text of a message's text blocks. */
function messageText(message) {
  return (message?.content ?? []).map(block => (block?.type === 'text' ? block.text : '')).join('')
}

// ───────────────────────────────────────────────────────────── HTTP helpers

/** Loopback socket + loopback Host header + same-origin browser markers. */
function isLoopbackRequest(req) {
  const address = (req.socket?.remoteAddress ?? '').toLowerCase()
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address
  const loopback = address === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)
  if (!loopback) return false
  let host
  try {
    host = new URL('http://' + (req.headers.host ?? ''))
  } catch {
    return false
  }
  if (!(host.hostname === 'localhost' || host.hostname === '[::1]' || /^127\./.test(host.hostname))) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host.host
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const value = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象')
  return value
}

/**
 * One exact route with a loopback fence, method dispatch and uniform error
 * handling. The web server keys routes by path, so every method of one path
 * shares this single registration.
 * @param path - path under the API prefix.
 * @param methods - `'GET'`/`'POST'` with `handle`, or a `{ GET, POST }` handler map.
 */
function route(path, methods, handle) {
  const table = typeof methods === 'string' ? { [methods]: handle } : methods
  return {
    kind: 'exact',
    path: `${API}/${path}`,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
      const method = req.method ?? 'GET'
      const handle = table[method]
      if (!handle) return writeJson(res, 405, { error: `method not allowed: ${method}` })
      try {
        const body = method === 'POST' ? await readJsonBody(req) : undefined
        writeJson(res, 200, await handle(body, req))
      } catch (error) {
        const status = typeof error?.status === 'number' ? error.status : 400
        writeJson(res, status, {
          error: error instanceof Error ? error.message : String(error),
          ...(typeof error?.mtime === 'number' ? { mtime: error.mtime } : {}),
        })
      }
    },
  }
}

// ───────────────────────────────────────────────────────────── folder dialog

/**
 * Last-resort OS folder dialog when the Harness picker service is absent or in
 * browse mode but this host still has a desktop (e.g. the plain loopback web
 * profile without the -auto picker). Windows only; other platforms report
 * `unsupported` and the page keeps its manual path input.
 */
function windowsFolderDialog(initial) {
  if (process.platform !== 'win32') return Promise.resolve({ unsupported: true })
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$d.Description = "选择提示词模板目录"',
    '$d.ShowNewFolderButton = $false',
    `$p = [Environment]::GetEnvironmentVariable('DSH_PS_INITIAL')`,
    'if ($p -and (Test-Path -LiteralPath $p)) { $d.SelectedPath = $p }',
    '$f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false}',
    'if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write($d.SelectedPath) }',
  ].join('; ')
  return new Promise(resolvePick => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, DSH_PS_INITIAL: initial ?? '' },
    })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk.toString('utf8') })
    child.on('error', () => resolvePick({ unsupported: true }))
    child.on('close', () => {
      const picked = out.trim()
      resolvePick(picked === '' ? { path: null } : { path: picked })
    })
  })
}

// ───────────────────────────────────────────────────────────── open with…

/**
 * Show the operating system's own "open with" chooser for one template file,
 * so the user picks any installed editor themselves (the plugin keeps no
 * editor list). The path is passed as data, never through a shell string.
 * - Windows: the shell "How do you want to open this file?" dialog.
 * - macOS: the system "Choose Application" dialog, then `open -a`.
 * - Other platforms have no standard chooser: the desktop's default handler.
 */
function openWithSpec(path) {
  if (process.platform === 'win32') {
    // OpenAs_RunDLL takes the raw remainder of the command line as the path.
    return { command: 'rundll32.exe', args: [`shell32.dll,OpenAs_RunDLL ${path}`], options: { windowsVerbatimArguments: true } }
  }
  if (process.platform === 'darwin') {
    const script = [
      'on run argv',
      'set appPath to POSIX path of (choose application with prompt "选择用于编辑提示词模板的程序" as alias)',
      'do shell script "open -a " & quoted form of appPath & " " & quoted form of (item 1 of argv)',
      'end run',
    ]
    return { command: 'osascript', args: [...script.flatMap(line => ['-e', line]), path] }
  }
  return { command: 'xdg-open', args: [path] }
}

/** Launch the chooser detached; resolves once it survived its first moment or rejects on spawn failure. */
function launchOpenWith(path) {
  const spec = openWithSpec(path)
  return new Promise((resolveLaunch, rejectLaunch) => {
    let settled = false
    const child = spawn(spec.command, spec.args, { detached: true, stdio: 'ignore', ...(spec.options ?? {}) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      rejectLaunch(new Error(`无法打开“打开方式”对话框：${error.message}`))
    })
    child.unref()
    setTimeout(() => {
      if (settled) return
      settled = true
      resolveLaunch()
    }, 500)
  })
}

// ───────────────────────────────────────────────────────────── plugin

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('prompt-switcher') : ctx.logger

  /** Bindings made in this process whose message is not yet in the log. */
  const pendingBindings = new WeakMap()

  // ── durable binding: fold the first template message from the full log.
  const projectionAvailable = (() => {
    try {
      ctx.sessionProjections.register({
        key: PROJECTION_KEY,
        stateVersion: 1,
        // Plain JSON state; the registry only calls `parse` on persisted rows.
        stateSchema: {
          parse(value) {
            if (value && typeof value === 'object' && 'bound' in value) return value
            throw new Error('invalid prompt-switcher projection state')
          },
        },
        init: () => ({ bound: null }),
        apply(state, event) {
          if (state.bound !== null || event?.type !== 'user/message') return state
          const message = event.data
          if (!isTemplateMessage(message)) return state
          return {
            bound: {
              name: String(message.source.template ?? ''),
              file: String(message.source.file ?? ''),
              digest: String(message.source.digest ?? ''),
              text: messageText(message),
            },
          }
        },
      })
      return true
    } catch (error) {
      logger?.warn?.('session projection unavailable, bindings fall back to visible history: %o', error)
      return false
    }
  })()

  /** The template bound to a session, if any (log fold, then in-flight, then visible history). */
  const bindingOf = (session) => {
    if (projectionAvailable) {
      try {
        const bound = ctx.sessionProjections.stateOf(session, PROJECTION_KEY)?.bound
        if (bound) return bound
      } catch { /* session not projected yet */ }
    }
    const pending = pendingBindings.get(session)
    if (pending) return pending
    try {
      const visible = session.deriveMessages().find(isTemplateMessage)
      if (visible) {
        return { name: visible.source.template, file: visible.source.file, digest: visible.source.digest, text: messageText(visible) }
      }
    } catch { /* no history access */ }
    return undefined
  }

  /** Whether the agent's session has never had a conversation turn. */
  const isFreshSession = (agent) => {
    const session = agent.session
    if (session.header?.isSeeded) return false
    if ((session.header?.delegationDepth ?? 0) > 0 || session.header?.origin === 'subagent') return false
    if (bindingOf(session)) return false
    try {
      const turns = ctx.sessionProjections.stateOf(session, 'turnBoundary')
      if (turns && ((turns.lastTurn ?? 0) > 0 || turns.openTurnStartSeq != null)) return false
    } catch { /* projection absent: rely on history below */ }
    const messages = session.deriveMessages()
    if (messages.some(m => m.role === 'assistant' || (m.role === 'user' && m.source?.kind === 'user'))) return false
    const inbox = agent.inbox
    if (inbox && (inbox.nextTurn.length > 0 || inbox.nextStep.some(m => m.source?.kind === 'user'))) return false
    return true
  }

  // ── keep the template in the model-visible history for every later step.
  ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
    const binding = bindingOf(agent.session)
    if (!binding) return decision
    if (decision.messages.some(isTemplateMessage)) {
      pendingBindings.delete(agent.session)
      return decision
    }
    let visible = false
    try {
      visible = agent.session.deriveMessages().some(isTemplateMessage)
    } catch { /* treat as missing */ }
    if (visible) return decision
    // Compaction (or an interrupted first step) dropped it: re-inject the same snapshot first.
    return { ...decision, messages: [templateMessage(binding), ...decision.messages] }
  })

  // ── the slash command the Browser half submits.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: COMMAND_NAME,
      description: '使用提示词模板开始新对话（从 / 菜单直接选择模板名；仅新对话的第一条消息有效）',
      input: { hint: '<模板> <第一条消息>', attachments: true },
      handler: async ({ agent, rawInput, attachments = [] }) => {
        const text = rawInput.replace(/^\s+/, '')
        const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text)
        if (!match) return { kind: 'error', text: '请选择一个提示词模板。' }
        const key = match[1]
        const message = (match[2] ?? '').trim()

        if (!isFreshSession(agent)) {
          return {
            kind: 'error',
            text: '提示词模板只能在新对话的第一条消息中使用；当前对话已开始，本次模板未生效，消息也未发送。请新建对话后再选择模板，或删去模板前缀直接发送。',
          }
        }
        if (message === '' && attachments.length === 0) {
          return { kind: 'error', text: '请在模板后输入第一条消息再发送。' }
        }
        const loaded = await loadActiveTemplate(key)
        if (loaded.error) return { kind: 'error', text: loaded.error }
        const { template } = loaded

        const binding = {
          name: template.name,
          file: template.file,
          digest: createHash('sha1').update(template.content, 'utf8').digest('hex'),
          text: renderTemplate(template.name, template.file, template.content),
        }
        pendingBindings.set(agent.session, binding)
        // Same order as /plan: model-facing context first, then the user's own message wakes the turn.
        agent.inject(templateMessage(binding))
        agent.steer(userMessage(
          [...attachments, ...(message === '' ? [] : [{ type: 'text', text: message }])],
          { kind: 'user' },
        ))
        return { kind: 'success', text: `已应用提示词模板「${template.name}」，本对话后续所有轮次都将遵守该模板。` }
      },
    })
  })

  // ── settings + menu routes.
  const routes = [
    route('state', 'GET', () => describeState()),
    route('templates', 'GET', async () => {
      const state = await describeState()
      return {
        hostProtocol: HOST_PROTOCOL,
        pinTop: state.pinTop,
        templates: state.templates.filter(t => t.active).map(({ id, name, file }) => ({ id, name, file })),
      }
    }),
    route('settings', 'POST', async (body) => {
      const store = await readStore()
      if (typeof body.pinTop === 'boolean') store.pinTop = body.pinTop
      await writeStore(store)
      return describeState()
    }),
    // Editor: full text (GET ?file=) or only its version (GET ?file=&meta=1) for change polling.
    route('file', {
      GET: async (_body, req) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const file = url.searchParams.get('file') ?? ''
        if (url.searchParams.get('meta') === '1') {
          const found = await resolveListedFile(file)
          const info = await stat(found.path)
          return { file: found.file, mtime: info.mtimeMs, size: info.size }
        }
        return readTemplateFile(file)
      },
      POST: (body) => writeTemplateFile(body.file, body.content, body.baseMtime, body.force === true),
    }),
    // System "open with" chooser for one listed template; the user picks the editor.
    route('open-external', 'POST', async (body) => {
      const found = await resolveListedFile(body.file)
      await launchOpenWith(found.path)
      return { ok: true, platform: process.platform }
    }),
    route('refresh', 'POST', () => describeState()),
    route('directory', 'POST', async (body) => {
      const raw = typeof body.directory === 'string' ? body.directory.trim() : ''
      if (raw === '') {
        const store = await readStore()
        await writeStore({ ...store, directory: '' })
        return describeState()
      }
      if (!isAbsolute(raw)) throw new Error('请填写绝对路径。')
      const directory = resolve(raw)
      let info
      try {
        info = await stat(directory)
      } catch {
        throw new Error(`目录不存在：${directory}`)
      }
      if (!info.isDirectory()) throw new Error(`不是目录：${directory}`)
      const store = await readStore()
      // A different directory starts with every template off; the same one keeps its switches.
      await writeStore({ ...store, directory, active: store.directory === directory ? store.active : {} })
      return describeState()
    }),
    route('active', 'POST', async (body) => {
      if (typeof body.file !== 'string' || body.file === '') throw new Error('缺少模板文件名。')
      const store = await readStore()
      const active = { ...store.active }
      if (body.active === true) active[body.file] = true
      else delete active[body.file]
      await writeStore({ ...store, active })
      return describeState()
    }),
    route('pick', 'POST', async (_body, req) => {
      const store = await readStore()
      const picker = ctx.get?.('directoryPicker')
      let capability
      try {
        capability = picker?.capability?.()
      } catch { /* picker without a backend */ }
      if (capability?.kind === 'native') {
        const controller = new AbortController()
        req.on('close', () => { if (!req.complete) controller.abort() })
        const path = await capability.pick(controller.signal)
        return { path: path ?? null }
      }
      return windowsFolderDialog(store.directory)
    }),
  ]
  ctx.effect(() => {
    const disposers = routes.map(r => ctx.webServer.register(r))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-prompt-switcher: routes')
}
