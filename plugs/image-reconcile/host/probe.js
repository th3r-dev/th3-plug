/**
 * Measure a route's real image budget with the profile's own credentials.
 *
 * A provider that does not document its image count (the Tokenme gateway) is
 * found by asking it: tiny 1×1 PNGs are sent to the model through the mounted
 * `llm` service until the route starts refusing. The search is a baseline plus
 * a binary search, so the worst case is a handful of small requests — and only
 * when the user runs `/imagereconcile probe`, which is the permission the
 * measurement needs.
 *
 * The probe images are all different colours, not copies of one file: a
 * gateway that deduplicated identical images would otherwise report a budget
 * far above the real one.
 */
import { deflateSync } from 'node:zlib'

/** How many distinct probe images are prepared; counts beyond this reuse them. */
export const PROBE_IMAGES = 32

/** Where the search stops when the route keeps accepting: `at least N`. */
export const SEARCH_CAP = 100

/** Standard CRC-32 table, computed once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 of one buffer, as the PNG spec sizes it. */
function crc32(buffer) {
  let crc = 0xFFFFFFFF
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

/** One PNG chunk: length, type, data, CRC. */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * A 1×1 true-colour PNG of one colour.
 * @param red - 0–255.
 * @param green - 0–255.
 * @param blue - 0–255.
 * @returns the encoded PNG bytes.
 */
export function tinyPng(red, green, blue) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)  // width
  header.writeUInt32BE(1, 4)  // height
  header[8] = 8               // bit depth
  header[9] = 2               // colour type: truecolour
  // compression, filter, interlace are all 0
  const pixels = Buffer.from([0, red & 0xFF, green & 0xFF, blue & 0xFF])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Store the distinct probe images once.
 * @param attachments - the mounted attachment service.
 * @returns their durable references, in a stable order.
 */
async function probeImages(attachments) {
  const inputs = []
  for (let i = 0; i < PROBE_IMAGES; i += 1) {
    inputs.push({ mediaType: 'image/png', data: tinyPng((i * 37) & 0xFF, (i * 73) & 0xFF, (i * 109) & 0xFF) })
  }
  return await attachments.saveImages(inputs)
}

/**
 * Send one probe request with `count` tiny images.
 *
 * @param ctx - host context.
 * @param route - the provider and model to measure.
 * @param refs - distinct probe-image references.
 * @param count - images to send.
 * @param timeoutMs - abort budget for the request.
 * @returns whether the route accepted the request.
 */
async function accept(ctx, route, refs, count, timeoutMs) {
  const llm = ctx.get('llm')
  const content = []
  for (let i = 0; i < count; i += 1) content.push({ type: 'image', attachment: refs[i % refs.length] })
  content.push({ type: 'text', text: `You received ${count} images. Reply with only the number.` })
  const options = {
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content }],
    system: 'You are an image-counting probe. Reply with a single integer.',
    maxTokens: 8,
    signal: AbortSignal.timeout(timeoutMs),
  }
  try {
    for await (const _chunk of llm.stream(options)) { /* the answer is irrelevant */ }
    return true
  } catch {
    return false
  }
}

/** Binary search for the largest accepted count between `lo` (accepted) and `hi` (refused). */
async function searchBetween(ctx, route, refs, lo, hi, timeoutMs, tested) {
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    tested.push(mid)
    if (await accept(ctx, route, refs, mid, timeoutMs)) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * Probe one provider route for its image budget.
 *
 * @param ctx - host context (needs the `attachments` and `llm` services).
 * @param provider - provider route to measure.
 * @param model - model id to measure.
 * @param timeoutMs - abort budget per probe request.
 * @returns `{ ok, limit?, note?, requests, at }` on success, or
 * `{ ok: false, error }` when nothing could be measured.
 */
export async function probeImageLimit(ctx, provider, model, timeoutMs = 60_000) {
  const llm = ctx.get('llm')
  const attachments = ctx.get('attachments')
  if (typeof llm?.stream !== 'function') throw new Error('the llm service is not mounted')
  if (typeof attachments?.saveImages !== 'function') throw new Error('the attachments service is not mounted')

  // A text-only route has no image budget to measure.
  try {
    const info = await llm.resolveModelInfo?.(provider, model)
    const modalities = info?.inputModalities
    if (Array.isArray(modalities) && !modalities.includes('image')) {
      return { ok: false, error: `${provider}/${model} is text-only; there is no image budget to measure` }
    }
  } catch { /* model info is optional; the baseline request decides */ }

  const route = { provider, model }
  const refs = await probeImages(attachments)
  const tested = []
  const at = new Date().toISOString()

  const baseline = await accept(ctx, route, refs, 1, timeoutMs)
  tested.push(1)
  if (!baseline) {
    return { ok: false, error: `even a single-image request was refused by ${provider}/${model}; the probe cannot tell why (check the model and credentials)`, requests: tested.length, at }
  }

  let limit
  if (!(await accept(ctx, route, refs, 9, timeoutMs))) {
    tested.push(9)
    limit = await searchBetween(ctx, route, refs, 1, 9, timeoutMs, tested)
  } else {
    tested.push(9)
    if (!(await accept(ctx, route, refs, 32, timeoutMs))) {
      tested.push(32)
      limit = await searchBetween(ctx, route, refs, 9, 32, timeoutMs, tested)
    } else {
      tested.push(32)
      if (!(await accept(ctx, route, refs, SEARCH_CAP, timeoutMs))) {
        tested.push(SEARCH_CAP)
        limit = await searchBetween(ctx, route, refs, 32, SEARCH_CAP, timeoutMs, tested)
      } else {
        tested.push(SEARCH_CAP)
        limit = SEARCH_CAP
      }
    }
  }

  const note = limit === SEARCH_CAP
    ? `the route accepted ${SEARCH_CAP} images, so the real cap is at least that; the probe stops searching there`
    : undefined
  return { ok: true, limit, note, requests: tested.length, at }
}
