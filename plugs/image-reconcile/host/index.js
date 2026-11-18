/**
 * @th3-plug/image-reconcile — Host half.
 *
 * A route with a small per-request image budget (the Tokenme gateway refuses
 * a ninth image) fails every turn once the conversation holds more images
 * than that: the Harness resends the whole history each request. Deleting the
 * images is not an option, and the request itself cannot be rewritten because
 * the history is derived before the step's claimed batch is even committed.
 *
 * So before each step leaves the process, the plug resolves the image budget
 * for the step's model and records the oldest occurrences over that budget as
 * `image/offload`. Every later step then sends the Harness's own omitted-image
 * note instead of the image bytes: the attachment's name and read-only path.
 * The newest images stay, the transcript stays, and the turn stops failing.
 *
 * A route with no known budget is left alone rather than guessed at — the
 * refusal then suggests `/imagereconcile probe`, the user's explicit
 * permission to measure it with tiny test requests through the profile's own
 * credentials.
 *
 * The decision needs `@deepseek-ai/dsh-compaction-image-offload` mounted (the
 * shipped base composition mounts it). Without it the plug changes nothing
 * rather than write an event no projection interprets.
 */
import { resolveLimit } from './limits.js'
import { probeImageLimit } from './probe.js'
import { countClaimedImages, offloadSupported, reconcileSession } from './trim.js'

export const name = 'th3-image-reconcile'

/** Defaults for the `config` block in cordis.patch.yml. */
const DEFAULTS = {
  /** Reconcile images before every model request. */
  enabled: true,
  /**
   * Known budgets, keyed by `provider` or `provider/model`. The shipped
   * default is empty: an observed cap (Tokenme's 8) and documented caps live
   * in `limits.js`, below a probe, so measuring can correct them.
   */
  limits: {},
  /** Explicit budget for routes with no known limit; 0 leaves them alone. */
  defaultLimit: 0,
  /** Slash command that trims the session, prints the budget, and probes. */
  command: 'imagereconcile',
  /** Abort budget for one probe request, in milliseconds. */
  probeTimeoutMs: 60_000,
}

/**
 * One sentence for the command panel about the budget in force.
 * @param resolution - the `resolveLimit` result.
 * @param route - the `provider/model` the budget applies to.
 * @returns the sentence.
 */
function budgetSentence(resolution, route) {
  if (resolution.source === 'none') {
    return `No image budget is known for ${route}; nothing was omitted. Measure it with /imagereconcile probe ${route}, or set limits in the plug config.`
  }
  const where = {
    config: 'set in the plug config',
    probed: `measured by /imagereconcile probe this session (for ${route})`,
    documented: `documented by the provider (${route})`,
    observed: 'observed in this profile (confirm it with /imagereconcile probe)',
    fallback: 'the configured defaultLimit (no documented or measured limit is known for this route)',
  }[resolution.source]
  return `Image budget: ${resolution.limit} image(s) per request, ${where}.`
}

/**
 * Parse the optional `probe` action and its `provider[/model...]` argument.
 * @param rawInput - everything after the command name.
 * @returns `{ probe, route }` for the action to take.
 */
function parseCommand(rawInput) {
  const parts = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  const probe = parts.includes('probe')
  const route = probe ? parts.filter(part => part !== 'probe').join(' ') : ''
  return { probe, route }
}

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...dropEmpty(config) }
  if (options.enabled === false) return
  if (options.limits !== undefined && (options.limits === null || typeof options.limits !== 'object')) {
    options.limits = DEFAULTS.limits
  }
  const limits = options.limits
  const defaultLimit = Number.isFinite(options.defaultLimit) ? Math.max(0, Math.trunc(options.defaultLimit)) : DEFAULTS.defaultLimit
  const probeTimeoutMs = Number.isFinite(options.probeTimeoutMs) && options.probeTimeoutMs > 0
    ? Math.trunc(options.probeTimeoutMs)
    : DEFAULTS.probeTimeoutMs
  /** Budgets measured this process, `provider` or `provider/model` → number. */
  const learned = new Map()
  /** Routes already warned about, so one missing budget does not spam. */
  const warnedRoutes = new Set()
  let warnedUnsupported = false
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`th3-image-reconcile: ${message}`)
    } catch { /* logging must never break a turn */ }
  }

  /** The budget for one step's model selection. */
  const budgetFor = (selection) => resolveLimit(limits, learned, selection?.provider, selection?.model, defaultLimit)
  const routeOf = (selection) => `${selection?.provider ?? 'unknown'}/${selection?.model ?? 'unknown'}`

  // ---- keep only the newest images before every model request ---------------
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || payload?.signal?.aborted === true) return decision
    if (!offloadSupported(ctx)) {
      if (!warnedUnsupported) {
        warnedUnsupported = true
        warn('this session store does not interpret image/offload (mount @deepseek-ai/dsh-compaction-image-offload); images were left alone')
      }
      return decision
    }
    try {
      const resolution = budgetFor(payload.modelSelection)
      if (resolution.source === 'none') {
        const route = routeOf(payload.modelSelection)
        if (!warnedRoutes.has(route)) {
          warnedRoutes.add(route)
          warn(`no image budget is known for ${route}; images were left alone (run /imagereconcile probe ${route} to measure it)`)
        }
        return decision
      }
      const claimed = countClaimedImages(decision.messages)
      const result = reconcileSession(payload.agent?.session, resolution.limit, claimed)
      if (result.overflow > 0) {
        warn(`this step carries ${claimed} new image(s), more than the ${resolution.limit}-image budget; the provider may still refuse it`)
      }
    } catch (error) {
      warn(`could not reconcile the image history: ${String(error?.message ?? error)}`)
    }
    return decision
  })

  // ---- name an image-cap refusal so a probe is suggested ---------------------
  ctx.on('agent/request-error', async (payload, next) => {
    const answer = await next()
    const text = `${payload?.failure?.message ?? ''} ${payload?.failure?.code ?? ''}`
    if (!/image/i.test(text)) return answer
    if (!/too many|maximum|max(imum)?\s+images?|limit|budget|exceed|no more than|only up to/i.test(text)) return answer
    const selection = payload?.agent?.model?.current?.() ?? {}
    const route = routeOf(selection)
    if (warnedRoutes.has(`refused:${route}`)) return answer
    warnedRoutes.add(`refused:${route}`)
    warn(`a request to ${route} was refused citing images; run /imagereconcile probe ${route} to measure that route's real image budget`)
    return answer
  })

  // ---- a human command to inspect, trim, and probe ---------------------------
  if (typeof options.command === 'string' && options.command !== '') {
    const commandName = options.command
    ctx.inject(['commands'], (scope) => {
      scope.commands.register({
        name: commandName,
        description: 'Keep only the newest images in this session\'s model history',
        input: { hint: '[probe [provider/model]]' },
        handler: async ({ agent, rawInput }) => {
          if (!offloadSupported(ctx)) {
            return {
              kind: 'error',
              text: 'Image Reconcile: this session store does not interpret image/offload (mount @deepseek-ai/dsh-compaction-image-offload), so nothing was changed.',
            }
          }
          const selection = agent?.model?.current?.() ?? {}
          const currentRoute = routeOf(selection)
          const { probe, route: wanted } = parseCommand(rawInput)

          if (probe) return await runProbe(ctx, { selection, currentRoute, wanted, learned, probeTimeoutMs, commandName })

          try {
            const resolution = budgetFor(selection)
            if (resolution.source === 'none') {
              return {
                kind: 'success',
                text: `Image Reconcile: ${budgetSentence(resolution, currentRoute)}`,
              }
            }
            const result = reconcileSession(agent?.session, resolution.limit)
            const head = result.offloaded > 0
              ? `kept the newest ${result.kept} image(s); omitted ${result.offloaded} older one(s) — each now reaches the model as a text note naming the stored file`
              : `${result.images} image(s) in the model history, within budget — nothing omitted`
            return { kind: 'success', text: `Image Reconcile: ${head}. ${budgetSentence(resolution, currentRoute)}` }
          } catch (error) {
            return { kind: 'error', text: `Image Reconcile: ${String(error?.message ?? error)}` }
          }
        },
      })
    })
  }
}

/**
 * Measure one route's image budget and remember it for this process.
 *
 * The probe only runs from this command: typing it is the permission to spend
 * a handful of tiny real requests against the provider.
 * @param ctx - Host context.
 * @param options - the command's selection, argument, and timing.
 * @returns the command outcome.
 */
async function runProbe(ctx, { selection, currentRoute, wanted, learned, probeTimeoutMs, commandName }) {
  const explicitRoute = wanted.includes('/')
  let target = explicitRoute ? wanted : (wanted === '' ? currentRoute : `${wanted}/${selection?.model ?? ''}`)
  if (target.endsWith('/')) {
    return { kind: 'error', text: `Image Reconcile probe: ${wanted} needs a current model or a full provider/model target` }
  }
  if (!target.includes('/')) {
    return { kind: 'error', text: `Image Reconcile probe: a target needs provider/model (got "${target}")` }
  }
  const [provider, ...rest] = target.split('/')
  const model = rest.join('/')
  try {
    const result = await probeImageLimit(ctx, provider, model, probeTimeoutMs)
    if (!result.ok) return { kind: 'error', text: `Image Reconcile probe: ${result.error}` }
    // A provider-only argument applies to every model of that provider; a full
    // route (or no argument, meaning the current route) applies to one model.
    const providerOnly = wanted !== '' && !wanted.includes('/')
    const key = providerOnly ? provider : target
    learned.set(key, result.limit)
    const snippet = `limits: { ${JSON.stringify(key)}: ${result.limit} }`
    return {
      kind: 'success',
      text: `Image Reconcile probe: ${target} accepts up to ${result.limit} image(s) per request (${result.requests} small test request(s)${result.note ? `, ${result.note}` : ''}). Learned for this process; add this to the ${commandName} row to keep it: ${snippet}`,
    }
  } catch (error) {
    return { kind: 'error', text: `Image Reconcile probe: ${String(error?.message ?? error)}` }
  }
}

/**
 * Drop unset config values so a partial user override still gets defaults.
 * @param config - the row's `config`.
 * @returns the entries that were actually set.
 */
function dropEmpty(config) {
  return Object.fromEntries(Object.entries(config ?? {}).filter(([, value]) => value !== undefined && value !== null))
}
