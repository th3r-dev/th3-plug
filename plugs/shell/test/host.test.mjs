// Host-half tests for @th3-plug/shell. Run: node --test plugs/shell/test/*.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { apply } from '../host/index.js'
import { currentWord, shellHistory } from '../host/complete.js'

const PLUG_DIR = fileURLToPath(new URL('..', import.meta.url))

/** A fake Cordis context that records what the plugin registers. */
function fakeContext({ cwd = PLUG_DIR } = {}) {
  const seen = { commands: [], executed: [], listeners: {}, routes: [] }
  const ctx = {
    logger: { warn() {} },
    get(name) {
      if (name === 'workingDirectory') return { ensure: async () => cwd, get: () => cwd }
      if (name === 'agents') return { get: id => (id === 's1' ? { session: {} } : undefined) }
      return undefined
    },
    inject(_deps, callback) {
      callback({ connection: { fetch: { register: route => { seen.routes.push(route); return () => {} } } } })
    },
    on(name, listener) { seen.listeners[name] = listener; return () => {} },
    effect(body) { for (const _ of body()) { /* run registrations */ } },
    commands: {
      register(definition) { seen.commands.push(definition); return () => {} },
      async execute(agent, line, _attachments, signal) {
        seen.executed.push(line)
        const def = seen.commands[0]
        return def.handler({ agent, rawInput: line.slice(def.name.length + 1), signal })
      },
    },
  }
  return { ctx, seen }
}

const signal = new AbortController().signal
const userMessage = text => ({ id: text, source: { kind: 'user', rpcId: 'r' }, content: [{ type: 'text', text }] })
const runtimeContext = { id: 'rc', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'ctx' }] }

test('/sh runs a command and reports output, exit code and cwd', async () => {
  const { ctx, seen } = fakeContext()
  apply(ctx, {})
  const sh = seen.commands.find(c => c.name === 'sh')
  assert.ok(sh, '/sh is registered')
  const result = await sh.handler({ agent: {}, rawInput: ' echo hello', signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^\$ echo hello\ncwd: /)
  assert.match(result.text, /\nhello\n/)
  assert.match(result.text, /exit 0 · /)
})

test('/sh reports non-zero exit as success with the code', async () => {
  const { ctx, seen } = fakeContext()
  apply(ctx, {})
  const result = await seen.commands[0].handler({ agent: {}, rawInput: 'echo oops 1>&2; exit 3', signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /oops/)
  assert.match(result.text, /exit 3 · /)
})

test('/sh times out long commands', async () => {
  const { ctx, seen } = fakeContext()
  apply(ctx, { timeoutMs: 300 })
  const result = await seen.commands[0].handler({ agent: {}, rawInput: 'sleep 5', signal })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /timed out/)
})

test('/sh without input returns usage', async () => {
  const { ctx, seen } = fakeContext()
  apply(ctx, {})
  const result = await seen.commands[0].handler({ agent: {}, rawInput: '  ', signal })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Usage: \/sh/)
})

test('a turn opened by !cmd runs it and sends nothing to the model', async () => {
  const { ctx, seen } = fakeContext()
  apply(ctx, {})
  const preStep = seen.listeners['agent/pre-step']
  const messages = [userMessage('!echo hi')]
  const decision = await preStep(
    { agent: {}, messages, step: 1, signal },
    async () => ({ kind: 'enter', messages: [...messages, runtimeContext] }),
  )
  assert.deepEqual(decision.messages, [])
  assert.deepEqual(seen.executed, ['/sh echo hi'])
})

test('ordinary prompts and a bare ! pass through untouched', async () => {
  const { ctx, seen } = fakeContext()
  apply(ctx, {})
  const preStep = seen.listeners['agent/pre-step']
  for (const text of ['hello model', '!', 'run !this']) {
    const messages = [userMessage(text)]
    const decision = await preStep(
      { agent: {}, messages, step: 1, signal },
      async () => ({ kind: 'enter', messages: [...messages, runtimeContext] }),
    )
    assert.deepEqual(decision.messages.map(m => m.id), [text, 'rc'])
  }
  assert.deepEqual(seen.executed, [])
})

test('a ! steer mid-turn runs and keeps the other messages', async () => {
  const { ctx, seen } = fakeContext()
  apply(ctx, {})
  const messages = [userMessage('!pwd'), userMessage('keep going')]
  const decision = await seen.listeners['agent/pre-step'](
    { agent: {}, messages, step: 3, signal },
    async () => ({ kind: 'enter', messages: [...messages, runtimeContext] }),
  )
  assert.deepEqual(decision.messages.map(m => m.id), ['keep going', 'rc'])
  assert.deepEqual(seen.executed, ['/sh pwd'])
})

test('bang: false leaves ! messages to the model', async () => {
  const { ctx, seen } = fakeContext()
  apply(ctx, { bang: false })
  assert.equal(seen.listeners['agent/pre-step'], undefined)
})

test('completion route answers history and rejects unknown kinds', async () => {
  const { ctx, seen } = fakeContext()
  apply(ctx, {})
  const route = seen.routes[0]
  assert.equal(route.path, '/api/th3-shell/complete')
  const history = await route.fetch(new Request('http://x/api/th3-shell/complete?kind=history&line=zzz-never-typed'))
  assert.equal(history.status, 200)
  assert.deepEqual((await history.json()).items, [])
  const bad = await route.fetch(new Request('http://x/api/th3-shell/complete?kind=nope&line=x'))
  assert.equal(bad.status, 400)
})

test('currentWord splits on the last unescaped space', () => {
  assert.deepEqual(currentWord(' git ch'), { word: 'ch', start: 5 })
  assert.deepEqual(currentWord('ls my\\ dir'), { word: 'ls my\\ dir', start: 0 })
  assert.deepEqual(currentWord('git '), { word: '', start: 4 })
})

test('shellHistory never returns the exact typed line', () => {
  for (const command of shellHistory('git')) assert.notEqual(command, 'git')
})

test('zsh completion lists directories under the plug', { skip: process.platform === 'win32' }, async () => {
  const { shellComplete } = await import('../host/complete.js')
  const items = await shellComplete('ls ho', PLUG_DIR, { timeoutMs: 8000 })
  assert.ok(items.some(item => item.word === 'host/'), JSON.stringify(items))
})
