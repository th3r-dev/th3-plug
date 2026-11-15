/**
 * @th3-plug/token-diet — Host half.
 *
 * Bounds every accepted tool result at first delivery (`tools/post-execute`)
 * to `maxResultChars`, keeping the head and the tail and replacing the middle
 * with a marker that names the spill file holding the complete original text.
 * The built-in pipeline only bounds results once compaction pressure hits;
 * this plug trims before the text is ever sent, so every later request in the
 * session pays the bounded size instead. `/cost` reports the savings to the
 * human; it is never model-visible.
 *
 * Fail-open everywhere: without a spill backend, or when the save rejects, the
 * original content stays inline — a successful tool call is never turned into
 * an error, mirroring the shipped `dsh-spill-policy` behaviour.
 */

export const name = 'th3-token-diet'

/** Services this plug needs. Optional ones are read with `ctx.get(name)`. */
export const inject = ['commands']

/** Defaults for the `config` block in cordis.patch.yml; documented in the plug README. */
const DEFAULTS = {
  /** Slash-command name, typed as `/<command>`. */
  command: 'cost',
  /** Trim when the combined text of a result exceeds this many UTF-16 code units. */
  maxResultChars: 2000,
  /** Leading code units kept from an oversized result. */
  headChars: 1500,
  /** Trailing code units kept from an oversized result. */
  tailChars: 400,
}

const CONFIG_KEYS = new Set(Object.keys(DEFAULTS))
/** Marker template length with empty locator/hint and one-digit counts. */
const MIN_MARKER = 48
/** The shipped spill policy's notice text; results carrying it are already bounded. */
const BUILTIN_NOTICE = 'Full formatted result stored at:'
/** This plug's marker head; results carrying it were already trimmed here. */
export const MARK = 'token-diet:'

/** The marker this plug writes; exported for the idempotency test. */
export function markOf(omitted, total, locator, hint) {
  return `${MARK} omitted ${omitted} of ${total} chars; full result: ${locator} — ${hint}`
}

/** The `\n\n[... ...]\n\n` wrapper around the marker, derived so it can never drift. */
const wrapped = (omitted, total, locator, hint) => `\n\n[... ${markOf(omitted, total, locator, hint)} ...]\n\n`
const WRAPPER = wrapped(0, 0, '', '').length - markOf(0, 0, '', '').length

export function apply(ctx, config = {}) {
  const options = resolveConfig(config)
  const max = options.maxResultChars
  const head = options.headChars
  const tail = options.tailChars

  /** Cumulative counters for the human-facing `/cost` readout. */
  const stats = { seen: 0, trimmed: 0, originalChars: 0, sentChars: 0, tokensSaved: 0 }

  // Optional services: the plug still loads and reports when they are absent,
  // it just cannot trim without somewhere to keep the full text.
  const meter = readOptional(ctx, 'tokenMeter')

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: options.command,
      description: 'Token Diet: report input tokens saved by trimming tool results at first delivery.',
      input: { hint: '[report]' },
      handler: async () => ({ kind: 'success', text: report(stats, options, hasSpill(ctx)) }),
    })

    yield ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (!isTrimCandidate(decision, exec)) return decision
      const content = decision.content ?? result?.content
      if (!isAllText(content)) return decision
      const full = content.map(block => block.text).join('')
      stats.seen += 1
      if (full.includes(BUILTIN_NOTICE) || full.includes(MARK)) return decision
      if (full.length <= max) return decision
      const replacement = await bounded(ctx, exec, content, full, max, head, tail)
      if (replacement === undefined) return decision
      recordSave(stats, meter, content, replacement)
      return { ...decision, content: replacement }
    })
  }, 'th3-token-diet lifecycle')
}

/** Validate and detach the config; unknown keys or bad numbers fail the load. */
function resolveConfig(config) {
  const merged = { ...DEFAULTS, ...dropEmpty(config) }
  for (const key of Object.keys(config ?? {})) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`token-diet: unknown config key "${key}"`)
  }
  for (const key of ['maxResultChars', 'headChars', 'tailChars']) {
    const value = merged[key]
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`token-diet: ${key} must be a non-negative integer (got ${value})`)
    }
  }
  if (!/^[a-z0-9_-]+$/.test(merged.command)) {
    throw new Error(`token-diet: command must be lower-case letters, digits, _ or - (got ${merged.command})`)
  }
  if (merged.headChars + merged.tailChars + MIN_MARKER > merged.maxResultChars) {
    throw new Error(
      `token-diet: headChars + tailChars + ${MIN_MARKER} must fit within maxResultChars `
      + `(${merged.headChars} + ${merged.tailChars} > ${merged.maxResultChars} - ${MIN_MARKER})`,
    )
  }
  return merged
}

/**
 * Replace the text of an oversized all-text result with head + marker + tail.
 * Returns undefined (and logs) when the plug cannot keep the full text
 * recoverable — the original content stays inline in that case.
 */
async function bounded(ctx, exec, content, full, max, headChars, tailChars) {
  try {
    const spillStore = ctx.get?.('spillStore')
    if (spillStore === undefined) throw new Error('no ctx.spillStore backend loaded')
    const owner = exec?.agent?.session?.header?.id
    if (owner === undefined) throw new Error(`no session owner for ${exec?.name ?? 'tool'} result`)
    const ref = await spillStore.saveText({
      owner: { sessionId: owner },
      source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'result' },
      suggestedName: `${exec.name}.txt`,
      content: full,
    })
    const replacement = sliceAroundMarker(full, max, headChars, tailChars, ref)
    return replacement
  } catch (error) {
    ctx.logger?.warn?.(`token-diet: ${String(error)}; keeping the inline content`)
    return undefined
  }
}

/**
 * Build the bounded content. The marker embeds the locator, whose length is
 * unknown at load time, so the head and tail are clamped to what remains of
 * the cap after the widest marker this result could produce. Slicing adjusts
 * the seams so a surrogate pair is never split.
 */
function sliceAroundMarker(full, max, headChars, tailChars, ref) {
  const locator = String(ref?.locator ?? '')
  const hint = String(ref?.retrievalHint ?? '')
  // Upper bound: the omitted count can never have more digits than the full length.
  const markerMax = WRAPPER + markOf(full.length, full.length, locator, hint).length
  const budget = max - markerMax
  if (budget < 1) return undefined // marker alone would not fit; keep the original
  const headLen = Math.min(headChars, budget)
  const tailLen = Math.min(tailChars, Math.max(0, budget - headLen))
  const headText = safeSlice(full, 0, headLen)
  const tailText = safeSlice(full, full.length - tailLen, full.length)
  const omitted = full.length - headText.length - tailText.length
  const marker = wrapped(omitted, full.length, locator, hint)
  return [{ type: 'text', text: `${headText}${marker}${tailText}` }]
}

/** Slicing never splits a surrogate pair: inspect raw UTF-16 units, not code points. */
function safeSlice(text, start, end) {
  const isLow = unit => unit >= 0xDC00 && unit <= 0xDFFF
  const isHigh = unit => unit >= 0xD800 && unit <= 0xDBFF
  while (start < end && isLow(text.charCodeAt(start))) start += 1
  while (end > start && end < text.length && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) end -= 1
  return text.slice(Math.max(0, start), Math.max(start, Math.min(end, text.length)))
}

/** The waterfall rules every pass-through case satisfies before measuring. */
function isTrimCandidate(decision, exec) {
  if (!decision || decision.kind !== 'accept') return false
  if (Object.hasOwn(decision, 'value')) return false
  if (exec?.name === 'read') return false
  if (exec?.parent !== undefined) return false // PTC dispatch copies are the ptc-dispatch-log seam's business
  return true
}

function isAllText(content) {
  return Array.isArray(content)
    && content.length > 0
    && content.every(block => block && block.type === 'text' && typeof block.text === 'string')
}

/** Update the counters, pricing with the mounted meter when available. */
function recordSave(stats, meter, before, after) {
  const originalChars = textLength(before)
  const sentChars = textLength(after)
  const beforeTokens = estimate(meter, before)
  const afterTokens = estimate(meter, after)
  stats.trimmed += 1
  stats.originalChars += originalChars
  stats.sentChars += sentChars
  if (beforeTokens !== undefined && afterTokens !== undefined) {
    stats.tokensSaved += Math.max(0, beforeTokens - afterTokens)
  }
}

function textLength(content) {
  return content.reduce((total, block) => total + (block.text?.length ?? 0), 0)
}

function estimate(meter, content) {
  try {
    if (meter?.estimateMessage) return meter.estimateMessage({ role: 'tool', content })
    return Math.ceil(textLength(content) / 4) + 4 // the token meter's fixed heuristic
  } catch {
    return undefined
  }
}

function hasSpill(ctx) {
  return ctx.get?.('spillStore') !== undefined
}

/** The human-facing `/cost` text. Never model-visible: command results are not history. */
function report(stats, options, spill) {
  const saved = stats.originalChars - stats.sentChars
  const pct = stats.trimmed > 0 && stats.originalChars > 0
    ? ` (${Math.round((100 * saved) / stats.originalChars)}%)`
    : ''
  const lines = [
    'Token Diet — since load:',
    `  tool results seen: ${fmt(stats.seen)}`,
    `  trimmed: ${fmt(stats.trimmed)}${stats.seen > 0 ? ` (${Math.round((100 * stats.trimmed) / stats.seen)}%)` : ''}`,
    `  tool-result chars: ${fmt(stats.originalChars)} → ${fmt(stats.sentChars)} — saved ${fmt(saved)}${pct}`,
    `  est. tokens saved: ${fmt(stats.tokensSaved)} (4 chars/token heuristic)`,
    `  config: max ${fmt(options.maxResultChars)} chars (head ${fmt(options.headChars)} / tail ${fmt(options.tailChars)})`,
  ]
  if (!spill) lines.push('  note: no spill backend mounted — oversized results are kept inline (nothing is trimmed).')
  return lines.join('\n')
}

const fmt = value => value.toLocaleString('en-US')

function readOptional(ctx, name) {
  try { return ctx.get?.(name) } catch { return undefined }
}

function dropEmpty(config) {
  return Object.fromEntries(Object.entries(config ?? {}).filter(([, value]) => value !== undefined && value !== null))
}
