<img src="icon.svg" width="64" align="right" alt="">

# shell — run local commands from the composer

`@th3-plug/shell` lets you run a shell command on your own machine from the
DeepSeek Harness chat box without calling the AI agent.

| Type | What happens |
|---|---|
| `!git status` | runs `git status` in the session's working folder |
| `/sh git status` | the same, as a slash command |
| `! git ch` (no Enter yet) | a suggestion menu with zsh completions and matching history |

The command and its output never reach the model and cost no tokens. The
result shows as your message bubble (`!git status`) followed by a reply-style
terminal block with the output, exit code, run time and a Copy button.

## Keys while the `!` menu is open

| Key | Action |
|---|---|
| Tab / click | insert the highlighted suggestion |
| ↑ / ↓ | move through suggestions |
| Enter | run the line exactly as typed |
| Esc | close the menu |

## Configuration

Defaults live in [`cordis.patch.yml`](cordis.patch.yml). To change one for
your profile, override the `th3-shell` row in the profile's own
`cordis.patch.yml` (an override replaces the whole `config`):

| Key | Default | Meaning |
|---|---|---|
| `name` | `sh` | slash-command name (`/sh`). The web view is keyed to `sh`; change both together. |
| `bang` | `true` | run messages that start with `!` |
| `autocomplete` | `true` | zsh completions + history while typing a `!` line |
| `completeTimeoutMs` | `5000` | give up on one completion request |
| `timeoutMs` | `120000` | kill a running command (0 = never) |
| `maxOutputChars` | `20000` | keep the last N characters of output |
| `shell` | `$SHELL` | shell executable |
| `loginShell` | `true` | run as `$SHELL -lc` so the PATH from your profile applies |

## How it works

```
web/client.js                         host/index.js
─────────────                         ─────────────
typing "!git ch"                      GET /api/th3-shell/complete
  └─ `!` trigger on the slash menu ─────► host/complete.js
     (wraps the per-session                ├─ history: ~/.zsh_history prefix match
      trigger controller)                  └─ zsh: host/capture-completion.zsh
                                              (compinit + your $fpath, nothing executed)
Enter "!git status"                   agent/pre-step listener
  └─ normal prompt ────────────────────► drops the `!` message from the step,
                                         runs commands.execute('/sh git status')
                                         → turn ends with no model request
command/run + command/done events ──► conversation.chat.commandview["sh"]
                                      renders bubble + terminal block
```

- **Host** (`host/`): the `/sh` command, the `!` interception in
  `agent/pre-step`, and the authenticated completion route.
- **Web** (`web/client.js`): the `!` suggestion menu and the result view.

## Limits

- Suggestions only while the caret is at the end of the `!` line.
- Commands run with your full user permissions, outside the agent sandbox.
  Interactive programs (`vim`, password prompts) do not work: there is no TTY.
- The `!` trigger wraps internals of `@deepseek-ai/dsh-client-ui-input-trigger`
  (`InputTriggerController.track` / `arbitrate`). A Harness update can break
  the menu; `!` commands keep running. See
  [docs/dsh-notes.md](../../docs/dsh-notes.md#the--trigger).
- zsh completion for slow commands (git in a very large repo) can take seconds;
  past `completeTimeoutMs` the completion group stays empty.

## Test

```bash
node --test plugs/shell/test/*.test.mjs
```
