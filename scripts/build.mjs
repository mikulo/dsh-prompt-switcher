#!/usr/bin/env node
/**
 * Build: src/*.js → lib/*.js (the published artifacts).
 *
 * The plugin is dependency-free ESM, so the build is a validating stamp:
 * 1. substitute the package version for `__PLUGIN_VERSION__`;
 * 2. prepend a "generated" banner (the Host half keeps its ESM form, the Client
 *    half stays a single `window.__ModuleLoader__.load(...)` artifact);
 * 3. check that the Host/Client route-protocol constants agree and that the
 *    Client module id equals the package name (the Web module table keys
 *    browser plugins by package name);
 * 4. syntax-check both outputs with `node --check`.
 *
 * Usage: node scripts/build.mjs          write lib/
 *        node scripts/build.mjs --check  fail when lib/ is stale (CI / pre-commit)
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const checkOnly = process.argv.includes('--check')

const FILES = ['index.js', 'client.js']
const banner = (file) => `/*! ${pkg.name} v${pkg.version} | ${pkg.license} | generated from src/${file} by scripts/build.mjs — edit src/, not lib/ */\n`

function fail(message) {
  console.error(`build: ${message}`)
  process.exit(1)
}

const outputs = new Map()
for (const file of FILES) {
  const source = await readFile(join(root, 'src', file), 'utf8')
  if (!source.includes('__PLUGIN_VERSION__')) fail(`src/${file} has no __PLUGIN_VERSION__ token`)
  outputs.set(file, banner(file) + source.replaceAll('__PLUGIN_VERSION__', pkg.version))
}

const hostProtocol = /export const HOST_PROTOCOL = (\d+)/.exec(outputs.get('index.js'))?.[1]
const clientProtocol = /const HOST_PROTOCOL = (\d+)/.exec(outputs.get('client.js'))?.[1]
if (!hostProtocol || hostProtocol !== clientProtocol) fail(`HOST_PROTOCOL mismatch: host ${hostProtocol}, client ${clientProtocol}`)
const moduleId = /__ModuleLoader__\.load\(\{\s*id: '([^']+)'/.exec(outputs.get('client.js'))?.[1]
if (moduleId !== pkg.name) fail(`client module id "${moduleId}" must equal package name "${pkg.name}"`)

await mkdir(join(root, 'lib'), { recursive: true })
let stale = false
for (const [file, text] of outputs) {
  const target = join(root, 'lib', file)
  let current
  try {
    current = await readFile(target, 'utf8')
  } catch {
    current = undefined
  }
  if (checkOnly) {
    if (current !== text) {
      stale = true
      console.error(`build: lib/${file} is stale — run \`npm run build\``)
    }
    continue
  }
  if (current !== text) await writeFile(target, text, 'utf8')
  execFileSync(process.execPath, ['--check', target], { stdio: 'inherit' })
  console.log(`build: lib/${file} (${Buffer.byteLength(text)} bytes)`)
}
if (stale) process.exit(1)
if (checkOnly) console.log('build: lib/ is up to date')
