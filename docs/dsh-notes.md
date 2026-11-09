# DeepSeek Harness notes for plug authors

What these plugs rely on in DeepSeek Harness (DSH) 0.2.x, and the traps that
cost time while building `shell`. Verify anything here against the running
Harness before relying on it: ask the agent to use `cordis_inspect_list` /
`cordis_inspect_query` (Host `Service`, `Event`, Client `Slots`, `Theme`).

## Anatomy of a bundle

A bundle is a package whose `package.json` declares `dsh.bundle.patch`. The
patch (`cordis.patch.yml`) inserts Loader rows; each row names a package and
gives it `config`.

| Piece | Where | Loaded by |
|---|---|---|
| Host half | `exports["."]` → `host/index.js` | the Harness process; `apply(ctx, config)` |
| Web half | `exports["./client"]` + `dsh.client` → `web/client.js` | the page, through `window.__ModuleLoader__.load({ id, factory })` |
| Metadata | `exports["./locale/*.json"]`, `exports["./icon"]` | plugin manager and settings, without activating the plug |

Host `apply` exports one of: `export function apply(ctx, config)` with optional
`export const inject = [...]` and `export const name`. Optional services are
read with `ctx.get('name')` so the plug still loads without them.

The Web module `id` must equal the package name. `factory(require)` returns
`{ inject, apply(ctx) }`; `require('react')` is the only module to take from
the page. Do not `require` Harness client packages — copy markup and CSS
instead and keep only `--dsw-alias-*` token references.

## Install and update

The agent's `plugin_manager` tool does the profile work; do not edit the
profile's `package.json` or `cordis.patch.yml` by hand.

| Change | What to do |
|---|---|
| New plug | `install_bundle` with the absolute plug folder |
| Host or Web code changed | `remove_bundle @th3-plug/<name>`, then `install_bundle <folder>` (bump `version`) — a re-install of an existing package is refused, and the running process keeps the old module until then |
| Web code changed | after the re-install, reload the Harness window (Cmd+R); the page does not hot-reload profile plugs |
| Only `config` defaults changed | same as code: re-install |
| Check it loaded | `plugin_manager list_plugins` → row `include:th3-<name>` with `fiberPhase: active`; for Web halves, Client `Slots.listSubTree` shows your registrations |

Install a plug from its folder (linked), never a copy, so the repo stays the
source of truth.

## APIs the shell plug uses

| Need | API | Notes |
|---|---|---|
| A human command `/sh …` | Host `ctx.commands.register({ name, description, input: { hint }, handler })` | handler gets `{ agent, rawInput, signal, commandId }` and returns `{ kind: 'success' \| 'error', text }`. Logged as `command/run` + `command/done`; never model-visible. Names: lower-case, `[a-z0-9_-]`. |
| Run a command programmatically | `ctx.commands.execute(agent, '/sh …', [], signal)` | same logging as a typed command |
| Act before a model request | Host `ctx.on('agent/pre-step', async (payload, next) => …)` | waterfall: call `next()` first, return `{ ...decision, messages }`. Returning `messages: []` at `step === 1` ends the turn with no model request. Human prompts have `source.kind === 'user'`. |
| Per-session working folder | `ctx.get('workingDirectory').ensure(agent, signal)` / `.get(session)` | `ctx.get('agents').get(sessionId)` for the agent |
| An authenticated HTTP endpoint for the page | `ctx.inject(['connection'], s => s.connection.fetch.register({ path: '/api/<x>/<y>', methods: ['GET'], requestBody: 'buffered', fetch: req => Response }))` | behind the same browser auth as `/api`; the page calls it with `fetch('/api/…', { credentials: 'same-origin' })`. Unauthenticated callers get 401. |
| Draw a command's result in the chat | Client slot `conversation.chat.commandview`, keyed by command name | props: `{ node: { name, args, outcome: { kind, text } \| null }, renderFactorySlot, … }` |
| The real user bubble | `renderFactorySlot('conversation.chat.user.content', { content: { text, attachments: [], extraBlocks: [] }, facts: {}, interactive: false })` | every slot entry receives `renderFactorySlot` |
| Suggestion menu rows | Client `ctx.inputTriggers.registerSource({ trigger, name, order, candidates(session, { query, signal }), onPick })` | `onPick` returns `{ text }` to replace the hit span. Rows may carry `section` (heading), `description`, `label`. |
| Translations | `ctx.locale.register(ns, { en: {...}, th: {...} })`, `ctx.locale.bind(ns)` | use **your own** namespace — see traps |

## The `!` trigger

The slash/@ menu (`@deepseek-ai/dsh-client-ui-input-trigger`) detects only `/`
and `@` (`detectTrigger` is module-private). `shell` adds `!` by wrapping
`InputTriggerController.prototype.track` and `.arbitrate`, reached through the
first controller that `ctx.inputTriggers.sessionOf()` returns:

- `track`: on a `!` line, build a hit `{ trigger: '!', query, span }` and run
  the same open-menu steps as the original; otherwise call the original.
- `arbitrate`: Enter on an open `!` menu closes it and passes, so Enter submits.

This is internal API. After a Harness update, check that `track(draft, caret,
guard, draftRev)`, `menu`, `reduce`, `fetchCandidates`, `deps.roster` still
exist; the plug restores the originals on unload.

## Traps

- **Locale namespaces belong to their owner.** `locale.register(ns, locale,
  dict)` throws if `ns` already has that locale. Registering titles into
  `slash.menu` killed the whole Web `apply`. Use your own namespace and wrap
  optional registrations in `try`.
- **One throw in Web `apply` disables everything after it.** Register the
  independent parts in separate `try` blocks or effects.
- **The menu highlights the first group that settles.** Slow sources lose the
  highlight to fast ones; hold the fast one back briefly if order matters.
- **`agent/pre-step` sees runtime-context messages too.** Strip them only when
  nothing else remains, or the step still sends a request.
- **Command events are not model history.** Fine for `!` output; if the model
  must see a result, inject it deliberately (`agent.inject()`), do not fake an
  assistant message.
- **zsh from a GUI app has a thin environment.** Login shell (`-lc`) for runs;
  for completion, read the user's `$fpath` once from `zsh -i` and pass it in.
- **`cordis_inspect_query` with an `input` argument** may be rejected by some
  agent front-ends ("input must be an object"); fall back to reading the
  package sources (below).

## Reading Harness sources

Installed packages live inside the app archive. Extract one file to read it:

```bash
ASAR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
npx --yes @electron/asar list "$ASAR" | grep dsh-client-ui-input-trigger/lib
npx --yes @electron/asar extract-file "$ASAR" \
  dsh/node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js
```

Each package also ships a `README.md` next to `lib/`.
