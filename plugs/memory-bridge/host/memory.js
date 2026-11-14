/**
 * Claude Code memory on disk: where a project's auto memory lives, its
 * MEMORY.md index, the note files, and the Claude-only instruction files the
 * Harness does not read by itself (~/.claude/CLAUDE.md, .claude/CLAUDE.md,
 * .claude/rules/).
 *
 * Pure or synchronous file access; no Harness API.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const NOTE_TYPES = ['user', 'feedback', 'project', 'reference']
export const INDEX_FILE = 'MEMORY.md'

const isFile = (path) => { try { return statSync(path).isFile() } catch { return false } }
const isDir = (path) => { try { return statSync(path).isDirectory() } catch { return false } }
const readText = (path) => { try { return readFileSync(path, 'utf8') } catch { return undefined } }
const readJson = (path) => { const text = readText(path); if (text === undefined) return undefined; try { return JSON.parse(text) } catch { return undefined } }

/** Content identity for duplicate suppression; never used for security. */
export const contentDigest = text => createHash('sha256').update(text).digest('hex')
export const byteLength = text => Buffer.byteLength(text, 'utf8')

/** Claude Code's project folder name: every character outside [A-Za-z0-9] becomes `-`. */
export function projectSlug(path) {
  return resolve(path).replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * The repository root Claude Code keys memory by: the nearest ancestor holding
 * `.git`; for a linked worktree (`.git` is a file) the main checkout. Outside a
 * repository, `cwd` itself.
 */
export function repoRoot(cwd) {
  const start = resolve(cwd)
  let dir = start
  for (;;) {
    const git = join(dir, '.git')
    if (isDir(git)) return dir
    if (isFile(git)) {
      const m = /^gitdir:\s*(.+)$/m.exec(readText(git) ?? '')
      if (m) {
        const gitdir = resolve(dir, m[1].trim())
        const worktrees = `${sep}.git${sep}worktrees${sep}`
        const at = gitdir.lastIndexOf(worktrees)
        if (at > 0) return gitdir.slice(0, at)
      }
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

const expandHome = (path, home) => (path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path)

/**
 * Where this project's auto memory lives and whether Claude Code would use it.
 * Follows CLAUDE_CONFIG_DIR, CLAUDE_CODE_DISABLE_AUTO_MEMORY, and the
 * `autoMemoryEnabled` / `autoMemoryDirectory` settings (user, project, local;
 * later scopes win).
 * @returns {{ root: string, configDir: string, dir: string, enabled: boolean, reason?: string }}
 */
export function locateMemory(cwd, { home = homedir(), env = process.env } = {}) {
  const root = repoRoot(cwd)
  const configDir = env.CLAUDE_CONFIG_DIR ? resolve(expandHome(env.CLAUDE_CONFIG_DIR, home)) : join(home, '.claude')
  let enabled = true
  let reason
  let custom
  for (const file of [join(configDir, 'settings.json'), join(root, '.claude', 'settings.json'), join(root, '.claude', 'settings.local.json')]) {
    const data = readJson(file)
    if (!data || typeof data !== 'object') continue
    if (data.autoMemoryEnabled === false) { enabled = false; reason = `autoMemoryEnabled is false in ${file}` }
    if (data.autoMemoryEnabled === true) { enabled = true; reason = undefined }
    if (typeof data.autoMemoryDirectory === 'string' && (data.autoMemoryDirectory.startsWith('~/') || isAbsolute(data.autoMemoryDirectory))) {
      custom = resolve(expandHome(data.autoMemoryDirectory, home))
    }
  }
  if (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1' || env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === 'true') {
    enabled = false
    reason = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY is set'
  }
  const name = env.CLAUDE_CODE_PROJECT_DIR_NAME || projectSlug(root)
  const dir = custom ?? join(configDir, 'projects', name, 'memory')
  return { root, configDir, dir, enabled, ...(reason ? { reason } : {}) }
}

/**
 * The MEMORY.md index as Claude Code loads it: the first `maxLines` lines or
 * `maxBytes` bytes, whichever ends first.
 */
export function loadIndex(dir, { maxLines = 200, maxBytes = 25_000 } = {}) {
  const path = join(dir, INDEX_FILE)
  const text = readText(path)
  if (text === undefined) return { path, exists: false, text: '', lines: [], truncated: false, totalLines: 0, totalBytes: 0 }
  const all = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  const kept = []
  let bytes = 0
  for (const line of all) {
    if (kept.length >= maxLines) break
    const size = byteLength(line) + 1
    if (bytes + size > maxBytes) break
    kept.push(line)
    bytes += size
  }
  return {
    path,
    exists: true,
    text: kept.join('\n'),
    lines: kept.filter(line => line.trim().length > 0),
    truncated: kept.length < all.length,
    totalLines: all.length,
    totalBytes: byteLength(text),
  }
}

// ---------------------------------------------------------------- frontmatter

/** Minimal YAML frontmatter reader: `key: value` and one level of nesting. */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text ?? '')
  if (!m) return { data: {}, body: text ?? '' }
  const data = {}
  let parent
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const nested = /^\s+/.test(raw)
    const kv = /^\s*([\w-]+):\s*(.*)$/.exec(raw)
    if (!kv) continue
    const [, key, rawValue] = kv
    const value = unquote(rawValue.trim())
    if (nested && parent) { data[parent] = typeof data[parent] === 'object' && data[parent] ? data[parent] : {}; data[parent][key] = value; continue }
    if (rawValue.trim() === '') { parent = key; data[key] = {}; continue }
    parent = undefined
    data[key] = value
  }
  return { data, body: text.slice(m[0].length) }
}

function unquote(value) {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try { return JSON.parse(value) } catch { return value.slice(1, -1) }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'")
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1).split(',').map(v => unquote(v.trim())).filter(Boolean)
  return value
}

const yamlScalar = value => (/^[\w./@-][^:#\n'"[\]{}&*!|>%`]*$/.test(value) && !/\s$/.test(value) ? value : JSON.stringify(value))

// ---------------------------------------------------------------- notes

const NOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** A note name the tool accepts, without `.md`. */
export function noteName(name) {
  const clean = String(name ?? '').trim().replace(/\.md$/i, '')
  if (!NOTE_NAME.test(clean) || clean.includes('..') || clean.toUpperCase() === 'MEMORY') {
    throw new Error(`invalid note name "${name}": use letters, digits, ".", "_" or "-" (for example "prefers-pnpm"), not MEMORY`)
  }
  return clean
}

/** Every note file in the folder with its frontmatter fields. */
export function listNotes(dir) {
  let entries = []
  try { entries = readdirSync(dir) } catch { return [] }
  return entries
    .filter(entry => entry.endsWith('.md') && entry !== INDEX_FILE && !entry.startsWith('.'))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => {
      const { data } = parseFrontmatter(readText(join(dir, file)) ?? '')
      const meta = typeof data.metadata === 'object' && data.metadata ? data.metadata : {}
      return {
        file,
        name: typeof data.name === 'string' ? data.name : file.slice(0, -3),
        description: typeof data.description === 'string' ? data.description : '',
        type: typeof data.type === 'string' ? data.type : typeof meta.type === 'string' ? meta.type : undefined,
        modified: typeof meta.modified === 'string' ? meta.modified : undefined,
      }
    })
}

/** The full text of one note, or of MEMORY.md for `MEMORY`. */
export function readNote(dir, name) {
  const file = String(name ?? '').trim().replace(/\.md$/i, '').toUpperCase() === 'MEMORY' ? INDEX_FILE : `${noteName(name)}.md`
  const path = join(dir, file)
  const text = readText(path)
  if (text === undefined) throw new Error(`no note "${file}" in ${dir}`)
  return { path, text }
}

const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim()

/** The MEMORY.md line Claude Code writes for a note. */
export function indexLine({ name, title, description }) {
  return `- [${oneLine(title) || name}](${name}.md) — ${oneLine(description)}`
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, text)
  renameSync(temp, path)
}

const linksTo = (line, name) => line.includes(`](${name}.md)`)

function rewriteIndex(dir, change) {
  const path = join(dir, INDEX_FILE)
  const before = readText(path) ?? ''
  const lines = before.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n').filter((line, i, all) => !(all.length === 1 && line === ''))
  const next = change(lines)
  const text = next.length > 0 ? `${next.join('\n')}\n` : ''
  if (text !== before) writeAtomic(path, text)
  return { path, lines: next, bytes: byteLength(text) }
}

/**
 * Create or replace one note and its index line, in Claude Code's format.
 * @returns {{ path: string, created: boolean, line: string, index: { lines: string[], bytes: number }, replacedLine?: string }}
 */
export function saveNote(dir, { name, title, description, type, content, sessionId, now = new Date() }) {
  const clean = noteName(name)
  if (!NOTE_TYPES.includes(type)) throw new Error(`type must be one of ${NOTE_TYPES.join(', ')}`)
  if (!oneLine(description)) throw new Error('description is required')
  const body = String(content ?? '').trim()
  if (!body) throw new Error('content is required')
  const path = join(dir, `${clean}.md`)
  const previous = readText(path)
  const prior = previous === undefined ? {} : parseFrontmatter(previous).data
  const origin = (typeof prior.metadata === 'object' && prior.metadata?.originSessionId) || sessionId
  const text = [
    '---',
    `name: ${yamlScalar(clean)}`,
    `description: ${yamlScalar(oneLine(description))}`,
    'metadata:',
    '  node_type: memory',
    `  type: ${type}`,
    ...(origin ? [`  originSessionId: ${yamlScalar(String(origin))}`] : []),
    `  modified: ${now.toISOString()}`,
    '---',
    '',
    body,
    '',
  ].join('\n')
  writeAtomic(path, text)
  const line = indexLine({ name: clean, title, description })
  let replacedLine
  const index = rewriteIndex(dir, (lines) => {
    const at = lines.findIndex(l => linksTo(l, clean))
    if (at < 0) return [...lines, line]
    replacedLine = lines[at]
    return lines.map((l, i) => (i === at ? line : l)).filter((l, i) => i === at || !linksTo(l, clean))
  })
  return { path, created: previous === undefined, line, index, ...(replacedLine !== undefined && replacedLine !== line ? { replacedLine } : {}) }
}

/** Delete one note and its index line. */
export function deleteNote(dir, name) {
  const clean = noteName(name)
  const path = join(dir, `${clean}.md`)
  const existed = isFile(path)
  if (existed) unlinkSync(path)
  const removed = []
  const index = rewriteIndex(dir, lines => lines.filter((l) => { if (linksTo(l, clean)) { removed.push(l); return false } return true }))
  if (!existed && removed.length === 0) throw new Error(`no note "${clean}.md" in ${dir}`)
  return { path, existed, removed, index }
}

// ---------------------------------------------------------------- instructions

const stripComments = text => text.replace(/```[\s\S]*?```|<!--[\s\S]*?-->/g, m => (m.startsWith('```') ? m : ''))

function walkMarkdown(dir, out = [], depth = 0) {
  if (depth > 4) return out
  let entries = []
  try { entries = readdirSync(dir).sort((a, b) => a.localeCompare(b)) } catch { return out }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (isDir(path)) walkMarkdown(path, out, depth + 1)
    else if (entry.endsWith('.md')) out.push(path)
  }
  return out
}

/** `~/…` for paths under home, project-relative inside `root`, else absolute. */
export function displayPath(path, root, home = homedir()) {
  if (root) {
    const rel = relative(root, path)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel
  }
  if (path.startsWith(home + sep)) return `~/${path.slice(home.length + 1)}`
  return path
}

/**
 * Claude Code instruction files the Harness does not load: user CLAUDE.md,
 * user rules, `.claude/CLAUDE.md`, project rules. Rules scoped with `paths`
 * load in Claude Code only next to matching files, so they are listed in
 * `scoped` instead. A file whose text the Harness already loads is skipped.
 * @returns {{ files: Array<{ path: string, display: string, content: string }>, scoped: string[], skipped: Array<{ path: string, why: string }> }}
 */
export function claudeInstructions({ root, configDir, home = homedir(), env = process.env }) {
  const dshHome = env.DSH_HOME || join(home, '.dsh')
  const agentsHome = env.DSH_AGENTS_HOME || join(home, '.agents')
  const loaded = new Set([join(dshHome, 'AGENTS.md'), join(agentsHome, 'AGENTS.md'), join(root, 'AGENTS.md'), join(root, 'CLAUDE.md')]
    .map(readText).filter(text => text !== undefined).map(text => contentDigest(text.trim())))
  const files = []
  const scoped = []
  const skipped = []
  const add = (path, { rule = false } = {}) => {
    const raw = readText(path)
    if (raw === undefined) return
    let content = raw
    if (rule) {
      const { data, body } = parseFrontmatter(raw)
      if (data.paths !== undefined && data.paths !== '' && !(Array.isArray(data.paths) && data.paths.length === 0)) { scoped.push(path); return }
      content = body
    }
    content = stripComments(content).trim()
    if (!content) return
    if (loaded.has(contentDigest(raw.trim())) || loaded.has(contentDigest(content))) { skipped.push({ path, why: 'the Harness already loads the same text' }); return }
    loaded.add(contentDigest(content))
    files.push({ path, display: displayPath(path, root, home), content })
  }
  add(join(configDir, 'CLAUDE.md'))
  for (const path of walkMarkdown(join(configDir, 'rules'))) add(path, { rule: true })
  add(join(root, '.claude', 'CLAUDE.md'))
  for (const path of walkMarkdown(join(root, '.claude', 'rules'))) add(path, { rule: true })
  return { files, scoped, skipped }
}

/** Keep files in order until `maxBytes`; the first file that does not fit is cut, the rest are omitted. */
export function budgetFiles(files, maxBytes) {
  const kept = []
  const omitted = []
  let used = 0
  for (const file of files) {
    const size = byteLength(file.content)
    if (used + size <= maxBytes) { kept.push(file); used += size; continue }
    const room = maxBytes - used
    if (room > 512 && omitted.length === 0) {
      const bytes = Buffer.from(file.content, 'utf8')
      let end = room
      while (end > 0 && (bytes[end] & 0xC0) === 0x80) end--
      kept.push({ ...file, content: `${bytes.subarray(0, end).toString('utf8')}\n…`, truncatedFrom: size })
      used = maxBytes
    } else {
      omitted.push(file)
    }
  }
  return { kept, omitted }
}
