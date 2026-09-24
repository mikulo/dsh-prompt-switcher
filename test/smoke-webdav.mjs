// WebDAV sync smoke test against a local fake WebDAV server, HTTP CONNECT proxy
// and SOCKS5 proxy: node test/smoke-webdav.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createTcpServer, connect } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const root = await mkdtemp(join(tmpdir(), 'dsh-ps-dav-'))
process.env.DSH_HOME = join(root, 'home')
const local = join(root, 'templates')
await mkdir(join(local, 'sub'), { recursive: true })
await writeFile(join(local, 'a.md'), 'local a')
await writeFile(join(local, '同名.md'), 'local same')
await writeFile(join(local, 'sub', 'nested.md'), 'ignored')

// ── fake WebDAV server: user "u" / password "p", files kept in memory
const DIR = '/dav/提示词/'
const files = new Map() // decoded path -> Buffer
const dirs = new Set(['/dav/'])
const davLog = []
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  davLog.push(`${req.method} ${path}`)
  if (req.headers.authorization !== 'Basic ' + Buffer.from('u:p').toString('base64')) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="dav"' })
    return res.end()
  }
  const dir = path.endsWith('/') ? path : path + '/'
  if (req.method === 'PROPFIND') {
    if (!dirs.has(dir)) { res.writeHead(404); return res.end() }
    const entry = (href, collection, size) => `<D:response><D:href>${encodeURI(href).replace(/&/g, '&amp;')}</D:href><D:propstat><D:prop>` +
      `<D:resourcetype>${collection ? '<D:collection/>' : ''}</D:resourcetype>` +
      (collection ? '' : `<D:getcontentlength>${size}</D:getcontentlength><D:getlastmodified>Tue, 01 Sep 2026 10:00:00 GMT</D:getlastmodified>`) +
      '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
    let xml = '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' + entry(dir, true)
    if (req.headers.depth === '1') {
      for (const d of dirs) if (d !== dir && d.startsWith(dir) && !d.slice(dir.length, -1).includes('/')) xml += entry(d, true)
      for (const [p, b] of files) if (p.startsWith(dir) && !p.slice(dir.length).includes('/')) xml += entry(p, false, b.length)
    }
    res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
    return res.end(xml + '</D:multistatus>')
  }
  if (req.method === 'MKCOL') { dirs.add(dir); res.writeHead(201); return res.end() }
  if (req.method === 'PUT') { const existed = files.has(path); files.set(path, body); res.writeHead(existed ? 204 : 201); return res.end() }
  if (req.method === 'GET') {
    if (!files.has(path)) { res.writeHead(404); return res.end() }
    res.writeHead(200); return res.end(files.get(path))
  }
  res.writeHead(405); res.end()
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const davPort = server.address().port

// ── fake HTTP CONNECT proxy
let httpProxyHits = 0
const httpProxy = createTcpServer((client) => {
  client.once('data', (head) => {
    const m = /^CONNECT ([^:]+):(\d+) HTTP/.exec(head.toString())
    if (!m) return client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    httpProxyHits++
    const upstream = connect(Number(m[2]), m[1], () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      client.pipe(upstream).pipe(client)
    })
    upstream.on('error', () => client.destroy())
  })
})
await new Promise(r => httpProxy.listen(0, '127.0.0.1', r))

// ── fake SOCKS5 proxy (no auth, domain + IPv4 addresses)
let socksHits = 0
const socksProxy = createTcpServer((client) => {
  let stage = 0
  let buf = Buffer.alloc(0)
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (stage === 0 && buf.length >= 3) {
      buf = buf.subarray(2 + buf[1])
      client.write(Buffer.from([5, 0]))
      stage = 1
    }
    if (stage === 1 && buf.length >= 7) {
      let host, off
      if (buf[3] === 1) { host = [...buf.subarray(4, 8)].join('.'); off = 8 } else { host = buf.subarray(5, 5 + buf[4]).toString(); off = 5 + buf[4] }
      const port = buf.readUInt16BE(off)
      client.removeListener('data', onData)
      socksHits++
      const upstream = connect(port, host === 'localhost' ? '127.0.0.1' : host, () => {
        client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
        client.pipe(upstream).pipe(client)
      })
      upstream.on('error', () => client.destroy())
    }
  }
  client.on('data', onData)
})
await new Promise(r => socksProxy.listen(0, '127.0.0.1', r))

// ── plugin with fake Harness services
const plugin = await import('../lib/index.js')
const routes = new Map()
plugin.apply({
  logger: { warn() {} },
  webServer: { register(r) { routes.set(r.path, r); return () => {} } },
  sessionProjections: { register() {}, stateOf() { return undefined } },
  on() {},
  effect(fn) { fn() },
  inject() {},
  get() { return undefined },
})
async function hit(path, body) {
  const r = routes.get(`/api/dsh-prompt-switcher/${path}`)
  assert.ok(r, `route ${path}`)
  const method = body === undefined ? 'GET' : 'POST'
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  Object.assign(req, { method, url: `/api/dsh-prompt-switcher/${path}`, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' }, complete: true })
  let status, payload
  await r.handler(req, { writeHead(s) { status = s }, end(p) { payload = JSON.parse(p) } })
  return { status, payload }
}

await hit('directory', { directory: local })
const url = `http://127.0.0.1:${davPort}${DIR}`

// ── settings: proxy off by default with the default address; password write-only
let r = await hit('webdav')
assert.equal(r.payload.webdav.proxyEnabled, false)
assert.equal(r.payload.webdav.proxyAddress, '127.0.0.1:7891')
assert.equal(r.payload.webdav.hasPassword, false)
r = await hit('webdav/test', { url: '' })
assert.equal(r.payload.ok, false)
r = await hit('webdav', { url: 'ftp://x/' })
assert.equal(r.status, 400)
r = await hit('webdav', { url, username: 'u', password: 'wrong' })
assert.equal(r.status, 200)
assert.equal(r.payload.webdav.password, undefined, 'password never returned')
assert.equal(r.payload.webdav.hasPassword, true)
r = await hit('webdav/test', {})
assert.equal(r.payload.ok, false)
assert.match(r.payload.message, /401/)
// the form's password is tested without saving it
r = await hit('webdav/test', { password: 'p' })
assert.equal(r.payload.ok, true)
assert.equal(r.payload.warning, true, 'directory missing yet')
assert.equal((await hit('webdav/test', {})).payload.ok, false, 'saved password still the wrong one')
r = await hit('webdav', { password: 'p' })
// an empty password field keeps the saved password
r = await hit('webdav', { password: '', username: 'u' })
assert.equal(r.payload.webdav.hasPassword, true)

// ── local → cloud: remote directory created on first push
r = await hit('webdav/local-list', {})
assert.equal(r.payload.remoteMissing, true)
const byName = (list) => Object.fromEntries(list.map(f => [f.name, f.conflict]))
assert.deepEqual(byName(r.payload.files), { 'a.md': false, '同名.md': false })
r = await hit('webdav/push', { files: ['a.md', '同名.md', '../x.md'] })
assert.deepEqual(r.payload.results.map(x => [x.name, x.status]), [['a.md', 'created'], ['同名.md', 'created'], ['../x.md', 'error']])
assert.ok(davLog.includes(`MKCOL ${DIR}`))
assert.equal(files.get(DIR + '同名.md').toString(), 'local same')
r = await hit('webdav/test', {})
assert.equal(r.payload.ok, true)
assert.equal(r.payload.warning, undefined)

// ── cloud → local with same-name confirmation
files.set(DIR + '同名.md', Buffer.from('cloud same'))
files.set(DIR + '云端 新.md', Buffer.from('cloud new'))
files.set(DIR + 'notes.txt', Buffer.from('ignored'))
dirs.add(DIR + 'sub/')
files.set(DIR + 'sub/deep.md', Buffer.from('ignored'))
r = await hit('webdav/remote-list', {})
assert.equal(r.status, 200, r.payload.error)
assert.deepEqual(byName(r.payload.files), { 'a.md': true, '同名.md': true, '云端 新.md': false })
const remoteA = r.payload.files.find(f => f.name === 'a.md')
assert.equal(remoteA.size, 7)
assert.equal(typeof remoteA.mtime, 'number')
r = await hit('webdav/pull', { files: ['a.md', '同名.md', '云端 新.md'], overwrite: ['同名.md'] })
assert.deepEqual(r.payload.results.map(x => [x.name, x.status]), [['a.md', 'skipped'], ['同名.md', 'overwritten'], ['云端 新.md', 'created']])
assert.equal(await readFile(join(local, 'a.md'), 'utf8'), 'local a')
assert.equal(await readFile(join(local, '同名.md'), 'utf8'), 'cloud same')
assert.equal(await readFile(join(local, '云端 新.md'), 'utf8'), 'cloud new')
// files not in the remote listing are refused
r = await hit('webdav/pull', { files: ['sub/deep.md', 'notes.txt'] })
assert.ok(r.payload.results.every(x => x.status === 'error'))

// ── push without overwrite skips same-name remote files; with overwrite replaces them
await writeFile(join(local, 'a.md'), 'local a v2')
r = await hit('webdav/push', { files: ['a.md'] })
assert.equal(r.payload.results[0].status, 'skipped')
assert.equal(files.get(DIR + 'a.md').toString(), 'local a')
r = await hit('webdav/push', { files: ['a.md'], overwrite: ['a.md'] })
assert.equal(r.payload.results[0].status, 'overwritten')
assert.equal(files.get(DIR + 'a.md').toString(), 'local a v2')

// ── proxies: the switch alone decides whether requests go through the proxy
const before = httpProxyHits
r = await hit('webdav/test', { proxyEnabled: true, proxyType: 'http', proxyAddress: `127.0.0.1:${httpProxy.address().port}` })
assert.equal(r.payload.ok, true, r.payload.message)
assert.match(r.payload.message, /HTTP 代理/)
assert.equal(httpProxyHits, before + 1)
r = await hit('webdav/test', { proxyEnabled: true, proxyType: 'socks5', proxyAddress: `127.0.0.1:${socksProxy.address().port}` })
assert.equal(r.payload.ok, true, r.payload.message)
assert.equal(socksHits, 1)
r = await hit('webdav/test', { proxyEnabled: false, proxyType: 'socks5', proxyAddress: `127.0.0.1:${socksProxy.address().port}` })
assert.equal(r.payload.ok, true)
assert.equal(socksHits, 1, 'proxy off → direct')
// saved proxy settings are used by sync
await hit('webdav', { proxyEnabled: true, proxyType: 'socks5', proxyAddress: `127.0.0.1:${socksProxy.address().port}` })
r = await hit('webdav/remote-list', {})
assert.equal(r.status, 200)
assert.ok(socksHits > 1)
// wrong proxy type / dead proxy → readable errors
r = await hit('webdav/test', { proxyEnabled: true, proxyType: 'socks5', proxyAddress: `127.0.0.1:${httpProxy.address().port}` })
assert.equal(r.payload.ok, false)
const dead = createTcpServer()
await new Promise(res => dead.listen(0, '127.0.0.1', res))
const deadPort = dead.address().port
await new Promise(res => dead.close(res))
r = await hit('webdav/test', { proxyEnabled: true, proxyType: 'http', proxyAddress: `127.0.0.1:${deadPort}` })
assert.equal(r.payload.ok, false)
assert.match(r.payload.message, /无法连接 HTTP 代理/)
r = await hit('webdav/test', { proxyEnabled: true, proxyAddress: 'not-an-address' })
assert.equal(r.payload.ok, false)
assert.match(r.payload.message, /主机:端口/)
r = await hit('webdav', { proxyAddress: '' })
assert.equal(r.payload.webdav.proxyAddress, '127.0.0.1:7891', 'empty address falls back to the default')

// ── clearing the password
r = await hit('webdav', { clearPassword: true })
assert.equal(r.payload.webdav.hasPassword, false)

server.close()
httpProxy.close()
socksProxy.close()
await rm(root, { recursive: true, force: true })
console.log('webdav smoke test: all assertions passed')
