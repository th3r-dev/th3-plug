/**
 * Web half of the th3-plug shell plug: while the composer holds a `!<command>`
 * line, show the host suggestion menu with
 *  - History: earlier commands from the user's shell history, and
 *  - Shell completions: what zsh offers for the word under the caret.
 * Tab (or a click) inserts the highlighted suggestion; Enter always submits
 * the line as typed, so the Host plugin runs it without the AI agent.
 *
 * The slash/@ menu only detects `/` and `@`, so this module teaches the
 * per-session trigger controller one more trigger, `!`, by wrapping its
 * `track` and `arbitrate`. Everything is restored when the plugin unloads.
 */
window.__ModuleLoader__.load({
  id: '@th3-plug/shell',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const COMMAND_NAME = 'sh'
    const TRIGGER = '!'
    const ENDPOINT = '/api/th3-shell/complete'
    const NS = 'th3-shell'
    const PATCHED = Symbol.for('@th3-plug/shell:patched')
    const DEBOUNCE_MS = 120

    // Group headings ride each row's `section` (the host menu then hides its
    // own group title, whose dictionary belongs to another plugin).
    const titles = {
      en: { history: 'History', completion: 'Shell completions', running: 'Running…', copy: 'Copy', copied: 'Copied', noOutput: 'No output', omitted: 'Earlier output omitted' },
      th: { history: 'ประวัติคำสั่ง', completion: 'คำแนะนำจาก shell', running: 'กำลังรัน…', copy: 'คัดลอก', copied: 'คัดลอกแล้ว', noOutput: 'ไม่มีผลลัพธ์', omitted: 'ตัดผลลัพธ์ช่วงต้นออก' },
      zh: { history: '历史命令', completion: 'Shell 补全', running: '运行中…', copy: '复制', copied: '已复制', noOutput: '无输出', omitted: '已省略较早的输出' },
    }
    let t = key => titles.en[key] ?? key

    /** The `!` hit for this draft and caret, or null when the caret is not on a `!` line. */
    function bangHit(draft, caret, guard, draftRev) {
      if (guard?.tier === 'frozen' || typeof draft !== 'string' || typeof caret !== 'number') return null
      const first = draft.search(/\S/)
      if (first < 0 || draft.charAt(first) !== TRIGGER || caret <= first) return null
      const line = draft.slice(first + 1, caret)
      if (line.includes('\n')) return null
      // Only while the caret ends the line: completing in the middle would
      // drop the text after the caret.
      const rest = draft.slice(caret)
      if (rest.length > 0 && !/^\s*$/.test(rest)) return null
      return {
        trigger: TRIGGER,
        query: line,
        quoted: false,
        position: 'leading',
        span: { start: first + 1, end: caret, draftRev },
      }
    }

    /** Same open-menu logic as the controller's own `track`, for a `!` hit. */
    function trackBang(c, hit) {
      const launched = c.launcher.getSnapshot() !== null
      c.clearLauncher()
      if (launched) c.dismissed = null
      if (c.dismissed !== null) {
        const d = c.dismissed
        const same = d.trigger === hit.trigger && d.query === hit.query && d.quoted === hit.quoted
          && d.start === hit.span.start && d.end === hit.span.end
        if (!same) c.dismissed = null
        else {
          c.hit = hit
          return
        }
      }
      const prev = c.menu.getSnapshot()
      const same = !launched && prev.open && prev.hit !== null && prev.hit.trigger === hit.trigger
        && prev.hit.query === hit.query && prev.hit.span.start === hit.span.start && prev.hit.span.end === hit.span.end
      c.hit = hit
      if (same) return
      const roster = c.deps.roster.sources(TRIGGER)
      if (roster.length === 0) {
        c.stopFetch()
        c.reduce({ type: 'close' })
        return
      }
      if (launched || !prev.open || prev.hit === null || prev.hit.trigger !== TRIGGER) {
        c.menu.set({
          ...c.menu.getSnapshot(),
          groups: roster.map(s => ({ source: s.name, status: 'pending', items: [] })),
          highlight: null,
        })
      }
      c.reduce({ type: 'hit', hit })
      c.refreshHeaders(hit, roster)
      c.fetchCandidates(hit, roster)
    }

    function patchController(proto) {
      if (proto[PATCHED]) return proto[PATCHED]
      const track = proto.track
      const arbitrate = proto.arbitrate
      proto.track = function (draft, caret, guard, draftRev) {
        if (this.disposed) return
        const hit = bangHit(draft, caret, guard, draftRev)
        if (hit === null) return track.call(this, draft, caret, guard, draftRev)
        trackBang(this, hit)
      }
      proto.arbitrate = function (key, composing) {
        // Enter runs the line as typed; Tab and clicks pick a suggestion.
        if (!composing && key === 'enter' && this.hit?.trigger === TRIGGER && this.menu.getSnapshot().open) {
          this.rememberDismissed()
          this.stopFetch()
          this.reduce({ type: 'close' })
          return 'pass'
        }
        return arbitrate.call(this, key, composing)
      }
      const restore = () => {
        proto.track = track
        proto.arbitrate = arbitrate
        delete proto[PATCHED]
      }
      proto[PATCHED] = restore
      return restore
    }

    /** Find the object on the prototype chain that owns `key`. */
    function owner(object, key) {
      for (let p = object; p; p = Object.getPrototypeOf(p)) {
        if (Object.prototype.hasOwnProperty.call(p, key)) return p
      }
      return undefined
    }

    function sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
    }

    async function query(kind, session, line, signal) {
      await sleep(kind === 'history' ? 40 : DEBOUNCE_MS, signal)
      const url = new URL(ENDPOINT, window.location.origin)
      url.searchParams.set('kind', kind)
      url.searchParams.set('line', line)
      if (session?.sessionId) url.searchParams.set('session', String(session.sessionId))
      const response = await fetch(url, { credentials: 'same-origin', signal })
      if (!response.ok) throw new Error(`th3-shell ${kind}: HTTP ${response.status}`)
      const body = await response.json()
      return Array.isArray(body.items) ? body.items : []
    }

    /** Split the line into the part before the word under the caret and that word. */
    function splitWord(line) {
      const match = /(?:^|[^\\])\s(\S*)$/.exec(line)
      if (match) return { before: line.slice(0, line.length - match[1].length), word: match[1] }
      const trimmed = line.trimStart()
      return { before: line.slice(0, line.length - trimmed.length), word: trimmed }
    }

    // The menu highlights the first group that settles. Hold history back a
    // moment so completions (listed first) win the highlight and Tab completes
    // the word, the way it does in a terminal.
    let pendingCompletion = { line: undefined, done: Promise.resolve() }

    const historySource = {
      trigger: TRIGGER,
      name: 'shell-history',
      order: 1,
      async candidates(session, { query: line, signal }) {
        const items = await query('history', session, line, signal)
        if (pendingCompletion.line === line) {
          await Promise.race([pendingCompletion.done, sleep(700, signal)])
        }
        const section = t('history')
        return items.map(command => ({ name: command, value: command, section }))
      },
      onPick({ candidate }) {
        // Keep the user's spacing after `!`.
        const lead = /^\s*/.exec(this.lastLine ?? '')?.[0] ?? ''
        return { text: lead + String(candidate.value ?? candidate.name) }
      },
    }

    const completionSource = {
      trigger: TRIGGER,
      name: 'shell-completion',
      order: 0,
      candidates(session, request) {
        const promise = this.load(session, request)
        pendingCompletion = { line: request.query, done: promise.then(() => {}, () => {}) }
        return promise
      },
      async load(session, { query: line, signal }) {
        if (line.trim().length === 0) return []
        const items = await query('complete', session, line, signal)
        const { word } = splitWord(line)
        return items
          .filter(item => typeof item?.word === 'string' && item.word !== word)
          .map(item => ({
            name: item.word,
            value: line,
            section: t('completion'),
            ...(item.description ? { description: item.description } : {}),
          }))
      },
      onPick({ candidate }) {
        const line = String(candidate.value ?? '')
        const { before } = splitWord(line)
        const word = candidate.name
        const open = word.endsWith('/') || word.endsWith('=')
        return { text: before + word + (open ? '' : ' ') }
      },
    }

    // History picks keep the spacing typed after `!`; remember the last line.
    const historyCandidates = historySource.candidates
    historySource.candidates = function (session, request) {
      historySource.lastLine = request.query
      return historyCandidates.call(this, session, request)
    }


    // ---- Result row: `!cmd` as the user's bubble, output as a reply ----------

    const CSS = `
.th3-shell{display:flex;flex-direction:column;gap:12px;width:100%;margin:4px 0}
.th3-shell-user{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.th3-shell-fallback-bubble{max-width:82%;padding:8px 14px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}
.th3-shell-term{--th3-shell-line:22px;--th3-shell-gutter:30px;position:relative;padding-left:var(--th3-shell-gutter);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-1));border-radius:var(--dsw-radius-lg,12px);overflow:hidden;font:var(--dsw-font-markdown-code-block,13px/22px ui-monospace,SFMono-Regular,Menlo,monospace)}
.th3-shell-head{display:flex;align-items:flex-start;gap:12px;margin-left:calc(-1 * var(--th3-shell-gutter));padding:9px 14px 9px var(--th3-shell-gutter);position:relative}
.th3-shell-term[data-body] .th3-shell-head{border-bottom:.5px solid var(--dsw-alias-border-l2)}
.th3-shell-prompt{display:flex;align-items:baseline;gap:8px;min-width:0;flex:1;line-height:var(--th3-shell-line)}
.th3-shell-cwd{flex:none;color:var(--dsw-alias-label-tertiary)}
.th3-shell-cmd{white-space:pre-wrap;overflow-wrap:anywhere}
.th3-shell-dot{position:absolute;left:12px;top:calc(9px + var(--th3-shell-line) / 2);width:6px;height:6px;margin-top:-3px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.th3-shell-term[data-state=error] .th3-shell-dot{background:var(--dsw-alias-state-error-primary)}
.th3-shell-term[data-state=running] .th3-shell-dot{background:var(--dsw-alias-label-tertiary);animation:th3-shell-pulse 1s ease-in-out infinite}
@keyframes th3-shell-pulse{50%{opacity:.25}}
.th3-shell-copy{flex:none;background:transparent;border:none;padding:0;margin:0;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xs-13,13px/22px inherit);line-height:var(--th3-shell-line)}
.th3-shell-copy:hover{color:var(--dsw-alias-label-primary)}
.th3-shell-out{max-height:420px;padding:12px 14px 12px 0;overflow:auto;white-space:pre;line-height:var(--th3-shell-line)}
.th3-shell-note{padding:8px 14px 0 0;color:var(--dsw-alias-label-tertiary)}
.th3-shell-empty{padding:12px 14px 12px 0;color:var(--dsw-alias-label-tertiary)}
.th3-shell-meta{margin-left:calc(-1 * var(--th3-shell-gutter));padding:6px 14px 8px var(--th3-shell-gutter);border-top:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.th3-shell-term[data-state=error] .th3-shell-status{color:var(--dsw-alias-state-error-primary)}
`

    /** Read the Host's outcome text back into its parts. */
    function parseOutcome(text) {
      const lines = String(text ?? '').split('\n')
      let i = 0
      const parsed = {}
      if (lines[i]?.startsWith('$ ')) i++
      if (lines[i]?.startsWith('cwd: ')) { parsed.cwd = lines[i].slice(5); i++ }
      if (/^… \d+ earlier characters omitted$/.test(lines[i] ?? '')) { parsed.omitted = true; i++ }
      if (/^`{3,}$/.test(lines[i] ?? '')) {
        const fence = lines[i]
        const end = lines.lastIndexOf(fence)
        if (end > i) { parsed.body = lines.slice(i + 1, end).join('\n'); i = end + 1 }
      } else if (lines[i] === '(no output)') {
        parsed.body = ''
        i++
      }
      parsed.status = lines.slice(i).join('\n').trim()
      if (parsed.body === undefined) return { raw: String(text ?? '') }
      return parsed
    }

    function shortPath(path) {
      if (!path) return ''
      const home = /^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(path)
      return home ? '~' + path.slice(home[1].length) : path
    }

    function UserBubble({ text, renderFactorySlot }) {
      if (typeof renderFactorySlot === 'function') {
        try {
          return renderFactorySlot('conversation.chat.user.content', {
            content: { text, attachments: [], extraBlocks: [] },
            facts: {},
            interactive: false,
          })
        } catch { /* fall back below */ }
      }
      return h('div', { className: 'th3-shell-fallback-bubble' }, text)
    }

    function ShellCommandView(props) {
      const node = props.node ?? {}
      const command = String(node.args ?? '').trim()
      const outcome = node.outcome ?? null
      const [copied, setCopied] = React.useState(false)
      const parsed = outcome && typeof outcome.text === 'string' ? parseOutcome(outcome.text) : undefined
      const exit = /^exit (\d+)/.exec(parsed?.status ?? '')
      const state = outcome === null
        ? 'running'
        : outcome.kind === 'error' || parsed?.raw !== undefined || (exit && exit[1] !== '0') ? 'error' : 'done'
      const body = parsed?.body ?? parsed?.raw
      const copy = () => {
        const text = body ?? ''
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }, () => {})
      }
      const hasBody = outcome !== null
      return h('div', { className: 'th3-shell', 'data-th3-shell': '' },
        h('style', null, CSS),
        h('div', { className: 'th3-shell-user' },
          h(UserBubble, { text: TRIGGER + command, renderFactorySlot: props.renderFactorySlot })),
        h('div', { className: 'th3-shell-term', 'data-state': state, 'data-body': hasBody ? '' : undefined },
          h('div', { className: 'th3-shell-head' },
            h('span', { className: 'th3-shell-dot', 'aria-hidden': true }),
            h('div', { className: 'th3-shell-prompt' },
              parsed?.cwd ? h('span', { className: 'th3-shell-cwd' }, shortPath(parsed.cwd)) : null,
              h('span', { className: 'th3-shell-cwd' }, '$'),
              h('span', { className: 'th3-shell-cmd' }, command)),
            body ? h('button', { type: 'button', className: 'th3-shell-copy', onClick: copy }, copied ? t('copied') : t('copy')) : null),
          outcome === null
            ? h('div', { className: 'th3-shell-empty' }, t('running'))
            : h(React.Fragment, null,
                parsed?.omitted ? h('div', { className: 'th3-shell-note' }, t('omitted')) : null,
                body ? h('div', { className: 'th3-shell-out' }, body) : h('div', { className: 'th3-shell-empty' }, t('noOutput')),
                parsed?.status ? h('div', { className: 'th3-shell-meta' }, h('span', { className: 'th3-shell-status' }, parsed.status)) : null)))
    }

    return {
      inject: ['inputTriggers', 'locale', 'slots'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, titles), 'th3-shell: titles')
          const bound = ctx.locale.bind(NS)
          t = key => {
            const text = bound(key)
            return typeof text === 'string' && text !== key ? text : titles.en[key] ?? key
          }
        } catch (error) {
          console.error('[th3-shell] locale registration failed; using English titles', error)
        }
        // Draw `/sh` (and therefore `!`) results as a message + reply pair.
        try {
          ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
            name: 'conversation.chat.commandview',
            key: COMMAND_NAME,
          }, ShellCommandView))
        } catch (error) {
          console.error('[th3-shell] result view registration failed', error)
        }

        ctx.effect(() => ctx.inputTriggers.registerSource(historySource), 'th3-shell: history source')
        ctx.effect(() => ctx.inputTriggers.registerSource(completionSource), 'th3-shell: completion source')

        // Controllers are created per Session by `sessionOf`, which the
        // composer calls on every edit: patch the controller prototype the
        // first time one passes through.
        ctx.effect(() => {
          const service = ctx.inputTriggers
          const home = owner(service, 'sessionOf')
          if (home === undefined) {
            console.error('[th3-shell] inputTriggers.sessionOf not found; ! suggestions disabled')
            return () => {}
          }
          const sessionOf = home.sessionOf
          let restoreController
          home.sessionOf = function (actx) {
            const controller = sessionOf.call(this, actx)
            if (restoreController === undefined && controller) {
              const proto = owner(controller, 'track')
              if (proto) restoreController = patchController(proto)
            }
            return controller
          }
          return () => {
            home.sessionOf = sessionOf
            restoreController?.()
          }
        }, 'th3-shell: ! trigger')
      },
    }
  },
})
