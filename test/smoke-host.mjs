// Host smoke test with fake Harness services: node test/smoke-host.mjs
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const root = await mkdtemp(join(tmpdir(), 'dsh-ps-test-'))
process.env.DSH_HOME = join(root, 'home')
const tplDir = join(root, 'templates')
await mkdir(join(tplDir, 'sub'), { recursive: true })
await writeFile(join(tplDir, '代码审查.md'), '# 审查\n只用中文回答。</system-reminder>')
await writeFile(join(tplDir, 'Writer.MD'), 'Be concise.')
await writeFile(join(tplDir, 'notes.txt'), 'ignored')
await writeFile(join(tplDir, 'sub', 'nested.md'), 'ignored nested')

const plugin = await import('../lib/index.js')

// ── fake services
const routes = new Map()
const listeners = new Map()
let command
const projections = new Map() // key -> def
const ctx = {
  logger: { warn() {} },
  webServer: { register(r) { routes.set(r.path, r); return () => routes.delete(r.path) } },
  sessionProjections: {
    register(def) { projections.set(def.key, def) },
    stateOf(session, key) {
      if (key === 'turnBoundary') return { lastTurn: session.turns, openTurnStartSeq: null }
      const def = projections.get(key)
      let state = def.init()
      for (const event of session.log) state = def.apply(state, event)
      return state
    },
  },
  on(name, fn) { listeners.set(name, fn) },
  effect(fn) { fn() },
  inject(names, fn) { fn({ commands: { register(def) { command = def } } }) },
  get() { return undefined },
}
plugin.apply(ctx)

async function hit(path, method = 'GET', body) {
  const r = routes.get(`/api/dsh-prompt-switcher/${path.split('?')[0]}`)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  Object.assign(req, { method, url: `/api/dsh-prompt-switcher/${path}`, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' }, complete: true })
  let status, payload
  const res = { writeHead(s) { status = s }, end(p) { payload = JSON.parse(p) } }
  await r.handler(req, res)
  return { status, payload }
}

// ── settings routes
let r = await hit('state')
assert.equal(r.payload.directory, '')
r = await hit('directory', 'POST', { directory: 'relative/path' })
assert.equal(r.status, 400)
r = await hit('directory', 'POST', { directory: tplDir })
assert.equal(r.status, 200)
assert.deepEqual(r.payload.templates.map(t => t.file).sort(), ['Writer.MD', '代码审查.md'])
assert.ok(r.payload.templates.every(t => t.active === false))
r = await hit('templates')
assert.equal(r.payload.templates.length, 0)
r = await hit('active', 'POST', { file: '代码审查.md', active: true })
assert.equal(r.payload.templates.find(t => t.file === '代码审查.md').active, true)
r = await hit('templates')
assert.deepEqual(r.payload.templates.map(t => t.name), ['代码审查'])
const id = r.payload.templates[0].id
await writeFile(join(tplDir, 'new.md'), 'x')
r = await hit('refresh', 'POST', {})
assert.equal(r.payload.templates.length, 3)
// forbidden from non-loopback
{
  const route = routes.get('/api/dsh-prompt-switcher/state')
  let status
  await route.handler({ method: 'GET', headers: { host: 'example.com' }, socket: { remoteAddress: '192.0.2.1' } }, { writeHead(s) { status = s }, end() {} })
  assert.equal(status, 403)
}

// ── pin setting (default on) survives directory changes
r = await hit('state')
assert.equal(r.payload.pinTop, true)
r = await hit('settings', 'POST', { pinTop: false })
assert.equal(r.payload.pinTop, false)
r = await hit('directory', 'POST', { directory: tplDir })
assert.equal(r.payload.pinTop, false)
assert.equal((await hit('templates')).payload.pinTop, false)
await hit('settings', 'POST', { pinTop: true })

// ── editor: read / meta / save / conflict / BOM + CRLF preserved / no traversal
await writeFile(join(tplDir, 'crlf.md'), '\uFEFFline1\r\nline2\r\n')
r = await hit(`file?file=${encodeURIComponent('crlf.md')}`)
assert.equal(r.status, 200)
assert.equal(r.payload.content, 'line1\nline2\n')
assert.equal(r.payload.bom, true)
const base = r.payload.mtime
r = await hit(`file?file=${encodeURIComponent('crlf.md')}&meta=1`)
assert.equal(r.payload.mtime, base)
assert.equal(r.payload.content, undefined)
await new Promise(res => setTimeout(res, 30))
r = await hit('file', 'POST', { file: 'crlf.md', content: 'a\nb\n', baseMtime: base })
assert.equal(r.status, 200)
const { readFile: rf, utimes } = await import('node:fs/promises')
assert.equal(await rf(join(tplDir, 'crlf.md'), 'utf8'), '\uFEFFa\r\nb\r\n')
// external change → stale save refused with 409, forced save wins
await utimes(join(tplDir, 'crlf.md'), new Date(), new Date(Date.now() + 5000))
r = await hit('file', 'POST', { file: 'crlf.md', content: 'mine', baseMtime: r.payload.mtime })
assert.equal(r.status, 409)
assert.equal(typeof r.payload.mtime, 'number')
r = await hit('file', 'POST', { file: 'crlf.md', content: 'mine', baseMtime: 1, force: true })
assert.equal(r.status, 200)
for (const bad of ['../outside.md', 'sub/nested.md', 'notes.txt', '']) {
  r = await hit('file', 'POST', { file: bad, content: 'x', force: true })
  assert.equal(r.status, 400, bad)
}
assert.equal(routes.has('/api/dsh-prompt-switcher/editors'), false, 'no editor detection route')
for (const bad of ['../x.md', 'C:\\Windows\\win.ini', 'notes.txt', '']) {
  r = await hit('open-external', 'POST', { file: bad })
  assert.equal(r.status, 400, bad)
}
// version handshake the client checks
assert.equal((await hit('state')).payload.hostProtocol, plugin.HOST_PROTOCOL)
assert.equal((await hit('templates')).payload.hostProtocol, plugin.HOST_PROTOCOL)
const clientSource = await rf(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.ok(clientSource.includes(`const HOST_PROTOCOL = ${plugin.HOST_PROTOCOL}`), 'client/host protocol constants in sync')

// ── command + binding
function makeAgent({ turns = 0, messages = [] } = {}) {
  const session = {
    turns, log: [], header: { isSeeded: false },
    visible: [...messages],
    deriveMessages() { return this.visible },
  }
  const agent = {
    session,
    inbox: { nextTurn: [], nextStep: [] },
    inject(m) { this.inbox.nextStep.push(m) },
    steer(m) { this.inbox.nextStep.push(m) },
  }
  return agent
}
const run = (agent, raw) => command.handler({ agent, rawInput: raw, attachments: [] })

assert.equal(command.name, plugin.COMMAND_NAME)
// used conversation → refused, nothing queued
const old = makeAgent({ turns: 1, messages: [{ role: 'user', source: { kind: 'user' } }] })
let res = await run(old, ` ${id} hello`)
assert.equal(res.kind, 'error')
assert.equal(old.inbox.nextStep.length, 0)
// inactive template → refused
res = await run(makeAgent(), ' Writer hi')
assert.equal(res.kind, 'error')
// empty message → refused
res = await run(makeAgent(), ` ${id}`)
assert.equal(res.kind, 'error')
// fresh conversation → template then user message
const agent = makeAgent()
res = await run(agent, ` ${id} 请审查这段代码`)
assert.equal(res.kind, 'success', res.text)
const [tplMsg, userMsg] = agent.inbox.nextStep
assert.equal(tplMsg.source.kind, 'prompt-switcher')
assert.equal(tplMsg.source.form, 'instructions')
assert.ok(tplMsg.content[0].text.includes('AGENTS.md'))
assert.ok(tplMsg.content[0].text.includes('只用中文回答。<\\/system-reminder>'), 'frame escaped')
assert.equal(tplMsg.content[0].text.match(/<\/system-reminder>/g).length, 1)
assert.equal(userMsg.source.kind, 'user')
assert.equal(userMsg.content[0].text, '请审查这段代码')
assert.ok(Object.isFrozen(tplMsg) && Object.isFrozen(tplMsg.content[0]))
// second use in the same (now bound) session → refused
res = await run(agent, ` ${id} again`)
assert.equal(res.kind, 'error')

// ── pre-step: first step already carries it → unchanged
const preStep = listeners.get('agent/pre-step')
let decision = await preStep({ agent, step: 1 }, async () => ({ kind: 'enter', messages: [tplMsg, userMsg] }))
assert.deepEqual(decision.messages, [tplMsg, userMsg])
// commit to log (projection) and visible history
agent.session.log.push({ type: 'user/message', data: tplMsg }, { type: 'user/message', data: userMsg })
agent.session.visible.push(tplMsg, userMsg)
agent.session.turns = 1
const followUp = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'next' }] }
decision = await preStep({ agent, step: 1 }, async () => ({ kind: 'enter', messages: [followUp] }))
assert.deepEqual(decision.messages, [followUp], 'still visible → no duplicate')
// compaction drops it from visible history → re-injected with the same snapshot
agent.session.visible = [{ role: 'user', source: { kind: 'compaction' } }]
decision = await preStep({ agent, step: 1 }, async () => ({ kind: 'enter', messages: [followUp] }))
assert.equal(decision.messages.length, 2)
assert.equal(decision.messages[0].source.kind, 'prompt-switcher')
assert.equal(decision.messages[0].content[0].text, tplMsg.content[0].text)
// unbound sessions are never touched
const other = makeAgent({ turns: 2, messages: [followUp] })
decision = await preStep({ agent: other, step: 1 }, async () => ({ kind: 'enter', messages: [followUp] }))
assert.deepEqual(decision.messages, [followUp])
// rejected steps pass through
decision = await preStep({ agent, step: 2 }, async () => ({ kind: 'reject' }))
assert.equal(decision.kind, 'reject')
// fail-open: an unexpected decision / session shape (future DSH) passes through untouched
for (const odd of [undefined, { kind: 'enter' }, { kind: 'enter', messages: 'x' }]) {
  assert.equal(await preStep({ agent, step: 1 }, async () => odd), odd)
}
const brokenAgent = { session: { get header() { throw new Error('changed contract') }, deriveMessages() { throw new Error('x') } } }
const passed = { kind: 'enter', messages: [followUp] }
assert.equal(await preStep({ agent: brokenAgent, step: 1, turn: 1 }, async () => passed), passed)

// ── global prompt: settings
r = await hit('state')
assert.deepEqual(
  { enabled: r.payload.global.enabled, source: r.payload.global.source, effective: r.payload.global.effective },
  { enabled: false, source: 'file', effective: false },
)
r = await hit('global', 'POST', { enabled: true })
assert.equal(r.status, 400, 'cannot enable without a file')
r = await hit('global', 'POST', { file: '../x.md' })
assert.equal(r.status, 400, 'only listed files')
r = await hit('global', 'POST', { file: 'Writer.MD' })
assert.equal(r.payload.global.name, 'Writer')
assert.equal(r.payload.global.inDirectory, true)
assert.equal(r.payload.global.enabled, false)
r = await hit('global', 'POST', { enabled: true })
assert.equal(r.status, 200)
assert.equal(r.payload.global.effective, true)
assert.deepEqual((await hit('templates')).payload.global, { effective: true, name: 'Writer' })

// ── global prompt: every new conversation binds it
const gMsgOf = (messages) => messages.filter(m => m.source?.kind === plugin.GLOBAL_SOURCE_KIND)
const plain = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }
const fresh = makeAgent()
decision = await preStep({ agent: fresh, step: 1, turn: 1 }, async () => ({ kind: 'enter', messages: [plain] }))
assert.equal(decision.messages.length, 2)
const gMsg = decision.messages[0]
assert.equal(gMsg.source.kind, plugin.GLOBAL_SOURCE_KIND)
assert.equal(gMsg.source.prompt, 'Writer')
assert.ok(gMsg.content[0].text.includes('global prompt "Writer"'))
assert.ok(gMsg.content[0].text.includes('Be concise.'))
assert.equal(decision.messages[1], plain)
// committed → projection keeps it; later steps do not duplicate it
fresh.session.log.push({ type: 'user/message', data: gMsg }, { type: 'user/message', data: plain })
fresh.session.visible.push(gMsg, plain, { role: 'assistant', content: [] })
fresh.session.turns = 1
decision = await preStep({ agent: fresh, step: 2, turn: 1 }, async () => ({ kind: 'enter', messages: [] }))
assert.equal(gMsgOf(decision.messages).length, 0)
decision = await preStep({ agent: fresh, step: 1, turn: 2 }, async () => ({ kind: 'enter', messages: [followUp] }))
assert.deepEqual(decision.messages, [followUp])
// compaction → the same snapshot comes back, even if the setting changed meanwhile
await hit('global', 'POST', { enabled: false })
fresh.session.visible = [{ role: 'user', source: { kind: 'compaction' } }]
decision = await preStep({ agent: fresh, step: 1, turn: 3 }, async () => ({ kind: 'enter', messages: [followUp] }))
assert.equal(decision.messages[0].content[0].text, gMsg.content[0].text)
await hit('global', 'POST', { enabled: true })
// conversations that already started, and subagents, are never touched
const started = makeAgent({ turns: 3, messages: [followUp, { role: 'assistant', content: [] }] })
decision = await preStep({ agent: started, step: 1, turn: 4 }, async () => ({ kind: 'enter', messages: [followUp] }))
assert.deepEqual(decision.messages, [followUp])
const compactedOld = makeAgent({ turns: 5, messages: [{ role: 'user', source: { kind: 'compaction' } }] })
decision = await preStep({ agent: compactedOld, step: 1, turn: 6 }, async () => ({ kind: 'enter', messages: [followUp] }))
assert.deepEqual(decision.messages, [followUp])
const sub = makeAgent()
sub.session.header.delegationDepth = 1
decision = await preStep({ agent: sub, step: 1, turn: 1 }, async () => ({ kind: 'enter', messages: [plain] }))
assert.deepEqual(decision.messages, [plain])

// ── global prompt + `/` template: the template is appended after the global prompt
const both = makeAgent()
res = await run(both, ` ${id} 请审查`)
assert.equal(res.kind, 'success', res.text)
assert.ok(res.text.includes('Writer') && res.text.includes('代码审查'))
const [bGlobal, bTpl, bUser] = both.inbox.nextStep
assert.equal(bGlobal.source.kind, plugin.GLOBAL_SOURCE_KIND)
assert.equal(bTpl.source.kind, plugin.SOURCE_KIND)
assert.ok(bTpl.content[0].text.includes('appended after the global prompt "Writer"'))
assert.equal(bUser.source.kind, 'user')
decision = await preStep({ agent: both, step: 1, turn: 1 }, async () => ({ kind: 'enter', messages: [bGlobal, bTpl, bUser] }))
assert.deepEqual(decision.messages, [bGlobal, bTpl, bUser], 'no duplicate global prompt')
both.session.log.push(...[bGlobal, bTpl, bUser].map(data => ({ type: 'user/message', data })))
both.session.turns = 1
both.session.visible = [{ role: 'user', source: { kind: 'compaction' } }]
decision = await preStep({ agent: both, step: 1, turn: 2 }, async () => ({ kind: 'enter', messages: [followUp] }))
assert.deepEqual(decision.messages.map(m => m.source.kind), [plugin.GLOBAL_SOURCE_KIND, plugin.SOURCE_KIND, 'user'])

// ── custom global prompt with a user-chosen name
r = await hit('global', 'POST', { source: 'custom' })
assert.equal(r.payload.global.effective, false)
assert.ok(r.payload.global.error)
r = await hit('global', 'POST', { customName: '   ', customContent: 'x', enabled: true })
assert.equal(r.status, 400, 'name required')
r = await hit('global', 'POST', { customName: '我的全局', customContent: '始终使用中文。\r\n', enabled: true })
assert.equal(r.status, 200)
assert.equal(r.payload.global.name, '我的全局')
assert.equal(r.payload.global.customContent, '始终使用中文。\n')
// saved into the template directory as <name>.md
assert.equal(await rf(join(tplDir, '我的全局.md'), 'utf8'), '始终使用中文。\n')
assert.equal(r.payload.global.customFile, join(tplDir, '我的全局.md'))
assert.ok(r.payload.templates.some(t => t.file === '我的全局.md'), 'appears in the template list')
// re-saving its own file needs no confirmation
r = await hit('global', 'POST', { customName: '我的全局', customContent: '始终使用中文。\n请简洁。' })
assert.equal(r.status, 200)
assert.equal(await rf(join(tplDir, '我的全局.md'), 'utf8'), '始终使用中文。\n请简洁。')
// another file of that name → 409 until overwrite is confirmed
await writeFile(join(tplDir, 'other.md'), 'keep me')
r = await hit('global', 'POST', { customName: 'other', customContent: 'W2' })
assert.equal(r.status, 409)
assert.deepEqual([r.payload.conflict, r.payload.file], ['file-exists', 'other.md'])
assert.equal(await rf(join(tplDir, 'other.md'), 'utf8'), 'keep me', 'untouched')
r = await hit('global', 'POST', { customName: 'other', customContent: 'W2', overwrite: true })
assert.equal(r.status, 200)
assert.equal(await rf(join(tplDir, 'other.md'), 'utf8'), 'W2')
for (const bad of ['a/b', 'x:y', 'CON', 'end.']) {
  r = await hit('global', 'POST', { customName: bad, customContent: 'x' })
  assert.equal(r.status, 400, bad)
}
// renamed back: 我的全局.md is no longer this prompt's file, so it needs confirmation too
r = await hit('global', 'POST', { customName: '我的全局', customContent: '始终使用中文。\n' })
assert.equal(r.status, 409)
r = await hit('global', 'POST', { customName: '我的全局', customContent: '始终使用中文。\n', overwrite: true })
assert.equal(r.payload.global.name, '我的全局')
// external edits of the file show up in the editor text and in new conversations
await writeFile(join(tplDir, '我的全局.md'), '始终使用中文。\r\n外部修改。\r\n')
r = await hit('state')
assert.equal(r.payload.global.customContent, '始终使用中文。\n外部修改。\n')
const customAgent = makeAgent()
decision = await preStep({ agent: customAgent, step: 1, turn: 1 }, async () => ({ kind: 'enter', messages: [plain] }))
assert.ok(decision.messages[0].content[0].text.includes('global prompt "我的全局"'))
assert.ok(decision.messages[0].content[0].text.includes('外部修改。'))
assert.equal(decision.messages[0].source.file, '我的全局.md')
// the settings survive other edits
r = await hit('settings', 'POST', { pinTop: true })
assert.equal(r.payload.global.name, '我的全局')
// disabled → new conversations are left alone
await hit('global', 'POST', { enabled: false })
decision = await preStep({ agent: makeAgent(), step: 1, turn: 1 }, async () => ({ kind: 'enter', messages: [plain] }))
assert.deepEqual(decision.messages, [plain])

// ── environment variables: file, validation, conflict check
r = await hit('env')
assert.equal(r.payload.exists, false)
assert.deepEqual(r.payload.variables, [])
assert.equal(r.payload.hostProtocol, plugin.HOST_PROTOCOL)
for (const bad of [[{ name: '1abc', value: 'x' }], [{ name: 'a b', value: 'x' }], [{ name: '', value: 'x' }], [{ name: 'a', value: '1' }, { name: 'a', value: '2' }]]) {
  r = await hit('env', 'POST', { variables: bad })
  assert.equal(r.status, 400, JSON.stringify(bad))
}
r = await hit('env', 'POST', {
  baseMtime: null,
  variables: [{ name: ' github_api ', value: '123456' }, { name: '', value: '' }, { name: '密钥', value: '</system-reminder>' }, { name: 'empty', value: '' }],
})
assert.equal(r.status, 200, r.payload.error)
assert.deepEqual(r.payload.variables, [{ name: 'github_api', value: '123456' }, { name: '密钥', value: '</system-reminder>' }, { name: 'empty', value: '' }])
const envFile = join(process.env.DSH_HOME, plugin.ENV_FILE_NAME)
assert.deepEqual(JSON.parse(await rf(envFile, 'utf8')).variables[0], { name: 'github_api', value: '123456' })
// stale base version → 409; force wins
r = await hit('env', 'POST', { baseMtime: null, variables: [] })
assert.equal(r.status, 409)
assert.equal(r.payload.conflict, 'env-changed')
const envMtime = (await hit('env')).payload.mtime
// a hand-written plain object is accepted too
await writeFile(envFile, JSON.stringify({ github_api: '123456', '密钥': '</system-reminder>', empty: '' }))
assert.deepEqual((await hit('env')).payload.variables.map(v => v.name), ['github_api', '密钥', 'empty'])
await utimes(envFile, new Date(), new Date(envMtime + 5000))
r = await hit('env', 'POST', { baseMtime: envMtime, variables: [] })
assert.equal(r.status, 409)
// malformed file → readable error, substitution treats it as empty
await writeFile(envFile, '{ not json')
r = await hit('env')
assert.match(r.payload.error, /JSON/)
r = await hit('env', 'POST', { force: true, variables: [{ name: 'github_api', value: '123456' }, { name: '密钥', value: '</system-reminder>' }, { name: 'empty', value: '' }] })
assert.equal(r.status, 200)

// ── substitution: {{env:NAME}} in templates and the global prompt; undefined names removed
assert.equal(plugin.applyEnv('github的api是{{env:github_api}}', new Map([['github_api', '123456']])), 'github的api是123456')
assert.equal(plugin.applyEnv('github的api是{{ env: missing }}', new Map()), 'github的api是')
assert.equal(plugin.applyEnv('{{github_api}} <github_api> {{env:}}', new Map([['github_api', 'x']])), '{{github_api}} <github_api> {{env:}}', 'other syntaxes untouched')
await writeFile(join(tplDir, 'envtpl.md'), 'github的api是{{env:github_api}}；未定义：[{{env:nope}}]；空：[{{env:empty}}]；{{env:密钥}}')
await hit('active', 'POST', { file: 'envtpl.md', active: true })
const envTplId = (await hit('templates')).payload.templates.find(t => t.file === 'envtpl.md').id
const envAgent = makeAgent()
res = await run(envAgent, ` ${envTplId} hi`)
assert.equal(res.kind, 'success', res.text)
const envText = envAgent.inbox.nextStep.find(m => m.source.kind === plugin.SOURCE_KIND).content[0].text
assert.ok(envText.includes('github的api是123456；未定义：[]；空：[]；'), envText)
assert.ok(envText.includes('<\\/system-reminder>'), 'values cannot close the frame')
assert.equal(envText.match(/<\/system-reminder>/g).length, 1)
// global prompt
await writeFile(join(tplDir, 'envglobal.md'), 'token={{env:github_api}} gone={{env:gone}}.')
await hit('global', 'POST', { source: 'file', file: 'envglobal.md', enabled: true })
decision = await preStep({ agent: makeAgent(), step: 1, turn: 1 }, async () => ({ kind: 'enter', messages: [plain] }))
assert.ok(decision.messages[0].content[0].text.includes('token=123456 gone=.'))
await hit('global', 'POST', { enabled: false })

// ── delete conversation (opt-in; fake persistence, registries and a live agent)
{
  const { existsSync } = await import('node:fs')
  const sessionsRoot = join(root, 'sessions')
  const project = join(sessionsRoot, '--D-work--')
  const headers = {
    'session-a': { id: 'session-a', cwd: 'D:\\work', delegationDepth: 0 },
    'session-sub': { id: 'session-sub', cwd: 'D:\\work', origin: 'subagent', parentSession: 'session-a', delegationDepth: 1 },
    'session-subsub': { id: 'session-subsub', cwd: 'D:\\work', origin: 'subagent', parentSession: 'session-sub', delegationDepth: 2 },
    'session-fork': { id: 'session-fork', cwd: 'D:\\work', parentSession: 'session-a', isSeeded: true, delegationDepth: 0 },
    'session-other': { id: 'session-other', cwd: 'D:\\work', delegationDepth: 0 },
  }
  for (const id of Object.keys(headers)) {
    await mkdir(join(project, id), { recursive: true })
    await writeFile(join(project, id, 'session.jsonl.zstd'), 'x')
  }
  const persistence = {
    async list() { return Object.values(headers).filter(h => existsSync(join(project, h.id))).map(header => ({ header })) },
    locate(meta) { return { kind: 'jsonl', path: join(sessionsRoot, '--D-work--', plugin.encodeSessionSegment(meta.id), 'session.jsonl.zstd') } },
  }
  const liveAgents = new Map([['session-a', {}]])
  const workspaceCalls = []
  const workspaceRegistry = {
    archivedSessionIds: [],
    async archiveSession(id, options) { workspaceCalls.push(['archive', id, options]) },
    async unarchiveSession(id) { workspaceCalls.push(['unarchive', id]) },
    async unpinSession(id) { workspaceCalls.push(['unpin', id]) },
  }
  const cacheDeleted = []
  const services = {
    sessionPersistence: persistence,
    workspaceRegistry,
    agents: { get: id => liveAgents.get(id) },
    sessions: { get: id => liveAgents.get(id), list: () => [] },
    sessionProjectionCache: { table: { async delete(id) { cacheDeleted.push(id) } } },
  }
  // the live agent's lifecycle effect, the way dsh-agent-loop labels it
  const lifecycle = Object.assign(async () => { liveAgents.delete('session-a') }, {
    [Symbol.for('cordis.effect')]: { label: 'agentLoop.lifecycle(session-a)', children: [] },
  })
  const emitted = []
  const dctx = {
    ...ctx,
    get: name => services[name],
    emit: (name, ...args) => emitted.push([name, ...args]),
    registry: new Map([['runtime', { fibers: [{ _disposables: [() => {}, lifecycle] }] }]]),
  }
  routes.clear()
  plugin.apply(dctx)

  r = await hit('session-delete/settings')
  assert.deepEqual(r.payload, { hostProtocol: plugin.HOST_PROTOCOL, enabled: false }, 'off by default')
  r = await hit('session-delete', 'POST', { sessionId: 'session-a' })
  assert.equal(r.status, 403, 'refused while not allowed')
  assert.ok(existsSync(join(project, 'session-a')))
  r = await hit('session-delete/settings', 'POST', { enabled: true })
  assert.equal(r.payload.enabled, true)
  assert.equal(JSON.parse(await rf(join(process.env.DSH_HOME, 'dsh-prompt-switcher.json'), 'utf8')).allowDeleteSession, true)
  // other settings keep the switch
  await hit('settings', 'POST', { pinTop: true })
  assert.equal((await hit('session-delete/settings')).payload.enabled, true)

  r = await hit('session-delete', 'POST', { sessionId: 'nope' })
  assert.equal(r.status, 404)
  r = await hit('session-delete', 'POST', { sessionId: 'session-sub' })
  assert.equal(r.status, 400, 'subagent sessions go with their conversation')
  r = await hit('session-delete', 'POST', { sessionId: 'session-a' })
  assert.equal(r.status, 200, r.payload.error)
  assert.deepEqual(r.payload.deleted.sort(), ['session-a', 'session-sub', 'session-subsub'])
  assert.equal(r.payload.pendingRestart, false)
  for (const id of ['session-a', 'session-sub', 'session-subsub']) assert.equal(existsSync(join(project, id)), false, id)
  for (const id of ['session-fork', 'session-other']) assert.ok(existsSync(join(project, id)), `${id} kept`)
  assert.equal(liveAgents.has('session-a'), false, 'live agent unloaded')
  assert.deepEqual(workspaceCalls, [['archive', 'session-a', { stopActivity: true }], ['unpin', 'session-a'], ['unarchive', 'session-a']])
  assert.deepEqual(cacheDeleted.sort(), ['session-a', 'session-sub', 'session-subsub'])
  assert.deepEqual(emitted.map(e => e[1]).sort(), ['session-a', 'session-sub', 'session-subsub'])
  assert.ok(emitted.every(e => e[0] === 'api-session/removed'))

  // a located path that is not that session's own directory is never removed (checked before anything changes)
  persistence.locate = () => ({ path: join(project, 'session-fork', 'session.jsonl.zstd') })
  workspaceCalls.length = 0
  r = await hit('session-delete', 'POST', { sessionId: 'session-other' })
  assert.equal(r.status, 400)
  assert.deepEqual(workspaceCalls, [], 'not archived either')
  assert.ok(existsSync(join(project, 'session-fork')) && existsSync(join(project, 'session-other')))
  assert.equal(plugin.encodeSessionSegment('a/b~c'), 'a~002Fb~007Ec')

  // ── "删除所有已归档": every archived top-level conversation (+ subagents), dangling entries cleared
  persistence.locate = (meta) => ({ path: join(sessionsRoot, '--D-work--', plugin.encodeSessionSegment(meta.id), 'session.jsonl.zstd') })
  Object.assign(headers, {
    'session-b': { id: 'session-b', cwd: 'D:\\work', delegationDepth: 0 },
    'session-b-sub': { id: 'session-b-sub', cwd: 'D:\\work', origin: 'subagent', parentSession: 'session-b', delegationDepth: 1 },
    'session-c': { id: 'session-c', cwd: 'D:\\work', delegationDepth: 0 },
  })
  for (const id of ['session-b', 'session-b-sub', 'session-c']) {
    await mkdir(join(project, id), { recursive: true })
    await writeFile(join(project, id, 'session.jsonl.zstd'), 'x')
  }
  workspaceRegistry.archivedSessionIds = ['session-b', 'session-b-sub', 'session-c', 'session-gone']
  workspaceCalls.length = 0
  r = await hit('session-delete/archived')
  assert.deepEqual(r.payload, { count: 2 }, 'top-level archived conversations only')
  r = await hit('session-delete/archived', 'POST', {})
  assert.equal(r.status, 200, r.payload.error)
  assert.deepEqual(r.payload.deleted, ['session-b', 'session-c'])
  assert.deepEqual(r.payload.failed, [])
  for (const id of ['session-b', 'session-b-sub', 'session-c']) assert.equal(existsSync(join(project, id)), false, id)
  for (const id of ['session-fork', 'session-other']) assert.ok(existsSync(join(project, id)), `${id} kept`)
  assert.ok(!workspaceCalls.some(c => c[0] === 'archive'), 'already archived: not archived again')
  assert.ok(workspaceCalls.some(c => c[0] === 'unarchive' && c[1] === 'session-gone'), 'dangling entry cleared')
  // gated by the same switch
  await hit('session-delete/settings', 'POST', { enabled: false })
  assert.equal((await hit('session-delete/archived', 'POST', {})).status, 403)
  assert.equal((await hit('session-delete/archived')).status, 403)
}

// ── DSH_HOME resolves like DSH itself (dsh-home-paths): `~` expanded
{
  const { homedir } = await import('node:os')
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = '~/dsh-ps-home-probe'
  const probe = join(homedir(), 'dsh-ps-home-probe')
  try {
    await hit('session-delete/settings', 'POST', { enabled: true })
    const { existsSync } = await import('node:fs')
    assert.ok(existsSync(join(probe, 'dsh-prompt-switcher.json')), 'settings written under the expanded home')
  } finally {
    process.env.DSH_HOME = saved
    await rm(probe, { recursive: true, force: true })
  }
}

await rm(root, { recursive: true, force: true })
console.log('host smoke test: all assertions passed')
