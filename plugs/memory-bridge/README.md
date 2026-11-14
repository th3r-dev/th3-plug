<img src="icon.svg" width="64" align="right" alt="">

# Memory Bridge — one memory for every model

`@th3-plug/memory-bridge`, called **Memory Bridge**: open a project in DeepSeek
Harness on any model and keep the memory the project already has. Claude Code
and every Harness model read and write the same plain-Markdown notes, so a
fact saved in one is remembered in the other.

- **The index comes along.** Every session starts with the project's
  `MEMORY.md` from `~/.claude/projects/<project>/memory/`, loaded the way
  Claude Code loads it (first 200 lines or 25 KB), plus the rules for using it.
  It is shown again after compaction.
- **The protocol works on any model.** The same short protocol is registered as
  a system-prompt section, so it reaches DeepSeek, Claude, GPT or any other
  model on every request, not only in the first message. Nothing in the notes
  is model-specific: they are Markdown files on disk.
- **The `memory` tool keeps it.** `list`, `read`, `save` and `delete` notes in
  Claude Code's own format (frontmatter `name`, `description`,
  `metadata.type`, `modified`, plus one `- [Title](note.md) — summary` line in
  `MEMORY.md`).
- **Edits from outside are announced.** When Claude Code changes the index
  while a Harness session is open, the added and removed lines reach the model
  on the next message.
- **Skipped instruction files load too.** `~/.claude/CLAUDE.md`,
  `~/.claude/rules/*.md`, `.claude/CLAUDE.md` and `.claude/rules/*.md`, which
  the Harness does not read by itself. (It already loads `CLAUDE.md`,
  `CLAUDE.local.md` and `AGENTS.md` in the project.)
- **`/memory` shows what was found.** It never goes to the model.

Hooks and permission rules are the [agent-bridge](../agent-bridge/README.md)
plug's job; skills already load when they sit in `~/.agents/skills` or
`.agents/skills`.

## Any model, any preset

| Worry | What happens |
|---|---|
| The session runs on DeepSeek, GPT, Gemini, a local model | Nothing to set: the notes are files, and the tool schema is plain JSON Schema. |
| A weaker model ignores the first message | The protocol is also a system-prompt section (`promptSection`), so it is in every request and survives compaction. |
| The session is long and compaction dropped the index | The next step adds the index again; the protocol never left the system prompt. |
| The model does not know what notes exist | `memory` action `list` returns every note with its type and description. |
| A subagent should not see the project memory | `subagents: false` (default): subagents get neither the index nor the message. |

Tell the agent "remember that we use pnpm" on any model and it saves a note;
Claude Code sees it in its next session too.

## Use

Install, then just work. Type `/memory` (or `/memory <folder>`) for the report:

```
Shared memory for /Users/me/Desktop/Work/Ada-Soft/ocm-workbench
Folder: ~/.claude/projects/-Users-me-Desktop-Work-Ada-Soft-ocm-workbench/memory
✔ memory: 180 notes (99 project, 61 feedback, 19 reference, 1 user)
  MEMORY.md: 180 lines, 35 KB
  ◐ only the first 116 lines load (limit 200 lines / 24 KB); ask the agent to shorten MEMORY.md
  tool: `memory` (list · read · save · delete)
  refresh: changes made outside the session are announced on your next message
  models: any (the notes are plain Markdown; no model-specific format); protocol on every request: yes (system prompt section)
✔ instructions ~/.claude/CLAUDE.md (7.6 KB)
```

## Which folder

Claude Code keys memory by the git repository, so every subfolder and linked
worktree of one repository shares one folder. The folder name is the root's
absolute path with every character outside `A-Z a-z 0-9` replaced by `-`.
Outside a repository, the session folder is the project. The plug also
follows `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PROJECT_DIR_NAME`,
`CLAUDE_CODE_DISABLE_AUTO_MEMORY`, and `autoMemoryEnabled` /
`autoMemoryDirectory` in `~/.claude/settings.json`,
`.claude/settings.json` and `.claude/settings.local.json`. The folder name is
only a convention: any folder works, and nothing in the plug needs Claude Code
to be installed.

## What the model sees

One sourced user-role message on the first step of a session, after your first
message: the bridged instruction files, then the shared memory section (the
folder, the `MEMORY.md` lines, and the protocol). It is part of the session log,
so resume and fork keep it; when compaction drops it, the next step adds a
fresh one. In addition, the protocol lives in the system prompt on every
request.

The `memory` tool:

| action | does |
|---|---|
| `list` | every note with its type and description |
| `read` | one note; `name: MEMORY` returns the whole index, including lines past the load limit |
| `save` | creates the note or replaces the one with that name, and its index line; keeps `originSessionId`, stamps `modified`; warns when `MEMORY.md` nears or passes the load limit |
| `delete` | removes the note and its index line |

Writes go only to `<memory folder>/<name>.md` and `MEMORY.md`. Names are
limited to letters, digits, `.`, `_` and `-`.

## Configuration

Defaults are in [`cordis.patch.yml`](cordis.patch.yml); override the
`th3-memory-bridge` row in the profile's own `cordis.patch.yml`.

| Key | Default | Meaning |
|---|---|---|
| `command` | `memory` | slash command for the report |
| `autoMemory` | `true` | show the `MEMORY.md` index and the rules for keeping it |
| `tool` | `true` | register the `memory` tool; off = the model can read notes from the folder but not save them |
| `promptSection` | `true` | keep the protocol in the system prompt, on every request and every model |
| `instructions` | `true` | load `~/.claude/CLAUDE.md`, `~/.claude/rules/`, `.claude/CLAUDE.md`, `.claude/rules/` |
| `refresh` | `true` | announce index lines changed outside the session on your next message |
| `subagents` | `false` | give subagents the memory too |
| `maxIndexLines` | `200` | `MEMORY.md` lines shown (Claude Code's limit) |
| `maxIndexBytes` | `25000` | `MEMORY.md` bytes shown (Claude Code's limit) |
| `maxInstructionBytes` | `65536` | budget for the bridged instruction files together; the first file over it is cut, later ones dropped |
| `projects` | `[]` | absolute project roots to bridge; empty = every project |

## Not covered

- Rules with `paths:` frontmatter (Claude Code loads them next to matching
  files). `/memory` lists them.
- `@path` imports inside `CLAUDE.md` files are left as text.
- Subagent memory folders (the `memory` field of a Claude Code subagent).
- A bridged instruction file that is identical to one the Harness already
  loads (for example `~/.claude/CLAUDE.md` symlinked to
  `~/.agents/AGENTS.md`) is skipped instead of loaded twice.

## Files

| File | Role |
|---|---|
| `host/index.js` | wiring: the memory message on `agent/pre-step`, the prompt section, the `memory` tool, `/memory` |
| `host/memory.js` | Claude Code paths, `MEMORY.md`, note format, instruction files |
| `cordis.patch.yml` | the row this bundle inserts |
| `locale/*.json`, `icon.svg` | title, description, icon |

## Test

```bash
node --test plugs/memory-bridge/test/*.test.mjs
```
