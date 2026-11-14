/**
 * Deal with an image that is already in the session log and too large to send.
 *
 * A request is assembled from the whole durable history, so shrinking the copy
 * on its way in only helps messages that are still new. An image accepted
 * before the plug was installed keeps its size forever, and every later request
 * carries it again.
 *
 * The Harness owns exactly one way to leave such an occurrence out of a
 * request: the `image/offload` decision, whose projection marks selected images
 * so every later request sends placeholder text instead. It is owned by
 * `@deepseek-ai/dsh-compaction-image-offload`, so nothing is recorded unless
 * that projection is mounted — an event nothing interprets would make the
 * session refuse to reopen.
 */
import { longEdge } from './retry.js'

/** The projection that interprets `image/offload`; without it the decision is unreadable. */
const OFFLOAD_EVENT = 'image/offload'

/**
 * Whether the mounted session store interprets `image/offload` events.
 * @param ctx - host context.
 * @returns whether omitting an image occurrence can be recorded.
 */
export function offloadSupported(ctx) {
  const projections = ctx.get('sessions')?.messageProjections
  return Array.isArray(projections) && projections.some(projection => projection?.type === OFFLOAD_EVENT)
}

/**
 * Image occurrences the current request would reject for their dimensions.
 * @param session - the session whose next request is assembled.
 * @param maxEdge - allowed longest edge in pixels.
 * @returns one `{ seq, imageIndexes }` target per affected message, in request order.
 */
export function oversizedTargets(session, maxEdge) {
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes) || typeof session?.eventAt !== 'function' || typeof session?.deriveEventMessage !== 'function') return []
  const targets = []
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
    const imageIndexes = []
    let imageIndex = 0
    for (const block of content) {
      if (block?.type !== 'image') continue
      const ref = block.attachment
      if (block.offloaded !== true && longEdge(ref?.width, ref?.height, maxEdge) !== undefined) imageIndexes.push(imageIndex)
      imageIndex += 1
    }
    if (imageIndexes.length > 0) targets.push({ seq, imageIndexes })
  }
  return targets
}

/**
 * Record one decision leaving every oversized image occurrence out of the
 * request. Occurrences already marked are skipped, so the call is safe to
 * repeat.
 * @param session - the session whose next request is assembled.
 * @param maxEdge - allowed longest edge in pixels.
 * @returns how many occurrences the decision marked.
 */
export function offloadOversized(session, maxEdge) {
  const targets = oversizedTargets(session, maxEdge)
  if (targets.length === 0) return 0
  session.append(OFFLOAD_EVENT, { targets })
  return targets.reduce((total, target) => total + target.imageIndexes.length, 0)
}
