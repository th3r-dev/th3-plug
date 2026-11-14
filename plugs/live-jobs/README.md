<img src="icon.svg" width="64" align="right" alt="">

# live-jobs — the background process, in the conversation

`@th3-plug/live-jobs` puts the agent's background work where you want to read
it — **inside the turn that started it** (default), or as a strip above the
composer. Either way you get the exact command, the output as the job produces
it, the exit status when it ends, and a stop button — no popover, no leaving the
transcript.

A `bash` call with `run_in_background` answers with one static line —
`started background job bash-1a2b…` — and the live output only exists in the
session-header job list, behind a popover. This plug keeps the process where the
command was: below the reply, above its action row.

```
┌────────────────────────────────────────────────────────────────────┐
│ ● Background process                                             ⌄ │
│                                                                    │
│ ● bash   running   12s                                   [■ Stop] │
│ $ npm run dev                                                      │
│ ready in 208ms                                                     │
│ Local:   http://localhost:5173/                                    │
│ press r to restart, q to quit                                      │
│                                              4 lines   [copy] [all]│
└────────────────────────────────────────────────────────────────────┘
```

## What it shows

- **The real command.** A job's label is what the tool registered, and for
  `bash` that is the exact command line — multi-line commands included, wrapped
  in full, scrollable when very long.
- **Live output.** The card follows the job's output stream while the command
  runs: the newest 8 lines by default, `Show all` for the newest 500 with its
  own scroll area. Output stays pinned to the bottom unless you scroll up.
- **The ending.** Status (`completed`, `stopped`, `failed`), the tool's own
  detail line (for a shell job, `exit code: N`), the duration, and the final
  bytes of output. The card is part of the turn, so it stays in the transcript
  after the process ends — reload the page and the finished job still reads
  there, as long as the Host still holds its output.
- **Stop.** Two presses: the first arms the control, a second press within
  three seconds kills the job through the Harness job controller. The owning
  agent still receives its usual completion notice, marked as cancelled by you.
- A **Copy command** button, per-job `Show all`/`Show less`, and a header
  chevron that collapses the whole card.

A turn that started no background process grows no card.

## Choose where it lives

One config key, `position`, picks the seat:

```yaml
config:
  position: conversation   # default: a card under the turn that started the job
  # position: extrabar    # a strip above the composer, like the todo dock
```

| `position` | Where it renders | Lifetime |
|---|---|---|
| `conversation` | `conversation.chat.turnTail`, under the reply that started the job | part of the turn, so it stays in the transcript after the process ends |
| `extrabar` | `conversation.input.dock`, directly above the composer | while a job runs and for 60 s after it settles |

Both seats are registered; the one that does not match `position` renders
nothing, so there is no duplicate. The choice is read from the Host route when
the page boots, so changing it takes effect after a window reload.

### Set it with the agent

Ask the agent to move the card, for example:

> set the live-jobs card to the extra bar

The agent changes `position` in the profile's override layer, at
`~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- id: th3-live-jobs
  name: "@th3-plug/live-jobs"
  config:
    position: extrabar
```

and re-applies the bundle (`plugin_manager remove_bundle` +
`install_bundle`, or a profile config reload). Reload the window with `Cmd+R`;
the card moves to the chosen seat. The bundle's own default lives in
[`cordis.patch.yml`](cordis.patch.yml), so a fresh install follows that value
unless the profile overrides it.

## How the card finds its process

The card is one entry in `conversation.chat.turnTail`, the additive seat under a
completed turn. It does not parse the transcript blindly:

1. It reads the turn's own `tool-call` nodes from the Chat snapshot
   (`useChat` → `locations.getTurn(turn)` / `nodes`).
2. Only a `bash`/`pwsh` call whose settled result acknowledged a background job
   (`started background job …` or `… moved to background job …`) contributes
   that job id. A `job_output` card that merely prints an id is ignored.
3. `ctx.jobs` supplies the roster row (`label` is the exact command) and the
   non-consuming live output (`observe`); `kill` stops it on the human's behalf.

Observation never moves the model's own read cursor and never touches a
completion notice. The shipped tool cards, the session-header job list, and the
rest of the conversation are untouched.

With `position: conversation` the card belongs to a completed turn, so it
appears when that turn ends. An agent that starts a job and then keeps working
in the same turn still shows its output in the header job list while the turn is
open; the inline card joins as soon as the turn closes. With
`position: extrabar` the strip appears as soon as the job is registered.

## Config

The Host half serves these numbers to the page on one authenticated route,
`GET /api/th3-live-jobs/config`. Defaults live in `cordis.patch.yml`; override
them in the profile's `cordis.patch.yml` under the row id `th3-live-jobs`.

| Key | Default | Meaning |
|---|---:|---|
| `position` | `conversation` | `conversation` = a card under the turn that started the job; `extrabar` = a strip above the composer. |
| `previewLines` | `8` | Output lines shown while a job's output is collapsed. |
| `maxOutputLines` | `500` | Newest output lines kept in the expanded view. |
| `stopConfirmMs` | `3000` | Window for the second press of the stop control. |

Numbers are clamped to safe ranges (for example `previewLines` 1–100) and an
unusable value keeps its default.

## Install

```bash
npm run verify                 # check + tests
```

Then, in DeepSeek Harness, remove and re-install the bundle with its absolute
path, and reload the window:

```
plugin_manager remove_bundle @th3-plug/live-jobs
plugin_manager install_bundle /abs/path/to/th3-plug/plugs/live-jobs
```

Ask for a background process, for example "start `npm run dev` in the
background", and the card appears under that reply (or above the composer, when
`position` is `extrabar`).

## Limits

- The observation ring is a live preview, not a transcript: it is bounded, and
  a gap notice appears when earlier bytes were evicted or a stream resumed past
  its head.
- `stdout` and `stderr` arrive concatenated in the order the registry read
  them; the card does not tint one channel.
- Jobs live in the Harness process. A Host restart empties the roster, so turns
  from before the restart keep their card only while the registry still holds
  that job.
- The card needs the Harness job capability (`dsh-jobs-local` +
  `dsh-api-job-controller`, both in `dsh-base`). Without `ctx.jobs` the Web half
  does not load.
