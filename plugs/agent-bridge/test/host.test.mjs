// Host-half tests for @th3-plug/agent-bridge. Run: node --test plugs/agent-bridge/test/*.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  fromUpdatedInput, interpretHook, matcherMatches, mergeOutcomes, parseRule,
  permissionVerdict, toClaudeCall,
} from '../host/claude.js'
import { BRIDGED_EVENTS, detect } from '../host/detect.js'
import { apply } from '../host/index.js'

const temps = []
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }) })

/** A throwaway git project with a .claude/settings.json. */
function project(settings, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-'))
  temps.push(root)
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(settings))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true })
    writeFileSync(join(root, name), text)
  }
  return root
}

/** Shell snippet: swallow stdin, print `json`. */
const reply = json => `cat >/dev/null; printf '%s' '${JSON.stringify(json)}'`

function fakeContext(cwd) {
  const seen = { commands: [], listeners: {}, injected: [], steered: [] }
  const agent = {
    id: 'session-1',
    session: {},
    inject: message => seen.injected.push(message),
    steer: message => seen.steered.push(message),
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'workingDirectory') return { get: () => cwd, ensure: async () => cwd }
      if (name === 'agents') return { roots: () => [agent] }
      return undefined
    },
    on(name, listener) { seen.listeners[name] = listener; return () => {} },
    effect(body) { for (const _ of body()) { /* run registrations */ } },
    commands: { register(definition) { seen.commands.push(definition); return () => {} } },
  }
  return { ctx, seen, agent }
}

const signal = new AbortController().signal
const allow = async () => ({ kind: 'allow' })
const exec = (agent, name, args) => ({ token: Symbol(name), callId: 'c1', name, arguments: args, agent, signal })

// ---------------------------------------------------------------- pure parts

test('matchers follow Claude Code: exact lists, regex otherwise, empty matches all', () => {
  assert.equal(matcherMatches('Bash|Write', ['Bash', 'bash']), true)
  assert.equal(matcherMatches('Bash', ['BashOutput']), false)
  assert.equal(matcherMatches('Read|read_file|view_file', ['Read', 'read']), true)
  assert.equal(matcherMatches('mcp__.*', ['mcp__github__issue']), true)
  assert.equal(matcherMatches(undefined, ['Anything']), true)
  assert.equal(matcherMatches('*', ['Anything']), true)
})

test('Harness calls are shown to hooks as Claude Code tools with absolute paths', () => {
  const read = toClaudeCall('read', { file_path: 'a/b.pdf', limit: 5 }, '/repo')
  assert.equal(read.name, 'Read')
  assert.deepEqual(read.input, { file_path: '/repo/a/b.pdf', limit: 5 })
  const task = toClaudeCall('subagent', { description: 'd', prompt: 'p' }, '/repo')
  assert.equal(task.name, 'Task')
  assert.ok(task.names.includes('Agent'))
  assert.equal(task.input.subagent_type, 'general-purpose')
  assert.equal(toClaudeCall('grep', { pattern: 'x', include: '*.py' }, '/r').input.glob, '*.py')
  assert.equal(toClaudeCall('mcp__x__y', { a: 1 }, '/r').name, 'mcp__x__y')
})

test('updatedInput maps back to Harness arguments, ignoring echoed values', () => {
  const shown = { description: 'd', prompt: 'p', subagent_type: 'general-purpose' }
  assert.deepEqual(fromUpdatedInput('subagent', { description: 'd', prompt: 'p' }, shown, { ...shown, prompt: 'p + rules' }), { description: 'd', prompt: 'p + rules' })
  assert.equal(fromUpdatedInput('subagent', { description: 'd', prompt: 'p' }, shown, shown), undefined)
  const shownRead = { file_path: '/repo/x.txt' }
  assert.equal(fromUpdatedInput('read', { file_path: 'x.txt' }, shownRead, { file_path: '/repo/x.txt' }), undefined)
})

test('permission rules: Bash prefixes, compound commands, path globs, families', () => {
  const rules = ['Bash(rm -rf:*)', 'Read(./.env)', 'Edit(/Source/**)', 'WebFetch(domain:example.com)']
    .map(rule => ({ behavior: 'deny', rule, base: '/repo', file: '/repo/.claude/settings.json', ...parseRule(rule) }))
  rules.push({ behavior: 'ask', rule: 'Bash(git push:*)', base: '/repo', ...parseRule('Bash(git push:*)') })
  const verdict = (name, args) => permissionVerdict(rules, toClaudeCall(name, args, '/repo'), { cwd: '/repo', home: '/home/u' })
  assert.equal(verdict('bash', { command: 'rm -rf build' })?.behavior, 'deny')
  assert.equal(verdict('bash', { command: 'ls && rm -rf /' })?.behavior, 'deny')
  assert.equal(verdict('bash', { command: 'rmdir x' }), undefined)
  assert.equal(verdict('bash', { command: 'git push origin main' })?.behavior, 'ask')
  assert.equal(verdict('read', { file_path: '.env' })?.behavior, 'deny')
  assert.equal(verdict('read', { file_path: 'src/.env' }), undefined)
  assert.equal(verdict('write', { file_path: '/repo/Source/2026/a.pdf', content: '' })?.behavior, 'deny')
  assert.equal(verdict('write', { file_path: '/repo/work/a.sql', content: '' }), undefined)
  assert.equal(verdict('web_fetch', { url: 'https://docs.example.com/x' })?.behavior, 'deny')
})

test('hook output: exit 2 blocks, JSON decides, plain stdout is prompt context', () => {
  assert.deepEqual(interpretHook('PreToolUse', { code: 2, stdout: '', stderr: 'no pdf' }), { contexts: [], decision: 'deny', reason: 'no pdf' })
  const json = interpretHook('PreToolUse', { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'r' } }) })
  assert.equal(json.decision, 'deny')
  assert.equal(json.reason, 'r')
  assert.deepEqual(interpretHook('UserPromptSubmit', { code: 0, stdout: 'remember X\n' }).contexts, ['remember X'])
  assert.equal(interpretHook('PostToolUse', { code: 0, stdout: 'ignored' }).contexts.length, 0)
  assert.equal(interpretHook('Stop', { code: 0, stdout: '{"decision":"block","reason":"tests"}' }).decision, 'block')
  assert.ok(interpretHook('PreToolUse', { code: 1, stdout: '', stderr: 'boom' }).note)
  const merged = mergeOutcomes([{ contexts: ['a'], decision: 'allow' }, { contexts: ['b'], decision: 'deny', reason: 'x' }])
  assert.equal(merged.decision, 'deny')
  assert.deepEqual(merged.contexts, ['a', 'b'])
})

// ---------------------------------------------------------------- wired plug

test('PreToolUse hooks and deny rules refuse matching calls; others pass', async () => {
  const root = project({
    hooks: {
      PreToolUse: [
        { matcher: 'Read', hooks: [{ type: 'command', command: `cat > "$CLAUDE_PROJECT_DIR/seen.json"; printf '%s' '${JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'read the TSV' } })}'` }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'cat >/dev/null; echo "not today" >&2; exit 2' }] },
      ],
    },
    permissions: { deny: ['Write(./secret.txt)'] },
  })
  const { ctx, seen, agent } = fakeContext(root)
  apply(ctx, {})
  const pre = seen.listeners['tools/pre-execute']

  const read = await pre(exec(agent, 'read', { file_path: 'scan.pdf' }), allow)
  assert.deepEqual(read, { kind: 'deny', reason: 'read the TSV' })
  const { readFileSync } = await import('node:fs')
  const input = JSON.parse(readFileSync(join(root, 'seen.json'), 'utf8'))
  assert.equal(input.hook_event_name, 'PreToolUse')
  assert.equal(input.tool_name, 'Read')
  assert.equal(input.tool_input.file_path, join(root, 'scan.pdf'))
  assert.equal(input.session_id, 'session-1')

  assert.deepEqual(await pre(exec(agent, 'bash', { command: 'ls' }), allow), { kind: 'deny', reason: 'not today' })
  const write = await pre(exec(agent, 'write', { file_path: 'secret.txt', content: '' }), allow)
  assert.equal(write.kind, 'deny')
  assert.match(write.reason, /Write\(\.\/secret\.txt\)/)
  assert.deepEqual(await pre(exec(agent, 'glob', { pattern: '*' }), allow), { kind: 'allow' })
  assert.deepEqual(await pre(exec(agent, 'read', { file_path: 'x' }), async () => ({ kind: 'deny', reason: 'other' })), { kind: 'deny', reason: 'other' })
})

test('updatedInput becomes a retry with the rewritten arguments', async () => {
  const root = project({
    hooks: { PreToolUse: [{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: reply({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { description: 'd', prompt: 'p\n\nRULES' } } }) }] }] },
  })
  const { ctx, seen, agent } = fakeContext(root)
  apply(ctx, {})
  const result = await seen.listeners['tools/pre-execute'](exec(agent, 'subagent', { description: 'd', prompt: 'p' }), allow)
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /"prompt":"p\\n\\nRULES"/)
})

test('UserPromptSubmit adds context after the prompt, or blocks it', async () => {
  const root = project({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `cat | grep -q forbidden && { echo "secret work" >&2; exit 2; }; ${reply({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Rules apply.' } })}` }] }] },
  })
  const { ctx, seen, agent } = fakeContext(root)
  apply(ctx, {})
  const preStep = seen.listeners['agent/pre-step']
  const user = text => ({ id: text, source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const enter = messages => async () => ({ kind: 'enter', messages })

  const ok = await preStep({ agent, messages: [], step: 1, signal }, enter([user('hello')]))
  assert.equal(ok.messages.length, 2)
  assert.equal(ok.messages[1].source.kind, 'th3-agent-bridge')
  assert.match(ok.messages[1].content[0].text, /Rules apply\./)

  const blocked = await preStep({ agent, messages: [], step: 1, signal }, enter([user('do the forbidden thing')]))
  assert.equal(blocked.messages.length, 1)
  assert.match(blocked.messages[0].content[0].text, /blocked.*\n?.*secret work/s)
})

test('PostToolUse context and SessionStart context reach the model', async () => {
  const root = project({
    hooks: {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `cat > "$CLAUDE_PROJECT_DIR/post.json"; ${reply({ systemMessage: 'stamped 2 files' })}` }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'cat >/dev/null; echo "Read the rules first."' }] }],
    },
  })
  const { ctx, seen, agent } = fakeContext(root)
  apply(ctx, {})
  const post = await seen.listeners['tools/post-execute'](
    exec(agent, 'bash', { command: 'make' }),
    { content: [{ type: 'text', text: 'built' }], value: 'built', isError: false },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(post.kind, 'accept')
  assert.equal(post.additionalContexts.length, 1)
  assert.match(post.additionalContexts[0].content[0].text, /stamped 2 files/)
  const { readFileSync } = await import('node:fs')
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'post.json'), 'utf8')).tool_response, { stdout: 'built', stderr: '', interrupted: false, isImage: false })

  await seen.listeners['agent/created']({ agent, source: 'startup', signal })
  assert.equal(seen.injected.length, 1)
  assert.match(seen.injected[0].content[0].text, /Read the rules first\./)
})

test('Stop hooks can keep the agent going, up to the limit', async () => {
  const root = project({ hooks: { Stop: [{ hooks: [{ type: 'command', command: reply({ decision: 'block', reason: 'run the tests' }) }] }] } })
  const { ctx, seen, agent } = fakeContext(root)
  apply(ctx, { maxStopContinuations: 2 })
  const stop = seen.listeners['agent/turn-stopping']
  for (let i = 0; i < 3; i++) await stop({ agent, turn: 1, signal })
  assert.equal(seen.steered.length, 2)
  assert.match(seen.steered[0].content[0].text, /run the tests/)
})

test('user-scope hooks stay off unless enabled', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bridge-home-'))
  temps.push(home)
  const root = project({})
  const { loadClaudeSettings } = await import('../host/claude.js')
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }))
  assert.equal(loadClaudeSettings(root, { home }).hooks.length, 0)
  assert.equal(loadClaudeSettings(root, { home, scopes: ['user'] }).hooks.length, 1)
})

test('/agent-bridge reports native, bridged and unused items', async () => {
  const root = project(
    { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }], Notification: [{ hooks: [{ type: 'command', command: 'true' }] }] } },
    {
      'AGENTS.md': 'a'.repeat(20_000),
      'CLAUDE.md': `${'c'.repeat(50_000)}\nSee @docs/extra.md\n`,
      '.cursorrules': 'be nice',
      '.claude/rules/sql.md': 'x',
      '.mcp.json': JSON.stringify({ mcpServers: { db: {} } }),
    },
  )
  const home = mkdtempSync(join(tmpdir(), 'agent-bridge-home-'))
  temps.push(home)
  const report = detect({ cwd: root, root, home, options: { hooks: true, permissions: true, scopes: ['project', 'local'], events: Object.keys(BRIDGED_EVENTS) } })
  const items = report.groups.flatMap(g => g.items.map(i => ({ agent: g.agent, ...i })))
  const find = (what, where = '') => items.find(i => i.what === what && i.where.includes(where))
  assert.equal(find('instructions', 'AGENTS.md').status, 'partial')
  assert.equal(find('instructions', 'CLAUDE.md').status, 'native')
  assert.equal(find('@imports').status, 'missing')
  assert.equal(find('hook PreToolUse').status, 'bridged')
  assert.equal(find('hook Notification').status, 'missing')
  assert.equal(find('rules', '.claude/rules').status, 'missing')
  assert.equal(find('MCP servers', '.mcp.json').status, 'missing')
  assert.equal(items.find(i => i.agent === 'Cursor')?.status, 'missing')

  const { ctx, seen } = fakeContext(root)
  apply(ctx, {})
  const command = seen.commands.find(c => c.name === 'agent-bridge')
  const result = await command.handler({ agent: { session: {} }, rawInput: '', signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /✔ bridged {2}hook PreToolUse/)
})
