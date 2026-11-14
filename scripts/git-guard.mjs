#!/usr/bin/env node
/**
 * PreToolUse guard: work in this repository happens on a branch, and `main`
 * changes only through a merged pull request.
 *
 * `.claude/settings.json` installs this script for Bash tool calls. Claude Code
 * runs it before every Bash call, and DeepSeek Harness runs the same hook
 * through the `@th3-plug/agent-bridge` plug. The script reads the hook payload
 * on stdin and exits 2 with a reason when a command would
 *
 * - commit, rebase, cherry-pick, revert or `git am` on `main` / `master`,
 * - merge into `main` / `master` (a fast-forward-only merge is allowed), or
 * - push anything to `main` / `master`, including `--all`, `--mirror` and
 *   `HEAD:main`.
 *
 * Everything else passes: `git fetch`, `git pull`, `git switch`, `git status`,
 * `gh pr create` and `gh pr merge` included. A command wrapped in
 * `bash -c "…"` (or `sh` / `zsh -c`) is read as the command it runs. The guard
 * only speaks for the repository that contains it; work in another checkout is
 * none of its business.
 *
 * Set `TH3_GIT_GUARD_ROOT` to guard a different repository (the tests use it).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const PROTECTED = new Set(['main', 'master'])
/** Subcommands that add or rewrite commits on the branch they run on. */
const REWRITES = new Set(['commit', 'rebase', 'cherry-pick', 'revert', 'am'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['-c', '--exec-path', '--namespace'])
const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_NESTING = 2

const real = (path) => { try { return realpathSync(path) } catch { return path } }

/**
 * Split a shell command into segments of words, so `cd x && git commit` and
 * `git commit -m "a; b"` are read the way a shell reads them.
 * @param {string} command - the Bash command line.
 * @returns {string[][]} one word list per command segment.
 */
export function segments(command) {
  const out = []
  let words = []
  let word = ''
  let quote
  let started = false
  const pushWord = () => { if (started) { words.push(word); word = ''; started = false } }
  const pushSegment = () => { pushWord(); if (words.length > 0) { out.push(words); words = [] } }
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]
    if (quote !== undefined) {
      if (char === quote) { quote = undefined; continue }
      if (char === '\\' && quote === '"' && i + 1 < command.length) { word += command[i += 1]; started = true; continue }
      word += char
      started = true
      continue
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue }
    if (char === '\\' && i + 1 < command.length) { word += command[i += 1]; started = true; continue }
    if (char === ' ' || char === '\t') { pushWord(); continue }
    if (char === '\n' || char === ';' || char === '|' || char === '&') {
      pushSegment()
      if ((char === '|' || char === '&') && command[i + 1] === char) i += 1
      continue
    }
    word += char
    started = true
  }
  pushSegment()
  return out
}

/**
 * Read the git invocation of one segment.
 * @param {string[]} words - one segment from {@link segments}.
 * @returns {{ sub: string, args: string[], dir?: string } | undefined} subcommand, its arguments, and a `-C` directory when the segment names one.
 */
export function gitInvocation(words) {
  const at = words.findIndex(word => /(^|\/)git$/.test(word))
  if (at < 0) return undefined
  const rest = words.slice(at + 1)
  let dir
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]
    if (word === '-C') { dir = rest[i + 1]; i += 1; continue }
    if (word.startsWith('-C') && word.length > 2) { dir = word.slice(2); continue }
    if (GLOBAL_OPTIONS_WITH_VALUE.has(word)) { i += 1; continue }
    if (word.startsWith('-')) continue
    return { sub: word, args: rest.slice(i + 1), ...(dir === undefined ? {} : { dir }) }
  }
  return undefined
}

/** The command a `sh -c "…"` (or bash/zsh) segment runs, if it is one. */
export function nestedCommand(words) {
  const at = words.findIndex(word => SHELLS.has(word.split('/').at(-1)))
  if (at < 0) return undefined
  const flag = words.indexOf('-c', at + 1)
  if (flag < 0 || flag + 1 >= words.length) return undefined
  return words[flag + 1]
}

/** The checked-out branch of `dir`, or undefined outside a repository. */
export function branchOf(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

function repositoryOf(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

const hint = branch => [
  `Blocked: work happens on a branch, never directly on ${branch}.`,
  'Create one, commit there, push it, then open the PR:',
  '  git switch -c feat/<plug>-<topic>',
  '  git commit -m "..."',
  '  git push -u origin feat/<plug>-<topic>',
  '  gh pr create --base main --fill',
].join('\n')

const pushHint = (problem, branch, onProtected) => [
  `Blocked: ${problem}.`,
  'main and master change only through a merged pull request.',
  'Push your branch and open the PR instead:',
  `  git push -u origin ${onProtected ? 'feat/<plug>-<topic>' : branch}`,
  '  gh pr create --base main --fill',
].join('\n')

function pushProblem({ sub, args }, branch, onProtected) {
  if (args.includes('--all') || args.includes('--mirror')) return `\`git ${sub} ${args.join(' ')}\` would update main or master`
  const refs = args.filter(arg => !arg.startsWith('-')).slice(1)
  if (refs.length === 0) return onProtected ? `this branch is ${branch}` : undefined
  for (const ref of refs) {
    const bare = ref.replace(/^\+/, '')
    const target = (bare.includes(':') ? bare.split(':').slice(1).join(':') : bare).replace(/^refs\/heads\//, '')
    if (PROTECTED.has(target)) return `this push targets ${target}`
    if ((target === 'HEAD' || target === '@') && onProtected) return `HEAD is ${branch}`
  }
  return undefined
}

/** Inspect one command line. `depth` bounds `bash -c` recursion. */
function inspect(command, startDir, guarded, depth) {
  let dir = startDir
  for (const words of segments(command)) {
    if ((words[0] === 'cd' || words[0] === 'pushd') && words[1] !== undefined) {
      dir = real(isAbsolute(words[1]) ? words[1] : resolve(dir, words[1]))
      continue
    }
    const inner = nestedCommand(words)
    if (inner !== undefined && depth < MAX_NESTING) {
      const decision = inspect(inner, dir, guarded, depth + 1)
      if (!decision.allowed) return decision
      continue
    }
    const git = gitInvocation(words)
    if (git === undefined) continue
    const base = git.dir === undefined ? dir : real(resolve(dir, git.dir))
    const repository = repositoryOf(base)
    if (repository === undefined || real(repository) !== guarded) continue
    const branch = branchOf(base)
    if (branch === undefined || branch === 'HEAD') continue
    const onProtected = PROTECTED.has(branch)
    if (onProtected && REWRITES.has(git.sub)) return { allowed: false, reason: hint(branch) }
    if (onProtected && git.sub === 'merge' && !git.args.includes('--ff-only')) {
      return { allowed: false, reason: `${hint(branch)}\nA fast-forward merge (\`git merge --ff-only\`) is allowed.` }
    }
    if (git.sub === 'push') {
      const problem = pushProblem(git, branch, onProtected)
      if (problem !== undefined) return { allowed: false, reason: pushHint(problem, branch, onProtected) }
    }
  }
  return { allowed: true }
}

/**
 * Decide one Bash call.
 * @param {{ tool_name?: string, tool_input?: { command?: unknown }, cwd?: string }} payload - the hook payload.
 * @param {{ root?: string }} [options] - the guarded repository; defaults to this script's repository.
 * @returns {{ allowed: boolean, reason?: string }} the decision; `reason` is the text shown to the model.
 */
export function evaluate(payload, { root = process.env.TH3_GIT_GUARD_ROOT || SCRIPT_ROOT } = {}) {
  if (payload?.tool_name !== 'Bash') return { allowed: true }
  const command = String(payload.tool_input?.command ?? '')
  if (!command.includes('git')) return { allowed: true }
  const guarded = real(resolve(root))
  return inspect(command, real(resolve(payload.cwd || process.cwd())), guarded, 0)
}

const invokedDirectly = process.argv[1] !== undefined && real(process.argv[1]) === real(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  let payload
  try { payload = JSON.parse(readFileSync(0, 'utf8')) } catch { payload = undefined }
  const decision = evaluate(payload)
  if (!decision.allowed) {
    process.stderr.write(`${decision.reason}\n`)
    process.exit(2)
  }
  process.exit(0)
}
