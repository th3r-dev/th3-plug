// Web-half tests for @th3-plug/retry: the module contract, the two actions and
// the editor, rendered with a tiny React stand-in and a stubbed fetch.
// Run: node --test plugs/retry/test/client.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

// --------------------------------------------------------------- React stand-in

/** Hook slots of the current render, in call order. */
let hooks = []
let cursor = 0

function resetHooks() {
  cursor = 0
}

function useState(initial) {
  const at = cursor++
  if (!(at in hooks)) hooks[at] = typeof initial === 'function' ? initial() : initial
  return [hooks[at], (next) => { hooks[at] = typeof next === 'function' ? next(hooks[at]) : next }]
}

function useRef(initial) {
  const at = cursor++
  if (!(at in hooks)) hooks[at] = { current: initial }
  return hooks[at]
}

// The component's only effect is the unmount flag: running it here would mark
// the instance dead on the first render, so it is deliberately inert.
function useEffect() {}

function useCallback(fn) {
  cursor++
  return fn
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.flat() } }
  },
  useState,
  useRef,
  useEffect,
  useCallback,
}

/** Render one element tree, resolving function components. */
function render(node) {
  if (node === null || node === undefined || node === false) return null
  if (Array.isArray(node)) return node.map(render).filter(Boolean)
  if (typeof node === 'string' || typeof node === 'number') return { type: '#text', text: String(node), props: {} }
  if (typeof node.type === 'function') return render(node.type(node.props))
  return {
    type: node.type,
    props: node.props,
    children: (node.props.children ?? []).flatMap(child => {
      const rendered = render(child)
      return rendered === null ? [] : (Array.isArray(rendered) ? rendered : [rendered])
    }),
  }
}

/** Every element of a tree, depth first. */
function walk(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

/** All text under one element. */
function textOf(node) {
  return walk(node).filter(element => element.type === '#text').map(element => element.text).join('')
}

function button(tree, label) {
  const found = walk(tree).find(element => element.type === 'button'
    && (element.props['aria-label'] === label || textOf(element) === label))
  assert.ok(found, `no button labelled ${JSON.stringify(label)}`)
  return found
}

// ------------------------------------------------------------------- the module

const requests = []
let answer = () => ({ ok: true })

globalThis.window = {
  location: { origin: 'http://host.invalid' },
  __ModuleLoader__: {
    load({ id, factory }) {
      globalThis.__loaded = { id, factory }
    },
  },
}

globalThis.fetch = async (path, init) => {
  requests.push({ path: String(path), body: init?.body === undefined ? undefined : JSON.parse(init.body) })
  return new Response(JSON.stringify(answer(String(path))), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

await import('../web/client.js')

const loaded = globalThis.__loaded
const module = loaded.factory(name => {
  if (name !== 'react') throw new Error(`unexpected require(${name})`)
  return React
})

/** The English translator of the last mount, which every draw reuses. */
let currentTranslate = key => key

/** Register the plugin into a fake Client context and return what it registered. */
function mount() {
  const registered = []
  let dictionaries
  const ctx = {
    locale: {
      register(namespace, dicts) {
        dictionaries = { namespace, dicts }
        return () => {}
      },
      bind() {
        return (key, params) => {
          const text = dictionaries?.dicts.en[key]
          if (typeof text !== 'string') return key
          return params === undefined ? text : text.replace(/\{(\w+)\}/g, (all, name) => String(params[name] ?? all))
        }
      },
    },
    effect(body) {
      body()
    },
    slots: {
      inject(name, callback) {
        callback()
      },
      register(options, Component) {
        registered.push({ options, Component })
        return () => {}
      },
    },
  }
  module.apply(ctx)
  const translate = (key, params) => {
    const text = dictionaries?.dicts.en[key]
    if (typeof text !== 'string') return key
    return params === undefined ? text : text.replace(/\{(\w+)\}/g, (all, name) => String(params[name] ?? all))
  }
  currentTranslate = translate
  return { registered, dictionaries, translate }
}

/** Render the action entry once, with the props the Chat slot supplies. */
function draw(entry, { messageId = 'assistant-1', access = true } = {}) {
  const verbs = entry.options.inject('session-1')
  const translate = (key, params) => {
    const text = entry.options.locale === 'th3-retry' ? key : key
    return params === undefined ? text : text.replace(/\{(\w+)\}/g, (all, name) => String(params[name] ?? all))
  }
  resetHooks()
  const tree = render(entry.Component({
    messageId,
    ...verbs,
    t: currentTranslate,
    useAccess: () => access,
  }))
  return { tree, verbs }
}

/** Let the component's promise chains settle, then render again. */
async function settle(tree, entry, options) {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  const { tree: next } = draw(entry, options)
  void tree
  return next
}

// ------------------------------------------------------------------------ tests

test('the module registers under its package name into the assistant action row', () => {
  assert.equal(loaded.id, '@th3-plug/retry')
  const { registered, dictionaries } = mount()
  assert.equal(registered.length, 1)
  const { options } = registered[0]
  assert.equal(options.name, 'conversation.chat.assistant-actions')
  assert.equal(options.id, 'retry')
  assert.equal(options.order, 20)
  assert.equal(options.locale, 'th3-retry')
  assert.equal(dictionaries.namespace, 'th3-retry')
  assert.deepEqual(Object.keys(dictionaries.dicts).sort(), ['en', 'th', 'zh'])
})

test('the action row reads "Retry" and "Edit"', () => {
  const { registered } = mount()
  const { tree } = draw(registered[0])
  assert.match(textOf(button(tree, 'Send the previous prompt again')), /Retry/)
  assert.match(textOf(button(tree, 'Edit the previous prompt, then send it again')), /Edit/)
})

test('a peer without prompt access sees nothing', () => {
  const { registered } = mount()
  const { tree } = draw(registered[0], { access: false })
  assert.equal(tree, null)
})

test('Retry posts the message identity and no text', async () => {
  const { registered } = mount()
  requests.length = 0
  answer = () => ({ ok: true, images: 1, dropped: 0, offloaded: 0 })
  const { tree } = draw(registered[0])
  button(tree, 'Send the previous prompt again').props.onClick()
  await settle(tree, registered[0])

  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/api/th3-retry/send')
  assert.deepEqual(requests[0].body, { sessionId: 'session-1', messageId: 'assistant-1' })
})

test('a refused resend shows the Host message in place of the actions', async () => {
  const { registered } = mount()
  requests.length = 0
  answer = () => ({ ok: false, error: 'session 9 is not open in this Harness' })
  const { tree } = draw(registered[0])
  button(tree, 'Send the previous prompt again').props.onClick()
  const next = await settle(tree, registered[0])
  assert.match(textOf(next), /session 9 is not open in this Harness/)
})

test('Edit reads the prompt into an editor and sends the edited text back', async () => {
  const { registered } = mount()
  requests.length = 0
  answer = (path) => (path.endsWith('/prompt')
    ? { ok: true, text: 'what is this?', images: 2, blocks: 3 }
    : { ok: true, images: 2, dropped: 0, offloaded: 1 })
  const { tree } = draw(registered[0])
  button(tree, 'Edit the previous prompt, then send it again').props.onClick()
  let next = await settle(tree, registered[0])

  assert.equal(requests[0].path, '/api/th3-retry/prompt')
  assert.deepEqual(requests[0].body, { sessionId: 'session-1', messageId: 'assistant-1' })
  const editor = walk(next).find(element => element.type === 'textarea')
  assert.ok(editor, 'the editor opened')
  assert.equal(editor.props.value, 'what is this?')
  assert.match(textOf(next), /2 image/)

  editor.props.onChange({ target: { value: 'what is this, exactly?' } })
  next = await settle(next, registered[0])
  button(next, 'Send again').props.onClick()
  await settle(next, registered[0])

  assert.equal(requests[1].path, '/api/th3-retry/send')
  assert.deepEqual(requests[1].body, { sessionId: 'session-1', messageId: 'assistant-1', text: 'what is this, exactly?' })
})

test('the editor closes on Escape and cancels without sending', async () => {
  const { registered } = mount()
  requests.length = 0
  answer = () => ({ ok: true, text: 'look', images: 0, blocks: 1 })
  const { tree } = draw(registered[0])
  button(tree, 'Edit the previous prompt, then send it again').props.onClick()
  let next = await settle(tree, registered[0])
  const editor = walk(next).find(element => element.type === 'textarea')

  let stopped = false
  editor.props.onKeyDown({ key: 'Escape', stopPropagation() { stopped = true } })
  assert.equal(stopped, true, 'the composer must not treat this Escape as a stop')
  next = await settle(next, registered[0])
  assert.equal(walk(next).find(element => element.type === 'textarea'), undefined)
  assert.equal(requests.length, 1, 'only the prompt read went out')
})

test('an empty editor cannot be sent, and Cmd+Enter on text can', async () => {
  const { registered } = mount()
  requests.length = 0
  answer = (path) => (path.endsWith('/prompt') ? { ok: true, text: '   ', images: 0 } : { ok: true, images: 0, dropped: 0, offloaded: 0 })
  const { tree } = draw(registered[0])
  button(tree, 'Edit the previous prompt, then send it again').props.onClick()
  let next = await settle(tree, registered[0])
  assert.equal(button(next, 'Send again').props.disabled, true)

  let prevented = false
  walk(next).find(element => element.type === 'textarea').props.onKeyDown({
    key: 'Enter', metaKey: true, preventDefault() { prevented = true },
  })
  assert.equal(prevented, true)
  assert.equal(requests.length, 1, 'a blank editor sends nothing')

  walk(next).find(element => element.type === 'textarea').props.onChange({ target: { value: 'now with words' } })
  next = await settle(next, registered[0])
  walk(next).find(element => element.type === 'textarea').props.onKeyDown({
    key: 'Enter', metaKey: true, preventDefault() {},
  })
  await settle(next, registered[0])
  assert.deepEqual(requests.at(-1).body, { sessionId: 'session-1', messageId: 'assistant-1', text: 'now with words' })
})

test('omitted copies are reported after a successful resend', async () => {
  const { registered } = mount()
  answer = () => ({ ok: true, images: 1, dropped: 0, offloaded: 2 })
  const { tree } = draw(registered[0])
  button(tree, 'Send the previous prompt again').props.onClick()
  const next = await settle(tree, registered[0])
  assert.match(textOf(next), /2 older copy/)
})

test('a missing route reads as an unavailable Host rather than a raw status', async () => {
  const { registered } = mount()
  const reachable = globalThis.fetch
  globalThis.fetch = async () => new Response('not found', { status: 404 })
  try {
    const { tree } = draw(registered[0])
    button(tree, 'Send the previous prompt again').props.onClick()
    const next = await settle(tree, registered[0])
    assert.match(textOf(next), /not answering on the Host/)
  } finally {
    globalThis.fetch = reachable
  }
})
