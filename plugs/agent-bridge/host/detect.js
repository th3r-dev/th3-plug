/**
 * Find every rule, hook, permission, skill, command, subagent, MCP server and
 * plugin that coding agents keep in a project or in the user's home, and say
 * whether DeepSeek Harness uses it natively, this plug bridges it, or nothing
 * applies it yet (with the fix).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { displayPath, readJsonCached, settingsFiles } from './claude.js'

/** Hook events this plug runs, mapped to the Harness moment it uses. */
export const BRIDGED_EVENTS = {
  PreToolUse: 'before each tool call',
  PostToolUse: 'after each successful tool call',
  PostToolUseFailure: 'after each failed tool call',
  UserPromptSubmit: 'when you send a message',
  SessionStart: 'when a session or subagent starts',
  Stop: 'when the main agent is about to stop',
  SubagentStop: 'when a subagent is about to stop',
  SessionEnd: 'when a session closes',
}

/** Instruction files the Harness loads by itself (dsh-agent-instructions defaults). */
const NATIVE_INSTRUCTIONS = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
const INSTRUCTION_BUDGET = 65_536

const isFile = (path) => { try { return statSync(path).isFile() } catch { return false } }
const isDir = (path) => { try { return statSync(path).isDirectory() } catch { return false } }
const size = (path) => { try { return statSync(path).size } catch { return 0 } }
const list = (dir) => { try { return readdirSync(dir) } catch { return [] } }

function walk(dir, test, out = [], depth = 0) {
  if (depth > 4) return out
  for (const entry of list(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const path = join(dir, entry)
    if (isDir(path)) walk(path, test, out, depth + 1)
    else if (test(entry)) out.push(path)
  }
  return out
}

/** Skill names under a root: directories with SKILL.md, or flat `<name>.md`. */
function skillNames(root) {
  const names = []
  for (const entry of list(root)) {
    if (entry.startsWith('.')) continue
    const path = join(root, entry)
    if (isDir(path) && isFile(join(path, 'SKILL.md'))) names.push(entry)
    else if (entry.endsWith('.md') && isFile(path) && entry !== 'README.md' && entry !== 'VENDORED.md') names.push(entry.slice(0, -3))
  }
  return names.sort((a, b) => a.localeCompare(b))
}

/** Directories from the project root down to `cwd`, broad to specific. */
function chain(root, cwd) {
  const dirs = [root]
  const rel = relative(root, cwd)
  if (!rel || rel.startsWith('..')) return dirs
  let dir = root
  for (const part of rel.split(/[\\/]/)) { dir = join(dir, part); dirs.push(dir) }
  return dirs
}

/** `@path/to/file.md` imports in a CLAUDE.md (outside code spans). */
function imports(path) {
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return [] }
  const found = new Set()
  for (const line of text.replace(/```[\s\S]*?```/g, '').split('\n')) {
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.\-/]+\.md)\b/g)) found.add(m[1])
  }
  return [...found]
}

/**
 * @returns {{ root: string, cwd: string, groups: Array<{ agent: string, items: Array<{ what: string, where: string, status: 'native'|'bridged'|'partial'|'off'|'missing', note?: string }> }> }}
 */
export function detect({ cwd, root, home = homedir(), options }) {
  const dshHome = process.env.DSH_HOME || join(home, '.dsh')
  const agentsHome = process.env.DSH_AGENTS_HOME || join(home, '.agents')
  const show = path => displayPath(path, root, home)
  const groups = []
  const group = (agent) => { const g = { agent, items: [] }; groups.push(g); return g }
  const scopes = options.scopes ?? []

  // ------------------------------------------------------------ Claude Code
  const claude = group('Claude Code')

  // The Harness budgets the whole project chain: it keeps the most specific
  // files and drops broader ones first, truncating the last one that fits.
  const instructionFiles = chain(root, cwd)
    .flatMap(dir => NATIVE_INSTRUCTIONS.map(name => join(dir, name)))
    .filter(isFile)
  const fate = new Map()
  let used = 0
  for (const path of [...instructionFiles].reverse()) {
    const bytes = size(path)
    if (used >= INSTRUCTION_BUDGET) fate.set(path, 'dropped')
    else if (used + bytes > INSTRUCTION_BUDGET) fate.set(path, used === 0 ? 'truncated' : 'dropped')
    else fate.set(path, 'kept')
    used += bytes
  }
  const total = instructionFiles.reduce((sum, path) => sum + size(path), 0)
  for (const path of instructionFiles) {
    const kept = fate.get(path) === 'kept'
    claude.items.push(kept
      ? { what: 'instructions', where: show(path), status: 'native' }
      : { what: 'instructions', where: show(path), status: 'partial', note: `${fate.get(path)}: the chain is ${Math.round(total / 1024)} KiB, over the Harness 64 KiB instruction budget. Raise maxBytes on the dsh-agent-instructions row, or move detail into skills.` })
    if (/CLAUDE(\.local)?\.md$/.test(path)) {
      const found = imports(path)
      if (found.length > 0) claude.items.push({ what: '@imports', where: `${show(path)} → ${found.join(', ')}`, status: 'missing', note: 'The Harness does not follow @path imports; the model only sees the paths.' })
    }
  }
  const userClaudeMd = join(home, '.claude', 'CLAUDE.md')
  if (isFile(userClaudeMd)) {
    const linked = isFile(join(agentsHome, 'AGENTS.md')) || isFile(join(dshHome, 'AGENTS.md'))
    claude.items.push({ what: 'user instructions', where: show(userClaudeMd), status: linked ? 'partial' : 'missing', note: linked ? 'The Harness loads ~/.agents/AGENTS.md and ~/.dsh/AGENTS.md instead; check they hold the same rules.' : 'Not loaded. Fix: ln -s ~/.claude/CLAUDE.md ~/.agents/AGENTS.md' })
  }
  const rulesDir = join(root, '.claude', 'rules')
  const ruleFiles = isDir(rulesDir) ? walk(rulesDir, name => name.endsWith('.md')) : []
  if (ruleFiles.length > 0) claude.items.push({ what: 'rules', where: `${show(rulesDir)} (${ruleFiles.length} files)`, status: 'missing', note: 'The Harness does not read .claude/rules/.' })

  for (const file of settingsFiles(root, home)) {
    const data = readJsonCached(file.path)
    if (data === null) continue
    const where = show(file.path)
    if (data.error) { claude.items.push({ what: 'settings', where, status: 'off', note: `unreadable: ${data.error}` }); continue }
    const enabled = scopes.includes(file.scope)
    const hookEvents = Object.entries(data.hooks ?? {})
    if (data.disableAllHooks === true) claude.items.push({ what: 'hooks', where, status: 'off', note: 'disableAllHooks is true' })
    for (const [event, groupsOfEvent] of hookEvents) {
      const hooks = (groupsOfEvent ?? []).flatMap(g => (g?.hooks ?? []).map(h => ({ ...h, matcher: g.matcher })))
      const commands = hooks.filter(h => (h.type ?? 'command') === 'command')
      const other = hooks.length - commands.length
      const matchers = [...new Set(hooks.map(h => h.matcher || '*'))].join(', ')
      const bridgedEvent = event in BRIDGED_EVENTS && (options.events ?? []).includes(event)
      let status
      let note
      if (!options.hooks) { status = 'off'; note = 'hooks: false in this plug\'s config' }
      else if (!(event in BRIDGED_EVENTS)) { status = 'missing'; note = 'no Harness equivalent yet' }
      else if (!bridgedEvent) { status = 'off'; note = 'event left out of this plug\'s events config' }
      else if (!enabled) { status = 'off'; note = `scope "${file.scope}" is not in this plug's scopes config; add it to run these` }
      else { status = other > 0 ? 'partial' : 'bridged'; note = other > 0 ? `${other} non-command hook(s) (prompt/agent type) are skipped` : BRIDGED_EVENTS[event] }
      claude.items.push({ what: `hook ${event}`, where: `${where} · ${commands.length} command(s) · matcher ${matchers}`, status, note })
    }
    const perms = data.permissions ?? {}
    for (const behavior of ['deny', 'ask']) {
      const rules = perms[behavior] ?? []
      if (rules.length === 0) continue
      claude.items.push({ what: `permissions.${behavior}`, where: `${where} · ${rules.length} rule(s)`, status: !options.permissions ? 'off' : enabled ? 'bridged' : 'off', note: enabled ? (behavior === 'deny' ? 'matching calls are refused' : 'matching calls ask for approval') : `scope "${file.scope}" is not in this plug's scopes config` })
    }
    if ((perms.allow ?? []).length > 0) claude.items.push({ what: 'permissions.allow', where: `${where} · ${perms.allow.length} rule(s)`, status: 'off', note: 'Not applied on purpose: the Harness sandbox and approval mode decide what runs.' })
    if (data.env && Object.keys(data.env).length > 0) claude.items.push({ what: 'env', where: `${where} · ${Object.keys(data.env).join(', ')}`, status: 'missing', note: 'Not exported into Harness tools.' })
    if (data.enabledPlugins && Object.keys(data.enabledPlugins).length > 0) {
      const on = Object.entries(data.enabledPlugins).filter(([, v]) => v).map(([k]) => k)
      if (on.length > 0) claude.items.push({ what: 'plugins', where: `${where} · ${on.join(', ')}`, status: 'missing', note: 'Claude Code plugins (their commands, agents and hooks) do not load in the Harness.' })
    }
  }

  const visible = new Set([
    ...skillNames(join(root, '.dsh', 'skills')),
    ...skillNames(join(root, '.agents', 'skills')),
    ...skillNames(join(dshHome, 'skills')),
    ...skillNames(join(agentsHome, 'skills')),
  ])
  for (const [dir, fix] of [
    [join(root, '.claude', 'skills'), `ln -s ../.claude/skills/<name> ${show(join(root, '.agents', 'skills'))}/<name>`],
    [join(home, '.claude', 'skills'), 'ln -s ~/.claude/skills/<name> ~/.agents/skills/<name>'],
  ]) {
    const names = skillNames(dir)
    if (names.length === 0) continue
    const missing = names.filter(n => !visible.has(n))
    claude.items.push(missing.length === 0
      ? { what: 'skills', where: `${show(dir)} (${names.length})`, status: 'native', note: 'every skill is also in a Harness skill root' }
      : { what: 'skills', where: `${show(dir)} (${names.length})`, status: missing.length === names.length ? 'missing' : 'partial', note: `${missing.length} not visible to the Harness: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''}. Fix: ${fix}` })
  }

  for (const [dir, what] of [
    [join(root, '.claude', 'commands'), 'slash commands'],
    [join(home, '.claude', 'commands'), 'slash commands'],
    [join(root, '.claude', 'agents'), 'subagents'],
    [join(home, '.claude', 'agents'), 'subagents'],
  ]) {
    const files = isDir(dir) ? walk(dir, n => n.endsWith('.md')) : []
    if (files.length > 0) claude.items.push({ what, where: `${show(dir)} (${files.length})`, status: 'missing', note: what === 'subagents' ? 'Harness subagents take a prompt, not a named agent file.' : 'Not registered as Harness commands; ask the agent to follow the file instead.' })
  }

  const mcp = []
  const projectMcp = readJsonCached(join(root, '.mcp.json'))
  if (projectMcp?.mcpServers) mcp.push([show(join(root, '.mcp.json')), Object.keys(projectMcp.mcpServers)])
  const claudeJson = readJsonCached(join(home, '.claude.json'))
  if (claudeJson?.mcpServers && Object.keys(claudeJson.mcpServers).length > 0) mcp.push(['~/.claude.json (user)', Object.keys(claudeJson.mcpServers)])
  const projectEntry = claudeJson?.projects?.[root]
  if (projectEntry?.mcpServers && Object.keys(projectEntry.mcpServers).length > 0) mcp.push(['~/.claude.json (this project)', Object.keys(projectEntry.mcpServers)])
  for (const [where, names] of mcp) claude.items.push({ what: 'MCP servers', where: `${where} · ${names.join(', ')}`, status: 'missing', note: 'Add each one to the Harness with a dsh-mcp-client bundle.' })

  // ------------------------------------------------------------ other agents
  const others = [
    ['Cursor', ['.cursorrules'], ['.cursor/rules'], '.mdc'],
    ['GitHub Copilot', ['.github/copilot-instructions.md'], ['.github/instructions'], '.md'],
    ['Windsurf', ['.windsurfrules'], ['.windsurf/rules'], '.md'],
    ['Cline', ['.clinerules'], ['.clinerules'], '.md'],
    ['Gemini CLI', ['GEMINI.md'], [], '.md'],
    ['Kiro', [], ['.kiro/steering'], '.md'],
  ]
  for (const [agent, files, dirs, ext] of others) {
    const g = { agent, items: [] }
    for (const file of files) {
      const path = join(root, file)
      if (isFile(path)) g.items.push({ what: 'rules', where: show(path), status: 'missing', note: `Not loaded. Fix: add "${file}" to instructionFileCandidates on the dsh-agent-instructions row.` })
    }
    for (const dir of dirs) {
      const path = join(root, dir)
      const found = isDir(path) ? walk(path, n => n.endsWith(ext)) : []
      if (found.length > 0) g.items.push({ what: 'rules', where: `${show(path)} (${found.length})`, status: 'missing', note: 'Not loaded by the Harness.' })
    }
    const geminiSettings = agent === 'Gemini CLI' ? readJsonCached(join(root, '.gemini', 'settings.json')) : null
    if (geminiSettings?.mcpServers) g.items.push({ what: 'MCP servers', where: `.gemini/settings.json · ${Object.keys(geminiSettings.mcpServers).join(', ')}`, status: 'missing' })
    if (g.items.length > 0) groups.push(g)
  }
  const codex = { agent: 'Codex', items: [] }
  if (isFile(join(home, '.codex', 'AGENTS.md'))) codex.items.push({ what: 'user instructions', where: '~/.codex/AGENTS.md', status: 'missing', note: 'Not loaded. Fix: ln -s ~/.codex/AGENTS.md ~/.agents/AGENTS.md' })
  if (codex.items.length > 0) groups.push(codex)

  return { root, cwd, groups }
}

const MARK = { native: '✔ native', bridged: '✔ bridged', partial: '◐ partial', off: '○ off', missing: '✖ not used' }

/** Plain-text report for the `/agent-bridge` command. */
export function formatReport(report, { active }) {
  const lines = [`Agent rules in ${report.root}`]
  if (report.cwd !== report.root) lines.push(`(session folder ${report.cwd})`)
  lines.push(active ? 'Bridge: on for this project' : 'Bridge: off for this project (not in the projects list)')
  let total = 0
  const counts = {}
  for (const g of report.groups) {
    if (g.items.length === 0) continue
    lines.push('', `## ${g.agent}`)
    for (const item of g.items) {
      total++
      counts[item.status] = (counts[item.status] ?? 0) + 1
      lines.push(`${MARK[item.status]}  ${item.what} — ${item.where}`)
      if (item.note) lines.push(`      ${item.note}`)
    }
  }
  if (total === 0) lines.push('', 'Nothing found: no agent rules, hooks or settings in this project or in your home folder.')
  else lines.push('', Object.entries(counts).map(([k, v]) => `${MARK[k]} ${v}`).join(' · '))
  return lines.join('\n')
}
