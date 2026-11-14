<img src="icon.svg" width="64" align="right" alt="">

# agent-bridge — Agent rules bridge

`@th3-plug/agent-bridge`: open any project in DeepSeek Harness and the rules
your other coding agents already follow there keep working. No per-project
setup: the session's folder decides.

- **Claude Code hooks run in the Harness.** `command` hooks from
  `.claude/settings.json` and `.claude/settings.local.json` fire at the
  matching moment, get the same JSON on stdin, and their exit code / JSON
  output is honoured (deny a tool call, ask, add context, block a prompt,
  keep the agent going on `Stop`).
- **Claude Code permission rules apply.** `permissions.deny` refuses a
  matching tool call; `permissions.ask` asks for approval.
- **`/agent-bridge` shows everything it found**, for Claude Code, Cursor,
  GitHub Copilot, Windsurf, Cline, Gemini CLI, Kiro and Codex, marked
  `native` (the Harness reads it), `bridged` (this plug applies it),
  `partial`, `off` or `not used`, each with the fix.

## Use

Install, then just work. Type `/agent-bridge` (or `/agent-bridge <folder>`)
to see the report. It never goes to the model.

```
## Claude Code
✔ native   instructions — CLAUDE.md
◐ partial  instructions — AGENTS.md
      dropped: the chain is 66 KiB, over the Harness 64 KiB instruction budget …
✔ bridged  hook PreToolUse — .claude/settings.json · 5 command(s) · matcher Bash, Read, Agent|Task …
✔ bridged  hook UserPromptSubmit — .claude/settings.json · 3 command(s)
○ off      hook Stop — ~/.claude/settings.json · 2 command(s)
      scope "user" is not in this plug's scopes config; add it to run these
✖ not used MCP servers — ~/.claude.json (user) · aws-mcp, figma-bridge
      Add each one to the Harness with a dsh-mcp-client bundle.
```

## What runs when

| Claude Code event | Harness moment | What the hook can do |
|---|---|---|
| `PreToolUse` | `tools/pre-execute` | `permissionDecision` deny / ask / allow, exit 2 = deny with stderr, `additionalContext`, `updatedInput` (see below) |
| `PostToolUse` | `tools/post-execute` | `additionalContext`, `systemMessage`, `decision: block` → feedback to the model |
| `PostToolUseFailure` | `tools/post-execute` on an error | same as `PostToolUse` |
| `UserPromptSubmit` | `agent/pre-step` with your message | add context (JSON or plain stdout), block the message (exit 2 / `decision: block`) |
| `SessionStart` | `agent/created` (sessions and subagents) | add context (JSON or plain stdout) |
| `Stop` / `SubagentStop` | `agent/turn-stopping` | `decision: block` + `reason` keeps the agent going (`stop_hook_active` is set on repeats) |
| `SessionEnd` | `agent/disposed` | side effects only |

Not bridged yet (shown as `not used`): `Notification`, `PreCompact`,
`PostCompact`, `SubagentStart`, `PermissionRequest`, and hooks of type
`prompt` / `agent`.

### How a Harness call looks to a hook

Tools are renamed to their Claude Code names, and relative paths become
absolute, so existing hooks match unchanged:

| Harness | Claude Code `tool_name` | `tool_input` |
|---|---|---|
| `bash` | `Bash` | `command`, `description`, `timeout` |
| `read`, `read_image` | `Read` | `file_path`, `offset`, `limit` |
| `write` | `Write` | `file_path`, `content` |
| `edit` | `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` |
| `glob` / `grep` | `Glob` / `Grep` | `pattern`, `path` (`grep` `include` → `glob`) |
| `web_fetch` | `WebFetch` | `url` |
| `subagent`, `subagent_fork` | `Task` (matcher `Agent` also matches) | `description`, `prompt`, `subagent_type` |
| `todo_write`, `ask_user_question`, `skill` | `TodoWrite`, `AskUserQuestion`, `Skill` | as named |
| anything else (`mcp__…`, `workflow`) | unchanged | unchanged |

A matcher also matches the Harness name, so `Read|read` works. Hooks get
`CLAUDE_PROJECT_DIR` (the git root), `DSH_AGENT_BRIDGE=1`, the session's
folder as working directory, and the PATH of your login shell. `transcript_path`
is empty: the Harness has no Claude Code transcript.

### `updatedInput`

The Harness cannot rewrite a call's arguments in place. With
`updatedInput: retry` (default) the call is refused and the model gets the
rewritten arguments to call again; a hook that leaves its marker in the input
(like an "already appended" comment) then lets the retry through. `ignore`
drops the rewrite and runs the original call.

### Permission rules

`deny` wins over `ask`. Supported specifiers: `Bash(prefix:*)`, `Bash(exact)`,
`Bash(glob*)` (each part of `&&`, `||`, `;`, `|` is checked), path globs for
`Read` / `Edit` / `Write` (`//abs`, `~/home`, `/project-relative`, `./cwd`,
bare names at any depth; `Edit` also covers `Write`, `Read` also covers
`Glob` / `Grep`), `WebFetch(domain:…)`, and `mcp__server[__tool]`.
`permissions.allow` is listed but never applied: the Harness sandbox and
approval mode decide what may run.

## Configuration

Defaults are in [`cordis.patch.yml`](cordis.patch.yml); override the
`th3-agent-bridge` row in the profile's own `cordis.patch.yml`.

| Key | Default | Meaning |
|---|---|---|
| `command` | `agent-bridge` | slash command for the report |
| `hooks` | `true` | run Claude Code command hooks |
| `permissions` | `true` | apply `permissions.deny` / `permissions.ask` |
| `scopes` | `[project, local]` | settings files to enforce; add `user` for `~/.claude/settings.json` |
| `events` | all bridged events | hook events to run |
| `projects` | `[]` | absolute project roots allowed to run hooks; empty = every project |
| `timeoutMs` | `60000` | per-hook timeout when the hook sets no `timeout` |
| `updatedInput` | `retry` | `retry` or `ignore` |
| `loginShell` | `true` | read PATH from your login shell once |
| `maxStopContinuations` | `3` | how often `Stop` hooks may keep one agent going in a row |

User-level hooks (`~/.claude/settings.json`) are off by default: they are often
written for Claude Code itself (status lines, transcript readers, sounds) and
run on every call in every project. Add `user` to `scopes` once you have
checked them with `/agent-bridge`.

## Security

Project hooks are commands from the repository. Opening an untrusted
repository in a session runs its `.claude/settings.json` hooks, as Claude Code
does after you trust a folder. Set `projects` to the roots you trust to limit
that.

## Files

| File | Role |
|---|---|
| `host/index.js` | wiring: tool, prompt and session events, `/agent-bridge` |
| `host/claude.js` | Claude Code settings, matchers, tool mapping, permission rules, hook output |
| `host/run.js` | runs one hook process (stdin JSON, timeout, login PATH) |
| `host/detect.js` | the cross-agent scan behind the report |
| `cordis.patch.yml` | the row this bundle inserts |
| `locale/*.json`, `icon.svg` | title, description, icon |

## Test

```bash
node --test plugs/agent-bridge/test/*.test.mjs
```
