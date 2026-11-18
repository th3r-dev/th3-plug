// The plug must stay dependency-free: no npm package, no Harness package.
// Run: node --test plugs/image-reconcile/test/manifest.test.mjs
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** Every import specifier of one ES module. */
function imports(source) {
  const found = []
  for (const match of source.matchAll(/^\s*(?:import|export)\b[^\n]*?from\s+['"]([^'"]+)['"]/gm)) found.push(match[1])
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) found.push(match[1])
  return found
}

const hostFiles = readdirSync(join(ROOT, 'host')).filter(file => file.endsWith('.js'))

test('the package declares no dependency at all', () => {
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [], 'a plug ships no npm package')
  assert.deepEqual(Object.keys(manifest.devDependencies ?? {}), [], 'and no build tool either')
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), [], 'nor a peer package')
  assert.equal(manifest.type, 'module')
})

test('the Host half imports only node built-ins and its own files', () => {
  for (const file of hostFiles) {
    for (const specifier of imports(readFileSync(join(ROOT, 'host', file), 'utf8'))) {
      const builtin = specifier.startsWith('node:')
      const local = specifier.startsWith('./')
      assert.ok(builtin || local, `host/${file} imports ${specifier}: only node: built-ins and ./ files are allowed`)
    }
  }
})

test('the trim records the supported decision instead of rewriting request messages', () => {
  const source = readFileSync(join(ROOT, 'host', 'trim.js'), 'utf8')
  assert.match(source, /session\.append\(OFFLOAD_EVENT/, 'the durable image/offload projection owns the omission')
  assert.doesNotMatch(source, /messages\s*=\s*.*filter/, 'a request batch cannot change the derived history')
})
