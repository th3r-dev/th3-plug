// Tests for scripts/git-guard.mjs, the PreToolUse hook that keeps `main` behind
// a pull request. Run: node --test scripts/*.test.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GUARD = fileURLToPath(new URL('./git-guard.mjs', import.meta.url))
const temps = []
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }) })

/** A throwaway repository whose checked-out branch is `main`. */
function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'git-guard-'))
  temps.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['-C', dir, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
  return dir
}

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const feature = (dir, name = 'feat/x') => git(dir, 'switch', '-q', '-c', name)

/** Run the hook exactly as Claude Code does: payload on stdin, exit code back. */
function hook(command, { cwd, root, tool = 'Bash' }) {
  const payload = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd }
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, TH3_GIT_GUARD_ROOT: root ?? cwd },
  })
  return { code: result.status, stderr: result.stderr }
}

// ---------------------------------------------------------------- main guard

test('commits are refused on main and allowed on a branch', () => {
  const dir = repository()
  const blocked = hook('git commit -m "wip"', { cwd: dir })
  assert.equal(blocked.code, 2)
  assert.match(blocked.stderr, /never directly on main/)
  assert.match(blocked.stderr, /git switch -c feat\/<plug>-<topic>/)

  feature(dir)
  assert.equal(hook('git commit -m "wip"', { cwd: dir }).code, 0)
  assert.equal(hook('git commit --amend --no-edit', { cwd: dir }).code, 0)
})

test('main refuses rewrites, a merge, and every push that lands on it', () => {
  const dir = repository()
  for (const command of [
    'git rebase origin/main',
    'git cherry-pick HEAD~1',
    'git revert HEAD',
    'git am patch.mbox',
    'git merge feat/x',
    'git push',
    'git push origin',
    'git push -u origin main',
    'git push origin HEAD:main',
    'git push --delete origin main',
    'git push --all',
  ]) {
    assert.equal(hook(command, { cwd: dir }).code, 2, command)
  }
  assert.equal(hook('git merge --ff-only origin/main', { cwd: dir }).code, 0)
})

test('a feature branch may push itself but never main', () => {
  const dir = repository()
  feature(dir)
  assert.equal(hook('git push -u origin feat/x', { cwd: dir }).code, 0)
  assert.equal(hook('git push', { cwd: dir }).code, 0)
  assert.equal(hook('git push origin main', { cwd: dir }).code, 2)
  assert.equal(hook('git push origin HEAD:refs/heads/main', { cwd: dir }).code, 2)
})

test('a wrapped command is read as the command it runs', () => {
  const dir = repository()
  feature(dir)
  assert.equal(hook('bash -c "git commit -m x"', { cwd: dir }).code, 0, 'feature branch, wrapped commit')
  assert.equal(hook('git commit -m "git push origin main"', { cwd: dir }).code, 0, 'a commit message is not a command')
  assert.equal(hook('sh -c "git push origin main"', { cwd: dir }).code, 2, 'wrapped push to main')
  assert.equal(hook('bash -lc "cd \"$HOME\" && git push"', { cwd: dir }).code, 0, 'another repository is left alone')
})

test('reading, switching and pulling on main pass', () => {
  const dir = repository()
  for (const command of ['git status', 'git switch main', 'git fetch origin', 'git pull --ff-only', 'git log --oneline -3']) {
    assert.equal(hook(command, { cwd: dir }).code, 0, command)
  }
})

// ---------------------------------------------------------------- parsing

test('quoted operators, cd and -C do not hide the command', () => {
  const guarded = repository()
  mkdirSync(join(guarded, 'sub'), { recursive: true })

  assert.equal(hook('git commit -m "fix; main && stuff"', { cwd: guarded }).code, 2, 'main is guarded whatever the message says')
  assert.equal(hook('git commit -m x', { cwd: join(guarded, 'sub'), root: guarded }).code, 2, 'a subdirectory is the same repository')
  assert.equal(hook('cd sub && git commit -m x', { cwd: guarded }).code, 2, 'cd resolves into the guarded repository')
  assert.equal(hook(`git -C "${guarded}" commit -m x`, { cwd: tmpdir(), root: guarded }).code, 2, '-C is resolved')
  assert.equal(hook(`git -C "${guarded}/sub" commit -m x`, { cwd: tmpdir(), root: guarded }).code, 2, '-C into a subdirectory is guarded')

  feature(guarded)
  assert.equal(hook('git commit -m "fix; main && stuff"', { cwd: guarded }).code, 0, 'quoted text is not a command')
  assert.equal(hook('cd sub && git commit -m x', { cwd: guarded }).code, 0, 'cd inside the feature branch')
})

test('another repository is not this guard\'s business', () => {
  const mine = repository()
  const other = repository()
  feature(mine)
  assert.equal(hook('git commit -m x', { cwd: other, root: mine }).code, 0)
  assert.equal(hook(`git -C "${other}" commit -m x`, { cwd: mine }).code, 0)
})

test('non-Bash tools, other programs and empty payloads pass', () => {
  const dir = repository()
  assert.equal(hook('git commit -m x', { cwd: dir, tool: 'Read' }).code, 0)
  assert.equal(hook('gh pr create --base main --fill', { cwd: dir }).code, 0)
  assert.equal(hook('npm run verify', { cwd: dir }).code, 0)
  const empty = spawnSync(process.execPath, [GUARD], { input: '', encoding: 'utf8', env: { ...process.env, TH3_GIT_GUARD_ROOT: dir } })
  assert.equal(empty.status, 0)
})

test('the reason names the branch to create and the PR to open', () => {
  const dir = repository()
  const { stderr } = hook('git push origin main', { cwd: dir })
  assert.match(stderr, /change only through a merged pull request/)
  assert.match(stderr, /gh pr create --base main --fill/)
})
