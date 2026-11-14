// Web-half tests for @th3-plug/live-jobs: the in-conversation turn card, the
// job it finds through the Chat snapshot, the command and live output it draws,
// and the two-press stop. Rendered with a tiny React stand-in.
// Run: node --test plugs/live-jobs/test/*.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

// ------------------------------------------------------------- React stand-in

let hooks = []
let cursor = 0

function resetHooks() {
  cursor = 0
}

function resetTree() {
  hooks = []
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

// Effects are deliberately inert: the clock, the observation stream and the
// clipboard would outlive the render, and these tests assert what is drawn.
function useEffect() {}

const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.flat() } }
  },
  useState,
  useRef,
  useEffect,
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
    children: (node.props.children ?? []).flatMap((child) => {
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

function byLabel(tree, label) {
  const found = walk(tree).find(element => element.type === 'button' && element.props['aria-label'] === label)
  assert.ok(found, `no button labelled ${JSON.stringify(label)}`)
  return found
}

function hasLabel(tree, label) {
  return walk(tree).some(element => element.type === 'button' && element.props['aria-label'] === label)
}

// ------------------------------------------------------------------- the module

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      globalThis.__loaded = { id, factory }
    },
  },
}

await import('../web/client.js')

const loaded = globalThis.__loaded
const module = loaded.factory((name) => {
  if (name !== 'react') throw new Error(`unexpected require(${name})`)
  return React
})

function mount() {
  const registered = []
  let namespace
  let dictionaries
  const ctx = {
    effect(body) { body() },
    locale: {
      register(ns, value) {
        namespace = ns
        dictionaries = value
        return () => {}
      },
    },
    slots: {
      inject(name, callback) { callback() },
      register(options, Component) {
        registered.push({ options, Component })
        return () => {}
      },
    },
    jobs: {},
  }
  module.apply(ctx)
  const turnEntry = registered.find(entry => entry.options.name === 'conversation.chat.turnTail')
  const dockEntry = registered.find(entry => entry.options.name === 'conversation.input.dock')
  const translate = (key, params) => {
    const text = dictionaries?.en?.[key]
    if (typeof text !== 'string') return key
    return params === undefined ? text : text.replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])))
  }
  return { registered, turnEntry, dockEntry, namespace, dictionaries, translate }
}

/** A Chat-snapshot stand-in: one turn's node keys are what `getTurn` answers. */
function snapshotOf({ turn = 1, nodes = [] } = {}) {
  const map = new Map(nodes.map((node, index) => [`key-${index}`, node]))
  return {
    locations: {
      getTurn(number) {
        return number === turn ? [...map.keys()] : []
      },
    },
    nodes: map,
  }
}

/** One settled shell call whose result acknowledged a background job. */
function ackNode({ name = 'bash', text = 'started background job bash-0123456789abcdef' } = {}) {
  return {
    kind: 'tool-call',
    data: {
      root: {
        kind: 'tool-result',
        name,
        content: [{ type: 'text', text }],
      },
    },
  }
}

const JOB_ID = 'bash-0123456789abcdef'
const NOW = Date.now()
const CONFIG = { position: 'conversation', previewLines: 8, maxOutputLines: 500, stopConfirmMs: 3000 }

function job(overrides = {}) {
  return {
    id: JOB_ID,
    kind: 'bash',
    label: 'npm run dev',
    status: 'running',
    startedAt: NOW - 5000,
    output: { total: 40 },
    ...overrides,
  }
}

/** Render the turn tail with the props the slot supplies. */
function draw(entry, {
  turn = 1,
  jobs = [],
  observed = {},
  snapshot = snapshotOf({ turn, nodes: jobs.length === 0 ? [] : [ackNode()] }),
  sessionId = 'session-1',
  killJob = async () => true,
  translate,
  config = CONFIG,
} = {}) {
  resetHooks()
  const state = { rows: { [sessionId]: jobs }, observed }
  return render(entry.Component({
    turn: { turn },
    seq: 10,
    openFile: () => {},
    sessionId,
    config,
    useChat: (selector) => selector(snapshot),
    useJobs: (selector) => selector(state),
    observe: () => () => {},
    watchRows: () => () => {},
    killJob,
    t: translate,
  }))
}

// ------------------------------------------------------------------------ tests

test('registers one card in each placement, keyed by the same id', () => {
  assert.equal(loaded.id, '@th3-plug/live-jobs')
  const { registered, turnEntry, dockEntry, namespace, dictionaries } = mount()
  assert.deepEqual(module.inject, ['jobs', 'slots', 'locale'])
  assert.equal(registered.length, 2)
  assert.ok(turnEntry)
  assert.ok(dockEntry)
  assert.equal(turnEntry.options.id, 'live-jobs')
  assert.equal(turnEntry.options.order, 10)
  assert.equal(turnEntry.options.locale, 'th3-live-jobs')
  assert.equal(dockEntry.options.id, 'live-jobs')
  assert.equal(dockEntry.options.order, 30)
  assert.equal(dockEntry.options.locale, 'th3-live-jobs')
  assert.equal(namespace, 'th3-live-jobs')
  assert.deepEqual(Object.keys(dictionaries).sort(), ['en', 'th', 'zh'])
})

test('a turn that started no process grows no card', () => {
  const { turnEntry, translate } = mount()
  resetTree()
  const tree = draw(turnEntry, {
    snapshot: snapshotOf({ turn: 1, nodes: [ackNode({ name: 'read', text: 'package.json' })] }),
    translate,
  })
  assert.equal(tree, null)
})

test('the card shows the exact command and its live output', () => {
  const { turnEntry, translate } = mount()
  resetTree()
  const tree = draw(turnEntry, {
    jobs: [job({ label: 'npm run dev\nnode watch.js' })],
    observed: {
      [JOB_ID]: {
        jobId: JOB_ID,
        text: 'ready in 20ms\nlistening on :3000\n',
        streaming: true,
        gapBefore: false,
      },
    },
    translate,
  })
  const text = textOf(tree)
  assert.match(text, /Background process/)
  assert.match(text, /npm run dev\nnode watch\.js/)
  assert.match(text, /listening on :3000/)
  assert.match(text, /running/)
  assert.match(text, /2 lines/)
  assert.ok(hasLabel(tree, 'Stop this background process'))
  assert.ok(hasLabel(tree, 'Copy command'))
})

test('a command-only job still shows a command and an empty-output note', () => {
  const { turnEntry, translate } = mount()
  resetTree()
  const tree = draw(turnEntry, { jobs: [job()], translate })
  assert.match(textOf(tree), /npm run dev/)
  assert.match(textOf(tree), /No output yet\./)
})

test('a process that finished long ago stays in the turn', () => {
  const { turnEntry, translate } = mount()
  resetTree()
  const tree = draw(turnEntry, {
    jobs: [job({ status: 'completed', finishedAt: NOW - 600000, detail: 'exit code: 0' })],
    observed: { [JOB_ID]: { jobId: JOB_ID, text: 'all tests passed\n', streaming: false, gapBefore: false } },
    translate,
  })
  const text = textOf(tree)
  assert.match(text, /completed/)
  assert.match(text, /exit code: 0/)
  assert.match(text, /all tests passed/)
  assert.ok(!hasLabel(tree, 'Stop this background process'))
})

test('a job_output call that only mentions an id does not duplicate the card', () => {
  const { turnEntry, translate } = mount()
  resetTree()
  const tree = draw(turnEntry, {
    jobs: [job()],
    snapshot: snapshotOf({
      turn: 1,
      nodes: [ackNode({ name: 'job_output', text: `[${JOB_ID}] running\n${'x'.repeat(10)}` })],
    }),
    translate,
  })
  assert.equal(tree, null)
})

test('a foreground shell result does not grow the card', () => {
  const { turnEntry, translate } = mount()
  resetTree()
  const tree = draw(turnEntry, {
    jobs: [job()],
    snapshot: snapshotOf({
      turn: 1,
      nodes: [ackNode({ text: `done; job ${JOB_ID} finished earlier` })],
    }),
    translate,
  })
  assert.equal(tree, null)
})

test('another turn does not show this turn’s process', () => {
  const { turnEntry, translate } = mount()
  resetTree()
  const snapshot = snapshotOf({ turn: 1, nodes: [ackNode()] })
  const tree = draw(turnEntry, { turn: 2, jobs: [job()], snapshot, translate })
  assert.equal(tree, null)
})

test('two processes in one turn share one card', () => {
  const { turnEntry, translate } = mount()
  resetTree()
  const second = 'bash-fedcba9876543210'
  const tree = draw(turnEntry, {
    jobs: [job(), job({ id: second, label: 'npm run api', startedAt: NOW - 2000 })],
    snapshot: snapshotOf({
      turn: 1,
      nodes: [
        ackNode(),
        ackNode({ text: `started background job ${second}` }),
      ],
    }),
    translate,
  })
  assert.match(textOf(tree), /2 background processes/)
  assert.match(textOf(tree), /npm run dev/)
  assert.match(textOf(tree), /npm run api/)
})

test('stopping a live process takes two presses', async () => {
  const calls = []
  const { turnEntry, translate } = mount()
  resetTree()
  const options = {
    jobs: [job()],
    translate,
    killJob: async (sessionId, jobId) => {
      calls.push([sessionId, jobId])
      return true
    },
  }
  const first = draw(turnEntry, options)
  byLabel(first, 'Stop this background process').props.onClick()
  const armed = draw(turnEntry, options)
  assert.ok(hasLabel(armed, 'Press again to stop this background process'))
  assert.equal(calls.length, 0, 'one press must not stop the process')
  byLabel(armed, 'Press again to stop this background process').props.onClick()
  await Promise.resolve()
  assert.deepEqual(calls, [['session-1', JOB_ID]])
})

test('position: extrabar turns the in-conversation card off', () => {
  const { turnEntry, translate } = mount()
  resetTree()
  const tree = draw(turnEntry, { jobs: [job()], translate, config: { ...CONFIG, position: 'extrabar' } })
  assert.equal(tree, null)
})

test('position: extrabar draws the command and output in the composer bar', () => {
  const { dockEntry, translate } = mount()
  resetTree()
  const tree = draw(dockEntry, {
    jobs: [job()],
    observed: {
      [JOB_ID]: { jobId: JOB_ID, text: 'ready in 20ms\nlistening on :3000\n', streaming: true, gapBefore: false },
    },
    translate,
    config: { ...CONFIG, position: 'extrabar' },
  })
  const text = textOf(tree)
  assert.match(text, /Background process/)
  assert.match(text, /npm run dev/)
  assert.match(text, /listening on :3000/)
  assert.ok(hasLabel(tree, 'Stop this background process'))
})

test('the composer bar stays empty while the card lives in the conversation', () => {
  const { dockEntry, translate } = mount()
  resetTree()
  assert.equal(draw(dockEntry, { jobs: [job()], translate }), null)
})

test('the composer bar drops a process that finished more than a minute ago', () => {
  const { dockEntry, translate } = mount()
  resetTree()
  const tree = draw(dockEntry, {
    jobs: [job({ status: 'completed', finishedAt: NOW - 120000 })],
    translate,
    config: { ...CONFIG, position: 'extrabar' },
  })
  assert.equal(tree, null)
})

test('collapsing the card keeps the title and drops the body', () => {
  const { turnEntry, translate } = mount()
  resetTree()
  const options = { jobs: [job()], translate }
  draw(turnEntry, options)
  byLabel(draw(turnEntry, options), 'Collapse this background process').props.onClick()
  const collapsed = draw(turnEntry, options)
  assert.match(textOf(collapsed), /Background process/)
  assert.equal(walk(collapsed).some(element => element.type === 'pre'), false)
})
