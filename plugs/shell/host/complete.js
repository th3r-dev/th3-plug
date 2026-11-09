/**
 * Completion data for `!<command>` lines, computed on the Host:
 *  - `complete`: candidates from the user's own zsh completion system
 *    (compinit + the $fpath their ~/.zshrc sets up: oh-my-zsh, Homebrew, …);
 *  - `history`: earlier commands from their shell history that start with the
 *    typed line (what zsh-autosuggestions would offer).
 * Nothing typed is executed; zsh only runs its completion functions.
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CAPTURE = join(HERE, 'capture-completion.zsh')
const ZSH = existsSync('/bin/zsh') ? '/bin/zsh' : 'zsh'

function run(file, args, { cwd, env, timeoutMs, signal, input } = {}) {
  return new Promise((resolvePromise) => {
    let out = ''
    let done = false
    let child
    try {
      child = spawn(file, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' })
    } catch {
      resolvePromise('')
      return
    }
    const kill = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch { /* gone */ }
    }
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise(out)
    }
    const onAbort = () => { kill(); finish() }
    const timer = setTimeout(() => { kill(); finish() }, timeoutMs ?? 5000)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8')
      if (out.length > 1_000_000) { kill(); finish() }
    })
    child.on('error', finish)
    child.on('close', finish)
    if (input !== undefined) child.stdin.end(input)
  })
}

let fpathPromise
/** The $fpath an interactive zsh of this user ends up with (read once). */
function userFpath() {
  fpathPromise ??= run(ZSH, ['-i', '-c', 'print -l -- $fpath'], {
    cwd: homedir(),
    env: { ...process.env, TERM: 'dumb', POWERLEVEL9K_INSTANT_PROMPT: 'off' },
    timeoutMs: 10_000,
  }).then(text => text.split('\n').map(l => l.trim()).filter(l => l.startsWith('/') && existsSync(l)))
  return fpathPromise
}

/** Warm the fpath cache early so the first Tab does not pay for ~/.zshrc. */
export function warmCompletion() {
  if (process.platform !== 'win32') void userFpath()
}

/** The word under completion: the text after the last unescaped whitespace. */
export function currentWord(line) {
  const match = /(?:^|[^\\])\s(\S*)$/.exec(line)
  if (match) return { word: match[1], start: line.length - match[1].length }
  const trimmed = line.trimStart()
  return { word: trimmed, start: line.length - trimmed.length }
}

/**
 * zsh completion candidates for `line` (everything typed after `!`).
 * @returns {Promise<{word: string, description?: string}[]>}
 */
export async function shellComplete(line, cwd, { signal, limit = 80, timeoutMs = 5000 } = {}) {
  if (process.platform === 'win32') return []
  if (line.trim().length === 0) return []
  if (line.includes('\n')) return []
  const fpath = await userFpath()
  if (signal?.aborted) return []
  const text = await run(ZSH, [CAPTURE, line], {
    cwd,
    env: { ...process.env, TERM: 'dumb', SHELL_COMMAND_FPATH: fpath.join('\n') },
    timeoutMs,
    signal,
  })
  const seen = new Map()
  for (const raw of text.split('\n')) {
    const entry = raw.replace(/\r$/, '')
    if (entry.length === 0) continue
    const at = entry.indexOf(' -- ')
    let word = (at < 0 ? entry : entry.slice(0, at)).replace(/\/{2,}$/, '/')
    const description = at < 0 ? undefined : entry.slice(at + 4).trim() || undefined
    if (word.length === 0) continue
    if (!word.endsWith('/') && !word.includes(' ')) {
      try {
        const path = resolve(cwd, word.replace(/^~(?=\/|$)/, homedir()))
        if (existsSync(path) && statSync(path).isDirectory() && /[/.~]/.test(word)) word += '/'
      } catch { /* not a path */ }
    }
    const prev = seen.get(word)
    if (prev === undefined) seen.set(word, { word, description })
    else if (prev.description === undefined && description !== undefined) prev.description = description
    if (seen.size >= limit) break
  }
  return [...seen.values()]
}

let historyCache
function historyEntries() {
  const file = process.env.HISTFILE || join(homedir(), existsSync(join(homedir(), '.zsh_history')) ? '.zsh_history' : '.bash_history')
  let mtime
  try { mtime = statSync(file).mtimeMs } catch { return [] }
  if (historyCache?.file === file && historyCache.mtime === mtime) return historyCache.entries
  let text
  try { text = readFileSync(file, 'latin1') } catch { return [] }
  // zsh writes raw bytes; re-read as UTF-8 for Thai and other non-ASCII text.
  text = Buffer.from(text, 'latin1').toString('utf8')
  const lines = text.split('\n')
  const commands = []
  let pending = ''
  for (const line of lines) {
    let entry = pending + (pending ? '\n' : '') + line.replace(/^: \d+:\d+;/, '')
    if (entry.endsWith('\\')) { pending = entry.slice(0, -1); continue }
    pending = ''
    entry = entry.trim()
    if (entry.length > 0) commands.push(entry)
  }
  const seen = new Set()
  const entries = []
  for (let i = commands.length - 1; i >= 0; i--) {
    const command = commands[i]
    if (seen.has(command)) continue
    seen.add(command)
    entries.push(command)
  }
  historyCache = { file, mtime, entries }
  return entries
}

/** Most recent distinct history commands starting with the typed line. */
export function shellHistory(line, { limit = 8 } = {}) {
  const typed = line.trimStart()
  const out = []
  for (const command of historyEntries()) {
    if (command.length <= typed.length && typed.length > 0) continue
    if (!command.startsWith(typed)) continue
    if (command.includes('\n')) continue
    out.push(command)
    if (out.length >= limit) break
  }
  return out
}
