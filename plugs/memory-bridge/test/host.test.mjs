// Host-half tests for @th3-plug/memory-bridge. Run: node --test plugs/memory-bridge/test/*.test.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import {
  budgetFiles, claudeInstructions, deleteNote, loadIndex, locateMemory, noteName,
  parseFrontmatter, projectSlug, readNote, repoRoot, saveNote,
} from '../host/memory.js'
import { SOURCE_KIND, apply, visibleMemory } from '../host/index.js'

const temps = []
const temp = (prefix) => { const dir = mkdtempSync(join(tmpdir(), prefix)); temps.push(dir); return dir }
const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }

let home
const saved = {}
before(() => {
  home = temp('memory-bridge-home-')
  for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_PROJECT_DIR_NAME', 'DSH_HOME', 'DSH_AGENTS_HOME']) saved[key] = process.env[key]
  process.env.HOME = home
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME
  process.env.DSH_HOME = join(home, '.dsh')
  process.env.DSH_AGENTS_HOME = join(home, '.agents')
})
after(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/** A git project and its Claude Code memory folder under the fake home. */
function project(index = '', notes = {}) {
  const root = temp('memory-bridge-proj-')
  mkdirSync(join(root, '.git'))
  const dir = join(home, '.claude', 'projects', projectSlug(root), 'memory')
  mkdirSync(dir, { recursive: true })
  if (index) writeFileSync(join(dir, 'MEMORY.md'), index)
  for (const [name, text] of Object.entries(notes)) writeFileSync(join(dir, name), text)
  return { root, dir }
}

function fakeContext(cwd, { root = true } = {}) {
  const seen = { commands: [], tools: [], listeners: {}, sections: [] }
  const surface = []
  const agent = {
    id: 'session-1',
    session: { surface: { nodes: surface.map((_, i) => i) }, eventAt: i => surface[i] },
  }
  const commit = (messages) => {
    for (const m of messages) surface.push({ type: 'user/message', data: { source: m.source } })
    agent.session.surface.nodes = surface.map((_, i) => i)
  }
  const compact = () => { surface.length = 0; agent.session.surface.nodes = [] }
  const ctx = {
    logger: { info() {}, warn(m) { throw new Error(m) } },
    get(name) {
      if (name === 'workingDirectory') return { get: () => cwd, ensure: async () => cwd }
      if (name === 'agents') return { roots: () => (root ? [agent] : []) }
      if (name === 'systemPrompt') return { section(definition) { seen.sections.push(definition); return () => {} } }
      return undefined
    },
    on(name, listener) { seen.listeners[name] = listener; return () => {} },
    effect(body) { for (const _ of body()) { /* run registrations */ } },
    commands: { register(definition) { seen.commands.push(definition); return () => {} } },
    tools: { register(definition) { seen.tools.push(definition); return () => {} } },
  }
  return { ctx, seen, agent, commit, compact }
}

const signal = new AbortController().signal
const userMessage = text => ({ id: 'u', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const step = async (seen, agent, messages) => seen.listeners['agent/pre-step']({ agent, messages, signal, step: 1 }, async () => ({ kind: 'enter', messages }))
const ours = decision => decision.messages.filter(m => m.source?.kind === SOURCE_KIND)

// ---------------------------------------------------------------- locating

test('the memory folder follows Claude Code: slug of the repository root', () => {
  assert.equal(projectSlug('/Users/me/Desktop/Work/Ada-Soft/ocm-workbench'), '-Users-me-Desktop-Work-Ada-Soft-ocm-workbench')
  assert.equal(projectSlug('/Users/me/My Drive/a@b.com'), '-Users-me-My-Drive-a-b-com')
  const { root, dir } = project()
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  assert.equal(repoRoot(join(root, 'src', 'deep')), root)
  assert.equal(locateMemory(join(root, 'src'), { home, env: {} }).dir, dir)
})

test('a linked worktree shares the main checkout memory', () => {
  const { root } = project()
  const worktree = temp('memory-bridge-wt-')
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(root, '.git', 'worktrees', 'feature')}\n`)
  assert.equal(repoRoot(worktree), root)
})

test('autoMemoryDirectory, autoMemoryEnabled and the env switch are honoured', () => {
  const { root } = project()
  write(join(root, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: '~/notes' }))
  assert.equal(locateMemory(root, { home, env: {} }).dir, join(home, 'notes'))
  write(join(root, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryEnabled: false }))
  assert.equal(locateMemory(root, { home, env: {} }).enabled, false)
  const other = project()
  assert.equal(locateMemory(other.root, { home, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } }).enabled, false)
})

test('the index loads like Claude Code: first 200 lines or 25 KB', () => {
  const { dir } = project(Array.from({ length: 250 }, (_, i) => `- [n${i}](n${i}.md) — note ${i}`).join('\n'))
  const byLines = loadIndex(dir)
  assert.equal(byLines.lines.length, 200)
  assert.equal(byLines.truncated, true)
  assert.equal(byLines.totalLines, 250)
  const byBytes = loadIndex(dir, { maxBytes: 100 })
  assert.ok(byBytes.lines.length < 5)
})

// ---------------------------------------------------------------- notes

test('saveNote writes Claude Code\'s note format and index line', () => {
  const { dir } = project('- [Old](old.md) — first\n')
  const result = saveNote(dir, { name: 'prefers-pnpm', title: 'Use pnpm', description: 'Use pnpm: not npm', type: 'feedback', content: 'Use pnpm.\n\n**Why:** lockfile.', sessionId: 's1', now: new Date('2026-11-10T00:00:00Z') })
  assert.equal(result.created, true)
  const text = readFileSync(join(dir, 'prefers-pnpm.md'), 'utf8')
  const { data, body } = parseFrontmatter(text)
  assert.equal(data.name, 'prefers-pnpm')
  assert.equal(data.description, 'Use pnpm: not npm')
  assert.deepEqual(data.metadata, { node_type: 'memory', type: 'feedback', originSessionId: 's1', modified: '2026-11-10T00:00:00.000Z' })
  assert.match(body, /^\nUse pnpm\./)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Old](old.md) — first\n- [Use pnpm](prefers-pnpm.md) — Use pnpm: not npm\n')

  const again = saveNote(dir, { name: 'prefers-pnpm', description: 'pnpm only', type: 'feedback', content: 'x', sessionId: 's2' })
  assert.equal(again.created, false)
  assert.equal(again.replacedLine, '- [Use pnpm](prefers-pnpm.md) — Use pnpm: not npm')
  assert.equal(parseFrontmatter(readFileSync(join(dir, 'prefers-pnpm.md'), 'utf8')).data.metadata.originSessionId, 's1')
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Old](old.md) — first\n- [prefers-pnpm](prefers-pnpm.md) — pnpm only\n')

  const gone = deleteNote(dir, 'prefers-pnpm')
  assert.equal(gone.existed, true)
  assert.equal(existsSync(join(dir, 'prefers-pnpm.md')), false)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Old](old.md) — first\n')
})

test('note names cannot escape the folder or clobber the index', () => {
  for (const bad of ['../x', 'a/b', 'MEMORY', '', '.hidden']) assert.throws(() => noteName(bad))
  assert.equal(noteName('user_role.md'), 'user_role')
  const { dir } = project('- [a](a.md) — a\n')
  assert.match(readNote(dir, 'MEMORY').text, /\[a\]/)
})

// ---------------------------------------------------------------- instructions

test('Claude-only instruction files are bridged, duplicates and path-scoped rules are not', () => {
  const { root } = project()
  const configDir = join(home, '.claude')
  write(join(configDir, 'CLAUDE.md'), '# Me\nAlways reply briefly.\n<!-- note to self -->\n')
  write(join(root, '.claude', 'CLAUDE.md'), 'Project rule.')
  write(join(root, 'CLAUDE.md'), 'Root rule.')
  write(join(root, '.claude', 'rules', 'style.md'), '---\ndescription: x\n---\nTwo spaces.')
  write(join(root, '.claude', 'rules', 'api.md'), '---\npaths:\n  - "src/api/**"\n---\nValidate input.')
  write(join(root, '.claude', 'rules', 'dup.md'), 'Root rule.')
  const found = claudeInstructions({ root, configDir, home, env: process.env })
  assert.deepEqual(found.files.map(f => f.display), ['~/.claude/CLAUDE.md', '.claude/CLAUDE.md', '.claude/rules/style.md'])
  assert.equal(found.files[0].content, '# Me\nAlways reply briefly.')
  assert.equal(found.files[2].content, 'Two spaces.')
  assert.deepEqual(found.scoped, [join(root, '.claude', 'rules', 'api.md')])
  assert.equal(found.skipped.length, 1)

  write(join(home, '.agents', 'AGENTS.md'), '# Me\nAlways reply briefly.\n<!-- note to self -->\n')
  assert.ok(!claudeInstructions({ root, configDir, home, env: process.env }).files.some(f => f.display === '~/.claude/CLAUDE.md'))
  rmSync(join(home, '.agents'), { recursive: true })
  rmSync(join(configDir, 'CLAUDE.md'))
})

test('the instruction budget cuts the first file that does not fit and drops the rest', () => {
  const files = [{ display: 'a', content: 'a'.repeat(600) }, { display: 'b', content: 'b'.repeat(2000) }, { display: 'c', content: 'c' }]
  const { kept, omitted } = budgetFiles(files, 1500)
  assert.deepEqual(kept.map(f => f.display), ['a', 'b'])
  assert.equal(kept[1].truncatedFrom, 2000)
  assert.deepEqual(omitted.map(f => f.display), ['c'])
})

// ---------------------------------------------------------------- context

test('the first step gets the memory once; compaction brings it back', async () => {
  const { root, dir } = project('- [Report style](tcm-report-style.md) — opens on สรุป\n')
  const { ctx, seen, agent, commit, compact } = fakeContext(root)
  apply(ctx, { instructions: false })
  const first = await step(seen, agent, [userMessage('hi')])
  const [baseline] = ours(first)
  assert.ok(baseline, 'baseline injected')
  assert.equal(first.messages[0].source.kind, 'user')
  const text = baseline.content[0].text
  assert.ok(text.includes(dir))
  assert.ok(text.includes('- [Report style](tcm-report-style.md) — opens on สรุป'))
  assert.ok(text.includes('`memory`'))
  assert.equal(baseline.source.form, 'baseline')
  assert.deepEqual(baseline.source.lines, ['- [Report style](tcm-report-style.md) — opens on สรุป'])
  commit(ours(first))

  const second = await step(seen, agent, [userMessage('again')])
  assert.equal(ours(second).length, 0)

  compact()
  const third = await step(seen, agent, [userMessage('after compaction')])
  assert.equal(ours(third)[0]?.source.form, 'baseline')
})

test('an empty memory still teaches saving; subagents get nothing by default', async () => {
  const { root } = project()
  const { ctx, seen, agent } = fakeContext(root)
  apply(ctx, { instructions: false })
  const decision = await step(seen, agent, [userMessage('hi')])
  assert.match(ours(decision)[0].content[0].text, /empty: no notes saved yet/)

  const sub = fakeContext(root, { root: false })
  apply(sub.ctx, {})
  assert.equal(ours(await step(sub.seen, sub.agent, [userMessage('task')])).length, 0)
})

test('index lines changed outside the session are announced; the tool\'s own saves are not', async () => {
  const { root, dir } = project('- [a](a.md) — a\n')
  const { ctx, seen, agent, commit } = fakeContext(root)
  apply(ctx, { instructions: false })
  commit(ours(await step(seen, agent, [userMessage('hi')])))

  const tool = seen.tools.find(t => t.name === 'memory')
  await tool.execute({ action: 'save', name: 'mine', description: 'mine', type: 'project', content: 'x' }, { agent, signal })
  assert.equal(ours(await step(seen, agent, [userMessage('next')])).length, 0, 'own save is already known')

  writeFileSync(join(dir, 'MEMORY.md'), `${readFileSync(join(dir, 'MEMORY.md'), 'utf8')}- [b](b.md) — from Claude Code\n`)
  const announced = ours(await step(seen, agent, [userMessage('later')]))
  assert.equal(announced.length, 1)
  assert.match(announced[0].content[0].text, /Added:\n- \[b\]\(b\.md\) — from Claude Code/)
  assert.ok(!announced[0].content[0].text.includes('mine'))
  commit(announced)
  assert.deepEqual([...visibleMemory(agent).lines].sort(), ['- [a](a.md) — a', '- [b](b.md) — from Claude Code', '- [mine](mine.md) — mine'])

  const toolOnly = await seen.listeners['agent/pre-step']({ agent, messages: [], signal, step: 2 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(ours(toolOnly).length, 0, 'refresh waits for a user message')
})

test('Claude Code instruction files ride in the same message', async () => {
  const { root } = project()
  write(join(home, '.claude', 'CLAUDE.md'), 'Global preference.')
  const { ctx, seen, agent } = fakeContext(root)
  apply(ctx, { autoMemory: false })
  const [message] = ours(await step(seen, agent, [userMessage('hi')]))
  assert.match(message.content[0].text, /Instructions from: ~\/\.claude\/CLAUDE\.md\n\nGlobal preference\./)
  assert.ok(!message.content[0].text.includes('Shared memory'))
  rmSync(join(home, '.claude', 'CLAUDE.md'))
})

// ---------------------------------------------------------------- tool and command

test('the memory tool reads, saves and deletes notes', async () => {
  const { root, dir } = project('- [a](a.md) — a\n', { 'a.md': '---\nname: a\n---\n\nbody a\n' })
  const { ctx, seen, agent } = fakeContext(root)
  apply(ctx, {})
  const tool = seen.tools.find(t => t.name === 'memory')
  assert.deepEqual(tool.parameters.required, ['action'])
  const listed = await tool.execute({ action: 'list' }, { agent, signal })
  assert.match(listed.text, /a · untyped/)
  const read = await tool.execute({ action: 'read', name: 'a' }, { agent, signal })
  assert.match(read.text, /body a/)
  assert.equal(tool.output.render({}, read)[0].text, read.text)
  await assert.rejects(tool.execute({ action: 'save', name: 'b', type: 'user' }, { agent, signal }), /save needs description/)
  await assert.rejects(tool.execute({ action: 'save', type: 'user', description: 'd', content: 'c' }, { agent, signal }), /save needs name/)
  await assert.rejects(tool.execute({ action: 'write', name: 'b' }, { agent, signal }), /action must be list, read, save or delete/)
  const saved = await tool.execute({ action: 'save', name: 'b', type: 'user', description: 'b note', content: 'B.' }, { agent, signal })
  assert.match(saved.text, /Saved new note .*b\.md\nIndex line: - \[b\]\(b\.md\) — b note\nMEMORY\.md: 2 lines/)
  const deleted = await tool.execute({ action: 'delete', name: 'a' }, { agent, signal })
  assert.match(deleted.text, /Removed index line: - \[a\]\(a\.md\) — a/)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [b](b.md) — b note\n')
})

test('the tool refuses when auto memory is off for the project', async () => {
  const { root } = project()
  write(join(root, '.claude', 'settings.json'), JSON.stringify({ autoMemoryEnabled: false }))
  const { ctx, seen, agent } = fakeContext(root)
  apply(ctx, {})
  await assert.rejects(seen.tools[0].execute({ action: 'read', name: 'MEMORY' }, { agent, signal }), /auto memory is off/)
})

test('/memory reports the folder, notes and limits', async () => {
  const { root } = project('- [a](a.md) — a\n', { 'a.md': '---\nname: a\nmetadata:\n  type: feedback\n---\nx\n', 'b.md': '---\nname: b\nmetadata:\n  type: project\n---\ny\n' })
  const { ctx, seen, agent } = fakeContext(root)
  apply(ctx, {})
  const command = seen.commands.find(c => c.name === 'memory')
  const { kind, text } = await command.handler({ agent, rawInput: '', signal })
  assert.equal(kind, 'success')
  assert.match(text, /Folder: ~\/\.claude\/projects\/.*\/memory/)
  assert.match(text, /✔ memory: 2 notes \(1 feedback, 1 project\)/)
  assert.match(text, /1 note file\(s\) not in the index: b\.md/)
})

// ---------------------------------------------------------------- any model

test('the memory protocol is a system-prompt section, on by default and switchable', () => {
  const { root } = project()
  const on = fakeContext(root)
  apply(on.ctx, {})
  assert.equal(on.seen.sections.length, 1)
  const [section] = on.seen.sections
  assert.equal(section.name, 'th3-memory-bridge')
  assert.equal(section.order, 910)
  assert.match(section.text, /^Shared memory:/)
  assert.match(section.text, /`memory` with action `save`/)
  assert.match(section.text, /action `read`/)
  assert.match(section.text, /action `delete`/)
  assert.ok(!/Claude|DeepSeek|GPT|Gemini/.test(section.text), 'the protocol names no model or vendor')

  const off = fakeContext(root)
  apply(off.ctx, { promptSection: false })
  assert.equal(off.seen.sections.length, 0)

  const noTool = fakeContext(root)
  apply(noTool.ctx, { tool: false })
  assert.equal(noTool.seen.sections.length, 0, 'no protocol for a tool that is not registered')
})

test('the memory message is model-neutral and lists every action', async () => {
  const { root } = project('- [a](a.md) — a\n')
  const { ctx, seen, agent } = fakeContext(root)
  apply(ctx, { instructions: false })
  const [message] = ours(await step(seen, agent, [userMessage('hi')]))
  const text = message.content[0].text
  assert.match(text, /Claude Code and this Harness \(on any model\) read and write the same notes/)
  for (const action of ['read', 'save', 'delete', 'list']) assert.ok(text.includes(`\`${action}\``), action)
  assert.ok(!/as an AI language model|You are Claude/.test(text))
})

test('list works on an empty memory and on a folder with unindexed notes', async () => {
  const { root } = project('', { 'stray.md': '---\nname: stray\ndescription: not in index\n---\nx\n' })
  const { ctx, seen, agent } = fakeContext(root)
  apply(ctx, {})
  const tool = seen.tools.find(t => t.name === 'memory')
  const text = (await tool.execute({ action: 'list' }, { agent, signal })).text
  assert.match(text, /1 note\(s\); MEMORY\.md 0 lines/)
  assert.match(text, /stray · untyped · not in index/)
})
