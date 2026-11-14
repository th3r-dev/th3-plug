// The plug must stay dependency-free: no npm package, no Harness package.
// Run: node --test plugs/retry/test/manifest.test.mjs
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

/** Every `require('…')` argument of one module (the Web half only has one). */
function requires(source) {
  return [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])
}

const hostFiles = readdirSync(join(ROOT, 'host')).filter(file => file.endsWith('.js'))
const clientFile = join(ROOT, 'web', 'client.js')

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

test('the Web half requires nothing but react', () => {
  const source = readFileSync(clientFile, 'utf8')
  assert.deepEqual(requires(source), ['react'], 'the page module table offers react and nothing else')
  assert.deepEqual(imports(source), [], 'a page module is one plain script')
})

test('the image work goes through the mounted service, not a bundled codec', () => {
  const images = readFileSync(join(ROOT, 'host', 'images.js'), 'utf8')
  assert.match(images, /attachments\.readImageRequest\(/, 'the attachment store owns the encoder')
  assert.match(images, /attachments\.saveImages\(/, 'and owns the storage of the result')
  assert.doesNotMatch(images, /sharp|jimp|canvas|image-resize-compress/, 'no codec is referenced by name')
})
