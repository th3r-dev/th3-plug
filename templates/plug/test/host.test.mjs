// Host-half tests for __PACKAGE__. Run: node --test plugs/__NAME__/test/*.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../host/index.js'

function fakeContext() {
  const seen = { commands: [] }
  const ctx = {
    get: () => undefined,
    on: () => () => {},
    effect(body) { for (const _ of body()) { /* run registrations */ } },
    commands: { register(definition) { seen.commands.push(definition); return () => {} } },
  }
  return { ctx, seen }
}

test('registers /__COMMAND__ and answers without the model', async () => {
  const { ctx, seen } = fakeContext()
  apply(ctx, {})
  const command = seen.commands.find(c => c.name === '__COMMAND__')
  assert.ok(command)
  const result = await command.handler({ agent: {}, rawInput: ' hi', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
})
