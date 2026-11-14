/**
 * Shrink the images one model request carries, so a route whose provider caps
 * image dimensions never refuses the request.
 *
 * The work happens on the durable attachment the prompt already holds, through
 * the mounted attachment service: it reads a resized model-request version of
 * that image and stores it as one more durable attachment. The message the
 * user sees keeps its own picture; only the request that leaves the process
 * carries the smaller copy, which is also what a retry of the same prompt
 * sends again.
 */
import { oversizedImage } from './retry.js'

/** Key one shrink operation by everything its result depends on. */
function variantKey(ref, options) {
  return `${String(ref.attachmentId)}|${options.maxEdge}|${options.maxBytes}`
}

/**
 * Store one shrunken copy of an oversized durable image.
 * @param ref - the durable image reference to shrink.
 * @param size - the capped dimensions.
 * @param attachments - the mounted attachment service.
 * @param options - resolved `maxEdge` and `maxBytes`.
 * @returns the durable reference of the smaller copy.
 */
async function shrinkOne(ref, size, attachments, options) {
  const image = await attachments.readImageRequest(ref, {
    width: size.width,
    height: size.height,
    maxBytes: options.maxBytes,
  })
  const [saved] = await attachments.saveImages([{
    mediaType: image.mediaType,
    data: image.data,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  }])
  if (saved === undefined) throw new Error('the attachment service stored no image')
  return saved
}

/**
 * The shrunken reference for one image, computed once per image and target.
 * @param ref - the durable image reference to shrink.
 * @param size - the capped dimensions.
 * @param attachments - the mounted attachment service.
 * @param options - resolved `maxEdge` and `maxBytes`.
 * @param cache - per-plugin map of in-flight and settled shrinks.
 * @returns the durable reference to send instead.
 */
function shrunken(ref, size, attachments, options, cache) {
  const key = variantKey(ref, options)
  const known = cache.get(key)
  if (known !== undefined) return known
  const pending = shrinkOne(ref, size, attachments, options).catch((error) => {
    cache.delete(key)
    throw error
  })
  cache.set(key, pending)
  return pending
}

/**
 * Whether one message carries an image that needs shrinking.
 * @param message - one message of the request batch.
 * @param maxEdge - allowed longest edge in pixels.
 * @returns whether the message must be rebuilt.
 */
function needsWork(message, maxEdge) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content.some(block => oversizedImage(block, maxEdge) !== undefined)
}

/**
 * Replace every oversized image of one message batch with a smaller copy.
 *
 * A message without an oversized image is passed through as the same object, and
 * a batch that needs no work comes back as the same array, so the caller can tell
 * the cheap case apart. One image that cannot be shrunk leaves its own block
 * untouched: the request then fails the way it did before instead of failing for
 * a new reason.
 * @param messages - the batch a step would send.
 * @param attachments - the mounted attachment service, or undefined.
 * @param options - resolved `maxEdge` and `maxBytes`.
 * @param cache - per-plugin map of in-flight and settled shrinks.
 * @param warn - sink for one image's failure.
 * @returns the batch to send.
 */
export async function shrinkMessages(messages, attachments, options, cache, warn = () => {}) {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  if (typeof attachments?.readImageRequest !== 'function') return messages
  if (typeof attachments?.saveImages !== 'function') return messages
  if (!(options.maxEdge > 0)) return messages
  if (!messages.some(message => needsWork(message, options.maxEdge))) return messages

  const next = []
  for (const message of messages) {
    if (!needsWork(message, options.maxEdge)) {
      next.push(message)
      continue
    }
    const content = []
    for (const block of message.content) {
      const oversized = oversizedImage(block, options.maxEdge)
      if (oversized === undefined) {
        content.push(block)
        continue
      }
      try {
        const ref = await shrunken(oversized.ref, oversized.size, attachments, options, cache)
        content.push({ ...block, attachment: ref })
      } catch (error) {
        warn(`could not shrink image ${String(oversized.ref.attachmentId)}: ${String(error?.message ?? error)}`)
        content.push(block)
      }
    }
    next.push({ ...message, content })
  }
  return next
}
