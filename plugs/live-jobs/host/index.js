/**
 * @th3-plug/live-jobs — Host half.
 *
 * The feature itself is drawn by the Web half, which reads the Harness job
 * registry through `ctx.jobs` and watches a job's retained output through
 * `ctx.jobs.observe`. This half owns only the numbers that shape the in-chat
 * process card — how many output lines a preview shows, and how long the stop
 * control stays armed — and hands them to the page over one authenticated
 * route. Keeping them here puts them in the Loader row's `config`, where the
 * profile can tune them.
 *
 * Everything registers inside `apply` (through `ctx.inject`) so removing the
 * plug removes the route again.
 */

export const name = 'th3-live-jobs'

/** The two placements the Web half can mount. */
const POSITIONS = new Set(['conversation', 'extrabar'])

/** Defaults for the `config` block in cordis.patch.yml. */
const DEFAULTS = {
  /**
   * Where the process card lives: `conversation` is a card under the turn
   * that started the job; `extrabar` is the strip above the composer.
   */
  position: 'conversation',
  /** Output lines shown while a job's output is collapsed. */
  previewLines: 8,
  /** Output lines retained in the expanded view (the page keeps the newest ones). */
  maxOutputLines: 500,
  /** Window for the two-press stop control, in milliseconds. */
  stopConfirmMs: 3_000,
}

/** Authenticated route the Web half reads its numbers from. */
const CONFIG_PATH = '/api/th3-live-jobs/config'

const LIMITS = {
  previewLines: [1, 100],
  maxOutputLines: [10, 5_000],
  stopConfirmMs: [500, 10_000],
}

function json(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Clamp one configured number, falling back to its default for anything unusable. */
function number(value, key) {
  const [min, max] = LIMITS[key]
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULTS[key]
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function dropEmpty(config) {
  return Object.fromEntries(
    Object.entries(config ?? {}).filter(([, value]) => value !== undefined && value !== null),
  )
}

export function apply(ctx, config = {}) {
  const given = { ...DEFAULTS, ...dropEmpty(config) }
  const options = {
    position: POSITIONS.has(given.position) ? given.position : DEFAULTS.position,
    ...Object.fromEntries(
      Object.keys(LIMITS).map(key => [key, number(given[key], key)]),
    ),
  }

  ctx.inject(['connection'], (scope) => {
    scope.connection.fetch.register({
      path: CONFIG_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => json(options),
    })
  })
}
