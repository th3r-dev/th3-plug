# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

DeepSeek Harness plugins ("plugs"). One bundle per `plugs/<name>/`; no build
step, no dependencies. Read [README.md](README.md) for the layout and
[docs/dsh-notes.md](docs/dsh-notes.md) for the Harness APIs and traps before
changing a plug.

## Git workflow

`main` is protected. It changes only through a merged pull request, so every
change, however small, happens on a branch. This applies to agents and humans
alike, including one-line documentation fixes.

1. Branch off `main`:
   `git switch main && git pull --ff-only && git switch -c feat/<plug>-<topic>`
   (or `fix/…`, `docs/…`). One topic per branch; several plugs that ship
   together may share one branch.
2. Commit on that branch. Subject in the imperative, body says why.
3. `git push -u origin <branch>`, then open the PR:
   `gh pr create --base main --fill`. Report the PR URL.
4. Land the work by merging the PR — the user merges, or an agent runs
   `gh pr merge --squash` when asked. Never `git push origin main`, never
   `git commit` on `main`.

A PreToolUse hook enforces this: [`.claude/settings.json`](.claude/settings.json)
runs [`scripts/git-guard.mjs`](scripts/git-guard.mjs) before every Bash call.
It refuses `commit`, `rebase`, `cherry-pick`, `revert`, `git am` and any
non-fast-forward `merge` on `main` / `master`, and every `git push` that lands
on them (`--all`, `--mirror`, `HEAD:main` included). Claude Code runs the hook
directly; DeepSeek Harness runs the same hook through the
[agent-bridge](plugs/agent-bridge/README.md) plug. When it blocks a command,
create the branch — do not look for a way around it.

## Commands

```bash
npm run new -- <name> [--web] [--title "..."] [--description "..."] [--command cmd]
npm run check [-- <name>]     # manifest, exports, patch, locale, icon, syntax
npm test                      # node --test plugs/*/test/*.test.mjs scripts/*.test.mjs
npm run verify                # check + test; run before every install
```

## Rules

- Names: folder `plugs/<name>`, package `@th3-plug/<name>`, row id
  `th3-<name>`, Web module id = package name, CSS class prefix = row id.
- Host code in `host/` (ES modules, Node built-ins only). Web code in one file,
  `web/client.js`, loaded through `window.__ModuleLoader__.load`; only
  `require('react')`.
- Register through `ctx.effect` / `ctx.on` / `ctx.inject` so unload cleans up.
  Read optional services with `ctx.get()`.
- Defaults go in `cordis.patch.yml` `config` and mirror a `DEFAULTS` object in
  `host/index.js`; document each key in the plug README.
- Use your own locale namespace (the row id). Never register into another
  plugin's namespace.
- UI uses `--dsw-alias-*` tokens; no literal colors except in artwork.
- New behaviour gets a `node:test` case in `plugs/<name>/test/` using a fake
  `ctx` (see `plugs/shell/test/host.test.mjs`).
- Bump the plug's `version` on every change you install.
- Icons follow the plug-icon family in [brand/BRAND.md](brand/BRAND.md#plug-icons).
  Brand PNGs are generated: edit `brand/*.svg`, then `npm run brand`.

## Installing a change

1. `npm run verify`
2. In DeepSeek Harness: `plugin_manager remove_bundle @th3-plug/<name>`, then
   `install_bundle <absolute path of this clone>/plugs/<name>`
   (new plugs: install only).
3. Web changes: the user reloads the window. Then confirm with Client
   `Slots.listSubTree` or by exercising the feature; installation alone does
   not prove what the page shows.
