# CLAUDE.md

See [AGENTS.md](AGENTS.md).

## Git workflow

`main` is protected: it changes only through a merged pull request. Never
commit on `main` and never push to it.

```bash
git switch main && git pull --ff-only
git switch -c feat/<plug>-<topic>     # or fix/…, docs/…
git commit -m "…"                     # commits happen on the branch
git push -u origin feat/<plug>-<topic>
gh pr create --base main --fill       # report the PR URL
```

Land the work by merging the PR; the user merges, or run `gh pr merge --squash`
when asked.

[`.claude/settings.json`](.claude/settings.json) installs a PreToolUse hook,
[`scripts/git-guard.mjs`](scripts/git-guard.mjs), that refuses `git commit`,
`rebase`, `cherry-pick`, `revert`, `git am`, non-fast-forward `git merge`, and
any `git push` that lands on `main` / `master`. Claude Code and DeepSeek
Harness (through the agent-bridge plug) both run it. If it blocks you, create
the branch; do not bypass it.
