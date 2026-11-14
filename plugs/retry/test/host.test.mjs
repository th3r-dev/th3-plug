// Host-half tests for @th3-plug/retry. Run: node --test plugs/retry/test/*.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shrinkMessages } from '../host/images.js'
import { offloadOversized, offloadSupported, oversizedTargets } from '../host/offload.js'
import { apply, ROUTES } from '../host/index.js'
import {
  describePrompt, findPrompt, imageBlocks, longEdge, messageText, oversizedImage, resendContent,
} from '../host/retry.js'

const OPTIONS = { maxEdge: 2000, maxBytes: 1024 * 1024 }

/** One durable image reference, as the attachment service reports it. */
const imageRef = (width, height, id = `sha256:${width}x${height}`) => ({
  attachmentId: id, mediaType: 'image/png', width, height, bytes: 1000,
})

/** The timestamp-like pieces of a message a test does not care about. */
const prompt = (content, id = 'user-1') => ({ id, role: 'user', content, source: { kind: 'user' } })
const reply = (id = 'assistant-1') => ({ id, role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model' } })

/** An attachment service that records what it was asked to do. */
function fakeAttachments({ fail = false } = {}) {
  const reads = []
  const saves = []
  return {
    reads,
    saves,
    async readImageRequest(ref, target) {
      reads.push({ ref, target })
      if (fail) throw new Error('encoder refused the image')
      return { data: new Uint8Array([1, 2, 3]), mediaType: 'image/webp', width: target.width, height: target.height }
    },
    async saveImages(inputs) {
      saves.push(inputs)
      const target = reads.at(-1)?.target ?? { width: 1, height: 1 }
      return inputs.map(input => ({
        attachmentId: `sha256:small-${input.data.byteLength}-${Math.random().toString(16).slice(2, 8)}`,
        mediaType: input.mediaType,
        width: target.width,
        height: target.height,
        bytes: input.data.byteLength,
      }))
    },
    async admitPromptContent(content) {
      return content
    },
  }
}

/** A session built from durable messages, with the surface a decision addresses. */
function historySession(messages) {
  const log = messages.map(message => ({
    type: message.role === 'assistant' ? 'assistant/message' : 'user/message',
    data: message,
  }))
  const appended = []
  return {
    appended,
    deriveMessages: () => messages,
    get surface() {
      return { nodes: log.map((_, index) => index) }
    },
    eventAt: index => log[index],
    deriveEventMessage: event => event.data,
    append(type, data) {
      appended.push({ type, data })
      log.push({ type, data })
    },
  }
}

/** A Host context with just the services this plug reads. */
function fakeHost({ messages = [], attachments, model, session, projections = [] } = {}) {
  const routes = new Map()
  const listeners = {}
  const followed = []
  const agent = {
    id: 'session-1',
    session: session ?? { deriveMessages: () => messages },
    followup: message => followed.push(message),
    model: { current: () => model },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'agents') return { get: id => (id === agent.id ? agent : undefined) }
      if (name === 'attachments') return attachments
      if (name === 'sessions') return { messageProjections: projections }
      if (name === 'llm') {
        return { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
      }
      return undefined
    },
    on(name, listener) { listeners[name] = listener; return () => {} },
    effect(body) { for (const _ of body()) { /* run registrations */ } },
    inject(deps, callback) {
      callback({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => {} } } } })
    },
  }
  return { ctx, routes, listeners, followed, agent }
}

/** Post one JSON body to a registered route and read its JSON answer. */
async function call(route, body) {
  const response = await route.fetch(new Request('http://host.invalid' + route.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return { status: response.status, body: await response.json() }
}

// ------------------------------------------------------------------ geometry

test('longEdge caps the longest side and keeps the aspect ratio', () => {
  assert.deepEqual(longEdge(4000, 3000, 2000), { width: 2000, height: 1500 })
  assert.deepEqual(longEdge(1080, 4000, 2000), { width: 540, height: 2000 })
  assert.deepEqual(longEdge(2000, 2000, 2000), undefined, 'a source that already fits needs no work')
  assert.deepEqual(longEdge(1200, 800, 2000), undefined)
  assert.deepEqual(longEdge(0, 800, 2000), undefined, 'an unusable size is not resized')
  assert.deepEqual(longEdge(4000, 3000, 0), undefined)
})

test('oversizedImage reports only the images a cap affects', () => {
  const tall = oversizedImage({ type: 'image', attachment: imageRef(1000, 4000) }, 2000)
  assert.equal(tall?.size.height, 2000)
  assert.equal(tall?.ref.width, 1000)
  assert.equal(oversizedImage({ type: 'image', attachment: imageRef(800, 600) }, 2000), undefined)
  assert.equal(oversizedImage({ type: 'text', text: 'hi' }, 2000), undefined)
  assert.equal(oversizedImage({ type: 'image' }, 2000), undefined)
})

// --------------------------------------------------------------- message parts

test('messageText and imageBlocks read only what they own', () => {
  const message = prompt([
    { type: 'text', text: 'look ' },
    { type: 'image', attachment: imageRef(10, 10) },
    { type: 'text', text: 'here' },
  ])
  assert.equal(messageText(message), 'look here')
  assert.equal(imageBlocks(message).length, 1)
  assert.equal(messageText(prompt([{ type: 'image', attachment: imageRef(10, 10) }])), '', 'an image carries no text')
  assert.equal(imageBlocks(reply()).length, 0)
})

// ------------------------------------------------------------ prompt lookup

test('findPrompt returns the prompt that opened the message turn', () => {
  const first = prompt([{ type: 'text', text: 'first' }], 'user-1')
  const second = prompt([{ type: 'text', text: 'second' }], 'user-2')
  const messages = [first, reply('assistant-1'), second, reply('assistant-2')]

  assert.equal(findPrompt(messages, 'assistant-2'), second)
  assert.equal(findPrompt(messages, 'assistant-1'), first)
})

test('findPrompt skips steering and injected context, and falls back to the newest prompt', () => {
  const first = prompt([{ type: 'text', text: 'first' }], 'user-1')
  const steering = { id: 'steer-1', role: 'user', content: [{ type: 'text', text: 'also fix tests' }], source: { kind: 'steering' } }
  const messages = [first, reply('assistant-1'), steering, reply('assistant-2')]

  assert.equal(findPrompt(messages, 'assistant-2'), first)
  assert.equal(findPrompt([first, reply('assistant-1')], 'gone'), first, 'an unknown message still retries the newest prompt')
  assert.equal(findPrompt([reply('assistant-1')], 'assistant-1'), undefined)
  assert.equal(findPrompt(undefined, 'assistant-1'), undefined)
})

// ------------------------------------------------------------ resend content

test('resendContent keeps the original text and images in order', () => {
  const message = prompt([
    { type: 'text', text: 'what is this?' },
    { type: 'image', attachment: imageRef(4000, 3000) },
  ])
  const content = resendContent(message)
  assert.equal(content.length, 2)
  assert.equal(content[0].text, 'what is this?')
  assert.equal(content[1].type, 'image')
  assert.equal(content[1].attachment.width, 4000, 'the original image is re-sent, not a copy of its pixels')
})

test('resendContent replaces the text and keeps the images', () => {
  const message = prompt([
    { type: 'text', text: 'old words' },
    { type: 'image', attachment: imageRef(4000, 3000) },
  ])
  const content = resendContent(message, 'new words\r\nsecond line')
  assert.equal(content[0].text, 'new words\nsecond line')
  assert.equal(content[1].type, 'image')
  assert.equal(resendContent(message, '   ').length, 1, 'blank text leaves only the images')
  assert.equal(resendContent(message, '   ')[0].type, 'image')
})

test('resendContent leaves out blocks a prompt does not own', () => {
  const message = prompt([
    { type: 'text', text: 'hi' },
    { type: 'notice', summary: 'runtime context' },
    { type: 'image', attachment: imageRef(100, 100) },
  ])
  assert.deepEqual(resendContent(message).map(block => block.type), ['text', 'image'])
})

test('describePrompt reports what a resend would carry', () => {
  const described = describePrompt(prompt([
    { type: 'text', text: 'two shots' },
    { type: 'image', attachment: imageRef(100, 100) },
    { type: 'image', attachment: imageRef(200, 200) },
  ]))
  assert.deepEqual(described, { text: 'two shots', images: 2, blocks: 3 })
})

// ----------------------------------------------------------------- shrinking

test('shrinkMessages replaces every oversized image and leaves the rest alone', async () => {
  const attachments = fakeAttachments()
  const small = prompt([{ type: 'text', text: 'fine' }, { type: 'image', attachment: imageRef(800, 600) }])
  const tall = prompt([{ type: 'image', attachment: imageRef(1080, 4000) }], 'user-2')
  const messages = [small, tall]

  const next = await shrinkMessages(messages, attachments, OPTIONS, new Map())
  assert.notEqual(next, messages, 'the batch was rebuilt')
  assert.equal(next[0], small, 'a message that needs no work keeps its identity')
  assert.equal(next[1].content[0].attachment.height, 2000)
  assert.equal(next[1].content[0].attachment.mediaType, 'image/webp')
  assert.equal(attachments.reads.length, 1)
  assert.deepEqual(attachments.reads[0].target, { width: 540, height: 2000, maxBytes: OPTIONS.maxBytes })
})

test('shrinkMessages computes one image once, even across messages', async () => {
  const attachments = fakeAttachments()
  const ref = imageRef(1080, 4000, 'sha256:shared')
  const messages = [
    prompt([{ type: 'image', attachment: ref }], 'user-1'),
    prompt([{ type: 'image', attachment: ref }], 'user-2'),
  ]
  const cache = new Map()
  const next = await shrinkMessages(messages, attachments, OPTIONS, cache)
  assert.equal(attachments.reads.length, 1, 'the second message reuses the settled shrink')
  assert.equal(next[0].content[0].attachment.attachmentId, next[1].content[0].attachment.attachmentId)
})

test('shrinkMessages leaves the batch untouched when nothing is oversized', async () => {
  const attachments = fakeAttachments()
  const messages = [prompt([{ type: 'image', attachment: imageRef(800, 600) }])]
  assert.equal(await shrinkMessages(messages, attachments, OPTIONS, new Map()), messages)
  assert.equal(attachments.reads.length, 0)
})

test('shrinkMessages passes the batch through without an attachment service', async () => {
  const messages = [prompt([{ type: 'image', attachment: imageRef(1080, 4000) }])]
  assert.equal(await shrinkMessages(messages, undefined, OPTIONS, new Map()), messages)
  assert.equal(await shrinkMessages(messages, {}, OPTIONS, new Map()), messages)
})

test('shrinkMessages keeps the original image when shrinking fails, and says so', async () => {
  const attachments = fakeAttachments({ fail: true })
  const warnings = []
  const ref = imageRef(1080, 4000)
  const messages = [prompt([{ type: 'image', attachment: ref }])]
  const next = await shrinkMessages(messages, attachments, OPTIONS, new Map(), message => warnings.push(message))
  assert.equal(next[0].content[0].attachment, ref, 'the failed image is sent as it was')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /could not shrink image/)
})

// ------------------------------------------------------------------- the plug

test('the plug exposes both routes and a pre-step listener', () => {
  const host = fakeHost({ attachments: fakeAttachments() })
  apply(host.ctx, OPTIONS)
  assert.deepEqual([...host.routes.keys()].sort(), [ROUTES.prompt, ROUTES.send].sort())
  for (const route of host.routes.values()) assert.deepEqual(route.methods, ['POST'])
  assert.equal(typeof host.listeners['agent/pre-step'], 'function')
})

test('the pre-step listener rewrites only an accepted decision, keeping its series flag', async () => {
  const attachments = fakeAttachments()
  const host = fakeHost({ attachments })
  apply(host.ctx, OPTIONS)
  const big = prompt([{ type: 'image', attachment: imageRef(3000, 4000) }])
  const step = host.listeners['agent/pre-step']
  const decision = await step({ agent: host.agent, messages: [big], signal: new AbortController().signal, step: 1 },
    async () => ({ kind: 'enter', messages: [big], startsRequestSeries: true }))

  assert.equal(decision.startsRequestSeries, true, 'a rewritten decision keeps every other field')
  assert.equal(decision.messages[0].content[0].attachment.height, 2000)

  const rejected = await step({ agent: host.agent, signal: new AbortController().signal, step: 1 }, async () => ({ kind: 'reject' }))
  assert.deepEqual(rejected, { kind: 'reject' })
})

test('shrink: false leaves the request images alone', () => {
  const host = fakeHost({ attachments: fakeAttachments() })
  apply(host.ctx, { ...OPTIONS, shrink: false })
  assert.equal(host.listeners['agent/pre-step'], undefined)
  assert.equal(host.routes.size, 2, 'the resend routes still work')
})

test('the prompt route reads the prompt behind a reply', async () => {
  const messages = [
    prompt([{ type: 'text', text: 'what is this?' }, { type: 'image', attachment: imageRef(4000, 3000) }]),
    reply('assistant-1'),
  ]
  const host = fakeHost({ messages })
  apply(host.ctx, OPTIONS)
  const answer = await call(host.routes.get(ROUTES.prompt), { sessionId: 'session-1', messageId: 'assistant-1' })
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body, { ok: true, text: 'what is this?', images: 1, blocks: 2 })
})

test('the send route sends the same prompt again with its image', async () => {
  const attachments = fakeAttachments()
  const messages = [
    prompt([{ type: 'text', text: 'what is this?' }, { type: 'image', attachment: imageRef(4000, 3000) }]),
    reply('assistant-1'),
  ]
  const host = fakeHost({ messages, attachments })
  apply(host.ctx, OPTIONS)
  const answer = await call(host.routes.get(ROUTES.send), { sessionId: 'session-1', messageId: 'assistant-1' })

  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body, { ok: true, images: 1, dropped: 0, offloaded: 0 })
  assert.equal(host.followed.length, 1)
  const sent = host.followed[0]
  assert.equal(sent.role, 'user')
  assert.equal(sent.source.kind, 'user')
  assert.match(sent.id, /^[0-9a-f-]{36}$/)
  assert.equal(sent.content[0].text, 'what is this?')
  assert.equal(sent.content[1].attachment.width, 4000)
  assert.equal(Object.isFrozen(sent), true, 'an inbox message arrives frozen')
})

test('the send route uses the edited text and keeps the images', async () => {
  const messages = [
    prompt([{ type: 'text', text: 'old words' }, { type: 'image', attachment: imageRef(4000, 3000) }]),
    reply('assistant-1'),
  ]
  const host = fakeHost({ messages, attachments: fakeAttachments() })
  apply(host.ctx, OPTIONS)
  const answer = await call(host.routes.get(ROUTES.send), { sessionId: 'session-1', messageId: 'assistant-1', text: 'new words' })
  assert.equal(answer.status, 200)
  assert.equal(host.followed[0].content[0].text, 'new words')
  assert.equal(host.followed[0].content[1].type, 'image')
})

test('a text-only model gets the prompt without its images', async () => {
  const messages = [
    prompt([{ type: 'text', text: 'look' }, { type: 'image', attachment: imageRef(4000, 3000) }]),
    reply('assistant-1'),
  ]
  const host = fakeHost({ messages, attachments: fakeAttachments(), model: { provider: 'p', model: 'm' } })
  host.ctx.get = (name) => {
    if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text'] }) }
    if (name === 'agents') return { get: () => host.agent }
    if (name === 'attachments') return fakeAttachments()
    return undefined
  }
  apply(host.ctx, OPTIONS)
  const answer = await call(host.routes.get(ROUTES.send), { sessionId: 'session-1', messageId: 'assistant-1' })
  assert.deepEqual(answer.body, { ok: true, images: 0, dropped: 1, offloaded: 0 })
  assert.equal(host.followed[0].content.length, 1)
  assert.equal(host.followed[0].content[0].type, 'text')
})

test('both routes refuse a session they cannot reach and a missing prompt', async () => {
  const host = fakeHost({ messages: [reply('assistant-1')] })
  apply(host.ctx, OPTIONS)
  const unknown = await call(host.routes.get(ROUTES.send), { sessionId: 'nope', messageId: 'assistant-1' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.ok, false)

  const noPrompt = await call(host.routes.get(ROUTES.prompt), { sessionId: 'session-1', messageId: 'assistant-1' })
  assert.equal(noPrompt.status, 404)
  assert.match(noPrompt.body.error, /no earlier prompt/)
})

test('a body that is not an object, or is far too long, is refused', async () => {
  const host = fakeHost({ messages: [prompt([{ type: 'text', text: 'hi' }]), reply('assistant-1')] })
  apply(host.ctx, OPTIONS)
  const send = host.routes.get(ROUTES.send)
  const notJson = await send.fetch(new Request('http://host.invalid' + ROUTES.send, { method: 'POST', body: 'nope' }))
  assert.equal(notJson.status, 400)

  const array = await call(send, [1, 2, 3])
  assert.equal(array.status, 400)

  const tooLong = await call(send, { sessionId: 'session-1', messageId: 'assistant-1', text: 'x'.repeat(100_001) })
  assert.equal(tooLong.status, 413)
  assert.equal(host.followed.length, 0)
})

// ------------------------------------------------- omitting a stored image

test('offloadSupported follows the mounted image/offload projection', () => {
  assert.equal(offloadSupported(fakeHost().ctx), false, 'nothing interprets the event without the projection')
  assert.equal(offloadSupported(fakeHost({ projections: [{ type: 'image/offload' }] }).ctx), true)
  assert.equal(offloadSupported({ get: () => undefined }), false)
})

test('oversizedTargets names the image indexes the request cannot send', () => {
  const session = historySession([
    prompt([{ type: 'text', text: 'fine' }, { type: 'image', attachment: imageRef(800, 600) }]),
    reply('assistant-1'),
    prompt([{ type: 'image', attachment: imageRef(100, 100) }, { type: 'image', attachment: imageRef(1080, 4000) }], 'user-2'),
    { ...prompt([{ type: 'image', attachment: imageRef(1080, 4000) }], 'user-3'), content: [{ type: 'image', attachment: imageRef(1080, 4000), offloaded: true }] },
  ])
  assert.deepEqual(oversizedTargets(session, 2000), [{ seq: 2, imageIndexes: [1] }])
})

test('oversizedTargets ignores a session it cannot walk', () => {
  assert.deepEqual(oversizedTargets(undefined, 2000), [])
  assert.deepEqual(oversizedTargets({ surface: { nodes: [0] } }, 2000), [])
})

test('offloadOversized records one decision and reports how many images it omitted', () => {
  const session = historySession([
    prompt([{ type: 'image', attachment: imageRef(1080, 4000) }, { type: 'image', attachment: imageRef(3000, 3000) }]),
  ])
  assert.equal(offloadOversized(session, 2000), 2)
  assert.deepEqual(session.appended, [{ type: 'image/offload', data: { targets: [{ seq: 0, imageIndexes: [0, 1] }] } }])
  assert.equal(offloadOversized({ ...session, surface: { nodes: [] } }, 2000), 0)
})

test('a dimension failure omits the stored image and retries the step', async () => {
  const messages = [prompt([{ type: 'text', text: 'look' }, { type: 'image', attachment: imageRef(1080, 4000) }]), reply('assistant-1')]
  const session = historySession(messages)
  const host = fakeHost({ session, projections: [{ type: 'image/offload' }] })
  apply(host.ctx, OPTIONS)
  const error = host.listeners['agent/request-error']
  const delegated = { kind: 'downstream' }

  const decision = await error({
    agent: host.agent,
    failure: { code: 'INVALID_REQUEST', message: 'At least one of the image dimensions exceed max allowed size for many-image requests: 3000 pixels' },
    signal: new AbortController().signal,
  }, async () => delegated)

  assert.deepEqual(decision, { kind: 'retry' })
  assert.equal(session.appended.length, 1)
  assert.equal(session.appended[0].type, 'image/offload')
})

test('every other failure, and every missing piece, is delegated untouched', async () => {
  const messages = [prompt([{ type: 'image', attachment: imageRef(1080, 4000) }]), reply('assistant-1')]
  const delegated = { kind: 'downstream' }
  const payload = failure => ({ agent: undefined, failure, signal: new AbortController().signal })

  const unfitted = fakeHost({ session: historySession(messages), projections: [{ type: 'image/offload' }] })
  apply(unfitted.ctx, OPTIONS)
  assert.deepEqual(await unfitted.listeners['agent/request-error'](payload({ code: 'RATE_LIMITED', message: 'slow down' }), async () => delegated), delegated)

  const unsupported = fakeHost({ session: historySession(messages) })
  apply(unsupported.ctx, OPTIONS)
  assert.deepEqual(await unsupported.listeners['agent/request-error'](
    payload({ message: 'At least one of the image dimensions exceed max allowed size' }), async () => delegated), delegated)
  assert.equal(unsupported.followed.length, 0)

  const nothingToOmit = fakeHost({ session: historySession([prompt([{ type: 'text', text: 'hi' }]), reply()]), projections: [{ type: 'image/offload' }] })
  apply(nothingToOmit.ctx, OPTIONS)
  assert.deepEqual(await nothingToOmit.listeners['agent/request-error'](
    payload({ message: 'At least one of the image dimensions exceed max allowed size' }), async () => delegated), delegated)
})

test('a resend omits the stored copy of the image it is about to re-send', async () => {
  const messages = [
    prompt([{ type: 'text', text: 'look' }, { type: 'image', attachment: imageRef(1080, 4000) }]),
    reply('assistant-1'),
  ]
  const session = historySession(messages)
  const host = fakeHost({ session, attachments: fakeAttachments(), projections: [{ type: 'image/offload' }] })
  apply(host.ctx, OPTIONS)
  const answer = await call(host.routes.get(ROUTES.send), { sessionId: 'session-1', messageId: 'assistant-1' })

  assert.equal(answer.body.offloaded, 1)
  assert.equal(answer.body.images, 1, 'the resent message still carries the picture')
  assert.equal(session.appended.filter(entry => entry.type === 'image/offload').length, 1)
  assert.equal(host.followed.length, 1)
})

test('offload: false keeps the stored image in place', async () => {
  const messages = [
    prompt([{ type: 'text', text: 'look' }, { type: 'image', attachment: imageRef(1080, 4000) }]),
    reply('assistant-1'),
  ]
  const session = historySession(messages)
  const host = fakeHost({ session, attachments: fakeAttachments(), projections: [{ type: 'image/offload' }] })
  apply(host.ctx, { ...OPTIONS, offload: false })
  const answer = await call(host.routes.get(ROUTES.send), { sessionId: 'session-1', messageId: 'assistant-1' })
  assert.equal(answer.body.offloaded, 0)
  assert.equal(session.appended.length, 0)
  assert.equal(host.listeners['agent/request-error'], undefined)
})

// ------------------------------------------- resolving the session's agent

test('a controller failure carrier is not mistaken for an agent', async () => {
  const messages = [prompt([{ type: 'text', text: 'hi' }]), reply('assistant-1')]
  const host = fakeHost({ messages })
  host.ctx.get = (name) => {
    if (name === 'agents') return { get: () => undefined }
    if (name === 'sessionController') return { resolveAgent: async () => ({ error: { code: 'session/not-found', message: 'no such session' } }) }
    if (name === 'attachments') return fakeAttachments()
    return undefined
  }
  apply(host.ctx, OPTIONS)
  const answer = await call(host.routes.get(ROUTES.send), { sessionId: 'gone', messageId: 'assistant-1' })
  assert.equal(answer.status, 404)
  assert.match(answer.body.error, /session gone is not open in this Harness/)
  assert.equal(host.followed.length, 0)
})

test('a cold session is resumed through the controller and then re-sent', async () => {
  const messages = [prompt([{ type: 'text', text: 'hi' }]), reply('assistant-1')]
  const resumed = { session: { deriveMessages: () => messages }, followup: (message) => resumed.sent.push(message), sent: [] }
  const host = fakeHost({ messages })
  host.ctx.get = (name) => {
    if (name === 'agents') return { get: () => undefined }
    if (name === 'sessionController') return { resolveAgent: async id => (id === 'cold-1' ? resumed : { error: { code: 'session/not-found' } }) }
    if (name === 'attachments') return fakeAttachments()
    return undefined
  }
  apply(host.ctx, OPTIONS)
  const answer = await call(host.routes.get(ROUTES.send), { sessionId: 'cold-1', messageId: 'assistant-1' })
  assert.equal(answer.status, 200)
  assert.equal(resumed.sent.length, 1)
  assert.equal(resumed.sent[0].content[0].text, 'hi')
})

test('a controller that throws reports the session as unreachable', async () => {
  const host = fakeHost({ messages: [prompt([{ type: 'text', text: 'hi' }]), reply('assistant-1')] })
  host.ctx.get = (name) => {
    if (name === 'agents') return { get: () => undefined }
    if (name === 'sessionController') return { resolveAgent: async () => { throw new Error('writer held') } }
    return undefined
  }
  apply(host.ctx, OPTIONS)
  const answer = await call(host.routes.get(ROUTES.prompt), { sessionId: 'cold-2', messageId: 'assistant-1' })
  assert.equal(answer.status, 404)
  assert.match(answer.body.error, /cannot be opened: writer held/)
})
