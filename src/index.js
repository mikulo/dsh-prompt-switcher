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
 * - Global prompt: one `.md` file (named after the file) or a custom text
 *   (named by the user). While enabled, the pre-step hook binds a snapshot of
 *   it to every brand-new top-level conversation through the same channel
 *   (source kind `prompt-switcher-global`). A template picked with `/` is
 *   appended AFTER the global prompt; it never replaces it.
 * - Environment variables: `{{env:NAME}}` in a template or the global prompt
 *   is replaced with the value from `$DSH_HOME/dsh-prompt-switcher.env.json`
 *   (an undefined name is removed) when the snapshot is bound. The file can be
 *   synced through WebDAV (push / pull / merge with per-name choices).
 * - Delete conversation (opt-in, `allowDeleteSession`): DSH has no delete
 *   API, so `POST /session-delete` stops the session's work through the
 *   official archive path, unloads its live Agent, removes its session
 *   directory (and those of its subagent sessions) from session persistence,
 *   drops its projection-cache row, and emits `api-session/removed` so every
 *   browser drops the row.
 *
 * Plain ESM, no dependencies: only `node:` built-ins and duck-typed Harness
 * services, so no install-time build or registry access is required.
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { connect as netConnect, isIP, isIPv4, isIPv6 } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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
/** Message source kind that marks the injected global prompt. */
export const GLOBAL_SOURCE_KIND = 'prompt-switcher-global'
/** Session projection key (unique across the composition). */
const PROJECTION_KEY = 'promptSwitcher'
/** The one host command the Browser half submits. */
export const COMMAND_NAME = 'prompt-template'
/**
 * Route-protocol version shared with client.js. The browser half hot-reloads
 * on its own, while a changed Host half needs a `dsh web` restart; the client
 * compares this value to tell the user so instead of failing obscurely.
 */
export const HOST_PROTOCOL = 8
/** HTTP route family. */
const API = '/api/dsh-prompt-switcher'
/** Cap on one template file (1 MiB, the same per-file cap agent-instructions uses). */
const MAX_TEMPLATE_BYTES = 1024 * 1024
/** Cap on JSON request bodies (large enough for a full-size custom global prompt). */
const MAX_BODY_BYTES = 4 * 1024 * 1024
/** Cap on the user-chosen name of a custom global prompt. */
const MAX_GLOBAL_NAME = 80

// ───────────────────────────────────────────────────────────── settings store

/**
 * `$DSH_HOME`, defaulting to `~/.dsh` — the same rule as dsh-home-paths
 * `resolveDshHome` (blank means unset, a leading `~` is expanded).
 */
function dshHome() {
  const raw = process.env.DSH_HOME
  if (!raw || raw.trim() === '') return join(homedir(), '.dsh')
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return resolve(join(homedir(), raw.slice(2)))
  return resolve(raw)
}

/** Absolute path of the settings file. */
function storePath() {
  return join(dshHome(), 'dsh-prompt-switcher.json')
}

/**
 * Normalize the global-prompt settings.
 * - `source: 'file'` uses the `.md` file at `filePath` (chosen from the template
 *   list; its name is the file name without extension);
 * - `source: 'custom'` uses the text the user typed under the name they chose;
 *   saving it writes `<template directory>/<name>.md` (`customFile`). Settings
 *   written by 1.2.0 kept the text inline (`customContent`); it is still read
 *   until the prompt is saved again.
 */
function normalizeGlobal(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    enabled: value.enabled === true,
    source: value.source === 'custom' ? 'custom' : 'file',
    filePath: typeof value.filePath === 'string' ? value.filePath : '',
    customName: typeof value.customName === 'string' ? value.customName : '',
    customFile: typeof value.customFile === 'string' ? value.customFile : '',
    customContent: typeof value.customContent === 'string' ? value.customContent : '',
  }
}

/** Default proxy address once the user turns the WebDAV proxy on. */
const DEFAULT_PROXY_ADDRESS = '127.0.0.1:7891'

/** Normalize the WebDAV sync settings (proxy off by default). */
function normalizeWebdav(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const text = (key) => (typeof value[key] === 'string' ? value[key] : '')
  return {
    url: text('url').trim(),
    username: text('username'),
    password: text('password'),
    proxyEnabled: value.proxyEnabled === true,
    proxyType: value.proxyType === 'socks5' ? 'socks5' : 'http',
    proxyAddress: text('proxyAddress').trim() || DEFAULT_PROXY_ADDRESS,
    // Also sync the environment-variable file (off by default).
    syncEnv: value.syncEnv === true,
  }
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
      global: normalizeGlobal(raw?.global),
      webdav: normalizeWebdav(raw?.webdav),
      // Offer "删除对话" in the sidebar session menu (default off).
      allowDeleteSession: raw?.allowDeleteSession === true,
    }
  } catch {
    return {
      directory: '',
      active: {},
      pinTop: true,
      global: normalizeGlobal(undefined),
      webdav: normalizeWebdav(undefined),
      allowDeleteSession: false,
    }
  }
}

/** Serialize writes so two quick toggles cannot interleave. */
let writeChain = Promise.resolve()

/** Atomically write a text file (temp file + rename), serialized with every other plugin write. */
function atomicWrite(file, text) {
  const run = async () => {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, file)
  }
  const next = writeChain.then(run, run)
  writeChain = next.catch(() => {})
  return next
}

/** Atomically persist the settings file. */
function writeStore(store) {
  return atomicWrite(storePath(), JSON.stringify(store, null, 2) + '\n')
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
    global: await describeGlobal(store),
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

// ───────────────────────────────────────────────────────────── global prompt

/** Display name of a global prompt: the `.md` file name, or the user's own name. */
function globalName(global) {
  if (global.source === 'custom') return global.customName.trim()
  return global.filePath ? basename(global.filePath, extname(global.filePath)) : ''
}

/**
 * Why `name` cannot be a file name (on any platform), or `undefined` when it can.
 * @param name - a bare name (custom prompt title) or a file name with extension.
 */
function invalidFileName(name) {
  if (typeof name !== 'string' || name.trim() === '') return '名称不能为空。'
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) return '名称不能包含以下字符：< > : " / \\ | ? *'
  if (/^[. ]|[. ]$/.test(name)) return '名称不能以点或空格开头或结尾。'
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) return `“${name}”是系统保留名，请换一个名称。`
  if (Buffer.byteLength(name, 'utf8') > 240) return '名称过长。'
  return undefined
}

/** Same file on this platform (Windows and macOS file systems ignore case). */
function samePath(a, b) {
  if (!a || !b) return false
  const x = resolve(a)
  const y = resolve(b)
  return process.platform === 'linux' ? x === y : x.toLowerCase() === y.toLowerCase()
}

/** Read one prompt file (BOM stripped), or a readable reason it cannot be used. */
async function readPromptFile(path, label) {
  let info
  try {
    info = await stat(path)
  } catch {
    return { error: `${label}文件不存在：${path}` }
  }
  if (!info.isFile()) return { error: `${label}不是文件：${path}` }
  if (info.size > MAX_TEMPLATE_BYTES) return { error: `${label}文件超过 1 MiB：${path}` }
  const content = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '')
  return { content }
}

/**
 * Read the configured global prompt's text.
 * @returns `{ name, file, content }` or `{ error }` (a readable reason).
 */
async function readGlobalContent(global) {
  if (global.source === 'custom') {
    const name = global.customName.trim()
    if (name === '') return { error: '请为自定义全局提示词填写名称并保存。' }
    if (global.customFile) {
      const read = await readPromptFile(global.customFile, '自定义全局提示词')
      if (read.error) return read
      if (read.content.trim() === '') return { error: '自定义全局提示词内容为空。' }
      return { name, file: basename(global.customFile), content: read.content }
    }
    // Inline text saved by 1.2.0.
    if (global.customContent.trim() === '') return { error: '自定义全局提示词内容为空。' }
    return { name, file: '', content: global.customContent }
  }
  if (global.filePath === '') return { error: '请选择一个 .md 文件作为全局提示词。' }
  const read = await readPromptFile(global.filePath, '全局提示词')
  if (read.error) return read
  if (read.content.trim() === '') return { error: `全局提示词文件内容为空：${global.filePath}` }
  return { name: globalName(global), file: basename(global.filePath), content: read.content }
}

/** Current text of the custom global prompt for the editor (its file, else the legacy inline text). */
async function customGlobalText(global) {
  if (!global.customFile) return global.customContent
  const read = await readPromptFile(global.customFile, '')
  return read.error ? '' : read.content.replace(/\r\n/g, '\n')
}

/**
 * Save the custom global prompt as `<directory>/<name>.md`.
 * An existing file of that name that is not already this prompt's file is
 * only replaced with `overwrite` (otherwise a 409 the client turns into a
 * confirmation). Renaming writes a new file and leaves the old one in place.
 * @returns the updated global settings.
 */
async function saveCustomGlobal(store, global, name, content, overwrite) {
  if (!store.directory) throw new Error('请先在“提示词设置”中配置模板目录：自定义全局提示词会保存为该目录下的“名称.md”文件。')
  const problem = invalidFileName(name)
  if (problem) throw new Error(problem)
  if ([...name].length > MAX_GLOBAL_NAME) throw new Error(`名称不能超过 ${MAX_GLOBAL_NAME} 个字符。`)
  let text = content.replace(/\r\n/g, '\n')
  if (text.trim() === '') throw new Error('全局提示词内容不能为空。')
  const file = `${name}.md`
  const target = join(store.directory, file)
  let existing
  try {
    existing = await stat(target)
  } catch { /* new file */ }
  if (existing && !existing.isFile()) throw new Error(`模板目录中已有同名的文件夹：${file}`)
  if (existing && !overwrite && !samePath(target, global.customFile)) {
    const conflict = new Error(`模板目录中已存在同名文件“${file}”。`)
    conflict.status = 409
    conflict.payload = { conflict: 'file-exists', file }
    throw conflict
  }
  // Keep an existing file's BOM and CRLF conventions.
  let bom = false
  if (existing) {
    const raw = await readFile(target, 'utf8')
    bom = raw.startsWith('\uFEFF')
    if (/\r\n/.test(raw)) text = text.replace(/\n/g, '\r\n')
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_TEMPLATE_BYTES) throw new Error('内容超过 1 MiB，未保存。')
  await writeFile(target, (bom ? '\uFEFF' : '') + text, 'utf8')
  return { ...global, customName: name, customFile: target, customContent: '' }
}

/** Settings-page view of the global prompt (with the reason it cannot apply, if any). */
async function describeGlobal(store) {
  const global = store.global
  const file = global.filePath ? basename(global.filePath) : ''
  let error
  if (global.enabled) {
    const read = await readGlobalContent(global)
    error = read.error
  }
  return {
    enabled: global.enabled,
    source: global.source,
    filePath: global.filePath,
    file,
    // Whether the chosen file lives in the current template directory (the list offers it).
    inDirectory: global.filePath !== '' && store.directory !== '' && samePath(dirname(global.filePath), store.directory),
    customName: global.customName,
    customFile: global.customFile,
    customContent: await customGlobalText(global),
    name: globalName(global),
    // In effect for new conversations right now.
    effective: global.enabled && error === undefined,
    error,
  }
}

/**
 * The global prompt a new conversation should bind right now.
 * @returns `undefined` when disabled, `{ binding }` when usable, `{ error }` otherwise.
 */
async function loadGlobalPrompt() {
  const store = await readStore()
  if (!store.global.enabled) return undefined
  const read = await readGlobalContent(store.global)
  if (read.error) return { error: read.error }
  // `{{env:NAME}}` placeholders are resolved into the snapshot the conversation binds.
  const { map } = await loadEnvMap()
  return {
    binding: {
      name: read.name,
      file: read.file,
      origin: store.global.source,
      digest: createHash('sha1').update(read.content, 'utf8').digest('hex'),
      text: renderGlobal(read.name, read.file, applyEnv(read.content, map)),
    },
  }
}

// ───────────────────────────────────────────────────────────── environment variables

/**
 * Environment variables: named strings that prompt templates and the global
 * prompt reference as `{{env:NAME}}`. They live in one JSON text file,
 * `$DSH_HOME/dsh-prompt-switcher.env.json`, shaped
 *   { "version": 1, "variables": [ { "name": "github_api", "value": "123456" } ] }
 * (the array keeps the user's order; a plain `{ "name": "value" }` object is
 * also accepted when the file is edited by hand). The same file name is used
 * at the root of the WebDAV directory.
 */
export const ENV_FILE_NAME = 'dsh-prompt-switcher.env.json'
/** Valid variable name: a letter (any script) or `_`, then letters, digits, `_`, `.`, `-`. */
const ENV_NAME_RE = /^[\p{L}_][\p{L}\p{N}_.-]*$/u
/** `{{env:NAME}}`, spaces allowed inside the braces. */
export const ENV_PLACEHOLDER_RE = /\{\{\s*env\s*:\s*([\p{L}_][\p{L}\p{N}_.-]*)\s*\}\}/gu
const MAX_ENV_NAME = 64
const MAX_ENV_VARS = 1000
/** Cap on the whole variable file (local and remote). */
const MAX_ENV_BYTES = 1024 * 1024

function envPath() {
  return join(dshHome(), ENV_FILE_NAME)
}

/** Why `name` cannot be a variable name, or `undefined`. */
function invalidEnvName(name) {
  if (typeof name !== 'string' || name === '') return '变量名不能为空。'
  if ([...name].length > MAX_ENV_NAME) return `变量名不能超过 ${MAX_ENV_NAME} 个字符：${name}`
  if (!ENV_NAME_RE.test(name)) return `变量名“${name}”无效：只能包含字母、汉字、数字、下划线、点和短横线，并以字母、汉字或下划线开头。`
  return undefined
}

/**
 * Validate a list the user saves: `[{ name, value }]`, names trimmed, unique.
 * Rows with both fields empty are dropped.
 */
function normalizeEnvList(list) {
  if (!Array.isArray(list)) throw new Error('环境变量列表格式不正确。')
  const out = []
  const seen = new Set()
  for (const item of list) {
    const name = typeof item?.name === 'string' ? item.name.trim() : ''
    const value = typeof item?.value === 'string' ? item.value : ''
    if (name === '' && value === '') continue
    const problem = invalidEnvName(name)
    if (problem) throw new Error(problem)
    if (seen.has(name)) throw new Error(`变量名重复：${name}`)
    seen.add(name)
    out.push({ name, value })
  }
  if (out.length > MAX_ENV_VARS) throw new Error(`环境变量不能超过 ${MAX_ENV_VARS} 个。`)
  return out
}

/**
 * Parse the variable file text (lenient: invalid entries are skipped, a
 * repeated name keeps its first position and its last value).
 */
function parseEnvText(text) {
  let raw
  try {
    raw = JSON.parse(String(text).replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`环境变量文件不是有效的 JSON：${error.message}`)
  }
  let entries
  if (Array.isArray(raw?.variables)) entries = raw.variables.map(v => [v?.name, v?.value])
  else if (raw?.variables && typeof raw.variables === 'object') entries = Object.entries(raw.variables)
  else if (raw && typeof raw === 'object' && !Array.isArray(raw) && !('variables' in raw) && !('version' in raw)) entries = Object.entries(raw)
  else throw new Error('环境变量文件格式不正确：缺少 variables 列表。')
  const map = new Map()
  for (const [name, value] of entries) {
    if (typeof name !== 'string' || invalidEnvName(name.trim())) continue
    map.set(name.trim(), typeof value === 'string' ? value : value == null ? '' : String(value))
  }
  return [...map].map(([name, value]) => ({ name, value }))
}

/** File text for a variable list. */
function serializeEnv(variables) {
  return JSON.stringify({ version: 1, variables: variables.map(({ name, value }) => ({ name, value })) }, null, 2) + '\n'
}

/**
 * Read the local variable file.
 * @returns `{ path, exists, variables, mtime, error? }` (a missing file is an empty list).
 */
async function readEnvFile() {
  const path = envPath()
  let info
  try {
    info = await stat(path)
  } catch {
    return { path, exists: false, variables: [], mtime: null }
  }
  if (!info.isFile()) return { path, exists: false, variables: [], mtime: null, error: `不是文件：${path}` }
  if (info.size > MAX_ENV_BYTES) return { path, exists: true, variables: [], mtime: info.mtimeMs, error: '环境变量文件超过 1 MiB。' }
  try {
    const variables = parseEnvText(await readFile(path, 'utf8'))
    return { path, exists: true, variables, mtime: info.mtimeMs }
  } catch (error) {
    return { path, exists: true, variables: [], mtime: info.mtimeMs, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Write the local variable file atomically. */
async function writeEnvFile(variables) {
  const text = serializeEnv(variables)
  if (Buffer.byteLength(text, 'utf8') > MAX_ENV_BYTES) throw new Error('环境变量内容超过 1 MiB，未保存。')
  await atomicWrite(envPath(), text)
  return readEnvFile()
}

/** Settings-page view of the variable file. */
async function describeEnv() {
  const env = await readEnvFile()
  return { hostProtocol: HOST_PROTOCOL, fileName: ENV_FILE_NAME, ...env }
}

/**
 * Save from the settings page. When `baseMtime` (the version the page loaded,
 * `null` for "no file yet") no longer matches, answer 409 unless `force`.
 */
async function saveEnv(body) {
  const variables = normalizeEnvList(body.variables)
  if (body.force !== true && 'baseMtime' in body) {
    const current = await readEnvFile()
    const base = typeof body.baseMtime === 'number' ? body.baseMtime : null
    const changed = base === null ? current.exists : !current.exists || Math.abs((current.mtime ?? 0) - base) > 1
    if (changed) {
      throw Object.assign(new Error('环境变量文件在打开后已被修改（可能来自云同步或外部编辑器）。'), {
        status: 409,
        payload: { conflict: 'env-changed' },
      })
    }
  }
  await writeEnvFile(variables)
  return describeEnv()
}

/** Name → value map for substitution; an unreadable file counts as empty. */
async function loadEnvMap() {
  const env = await readEnvFile()
  return { map: new Map(env.variables.map(v => [v.name, v.value])), error: env.error }
}

/**
 * Replace every `{{env:NAME}}` with its value; an undefined name is removed.
 * @returns the substituted text.
 */
export function applyEnv(text, map) {
  return String(text).replace(ENV_PLACEHOLDER_RE, (_, name) => (map.has(name) ? map.get(name) : ''))
}

// ───────────────────────────────────────────────────────────── model message

/** Keep template text from closing the plugin-owned frame (same rule as agent-instructions). */
function escapeFrame(text) {
  return text.replace(/<\/system-reminder>/gi, '<\\/system-reminder>')
}

/**
 * Model-visible text of a bound template: AGENTS.md framing and authority.
 * @param globalName - name of the global prompt already bound to this
 *   conversation, if any: the template is appended to it, never replacing it.
 */
function renderTemplate(name, file, content, globalName) {
  return [
    '<system-reminder>',
    `The user started this conversation with the prompt template "${escapeFrame(name)}". ` +
      'Treat it exactly like workspace instructions from AGENTS.md: it applies to this entire conversation, ' +
      'including every later turn, until the conversation ends. It does not override system, developer, or direct user instructions.' +
      (globalName
        ? ` This template is appended after the global prompt "${escapeFrame(globalName)}": both apply together, and this template does not replace or cancel the global prompt.`
        : ''),
    '',
    `Instructions from prompt template: ${escapeFrame(file)}`,
    '',
    escapeFrame(content.trim()),
    '</system-reminder>',
  ].join('\n')
}

/** Model-visible text of the global prompt: AGENTS.md framing and authority. */
function renderGlobal(name, file, content) {
  return [
    '<system-reminder>',
    `The user configured the global prompt "${escapeFrame(name)}" for every new conversation. ` +
      'Treat it exactly like workspace instructions from AGENTS.md: it applies to this entire conversation, ' +
      'including every later turn, until the conversation ends. It does not override system, developer, or direct user instructions. ' +
      'If a prompt template is also selected for this conversation, that template is appended after this global prompt and both apply together.',
    '',
    `Instructions from global prompt: ${escapeFrame(file || name)}`,
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

/** The sourced global-prompt message; the text is the durable snapshot. */
function globalMessage(binding) {
  return userMessage([{ type: 'text', text: binding.text }], {
    kind: GLOBAL_SOURCE_KIND,
    form: 'instructions',
    prompt: binding.name,
    file: binding.file,
    origin: binding.origin,
    digest: binding.digest,
  })
}

/** Whether a message is this plugin's template message. */
function isTemplateMessage(message) {
  return message?.role === 'user' && message?.source?.kind === SOURCE_KIND
}

/** Whether a message is this plugin's global-prompt message. */
function isGlobalMessage(message) {
  return message?.role === 'user' && message?.source?.kind === GLOBAL_SOURCE_KIND
}

/** Global binding carried by a global-prompt message. */
function globalFromMessage(message) {
  return {
    name: String(message.source.prompt ?? ''),
    file: String(message.source.file ?? ''),
    origin: String(message.source.origin ?? ''),
    digest: String(message.source.digest ?? ''),
    text: messageText(message),
  }
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
          ...(error?.payload && typeof error.payload === 'object' ? error.payload : {}),
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

// ───────────────────────────────────────────────────────────── WebDAV sync

/** Per-request budget (connect + proxy handshake + TLS + response). */
const WEBDAV_TIMEOUT_MS = 20_000
/** Cap on a PROPFIND listing body. */
const MAX_LISTING_BYTES = 8 * 1024 * 1024
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>'

/** WebDAV settings as the browser sees them: the password never leaves the host. */
function publicWebdav(webdav) {
  const { password, ...rest } = webdav
  return { ...rest, hasPassword: password !== '', defaultProxyAddress: DEFAULT_PROXY_ADDRESS }
}

/** Parse the configured directory URL (always with a trailing slash). */
function parseDavUrl(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') throw new Error('请先填写 WebDAV 地址。')
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error('WebDAV 地址格式不正确，例如 https://dav.example.com/dav/prompts/')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('WebDAV 地址必须以 http:// 或 https:// 开头。')
  if (url.username || url.password) throw new Error('请把用户名和密码填在对应的输入框中，不要写进地址。')
  url.hash = ''
  url.search = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

/** Parse `host:port` (an optional `http://` / `socks5://` prefix is tolerated). */
function parseProxyAddress(raw) {
  const text = String(raw ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '')
  const match = /^(?:\[([0-9a-fA-F:.]+)\]|([^\s:[\]/]+)):(\d{1,5})$/.exec(text)
  const port = match ? Number(match[3]) : 0
  if (!match || port < 1 || port > 65535) throw new Error(`代理地址格式应为“主机:端口”，例如 ${DEFAULT_PROXY_ADDRESS}`)
  return { host: match[1] ?? match[2], port }
}

/** Human description of the route a request takes (shown in test results). */
function describeRoute(config) {
  if (!config.proxyEnabled) return '直连'
  return `经 ${config.proxyType === 'socks5' ? 'SOCKS5' : 'HTTP'} 代理 ${config.proxyAddress}`
}

/** Open a TCP connection; `track` receives the socket so a timeout can destroy it. */
function openSocket(host, port, track) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = netConnect({ host, port })
    track(socket)
    const onError = (error) => rejectSocket(error)
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.removeListener('error', onError)
      resolveSocket(socket)
    })
  })
}

/**
 * Read from `socket` until `check(buffer)` returns the length of a complete
 * message (>= 0); surplus bytes are pushed back for the next reader.
 */
function readUntil(socket, check) {
  return new Promise((resolveRead, rejectRead) => {
    let buffer = Buffer.alloc(0)
    let done = false
    const finish = () => {
      done = true
      socket.removeListener('readable', onReadable)
      socket.removeListener('error', onError)
      socket.removeListener('end', onEnd)
    }
    const onError = (error) => { finish(); rejectRead(error) }
    const onEnd = () => { finish(); rejectRead(new Error('代理提前关闭了连接')) }
    function onReadable() {
      let chunk
      while (!done && (chunk = socket.read()) !== null) {
        buffer = Buffer.concat([buffer, chunk])
        let used
        try {
          used = check(buffer)
        } catch (error) {
          finish()
          rejectRead(error)
          return
        }
        if (used >= 0) {
          finish()
          if (used < buffer.length) socket.unshift(buffer.subarray(used))
          resolveRead(buffer.subarray(0, used))
          return
        }
      }
    }
    socket.on('readable', onReadable)
    socket.once('error', onError)
    socket.once('end', onEnd)
  })
}

/** Tunnel through an HTTP proxy with CONNECT (works for http and https targets). */
async function httpProxyTunnel(proxy, host, port, track) {
  const socket = await openSocket(proxy.host, proxy.port, track).catch((error) => {
    throw proxyError(error, proxy, 'HTTP')
  })
  const authority = isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
  const head = await readUntil(socket, (buffer) => {
    const end = buffer.indexOf('\r\n\r\n')
    if (end >= 0) return end + 4
    if (buffer.length > 16 * 1024) throw new Error('HTTP 代理返回了无效的响应')
    return -1
  })
  const status = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head.toString('latin1'))?.[1]
  if (status !== '200') {
    socket.destroy()
    throw Object.assign(new Error(status === '407'
      ? `HTTP 代理 ${proxy.host}:${proxy.port} 需要认证（407），本插件暂不支持带认证的代理`
      : `HTTP 代理拒绝了到 ${authority} 的连接（${status ?? '无效响应'}），请确认代理类型选择正确`), { proxy: true })
  }
  return socket
}

const SOCKS5_ERRORS = {
  1: '代理服务器内部错误',
  2: '代理规则不允许该连接',
  3: '网络不可达',
  4: '目标主机不可达',
  5: '目标拒绝连接',
  6: '连接超时',
  7: '代理不支持该命令',
  8: '代理不支持该地址类型',
}

/** Tunnel through a SOCKS5 proxy (no authentication; the proxy resolves the host name). */
async function socks5Tunnel(proxy, host, port, track) {
  const socket = await openSocket(proxy.host, proxy.port, track).catch((error) => {
    throw proxyError(error, proxy, 'SOCKS5')
  })
  const fail = (message) => {
    socket.destroy()
    return Object.assign(new Error(message), { proxy: true })
  }
  socket.write(Buffer.from([5, 1, 0]))
  const hello = await readUntil(socket, (buffer) => (buffer.length >= 2 ? 2 : -1))
  if (hello[0] !== 5) throw fail(`${proxy.host}:${proxy.port} 不是 SOCKS5 代理，请确认代理类型选择正确`)
  if (hello[1] !== 0) throw fail(`SOCKS5 代理 ${proxy.host}:${proxy.port} 要求认证，本插件暂不支持带认证的代理`)
  let address
  if (isIPv4(host)) {
    address = Buffer.from([1, ...host.split('.').map(Number)])
  } else {
    const name = Buffer.from(host, 'utf8')
    if (name.length > 255) throw fail('主机名过长')
    address = Buffer.concat([Buffer.from([3, name.length]), name])
  }
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 255])]))
  const reply = await readUntil(socket, (buffer) => {
    if (buffer.length < 5) return -1
    const type = buffer[3]
    const length = type === 1 ? 10 : type === 4 ? 22 : type === 3 ? 7 + buffer[4] : buffer.length
    return buffer.length >= length ? length : -1
  })
  if (reply[1] !== 0) throw fail(`SOCKS5 代理无法连接 ${host}:${port}：${SOCKS5_ERRORS[reply[1]] ?? `错误码 ${reply[1]}`}`)
  return socket
}

/** A failure to reach the proxy itself. */
function proxyError(error, proxy, kind) {
  const reason = error?.code === 'ECONNREFUSED' ? '连接被拒绝' : error?.code === 'ENOTFOUND' ? '无法解析主机名' : (error?.message ?? String(error))
  return Object.assign(new Error(`无法连接 ${kind} 代理 ${proxy.host}:${proxy.port}（${reason}），请确认代理软件已启动、地址和端口正确`), { proxy: true })
}

/** Upgrade a connected socket to TLS. */
function tlsWrap(socket, host, track) {
  return new Promise((resolveTls, rejectTls) => {
    const secure = tlsConnect({ socket, servername: isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'] })
    track(secure)
    const onError = (error) => rejectTls(error)
    secure.once('error', onError)
    secure.once('secureConnect', () => {
      secure.removeListener('error', onError)
      resolveTls(secure)
    })
  })
}

/** Readable network error text for WebDAV requests. */
function networkErrorText(error) {
  if (error?.proxy || error?.timeout) return error.message
  const code = String(error?.code ?? '')
  if (code === 'ECONNREFUSED') return '连接被拒绝，请检查地址和端口'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '无法解析服务器域名，请检查地址，或开启代理'
  if (code === 'ECONNRESET' || code === 'EPIPE') return '连接被服务器或代理重置'
  if (code === 'ETIMEDOUT' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return '无法连接服务器（网络不可达或超时）'
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL/.test(code)) return `TLS 证书校验失败：${error.message}`
  if (code === 'EPROTO' || /wrong version number/i.test(error?.message ?? '')) return 'TLS 握手失败：地址的协议（http/https）或端口可能不正确'
  return error?.message ?? String(error)
}

/**
 * One WebDAV request (follows up to 3 redirects).
 * @returns `{ status, headers, body }` with the full body buffered (capped at `maxBytes`).
 */
async function davRequest(config, method, url, { headers = {}, body, maxBytes = MAX_LISTING_BYTES, redirects = 3 } = {}) {
  const target = new URL(url)
  const secure = target.protocol === 'https:'
  const host = target.hostname.replace(/^\[|\]$/g, '')
  const port = Number(target.port) || (secure ? 443 : 80)
  const sockets = []
  const track = (socket) => { sockets.push(socket) }
  let timer
  const timeout = new Promise((_, rejectTimeout) => {
    timer = setTimeout(() => {
      for (const socket of sockets) socket.destroy()
      rejectTimeout(Object.assign(new Error(`请求超时（${WEBDAV_TIMEOUT_MS / 1000} 秒，${describeRoute(config)}）`), { timeout: true }))
    }, WEBDAV_TIMEOUT_MS)
  })
  const run = async () => {
    let socket
    if (config.proxyEnabled) {
      const proxy = parseProxyAddress(config.proxyAddress)
      socket = config.proxyType === 'socks5'
        ? await socks5Tunnel(proxy, host, port, track)
        : await httpProxyTunnel(proxy, host, port, track)
    } else {
      socket = await openSocket(host, port, track)
    }
    if (secure) socket = await tlsWrap(socket, host, track)
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
    const auth = config.username !== '' || config.password !== ''
      ? { authorization: 'Basic ' + Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64') }
      : {}
    return await new Promise((resolveResponse, rejectResponse) => {
      const req = httpRequest({
        method,
        host,
        port,
        path: target.pathname + target.search,
        headers: {
          host: target.host,
          connection: 'close',
          'user-agent': `dsh-prompt-switcher/${version}`,
          ...auth,
          ...headers,
          ...(payload ? { 'content-length': String(payload.length) } : {}),
        },
        createConnection: () => socket,
      })
      req.once('error', rejectResponse)
      req.once('response', (res) => {
        const chunks = []
        let size = 0
        res.on('data', (chunk) => {
          size += chunk.length
          if (size > maxBytes) {
            req.destroy(Object.assign(new Error('响应超过大小上限'), { tooLarge: true }))
            return
          }
          chunks.push(chunk)
        })
        res.once('end', () => resolveResponse({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
        res.once('error', rejectResponse)
      })
      req.end(payload)
    })
  }
  let response
  try {
    response = await Promise.race([run(), timeout])
  } catch (error) {
    if (error?.tooLarge) throw error
    throw Object.assign(new Error(networkErrorText(error)), { network: true })
  } finally {
    clearTimeout(timer)
    for (const socket of sockets) socket.destroy()
  }
  if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location && redirects > 0) {
    const next = new URL(response.headers.location, target)
    return davRequest(config, method, next.href, { headers, body, maxBytes, redirects: redirects - 1 })
  }
  return response
}

/** Readable text for an unexpected WebDAV status. */
function davStatusText(status, action) {
  if (status === 401) return `${action}失败：认证失败（401），请检查用户名和密码`
  if (status === 403) return `${action}失败：没有权限（403）`
  if (status === 404) return `${action}失败：路径不存在（404）`
  if (status === 405) return `${action}失败：服务器不允许该操作（405），请确认地址指向 WebDAV 目录`
  if (status === 409) return `${action}失败：上级目录不存在（409）`
  if (status === 423) return `${action}失败：资源被锁定（423）`
  if (status === 507) return `${action}失败：云端空间不足（507）`
  return `${action}失败：服务器返回 HTTP ${status}`
}

function decodeXml(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** Text of the first `<prefix:tag>` element in `xml` (any namespace prefix). */
function xmlTag(xml, tag) {
  const match = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}\\s*>`, 'i').exec(xml)
  return match ? decodeXml(match[1]).trim() : undefined
}

/** Normalized, decoded path without a trailing slash. */
function davPath(pathname) {
  return safeDecode(pathname).replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

/**
 * The `.md` files directly inside the listed directory (no collections, no
 * sub-directories) from a PROPFIND Depth: 1 multistatus body.
 */
function parseListing(xml, base) {
  const directory = davPath(base.pathname)
  const files = []
  const responses = xml.match(/<(?:[\w.-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?response\s*>/gi) ?? []
  for (const block of responses) {
    const href = xmlTag(block, 'href')
    if (!href) continue
    if (/<(?:[\w.-]+:)?collection\b/i.test(block)) continue
    let path
    try {
      path = davPath(new URL(href, base).pathname)
    } catch {
      continue
    }
    const slash = path.lastIndexOf('/')
    if (path.slice(0, slash) !== directory) continue
    const name = path.slice(slash + 1)
    if (name === '' || extname(name).toLowerCase() !== '.md') continue
    const size = Number.parseInt(xmlTag(block, 'getcontentlength') ?? '', 10)
    const mtime = Date.parse(xmlTag(block, 'getlastmodified') ?? '')
    files.push({ name, size: Number.isFinite(size) ? size : null, mtime: Number.isFinite(mtime) ? mtime : null })
  }
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
  return files
}

/** URL of one file inside the configured directory. */
function davFileUrl(base, name) {
  return new URL(encodeURIComponent(name), base).href
}

/**
 * List the remote directory.
 * @returns `{ base, missing: true }` when it does not exist yet, else `{ base, missing: false, files }`.
 */
async function listRemote(config) {
  const base = parseDavUrl(config.url)
  const res = await davRequest(config, 'PROPFIND', base.href, {
    headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY,
  })
  if (res.status === 404) return { base, missing: true, files: [] }
  if (res.status !== 207 && res.status !== 200) throw new Error(davStatusText(res.status, '读取云端目录'))
  return { base, missing: false, files: parseListing(res.body.toString('utf8'), base) }
}

/** Connection test: PROPFIND Depth: 0 on the directory with the given (possibly unsaved) settings. */
async function testWebdav(config) {
  const route = describeRoute(config)
  try {
    const base = parseDavUrl(config.url)
    if (config.proxyEnabled) parseProxyAddress(config.proxyAddress)
    const started = Date.now()
    const res = await davRequest(config, 'PROPFIND', base.href, {
      headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    })
    const elapsed = Date.now() - started
    if (res.status === 207 || res.status === 200) {
      return { ok: true, message: `连接成功（${route}，HTTP ${res.status}，耗时 ${elapsed} ms）` }
    }
    if (res.status === 404) {
      return { ok: true, warning: true, message: `已连接到服务器（${route}），但云端目录不存在；第一次“同步到云端”时会自动创建。` }
    }
    return { ok: false, message: `${davStatusText(res.status, '连接')}（${route}）` }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return { ok: false, message: error?.network ? `连接失败：${text}` : text }
  }
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Unique non-empty strings from a client-supplied array. */
function nameList(value) {
  return Array.isArray(value) ? [...new Set(value.filter(v => typeof v === 'string' && v !== ''))] : []
}

/** Configured template directory (sync target/source), or a readable error. */
function requireDirectory(store) {
  if (!store.directory) throw new Error('请先在“提示词设置”中配置模板目录。')
  return store.directory
}

/** Remote listing for “同步到本地”: every remote `.md` plus whether a local file has that name. */
async function remoteForPull(store) {
  const directory = requireDirectory(store)
  const listing = await listRemote(store.webdav)
  if (listing.missing) throw new Error('云端目录不存在，请检查 WebDAV 地址。')
  const files = []
  for (const file of listing.files) {
    files.push({ ...file, conflict: await pathExists(join(directory, file.name)), invalid: invalidFileName(file.name) })
  }
  return { url: listing.base.href, directory, files }
}

/** Local listing for “同步到云端”: every local `.md` plus whether the cloud has that name. */
async function localForPush(store) {
  const directory = requireDirectory(store)
  const scan = await scanDirectory(directory)
  if (scan.error) throw new Error(scan.error)
  const listing = await listRemote(store.webdav)
  const remote = new Set(listing.files.map(f => f.name))
  return {
    url: listing.base.href,
    directory,
    remoteMissing: listing.missing,
    files: scan.templates.map(t => ({ name: t.file, size: t.size, mtime: t.mtime, conflict: remote.has(t.file) })),
  }
}

/**
 * Download the chosen remote files into the template directory. A file that
 * exists locally is only replaced when named in `overwrite` (re-checked here).
 */
async function pullFiles(store, names, overwrite) {
  const directory = requireDirectory(store)
  const listing = await listRemote(store.webdav)
  if (listing.missing) throw new Error('云端目录不存在，请检查 WebDAV 地址。')
  const remote = new Set(listing.files.map(f => f.name))
  const replace = new Set(nameList(overwrite))
  const results = []
  for (const name of nameList(names)) {
    if (!remote.has(name)) {
      results.push({ name, status: 'error', message: '云端已不存在该文件' })
      continue
    }
    const problem = invalidFileName(name)
    if (problem) {
      results.push({ name, status: 'error', message: `文件名不能在本地使用：${problem}` })
      continue
    }
    const target = join(directory, name)
    const exists = await pathExists(target)
    if (exists && !replace.has(name)) {
      results.push({ name, status: 'skipped' })
      continue
    }
    try {
      const res = await davRequest(store.webdav, 'GET', davFileUrl(listing.base, name), { maxBytes: MAX_TEMPLATE_BYTES })
      if (res.status !== 200) throw new Error(davStatusText(res.status, '下载'))
      await writeFile(target, res.body)
      results.push({ name, status: exists ? 'overwritten' : 'created' })
    } catch (error) {
      results.push({ name, status: 'error', message: error?.tooLarge ? '文件超过 1 MiB' : (error instanceof Error ? error.message : String(error)) })
    }
  }
  return { results }
}

/**
 * Upload the chosen local templates into the remote directory (created when
 * missing). A remote file with the same name is only replaced when named in
 * `overwrite` (re-checked here).
 */
async function pushFiles(store, names, overwrite) {
  const directory = requireDirectory(store)
  const scan = await scanDirectory(directory)
  if (scan.error) throw new Error(scan.error)
  const local = new Map(scan.templates.map(t => [t.file, t]))
  const listing = await listRemote(store.webdav)
  if (listing.missing) {
    const res = await davRequest(store.webdav, 'MKCOL', listing.base.href)
    if (res.status !== 201 && res.status !== 405) throw new Error(davStatusText(res.status, '创建云端目录'))
  }
  const remote = new Set(listing.files.map(f => f.name))
  const replace = new Set(nameList(overwrite))
  const results = []
  for (const name of nameList(names)) {
    const template = local.get(name)
    if (!template) {
      results.push({ name, status: 'error', message: '本地已不存在该文件' })
      continue
    }
    const exists = remote.has(name)
    if (exists && !replace.has(name)) {
      results.push({ name, status: 'skipped' })
      continue
    }
    try {
      if (template.size > MAX_TEMPLATE_BYTES) throw new Error('文件超过 1 MiB')
      const content = await readFile(join(directory, name))
      const res = await davRequest(store.webdav, 'PUT', davFileUrl(listing.base, name), {
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
        body: content,
      })
      if (![200, 201, 204].includes(res.status)) throw new Error(davStatusText(res.status, '上传'))
      results.push({ name, status: exists ? 'overwritten' : 'created' })
    } catch (error) {
      results.push({ name, status: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { results }
}

/** Environment-variable sync needs its switch on and a saved URL. */
function requireEnvSync(store) {
  if (!store.webdav.syncEnv) throw new Error('请先打开“同步环境变量文件”开关。')
  if (!store.webdav.url) throw new Error('请先填写并保存 WebDAV 地址。')
}

/**
 * The variable file at the root of the WebDAV directory.
 * @returns `{ url, exists, variables, error? }`.
 */
async function readRemoteEnv(config) {
  const base = parseDavUrl(config.url)
  const url = davFileUrl(base, ENV_FILE_NAME)
  let res
  try {
    res = await davRequest(config, 'GET', url, { maxBytes: MAX_ENV_BYTES })
  } catch (error) {
    if (error?.tooLarge) return { base, url, exists: true, variables: [], error: '云端环境变量文件超过 1 MiB。' }
    throw error
  }
  if (res.status === 404) return { base, url, exists: false, variables: [] }
  if (res.status !== 200) throw new Error(davStatusText(res.status, '读取云端环境变量文件'))
  try {
    return { base, url, exists: true, variables: parseEnvText(res.body.toString('utf8')) }
  } catch (error) {
    return { base, url, exists: true, variables: [], error: `云端${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Upload a variable list as the remote file (the directory is created when missing). */
async function writeRemoteEnv(config, remote, variables) {
  const listing = await listRemote(config)
  if (listing.missing) {
    const made = await davRequest(config, 'MKCOL', listing.base.href)
    if (made.status !== 201 && made.status !== 405) throw new Error(davStatusText(made.status, '创建云端目录'))
  }
  const res = await davRequest(config, 'PUT', remote.url, {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: serializeEnv(variables),
  })
  if (![200, 201, 204].includes(res.status)) throw new Error(davStatusText(res.status, '上传环境变量文件'))
}

/**
 * Compare two variable lists by name.
 * @returns `{ same, onlyLocal, onlyRemote, conflicts }` (conflicts carry both values).
 */
function diffEnv(localVars, remoteVars) {
  const remote = new Map(remoteVars.map(v => [v.name, v.value]))
  const local = new Map(localVars.map(v => [v.name, v.value]))
  const same = []
  const onlyLocal = []
  const conflicts = []
  for (const { name, value } of localVars) {
    if (!remote.has(name)) onlyLocal.push({ name, value })
    else if (remote.get(name) === value) same.push(name)
    else conflicts.push({ name, local: value, remote: remote.get(name) })
  }
  const onlyRemote = remoteVars.filter(v => !local.has(v.name)).map(({ name, value }) => ({ name, value }))
  return { same, onlyLocal, onlyRemote, conflicts }
}

/** Local and remote variable files side by side, for the sync panel. */
async function compareEnv(store) {
  requireEnvSync(store)
  const local = await readEnvFile()
  const remote = await readRemoteEnv(store.webdav)
  const diff = diffEnv(local.variables, remote.variables)
  return {
    fileName: ENV_FILE_NAME,
    local: { path: local.path, exists: local.exists, count: local.variables.length, error: local.error },
    remote: { url: safeDecode(remote.url), exists: remote.exists, count: remote.variables.length, error: remote.error },
    diff,
    identical: local.exists && remote.exists && !local.error && !remote.error &&
      diff.onlyLocal.length === 0 && diff.onlyRemote.length === 0 && diff.conflicts.length === 0,
  }
}

/**
 * Merge two lists: local order first, then remote-only names. A name whose
 * values differ takes the side named in `choices[name]` ('local' | 'remote').
 * @returns `{ merged }` or `{ unresolved }` (conflicts without a choice).
 */
function mergeEnv(localVars, remoteVars, choices) {
  const remote = new Map(remoteVars.map(v => [v.name, v.value]))
  const pick = choices && typeof choices === 'object' ? choices : {}
  const merged = []
  const unresolved = []
  for (const { name, value } of localVars) {
    if (!remote.has(name) || remote.get(name) === value) {
      merged.push({ name, value })
      continue
    }
    if (pick[name] === 'local') merged.push({ name, value })
    else if (pick[name] === 'remote') merged.push({ name, value: remote.get(name) })
    else unresolved.push({ name, local: value, remote: remote.get(name) })
  }
  const local = new Set(localVars.map(v => v.name))
  for (const v of remoteVars) if (!local.has(v.name)) merged.push({ name: v.name, value: v.value })
  return unresolved.length > 0 ? { unresolved } : { merged }
}

/**
 * Run one environment-variable sync:
 * - `push`  本地覆盖云端 (upload the local file);
 * - `pull`  云端覆盖本地 (download the cloud file);
 * - `merge` 合并配置文件 (write the merged list to both sides; conflicting
 *   names need a choice, otherwise 409 with the conflicts).
 * Both files are re-read here, so the result never relies on a stale listing.
 */
async function syncEnv(store, mode, choices) {
  requireEnvSync(store)
  const local = await readEnvFile()
  const remote = await readRemoteEnv(store.webdav)
  if (mode === 'push') {
    if (local.error) throw new Error(local.error)
    if (!local.exists) throw new Error('本地还没有环境变量文件，请先在“环境变量”页面添加并保存。')
    await writeRemoteEnv(store.webdav, remote, local.variables)
    return { mode, count: local.variables.length }
  }
  if (mode === 'pull') {
    if (remote.error) throw new Error(remote.error)
    if (!remote.exists) throw new Error('云端没有环境变量文件。')
    await writeEnvFile(remote.variables)
    return { mode, count: remote.variables.length }
  }
  if (mode === 'merge') {
    if (local.error) throw new Error(local.error)
    if (remote.error) throw new Error(remote.error)
    const result = mergeEnv(local.variables, remote.variables, choices)
    if (result.unresolved) {
      throw Object.assign(new Error('有同名但值不同的环境变量，请为每一项选择使用云端还是本地的值。'), {
        status: 409,
        payload: { conflict: 'env-choices', conflicts: result.unresolved },
      })
    }
    await writeEnvFile(result.merged)
    await writeRemoteEnv(store.webdav, remote, result.merged)
    return { mode, count: result.merged.length }
  }
  throw new Error('未知的同步方式。')
}

/** Apply a settings-form body onto WebDAV settings (an empty password keeps the saved one). */
function mergeWebdav(current, body) {
  const next = { ...current }
  if (typeof body.url === 'string') next.url = body.url.trim()
  if (typeof body.username === 'string') next.username = body.username
  if (typeof body.password === 'string' && body.password !== '') next.password = body.password
  if (body.clearPassword === true) next.password = ''
  if (typeof body.proxyEnabled === 'boolean') next.proxyEnabled = body.proxyEnabled
  if (body.proxyType === 'http' || body.proxyType === 'socks5') next.proxyType = body.proxyType
  if (typeof body.proxyAddress === 'string') next.proxyAddress = body.proxyAddress.trim() || DEFAULT_PROXY_ADDRESS
  if (typeof body.syncEnv === 'boolean') next.syncEnv = body.syncEnv
  return next
}

// ───────────────────────────────────────────────────────────── delete conversation

/**
 * DSH (0.2.0-rc.1) has no "delete session" operation: the session-persistence
 * contract is append-only and the Web UI only archives. Deleting therefore
 * composes the pieces the Harness does expose, in this order:
 * 1. archive with `stopActivity` (the official path behind "归档对话"): stops
 *    the turn, jobs, subagents and schedules, and makes every browser leave
 *    the conversation if it is open;
 * 2. unload the live Agent/Session, if this process loaded it;
 * 3. remove the session directory of the conversation and of its subagent
 *    sessions (forks are independent conversations and stay);
 * 4. drop the projection-cache rows, clear the archive/pin entries, and emit
 *    `api-session/removed` (forwarded to every browser by dsh-api-remotes).
 */

/** Effect label dsh-agent-loop gives the lifecycle of one live Agent (`prepare`). */
const agentLifecycleLabel = (id) => `agentLoop.lifecycle(${id})`
/** Cordis tags every effect disposer with its metadata under this global symbol. */
const CORDIS_EFFECT = Symbol.for('cordis.effect')
/** How long to wait for an unloaded Agent to leave the live registries. */
const UNLOAD_TIMEOUT_MS = 15_000

/** A Harness service when this composition has it (`undefined` otherwise). */
function optionalService(ctx, name) {
  try {
    return ctx.get?.(name) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Same encoding as dsh-session-persistence-jsonl `encodeSegment`: the name of
 * a session's own directory. Used to verify a located path before removal.
 */
export function encodeSessionSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch) ? ch : '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * The directory that holds every artifact of one stored session, refusing
 * anything that does not look exactly like `<root>/<project key>/<session id>`.
 */
function sessionDirectoryOf(persistence, header) {
  let located
  try {
    located = persistence.locate?.(header)
  } catch (error) {
    throw new Error(`无法定位对话文件：${error instanceof Error ? error.message : String(error)}`)
  }
  const path = typeof located === 'string' ? located : located?.path
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error('当前 DSH 的会话存储不支持定位对话文件，无法删除（需要 JSONL 会话存储）。')
  }
  const dir = dirname(path)
  const project = basename(dirname(dir))
  if (basename(dir) !== encodeSessionSegment(String(header.id)) ||
    !(project === '_no-cwd' || (project.length > 4 && project.startsWith('--') && project.endsWith('--')))) {
    throw new Error(`对话文件的位置与预期不符，已取消删除：${dir}`)
  }
  return dir
}

/**
 * Every live effect disposer with this label, across all fibers. The Agent
 * loop keeps the teardown of a Web session's Agent only in the owner's effect
 * (the Session controller drops the handle), so the effect label is the one
 * stable way to reach it. Returns [] when Cordis internals differ.
 */
function findEffectDisposers(ctx, label) {
  const found = []
  let runtimes
  try {
    runtimes = [...ctx.registry.values()]
  } catch {
    return found
  }
  for (const runtime of runtimes) {
    let fibers
    try {
      fibers = [...(runtime?.fibers ?? [])]
    } catch {
      continue
    }
    for (const fiber of fibers) {
      let disposables
      try {
        disposables = [...(fiber?._disposables ?? [])]
      } catch {
        continue
      }
      for (const dispose of disposables) {
        if (typeof dispose === 'function' && dispose[CORDIS_EFFECT]?.label === label) found.push(dispose)
      }
    }
  }
  return found
}

/**
 * Deletes conversations for the settings-gated route.
 * @param ctx - the plugin context (services are looked up per call).
 * @param logger - optional logger.
 */
function createSessionDeleter(ctx, logger) {
  const sessionsOf = () => optionalService(ctx, 'sessions')
  const agentsOf = () => optionalService(ctx, 'agents')
  const isLive = (id) => {
    try {
      return agentsOf()?.get?.(id) !== undefined || sessionsOf()?.get?.(id) !== undefined
    } catch {
      return false
    }
  }
  const warn = (message, error) => logger?.warn?.(`${message}: %s`, error instanceof Error ? error.message : String(error))

  /** Unload one live Agent (and its Session) through its own lifecycle teardown. */
  async function unload(id) {
    for (const dispose of findEffectDisposers(ctx, agentLifecycleLabel(id))) {
      try {
        await dispose()
      } catch (error) {
        warn(`unloading agent ${id} failed`, error)
      }
    }
    const deadline = Date.now() + UNLOAD_TIMEOUT_MS
    while (isLive(id) && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 50))
    return !isLive(id)
  }

  /** Settings gate + services + every known header (stored logs and this process's live sessions). */
  async function prepare() {
    const store = await readStore()
    if (!store.allowDeleteSession) {
      throw Object.assign(new Error('未开启“允许删除对话”：请在 设置 → 提示词模板 → 允许删除对话 中开启。'), { status: 403 })
    }
    const persistence = optionalService(ctx, 'sessionPersistence')
    if (!persistence || typeof persistence.list !== 'function') {
      throw new Error('当前 DSH 没有可用的会话存储（sessionPersistence），无法删除对话。')
    }
    const headers = new Map()
    for (const snapshot of await persistence.list()) {
      if (typeof snapshot?.header?.id === 'string') headers.set(snapshot.header.id, snapshot.header)
    }
    const stored = new Set(headers.keys())
    try {
      for (const session of sessionsOf()?.list?.() ?? []) {
        if (session?.header && typeof session.id === 'string' && !headers.has(session.id)) headers.set(session.id, session.header)
      }
    } catch { /* no live registry */ }
    return { persistence, workspaces: optionalService(ctx, 'workspaceRegistry'), headers, stored }
  }

  /** Current archive set (empty when the workspace registry is absent). */
  const archivedIds = (workspaces) => {
    try {
      return [...(workspaces?.archivedSessionIds ?? [])].map(String)
    } catch {
      return []
    }
  }

  /**
   * Delete one conversation.
   * @param sessionId - the top-level conversation to delete.
   * @param env - the result of {@link prepare}; deleted ids are removed from it.
   * @returns `{ deleted, pendingRestart }`; `pendingRestart` when a live copy
   *   could not be unloaded (it stays archived until `dsh web` restarts).
   */
  async function deleteOne(sessionId, env) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 512) throw new Error('缺少对话 ID。')
    const { persistence, workspaces, headers, stored } = env
    const root = headers.get(sessionId)
    if (!root) throw Object.assign(new Error('对话不存在，或已被删除。'), { status: 404 })
    if (root.origin === 'subagent') throw new Error('子代理会话不能单独删除，请删除它所属的对话。')

    // The conversation plus its subagent sessions (at any depth).
    const targets = [sessionId]
    for (let grew = true; grew;) {
      grew = false
      for (const [id, header] of headers) {
        if (!targets.includes(id) && header?.origin === 'subagent' && targets.includes(header.parentSession)) {
          targets.push(id)
          grew = true
        }
      }
    }

    // Locate (and verify) every directory before anything changes.
    const directories = targets.filter(id => stored.has(id)).map(id => sessionDirectoryOf(persistence, headers.get(id)))

    // 1. Stop its work and move every browser off it (official archive path).
    const wasArchived = archivedIds(workspaces).includes(sessionId)
    let stopped = false
    if (!wasArchived && typeof workspaces?.archiveSession === 'function') {
      try {
        await workspaces.archiveSession(sessionId, { stopActivity: true })
        stopped = true
      } catch (error) {
        warn(`archiving ${sessionId} before deletion failed`, error)
      }
    }
    if (!stopped) {
      try {
        await ctx.parallel?.('workspace/session-stop', { sessionId })
      } catch (error) {
        warn(`stopping ${sessionId} before deletion failed`, error)
      }
    }

    // 2. Unload live copies, subagents first.
    const stillLive = []
    for (const id of [...targets].reverse()) {
      if (isLive(id) && !(await unload(id))) stillLive.push(id)
    }

    // 3. Remove the stored logs.
    for (const dir of directories) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

    // 4. Projection cache rows, archive / pin entries, browser lists.
    const cache = optionalService(ctx, 'sessionProjectionCache')
    for (const id of targets) {
      try {
        await cache?.table?.delete?.(id)
      } catch (error) {
        warn(`dropping the projection cache of ${id} failed`, error)
      }
    }
    // A copy that is still loaded keeps its archive entry so it stays hidden until a restart.
    if (stillLive.length === 0 && workspaces) {
      for (const cleanup of ['unpinSession', 'unarchiveSession']) {
        try {
          await workspaces[cleanup]?.(sessionId)
        } catch (error) {
          warn(`${cleanup}(${sessionId}) after deletion failed`, error)
        }
      }
    }
    for (const id of targets) {
      try {
        ctx.emit?.('api-session/removed', id)
      } catch (error) {
        warn(`announcing the removal of ${id} failed`, error)
      }
    }
    for (const id of targets) {
      headers.delete(id)
      stored.delete(id)
    }
    logger?.info?.('deleted conversation %s (%d session logs)', sessionId, targets.length)
    return { deleted: targets, pendingRestart: stillLive.length > 0 }
  }

  /**
   * Top-level archived conversations (archived subagent sessions go with
   * their conversation), plus archive entries whose session no longer exists.
   */
  function archivedPlan(env) {
    const conversations = []
    const dangling = []
    for (const id of archivedIds(env.workspaces)) {
      const header = env.headers.get(id)
      if (!header) dangling.push(id)
      else if (header.origin !== 'subagent') conversations.push(id)
    }
    return { conversations, dangling }
  }

  return {
    deleteSession: async (sessionId) => deleteOne(sessionId, await prepare()),
    /** How many archived conversations "删除所有已归档" would delete. */
    async countArchived() {
      const env = await prepare()
      return { count: archivedPlan(env).conversations.length }
    },
    /**
     * Delete every archived conversation; one failure does not stop the rest.
     * @returns `{ deleted, failed: [{ sessionId, error }], pendingRestart }`.
     */
    async deleteArchived() {
      const env = await prepare()
      const { conversations, dangling } = archivedPlan(env)
      const deleted = []
      const failed = []
      let pendingRestart = false
      for (const id of conversations) {
        if (!env.headers.has(id)) continue // already removed with an earlier conversation
        try {
          const result = await deleteOne(id, env)
          deleted.push(id)
          pendingRestart ||= result.pendingRestart
        } catch (error) {
          failed.push({ sessionId: id, error: error instanceof Error ? error.message : String(error) })
        }
      }
      // Archive entries of sessions that are already gone: just clear them.
      for (const id of dangling) {
        try {
          await env.workspaces?.unarchiveSession?.(id)
        } catch (error) {
          warn(`unarchiveSession(${id}) failed`, error)
        }
      }
      return { deleted, failed, pendingRestart }
    },
  }
}

// ───────────────────────────────────────────────────────────── plugin

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('prompt-switcher') : ctx.logger

  /** Template bindings made in this process whose message may not be in the log yet. */
  const pendingBindings = new WeakMap()
  /** Global-prompt bindings made in this process whose message may not be in the log yet. */
  const pendingGlobals = new WeakMap()

  // ── durable bindings: fold the first template / global-prompt message from the full log.
  const projectionAvailable = (() => {
    try {
      ctx.sessionProjections.register({
        key: PROJECTION_KEY,
        stateVersion: 2,
        // Plain JSON state; the registry only calls `parse` on persisted rows.
        stateSchema: {
          parse(value) {
            if (value && typeof value === 'object' && 'bound' in value) return { global: null, ...value }
            throw new Error('invalid prompt-switcher projection state')
          },
        },
        init: () => ({ bound: null, global: null }),
        apply(state, event) {
          if (event?.type !== 'user/message') return state
          const message = event.data
          if (state.bound === null && isTemplateMessage(message)) {
            return {
              ...state,
              bound: {
                name: String(message.source.template ?? ''),
                file: String(message.source.file ?? ''),
                digest: String(message.source.digest ?? ''),
                text: messageText(message),
              },
            }
          }
          if ((state.global ?? null) === null && isGlobalMessage(message)) {
            return { ...state, global: globalFromMessage(message) }
          }
          return state
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

  /** The global prompt bound to a session, if any (log fold, then in-flight, then visible history). */
  const globalBindingOf = (session) => {
    if (projectionAvailable) {
      try {
        const bound = ctx.sessionProjections.stateOf(session, PROJECTION_KEY)?.global
        if (bound) return bound
      } catch { /* session not projected yet */ }
    }
    const pending = pendingGlobals.get(session)
    if (pending) return pending
    try {
      const visible = session.deriveMessages().find(isGlobalMessage)
      if (visible) return globalFromMessage(visible)
    } catch { /* no history access */ }
    return undefined
  }

  /** Top-level user conversation (not a subagent, not seeded from another session). */
  const isTopLevel = (session) => {
    if (session.header?.isSeeded) return false
    if ((session.header?.delegationDepth ?? 0) > 0 || session.header?.origin === 'subagent') return false
    return true
  }

  /** Whether the agent's session has never had a conversation turn. */
  const isFreshSession = (agent) => {
    const session = agent.session
    if (!isTopLevel(session)) return false
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

  /**
   * Whether this pre-step opens the very first turn of a brand-new top-level
   * conversation: the only moment a global prompt is bound. Conversations that
   * started before the global prompt was enabled are never touched.
   */
  const isConversationStart = (session, turn) => {
    if (!isTopLevel(session)) return false
    let current = turn
    if (typeof current !== 'number') {
      try {
        current = ctx.sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn
      } catch { /* projection absent */ }
    }
    if (typeof current === 'number' && current > 1) return false
    let history
    try {
      history = session.deriveMessages()
    } catch {
      return false
    }
    return !history.some(m => m.role === 'assistant' ||
      (m.role === 'user' && (m.source?.kind === 'user' || m.source?.kind === 'compaction')))
  }

  /** Resolve the global prompt for a conversation that starts now; failures only log. */
  const bindGlobalNow = async (session) => {
    let loaded
    try {
      loaded = await loadGlobalPrompt()
    } catch (error) {
      loaded = { error: error instanceof Error ? error.message : String(error) }
    }
    if (loaded?.error) {
      logger?.warn?.('global prompt not applied: %s', loaded.error)
      return { error: loaded.error }
    }
    if (!loaded?.binding) return {}
    pendingGlobals.set(session, loaded.binding)
    return { binding: loaded.binding }
  }

  // ── bind the global prompt to new conversations, and keep the global prompt
  //    and template in the model-visible history for every later step
  //    (global first, the template appended after it).
  // Fail-open: this hook runs before every model step of every conversation,
  // so any surprise (a changed DSH contract, an unreadable prompt file) only
  // skips the injection — it never breaks the step itself.
  ctx.on('agent/pre-step', async (event, next) => {
    const decision = await next()
    try {
      return await injectPrompts(event, decision)
    } catch (error) {
      logger?.warn?.('prompt injection skipped: %s', error instanceof Error ? error.message : String(error))
      return decision
    }
  })

  /** The pre-step decision with the global prompt / template prepended when they are missing. */
  async function injectPrompts({ agent, step, turn }, decision) {
    if (!decision || !Array.isArray(decision.messages) || !agent?.session) return decision
    if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
    const session = agent.session

    let global = globalBindingOf(session)
    if (!global && !decision.messages.some(isGlobalMessage) && isConversationStart(session, turn)) {
      global = (await bindGlobalNow(session)).binding
    }
    const template = bindingOf(session)
    if (!global && !template) return decision

    let history = []
    try {
      history = session.deriveMessages()
    } catch { /* treat as missing */ }
    const prefix = []
    // Missing from both this step and the visible history (new conversation,
    // compaction, or an interrupted first step): re-inject the same snapshot.
    if (global && !decision.messages.some(isGlobalMessage) && !history.some(isGlobalMessage)) {
      prefix.push(globalMessage(global))
    }
    if (template && !decision.messages.some(isTemplateMessage) && !history.some(isTemplateMessage)) {
      prefix.push(templateMessage(template))
    }
    if (prefix.length === 0) return decision
    return { ...decision, messages: [...prefix, ...decision.messages] }
  }

  // ── the slash command the Browser half submits.
  ctx.inject(['commands'], (commandCtx) => {
    if (typeof commandCtx.commands?.register !== 'function') {
      logger?.warn?.('commands.register unavailable: the /prompt-template command is disabled')
      return
    }
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

        // The global prompt (if enabled) is bound first; the template is appended after it.
        let global = globalBindingOf(agent.session)
        let globalError
        if (!global) {
          const bound = await bindGlobalNow(agent.session)
          global = bound.binding
          globalError = bound.error
        }

        // `{{env:NAME}}` placeholders are resolved into the bound snapshot.
        const { map: envMap, error: envError } = await loadEnvMap()
        if (envError) logger?.warn?.('environment variables not applied: %s', envError)
        const binding = {
          name: template.name,
          file: template.file,
          digest: createHash('sha1').update(template.content, 'utf8').digest('hex'),
          text: renderTemplate(template.name, template.file, applyEnv(template.content, envMap), global?.name),
        }
        pendingBindings.set(agent.session, binding)
        // Same order as /plan: model-facing context first, then the user's own message wakes the turn.
        if (global) agent.inject(globalMessage(global))
        agent.inject(templateMessage(binding))
        agent.steer(userMessage(
          [...attachments, ...(message === '' ? [] : [{ type: 'text', text: message }])],
          { kind: 'user' },
        ))
        const applied = global
          ? `已应用全局提示词「${global.name}」，并在其后追加提示词模板「${template.name}」，本对话后续所有轮次都将同时遵守两者。`
          : `已应用提示词模板「${template.name}」，本对话后续所有轮次都将遵守该模板。`
        return { kind: 'success', text: globalError ? `${applied}（全局提示词未生效：${globalError}）` : applied }
      },
    })
  })

  const deleter = createSessionDeleter(ctx, logger)
  /** One deletion at a time (a bulk delete must not interleave with a single one). */
  let deletionChain = Promise.resolve()
  const serialized = (job) => {
    const next = deletionChain.then(job, job)
    deletionChain = next.catch(() => {})
    return next
  }
  const describeDeletion = async () => ({ hostProtocol: HOST_PROTOCOL, enabled: (await readStore()).allowDeleteSession })

  // ── settings + menu routes.
  const routes = [
    // "允许删除对话": the switch, and the deletion the sidebar menu asks for.
    route('session-delete/settings', {
      GET: () => describeDeletion(),
      POST: async (body) => {
        if (typeof body.enabled !== 'boolean') throw new Error('缺少 enabled。')
        const store = await readStore()
        await writeStore({ ...store, allowDeleteSession: body.enabled })
        return describeDeletion()
      },
    }),
    route('session-delete', 'POST', (body) => serialized(() => deleter.deleteSession(body.sessionId))),
    // "删除所有已归档" in the sidebar view-options menu.
    route('session-delete/archived', {
      GET: () => deleter.countArchived(),
      POST: () => serialized(() => deleter.deleteArchived()),
    }),
    route('state', 'GET', () => describeState()),
    route('templates', 'GET', async () => {
      const state = await describeState()
      return {
        hostProtocol: HOST_PROTOCOL,
        pinTop: state.pinTop,
        templates: state.templates.filter(t => t.active).map(({ id, name, file }) => ({ id, name, file })),
        global: { effective: state.global.effective, name: state.global.name },
      }
    }),
    // Global prompt: partial update of { enabled, source, file, customName, customContent, overwrite }.
    route('global', 'POST', async (body) => {
      const store = await readStore()
      let global = { ...store.global }
      if (body.source === 'file' || body.source === 'custom') global.source = body.source
      if (typeof body.file === 'string') {
        // Only a file the current directory scan lists can be chosen (no arbitrary paths).
        global.filePath = body.file === '' ? '' : (await resolveListedFile(body.file)).path
      }
      // The custom text is saved as `<template directory>/<name>.md`.
      if (typeof body.customName === 'string' || typeof body.customContent === 'string') {
        const name = typeof body.customName === 'string' ? body.customName.trim() : global.customName
        const content = typeof body.customContent === 'string' ? body.customContent : await customGlobalText(global)
        global = await saveCustomGlobal(store, global, name, content, body.overwrite === true)
      }
      if (typeof body.enabled === 'boolean') global.enabled = body.enabled
      // Turning it on requires a usable prompt; other edits may be saved incomplete.
      if (body.enabled === true) {
        const read = await readGlobalContent(global)
        if (read.error) throw new Error(read.error)
      }
      await writeStore({ ...store, global })
      return describeState()
    }),
    route('settings', 'POST', async (body) => {
      const store = await readStore()
      if (typeof body.pinTop === 'boolean') store.pinTop = body.pinTop
      await writeStore(store)
      return describeState()
    }),
    // ── WebDAV sync (the password is write-only: it is never sent back).
    route('webdav', {
      GET: async () => {
        const store = await readStore()
        return { hostProtocol: HOST_PROTOCOL, directory: store.directory, webdav: publicWebdav(store.webdav) }
      },
      POST: async (body) => {
        const store = await readStore()
        const webdav = mergeWebdav(store.webdav, body)
        if (webdav.url !== '') parseDavUrl(webdav.url)
        parseProxyAddress(webdav.proxyAddress)
        await writeStore({ ...store, webdav })
        return { hostProtocol: HOST_PROTOCOL, directory: store.directory, webdav: publicWebdav(webdav) }
      },
    }),
    // Test the settings currently in the form (saved password when the field is left empty).
    route('webdav/test', 'POST', async (body) => {
      const store = await readStore()
      return testWebdav(mergeWebdav(store.webdav, body))
    }),
    route('webdav/remote-list', 'POST', async () => remoteForPull(await readStore())),
    route('webdav/local-list', 'POST', async () => localForPush(await readStore())),
    route('webdav/pull', 'POST', async (body) => pullFiles(await readStore(), body.files, body.overwrite)),
    route('webdav/push', 'POST', async (body) => pushFiles(await readStore(), body.files, body.overwrite)),
    // Environment-variable file: compare both sides, then push / pull / merge.
    route('webdav/env-compare', 'POST', async () => compareEnv(await readStore())),
    route('webdav/env-sync', 'POST', async (body) => syncEnv(await readStore(), body.mode, body.choices)),
    // Environment variables used as {{env:NAME}} in prompts.
    route('env', {
      GET: () => describeEnv(),
      POST: (body) => saveEnv(body),
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
    // One rejected route (a changed webServer contract) must not take the others down.
    const disposers = []
    for (const r of routes) {
      try {
        const dispose = ctx.webServer.register(r)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        logger?.warn?.('route %s not registered: %s', r.path, error instanceof Error ? error.message : String(error))
      }
    }
    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* already gone */ }
      }
    }
  }, 'dsh-prompt-switcher: routes')
}
