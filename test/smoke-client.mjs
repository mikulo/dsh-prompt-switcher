// Client smoke test with a fake module loader: node test/smoke-client.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

let loaded
globalThis.window = { __ModuleLoader__: { load(def) { loaded = def } } }
const React = { createElement: (type, props, ...children) => ({ type, props, children }), useState() {}, useEffect() {}, useRef() {}, useCallback() {}, useMemo() {} }
const primitives = { Button() {}, Input() {}, Switch() {}, rankByName: (items, q) => items.filter(i => i.name.includes(q)) }
new Function(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))()
assert.equal(loaded.id, '@mikulo/dsh-prompt-switcher')
const plugin = loaded.factory(id => ({ react: React, '@deepseek-ai/dsh-client-ui-primitives': primitives })[id])
assert.deepEqual(plugin.inject, ['slots', 'locale'])

// fetch mock for the host routes
const TEMPLATES = [{ id: 'tabc', name: '代码审查', file: '代码审查.md' }, { id: 'tdef', name: 'writer', file: 'writer.md' }]

let section, source, executed
let pinTop = false
let globalInfo = { effective: false, name: '' }
const TEMPLATES_RESPONSE = () => ({ pinTop, templates: TEMPLATES, global: globalInfo })
globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).endsWith('/templates') ? TEMPLATES_RESPONSE() : {}) })
const dict = {}
const registered = []
let commandResult = { kind: 'success' }
const commands = { async execute(sessionId, line, atts) { executed = { sessionId, line, atts }; return { ok: true, value: { result: commandResult } } } }
const ctx = {
  effect(fn) { return fn() },
  locale: { register(ns, d) { dict[ns] = d.zh; return () => {} }, bind: ns => (key, vars) => (dict[ns][key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars?.[k]) },
  slots: { inject(name, fn) { assert.equal(name, 'settings.section'); fn() }, register(opts, Page) { section = { opts, Page } } },
  // Regression: the root ctx must never be asked for `remote.commands` directly.
  get(name) { throw new Error(`cannot get property "${name}" without inject`) },
  inject(names, fn) {
    assert.deepEqual(names, ['inputTriggers', 'remote', 'remote.commands'])
    fn({
      effect: f => f(),
      remote: { commands },
      inputTriggers: { registerSource(s) { source = s; registered.push(s.order); return () => { registered.push('off') } } },
    })
  },
}
// Fake document for the `、` ≡ `/` alias (Chinese IME): records listeners and edit commands.
const domListeners = {}
const textNode = {}
const composerRoot = { isConnected: true, contains: node => node === textNode }
const composerTarget = { closest: sel => (sel === '[data-composer-input]' ? composerRoot : null) }
const outsideTarget = { closest: () => null }
let textBefore = ''
let execCalls = []
let modifyCalls = []
const domSelection = { rangeCount: 1, isCollapsed: true, getRangeAt: () => ({ startContainer: textNode, startOffset: 0 }), modify: (...args) => { modifyCalls.push(args) } }
globalThis.document = {
  addEventListener(type, fn, capture) { assert.equal(capture, true); domListeners[type] = fn },
  removeEventListener(type) { delete domListeners[type] },
  getSelection: () => domSelection,
  createRange: () => ({ selectNodeContents() {}, setEnd() {}, toString: () => textBefore }),
  execCommand(...args) { execCalls.push(args); return true },
}

plugin.apply(ctx)
assert.deepEqual(Object.keys(domListeners).sort(), ['beforeinput', 'compositionend'])
{
  const beforeInput = (over, before) => {
    textBefore = before
    execCalls = []
    const event = { target: composerTarget, inputType: 'insertText', data: '、', isComposing: false, prevented: false, stopped: false, ...over }
    event.preventDefault = () => { event.prevented = true }
    event.stopImmediatePropagation = () => { event.stopped = true }
    domListeners.beforeinput(event)
    return event
  }
  // direct commit at the start of the draft → replaced by `/`
  let ev = beforeInput({}, '')
  assert.ok(ev.prevented && ev.stopped)
  assert.deepEqual(execCalls, [['insertText', false, '/']])
  assert.ok(beforeInput({ data: '／' }, '  \n').prevented) // full-width slash, whitespace only before it
  // never rewritten: mid-text enumeration comma, real `/`, IME composing, other editors, other input types
  for (const [over, before] of [[{}, '苹果'], [{ data: '/' }, ''], [{ isComposing: true }, ''], [{ target: outsideTarget }, ''], [{ inputType: 'insertFromPaste' }, '']]) {
    ev = beforeInput(over, before)
    assert.ok(!ev.prevented && execCalls.length === 0)
  }

  // composition commit (Pinyin IME): rewritten after compositionend
  const compositionEnd = async (data, before) => {
    textBefore = before
    execCalls = []
    modifyCalls = []
    domListeners.compositionend({ target: composerTarget, data })
    await new Promise(r => setTimeout(r, 10))
  }
  await compositionEnd('、', '、')
  assert.deepEqual(modifyCalls, [['extend', 'backward', 'character']])
  assert.deepEqual(execCalls, [['insertText', false, '/']])
  await compositionEnd('、', '苹果、') // enumeration comma inside text stays
  assert.ok(modifyCalls.length === 0 && execCalls.length === 0)
  await compositionEnd('你好', '你好')
  assert.ok(modifyCalls.length === 0 && execCalls.length === 0)
}
// pinned by default, then the Host answer (pinTop:false) re-registers it below the built-ins
assert.equal(registered[0], -100)
await new Promise(r => setTimeout(r, 10))
assert.deepEqual(registered, [-100, 'off', 100])
assert.equal(source.order, 100)
assert.equal(section.opts.id, 'prompt-switcher')
assert.equal(section.opts.label(), '提示词模板')
assert.equal(typeof section.Page, 'function')

assert.equal(source.trigger, '/')
const session = { sessionId: 's1' }
const signal = new AbortController().signal
assert.deepEqual(await source.candidates(session, { query: '', position: 'inline', signal }), [])
const rows = await source.candidates(session, { query: '', position: 'leading', signal })
assert.deepEqual(rows.map(r => r.label), ['代码审查', 'writer'])
assert.deepEqual((await source.candidates(session, { query: '代码', position: 'leading', signal })).map(r => r.value), ['tabc'])

// Picking inserts plain text; no composer claim (a claim breaks IME input in
// DSH's composer), and no space-time claim either.
assert.deepEqual(source.onPick({ candidate: rows[0], session }), { text: '/代码审查 ' })
assert.equal(source.matchSpace, undefined)

// Enter adjudication claims the draft at send time.
const pick = await source.matchEnter(session, '/代码审查 你好 世界', signal, { attachments: 0 })
assert.equal(pick.claim.token, '/代码审查 ')
assert.equal(pick.claim.name, 'prompt-template')
assert.deepEqual(await pick.claim.submit('你好 世界', {}, []), { kind: 'success' })
assert.deepEqual(executed, { sessionId: 's1', line: '/prompt-template tabc 你好 世界', atts: [] })

assert.ok(await source.matchEnter(session, '/writer hello', signal, { attachments: 0 }))
assert.ok(await source.matchEnter(session, '/代码审查', signal, { attachments: 0 }))
assert.equal(await source.matchEnter(session, '/代码审查x hi', signal, { attachments: 0 }), undefined)
assert.equal(await source.matchEnter(session, '/plan', signal, { attachments: 0 }), undefined)
assert.equal(await source.matchEnter(session, 'hello', signal, { attachments: 0 }), undefined)

// an effective global prompt is mentioned on every template row
assert.equal(rows[0].description, '提示词模板 · 仅新对话首条消息生效')
globalInfo = { effective: true, name: '全局规范' }
await new Promise(r => setTimeout(r, 3100)) // menu cache TTL
const globalRows = await source.candidates(session, { query: '', position: 'leading', signal })
assert.equal(globalRows[0].description, '提示词模板 · 追加在全局提示词「全局规范」之后')

// host refusal surfaces as a composer error (draft kept)
commandResult = { kind: 'error', text: '只能在新对话中使用' }
assert.deepEqual(await pick.claim.submit('x', {}, []), { kind: 'error', text: '只能在新对话中使用' })
// an outdated Host half (route missing → 404/401) never breaks the menu
globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) })
await new Promise(r => setTimeout(r, 3100)) // menu cache TTL
assert.deepEqual(await source.candidates(session, { query: '', position: 'leading', signal }), [])
console.log('client smoke test: all assertions passed')
