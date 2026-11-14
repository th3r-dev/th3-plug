/**
 * Claude Code compatibility: where its settings live, how its hook matchers and
 * permission rules match a call, how a Harness tool call looks to a Claude Code
 * hook, and how a hook's exit code and output turn into a decision.
 *
 * Everything here is pure or reads files synchronously; no Harness API.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Settings files Claude Code reads, broad to specific. `scope` keys the `scopes` config. */
export function settingsFiles(root, home = homedir()) {
  const files = [{ scope: 'user', path: join(home, '.claude', 'settings.json'), base: home }]
  if (root) {
    files.push(
      { scope: 'project', path: join(root, '.claude', 'settings.json'), base: root },
      { scope: 'local', path: join(root, '.claude', 'settings.local.json'), base: root },
    )
  }
  return files
}

const jsonCache = new Map()

/** Parsed JSON of a file, cached until its mtime or size changes. `null` when absent; `{ error }` when unreadable. */
export function readJsonCached(path) {
  let stat
  try { stat = statSync(path) } catch { jsonCache.delete(path); return null }
  const hit = jsonCache.get(path)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.data
  let data
  try { data = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { data = { error: String(error?.message ?? error) } }
  jsonCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, data })
  return data
}

const rootCache = new Map()

/** Nearest ancestor of `cwd` holding `.git` (the same rule the Harness uses), else `cwd`. */
export function projectRoot(cwd) {
  if (!cwd) return undefined
  const start = resolve(cwd)
  const cached = rootCache.get(start)
  if (cached) return cached
  let dir = start
  for (;;) {
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) { dir = start; break }
    dir = parent
  }
  rootCache.set(start, dir)
  return dir
}

/**
 * Every hook and permission rule the given scopes declare.
 * Hooks are `{ scope, file, event, matcher, type, command, timeout }`; rules are
 * `{ scope, file, base, behavior, rule, tool, spec }`.
 */
export function loadClaudeSettings(root, { scopes = ['project', 'local'], home = homedir() } = {}) {
  const hooks = []
  const rules = []
  const files = []
  let disableAllHooks = false
  for (const file of settingsFiles(root, home)) {
    const data = readJsonCached(file.path)
    if (data === null) continue
    const enabled = scopes.includes(file.scope)
    files.push({ ...file, enabled, error: data.error })
    if (data.error || !enabled) continue
    if (data.disableAllHooks === true) disableAllHooks = true
    for (const [event, groups] of Object.entries(data.hooks ?? {})) {
      if (!Array.isArray(groups)) continue
      for (const group of groups) {
        for (const hook of group?.hooks ?? []) {
          hooks.push({
            scope: file.scope,
            file: file.path,
            event,
            matcher: group.matcher,
            type: hook.type ?? 'command',
            command: hook.command,
            timeout: typeof hook.timeout === 'number' ? hook.timeout : undefined,
          })
        }
      }
    }
    for (const behavior of ['deny', 'ask', 'allow']) {
      for (const rule of data.permissions?.[behavior] ?? []) {
        if (typeof rule !== 'string') continue
        rules.push({ scope: file.scope, file: file.path, base: file.base, behavior, rule, ...parseRule(rule) })
      }
    }
  }
  return { files, hooks: disableAllHooks ? [] : hooks, rules, disableAllHooks }
}

// ---------------------------------------------------------------- tool calls

const absolute = (path, cwd) => (typeof path === 'string' && path.length > 0 && cwd && !isAbsolute(path) ? resolve(cwd, path) : path)

/**
 * Harness tool → Claude Code tool. `keys` maps Claude input keys to Harness
 * argument keys, used both to build the hook input and to read `updatedInput` back.
 */
const TOOLS = {
  bash: { name: 'Bash', keys: { command: 'command', description: 'description', timeout: 'timeoutMs', run_in_background: 'run_in_background' } },
  read: { name: 'Read', keys: { file_path: 'file_path', offset: 'offset', limit: 'limit' }, paths: ['file_path'] },
  read_image: { name: 'Read', keys: { file_path: 'file_path' }, paths: ['file_path'] },
  write: { name: 'Write', keys: { file_path: 'file_path', content: 'content' }, paths: ['file_path'] },
  edit: { name: 'Edit', keys: { file_path: 'file_path', old_string: 'old_string', new_string: 'new_string', replace_all: 'replace_all' }, paths: ['file_path'] },
  glob: { name: 'Glob', keys: { pattern: 'pattern', path: 'path' }, paths: ['path'] },
  grep: { name: 'Grep', keys: { pattern: 'pattern', path: 'path', glob: 'include' }, paths: ['path'] },
  web_fetch: { name: 'WebFetch', keys: { url: 'url' } },
  subagent: { name: 'Task', aliases: ['Agent'], keys: { description: 'description', prompt: 'prompt' }, extra: { subagent_type: 'general-purpose' } },
  subagent_fork: { name: 'Task', aliases: ['Agent'], keys: { description: 'description', prompt: 'prompt' }, extra: { subagent_type: 'general-purpose' } },
  todo_write: { name: 'TodoWrite', keys: { todos: 'todos' } },
  ask_user_question: { name: 'AskUserQuestion', keys: { questions: 'questions' } },
  skill: { name: 'Skill', keys: { skill: 'name' } },
}

/** Tools a Claude Code permission rule for `tool` also covers. */
const RULE_FAMILY = {
  Edit: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  Write: ['Write'],
  Read: ['Read', 'Glob', 'Grep'],
  Task: ['Task', 'Agent'],
  Agent: ['Task', 'Agent'],
}

/**
 * How a Harness call looks to Claude Code: `{ name, names, input, dshName }`.
 * `names` are every name a matcher may use for it (Claude name, aliases, Harness name).
 */
export function toClaudeCall(dshName, args, cwd) {
  const spec = TOOLS[dshName]
  const source = args && typeof args === 'object' ? args : {}
  if (!spec) {
    return { dshName, name: dshName, names: [dshName], input: { ...source }, mapped: false }
  }
  const input = { ...(spec.extra ?? {}) }
  for (const [claudeKey, dshKey] of Object.entries(spec.keys)) {
    const value = source[dshKey]
    if (value === undefined) continue
    input[claudeKey] = spec.paths?.includes(claudeKey) ? absolute(value, cwd) : value
  }
  return { dshName, name: spec.name, names: [spec.name, ...(spec.aliases ?? []), dshName], input, mapped: true }
}

/**
 * Harness arguments a hook asked for through `updatedInput`, or `undefined`
 * when it changed nothing the Harness tool accepts. Only keys whose value
 * differs from what the hook was shown are applied.
 */
export function fromUpdatedInput(dshName, originalArgs, shownInput, updatedInput) {
  if (!updatedInput || typeof updatedInput !== 'object') return undefined
  const spec = TOOLS[dshName]
  const keys = spec ? spec.keys : Object.fromEntries(Object.keys(updatedInput).map(k => [k, k]))
  const next = { ...(originalArgs ?? {}) }
  let changed = false
  for (const [claudeKey, dshKey] of Object.entries(keys)) {
    if (!(claudeKey in updatedInput)) continue
    if (JSON.stringify(updatedInput[claudeKey]) === JSON.stringify(shownInput?.[claudeKey])) continue
    next[dshKey] = updatedInput[claudeKey]
    changed = true
  }
  return changed ? next : undefined
}

/** What a Claude Code hook expects in `tool_response` for a finished call. */
export function toolResponse(dshName, result) {
  const text = (result?.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n')
  const value = result?.value
  if (dshName === 'bash') {
    const out = typeof value === 'string' ? value : text
    return { stdout: out, stderr: '', interrupted: false, isImage: false }
  }
  if (value !== undefined && value !== null && typeof value === 'object') return value
  if (typeof value === 'string') return value
  return text
}

// ---------------------------------------------------------------- matching

/**
 * Claude Code matcher semantics: empty or `*` matches everything; a plain
 * `A|B` list matches names exactly; anything else is a regular expression.
 */
export function matcherMatches(matcher, names) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true
  if (/^[A-Za-z0-9_|-]+$/.test(matcher)) {
    const set = matcher.split('|').filter(Boolean)
    return names.some(name => set.includes(name))
  }
  try {
    const re = new RegExp(matcher)
    return names.some(name => re.test(name))
  } catch {
    return false
  }
}

/** `Bash(npm run test:*)` → `{ tool: 'Bash', spec: 'npm run test:*' }`; `Read` → `{ tool: 'Read' }`. */
export function parseRule(rule) {
  const m = /^\s*([^()\s]+)\s*(?:\((.*)\))?\s*$/s.exec(rule)
  if (!m) return { tool: rule.trim() }
  return m[2] === undefined ? { tool: m[1] } : { tool: m[1], spec: m[2] }
}

const escapeRe = text => text.replace(/[.+^${}()|[\]\\]/g, '\\$&')

/** gitignore-style glob → RegExp over an absolute POSIX path. */
export function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/'
        out += slash ? '(?:.*/)?' : '.*'
        i += slash ? 2 : 1
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += escapeRe(c)
    }
  }
  return new RegExp(`^${out}$`)
}

/** Absolute glob for a path rule spec, following Claude Code's prefixes. */
function pathPattern(spec, { cwd, base, home }) {
  if (spec.startsWith('//')) return spec.slice(1)
  if (spec.startsWith('~/')) return join(home, spec.slice(2))
  if (spec.startsWith('/')) return join(base ?? cwd, spec.slice(1))
  if (spec.startsWith('./')) return join(cwd, spec.slice(2))
  if (!spec.includes('/')) return join(cwd, '**', spec)
  return join(cwd, spec)
}

function pathMatches(spec, path, context) {
  if (typeof path !== 'string' || path.length === 0) return false
  const pattern = pathPattern(spec, context).split(sep).join('/')
  const re = globToRegExp(pattern.endsWith('/') ? `${pattern}**` : pattern)
  let target = resolve(context.cwd, path).split(sep).join('/')
  for (;;) {
    if (re.test(target)) return true
    const parent = target.slice(0, target.lastIndexOf('/'))
    if (parent.length === 0 || parent === target) return false
    target = parent
  }
}

/** Split a shell command on `&&`, `||`, `;`, `|` and newlines (quotes are not parsed). */
export function subcommands(command) {
  return String(command ?? '').split(/&&|\|\||[;|\n]/).map(part => part.trim()).filter(Boolean)
}

function bashMatches(spec, command) {
  const parts = [String(command ?? '').trim(), ...subcommands(command)]
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2).trim()
    return parts.some(part => part === prefix || part.startsWith(`${prefix} `))
  }
  if (spec.includes('*')) {
    const re = new RegExp(`^${spec.split('*').map(escapeRe).join('.*')}$`, 's')
    return parts.some(part => re.test(part))
  }
  return parts.some(part => part === spec.trim())
}

/**
 * Whether a parsed permission rule covers a call.
 * @returns `true`, `false`, or `'unsupported'` when the rule's specifier is not understood.
 */
export function ruleMatches(rule, call, context) {
  const tool = rule.tool
  if (tool.startsWith('mcp__')) {
    if (!call.name.startsWith('mcp__')) return false
    return call.name === tool || call.name.startsWith(`${tool}__`) || (tool.endsWith('__*') && call.name.startsWith(tool.slice(0, -1)))
  }
  const family = RULE_FAMILY[tool] ?? [tool]
  if (!call.names.some(name => family.includes(name))) return false
  const spec = rule.spec
  if (spec === undefined || spec === '' || spec === '*') return true
  if (call.name === 'Bash') return bashMatches(spec, call.input.command)
  if (['Read', 'Write', 'Edit', 'Glob', 'Grep', 'MultiEdit', 'NotebookEdit'].includes(call.name)) {
    const path = call.input.file_path ?? call.input.path ?? (call.name === 'Glob' || call.name === 'Grep' ? context.cwd : undefined)
    return pathMatches(spec, path, context)
  }
  if (call.name === 'WebFetch' && spec.startsWith('domain:')) {
    try {
      const host = new URL(call.input.url).hostname
      const domain = spec.slice('domain:'.length)
      return host === domain || host.endsWith(`.${domain}`)
    } catch {
      return false
    }
  }
  return 'unsupported'
}

/** The first `deny`, else the first `ask`, rule that covers a call. */
export function permissionVerdict(rules, call, { cwd, home = homedir() } = {}) {
  for (const behavior of ['deny', 'ask']) {
    for (const rule of rules) {
      if (rule.behavior !== behavior) continue
      if (ruleMatches(rule, call, { cwd, base: rule.base, home }) === true) return { behavior, rule }
    }
  }
  return undefined
}

// ---------------------------------------------------------------- hook output

/**
 * Turn one finished hook process into a decision, following Claude Code's
 * exit-code and JSON-output contract.
 * @returns `{ decision?, reason?, contexts, systemMessage?, stop?, updatedInput?, note? }`
 *   where `decision` is `allow` | `deny` | `ask` | `block`.
 */
export function interpretHook(event, run) {
  const out = { contexts: [] }
  if (run.error) { out.note = `failed to start: ${run.error}`; return out }
  if (run.timedOut) { out.note = 'timed out'; return out }
  const stdout = (run.stdout ?? '').trim()
  const stderr = (run.stderr ?? '').trim()
  if (run.code === 2) {
    out.decision = event === 'PreToolUse' ? 'deny' : 'block'
    out.reason = stderr || `blocked by a ${event} hook`
    return out
  }
  if (run.code !== 0) {
    out.note = `exit ${run.code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`
    return out
  }
  let json
  if (stdout.startsWith('{')) {
    try { json = JSON.parse(stdout) } catch { json = undefined }
  }
  if (!json) {
    if (stdout && (event === 'UserPromptSubmit' || event === 'SessionStart')) out.contexts.push(stdout)
    return out
  }
  if (json.continue === false) out.stop = { reason: json.stopReason || `stopped by a ${event} hook` }
  if (typeof json.systemMessage === 'string' && json.systemMessage.trim()) out.systemMessage = json.systemMessage.trim()
  const specific = json.hookSpecificOutput ?? {}
  if (typeof specific.additionalContext === 'string' && specific.additionalContext.trim()) out.contexts.push(specific.additionalContext.trim())
  if (event === 'PreToolUse') {
    const permission = specific.permissionDecision
      ?? (json.decision === 'approve' ? 'allow' : json.decision === 'block' ? 'deny' : undefined)
    if (permission === 'allow' || permission === 'deny' || permission === 'ask') {
      out.decision = permission
      out.reason = specific.permissionDecisionReason || json.reason || undefined
    }
    if (specific.updatedInput && typeof specific.updatedInput === 'object') out.updatedInput = specific.updatedInput
  } else if (json.decision === 'block') {
    out.decision = 'block'
    out.reason = json.reason || `blocked by a ${event} hook`
  }
  return out
}

const RANK = { deny: 3, block: 3, ask: 2, allow: 1 }

/** Combine the outcomes of every hook that ran for one event. */
export function mergeOutcomes(outcomes) {
  const merged = { contexts: [], systemMessages: [], reasons: [], notes: [] }
  for (const outcome of outcomes) {
    merged.contexts.push(...outcome.contexts)
    if (outcome.systemMessage) merged.systemMessages.push(outcome.systemMessage)
    if (outcome.note) merged.notes.push(outcome.note)
    if (outcome.stop && !merged.stop) merged.stop = outcome.stop
    if (outcome.updatedInput && !merged.updatedInput) merged.updatedInput = outcome.updatedInput
    if (outcome.decision) {
      const rank = RANK[outcome.decision]
      if (!merged.decision || rank > RANK[merged.decision]) {
        merged.decision = outcome.decision
        merged.reasons = []
      }
      if (rank === RANK[merged.decision] && outcome.reason) merged.reasons.push(outcome.reason)
    }
  }
  merged.reason = merged.reasons.join('\n') || undefined
  return merged
}

/** A path for display: relative to `root` when inside it, `~/…` under home. */
export function displayPath(path, root, home = homedir()) {
  if (root) {
    const rel = relative(root, path)
    if (!rel.startsWith('..') && !isAbsolute(rel)) return rel || '.'
  }
  if (path.startsWith(home + sep)) return `~/${path.slice(home.length + 1)}`
  return path
}
