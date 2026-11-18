/**
 * Where an image budget comes from, in priority order.
 *
 * The same model behind two gateways can have two different caps (DeepSeek's
 * own API allows 600 images per request; the Tokenme gateway refuses a ninth),
 * so the budget is keyed by provider first and can be narrowed to
 * `provider/model`.
 *
 *   1. `limits` config — the profile owner's word, exact then provider key.
 *   2. probed — measured by `/imagereconcile probe` in this process.
 *   3. documented — the built-in table from provider docs (below).
 *   4. observed — a cap recorded from a real refusal in this profile (below);
 *      below a probe so measuring can correct it, above nothing.
 *   5. `defaultLimit` — only when the profile owner set one above zero.
 *   6. none — the route is left alone; a refusal then suggests the probe.
 *
 * Guessing a budget for an unknown route would permanently omit images on a
 * model that had plenty of room, so "none" is a real answer, not an error.
 */

/**
 * Image caps read from provider documentation.
 *
 * `deepseek` / `deepseek-account`: api-docs.deepseek.com/guides/vision
 * (checked 2026-11) — "Max images per request: 600" for `deepseek-flash`
 * (served by DeepSeek-V4.1-Flash-1017). The account login uses the same
 * platform, so it shares the cap.
 *
 * `openai`: developers.openai.com/api/docs/guides/images-vision (checked
 * 2026-11) — "Image count: Up to 1,500 images per request".
 *
 * Anthropic states 100 images/request for 200k-context models and 600 for the
 * rest (vision.md, "Request limits"), and Gemini's count is not in the page
 * this plug could fetch; both vary by model, so they are measured with the
 * probe rather than guessed. A wrong number would omit images forever on a
 * route that had room.
 */
export const DOCUMENTED_LIMITS = {
  deepseek: 600,
  'deepseek-account': 600,
  openai: 1500,
}

/**
 * Caps observed in this profile from a real refusal.
 *
 * `tokenme`: the gateway refused a ninth image in an image-heavy session while
 * its docs were unreachable. This is a fact about the profile, not a supplier
 * promise: `/imagereconcile probe` measures it and outranks this entry.
 */
export const OBSERVED_LIMITS = {
  tokenme: 8,
}

/**
 * Look one key up with `provider/model` precision first.
 * @param table - a flat `key -> number` map.
 * @param provider - the request's provider route.
 * @param model - the request's model id.
 * @returns the number, or undefined.
 */
function lookup(table, provider, model) {
  const exact = table[`${provider}/${model}`]
  if (Number.isFinite(exact)) return exact
  return table[provider]
}

/**
 * The image budget for one model selection.
 *
 * @param limits - the `limits` config map (or undefined).
 * @param learned - probed results from this process, `route -> number`.
 * @param provider - provider route of the request.
 * @param model - model id of the request.
 * @param defaultLimit - explicit fallback; `0` (the default) leaves unknown
 * routes alone.
 * @returns `{ limit, source }` where source is `config`, `probed`,
 * `documented`, `observed`, `fallback` or `none` (`limit` is undefined for
 * `none`).
 */
export function resolveLimit(limits, learned, provider, model, defaultLimit = 0) {
  const accept = (value, source) => ({ limit: Math.max(0, Math.trunc(value)), source })
  if (typeof provider === 'string' && provider !== '') {
    const configured = lookup(limits ?? {}, provider, model)
    if (Number.isFinite(configured)) return accept(configured, 'config')
    const probed = learned?.get(`${provider}/${model}`) ?? learned?.get(provider)
    if (Number.isFinite(probed)) return accept(probed, 'probed')
    const documented = lookup(DOCUMENTED_LIMITS, provider, model)
    if (Number.isFinite(documented)) return accept(documented, 'documented')
    const observed = lookup(OBSERVED_LIMITS, provider, model)
    if (Number.isFinite(observed)) return accept(observed, 'observed')
  }
  if (Number.isFinite(defaultLimit) && defaultLimit > 0) return accept(defaultLimit, 'fallback')
  return { limit: undefined, source: 'none' }
}
