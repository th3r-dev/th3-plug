// Host-half tests for @th3-plug/live-jobs: the one authenticated route and its
// clamping. Run: node --test plugs/live-jobs/test/*.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../host/index.js'

const DEFAULTS = {
  position: 'conversation',
  previewLines: 8,
  maxOutputLines: 500,
  stopConfirmMs: 3000,
}

function fakeContext() {
  const routes = []
  const ctx = {
    inject(services, callback) {
      assert.deepEqual(services, ['connection'])
      callback({ connection: { fetch: { register(route) { routes.push(route); return () => {} } } } })
      return () => {}
    },
  }
  return { ctx, routes }
}

test('serves the card numbers over one authenticated GET route', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, {})
  assert.equal(routes.length, 1)
  const [route] = routes
  assert.equal(route.path, '/api/th3-live-jobs/config')
  assert.deepEqual(route.methods, ['GET'])
  assert.equal(route.requestBody, 'buffered')
  const response = await route.fetch()
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /application\/json/)
  assert.deepEqual(await response.json(), DEFAULTS)
})

test('clamps a configured number and falls back for an unusable one', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, {
    position: 'sidebar',
    previewLines: 500,
    maxOutputLines: 1,
    stopConfirmMs: 100,
  })
  const body = await (await routes[0].fetch()).json()
  assert.deepEqual(body, {
    position: 'conversation',
    previewLines: 100,
    maxOutputLines: 10,
    stopConfirmMs: 500,
  })
})

test('keeps the extra-bar placement the profile asked for', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, { position: 'extrabar' })
  const body = await (await routes[0].fetch()).json()
  assert.equal(body.position, 'extrabar')
})
