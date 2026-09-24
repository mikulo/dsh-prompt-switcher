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
plugin.apply(ctx)
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

const pick = source.onPick({ candidate: rows[0], session })
assert.equal(pick.claim.token, '/代码审查 ')
assert.equal(pick.claim.name, 'prompt-template')
assert.deepEqual(await pick.claim.submit('你好 世界', {}, []), { kind: 'success' })
assert.deepEqual(executed, { sessionId: 's1', line: '/prompt-template tabc 你好 世界', atts: [] })

assert.ok(source.matchSpace(session, '/代码审查'))
assert.equal(source.matchSpace(session, '/plan'), undefined)
assert.ok(await source.matchEnter(session, '/writer hello', signal, { attachments: 0 }))
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
