// Host-half tests for @th3-plug/token-diet. Run: node --test plugs/token-diet/test/*.test.mjs
//
// The matrix lives in TEST_PLAN.md at the repo root; test ids below refer to it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, markOf } from '../host/index.js'

const BUILTIN_NOTICE = 'Full formatted result stored at:'

/** A fake Cordis context that records what the plugin registers. */
function fakeContext({ spill, meter } = {}) {
  const seen = { commands: [], listeners: {}, warns: [], spillCalls: [] }
  const ctx = {
    logger: { warn: message => seen.warns.push(message) },
    get(name) {
      if (name === 'spillStore') return spill === undefined
        ? undefined
        : {
            saveText: async request => {
              if (spill.reject) throw new Error(spill.reject)
              seen.spillCalls.push(request)
              return { locator: '/tmp/spill/web_fetch.txt', bytes: request.content.length, retrievalHint: 'read or grep this path' }
            },
          }
      if (name === 'tokenMeter') {
        return meter === undefined ? undefined : { estimateMessage: message => Math.ceil(textOf(message.content).length / 4) + 4 }
      }
      return undefined
    },
    on(name, listener) { seen.listeners[name] = listener; return () => {} },
    effect(body) { for (const _ of body()) { /* run registrations */ } },
    commands: {
      register(definition) { seen.commands.push(definition); return () => {} },
    },
  }
  return { ctx, seen }
}

const textOf = content => content.map(block => block.text ?? '').join('')
const text = length => 'x'.repeat(length)
const exec = (name = 'web_fetch', extra = {}) => ({
  name,
  callId: 'call-1',
  agent: { session: { header: { id: 'session-1' } } },
  ...extra,
})
const accept = content => ({ kind: 'accept', content })

/** Run the registered post-execute listener against a decision. */
async function trim(seen, execArgs, decision) {
  return await seen.listeners['tools/post-execute'](execArgs, { content: decision.content }, async () => decision)
}

// --- T-1: FR-1 happy path ----------------------------------------------------
test('T-1 trims an oversized all-text result to the cap with head and tail intact', async () => {
  const { ctx, seen } = fakeContext({ spill: {} })
  apply(ctx, { maxResultChars: 2000, headChars: 1500, tailChars: 400 })
  const original = text(5000)
  const out = await trim(seen, exec(), accept([{ type: 'text', text: original }]))
  assert.equal(out.kind, 'accept')
  const blocks = out.content
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.length <= 2000, `got ${blocks[0].text.length}`)
  assert.ok(blocks[0].text.startsWith('x'.repeat(20)), 'keeps the head')
  assert.ok(blocks[0].text.endsWith('x'.repeat(20)), 'keeps the tail')
  assert.match(blocks[0].text, /token-diet: omitted \d+ of 5000 chars/)
  assert.equal(seen.spillCalls.length, 1)
  assert.equal(seen.spillCalls[0].content, original)
  assert.equal(seen.spillCalls[0].owner.sessionId, 'session-1')
  assert.equal(seen.spillCalls[0].source.toolName, 'web_fetch')
})

// --- T-2: FR-2 under cap passes the same decision through ---------------------
test('T-2 returns the same decision object for results within the cap', async () => {
  const { ctx, seen } = fakeContext({ spill: {} })
  apply(ctx, {})
  const decision = accept([{ type: 'text', text: text(500) }])
  const out = await trim(seen, exec(), decision)
  assert.equal(out, decision)
  assert.equal(seen.spillCalls.length, 0)
})

// --- T-3: FR-2 marker names the locator and the hint --------------------------
test('T-3 marker carries the omitted count, the spill locator and the retrieval hint', async () => {
  const { ctx, seen } = fakeContext({ spill: {} })
  apply(ctx, {})
  const out = await trim(seen, exec(), accept([{ type: 'text', text: text(5000) }]))
  const marker = out.content[0].text.match(/\[\.\.\..*\.\.\]/s)[0]
  assert.ok(marker.includes('/tmp/spill/web_fetch.txt'))
  assert.ok(marker.includes('read or grep this path'))
  assert.match(marker, /omitted \d{4} of 5000 chars/)
})

// --- T-4..T-10: FR-3 pass-through rules ---------------------------------------
test('T-4 read results pass through untouched', async () => {
  const { ctx, seen } = fakeContext({ spill: {} })
  apply(ctx, {})
  const decision = accept([{ type: 'text', text: text(5000) }])
  const out = await trim(seen, exec('read'), decision)
  assert.equal(out, decision)
  assert.equal(seen.spillCalls.length, 0)
})

test('T-5 results with a non-text block pass through untouched', async () => {
  const { ctx, seen } = fakeContext({ spill: {} })
  apply(ctx, {})
  const decision = accept([{ type: 'text', text: text(5000) }, { type: 'image', attachment: {} }])
  const out = await trim(seen, exec(), decision)
  assert.equal(out, decision)
  assert.equal(seen.spillCalls.length, 0)
})

test('T-6 a result already bounded by the built-in spill policy passes through', async () => {
  const { ctx, seen } = fakeContext({ spill: {} })
  apply(ctx, {})
  const decision = accept([{ type: 'text', text: `${text(4000)}\n\n(Omitted 8000 bytes. ${BUILTIN_NOTICE} /tmp/spill/x.txt.)` }])
  const out = await trim(seen, exec(), decision)
  assert.equal(out, decision)
  assert.equal(seen.spillCalls.length, 0)
})

test('T-7 a result already trimmed by this plug passes through (idempotent)', async () => {
  const { ctx, seen } = fakeContext({ spill: {} })
  apply(ctx, {})
  const decision = accept([{ type: 'text', text: `${text(1500)}\n\n[... ${markOf(100, 500, '/tmp/spill/x.txt', 'read it')} ...]\n\n${text(400)}` }])
  const out = await trim(seen, exec(), decision)
  assert.equal(out, decision)
  assert.equal(seen.spillCalls.length, 0)
})

test('T-8 a decision with a value own-property passes through', async () => {
  const { ctx, seen } = fakeContext({ spill: {} })
  apply(ctx, {})
  const decision = { kind: 'accept', value: { ok: true }, content: [{ type: 'text', text: text(5000) }] }
  const out = await trim(seen, exec(), decision)
  assert.equal(out, decision)
  assert.equal(seen.spillCalls.length, 0)
})

test('T-9 a non-accept decision passes through', async () => {
  const { ctx, seen } = fakeContext({ spill: {} })
  apply(ctx, {})
  const decision = { kind: 'deny', reason: 'blocked' }
  const out = await seen.listeners['tools/post-execute'](exec(), {}, async () => decision)
  assert.equal(out, decision)
  assert.equal(seen.spillCalls.length, 0)
})

test('T-10 PTC sub-dispatch copies pass through', async () => {
  const { ctx, seen } = fakeContext({ spill: {} })
  apply(ctx, {})
  const decision = accept([{ type: 'text', text: text(5000) }])
  const out = await trim(seen, exec('web_fetch', { parent: { callId: 'p1' } }), decision)
  assert.equal(out, decision)
  assert.equal(seen.spillCalls.length, 0)
})

// --- T-11/T-12: FR-4 fail-open -------------------------------------------------
test('T-11 with no spill backend an oversized result stays inline with a warning', async () => {
  const { ctx, seen } = fakeContext()
  apply(ctx, {})
  const decision = accept([{ type: 'text', text: text(5000) }])
  const out = await trim(seen, exec(), decision)
  assert.equal(out, decision)
  assert.equal(seen.warns.length, 1)
})

test('T-12 a rejecting spill save keeps the original inline and logs a warning', async () => {
  const { ctx, seen } = fakeContext({ spill: { reject: 'disk full' } })
  apply(ctx, {})
  const decision = accept([{ type: 'text', text: text(5000) }])
  const out = await trim(seen, exec(), decision)
  assert.equal(out, decision)
  assert.equal(seen.warns.length, 1)
  assert.match(seen.warns[0], /disk full/)
})

// --- T-13: FR-5 counters and /cost ---------------------------------------------
test('T-13 /cost reports the accumulated counters', async () => {
  const { ctx, seen } = fakeContext({ spill: {}, meter: {} })
  apply(ctx, {})
  await trim(seen, exec(), accept([{ type: 'text', text: text(5000) }]))
  await trim(seen, exec('bash', { callId: 'call-2' }), accept([{ type: 'text', text: text(3000) }]))
  await trim(seen, exec(), accept([{ type: 'text', text: text(300) }])) // passes through
  const command = seen.commands.find(c => c.name === 'cost')
  const report = await command.handler({ rawInput: '', signal: new AbortController().signal })
  assert.equal(report.kind, 'success')
  assert.match(report.text, /results seen: 3/)
  assert.match(report.text, /trimmed: 2/)
  assert.match(report.text, /— saved [\d,]+ chars|saved [\d,]+ \(/)
  assert.match(report.text, /est\. tokens saved: [\d,]+/)
})

test('T-13b /cost before any traffic reports zeros without throwing', async () => {
  const { ctx, seen } = fakeContext()
  apply(ctx, {})
  const report = await seen.commands[0].handler({ rawInput: '', signal: new AbortController().signal })
  assert.equal(report.kind, 'success')
  assert.match(report.text, /trimmed: 0/)
})

// --- T-14..T-16: FR-6 config validation ----------------------------------------
test('T-14 unknown config keys are rejected', () => {
  const { ctx } = fakeContext()
  assert.throws(() => apply(ctx, { maxResultCharz: 10 }), /unknown config key/i)
})

test('T-15 head + tail must fit inside the cap', () => {
  const { ctx } = fakeContext()
  assert.throws(() => apply(ctx, { maxResultChars: 100, headChars: 90, tailChars: 90 }), /headChars \+ tailChars/)
})

test('T-16 negative and fractional config values are rejected', () => {
  const { ctx } = fakeContext()
  assert.throws(() => apply(ctx, { maxResultChars: -1 }), /maxResultChars/)
  assert.throws(() => apply(ctx, { maxResultChars: 100.5 }), /maxResultChars/)
  assert.throws(() => apply(ctx, { headChars: -5 }), /headChars/)
})

// --- T-17: FR-8 registrations without optional services -------------------------
test('T-17 apply registers exactly one listener and one command without optional services', () => {
  const { ctx, seen } = fakeContext()
  apply(ctx, {})
  assert.equal(Object.keys(seen.listeners).length, 1)
  assert.ok(seen.listeners['tools/post-execute'])
  assert.equal(seen.commands.length, 1)
  assert.equal(seen.commands[0].name, 'cost')
  assert.ok(seen.commands[0].input?.hint, 'command input hint must not be empty (activation rejects empty hints)')
})

// --- T-18: surrogate-pair edge ---------------------------------------------------
test('T-18 slicing never splits a surrogate pair at either seam', async () => {
  const { ctx, seen } = fakeContext({ spill: {} })
  apply(ctx, { maxResultChars: 2000, headChars: 1500, tailChars: 400 })
  // Emoji A straddles the head seam (units 1499-1500), B straddles the tail
  // seam (~5000 - 383 kept tail = 4617), C sits well inside the kept tail.
  // The exact tail seam depends on the marker's width, so B's survival is not
  // asserted — only that no pair is ever split.
  const original = 'x'.repeat(1499) + '😀' + 'y'.repeat(3115) + '😀' + 'y'.repeat(332) + '😀' + 'y'.repeat(48)
  assert.equal(original.length, 5000)
  const out = await trim(seen, exec(), accept([{ type: 'text', text: original }]))
  const body = out.content[0].text
  assert.ok(body.length <= 2000)
  for (const unit of body) {
    const lone = unit.length === 1 && unit.charCodeAt(0) >= 0xD800 && unit.charCodeAt(0) <= 0xDFFF
    assert.ok(!lone, `lone surrogate U+${unit.codePointAt(0).toString(16)}`)
  }
  // Which emojis survive depends on the exact seam positions; that at least C
  // (well inside the kept tail) arrives whole, and never a half-pair.
  assert.ok([...body].filter(unit => unit === '😀').length >= 1)
})

// --- T-19: NFR population simulation ---------------------------------------------
test('T-19 the shipped default removes ≥50% of char-steps on a measured-shape histogram', async () => {
  const { ctx, seen } = fakeContext({ spill: {} })
  apply(ctx, {}) // defaults: 2000 / 1500 / 400
  // Sizes and step-weights shaped from the 32-session measurement (sizes cluster
  // below 1k with a long tail; see SRS §3). Counts are representative, not exact.
  const histogram = [
    [200, 1600], [800, 1200], [1500, 500], [2500, 400], [4000, 250], [9000, 180], [30000, 103],
  ]
  let before = 0
  let after = 0
  for (const [size, weight] of histogram) {
    before += size * weight
    const out = await trim(seen, exec('web_fetch'), accept([{ type: 'text', text: text(size) }]))
    after += textOf(out.content).length * weight
  }
  assert.ok(after < before, 'trimming must reduce the total')
  assert.ok(1 - after / before >= 0.5, `expected ≥50% reduction, got ${((1 - after / before) * 100).toFixed(1)}%`)
})

// --- T-20: FR-7 no model call ------------------------------------------------------
test('T-20 the trim path needs no LLM service and only awaits the spill save', async () => {
  const { ctx, seen } = fakeContext({ spill: {} })
  assert.equal(ctx.get('llm'), undefined)
  apply(ctx, {})
  const out = await trim(seen, exec(), accept([{ type: 'text', text: text(5000) }]))
  assert.equal(out.kind, 'accept')
  assert.equal(seen.spillCalls.length, 1)
})
