/**
 * Pure helpers of the retry plug: find the prompt a turn started from, rebuild
 * the content to send again, and work out the shrinking geometry.
 *
 * Nothing here touches a service, so every rule in it is testable without a
 * running Harness.
 */

/** Longest accepted prompt text, in characters, that a resend may carry. */
export const MAX_TEXT_CHARS = 100_000

/**
 * Aspect-preserving size that caps the longest edge.
 * @param width - source width in pixels.
 * @param height - source height in pixels.
 * @param maxEdge - allowed longest edge in pixels.
 * @returns the capped size, or undefined when the source already fits (or the input is unusable).
 */
export function longEdge(width, height, maxEdge) {
  const w = Math.round(Number(width))
  const h = Math.round(Number(height))
  const cap = Math.round(Number(maxEdge))
  if (!(w > 0 && h > 0 && cap > 0)) return undefined
  if (Math.max(w, h) <= cap) return undefined
  return w >= h
    ? { width: cap, height: Math.max(1, Math.round(cap * h / w)) }
    : { width: Math.max(1, Math.round(cap * w / h)), height: cap }
}

/**
 * The durable image reference of a block whose longest edge exceeds the cap.
 * @param block - one content block of a user message.
 * @param maxEdge - allowed longest edge in pixels.
 * @returns the reference to shrink, or undefined when this block needs no work.
 */
export function oversizedImage(block, maxEdge) {
  if (block?.type !== 'image') return undefined
  const ref = block.attachment
  if (ref === undefined || ref === null || typeof ref !== 'object') return undefined
  const size = longEdge(ref.width, ref.height, maxEdge)
  return size === undefined ? undefined : { ref, size }
}

/** The model-visible text of one message, concatenated in block order. */
export function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content.flatMap(block => (block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('')
}

/** The image blocks of one message, in block order. */
export function imageBlocks(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content.filter(block => block?.type === 'image' && block.attachment !== undefined && block.attachment !== null)
}

/** Whether a message carries an ordinary human prompt rather than steering or injected context. */
export function isPrompt(message) {
  return message?.role === 'user' && message?.source?.kind === 'user'
}

/**
 * Find the human prompt a retry starts from: the prompt that opened the turn
 * whose closing assistant message is `messageId`.
 *
 * The assistant message is looked up by its durable identity, then the search
 * walks backwards for the nearest ordinary prompt. A message that the log no
 * longer carries (a shadowed or compacted one) falls back to the newest prompt.
 * @param messages - durable messages of the session, oldest first.
 * @param messageId - identity of the finalized assistant message the action belongs to.
 * @returns the prompt message, or undefined when the session has none.
 */
export function findPrompt(messages, messageId) {
  if (!Array.isArray(messages)) return undefined
  const at = typeof messageId === 'string' ? messages.findIndex(message => message?.id === messageId) : -1
  for (let index = at >= 0 ? at : messages.length - 1; index >= 0; index -= 1) {
    if (isPrompt(messages[index])) return messages[index]
  }
  return undefined
}

/**
 * Rebuild the content a resend carries: the durable images of the original
 * prompt, with the same text or with `text` standing in for it.
 *
 * Content kinds a prompt does not own (context notices and the like) are left
 * out, so the resent message is exactly a prompt.
 * @param message - the original prompt message.
 * @param text - replacement text; omit to send the original text unchanged.
 * @returns the ordered content blocks, possibly empty.
 */
export function resendContent(message, text) {
  const content = Array.isArray(message?.content) ? message.content : []
  const images = imageBlocks(message)
  if (typeof text === 'string') {
    const body = text.replace(/\r\n?/g, '\n')
    return body.trim() === '' ? [...images] : [{ type: 'text', text: body }, ...images]
  }
  const blocks = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') blocks.push({ type: 'text', text: block.text })
    else if (block?.type === 'image' && block.attachment !== undefined) blocks.push({ type: 'image', attachment: block.attachment })
  }
  return blocks
}

/**
 * What a resend of one prompt carries, without sending it.
 * @param message - the original prompt message.
 * @returns the prompt text, its image count, and whether there is anything to send.
 */
export function describePrompt(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return {
    text: messageText(message),
    images: imageBlocks(message).length,
    blocks: content.length,
  }
}
