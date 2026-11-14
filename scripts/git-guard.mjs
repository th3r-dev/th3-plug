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
 * `bash -c "…"` (or `sh` / `zsh -c`) is read as the command it runs, and the
 * branch is found by reading `.git/HEAD` directly. The guard only speaks for
 * the repository that contains it; work in another checkout is none of its
 * business.
 *
 * Set `TH3_GIT_GUARD_ROOT` to guard a different repository (the tests use it).
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const PROTECTED = new Set(['main', 'master'])
/** Subcommands that add or rewrite commits on the branch they run on. */
const REWRITES = new Set(['commit', 'rebase', 'cherry-pick', 'revert', 'am'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const GIT_OPTIONS_WITH_VALUE = new Set(['-c', '--exec-path', '--namespace'])
const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_NESTING = 2

const real = (path) => { try { return realpathSync(path) } catch { return path } }
const isGitWord = word => word === 'git' || word.endsWith('/git')
const blocked = reason => ({ allowed: false, reason })

// ---------------------------------------------------------------- parsing

function pushWord(state) {
  if (!state.started) return
  state.words.push(state.word)
  state.word = ''
  state.started = false
}

function pushSegment(state) {
  pushWord(state)
  if (state.words.length > 0) state.segments.push(state.words)
  state.words = []
}

/** Consume one character inside a quoted word; returns the new index. */
function stepQuoted(state, command, index) {
  const char = command[index]
  if (char === state.quote) { state.quote = undefined; return index }
  if (char === '\\' && state.quote === '"' && index + 1 < command.length) {
    state.word += command[index + 1]
    return index + 1
  }
  state.word += char
  state.started = true
  return index
}

/** Consume one character outside quotes; returns the new index. */
function stepPlain(state, command, index) {
  const char = command[index]
  if (char === "'" || char === '"') { state.quote = char; state.started = true; return index }
  if (char === '\\' && index + 1 < command.length) {
    state.word += command[index + 1]
    state.started = true
    return index + 1
  }
  if (char === ' ' || char === '\t') { pushWord(state); return index }
  if (char === '\n' || char === ';') { pushSegment(state); return index }
  if (char === '|' || char === '&') {
    pushSegment(state)
    return command[index + 1] === char ? index + 1 : index
  }
  state.word += char
  state.started = true
  return index
}

/**
 * Split a shell command into segments of words, so `cd x && git commit` and
 * `git commit -m "a; b"` are read the way a shell reads them.
 * @param {string} command - the Bash command line.
 * @returns {string[][]} one word list per command segment.
 */
export function segments(command) {
  const state = { segments: [], words: [], word: '', quote: undefined, started: false }
  for (let index = 0; index < command.length; index += 1) {
    index = state.quote === undefined ? stepPlain(state, command, index) : stepQuoted(state, command, index)
  }
  pushSegment(state)
  return state.segments
}

/**
 * Read the git invocation of one segment.
 * @param {string[]} words - one segment from {@link segments}.
 * @returns {{ sub: string, args: string[], dir?: string } | undefined} subcommand, its arguments, and a `-C` directory when the segment names one.
 */
export function gitInvocation(words) {
  const at = words.findIndex(isGitWord)
  if (at < 0) return undefined
  const rest = words.slice(at + 1)
  let dir
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index]
    if (word === '-C') { dir = rest[index + 1]; index += 1; continue }
    if (word.startsWith('-C') && word.length > 2) { dir = word.slice(2); continue }
    if (GIT_OPTIONS_WITH_VALUE.has(word)) { index += 1; continue }
    if (word.startsWith('-')) continue
    return { sub: word, args: rest.slice(index + 1), ...(dir === undefined ? {} : { dir }) }
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

// ---------------------------------------------------------------- repository

/**
 * Find the working tree and git directory that own `dir`, by walking up to the
 * nearest `.git` (a directory, or the `gitdir:` file a worktree and submodule
 * use). Reading those files keeps the hook off `PATH` and off a child process.
 * @param {string} dir - absolute directory to start from.
 * @returns {{ root: string, gitDir: string } | undefined} paths of the working tree and its git directory.
 */
export function repositoryOf(dir) {
  let current = real(dir)
  for (;;) {
    const dotGit = join(current, '.git')
    let stat
    try { stat = statSync(dotGit) } catch { stat = undefined }
    if (stat?.isDirectory()) return { root: current, gitDir: dotGit }
    if (stat?.isFile()) return { root: current, gitDir: worktreeGitDir(current, dotGit) }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** The git directory a worktree or submodule `.git` file points at. */
function worktreeGitDir(current, dotGit) {
  try {
    const found = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
    if (found !== null) return resolve(current, found[1].trim())
  } catch { /* unreadable: fall back to the file itself */ }
  return dotGit
}

/**
 * The checked-out branch of `dir`: the ref in HEAD, `HEAD` when detached, or
 * undefined outside a repository.
 * @param {string} dir - absolute directory.
 * @returns {string | undefined} branch name, `HEAD`, or undefined.
 */
export function branchOf(dir) {
  const repository = repositoryOf(dir)
  if (repository === undefined) return undefined
  try {
    const head = readFileSync(join(repository.gitDir, 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return ref === null ? 'HEAD' : ref[1]
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- decision

const branchHint = branch => [
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

const pushTarget = ref => {
  const bare = ref.replace(/^\+/, '')
  const target = bare.includes(':') ? bare.split(':').slice(1).join(':') : bare
  return target.replace(/^refs\/heads\//, '')
}

/** Why a push is not allowed, or undefined when it is. */
function pushProblem({ sub, args }, branch, onProtected) {
  if (args.includes('--all') || args.includes('--mirror')) return `\`git ${sub} ${args.join(' ')}\` would update main or master`
  const refs = args.filter(arg => !arg.startsWith('-')).slice(1)
  if (refs.length === 0) return onProtected ? `this branch is ${branch}` : undefined
  for (const ref of refs) {
    const target = pushTarget(ref)
    if (PROTECTED.has(target)) return `this push targets ${target}`
    if ((target === 'HEAD' || target === '@') && onProtected) return `HEAD is ${branch}`
  }
  return undefined
}

/** The decision for one segment, when it runs git in the guarded repository. */
function gitDecision(words, dir, guarded) {
  const git = gitInvocation(words)
  if (git === undefined) return undefined
  const base = git.dir === undefined ? dir : real(resolve(dir, git.dir))
  const repository = repositoryOf(base)
  if (repository === undefined || repository.root !== guarded) return undefined
  const branch = branchOf(base)
  if (branch === undefined || branch === 'HEAD') return undefined
  const onProtected = PROTECTED.has(branch)
  if (onProtected && REWRITES.has(git.sub)) return blocked(branchHint(branch))
  if (onProtected && git.sub === 'merge' && !git.args.includes('--ff-only')) {
    return blocked(`${branchHint(branch)}\nA fast-forward merge (\`git merge --ff-only\`) is allowed.`)
  }
  if (git.sub !== 'push') return undefined
  const problem = pushProblem(git, branch, onProtected)
  return problem === undefined ? undefined : blocked(pushHint(problem, branch, onProtected))
}

/** Inspect one command line. `depth` bounds `bash -c` recursion. */
function inspect(command, startDir, guarded, depth) {
  let dir = startDir
  for (const words of segments(command)) {
    if ((words[0] === 'cd' || words[0] === 'pushd') && words[1] !== undefined) {
      dir = real(isAbsolute(words[1]) ? words[1] : resolve(dir, words[1]))
      continue
    }
    const nested = nestedCommand(words)
    if (nested !== undefined && depth < MAX_NESTING) {
      const decision = inspect(nested, dir, guarded, depth + 1)
      if (!decision.allowed) return decision
      continue
    }
    const decision = gitDecision(words, dir, guarded)
    if (decision !== undefined) return decision
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
  const raw = payload.tool_input?.command
  const command = typeof raw === 'string' ? raw : ''
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
