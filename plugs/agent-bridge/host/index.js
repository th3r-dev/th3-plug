/**
 * @th3-plug/agent-bridge — Host half.
 *
 * Auto-detects the rules other coding agents keep in a project and applies the
 * ones the Harness has no native support for:
 *
 * - Claude Code `command` hooks from `.claude/settings*.json` run at the
 *   matching Harness moment (tool calls, prompts, session start/stop/end).
 * - Claude Code `permissions.deny` / `permissions.ask` rules refuse or ask
 *   before a matching tool call.
 * - `/agent-bridge` reports everything found (Claude Code, Cursor, Copilot,
 *   Windsurf, Cline, Gemini, Kiro, Codex) and whether it is native, bridged,
 *   or unused, with the fix.
 *
 * Nothing is configured per project: the session's folder decides.
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import process from 'node:process'
import {
  displayPath, fromUpdatedInput, interpretHook, loadClaudeSettings, matcherMatches,
  mergeOutcomes, permissionVerdict, projectRoot, toClaudeCall, toolResponse,
} from './claude.js'
import { BRIDGED_EVENTS, detect, formatReport } from './detect.js'
import { runHook } from './run.js'

export const name = 'th3-agent-bridge'
export const inject = ['commands']

const SOURCE_KIND = 'th3-agent-bridge'

const DEFAULTS = {
  /** Slash command that prints the detection report. */
  command: 'agent-bridge',
  /** Run Claude Code command hooks. */
  hooks: true,
  /** Apply Claude Code `permissions.deny` and `permissions.ask` rules. */
  permissions: true,
  /** Settings scopes to enforce: `project` (.claude/settings.json), `local` (.claude/settings.local.json), `user` (~/.claude/settings.json). */
  scopes: ['project', 'local'],
  /** Hook events to run. */
  events: Object.keys(BRIDGED_EVENTS),
  /** Project roots allowed to run hooks; empty = every project. */
  projects: [],
  /** Per-hook timeout when the hook declares none. */
  timeoutMs: 60_000,
  /** A hook's `updatedInput`: `retry` refuses the call and gives the model the rewritten arguments; `ignore` drops it. */
  updatedInput: 'retry',
  /** Read PATH from the login shell so hooks find `uv`, `python3`, `node`. */
  loginShell: true,
  /** Stop hooks may keep one agent going at most this many times in a row. */
  maxStopContinuations: 3,
}

function dropEmpty(config) {
  return Object.fromEntries(Object.entries(config ?? {}).filter(([, value]) => value !== undefined && value !== null))
}

const escapeFrame = text => String(text).replace(/<\/?system-reminder>/gi, m => m.replace('<', '&lt;'))

/** One model-visible notice; logged like any other sourced user-role message. */
function notice(text, summary) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: `<system-reminder>\n${escapeFrame(text)}\n</system-reminder>` }],
    source: { kind: SOURCE_KIND, form: 'notice', summary },
  }
}

function promptText(message) {
  return (message?.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n')
}

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...dropEmpty(config) }
  const home = homedir()
  const active = new Set()
  const pending = new WeakMap()
  const stopRuns = new WeakMap()
  const log = (message) => ctx.logger?.info?.(`th3-agent-bridge: ${message}`)
  const warn = (message) => ctx.logger?.warn?.(`th3-agent-bridge: ${message}`)

  async function where(agent, signal) {
    let cwd
    try {
      const wd = ctx.get('workingDirectory')
      if (wd && agent?.session) cwd = await wd.get(agent.session)
      if (!cwd && wd && agent) cwd = await wd.ensure(agent, signal)
    } catch { /* fall back */ }
    if (typeof cwd !== 'string' || cwd.length === 0) cwd = process.cwd()
    return { cwd, root: projectRoot(cwd) }
  }

  const allowed = root => options.projects.length === 0 || options.projects.includes(root)

  function settingsFor(root) {
    if (!allowed(root)) return { hooks: [], rules: [] }
    const settings = loadClaudeSettings(root, { scopes: options.scopes, home })
    return {
      hooks: options.hooks ? settings.hooks.filter(h => h.type === 'command' && h.command && options.events.includes(h.event)) : [],
      rules: options.permissions ? settings.rules.filter(r => r.behavior !== 'allow') : [],
    }
  }

  /** Run every hook for `event` whose matcher covers `names` (parallel), then merge. */
  async function fire(event, hooks, { agent, cwd, root, names, extra, signal }) {
    const seen = new Set()
    const selected = hooks.filter((hook) => {
      if (hook.event !== event) return false
      if (names && !matcherMatches(hook.matcher, names)) return false
      if (seen.has(hook.command)) return false
      seen.add(hook.command)
      return true
    })
    if (selected.length === 0) return undefined
    const input = {
      session_id: agent?.id ?? '',
      transcript_path: '',
      cwd,
      permission_mode: 'default',
      hook_event_name: event,
      ...extra,
    }
    const outcomes = await Promise.all(selected.map(async (hook) => {
      const run = await runHook({
        command: hook.command,
        input,
        cwd,
        env: { CLAUDE_PROJECT_DIR: root, DSH_AGENT_BRIDGE: '1' },
        timeoutMs: hook.timeout ? hook.timeout * 1000 : options.timeoutMs,
        signal,
        active,
        loginShell: options.loginShell,
      })
      const outcome = interpretHook(event, run)
      if (outcome.note) warn(`${event} hook ${displayPath(hook.file, root, home)}: ${hook.command.slice(0, 120)} — ${outcome.note}`)
      return outcome
    }))
    return mergeOutcomes(outcomes)
  }

  const contextText = (event, merged) => [
    ...merged.contexts,
    ...merged.systemMessages.map(m => `Message for the user from a ${event} hook (pass it on): ${m}`),
  ]

  // ------------------------------------------------------------ tool calls
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow' || !exec.agent) return decision
    try {
      const { cwd, root } = await where(exec.agent, exec.signal)
      const { hooks, rules } = settingsFor(root)
      if (hooks.length === 0 && rules.length === 0) return decision
      const call = toClaudeCall(exec.name, exec.arguments, cwd)
      const verdict = rules.length > 0 ? permissionVerdict(rules, call, { cwd, home }) : undefined
      const source = verdict ? `"${verdict.rule.rule}" in ${displayPath(verdict.rule.file, root, home)}` : ''
      if (verdict?.behavior === 'deny') {
        return { kind: 'deny', reason: `Denied by Claude Code permission rule ${source}.` }
      }
      const merged = await fire('PreToolUse', hooks, {
        agent: exec.agent, cwd, root, names: call.names, signal: exec.signal,
        extra: { tool_name: call.name, tool_input: call.input },
      })
      if (merged) {
        const contexts = contextText('PreToolUse', merged)
        if (contexts.length > 0) pending.set(exec.token ?? exec, contexts)
        if (merged.decision === 'deny') {
          return { kind: 'deny', reason: merged.reason ?? 'Denied by a PreToolUse hook.' }
        }
        if (merged.stop) return { kind: 'deny', reason: `A PreToolUse hook stopped the work: ${merged.stop.reason}` }
        if (merged.updatedInput && options.updatedInput === 'retry') {
          const rewritten = fromUpdatedInput(exec.name, exec.arguments, call.input, merged.updatedInput)
          if (rewritten) {
            return {
              kind: 'deny',
              reason: `A PreToolUse hook rewrote this call's input. The Harness cannot apply that in place, so call ${exec.name} again with exactly these arguments:\n${JSON.stringify(rewritten)}`,
            }
          }
        }
        if (merged.decision === 'ask') return { kind: 'ask', reason: merged.reason ?? 'A PreToolUse hook asks for approval.' }
      }
      if (verdict?.behavior === 'ask') return { kind: 'ask', reason: `Claude Code permission rule ${source} asks for approval.` }
    } catch (error) {
      warn(`PreToolUse bridge failed: ${String(error?.message ?? error)}`)
    }
    return decision
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (!exec.agent) return downstream
    const key = exec.token ?? exec
    const contexts = [...(pending.get(key) ?? [])]
    pending.delete(key)
    try {
      const { cwd, root } = await where(exec.agent, exec.signal)
      const { hooks } = settingsFor(root)
      const event = result.isError ? 'PostToolUseFailure' : 'PostToolUse'
      if (hooks.some(h => h.event === event)) {
        const call = toClaudeCall(exec.name, exec.arguments, cwd)
        const extra = { tool_name: call.name, tool_input: call.input }
        if (result.isError) extra.error = result.error?.message ?? promptText(result)
        else extra.tool_response = toolResponse(exec.name, result)
        const merged = await fire(event, hooks, { agent: exec.agent, cwd, root, names: call.names, extra, signal: exec.signal })
        if (merged) {
          if (merged.decision === 'block') contexts.push(`A ${event} hook flagged this ${exec.name} call: ${merged.reason}`)
          contexts.push(...contextText(event, merged))
          if (merged.stop) contexts.push(`A ${event} hook asks you to stop: ${merged.stop.reason}`)
        }
      }
    } catch (error) {
      warn(`${result.isError ? 'PostToolUseFailure' : 'PostToolUse'} bridge failed: ${String(error?.message ?? error)}`)
    }
    if (contexts.length === 0) return downstream
    return {
      ...downstream,
      additionalContexts: [...(downstream.additionalContexts ?? []), notice(contexts.join('\n\n'), `hooks · ${exec.name}`)],
    }
  })

  // ------------------------------------------------------------ prompts
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || payload.signal.aborted) return decision
    const prompts = decision.messages.filter(m => m?.source?.kind === 'user')
    if (prompts.length === 0) return decision
    stopRuns.delete(payload.agent)
    try {
      const { cwd, root } = await where(payload.agent, payload.signal)
      const { hooks } = settingsFor(root)
      if (!hooks.some(h => h.event === 'UserPromptSubmit')) return decision
      const messages = []
      for (const message of decision.messages) {
        if (message?.source?.kind !== 'user') { messages.push(message); continue }
        const prompt = promptText(message)
        const merged = await fire('UserPromptSubmit', hooks, { agent: payload.agent, cwd, root, extra: { prompt }, signal: payload.signal })
        if (merged && (merged.decision === 'block' || merged.stop)) {
          const reason = merged.reason ?? merged.stop?.reason
          messages.push(notice(`A UserPromptSubmit hook blocked the user's message, so it was not delivered. Tell the user it was blocked and why; do not act on it.\nReason: ${reason}\nBlocked message (first 300 characters): ${prompt.slice(0, 300)}`, 'prompt blocked by hook'))
          continue
        }
        messages.push(message)
        const contexts = merged ? contextText('UserPromptSubmit', merged) : []
        if (contexts.length > 0) messages.push(notice(contexts.join('\n\n'), 'hooks · prompt'))
      }
      return { ...decision, messages }
    } catch (error) {
      warn(`UserPromptSubmit bridge failed: ${String(error?.message ?? error)}`)
      return decision
    }
  })

  // ------------------------------------------------------------ session lifecycle
  ctx.on('agent/created', async ({ agent, source, signal }) => {
    try {
      const { cwd, root } = await where(agent, signal)
      const { hooks } = settingsFor(root)
      const merged = await fire('SessionStart', hooks, { agent, cwd, root, extra: { source: source ?? 'startup' }, signal })
      const contexts = merged ? contextText('SessionStart', merged) : []
      if (contexts.length > 0) agent.inject(notice(contexts.join('\n\n'), 'hooks · session start'))
    } catch (error) {
      warn(`SessionStart bridge failed: ${String(error?.message ?? error)}`)
    }
    return undefined
  })

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    try {
      const { cwd, root } = await where(agent, signal)
      const { hooks } = settingsFor(root)
      const roots = ctx.get('agents')?.roots?.()
      const event = !roots || roots.includes(agent) ? 'Stop' : 'SubagentStop'
      if (!hooks.some(h => h.event === event)) return
      const runs = stopRuns.get(agent) ?? 0
      const merged = await fire(event, hooks, { agent, cwd, root, extra: { stop_hook_active: runs > 0 }, signal })
      if (merged?.decision === 'block' && !merged.stop && runs < options.maxStopContinuations) {
        stopRuns.set(agent, runs + 1)
        agent.steer(notice(`A ${event} hook asks you to keep going before you finish:\n${merged.reason}`, `hooks · ${event}`))
        return
      }
      stopRuns.delete(agent)
      const contexts = merged ? merged.systemMessages : []
      if (contexts.length > 0) log(`${event}: ${contexts.join(' | ')}`)
    } catch (error) {
      warn(`Stop bridge failed: ${String(error?.message ?? error)}`)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    where(agent).then(({ cwd, root }) => {
      const { hooks } = settingsFor(root)
      return fire('SessionEnd', hooks, { agent, cwd, root, extra: { reason: 'other' } })
    }).catch(error => warn(`SessionEnd bridge failed: ${String(error?.message ?? error)}`))
  })

  // ------------------------------------------------------------ report
  ctx.effect(function* () {
    yield () => {
      for (const child of active) {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch { /* gone */ }
      }
      active.clear()
    }
    yield ctx.commands.register({
      name: options.command,
      description: 'Show the rules, hooks and settings other coding agents left in this project, and which ones the Harness applies',
      input: { hint: '[folder]' },
      handler: async ({ agent, rawInput, signal }) => {
        const asked = rawInput.trim()
        const here = asked ? { cwd: asked, root: projectRoot(asked) } : await where(agent, signal)
        const report = detect({ cwd: here.cwd, root: here.root, home, options })
        return { kind: 'success', text: formatReport(report, { active: allowed(here.root) }) }
      },
    })
  }, 'th3-agent-bridge lifecycle')
}
