// Host-half tests for @th3-plug/image-reconcile.
// Run: node --test plugs/image-reconcile/test/*.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../host/index.js'
import { DOCUMENTED_LIMITS, resolveLimit } from '../host/limits.js'
import { probeImageLimit, SEARCH_CAP, tinyPng } from '../host/probe.js'
import {
  countClaimedImages, liveImageOccurrences, offloadSupported, planTargets, reconcileSession,
} from '../host/trim.js'

const text = value => ({ type: 'text', text: value })
const image = (id = 'a') => ({
  type: 'image',
  attachment: { attachmentId: `sha256:${id}`, mediaType: 'image/png', width: 10, height: 10, bytes: 100 },
})

/** One durable surface event. */
const surfaceEvent = (type, content) => ({
  type,
  data: { role: type === 'tool/result' ? 'tool' : 'user', content },
})

/**
 * A session whose surface is the given events and whose derivation applies the
 * image/offload decisions appended to it, like the Harness projection does.
 */
function fakeSession(events) {
  const log = events.map((event, index) => ({ ...event, seq: index }))
  const appended = []
  return {
    appended,
    get surface() {
      return { nodes: log.map((_, index) => index), contentGeneration: appended.length }
    },
    eventAt(seq) {
      return log[seq]
    },
    deriveEventMessage(event) {
      const indexes = new Set()
      for (const decision of appended) {
        for (const target of decision.data.targets) {
          if (target.seq !== event.seq) continue
          for (const imageIndex of target.imageIndexes) indexes.add(imageIndex)
        }
      }
      let index = 0
      return {
        ...event.data,
        content: event.data.content.map((block) => {
          if (block.type !== 'image') return block
          const current = index
          index += 1
          return indexes.has(current) ? { ...block, offloaded: true } : block
        }),
      }
    },
    append(type, data) {
      appended.push({ type, data })
      log.push({ seq: log.length, type, data })
    },
  }
}

/** A Host context with just the services this plug reads. */
function fakeHost({
  projections = [{ type: 'image/offload' }],
  llm = {
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
    stream: async function* () { yield {} },
  },
  attachments = {
    saveImages: async inputs => inputs.map((input, index) => ({
      attachmentId: `sha256:tiny-${index}`,
      mediaType: input.mediaType,
      width: 1,
      height: 1,
      bytes: input.data.byteLength,
    })),
  },
} = {}) {
  const listeners = {}
  const commands = []
  const warnings = []
  const ctx = {
    logger: { warn(message) { warnings.push(message) } },
    get(name) {
      if (name === 'sessions') return { messageProjections: projections }
      if (name === 'llm') return llm
      if (name === 'attachments') return attachments
      return undefined
    },
    on(name, listener) {
      listeners[name] = listener
      return () => {}
    },
    inject(deps, callback) {
      if (deps.includes('commands')) {
        callback({ commands: { register(command) { commands.push(command); return () => {} } } })
      }
    },
  }
  return { ctx, listeners, commands, warnings }
}

/** Run the registered pre-step listener with an enter decision. */
async function preStep(listeners, agent, messages = [], modelSelection = { provider: 'tokenme', model: 'm1' }) {
  return await listeners['agent/pre-step'](
    { agent, messages, turn: 1, step: 1, signal: { aborted: false }, modelSelection },
    async () => ({ kind: 'enter', messages }),
  )
}

/** A fake llm whose route accepts at most `cap` images per request. */
function capLlm(cap) {
  const requested = []
  const sent = []
  return {
    requested,
    sent,
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
    stream: async function* (options) {
      const blocks = options.messages[0].content.filter(block => block.type === 'image')
      requested.push(blocks.length)
      sent.push(blocks.map(block => block.attachment.attachmentId))
      if (blocks.length > cap) throw new Error('too many images per request')
      yield { type: 'text', text: String(blocks.length) }
    },
  }
}

// ------------------------------------------------------------------ counting

test('liveImageOccurrences walks the surface in model order and skips output', () => {
  const session = fakeSession([
    surfaceEvent('user/message', [text('look'), image('a'), image('b')]),
    surfaceEvent('assistant/message', [text('I see them')]),
    surfaceEvent('tool/result', [image('c')]),
  ])

  assert.deepEqual(liveImageOccurrences(session), [
    { seq: 0, imageIndex: 0 },
    { seq: 0, imageIndex: 1 },
    { seq: 2, imageIndex: 0 },
  ])
})

test('liveImageOccurrences leaves out an occurrence already offloaded', () => {
  const session = fakeSession([surfaceEvent('user/message', [image('a'), image('b')])])
  session.append('image/offload', { targets: [{ seq: 0, imageIndexes: [0] }] })

  assert.deepEqual(liveImageOccurrences(session), [{ seq: 0, imageIndex: 1 }])
})

test('countClaimedImages counts image blocks only', () => {
  assert.equal(countClaimedImages([
    { role: 'user', content: [text('hi'), image('a')] },
    { role: 'user', content: [image('b'), image('c')] },
  ]), 3)
  assert.equal(countClaimedImages(undefined), 0)
  assert.equal(countClaimedImages([{ content: [text('only text')] }]), 0)
})

test('offloadSupported follows the mounted session projections', () => {
  assert.equal(offloadSupported(fakeHost().ctx), true)
  assert.equal(offloadSupported(fakeHost({ projections: [] }).ctx), false)
  assert.equal(offloadSupported(fakeHost({ projections: [{ type: 'other/event' }] }).ctx), false)
})

// ------------------------------------------------------------------ selection

test('planTargets groups by message and keeps the newest occurrences', () => {
  const occurrences = [
    { seq: 0, imageIndex: 1 },
    { seq: 0, imageIndex: 2 },
    { seq: 1, imageIndex: 0 },
    { seq: 1, imageIndex: 1 },
  ]

  assert.deepEqual(planTargets(occurrences, 2), [
    { seq: 0, imageIndexes: [1, 2] },
  ])
  assert.deepEqual(planTargets(occurrences, 1), [
    { seq: 0, imageIndexes: [1, 2] },
    { seq: 1, imageIndexes: [0] },
  ])
  assert.deepEqual(planTargets(occurrences, 4), [], 'nothing to omit at the budget')
  assert.deepEqual(planTargets(occurrences, 9), [])
})

test('reconcileSession does nothing while the history fits', () => {
  const session = fakeSession([surfaceEvent('user/message', Array.from({ length: 8 }, (_, i) => image(`i${i}`)))])

  const result = reconcileSession(session, 8)

  assert.equal(result.images, 8)
  assert.equal(result.offloaded, 0)
  assert.equal(result.kept, 8)
  assert.deepEqual(session.appended, [], 'no decision is written when the request already fits')
})

test('reconcileSession omits the oldest image over the cap and keeps the newest', () => {
  const session = fakeSession([surfaceEvent('user/message', Array.from({ length: 9 }, (_, i) => image(`i${i}`)))])

  const result = reconcileSession(session, 8)

  assert.equal(result.images, 9)
  assert.equal(result.offloaded, 1)
  assert.equal(result.kept, 8)
  assert.equal(session.appended.length, 1)
  assert.equal(session.appended[0].type, 'image/offload')
  assert.deepEqual(session.appended[0].data, { targets: [{ seq: 0, imageIndexes: [0] }] })

  const again = reconcileSession(session, 8)
  assert.equal(again.offloaded, 0, 'a second pass sees the omission and does nothing')
  assert.equal(session.appended.length, 1)
})

test('reconcileSession reserves room for images still entering with the step', () => {
  const session = fakeSession([surfaceEvent('user/message', Array.from({ length: 8 }, (_, i) => image(`i${i}`)))])

  const result = reconcileSession(session, 8, 1)

  assert.equal(result.images, 9)
  assert.equal(result.offloaded, 1)
  assert.equal(result.kept, 7)
  assert.equal(result.claimed, 1)
  assert.equal(result.overflow, 0)
})

test('reconcileSession reports new images it cannot omit yet', () => {
  const session = fakeSession([surfaceEvent('user/message', [image('a'), image('b'), image('c')])])

  const result = reconcileSession(session, 8, 10)

  assert.equal(result.offloaded, 3)
  assert.equal(result.kept, 0)
  assert.equal(result.overflow, 2)
})

// ------------------------------------------------------------------- wiring

test('apply records a decision before a step that would exceed the cap', async () => {
  const { ctx, listeners } = fakeHost()
  apply(ctx, {})
  const session = fakeSession([surfaceEvent('user/message', Array.from({ length: 9 }, (_, i) => image(`i${i}`)))])
  const agent = { session }

  const decision = await preStep(listeners, agent)

  assert.equal(decision.kind, 'enter')
  assert.equal(session.appended.length, 1)
  assert.equal(session.appended[0].type, 'image/offload')
})

test('apply counts the step messages and leaves a rejected step alone', async () => {
  const { ctx, listeners } = fakeHost()
  apply(ctx, {})
  const session = fakeSession([surfaceEvent('user/message', Array.from({ length: 8 }, (_, i) => image(`i${i}`)))])
  const agent = { session }

  await preStep(listeners, agent, [{ role: 'user', content: [image('new')] }])
  assert.equal(session.appended.length, 1, 'the new image takes the last slot, so the oldest goes')

  const rejected = await listeners['agent/pre-step'](
    { agent, messages: [], turn: 1, step: 2, signal: { aborted: false }, modelSelection: {} },
    async () => ({ kind: 'reject' }),
  )
  assert.deepEqual(rejected, { kind: 'reject' })
  assert.equal(session.appended.length, 1, 'a rejected step records no decision')
})

test('apply records nothing when image/offload is not interpreted', async () => {
  const { ctx, listeners, warnings } = fakeHost({ projections: [] })
  apply(ctx, {})
  const session = fakeSession([surfaceEvent('user/message', Array.from({ length: 9 }, (_, i) => image(`i${i}`)))])

  await preStep(listeners, { session })

  assert.deepEqual(session.appended, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /does not interpret image\/offload/)
})

test('apply can be disabled entirely', () => {
  const { ctx, listeners } = fakeHost()
  apply(ctx, { enabled: false })

  assert.equal(listeners['agent/pre-step'], undefined)
})

test('the command trims the open session and reports the counts', async () => {
  const { ctx, commands } = fakeHost()
  apply(ctx, {})
  const session = fakeSession([surfaceEvent('user/message', Array.from({ length: 10 }, (_, i) => image(`i${i}`)))])

  const agent = { session, model: { current: () => ({ provider: 'tokenme', model: 'm1' }) } }
  const answer = await commands[0].handler({ agent })

  assert.equal(commands[0].name, 'imagereconcile')
  assert.deepEqual(commands[0].input, { hint: '[probe [provider/model]]' })
  assert.equal(answer.kind, 'success')
  assert.match(answer.text, /kept the newest 8 image\(s\); omitted 2 older one\(s\)/)
  assert.equal(session.appended.length, 1)
})

test('the command explains when it cannot record the omission', async () => {
  const { ctx, commands } = fakeHost({ projections: [] })
  apply(ctx, {})

  const answer = await commands[0].handler({ agent: { session: fakeSession([]) } })

  assert.equal(answer.kind, 'error')
  assert.match(answer.text, /does not interpret image\/offload/)
})

// ------------------------------------------------------------- budget sources

test('resolveLimit prefers config, then probed, then documented, then observed, then fallback', () => {
  const learned = new Map([['tokenme/m1', 4]])
  assert.deepEqual(resolveLimit({ tokenme: 3, 'tokenme/m1': 5 }, learned, 'tokenme', 'm1', 8), { limit: 5, source: 'config' })
  assert.deepEqual(resolveLimit({ tokenme: 3 }, learned, 'tokenme', 'm2', 8), { limit: 3, source: 'config' })
  assert.deepEqual(resolveLimit({}, learned, 'tokenme', 'm1', 8), { limit: 4, source: 'probed' })
  assert.deepEqual(resolveLimit({}, new Map(), 'deepseek', 'deepseek-flash', 8), { limit: 600, source: 'documented' })
  assert.equal(DOCUMENTED_LIMITS['deepseek-account'], 600, 'the account login shares the platform cap')
  assert.deepEqual(resolveLimit({}, new Map(), 'tokenme', 'm1', 8), { limit: 8, source: 'observed' })
  assert.deepEqual(resolveLimit({}, new Map(), 'anthropic', 'claude', 0), { limit: undefined, source: 'none' })
  assert.deepEqual(resolveLimit({}, new Map(), 'anthropic', 'claude', 6), { limit: 6, source: 'fallback' })
})

test('pre-step trims to the documented deepseek budget, not the fallback', async () => {
  const { ctx, listeners } = fakeHost()
  apply(ctx, {})
  const session = fakeSession([surfaceEvent('user/message', Array.from({ length: 9 }, (_, i) => image(`i${i}`)))])

  await preStep(listeners, { session }, [], { provider: 'deepseek', model: 'deepseek-flash' })

  assert.deepEqual(session.appended, [], 'nine images fit the documented 600-image budget')
})

test('pre-step trims to a config override for one provider', async () => {
  const { ctx, listeners } = fakeHost()
  apply(ctx, { limits: { tokenme: 3 } })
  const session = fakeSession([surfaceEvent('user/message', Array.from({ length: 9 }, (_, i) => image(`i${i}`)))])

  await preStep(listeners, { session })

  assert.equal(session.appended.length, 1)
  assert.equal(session.appended[0].data.targets[0].imageIndexes.length, 6)
})

test('a probed budget learned by the command beats the observed tokenme cap', async () => {
  const { ctx, listeners, commands } = fakeHost({ llm: capLlm(7) })
  apply(ctx, {})
  const session = fakeSession([surfaceEvent('user/message', Array.from({ length: 9 }, (_, i) => image(`i${i}`)))])
  const agent = { session, model: { current: () => ({ provider: 'tokenme', model: 'm1' }) } }

  const answer = await commands[0].handler({ agent, rawInput: 'probe tokenme/m1' })
  assert.equal(answer.kind, 'success')
  assert.match(answer.text, /accepts up to 7 image/)

  await preStep(listeners, agent)
  assert.equal(session.appended.length, 1, 'the probed budget of 7 omits two, the observed 8 would have omitted one')
  assert.equal(session.appended[0].data.targets[0].imageIndexes.length, 2)
})

// ------------------------------------------------------------------ probing

test('probeImageLimit binary-searches the cap below the first refusal', async () => {
  const llm = capLlm(7)
  const { ctx } = fakeHost({ llm })
  const result = await probeImageLimit(ctx, 'tokenme', 'm1')

  assert.equal(result.ok, true)
  assert.equal(result.limit, 7)
  assert.equal(result.note, undefined)
  assert.deepEqual(llm.requested, [1, 9, 5, 7, 8], 'baseline, first refusal, then the search')
  assert.equal(result.requests, 5)
})

test('probeImageLimit reports the search cap when the route keeps accepting', async () => {
  const { ctx } = fakeHost({ llm: capLlm(SEARCH_CAP) })
  const result = await probeImageLimit(ctx, 'deepseek', 'm1')

  assert.equal(result.ok, true)
  assert.equal(result.limit, SEARCH_CAP)
  assert.match(result.note, /at least/)
})

test('probeImageLimit gives up when even one image is refused', async () => {
  const { ctx } = fakeHost({ llm: capLlm(0) })
  const result = await probeImageLimit(ctx, 'tokenme', 'm1')

  assert.equal(result.ok, false)
  assert.match(result.error, /single-image request was refused/)
})

test('a request refused for images suggests the probe once per route', async () => {
  const { ctx, listeners, warnings } = fakeHost()
  apply(ctx, {})
  const agent = { model: { current: () => ({ provider: 'tokenme', model: 'm1' }) } }
  const payload = { agent, failure: { message: 'Error: too many images per request' }, signal: { aborted: false } }

  await listeners['agent/request-error'](payload, async () => ({ kind: 'error' }))
  await listeners['agent/request-error'](payload, async () => ({ kind: 'error' }))

  const hints = warnings.filter(warning => /probe/.test(warning))
  assert.equal(hints.length, 1, 'the hint fires once for the same route')
})

test('pre-step leaves a route with no known budget alone and warns once', async () => {
  const { ctx, listeners, warnings } = fakeHost()
  apply(ctx, {})
  const session = fakeSession([surfaceEvent('user/message', Array.from({ length: 40 }, (_, i) => image(`i${i}`)))])
  const selection = { provider: 'anthropic', model: 'claude-x' }

  await preStep(listeners, { session }, [], selection)
  await preStep(listeners, { session }, [], selection)

  assert.deepEqual(session.appended, [], 'an unmeasured route keeps its images')
  assert.equal(warnings.filter(warning => /no image budget is known/.test(warning)).length, 1)
})

test('the command on an unmeasured route reports the probe and omits nothing', async () => {
  const { ctx, commands, warnings } = fakeHost()
  apply(ctx, {})
  const session = fakeSession([surfaceEvent('user/message', Array.from({ length: 9 }, (_, i) => image(`i${i}`)))])
  const agent = { session, model: { current: () => ({ provider: 'anthropic', model: 'claude-x' }) } }

  const answer = await commands[0].handler({ agent })

  assert.equal(answer.kind, 'success')
  assert.match(answer.text, /No image budget is known for anthropic\/claude-x/)
  assert.match(answer.text, /probe anthropic\/claude-x/)
  assert.deepEqual(session.appended, [])
  assert.deepEqual(warnings, [])
})

test('a provider-only probe is remembered for every model of that provider', async () => {
  const { ctx, commands } = fakeHost({ llm: capLlm(5) })
  apply(ctx, {})
  const first = { session: fakeSession([]), model: { current: () => ({ provider: 'tokenme', model: 'm1' }) } }

  const answer = await commands[0].handler({ agent: first, rawInput: 'probe tokenme' })
  assert.equal(answer.kind, 'success')
  assert.match(answer.text, /accepts up to 5 image/)
  assert.match(answer.text, /limits: \{ "tokenme": 5 \}/)

  const session = fakeSession([surfaceEvent('user/message', Array.from({ length: 9 }, (_, i) => image(`i${i}`)))])
  const second = { session, model: { current: () => ({ provider: 'tokenme', model: 'm2' }) } }
  const trimmed = await commands[0].handler({ agent: second })

  assert.equal(trimmed.kind, 'success')
  assert.match(trimmed.text, /kept the newest 5 image\(s\); omitted 4 older one\(s\)/)
})


test('probe images are distinct so a deduplicating gateway cannot inflate the cap', async () => {
  const llm = capLlm(100)
  const { ctx } = fakeHost({ llm })
  await probeImageLimit(ctx, 'tokenme', 'm1')

  const nine = llm.sent[llm.requested.indexOf(9)]
  assert.equal(nine.length, 9)
  assert.equal(new Set(nine).size, 9, 'every probe image is a different attachment')
  assert.deepEqual([...tinyPng(1, 2, 3).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a real PNG signature')
})
