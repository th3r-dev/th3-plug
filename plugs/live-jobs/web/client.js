/**
 * @th3-plug/live-jobs — Web half.
 *
 * The process view lives **in the conversation**, under the turn that started
 * it: the card below shows the exact command a background job runs, the output
 * as the job produces it, the exit status when it settles, and a stop control.
 *
 * Where the card comes from:
 *
 *  - `conversation.chat.turnTail` is the additive seat under a completed turn,
 *    before its action row. It receives `{ turn, seq, openFile }`.
 *  - The turn's tool calls are read from the Chat snapshot (`useChat`): every
 *    `tool-call` node of that turn whose settled result acknowledged a
 *    background job contributes the job id it printed.
 *  - `ctx.jobs` then supplies the roster row (`label` is the exact command for
 *    `bash`) and the non-consuming live output (`observe`), and `kill` stops it
 *    on the human's behalf. Nothing here touches the model's read cursor.
 *
 * Only background jobs produce output the page can watch while they run; a
 * foreground call already streams its own conversation card when it settles.
 */
window.__ModuleLoader__.load({
  id: '@th3-plug/live-jobs',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'th3-live-jobs'
    const CONFIG_PATH = '/api/th3-live-jobs/config'

    /** Where the card may live; mirrored by the Host config. */
    const POSITIONS = new Set(['conversation', 'extrabar'])

    /** Mirrors the Host defaults; used until the route answers and when it does not. */
    const FALLBACK = {
      position: 'conversation',
      previewLines: 8,
      maxOutputLines: 500,
      stopConfirmMs: 3000,
    }

    const LIMITS = {
      previewLines: [1, 100],
      maxOutputLines: [10, 5000],
      stopConfirmMs: [500, 10000],
    }

    /** Job kinds whose label is a shell command line, so it gets a prompt and mono type. */
    const SHELL_KINDS = new Set(['bash', 'pwsh', 'sh', 'zsh', 'shell', 'terminal'])
    const EMPTY = Object.freeze([])
    /** How long the composer-bar placement keeps a finished job on screen. */
    const KEEP_SETTLED_MS = 60_000
    /** A job id printed by the shell tool, e.g. `bash-0123456789abcdef`. */
    const JOB_ID = /\b(?:bash|pwsh)-[0-9a-f]{16}\b/g
    /** The shell tool's acknowledgement that a process became a background job. */
    const BACKGROUND_ACK = /started background job|moved to background job/

    // ------------------------------------------------------------- copy (en/th/zh)

    const titles = {
      en: {
        'section.label': 'Background process',
        'title.one': 'Background process',
        'title.many': '{count} background processes',
        'status.running': 'running',
        'status.stopping': 'stopping',
        'status.completed': 'completed',
        'status.killed': 'stopped',
        'status.failed': 'failed',
        'output.label': 'Live output',
        'output.empty': 'No output yet.',
        'output.gap': 'Earlier output is no longer retained.',
        'output.error': 'Live output stopped: {error}',
        'output.hidden': '{count} earlier lines hidden — show all',
        'output.truncated': '{count} older lines are outside this view',
        'output.lines': '{count} lines',
        'output.oneLine': '1 line',
        'output.noLines': 'no output',
        'duration.seconds': '{seconds}s',
        'duration.minutes': '{minutes}m {seconds}s',
        'duration.hours': '{hours}h {minutes}m',
        'action.stop': 'Stop',
        'action.stopConfirm': 'Stop?',
        'action.stopLabel': 'Stop this background process',
        'action.stopConfirmLabel': 'Press again to stop this background process',
        'action.copy': 'Copy command',
        'action.copied': 'Copied',
        'action.more': 'Show all',
        'action.less': 'Show less',
        'action.collapse': 'Collapse this background process',
        'action.expand': 'Expand this background process',
      },
      th: {
        'section.label': 'งานเบื้องหลัง',
        'title.one': 'งานเบื้องหลัง',
        'title.many': 'งานเบื้องหลัง {count} งาน',
        'status.running': 'กำลังทำงาน',
        'status.stopping': 'กำลังหยุด',
        'status.completed': 'เสร็จแล้ว',
        'status.killed': 'ถูกหยุด',
        'status.failed': 'ล้มเหลว',
        'output.label': 'เอาต์พุตสด',
        'output.empty': 'ยังไม่มีเอาต์พุต',
        'output.gap': 'เอาต์พุตช่วงต้นถูกตัดออกแล้ว',
        'output.error': 'ดูเอาต์พุตสดไม่ได้: {error}',
        'output.hidden': 'ซ่อนไว้ {count} บรรทัด — ดูทั้งหมด',
        'output.truncated': 'มีอีก {count} บรรทัดที่อยู่นอกมุมมองนี้',
        'output.lines': '{count} บรรทัด',
        'output.oneLine': '1 บรรทัด',
        'output.noLines': 'ไม่มีเอาต์พุต',
        'duration.seconds': '{seconds} วิ',
        'duration.minutes': '{minutes} น. {seconds} วิ',
        'duration.hours': '{hours} ชม. {minutes} น.',
        'action.stop': 'หยุด',
        'action.stopConfirm': 'หยุด?',
        'action.stopLabel': 'หยุดงานเบื้องหลังนี้',
        'action.stopConfirmLabel': 'กดอีกครั้งเพื่อหยุดงานเบื้องหลังนี้',
        'action.copy': 'คัดลอกคำสั่ง',
        'action.copied': 'คัดลอกแล้ว',
        'action.more': 'ดูทั้งหมด',
        'action.less': 'ย่อ',
        'action.collapse': 'ย่อการ์ดงานเบื้องหลังนี้',
        'action.expand': 'ขยายการ์ดงานเบื้องหลังนี้',
      },
      zh: {
        'section.label': '后台进程',
        'title.one': '后台进程',
        'title.many': '{count} 个后台进程',
        'status.running': '运行中',
        'status.stopping': '停止中',
        'status.completed': '已完成',
        'status.killed': '已停止',
        'status.failed': '失败',
        'output.label': '实时输出',
        'output.empty': '暂无输出。',
        'output.gap': '更早的输出已不再保留。',
        'output.error': '实时输出已中断：{error}',
        'output.hidden': '隐藏了 {count} 行 — 显示全部',
        'output.truncated': '另有 {count} 行不在此视图中',
        'output.lines': '{count} 行',
        'output.oneLine': '1 行',
        'output.noLines': '无输出',
        'duration.seconds': '{seconds}秒',
        'duration.minutes': '{minutes}分 {seconds}秒',
        'duration.hours': '{hours}时 {minutes}分',
        'action.stop': '停止',
        'action.stopConfirm': '确认停止?',
        'action.stopLabel': '停止这个后台进程',
        'action.stopConfirmLabel': '再次按下以停止这个后台进程',
        'action.copy': '复制命令',
        'action.copied': '已复制',
        'action.more': '显示全部',
        'action.less': '收起',
        'action.collapse': '收起这个后台进程卡片',
        'action.expand': '展开这个后台进程卡片',
      },
    }

    // ---------------------------------------------------------------------- CSS

    const CSS = `
.th3-live-jobs{box-sizing:border-box;width:100%;margin:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:calc(12px + var(--dsh-content-font-delta,0px));line-height:1.5;overflow:hidden}.th3-live-jobs[data-variant=dock]{flex:none;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));max-width:calc(var(--dsh-composer-card-max-width,760px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));margin:0 auto;border:0;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-panel,none);backdrop-filter:var(--dsw-menu-backdrop-filter,none)}
.th3-live-jobs-head{display:flex;align-items:center;gap:8px;min-height:32px;padding:4px 6px 4px 11px}
.th3-live-jobs-pulse{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.th3-live-jobs-pulse[data-state=live]{background:var(--dsw-alias-brand-primary);animation:th3-live-jobs-pulse 1.6s ease-in-out infinite}
@keyframes th3-live-jobs-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.78)}}
@media (prefers-reduced-motion:reduce){.th3-live-jobs-pulse{animation:none!important}}
.th3-live-jobs-title{min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.th3-live-jobs-spacer{flex:1;min-width:0}
.th3-live-jobs-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
@media (hover:hover){.th3-live-jobs-icon:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}}
.th3-live-jobs-icon:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.th3-live-jobs-icon[data-open=true] svg{transform:rotate(180deg)}
.th3-live-jobs-body{display:flex;flex-direction:column;max-height:46vh;overflow:auto;padding:0 11px 9px}
.th3-live-jobs-row{display:flex;flex-direction:column;gap:5px;padding:7px 0;min-width:0}
.th3-live-jobs-row + .th3-live-jobs-row{border-top:.5px solid var(--dsw-alias-border-l1)}
.th3-live-jobs-row[data-live=true]{box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary);padding-left:8px;margin-left:-8px}
.th3-live-jobs-rowhead{display:flex;align-items:center;gap:6px;min-width:0}
.th3-live-jobs-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.th3-live-jobs-dot[data-state=ongoing]{background:var(--dsw-alias-brand-primary);animation:th3-live-jobs-pulse 1.6s ease-in-out infinite}
.th3-live-jobs-dot[data-state=done]{background:var(--dsw-alias-state-success-primary)}
.th3-live-jobs-dot[data-state=warning]{background:var(--dsw-alias-state-warn-primary)}
.th3-live-jobs-dot[data-state=error]{background:var(--dsw-alias-state-error-primary)}
.th3-live-jobs-kind{flex:none;padding:0 5px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:calc(10px + var(--dsh-content-font-delta,0px));line-height:16px}
.th3-live-jobs-state{flex:none;color:var(--dsw-alias-label-secondary);font-size:calc(11px + var(--dsh-content-font-delta,0px))}
.th3-live-jobs-state[data-state=error]{color:var(--dsw-alias-state-error-primary)}
.th3-live-jobs-state[data-state=warning]{color:var(--dsw-alias-state-warn-primary)}
.th3-live-jobs-time{flex:none;color:var(--dsw-alias-label-secondary);font-size:calc(11px + var(--dsh-content-font-delta,0px));font-variant-numeric:tabular-nums}
.th3-live-jobs-stop{display:inline-flex;flex:none;align-items:center;gap:4px;height:20px;padding:0 5px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:calc(10px + var(--dsh-content-font-delta,0px));line-height:1;cursor:pointer}
@media (hover:hover){.th3-live-jobs-stop:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}}
.th3-live-jobs-stop[data-kill-state=armed],.th3-live-jobs-stop[data-kill-state=failed]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.th3-live-jobs-stop:disabled{opacity:.5;cursor:default}
.th3-live-jobs-stop:focus-visible{outline:2px solid var(--dsw-alias-state-error-primary);outline-offset:1px}
.th3-live-jobs-command,.th3-live-jobs-output{box-sizing:border-box;margin:0;padding:5px 7px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l1);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:calc(11px + var(--dsh-content-font-delta,0px));line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;tab-size:2}
.th3-live-jobs-command{max-height:112px;color:var(--dsw-alias-label-primary)}
.th3-live-jobs-command[data-shell=false]{font-family:inherit;font-size:calc(11.5px + var(--dsh-content-font-delta,0px))}
.th3-live-jobs-prompt{color:var(--dsw-alias-label-secondary);user-select:none}
.th3-live-jobs-output{max-height:132px;min-height:22px;color:var(--dsw-alias-label-primary)}
.th3-live-jobs-output[data-empty=true]{color:var(--dsw-alias-label-secondary);font-family:inherit;font-style:italic}
.th3-live-jobs-notice{color:var(--dsw-alias-label-secondary);font-size:calc(10.5px + var(--dsh-content-font-delta,0px));line-height:1.4}
.th3-live-jobs-notice[data-kind=error]{color:var(--dsw-alias-state-error-primary)}
.th3-live-jobs-link{display:inline-flex;align-items:center;gap:3px;padding:0 2px;border:0;border-radius:var(--dsw-radius-xs,4px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:calc(10.5px + var(--dsh-content-font-delta,0px));line-height:1.5;cursor:pointer}
@media (hover:hover){.th3-live-jobs-link:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}}
.th3-live-jobs-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.th3-live-jobs-foot{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;min-width:0}
.th3-live-jobs-meta{min-width:0;color:var(--dsw-alias-label-secondary);font-size:calc(10.5px + var(--dsh-content-font-delta,0px));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.th3-live-jobs-more-lines{align-self:flex-start}
`

    const STYLE_KEY = 'th3-live-jobs'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-${STYLE_KEY}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset[STYLE_KEY] = ''
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------------------ helpers

    function configNumber(value, key) {
      const [min, max] = LIMITS[key]
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return FALLBACK[key]
      return Math.min(max, Math.max(min, Math.round(parsed)))
    }

    function normalizeConfig(value) {
      if (value === null || typeof value !== 'object') return FALLBACK
      const next = { position: POSITIONS.has(value.position) ? value.position : FALLBACK.position }
      for (const key of Object.keys(LIMITS)) next[key] = configNumber(value[key], key)
      return next
    }

    /** One shared request for the Host's numbers; a failure keeps the fallbacks. */
    let configPromise
    function loadConfig() {
      if (configPromise === undefined) {
        configPromise = (async () => {
          try {
            const response = await fetch(CONFIG_PATH, {
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            })
            if (!response.ok) return FALLBACK
            return normalizeConfig(await response.json())
          } catch {
            return FALLBACK
          }
        })()
      }
      return configPromise
    }

    function useConfig() {
      const [value, setValue] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        loadConfig().then((next) => { if (alive) setValue(next) })
        return () => { alive = false }
      }, [])
      return value
    }

    function isLive(job) {
      return job.status === 'running' || job.status === 'stopping'
    }

    function dotState(status) {
      switch (status) {
        case 'running': return 'ongoing'
        case 'stopping': return 'warning'
        case 'completed': return 'done'
        case 'killed': return 'warning'
        case 'failed': return 'error'
        default: return 'idle'
      }
    }

    /** Elapsed time in at most two adjacent units, localized. */
    function formatDuration(elapsedMs, t) {
      const total = Math.max(0, Math.floor(elapsedMs / 1000))
      const seconds = total % 60
      const minutes = Math.floor(total / 60) % 60
      const hours = Math.floor(total / 3600)
      if (hours > 0) return t('duration.hours', { hours, minutes })
      if (minutes > 0) return t('duration.minutes', { minutes, seconds })
      return t('duration.seconds', { seconds })
    }

    function settledAt(job) {
      return job.finishedAt ?? job.startedAt
    }

    function findJob(rows, id) {
      if (!Array.isArray(rows)) return undefined
      return rows.find(job => job.id === id)
    }

    function contentText(content) {
      if (!Array.isArray(content)) return ''
      let text = ''
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') text += `${block.text}\n`
      }
      return text
    }

    /**
     * The background job ids one completed turn started, read from that turn's
     * settled `tool-call` nodes: only a shell call whose result acknowledged a
     * background job contributes, so a `job_output` card that merely mentions
     * an id never duplicates the process card.
     */
    function jobIdsOfTurn(locations, nodes, turnNumber) {
      if (turnNumber === undefined || locations === undefined || nodes === undefined) return EMPTY
      let keys
      try {
        keys = locations.getTurn?.(turnNumber)
      } catch {
        return EMPTY
      }
      if (!Array.isArray(keys) || keys.length === 0) return EMPTY
      const ids = new Set()
      for (const key of keys) {
        let node
        try {
          node = nodes.get?.(key)
        } catch {
          continue
        }
        if (node === null || node === undefined || node.kind !== 'tool-call') continue
        const root = node.data?.root
        if (root === null || root === undefined) continue
        if (root.name !== 'bash' && root.name !== 'pwsh') continue
        const text = contentText(root.content)
        if (!BACKGROUND_ACK.test(text)) continue
        for (const match of text.matchAll(JOB_ID)) ids.add(match[0])
      }
      return ids.size === 0 ? EMPTY : [...ids]
    }

    function icon(name) {
      const common = {
        width: 12,
        height: 12,
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        focusable: 'false',
      }
      switch (name) {
        case 'chevron':
          return h('svg', { ...common, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
            h('path', { d: 'M4 6.2 8 10.2 12 6.2' }))
        case 'copy':
          return h('svg', { ...common, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' },
            h('rect', { x: 5.4, y: 5.4, width: 8.2, height: 8.2, rx: 1.6 }),
            h('path', { d: 'M10.6 5.4V3.8c0-.7-.6-1.3-1.3-1.3H3.8c-.7 0-1.3.6-1.3 1.3v5.5c0 .7.6 1.3 1.3 1.3h1.6' }))
        case 'stop':
          return h('svg', { ...common, fill: 'currentColor' }, h('rect', { x: 4.4, y: 4.4, width: 7.2, height: 7.2, rx: 1.2 }))
        default:
          return null
      }
    }

    // ---------------------------------------------------------------- components

    /** One ticking clock while anything in the card still runs. */
    function useClock(active) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        if (!active) return undefined
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [active])
      return now
    }

    /** The composer-bar clock: tick while a job runs, then one timer so finished rows can age out. */
    function useDockClock(jobs) {
      const [now, setNow] = React.useState(() => Date.now())
      const anyLive = jobs.some(isLive)

      React.useEffect(() => {
        if (!anyLive) return undefined
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [anyLive])

      React.useEffect(() => {
        if (anyLive || jobs.length === 0) return undefined
        const waits = jobs
          .map(job => settledAt(job) + KEEP_SETTLED_MS - Date.now())
          .filter(ms => ms > 0)
        if (waits.length === 0) return undefined
        const timer = setTimeout(() => setNow(Date.now()), Math.min(...waits) + 50)
        return () => clearTimeout(timer)
      }, [jobs, anyLive, now])

      return now
    }

    /** Live jobs first in start order, then finished ones newest first. */
    function compareJobs(left, right) {
      const liveLeft = isLive(left)
      const liveRight = isLive(right)
      if (liveLeft !== liveRight) return liveLeft ? -1 : 1
      if (liveLeft) return left.startedAt - right.startedAt
      return settledAt(right) - settledAt(left)
    }

    /** The shell both placements draw: header with state and a body of job cards. */
    function ProcessPanel({ title, anyLive, open, onToggle, variant, t, children }) {
      return h('section', {
        className: 'th3-live-jobs',
        'data-variant': variant,
        'data-state': anyLive ? 'live' : 'settled',
        'aria-label': t('section.label'),
      },
        h('header', { className: 'th3-live-jobs-head' },
          h('span', { className: 'th3-live-jobs-pulse', 'data-state': anyLive ? 'live' : 'idle', 'aria-hidden': 'true' }),
          h('span', { className: 'th3-live-jobs-title', title }, title),
          h('span', { className: 'th3-live-jobs-spacer' }),
          h('button', {
            type: 'button',
            className: 'th3-live-jobs-icon',
            'data-open': open ? 'true' : 'false',
            'aria-expanded': open,
            'aria-label': open ? t('action.collapse') : t('action.expand'),
            title: open ? t('action.collapse') : t('action.expand'),
            onClick: onToggle,
          }, icon('chevron')),
        ),
        open ? h('div', { className: 'th3-live-jobs-body' }, children) : null,
      )
    }

    /** Cards for one set of jobs, with their live output. */
    function ProcessList({ jobs, observed, sessionId, observe, killJob, config, now, t }) {
      return jobs.map(job => h(JobCard, {
        key: String(job.id),
        job,
        view: observed?.[String(job.id)],
        sessionId,
        observe,
        killJob,
        config,
        now,
        t,
      }))
    }

    /**
     * The in-conversation placement: a card under the turn that started the
     * process. It renders nothing for a turn that started none, and nothing at
     * all when the profile put the card in the composer bar instead.
     */
    function TurnProcesses(props) {
      const { turn, sessionId, useChat, useJobs, observe, killJob, t } = props
      const fetched = useConfig()
      const config = props.config ?? fetched
      const [open, setOpen] = React.useState(true)
      const locations = useChat((state) => state.locations)
      const nodes = useChat((state) => state.nodes)
      const roster = useJobs((state) => state.rows[sessionId])
      const observed = useJobs((state) => state.observed)

      const turnNumber = turn !== null && typeof turn === 'object' ? turn.turn : turn
      const placed = config === null || config.position === 'conversation'
      const ids = placed ? jobIdsOfTurn(locations, nodes, turnNumber) : EMPTY
      const jobs = ids.map(id => findJob(roster, id)).filter(Boolean)
      const anyLive = jobs.some(isLive)
      const now = useClock(anyLive)

      if (config === null || config.position !== 'conversation' || jobs.length === 0) return null

      const title = jobs.length === 1 ? t('title.one') : t('title.many', { count: jobs.length })

      return h(ProcessPanel, {
        title,
        anyLive,
        open,
        onToggle: () => setOpen(!open),
        variant: 'conversation',
        t,
      }, h(ProcessList, { jobs, observed, sessionId, observe, killJob, config, now, t }))
    }

    /**
     * The composer-bar placement: one strip above the composer with the
     * session's live processes and any that finished moments ago.
     */
    function DockStrip(props) {
      const { sessionId, useJobs, watchRows, observe, killJob, t } = props
      const fetched = useConfig()
      const config = props.config ?? fetched
      const [open, setOpen] = React.useState(true)

      React.useEffect(() => {
        if (config === null || config.position !== 'extrabar' || watchRows === undefined) return undefined
        return watchRows(sessionId)
      }, [config, sessionId, watchRows])

      const roster = useJobs((state) => state.rows[sessionId])
      const observed = useJobs((state) => state.observed)
      const all = Array.isArray(roster) ? roster : EMPTY
      const placed = config !== null && config.position === 'extrabar'
      const now = useDockClock(placed ? all : EMPTY)
      const visible = placed
        ? all.filter(job => isLive(job) || now - settledAt(job) < KEEP_SETTLED_MS).sort(compareJobs)
        : EMPTY
      const anyLive = visible.some(isLive)

      if (!placed || visible.length === 0) return null

      const title = visible.length === 1 ? t('title.one') : t('title.many', { count: visible.length })

      return h(ProcessPanel, {
        title,
        anyLive,
        open,
        onToggle: () => setOpen(!open),
        variant: 'dock',
        t,
      }, h(ProcessList, { jobs: visible, observed, sessionId, observe, killJob, config, now, t }))
    }

    /** One job: the exact command, its live output, and the stop control. */
    function JobCard(props) {
      const { job, view, sessionId, observe, killJob, config, now, t } = props
      const [expanded, setExpanded] = React.useState(false)
      const [kill, setKill] = React.useState('idle')
      const [copied, setCopied] = React.useState(false)
      const outputRef = React.useRef(null)
      const pinnedRef = React.useRef(true)

      React.useEffect(() => {
        if (observe === undefined) return undefined
        return observe(sessionId, job.id)
      }, [sessionId, job.id, observe])

      React.useEffect(() => {
        if (kill !== 'armed') return undefined
        const timer = setTimeout(() => setKill('idle'), config.stopConfirmMs)
        return () => clearTimeout(timer)
      }, [kill, config.stopConfirmMs])

      React.useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(false), 1200)
        return () => clearTimeout(timer)
      }, [copied])

      const text = view?.text ?? ''
      React.useEffect(() => {
        const element = outputRef.current
        if (element !== null && pinnedRef.current) element.scrollTop = element.scrollHeight
      }, [text, expanded])

      const live = isLive(job)
      const state = dotState(job.status)
      const status = t(`status.${job.status}`)
      const detail = job.progress ?? job.detail
      const elapsed = formatDuration(live ? now - job.startedAt : settledAt(job) - job.startedAt, t)
      const shell = SHELL_KINDS.has(job.kind)
      const whole = text.endsWith('\n') ? text.slice(0, -1) : text
      const allLines = whole === '' ? [] : whole.split('\n')
      const limit = expanded ? Math.max(config.maxOutputLines, config.previewLines) : config.previewLines
      const lines = allLines.length > limit ? allLines.slice(allLines.length - limit) : allLines
      const older = allLines.length - lines.length
      const total = allLines.length === 0 ? t('output.noLines') : allLines.length === 1 ? t('output.oneLine') : t('output.lines', { count: allLines.length })

      async function stop() {
        if (kill === 'pending') return
        if (kill !== 'armed') {
          setKill('armed')
          return
        }
        setKill('pending')
        let ok = false
        try {
          ok = await killJob(sessionId, job.id)
        } catch {
          ok = false
        }
        setKill(ok ? 'idle' : 'failed')
      }

      async function copy() {
        try {
          await globalThis.navigator?.clipboard?.writeText?.(job.label)
        } catch {
          /* A denied clipboard keeps the command selectable; the label still flips. */
        }
        setCopied(true)
      }

      return h('article', { className: 'th3-live-jobs-row', 'data-live': live ? 'true' : 'false', 'data-job': job.id },
        h('div', { className: 'th3-live-jobs-rowhead' },
          h('span', { className: 'th3-live-jobs-dot', 'data-state': state, 'aria-hidden': 'true' }),
          h('span', { className: 'th3-live-jobs-kind' }, job.kind),
          h('span', { className: 'th3-live-jobs-state', 'data-state': state }, status),
          h('span', { className: 'th3-live-jobs-time', title: elapsed }, elapsed),
          h('span', { className: 'th3-live-jobs-spacer' }),
          live ? h('button', {
            type: 'button',
            className: 'th3-live-jobs-stop',
            'data-kill-state': kill,
            disabled: kill === 'pending',
            'aria-label': t(kill === 'armed' ? 'action.stopConfirmLabel' : 'action.stopLabel'),
            title: t(kill === 'armed' ? 'action.stopConfirmLabel' : 'action.stopLabel'),
            onClick: stop,
          }, icon('stop'), kill === 'armed' ? h('span', null, t('action.stopConfirm')) : null) : null,
        ),
        h('pre', {
          className: 'th3-live-jobs-command',
          'data-shell': shell ? 'true' : 'false',
          title: job.label,
          tabIndex: 0,
        }, shell ? h('span', { className: 'th3-live-jobs-prompt', 'aria-hidden': 'true' }, '$ ') : null, job.label),
        view?.gapBefore === true ? h('div', { className: 'th3-live-jobs-notice' }, t('output.gap')) : null,
        view?.error !== undefined ? h('div', { className: 'th3-live-jobs-notice', 'data-kind': 'error' }, t('output.error', { error: view.error })) : null,
        older > 0 && !expanded ? h('button', {
          type: 'button',
          className: 'th3-live-jobs-link th3-live-jobs-more-lines',
          onClick: () => setExpanded(true),
        }, t('output.hidden', { count: older })) : null,
        older > 0 && expanded ? h('div', { className: 'th3-live-jobs-notice' }, t('output.truncated', { count: older })) : null,
        h('pre', {
          className: 'th3-live-jobs-output',
          'data-empty': allLines.length === 0 ? 'true' : 'false',
          'aria-label': t('output.label'),
          ref: outputRef,
          onScroll: (event) => {
            const element = event.currentTarget
            pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
          },
        }, allLines.length === 0 ? t('output.empty') : lines.join('\n')),
        h('div', { className: 'th3-live-jobs-foot' },
          detail !== undefined && detail !== '' ? h('span', { className: 'th3-live-jobs-meta', title: detail }, detail) : null,
          h('span', { className: 'th3-live-jobs-spacer' }),
          h('span', { className: 'th3-live-jobs-meta' }, total),
          h('button', {
            type: 'button',
            className: 'th3-live-jobs-link',
            'aria-label': t(copied ? 'action.copied' : 'action.copy'),
            title: t(copied ? 'action.copied' : 'action.copy'),
            onClick: copy,
          }, icon('copy'), h('span', null, t(copied ? 'action.copied' : 'action.copy'))),
          allLines.length > config.previewLines || expanded ? h('button', {
            type: 'button',
            className: 'th3-live-jobs-link',
            'aria-expanded': expanded,
            onClick: () => setExpanded(!expanded),
          }, t(expanded ? 'action.less' : 'action.more')) : null,
        ),
      )
    }

    // ----------------------------------------------------------------- plugin body

    return {
      inject: ['jobs', 'slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, titles), 'th3-live-jobs: dictionaries')

        const shared = () => ({
          hooks: { jobs: ctx.jobs.state },
          observe: (sessionId, jobId) => ctx.jobs.observe(sessionId, jobId),
          killJob: async (sessionId, jobId) => (await ctx.jobs.kill(sessionId, jobId)).ok,
        })

        // Both seats are registered; each reads `config.position` and renders
        // only for its own placement, so a profile config change needs only a
        // page reload (the route decides which card appears).
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'live-jobs',
          order: 10,
          locale: NS,
          inject: shared,
        }, TurnProcesses))

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'live-jobs',
          order: 30,
          locale: NS,
          inject: () => ({
            ...shared(),
            watchRows: (sessionId) => ctx.jobs.watchRows(sessionId),
          }),
        }, DockStrip))
      },
    }
  },
})
