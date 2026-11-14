/**
 * Run one Claude Code `command` hook: JSON on stdin, stdout/stderr/exit back.
 */
import { spawn } from 'node:child_process'
import process from 'node:process'

const MAX_OUTPUT = 1_000_000
const COMMON_BIN = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

let loginPath

/**
 * PATH from the user's login shell, read once. A GUI-launched Harness has a
 * thin PATH, and hooks usually call tools such as `uv`, `python3` or `node`.
 */
export function userPath({ loginShell = true } = {}) {
  if (loginPath) return loginPath
  const fallback = () => {
    const parts = (process.env.PATH ?? '').split(':').filter(Boolean)
    for (const dir of COMMON_BIN) if (!parts.includes(dir)) parts.push(dir)
    return parts.join(':')
  }
  if (!loginShell || process.platform === 'win32') {
    loginPath = Promise.resolve(process.env.PATH ?? '')
    return loginPath
  }
  loginPath = new Promise((resolvePath) => {
    const shell = process.env.SHELL || '/bin/zsh'
    let out = ''
    let child
    try {
      child = spawn(shell, ['-lc', 'printf "__PATH__%s__END__" "$PATH"'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolvePath(fallback())
      return
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolvePath(fallback()) }, 5000)
    child.stdout.on('data', chunk => { out += chunk })
    child.on('error', () => { clearTimeout(timer); resolvePath(fallback()) })
    child.on('close', () => {
      clearTimeout(timer)
      const m = /__PATH__(.*)__END__/s.exec(out)
      resolvePath(m && m[1] ? m[1] : fallback())
    })
  })
  return loginPath
}

/**
 * @param {object} options
 * @param {string} options.command  shell command from the settings file
 * @param {object} options.input     hook input, written to stdin as JSON
 * @param {string} options.cwd
 * @param {Record<string,string>} options.env  extra environment
 * @param {number} options.timeoutMs
 * @param {AbortSignal} [options.signal]
 * @param {Set} [options.active]     running children, killed on unload
 * @returns {Promise<{ code?: number, stdout: string, stderr: string, timedOut?: boolean, error?: string, ms: number }>}
 */
export async function runHook({ command, input, cwd, env = {}, timeoutMs = 60_000, signal, active, loginShell = true }) {
  const PATH = await userPath({ loginShell })
  return new Promise((resolveRun) => {
    const started = Date.now()
    const detached = process.platform !== 'win32'
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let child
    try {
      child = process.platform === 'win32'
        ? spawn(command, { cwd, env: { ...process.env, ...env }, shell: true, windowsHide: true })
        : spawn('/bin/sh', ['-c', command], { cwd, env: { ...process.env, PATH, ...env }, detached })
    } catch (error) {
      resolveRun({ stdout: '', stderr: '', error: String(error?.message ?? error), ms: 0 })
      return
    }
    active?.add(child)
    const kill = () => {
      try {
        if (detached && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch { /* gone */ }
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      active?.delete(child)
      resolveRun({ ...result, ms: Date.now() - started })
    }
    const timer = setTimeout(() => { timedOut = true; kill() }, Math.max(1, timeoutMs))
    const onAbort = () => kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => { if (stdout.length < MAX_OUTPUT) stdout += chunk })
    child.stderr.on('data', (chunk) => { if (stderr.length < MAX_OUTPUT) stderr += chunk })
    child.stdin.on('error', () => { /* hook did not read stdin */ })
    child.on('error', error => finish({ stdout, stderr, error: String(error?.message ?? error) }))
    child.on('close', (code) => {
      if (timedOut) finish({ stdout, stderr, timedOut: true })
      else if (signal?.aborted) finish({ stdout, stderr, error: 'cancelled' })
      else finish({ code, stdout, stderr })
    })
    child.stdin.end(JSON.stringify(input))
  })
}
