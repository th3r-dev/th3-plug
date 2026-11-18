/**
 * Image accounting for one model request.
 *
 * A request is assembled from the whole durable history every step, so the
 * only way to stop an old picture from being sent again is to record that the
 * Harness should leave it out. `image/offload` is that decision: its projection
 * (owned by `@deepseek-ai/dsh-compaction-image-offload`) marks selected image
 * occurrences, and every later request renders them as placeholder text naming
 * the attachment instead of sending its bytes.
 *
 * This module counts the occurrences the model would receive, chooses the
 * oldest ones over a budget, and appends one decision. It is pure apart from
 * the final `session.append`, so the selection is easy to test.
 */

/** The durable decision the Harness's image-offload projection interprets. */
export const OFFLOAD_EVENT = 'image/offload'

/**
 * Whether the mounted session store interprets `image/offload` events.
 *
 * An event nothing interprets makes a session refuse to reopen, so the plug
 * must not record one on a profile that does not mount the projection.
 *
 * @param ctx - Host context.
 * @returns whether omitting an image occurrence can be recorded.
 */
export function offloadSupported(ctx) {
  const projections = ctx.get('sessions')?.messageProjections
  return Array.isArray(projections) && projections.some(projection => projection?.type === OFFLOAD_EVENT)
}

/**
 * Image occurrences the next request would carry, oldest first.
 *
 * The surface is walked in model order. Assistant nodes are model output and
 * carry no input images; only `user/message` and `tool/result` events do.
 * `imageIndex` is the depth-first index among every image block of that
 * message, including occurrences already offloaded, because the projection
 * addresses occurrences by that index.
 *
 * @param session - Session whose next request is assembled.
 * @returns `{ seq, imageIndex }` for every occurrence still sent as an image.
 */
export function liveImageOccurrences(session) {
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes)
    || typeof session?.eventAt !== 'function'
    || typeof session?.deriveEventMessage !== 'function') return []
  const occurrences = []
  for (const seq of nodes) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      continue
    }
    if (event?.type !== 'user/message' && event?.type !== 'tool/result') continue
    let message
    try {
      message = session.deriveEventMessage(event)
    } catch {
      continue
    }
    const content = Array.isArray(message?.content) ? message.content : []
    let imageIndex = 0
    for (const block of content) {
      if (block?.type !== 'image') continue
      if (block.offloaded !== true) occurrences.push({ seq, imageIndex })
      imageIndex += 1
    }
  }
  return occurrences
}

/**
 * Images a step's claimed messages add to the request.
 *
 * `agent/pre-step` hands over the messages still entering the session; they
 * are not surface nodes yet, so they cannot be addressed by an offload
 * decision, but they do count against the same request budget.
 *
 * @param messages - Messages claimed for the step.
 * @returns how many image blocks they hold.
 */
export function countClaimedImages(messages) {
  if (!Array.isArray(messages)) return 0
  let count = 0
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : []
    for (const block of content) if (block?.type === 'image') count += 1
  }
  return count
}

/**
 * Group the oldest occurrences into one `image/offload` decision.
 *
 * @param occurrences - Live occurrences oldest first.
 * @param keep - How many of the newest occurrences must stay as images.
 * @returns Targets grouped by message, with strictly increasing indexes.
 */
export function planTargets(occurrences, keep) {
  if (!Array.isArray(occurrences)) return []
  const excess = Math.max(0, occurrences.length - Math.max(0, keep))
  if (excess === 0) return []
  const targets = []
  let current
  for (const occurrence of occurrences.slice(0, excess)) {
    if (current !== undefined && current.seq === occurrence.seq) current.imageIndexes.push(occurrence.imageIndex)
    else {
      current = { seq: occurrence.seq, imageIndexes: [occurrence.imageIndex] }
      targets.push(current)
    }
  }
  return targets
}

/**
 * Keep only the newest images in one session's model history.
 *
 * Images entering with the current step are reserved first, then the oldest
 * occurrences already in the log are omitted until the request fits. The
 * decision is recorded durably, so later steps do not carry those images
 * again.
 *
 * @param session - Session whose next request is assembled.
 * @param maxImages - Images one request may carry.
 * @param claimedImages - Images the step's new messages add.
 * @returns what the decision did and what it could not fix.
 */
export function reconcileSession(session, maxImages, claimedImages = 0) {
  const live = liveImageOccurrences(session)
  const claimed = Math.max(0, claimedImages)
  const budget = Math.max(0, maxImages - claimed)
  const targets = planTargets(live, budget)
  const offloaded = targets.reduce((total, target) => total + target.imageIndexes.length, 0)
  if (offloaded > 0) session.append(OFFLOAD_EVENT, { targets })
  return {
    /** Images the next request would have carried before the decision. */
    images: live.length + claimed,
    /** Images already in the log before the decision. */
    live: live.length,
    /** Images entering with this step. */
    claimed,
    /** Occurrences this decision omitted. */
    offloaded,
    /** Occurrences still sent as images. */
    kept: live.length - offloaded,
    /** Images over the cap that this step cannot omit (they are still new). */
    overflow: Math.max(0, live.length + claimed - offloaded - maxImages),
  }
}
