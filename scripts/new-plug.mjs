#!/usr/bin/env node
/**
 * Scaffold plugs/<name> from templates/plug.
 *
 *   node scripts/new-plug.mjs <name> [--web] [--title "Title"] [--description "..."] [--command cmd]
 *
 * <name>      lower-case kebab name; package becomes @th3-plug/<name>,
 *             Loader row id th3-<name>.
 * --web       include the Web half (web/client.js + dsh.client manifest).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE = join(ROOT, 'templates', 'plug')
const SCOPE = '@th3-plug'

function usage(message) {
  if (message) console.error(`error: ${message}\n`)
  console.error('usage: node scripts/new-plug.mjs <name> [--web] [--title "Title"] [--description "..."] [--command cmd]')
  process.exit(message ? 1 : 0)
}

const args = process.argv.slice(2)
if (args.length === 0 || args.includes('-h') || args.includes('--help')) usage()
const name = args[0]
if (!/^[a-z][a-z0-9-]*$/.test(name)) usage(`name "${name}" must be lower-case kebab (a-z, 0-9, -)`)
const flag = (key) => {
  const at = args.indexOf(key)
  if (at < 0) return undefined
  const value = args[at + 1]
  if (value === undefined || value.startsWith('--')) usage(`${key} needs a value`)
  return value
}
const web = args.includes('--web')
const title = flag('--title') ?? name.replace(/(^|-)([a-z])/g, (_, sep, c) => (sep ? ' ' : '') + c.toUpperCase())
const description = flag('--description') ?? `${title} for DeepSeek Harness.`
const command = flag('--command') ?? name.replace(/-/g, '')
if (!/^[a-z0-9_-]+$/.test(command)) usage(`command "${command}" must be lower-case letters, digits, _ or -`)

const target = join(ROOT, 'plugs', name)
if (existsSync(target)) usage(`${relative(ROOT, target)} already exists`)

const tokens = {
  __NAME__: name,
  __PACKAGE__: `${SCOPE}/${name}`,
  __ENTRY__: `th3-${name}`,
  __TITLE__: title,
  __DESCRIPTION__: description,
  __COMMAND__: command,
}
const fill = text => text.replace(/__[A-Z]+__/g, token => tokens[token] ?? token)

function copyTree(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    if (entry === 'web' && !web) continue
    const source = join(from, entry)
    const dest = join(to, entry)
    if (statSync(source).isDirectory()) copyTree(source, dest)
    else if (/\.(js|mjs|json|ya?ml|md|svg|zsh|txt)$/.test(entry)) writeFileSync(dest, fill(readFileSync(source, 'utf8')))
    else cpSync(source, dest)
  }
}
copyTree(TEMPLATE, target)

const pkg = {
  name: tokens.__PACKAGE__,
  version: '0.1.0',
  private: true,
  description,
  license: 'MIT',
  type: 'module',
  exports: {
    '.': './host/index.js',
    ...(web ? { './client': './web/client.js' } : {}),
    './locale/*.json': './locale/*.json',
    './icon': './icon.svg',
  },
  files: ['host/*.js', ...(web ? ['web/client.js'] : []), 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md'],
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    ...(web
      ? { client: { platform: 'web', immediately: true, inject: ['@deepseek-ai/dsh-client-ui-conversation'] } }
      : {}),
  },
}
writeFileSync(join(target, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

console.log(`created ${relative(ROOT, target)}/ (${tokens.__PACKAGE__}, row ${tokens.__ENTRY__}, /${command}${web ? ', with web half' : ''})`)
console.log('next:')
console.log(`  node scripts/check.mjs ${name}`)
console.log(`  node --test plugs/${name}/test/*.test.mjs`)
console.log(`  ask DeepSeek Harness: "install bundle ${target}"`)
