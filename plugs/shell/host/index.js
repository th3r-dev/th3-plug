/**
 * `/sh <command>` — run a shell command on this machine directly from the
 * composer. The command never reaches the model: it is a human command, so the
 * line and its output stay in the UI command plane and cost no tokens.
 */
import { spawn } from 'node:child_process'
import process from 'node:process'
import { shellComplete, shellHistory, warmCompletion } from './complete.js'

/** Authenticated `/api` route the Web composer queries for `!` suggestions. */
const COMPLETE_PATH = '/api/th3-shell/complete'

export const name = 'th3-shell'
export const inject = ['commands']

const DEFAULTS = {
  /** Slash-command name, typed as `/<name> <command>`. */
  name: 'sh',
  /** Kill the command after this many milliseconds (0 = never). */
  timeoutMs: 120_000,
  /** Keep at most this many characters of output (the tail is kept). */
  maxOutputChars: 20_000,
  /** Shell executable; defaults to $SHELL (or cmd.exe on Windows). */
  shell: undefined,
  /** Run as a login shell (`-lc`) so PATH from your shell profile applies. */
  loginShell: true,
  /** Also run a prompt that starts with `!` as a shell command. */
  bang: true,
  /** Offer zsh completions and history while typing a `!` line. */
  autocomplete: true,
  /** Give up on one completion request after this many milliseconds. */
  completeTimeoutMs: 5000,
}

async function sessionCwd(ctx, sessionId) {
  try {
    const agent = sessionId ? ctx.get('agents')?.get(sessionId) : undefined
    const wd = ctx.get('workingDirectory')
    if (agent && wd) return wd.get(agent.session)
  } catch { /* fall through */ }
  return process.cwd()
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g

function shellInvocation(command, options) {
  if (process.platform === 'win32') {
    const file = options.shell || process.env.ComSpec || 'cmd.exe'
    return { file, args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true }
  }
  const file = options.shell || process.env.SHELL || '/bin/sh'
  return { file, args: [options.loginShell ? '-lc' : '-c', command] }
}

function runShell(command, cwd, options, signal, active) {
  return new Promise((resolve) => {
    const started = Date.now()
    const { file, args, windowsVerbatimArguments } = shellInvocation(command, options)
    const detached = process.platform !== 'win32'
    let output = ''
    let dropped = 0
    let settled = false
    let reason

    const append = (chunk) => {
      output += chunk.toString('utf8')
      const max = options.maxOutputChars
      if (max > 0 && output.length > max * 2) {
        dropped += output.length - max
        output = output.slice(-max)
      }
    }

    let child
    try {
      child = spawn(file, args, {
        cwd,
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached,
        windowsHide: true,
        windowsVerbatimArguments,
      })
    } catch (error) {
      resolve({ error: String(error?.message ?? error) })
      return
    }
    active.add(child)

    const kill = (why) => {
      if (settled || child.exitCode !== null) return
      reason = why
      try {
        if (detached && child.pid) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return
        try {
          if (detached && child.pid) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch { /* already gone */ }
      }, 3000).unref?.()
    }

    const timer = options.timeoutMs > 0
      ? setTimeout(() => kill(`timed out after ${options.timeoutMs / 1000}s`), options.timeoutMs)
      : undefined
    const onAbort = () => kill('cancelled')
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      active.delete(child)
      resolve({ error: String(error?.message ?? error) })
    })
    child.on('close', (code, sig) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      active.delete(child)
      let text = output.replace(ANSI, '').replace(/\r\n?/g, '\n')
      const max = options.maxOutputChars
      if (max > 0 && text.length > max) {
        dropped += text.length - max
        text = text.slice(-max)
      }
      resolve({ code, signal: sig, reason, text, dropped, ms: Date.now() - started })
    })
  })
}

/** The command of a human prompt written as `!<command>`, else undefined. */
function bangCommand(message) {
  if (message?.source?.kind !== 'user') return undefined
  const content = message.content
  if (!Array.isArray(content) || content.length === 0) return undefined
  if (!content.every(block => block?.type === 'text')) return undefined
  const text = content.map(block => block.text).join('').trim()
  if (!text.startsWith('!')) return undefined
  const command = text.slice(1).trim()
  return command.length > 0 ? command : undefined
}

function fence(text) {
  let ticks = '```'
  while (text.includes(ticks)) ticks += '`'
  return `${ticks}\n${text}\n${ticks}`
}

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...Object.fromEntries(Object.entries(config ?? {}).filter(([, v]) => v !== undefined && v !== null)) }
  const active = new Set()

  const handler = async ({ agent, rawInput, signal }) => {
    const command = rawInput.trim()
    if (command.length === 0) {
      return { kind: 'error', text: `Usage: /${options.name} <command>   e.g. /${options.name} git status` }
    }

    let cwd = process.cwd()
    try {
      const wd = ctx.get('workingDirectory')
      if (wd) cwd = await wd.ensure(agent, signal)
    } catch { /* fall back to the Host directory */ }

    const result = await runShell(command, cwd, options, signal, active)
    if (result.error) {
      return { kind: 'error', text: `$ ${command}\nFailed to start: ${result.error}` }
    }

    const status = result.reason
      ? result.reason
      : result.signal
        ? `killed by ${result.signal}`
        : `exit ${result.code}`
    const lines = [`$ ${command}`, `cwd: ${cwd}`]
    const body = result.text.replace(/\n+$/, '')
    if (result.dropped > 0) lines.push(`… ${result.dropped} earlier characters omitted`)
    lines.push(body.length > 0 ? fence(body) : '(no output)')
    lines.push(`${status} · ${(result.ms / 1000).toFixed(2)}s`)
    const text = lines.join('\n')

    if (result.reason) return { kind: 'error', text }
    return { kind: 'success', text }
  }

  // Suggestions for the Web composer while a `!` line is being typed. The route
  // lives under `/api`, so the same browser authentication guards it.
  if (options.autocomplete !== false) {
    warmCompletion()
    ctx.inject(['connection'], (scope) => {
      scope.connection.fetch.register({
        path: COMPLETE_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const url = new URL(request.url)
          const kind = url.searchParams.get('kind') ?? 'complete'
          const line = url.searchParams.get('line') ?? ''
          if (line.length > 4000) return json({ error: 'line too long' }, 400)
          if (kind === 'history') return json({ items: shellHistory(line) })
          if (kind !== 'complete') return json({ error: 'unknown kind' }, 400)
          const cwd = await sessionCwd(ctx, url.searchParams.get('session'))
          const items = await shellComplete(line, cwd, { signal: request.signal, timeoutMs: options.completeTimeoutMs })
          return json({ items })
        },
      })
    })
  }

  // `!<command>` typed in the composer: take the prompt out of the step before
  // the model sees it and run it through the same `/sh` command, so the line
  // and its output are recorded as a command row instead of a user message.
  if (options.bang !== false) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision.kind !== 'enter' || payload.signal.aborted) return decision
      const bang = []
      const rest = []
      for (const message of decision.messages) {
        const command = bangCommand(message)
        if (command === undefined) rest.push(message)
        else bang.push(command)
      }
      if (bang.length === 0) return decision
      for (const command of bang) {
        if (payload.signal.aborted) break
        try {
          await ctx.commands.execute(payload.agent, `/${options.name} ${command}`, [], payload.signal)
        } catch (error) {
          ctx.logger?.warn?.(`th3-shell: "!${command}" failed: ${String(error)}`)
        }
      }
      // A turn opened only by `!` lines ends without a model request: drop the
      // runtime-context snapshot too, so the step has nothing to send.
      const onlyContext = rest.every(message => message.source?.kind === 'runtime-context')
      const messages = payload.step === 1 && onlyContext ? [] : rest
      return { ...decision, messages }
    })
  }

  ctx.effect(function* () {
    yield () => {
      for (const child of active) {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM')
          else child.kill('SIGTERM')
        } catch { /* already gone */ }
      }
      active.clear()
    }
    yield ctx.commands.register({
      name: options.name,
      description: 'Run a shell command on this machine instantly, without the AI agent',
      input: { hint: '<command>' },
      handler,
    })
  }, 'th3-shell lifecycle')
}
