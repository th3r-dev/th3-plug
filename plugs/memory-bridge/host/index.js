/**
 * @th3-plug/memory-bridge — Host half. Memory Bridge.
 *
 * Gives every Harness session, on any model, the shared project memory:
 *
 * - The memory index (`~/.claude/projects/<project>/memory/MEMORY.md`) and the
 *   rules for keeping it, once per session and again after compaction, as one
 *   sourced user-role message.
 * - A short prompt section stating the same protocol on every model request,
 *   so it survives compaction and does not depend on one model's habits.
 * - Index lines that changed outside this session (Claude Code running next to
 *   it) are announced on the next user message.
 * - A `memory` tool that lists, reads, saves and deletes notes in the plain
 *   Markdown format Claude Code uses, so every agent shares one memory.
 * - Claude Code instruction files the Harness skips: `~/.claude/CLAUDE.md`,
 *   `~/.claude/rules/`, `.claude/CLAUDE.md`, `.claude/rules/`.
 * - `/memory` reports what was found. It never reaches the model.
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import process from 'node:process'
import {
  NOTE_TYPES, budgetFiles, byteLength, claudeInstructions, deleteNote, displayPath,
  listNotes, loadIndex, locateMemory, readNote, saveNote,
} from './memory.js'

export const name = 'th3-memory-bridge'
export const inject = ['commands', 'tools']

export const SOURCE_KIND = 'th3-memory-bridge'

const DEFAULTS = {
  /** Slash command for the report. */
  command: 'memory',
  /** Show the memory index and the rules for keeping it. */
  autoMemory: true,
  /** Register the `memory` tool (list, read, save, delete notes). */
  tool: true,
  /** Keep the memory protocol in the system prompt, so any model sees it on every request. */
  promptSection: true,
  /** Load ~/.claude/CLAUDE.md, ~/.claude/rules/, .claude/CLAUDE.md and .claude/rules/. */
  instructions: true,
  /** On a new user message, announce index lines that changed outside this session. */
  refresh: true,
  /** Give subagents the memory too (Claude Code does not). */
  subagents: false,
  /** MEMORY.md lines shown, as Claude Code loads them. */
  maxIndexLines: 200,
  /** MEMORY.md bytes shown, as Claude Code loads them. */
  maxIndexBytes: 25_000,
  /** Budget for the bridged instruction files together. */
  maxInstructionBytes: 65_536,
  /** Absolute project roots to bridge; empty = every project. */
  projects: [],
}

function dropEmpty(config) {
  return Object.fromEntries(Object.entries(config ?? {}).filter(([, value]) => value !== undefined && value !== null))
}

const escapeFrame = text => String(text).replace(/<\/?system-reminder>/gi, m => m.replace('<', '&lt;'))
const kib = bytes => `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`

function message(text, source) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: `<system-reminder>\n${escapeFrame(text)}\n</system-reminder>` }],
    source: { kind: SOURCE_KIND, ...source },
  }
}

// ---------------------------------------------------------------- rendering

/**
 * The memory protocol as a system-prompt section: short, imperative, and
 * model-neutral, so it reaches any model on every request even after
 * compaction dropped the first message.
 */
export const MEMORY_PROMPT = [
  'Shared memory: this project keeps one Markdown note per fact in a `MEMORY.md` index that arrives as a system reminder when memory is available. The notes are shared with the other coding agents the user runs, so keep them in the same plain-Markdown shape.',
  '',
  '1. When a listed note bears on the task, read it before relying on its one-line summary: call `memory` with action `read` and the name without `.md`. A note can be stale; a direct user instruction wins.',
  '2. Call `memory` with action `save` (name, type, description, content) when the user corrects you, states a preference or working style, gives a decision or deadline the code does not show, says where outside information lives, or says to remember something.',
  '3. Check the index first: if a note on the same topic exists, save with that name to replace it instead of adding a duplicate. Use action `delete` for a note that is wrong.',
  '4. Note body: the rule or fact first, then `**Why:**` and `**How to apply:**`. Keep `description` under 150 characters.',
  '5. Never save what the code or instruction files already say, details of the current task, or secrets.',
].join('\n')

/** Prompt section order: after file references, before the per-tool sections. */
const MEMORY_SECTION_ORDER = 910

/** The memory index and the rules for using it, as one user-role message. */
export function memoryGuidance({ dir, index, tool, maxIndexLines, maxIndexBytes }) {
  const lines = [
    '## Shared memory',
    '',
    `This project keeps a shared Markdown memory at \`${dir}\`: one note per fact, listed in the MEMORY.md index below. Claude Code and this Harness (on any model) read and write the same notes, so a note saved here is remembered there too.`,
    '',
    'Contents of MEMORY.md:',
    '',
    index.lines.length > 0 ? index.text : '(empty: no notes saved yet)',
  ]
  if (index.truncated) {
    lines.push('', `Only the first ${index.text.split('\n').length} of ${index.totalLines} lines are shown (load limit ${maxIndexLines} lines / ${maxIndexBytes} bytes).${tool ? ' Call `memory` with action read and name MEMORY for the rest, or action list for the note names.' : ''} Shorten the index when you next save: one short line per note, merge or delete stale notes.`)
  }
  if (!tool) {
    lines.push('', `Notes load only when read: when a listed note bears on the task, read that note file from \`${dir}\` before relying on the one-line summary. Saving is off for this session.`)
    return lines.join('\n')
  }
  lines.push(
    '',
    'Protocol:',
    '1. A note can be stale. Check it against the current files before acting on it, and treat a direct user instruction as the higher authority.',
    '2. When a listed note bears on the task, read it first: call `memory` with action `read` and its name without `.md`. Do not rely on the summary line alone.',
    '3. When the user corrects you, states a preference or working style, gives a decision or deadline the code does not show, says where outside information lives, or asks you to remember something, save it: `memory` with action `save`, plus name, type, description and content.',
    '4. Before saving, look in the index for a note on the same topic and save under that name to replace it, instead of adding a near-duplicate. Delete a note that turns out wrong with action `delete`.',
    '5. Note body: the rule or fact first, then a `**Why:**` line and a `**How to apply:**` line. Keep `description` under 150 characters. Use action `list` to see every note with its type and description.',
    '6. Do not save what the code, git history or instruction files already say, the details of the current task, or secrets.',
  )
  return lines.join('\n')
}

function instructionsText({ kept, omitted }) {
  if (kept.length === 0) return ''
  const parts = ['The following instruction files from Claude Code may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.']
  for (const file of kept) {
    parts.push(`Instructions from: ${file.display}${file.truncatedFrom ? ` (cut from ${kib(file.truncatedFrom)} to fit)` : ''}\n\n${file.content}`)
  }
  if (omitted.length > 0) parts.push(`Not loaded (over the instruction budget): ${omitted.map(f => f.display).join(', ')}`)
  return parts.join('\n\n')
}

/** Lines of the latest visible index, folded from the session's visible messages. */
export function visibleMemory(agent, pending = []) {
  const state = { baseline: false, dir: undefined, lines: new Set(), pending: false }
  const fold = (source) => {
    if (source?.kind !== SOURCE_KIND) return
    if (source.form === 'baseline') {
      state.baseline = true
      state.dir = source.dir
      state.lines = new Set(Array.isArray(source.lines) ? source.lines : [])
    } else if (source.form === 'update' && state.baseline) {
      for (const line of source.removed ?? []) state.lines.delete(line)
      for (const line of source.added ?? []) state.lines.add(line)
    }
  }
  const session = agent?.session
  const nodes = session?.surface?.nodes
  if (nodes && typeof session.eventAt === 'function') {
    for (const seq of nodes) {
      const event = session.eventAt(seq)
      if (event?.type === 'user/message') fold(event.data?.source)
    }
  }
  for (const m of pending) {
    if (m?.source?.kind === SOURCE_KIND) { state.pending = true; fold(m.source) }
  }
  return state
}

// ---------------------------------------------------------------- plugin

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...dropEmpty(config) }
  const home = homedir()
  /** Index changes this plug's own tool made per agent since its last notice (derived cache). */
  const ownChanges = new WeakMap()
  const warn = message => ctx.logger?.warn?.(`th3-memory-bridge: ${message}`)

  async function where(agent, signal) {
    let cwd
    try {
      const wd = ctx.get('workingDirectory')
      if (wd && agent?.session) cwd = await wd.get(agent.session)
      if (!cwd && wd && agent) cwd = await wd.ensure(agent, signal)
    } catch { /* fall back */ }
    if (typeof cwd !== 'string' || cwd.length === 0) cwd = process.cwd()
    return cwd
  }

  const allowed = root => options.projects.length === 0 || options.projects.includes(root)
  const isRoot = (agent) => {
    const roots = ctx.get('agents')?.roots?.()
    return !Array.isArray(roots) || roots.includes(agent)
  }
  const indexOf = dir => loadIndex(dir, { maxLines: options.maxIndexLines, maxBytes: options.maxIndexBytes })

  function baseline(cwd) {
    const located = locateMemory(cwd, { home })
    if (!allowed(located.root)) return undefined
    const sections = []
    let files = []
    if (options.instructions) {
      const found = claudeInstructions({ root: located.root, configDir: located.configDir, home })
      const budgeted = budgetFiles(found.files, options.maxInstructionBytes)
      files = budgeted.kept.map(f => f.display)
      const text = instructionsText(budgeted)
      if (text) sections.push(text)
    }
    const memoryOn = options.autoMemory && located.enabled
    const index = memoryOn ? indexOf(located.dir) : undefined
    if (memoryOn) {
      sections.push(memoryGuidance({ dir: located.dir, index, tool: options.tool, maxIndexLines: options.maxIndexLines, maxIndexBytes: options.maxIndexBytes }))
    }
    if (sections.length === 0) return undefined
    return message(sections.join('\n\n'), {
      form: 'baseline',
      dir: memoryOn ? located.dir : null,
      lines: index?.lines ?? [],
      files,
      summary: memoryOn ? `memory · ${index.lines.length} notes indexed` : 'instruction files',
    })
  }

  function update(agent, state, cwd) {
    if (!state.dir) return undefined
    const located = locateMemory(cwd, { home })
    if (located.dir !== state.dir || !located.enabled) return undefined
    const known = new Set(state.lines)
    const own = ownChanges.get(agent)
    if (own) {
      for (const line of own.removed) known.delete(line)
      for (const line of own.added) known.add(line)
    }
    const current = indexOf(state.dir).lines
    const now = new Set(current)
    const added = current.filter(line => !known.has(line))
    const removed = [...known].filter(line => !now.has(line))
    if (added.length === 0 && removed.length === 0) return undefined
    ownChanges.delete(agent)
    const text = ['The shared memory index (MEMORY.md) changed outside this session since it was last shown.']
    if (added.length > 0) text.push('', 'Added:', ...added)
    if (removed.length > 0) text.push('', 'Removed:', ...removed)
    // Own tool writes are already in the conversation; fold them in silently.
    const ownAdded = own ? [...own.added].filter(line => now.has(line) && !state.lines.has(line)) : []
    const ownRemoved = own ? [...own.removed].filter(line => !now.has(line) && state.lines.has(line)) : []
    return message(text.join('\n'), {
      form: 'update',
      dir: state.dir,
      added: [...added, ...ownAdded],
      removed: [...removed, ...ownRemoved],
      summary: `memory · index changed (+${added.length} −${removed.length})`,
    })
  }

  // ------------------------------------------------------------ context
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || payload.signal?.aborted) return decision
    const { agent } = payload
    if (!options.subagents && !isRoot(agent)) return decision
    if (!options.autoMemory && !options.instructions) return decision
    try {
      const messages = decision.messages ?? []
      const state = visibleMemory(agent, messages)
      if (state.pending) return decision
      const cwd = await where(agent, payload.signal)
      const located = locateMemory(cwd, { home })
      let extra
      if (!state.baseline || (state.dir && state.dir !== located.dir)) {
        extra = baseline(cwd)
        ownChanges.delete(agent)
      } else if (options.refresh && options.autoMemory && messages.some(m => m?.source?.kind === 'user')) {
        extra = update(agent, state, cwd)
      }
      if (!extra) return decision
      return { ...decision, messages: [...messages, extra] }
    } catch (error) {
      warn(`memory context failed: ${String(error?.message ?? error)}`)
      return decision
    }
  })

  // ------------------------------------------------------------ tool
  async function memoryDir(agent, signal) {
    const located = locateMemory(await where(agent, signal), { home })
    if (!allowed(located.root)) throw new Error(`memory-bridge is off for ${located.root} (not in its projects list)`)
    if (!options.autoMemory || !located.enabled) throw new Error(`auto memory is off for this project${located.reason ? `: ${located.reason}` : ''}`)
    return located.dir
  }

  function limitNote(index) {
    const lines = index.lines.length
    if (lines > options.maxIndexLines || index.bytes > options.maxIndexBytes) {
      return `MEMORY.md is over the load limit (${lines} lines, ${index.bytes} bytes; limit ${options.maxIndexLines} lines / ${options.maxIndexBytes} bytes): lines past it are not shown in new sessions. Shorten it now: one short line per note, merge or delete stale notes.`
    }
    if (lines > options.maxIndexLines * 0.9 || index.bytes > options.maxIndexBytes * 0.9) {
      return `MEMORY.md is near the load limit (${lines} lines, ${index.bytes} bytes of ${options.maxIndexLines} / ${options.maxIndexBytes}). Keep entries short; merge or delete stale notes.`
    }
    return undefined
  }

  const memoryTool = {
    name: 'memory',
    description: 'Read, save, delete or list notes in this project\'s shared memory, the plain-Markdown folder that Claude Code and this Harness both keep. Read a note before relying on its MEMORY.md summary; save one when the user corrects you, states a preference, or asks you to remember something.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'save', 'delete'], description: 'list shows every note with type and description; read returns one note; save creates or replaces a note and its index line; delete removes both.' },
        name: { type: 'string', description: 'Note name without .md, in kebab-case, such as "prefers-pnpm". Required for read, save and delete. With read, MEMORY returns the whole index.' },
        type: { type: 'string', enum: NOTE_TYPES, description: 'Required for save: user (who the user is), feedback (a correction or confirmed approach), project (work the code does not show), reference (where outside information lives).' },
        title: { type: 'string', description: 'For save: short link text for the index line. Defaults to name.' },
        description: { type: 'string', description: 'Required for save: one line under 150 characters, stored in the note and shown in the index.' },
        content: { type: 'string', description: 'Required for save: the note body in Markdown, rule first, then **Why:** and **How to apply:**.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', properties: { action: { type: 'string' }, path: { type: 'string' }, text: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const action = args?.action
      if (!['list', 'read', 'save', 'delete'].includes(action)) throw new Error('action must be list, read, save or delete')
      const dir = await memoryDir(exec?.agent, exec?.signal)
      if (action === 'list') {
        const notes = listNotes(dir)
        const index = indexOf(dir)
        const rows = notes.map((note) => `${note.name} · ${note.type ?? 'untyped'}${note.description ? ` · ${note.description}` : ''}`)
        const head = `${dir}\n${notes.length} note(s); MEMORY.md ${index.totalLines} lines, ${index.totalBytes} bytes`
        return { action, path: dir, text: [head, '', ...rows].join('\n') }
      }
      if (typeof args.name !== 'string' || args.name.trim() === '') throw new Error(`${action} needs name`)
      if (action === 'read') {
        const note = readNote(dir, args.name)
        return { action, path: note.path, text: `${note.path}\n\n${note.text}` }
      }
      const agent = exec?.agent
      let own = agent ? ownChanges.get(agent) : undefined
      if (agent && !own) { own = { added: new Set(), removed: new Set() }; ownChanges.set(agent, own) }
      if (action === 'save') {
        for (const key of ['type', 'description', 'content']) {
          if (typeof args[key] !== 'string' || args[key].trim() === '') throw new Error(`save needs ${key}`)
        }
        const saved = saveNote(dir, { ...args, sessionId: agent?.id })
        if (own) {
          if (saved.replacedLine) { own.removed.add(saved.replacedLine); own.added.delete(saved.replacedLine) }
          own.removed.delete(saved.line)
          own.added.add(saved.line)
        }
        const lines = [
          `${saved.created ? 'Saved new note' : 'Replaced note'} ${saved.path}`,
          `Index line: ${saved.line}`,
          `MEMORY.md: ${saved.index.lines.length} lines, ${saved.index.bytes} bytes`,
        ]
        const note = limitNote(saved.index)
        if (note) lines.push(note)
        return { action, path: saved.path, text: lines.join('\n') }
      }
      const gone = deleteNote(dir, args.name)
      if (own) for (const line of gone.removed) { own.removed.add(line); own.added.delete(line) }
      return {
        action,
        path: gone.path,
        text: [`Deleted ${gone.existed ? gone.path : `the index line for ${gone.path} (the file was already gone)`}`, ...gone.removed.map(l => `Removed index line: ${l}`)].join('\n'),
      }
    },
  }

  // ------------------------------------------------------------ report
  function report(cwd) {
    const located = locateMemory(cwd, { home })
    const show = path => displayPath(path, undefined, home)
    const lines = [`Shared memory for ${located.root}`]
    if (!allowed(located.root)) lines.push('Bridge: off for this project (not in the projects list)')
    lines.push(`Folder: ${show(located.dir)}`)
    if (!options.autoMemory) lines.push('○ memory: off (autoMemory: false in this plug\'s config)')
    else if (!located.enabled) lines.push(`○ memory: off — ${located.reason}`)
    else {
      const index = indexOf(located.dir)
      const notes = listNotes(located.dir)
      const byType = {}
      for (const note of notes) byType[note.type ?? 'untyped'] = (byType[note.type ?? 'untyped'] ?? 0) + 1
      lines.push(`✔ memory: ${notes.length} notes${notes.length ? ` (${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', ')})` : ''}`)
      if (!index.exists) lines.push('  MEMORY.md: not created yet; the first saved note creates it')
      else {
        lines.push(`  MEMORY.md: ${index.totalLines} lines, ${kib(index.totalBytes)}`)
        if (index.truncated) lines.push(`  ◐ only the first ${index.text.split('\n').length} lines load (limit ${options.maxIndexLines} lines / ${kib(options.maxIndexBytes)}); ask the agent to shorten MEMORY.md`)
        const linked = new Set(index.lines.map(l => /\]\(([^)]+\.md)\)/.exec(l)?.[1]).filter(Boolean))
        const unlisted = notes.filter(n => !linked.has(n.file))
        if (unlisted.length > 0 && !index.truncated) lines.push(`  ◐ ${unlisted.length} note file(s) not in the index: ${unlisted.slice(0, 8).map(n => n.file).join(', ')}${unlisted.length > 8 ? ', …' : ''}`)
      }
      lines.push(`  tool: ${options.tool ? '`memory` (list · read · save · delete)' : 'off — the agent can read notes but not save them'}`)
      lines.push(`  refresh: ${options.refresh ? 'changes made outside the session are announced on your next message' : 'off'}`)
      lines.push(`  models: any (the notes are plain Markdown; no model-specific format); protocol on every request: ${options.promptSection ? 'yes (system prompt section)' : 'no, first message only'}`)
    }
    if (options.instructions) {
      const found = claudeInstructions({ root: located.root, configDir: located.configDir, home })
      const { kept, omitted } = budgetFiles(found.files, options.maxInstructionBytes)
      if (kept.length + omitted.length + found.scoped.length + found.skipped.length === 0) lines.push('○ instructions: no ~/.claude/CLAUDE.md, .claude/CLAUDE.md or rules to bridge')
      for (const file of kept) lines.push(`✔ instructions ${file.display} (${kib(byteLength(file.content))}${file.truncatedFrom ? `, cut from ${kib(file.truncatedFrom)}` : ''})`)
      for (const file of omitted) lines.push(`✖ instructions ${file.display} — over the ${kib(options.maxInstructionBytes)} budget (maxInstructionBytes)`)
      for (const skip of found.skipped) lines.push(`○ instructions ${displayPath(skip.path, located.root, home)} — ${skip.why}`)
      if (found.scoped.length > 0) lines.push(`○ ${found.scoped.length} path-scoped rule(s) not loaded (they apply only next to matching files): ${found.scoped.map(p => displayPath(p, located.root, home)).join(', ')}`)
    } else {
      lines.push('○ instructions: off (instructions: false in this plug\'s config)')
    }
    lines.push('', 'New sessions get this memory on their first request; open sessions get it after compaction or when you move to another folder.')
    return lines.join('\n')
  }

  ctx.effect(function* () {
    if (options.tool) yield ctx.tools.register(memoryTool)
    const prompt = ctx.get('systemPrompt')
    if (options.promptSection && options.autoMemory && options.tool) {
      if (prompt?.section) yield prompt.section({ name: 'th3-memory-bridge', order: MEMORY_SECTION_ORDER, text: MEMORY_PROMPT })
      else warn('systemPrompt service unavailable; the memory protocol is only in the session message')
    }
    yield ctx.commands.register({
      name: options.command,
      description: 'Show the shared memory and instruction files this project keeps for every model',
      input: { hint: '[folder]' },
      handler: async ({ agent, rawInput, signal }) => {
        const asked = rawInput.trim()
        return { kind: 'success', text: report(asked || await where(agent, signal)) }
      },
    })
  }, 'th3-memory-bridge lifecycle')
}
