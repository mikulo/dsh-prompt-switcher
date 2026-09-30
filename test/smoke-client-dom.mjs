// "删除所有已归档" row injected into the sidebar view-options menu, with a tiny fake DOM:
// node test/smoke-client-dom.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// ── minimal DOM: just what installDeleteArchivedRow touches
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.parentElement = null
    this.attrs = {}
    this.className = ''
    this.style = {}
    this.listeners = {}
    this._text = ''
    this.innerHTML = ''
  }
  get classList() { return this.className.split(/\s+/).filter(Boolean) }
  get textContent() { return this._text + this.children.map(c => c.textContent).join('') }
  set textContent(v) { this._text = v; this.children = [] }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return this.attrs[k] ?? null }
  appendChild(c) { c.parentElement = this; this.children.push(c); observers.forEach(o => o.notify(this, c)); return c }
  append(...cs) { cs.forEach(c => this.appendChild(c)) }
  remove() { const p = this.parentElement; if (p) p.children = p.children.filter(c => c !== this); this.parentElement = null }
  cloneNode() { const e = new El(this.tagName); e.className = this.className; e.attrs = { ...this.attrs }; return e }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  dispatchEvent(ev) { ev.target ??= this; for (let n = this; n; n = n.parentElement) for (const fn of n.listeners[ev.type] ?? []) fn(ev); return true }
  click() { this.dispatchEvent({ type: 'click', stopPropagation() {} }) }
  *all() { for (const c of this.children) { yield c; yield* c.all() } }
  querySelectorAll(sel) { return [...this.all()].filter(e => matches(e, sel)) }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null }
}
function matches(e, sel) {
  const m = /^(\w+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(sel)
  if (!m) throw new Error(`unsupported selector ${sel}`)
  if (m[1] && e.tagName !== m[1].toUpperCase()) return false
  if (m[2] && !(m[2] in e.attrs)) return false
  if (m[3] !== undefined && e.attrs[m[2]] !== m[3]) return false
  return true
}
const observers = []
globalThis.MutationObserver = class {
  constructor(cb) { this.cb = cb }
  observe(target) { this.target = target; observers.push(this) }
  disconnect() { observers.splice(observers.indexOf(this), 1) }
  notify(parent, node) { if (parent === this.target) this.cb([{ addedNodes: [node] }]) }
}
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
globalThis.KeyboardEvent = class { constructor(type, init) { Object.assign(this, { type }, init) } }
const body = new El('body')
const docListeners = {}
globalThis.document = {
  body,
  createElement: tag => new El(tag),
  querySelectorAll: sel => body.querySelectorAll(sel),
  addEventListener(type, fn) { docListeners[type] = fn },
  removeEventListener() {},
  dispatchEvent() { return true },
}

// ── load the client with fake React / primitives / Host
let loaded
globalThis.window = { __ModuleLoader__: { load(def) { loaded = def } } }
let hooks = []
let hi = 0
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState(init) { const i = hi++; if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init; return [hooks[i], v => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v }] },
  useEffect(fn) { hi++; fn() },
  useRef(v) { const i = hi++; if (!(i in hooks)) hooks[i] = { current: v }; return hooks[i] },
  useCallback(fn) { hi++; return fn },
  useMemo(fn) { hi++; return fn() },
  Fragment: 'fragment',
}
const primitives = { Button() {}, Input() {}, Switch() {}, Modal() {}, MenuItemButton() {} }
let archivedPosts = 0
globalThis.fetch = async (url, init) => {
  const path = String(url)
  let payload = {}
  if (path.endsWith('/session-delete/settings')) payload = { hostProtocol: 8, enabled: true }
  else if (path.endsWith('/session-delete/archived')) {
    if (init?.method === 'POST') { archivedPosts++; payload = { deleted: ['x', 'y'], failed: [{ sessionId: 'z', error: 'boom' }], pendingRestart: false } }
    else payload = { count: 3 }
  }
  return { ok: true, status: 200, json: async () => payload }
}
new Function(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))()
const plugin = loaded.factory(id => ({ react: React, '@deepseek-ai/dsh-client-ui-primitives': primitives })[id])
const slots = {}
const dict = {}
plugin.apply({
  effect(fn) { return fn() },
  locale: { register(ns, d) { dict[ns] = d.zh; return () => {} }, bind: ns => (key, vars) => (dict[ns][key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars?.[k]) },
  slots: { inject(_name, fn) { fn() }, register(opts, C) { slots[opts.name] = C; return () => {} } },
  inject() {},
})
await new Promise(r => setTimeout(r, 10)) // deletion switch loaded (enabled)

// ── DSH opens the view-options menu: a portaled list with three filter rows
function openMenu(className = 'bhn1Oq_viewOptionsMenu', labels = ['隐藏已归档', '全部对话（显示已归档）', '仅显示已归档']) {
  const list = new El('div')
  list.setAttribute('role', 'menu')
  list.className = `Menu_list ${className}`
  const viewport = new El('div')
  viewport.className = 'Menu_viewport'
  list.appendChild(viewport)
  const sep = new El('div'); sep.className = 'Menu_separator'; sep.setAttribute('role', 'separator'); viewport.appendChild(sep)
  for (const [label, selected] of labels.map((l, i) => [l, i === 0])) {
    const wrap = new El('div'); wrap.className = 'Menu_itemWrap'
    const b = new El('button'); b.setAttribute('role', 'menuitem'); b.className = `Menu_item${selected ? ' Menu_selected' : ''}`
    const icon = new El('span'); icon.className = 'Menu_itemIcon'
    const text = new El('span'); text.className = 'Menu_itemLabel'; text.textContent = label
    b.append(icon, text); wrap.appendChild(b); viewport.appendChild(wrap)
  }
  body.appendChild(list) // portal → direct child of <body>
  return { list, viewport }
}
let escapes = 0
const { list, viewport } = openMenu()
list.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') escapes++ })
await new Promise(r => setTimeout(r, 5))
const rows = viewport.querySelectorAll('button[role="menuitem"]')
assert.equal(rows.length, 4, 'one row added')
const row = rows[3]
assert.equal(row.textContent, '删除所有已归档')
assert.equal(row.className, 'Menu_item', 'native row classes, without the selected mark')
assert.ok(row.style.color.includes('error'), 'red')
assert.equal(viewport.children.at(-2).getAttribute('role'), 'separator', 'hairline before it')
assert.equal(viewport.children.at(-1).className, 'Menu_itemWrap')
// re-render of the same list does not duplicate it
viewport.appendChild(new El('div'))
assert.equal(viewport.querySelectorAll('button[role="menuitem"]').length, 4)
// other menus are left alone
const other = openMenu('xx_otherMenu', ['置顶对话', '重命名', '归档对话'])
await new Promise(r => setTimeout(r, 5))
assert.equal(other.viewport.querySelectorAll('button[role="menuitem"]').length, 3)
// a future build without the class is still recognised by its "隐藏已归档" row
const renamed = openMenu('zz_renamedClass')
await new Promise(r => setTimeout(r, 5))
assert.equal(renamed.viewport.querySelectorAll('button[role="menuitem"]').length, 4)

// ── click: menu closes (Escape, no unique trigger here) and the confirmation opens
const Overlay = slots['shell.overlay']
hooks = []; hi = 0
assert.equal(Overlay({}), null)
row.click()
assert.equal(escapes, 1, 'menu closed')
hooks = []; hi = 0
const confirm = Overlay({})
assert.ok(confirm)
hooks = []; hi = 0
confirm.type(confirm.props) // mount: fetch the count
await new Promise(r => setTimeout(r, 5))
hi = 0
let modal = confirm.type(confirm.props)
assert.equal(modal.type, primitives.Modal)
assert.equal(modal.props.title, '删除所有已归档对话')
assert.equal(modal.props.description, '是否删除所有已归档的对话，删除不可撤销')
assert.ok(modal.children.some(c => c?.children?.[0] === '共 3 个已归档对话（连同它们的子代理会话）将被彻底删除。'))
const [no, yes] = modal.props.footer.children
assert.equal(no.children[0], '否')
assert.equal(yes.children[0], '是')
assert.equal(yes.props.disabled, false)
await yes.props.onClick()
assert.equal(archivedPosts, 1)
hi = 0
modal = confirm.type(confirm.props)
assert.ok(JSON.stringify(modal.children).includes('已删除 2 个对话，1 个删除失败'), 'failures are listed')
assert.ok(JSON.stringify(modal.children).includes('z：boom'))
console.log('client DOM smoke test: all assertions passed')
