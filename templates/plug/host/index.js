/**
 * __PACKAGE__ — Host half.
 *
 * Runs in the Harness process (Node). Register everything inside `apply` with
 * `ctx.effect` / `ctx.on` so unloading the plug removes it again.
 *
 * Starter behaviour: a `/__COMMAND__ [text]` slash command that answers in the
 * UI without calling the model. Replace it with the plug's real work.
 */

export const name = '__ENTRY__'

/** Services this plug needs. Optional ones: read with `ctx.get(name)` instead. */
export const inject = ['commands']

/** Defaults for the `config` block in cordis.patch.yml. */
const DEFAULTS = {
  /** Slash-command name, typed as `/<command>`. */
  command: '__COMMAND__',
}

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...dropEmpty(config) }

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: options.command,
      description: '__DESCRIPTION__',
      input: { hint: '[text]' },
      handler: async ({ rawInput }) => {
        const text = rawInput.trim()
        return { kind: 'success', text: text ? `__TITLE__ received: ${text}` : '__TITLE__ is installed.' }
      },
    })
  }, '__ENTRY__ lifecycle')
}

function dropEmpty(config) {
  return Object.fromEntries(Object.entries(config ?? {}).filter(([, value]) => value !== undefined && value !== null))
}
