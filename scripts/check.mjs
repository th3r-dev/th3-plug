#!/usr/bin/env node
/**
 * Validate every plug (or the ones named) before installing it.
 *
 *   node scripts/check.mjs            all plugs
 *   node scripts/check.mjs shell      one plug
 *
 * Checks the things the Harness plugin manager and Loader rely on: manifest
 * shape, exports and `files` that resolve, the patch row naming the package,
 * locale metadata, the icon, the Web module id, JavaScript/zsh syntax, and
 * template tokens left behind. Exits 1 on any error.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGS = join(ROOT, 'plugs')
const SCOPE = '@th3-plug'
const ICON_LIMIT = 256 * 1024

const wanted = process.argv.slice(2)
const names = wanted.length > 0
  ? wanted
  : readdirSync(PLUGS).filter(n => statSync(join(PLUGS, n)).isDirectory()).sort()

/** Files matching a `files`/`exports` pattern with at most one `*` per segment. */
function match(dir, pattern) {
  const clean = pattern.replace(/^\.\//, '')
  const parts = clean.split('/')
  let found = ['']
  for (const part of parts) {
    const next = []
    for (const base of found) {
      const here = join(dir, base)
      if (!part.includes('*')) {
        if (existsSync(join(here, part))) next.push(join(base, part))
        continue
      }
      if (!existsSync(here) || !statSync(here).isDirectory()) continue
      const re = new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
      for (const entry of readdirSync(here)) if (re.test(entry)) next.push(join(base, entry))
    }
    found = next
  }
  return found
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

let failures = 0
for (const name of names) {
  const dir = join(PLUGS, name)
  const errors = []
  const warnings = []
  const err = message => errors.push(message)
  const warn = message => warnings.push(message)

  if (!existsSync(join(dir, 'package.json'))) {
    console.log(`✖ ${name}: no package.json`)
    failures++
    continue
  }
  let pkg
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch (e) { err(`package.json: ${e.message}`) }

  if (pkg) {
    if (pkg.name !== `${SCOPE}/${name}`) err(`package name "${pkg.name}" should be "${SCOPE}/${name}"`)
    if (pkg.private !== true) warn('package.json should be "private": true')
    if (pkg.type !== 'module') err('package.json needs "type": "module"')
    const exp = pkg.exports ?? {}
    for (const key of ['.', './locale/*.json', './icon']) if (!(key in exp)) err(`exports is missing "${key}"`)
    for (const [key, target] of Object.entries(exp)) {
      if (typeof target !== 'string') continue
      if (match(dir, target).length === 0) err(`exports["${key}"] → ${target} matches no file`)
    }
    for (const pattern of pkg.files ?? []) if (match(dir, pattern).length === 0) err(`files entry "${pattern}" matches no file`)

    const patchPath = pkg.dsh?.bundle?.patch
    if (!patchPath) err('dsh.bundle.patch is missing')
    else if (!existsSync(join(dir, patchPath))) err(`dsh.bundle.patch ${patchPath} does not exist`)
    else {
      const patch = readFileSync(join(dir, patchPath), 'utf8')
      if (!/^\s*- insert:/m.test(patch)) err(`${patchPath} has no "- insert:" list`)
      const rowName = /name:\s*['"]?([^'"\s]+)['"]?/.exec(patch)?.[1]
      if (rowName !== pkg.name) err(`${patchPath} row name "${rowName}" should be "${pkg.name}"`)
      const id = /id:\s*([^\s#]+)/.exec(patch)?.[1]
      if (!id) err(`${patchPath} row has no id`)
      else if (!id.startsWith('th3-')) warn(`row id "${id}" does not start with th3-`)
    }

    const client = pkg.dsh?.client
    if (client) {
      if (client.platform !== 'web') err('dsh.client.platform should be "web"')
      const clientFile = exp['./client']
      if (!clientFile) err('dsh.client is declared but exports has no "./client"')
      else if (existsSync(join(dir, clientFile))) {
        const source = readFileSync(join(dir, clientFile), 'utf8')
        if (!source.includes('window.__ModuleLoader__.load(')) err(`${clientFile} does not call window.__ModuleLoader__.load`)
        const id = /id:\s*['"]([^'"]+)['"]/.exec(source)?.[1]
        if (id !== pkg.name) err(`${clientFile} module id "${id}" should be "${pkg.name}"`)
        if (/require\(['"]@deepseek-ai\/dsh-client-ui-/.test(source)) warn(`${clientFile} requires a Harness UI package; copy markup instead (docs/dsh-notes.md)`)
      }
    } else if (exp['./client']) warn('exports "./client" without dsh.client: the page will not load it')
  }

  for (const locale of ['en']) {
    const file = join(dir, 'locale', `${locale}.json`)
    if (!existsSync(file)) { err(`locale/${locale}.json is missing`); continue }
    try {
      const meta = JSON.parse(readFileSync(file, 'utf8')).meta
      if (!meta?.title) err(`locale/${locale}.json has no meta.title`)
      if (!meta?.description) err(`locale/${locale}.json has no meta.description`)
    } catch (e) { err(`locale/${locale}.json: ${e.message}`) }
  }
  for (const file of match(dir, 'locale/*.json')) {
    try { JSON.parse(readFileSync(join(dir, file), 'utf8')) } catch (e) { err(`${file}: ${e.message}`) }
  }

  const icon = join(dir, 'icon.svg')
  if (!existsSync(icon)) err('icon.svg is missing')
  else {
    const bytes = statSync(icon).size
    if (bytes > ICON_LIMIT) err(`icon.svg is ${bytes} bytes (limit ${ICON_LIMIT})`)
    if (!/<svg[\s>]/.test(readFileSync(icon, 'utf8'))) err('icon.svg is not an SVG document')
  }

  if (!existsSync(join(dir, 'README.md'))) warn('README.md is missing')

  for (const file of walk(dir)) {
    const rel = relative(dir, file)
    const text = /\.(js|mjs|json|ya?ml|md|svg|zsh)$/.test(file) ? readFileSync(file, 'utf8') : ''
    const leftover = /__(NAME|PACKAGE|ENTRY|TITLE|DESCRIPTION|COMMAND)__/.exec(text)
    if (leftover) err(`${rel} still contains template token ${leftover[0]}`)
    if (/\.(m?js)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
      if (result.status !== 0) err(`${rel}: syntax error\n${result.stderr.trim().split('\n').slice(0, 4).join('\n')}`)
    }
    if (file.endsWith('.zsh')) {
      const result = spawnSync('zsh', ['-n', file], { encoding: 'utf8' })
      if (result.error === undefined && result.status !== 0) err(`${rel}: zsh syntax error\n${result.stderr.trim()}`)
      if (!(statSync(file).mode & 0o111)) warn(`${rel} is not executable`)
    }
  }

  const mark = errors.length > 0 ? '✖' : '✔'
  console.log(`${mark} ${name}${pkg?.version ? ` ${pkg.version}` : ''}`)
  for (const message of errors) console.log(`  error: ${message}`)
  for (const message of warnings) console.log(`  warn:  ${message}`)
  if (errors.length > 0) failures++
}

if (failures > 0) {
  console.log(`\n${failures} plug(s) failed`)
  process.exit(1)
}
