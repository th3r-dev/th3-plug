/**
 * @th3-plug/retry — Host half.
 *
 * Two jobs, both about a prompt that hit a provider limit:
 *
 * 1. **Fit the images.** A route can refuse an image whose longest edge is over
 *    its cap ("At least one of the image dimensions exceed max allowed size for
 *    many-image requests"). Before a step leaves the process, every oversized
 *    image is replaced in the request batch by a smaller durable copy of the
 *    same picture, so the request is accepted and the transcript keeps the
 *    original. An image that was committed before the plug existed is left out
 *    of the request instead — see `offload.js`.
 * 2. **Send a prompt again.** Two authenticated routes let the Web actions read
 *    the prompt behind an assistant message and send it again — with its images,
 *    or with text the user edited first.
 *
 * Register everything inside `apply` so unloading the plug removes it again.
 */
import { randomUUID } from 'node:crypto'
import { shrinkMessages } from './images.js'
import { offloadOversized, offloadSupported } from './offload.js'
import {
  MAX_TEXT_CHARS, describePrompt, findPrompt, imageBlocks, resendContent,
} from './retry.js'

export const name = 'th3-retry'

const DEFAULTS = {
  /** Longest image edge, in pixels, a model request may carry. */
  maxEdge: 2000,
  /** Encoded-byte target for one shrunken image. */
  maxBytes: 1024 * 1024,
  /** Shrink oversized request images (off keeps only the resend actions working). */
  shrink: true,
  /** Leave an image committed before this plug was installed out of later requests. */
  offload: true,
}

/**
 * Provider wording for the dimension refusal this plug exists for. Nothing else
 * is treated as one, so an unrelated failure never drops an image.
 */
const DIMENSION_FAILURE = /(exceed[s]?\s+(the\s+)?max\s+allowed\s+size|image\s+dimensions?\s+exceed|image\s+dimensions?\s+are\s+too\s+large)/i

/** Authenticated route returning the prompt behind one assistant message. */
const PROMPT_PATH = '/api/th3-retry/prompt'
/** Authenticated route sending that prompt again. */
const SEND_PATH = '/api/th3-retry/send'

/** Refuse a request body larger than this many bytes. */
const MAX_BODY_BYTES = 1024 * 1024

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Read one JSON request body, refusing an oversized or malformed one. */
async function readBody(request) {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, 'the request body is too large')
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'the request body is too large')
  if (text.trim() === '') return {}
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'the request body is not JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'the request body must be a JSON object')
  return value
}

/** Freeze one message the way the Session log expects to receive it. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/** Build one identified user message for the agent inbox. */
function userMessage(content) {
  return deepFreeze({ id: randomUUID(), role: 'user', content, source: { kind: 'user' } })
}

/** Whether a value is a live Agent handle rather than a failure carrier. */
function isAgent(value) {
  return value !== null && typeof value === 'object' && typeof value.followup === 'function' && value.session !== undefined
}

/**
 * The live agent of one session, resuming a cold session when the Harness can.
 *
 * The registry only holds live agents, and the session controller answers with
 * either an agent or a failure carrier, so anything that is not an agent handle
 * means this Harness cannot address that session.
 * @param ctx - host context.
 * @param sessionId - session the Web action addressed.
 * @returns the live agent.
 */
async function agentFor(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') throw new HttpError(400, 'sessionId is required')
  const live = ctx.get('agents')?.get(sessionId)
  if (isAgent(live)) return live
  const controller = ctx.get('sessionController')
  if (typeof controller?.resolveAgent === 'function') {
    let found
    try {
      found = await controller.resolveAgent(sessionId)
    } catch (error) {
      throw new HttpError(404, `session ${sessionId} cannot be opened: ${String(error?.message ?? error)}`)
    }
    if (isAgent(found)) return found
  }
  throw new HttpError(404, `session ${sessionId} is not open in this Harness`)
}

/**
 * The durable messages of one live agent, oldest first.
 * @param agent - the session's agent.
 * @returns the messages the model would see, or an empty list when unreadable.
 */
function messagesOf(agent) {
  try {
    const messages = agent?.session?.deriveMessages?.()
    return Array.isArray(messages) ? messages : []
  } catch {
    return []
  }
}

/**
 * Whether the session's current model accepts images.
 * @param ctx - host context.
 * @param agent - the session's agent.
 * @returns false only when the model is known to be text-only.
 */
async function takesImages(ctx, agent) {
  try {
    const current = agent?.model?.current?.()
    const llm = ctx.get('llm')
    if (current === undefined || typeof llm?.resolveModelInfo !== 'function') return true
    const info = await llm.resolveModelInfo(current.provider, current.model)
    const modalities = info?.inputModalities
    return Array.isArray(modalities) ? modalities.includes('image') : true
  } catch {
    return true
  }
}

/**
 * Admit prompt content again so stored images are re-checked against the limits.
 * @param ctx - host context.
 * @param content - ordered prompt blocks to send.
 * @returns the admitted blocks.
 */
async function admit(ctx, content) {
  const attachments = ctx.get('attachments')
  if (!content.some(block => block.type === 'image')) return content
  if (typeof attachments?.admitPromptContent !== 'function') return content
  return await attachments.admitPromptContent(content)
}

/**
 * Resolve one prompt behind the assistant message an action names.
 * @param ctx - host context.
 * @param sessionId - addressed session.
 * @param messageId - the finalized assistant message the action belongs to.
 * @returns the agent and the prompt it answers.
 */
async function promptOf(ctx, sessionId, messageId) {
  const agent = await agentFor(ctx, sessionId)
  const prompt = findPrompt(messagesOf(agent), typeof messageId === 'string' ? messageId : undefined)
  if (prompt === undefined) throw new HttpError(404, 'this session has no earlier prompt to send again')
  return { agent, prompt }
}

/** Report a stored error as one JSON body the Web action can display. */
function failure(error) {
  const status = error instanceof HttpError ? error.status : 500
  return json({ ok: false, error: String(error?.message ?? error) }, status)
}

export function apply(ctx, config = {}) {
  const options = {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(config ?? {}).filter(([, value]) => value !== undefined && value !== null)),
  }
  /** Settled and in-flight shrinks, keyed by image identity and target. */
  const variants = new Map()
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`th3-retry: ${message}`)
    } catch { /* logging must never break a turn */ }
  }

  // ---- fit the images of every request -------------------------------------
  if (options.shrink !== false) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision?.kind !== 'enter' || payload?.signal?.aborted === true) return decision
      try {
        const messages = await shrinkMessages(decision.messages, ctx.get('attachments'), options, variants, warn)
        return messages === decision.messages ? decision : { ...decision, messages }
      } catch (error) {
        warn(`image shrinking failed: ${String(error?.message ?? error)}`)
        return decision
      }
    })
  }

  // ---- deal with an image committed before this plug was installed ---------
  if (options.offload !== false) {
    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      if (signal?.aborted === true || !DIMENSION_FAILURE.test(`${failure?.message ?? ''} ${failure?.code ?? ''}`)) return next()
      if (!offloadSupported(ctx)) return next()
      let marked = 0
      try {
        marked = offloadOversized(agent?.session, options.maxEdge)
      } catch (error) {
        warn(`could not omit an oversized historical image: ${String(error?.message ?? error)}`)
        return next()
      }
      if (marked === 0) return next()
      return { kind: 'retry' }
    })
  }

  // ---- read and re-send a previous prompt ----------------------------------
  ctx.inject(['connection'], (scope) => {
    scope.connection.fetch.register({
      path: PROMPT_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await readBody(request)
          const { prompt } = await promptOf(ctx, body.sessionId, body.messageId)
          return json({ ok: true, ...describePrompt(prompt) })
        } catch (error) {
          return failure(error)
        }
      },
    })
    scope.connection.fetch.register({
      path: SEND_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await readBody(request)
          const text = body.text === undefined || body.text === null ? undefined : String(body.text)
          if (text !== undefined && text.length > MAX_TEXT_CHARS) throw new HttpError(413, `the edited prompt is longer than ${MAX_TEXT_CHARS} characters`)
          const { agent, prompt } = await promptOf(ctx, body.sessionId, body.messageId)
          let content = resendContent(prompt, text)
          if (content.length === 0) throw new HttpError(400, 'that prompt has no text or image to send again')
          let dropped = 0
          if (content.some(block => block.type === 'image') && !await takesImages(ctx, agent)) {
            dropped = imageBlocks(prompt).length
            content = content.filter(block => block.type !== 'image')
          }
          // The prompt being re-sent is still the largest image in the request:
          // its stored copy goes out of the model's view, its fresh copy goes in.
          let offloaded = 0
          if (options.offload !== false && offloadSupported(ctx)) {
            try {
              offloaded = offloadOversized(agent.session, options.maxEdge)
            } catch (error) {
              warn(`could not omit an oversized historical image: ${String(error?.message ?? error)}`)
            }
          }
          agent.followup(userMessage(await admit(ctx, content)))
          return json({ ok: true, images: imageBlocks(prompt).length - dropped, dropped, offloaded })
        } catch (error) {
          return failure(error)
        }
      },
    })
  })
}

/** Paths the Web half posts to; exported for tests and documentation. */
export const ROUTES = { prompt: PROMPT_PATH, send: SEND_PATH }
