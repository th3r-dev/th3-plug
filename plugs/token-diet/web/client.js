/**
 * Web half of the th3-plug token-diet plug: draw the `/cost` report as a
 * compact stat card in the conversation instead of a plain text block.
 *
 * The Host half owns the numbers; this half only presents them, parsing the
 * stable report lines and falling back to the raw text when the format ever
 * changes. Everything unloads with the plug: registrations go through
 * `ctx.slots.inject` / `ctx.effect`, and CSS is scoped under the
 * `th3-token-diet` prefix with theme tokens only.
 */

/** Parse the Host's stable report lines; undefined fields mean "not in the text". */
export function parseReport(text) {
  if (typeof text !== 'string') return undefined
  const num = pattern => {
    const hit = pattern.exec(text)
    return hit ? Number(hit[1].replace(/,/g, '')) : undefined
  }
  const seen = num(/^\s+tool results seen: ([\d,]+)$/m)
  const trimmedMatch = /^\s+trimmed: ([\d,]+)(?: \((\d+)%\))?$/m.exec(text)
  const charsMatch = /^\s+tool-result chars: ([\d,]+) → ([\d,]+) — saved ([\d,]+)(?: \((\d+)%\))?$/m.exec(text)
  const tokens = num(/^\s+est\. tokens saved: ([\d,]+)/m)
  const configMatch = /^\s+config: max ([\d,]+) chars \(head ([\d,]+) \/ tail ([\d,]+)\)$/m.exec(text)
  const noteMatch = /^\s+note: (.+)$/m.exec(text)
  if (seen === undefined && trimmedMatch === null && charsMatch === null) return undefined
  return {
    seen,
    trimmed: trimmedMatch ? Number(trimmedMatch[1].replace(/,/g, '')) : undefined,
    trimmedPct: trimmedMatch?.[2] !== undefined ? Number(trimmedMatch[2]) : undefined,
    charsOriginal: charsMatch ? Number(charsMatch[1].replace(/,/g, '')) : undefined,
    charsSent: charsMatch ? Number(charsMatch[2].replace(/,/g, '')) : undefined,
    charsSaved: charsMatch ? Number(charsMatch[3].replace(/,/g, '')) : undefined,
    savedPct: charsMatch?.[4] !== undefined ? Number(charsMatch[4]) : undefined,
    tokens,
    config: configMatch ? { max: configMatch[1], head: configMatch[2], tail: configMatch[3] } : undefined,
    note: noteMatch ? noteMatch[1] : undefined,
  }
}

window.__ModuleLoader__.load({
  id: '@th3-plug/token-diet',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const COMMAND_NAME = 'cost'
    const NS = 'th3-token-diet'

    const titles = {
      en: {
        title: 'Token Diet',
        seen: 'Results seen',
        trimmed: 'Trimmed',
        saved: 'Tool-result chars saved',
        tokens: 'Est. tokens saved',
        config: 'Config',
        copy: 'Copy',
        copied: 'Copied',
        raw: 'Report',
      },
      th: {
        title: 'โทเคนไดเอท',
        seen: 'ผลลัพธ์ที่เห็น',
        trimmed: 'ตัดแล้ว',
        saved: 'ตัวอักษรที่ประหยัดได้',
        tokens: 'โทเคนที่ประหยัดได้ (ประมาณ)',
        config: 'ค่าตั้ง',
        copy: 'คัดลอก',
        copied: 'คัดลอกแล้ว',
        raw: 'รายงาน',
      },
    }

    const CSS = `
.th3-token-diet{display:flex;flex-direction:column;gap:10px;max-width:420px;width:100%;margin:4px 0;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2)}
.th3-token-diet-head{display:flex;align-items:center;gap:8px}
.th3-token-diet-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.th3-token-diet[data-state=running] .th3-token-diet-dot{background:var(--dsw-alias-label-tertiary);animation:th3-token-diet-pulse 1s ease-in-out infinite}
.th3-token-diet[data-state=running] .th3-token-diet-body{color:var(--dsw-alias-label-tertiary)}
@keyframes th3-token-diet-pulse{50%{opacity:.3}}
.th3-token-diet-title{flex:1;font-weight:600;color:var(--dsw-alias-label-primary)}
.th3-token-diet-copy{flex:none;font:inherit;font-size:12px;padding:2px 8px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.th3-token-diet-copy:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}
.th3-token-diet-body{display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-primary)}
.th3-token-diet-row{display:flex;align-items:baseline;gap:8px}
.th3-token-diet-label{flex:1;color:var(--dsw-alias-label-secondary);font-size:12px}
.th3-token-diet-value{flex:none;font-variant-numeric:tabular-nums}
.th3-token-diet-sub{color:var(--dsw-alias-label-tertiary);font-size:12px}
.th3-token-diet-bar{position:relative;height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-1));overflow:hidden}
.th3-token-diet-bar>span{position:absolute;inset:0;right:auto;border-radius:2px;background:var(--dsw-alias-state-success-primary)}
.th3-token-diet-config{color:var(--dsw-alias-label-tertiary);font-size:12px}
.th3-token-diet-note{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.th3-token-diet-raw{margin:0;font:var(--dsw-font-markdown-code-block,13px/20px ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}
`

    function Stat({ label, value, sub, bar }) {
      return h('div', { className: 'th3-token-diet-row-wrap' },
        h('div', { className: 'th3-token-diet-row' },
          h('span', { className: 'th3-token-diet-label' }, label),
          h('span', { className: 'th3-token-diet-value' }, value),
          sub !== undefined ? h('span', { className: 'th3-token-diet-sub' }, sub) : null),
        bar !== undefined ? h('div', { className: 'th3-token-diet-bar' }, h('span', { style: { width: `${bar}%` } })) : null)
    }

    function CostView(props) {
      const node = props.node ?? {}
      const outcome = node.outcome ?? null
      const parsed = outcome && typeof outcome.text === 'string' ? parseReport(outcome.text) : undefined
      const [copied, setCopied] = React.useState(false)
      const copy = () => {
        navigator.clipboard?.writeText(outcome?.text ?? '').then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }, () => {})
      }
      const state = outcome === null ? 'running' : 'done'
      const fmt = value => (typeof value === 'number' ? value.toLocaleString('en-US') : '—')
      return h('div', { className: 'th3-token-diet', 'data-state': state },
        h('style', null, CSS),
        h('div', { className: 'th3-token-diet-head' },
          h('span', { className: 'th3-token-diet-dot' }),
          h('span', { className: 'th3-token-diet-title' }, t('title')),
          h('button', { className: 'th3-token-diet-copy', onClick: copy, disabled: outcome === null }, copied ? t('copied') : t('copy'))),
        h('div', { className: 'th3-token-diet-body' },
          parsed === undefined
            ? [h('div', { key: 'raw-label', className: 'th3-token-diet-config' }, t('raw')), h('pre', { key: 'raw', className: 'th3-token-diet-raw' }, outcome?.text ?? '')]
            : [
                h(Stat, { key: 'seen', label: t('seen'), value: fmt(parsed.seen) }),
                h(Stat, { key: 'trimmed', label: t('trimmed'), value: fmt(parsed.trimmed), sub: parsed.trimmedPct !== undefined ? `${parsed.trimmedPct}%` : undefined }),
                h(Stat, {
                  key: 'chars',
                  label: t('saved'),
                  value: fmt(parsed.charsSaved),
                  sub: parsed.savedPct !== undefined ? `${parsed.savedPct}%` : undefined,
                  bar: parsed.savedPct,
                }),
                h(Stat, { key: 'tokens', label: t('tokens'), value: fmt(parsed.tokens) }),
                parsed.config !== undefined
                  ? h('div', { key: 'config', className: 'th3-token-diet-config' },
                    `${t('config')}: max ${parsed.config.max} · head ${parsed.config.head} · tail ${parsed.config.tail}`)
                  : null,
                parsed.note !== undefined ? h('div', { key: 'note', className: 'th3-token-diet-note' }, parsed.note) : null,
              ]))
    }

    /** Locale falls back to English on any failure; never let one throw blank the slot. */
    let t = key => titles.en[key] ?? key

    return {
      inject: ['locale', 'slots'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, titles), 'th3-token-diet: titles')
          const bound = ctx.locale.bind(NS)
          t = key => {
            const text = bound(key)
            return typeof text === 'string' && text !== key ? text : titles.en[key] ?? key
          }
        } catch (error) {
          console.error('[th3-token-diet] locale registration failed; using English titles', error)
        }
        try {
          ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
            name: 'conversation.chat.commandview',
            key: COMMAND_NAME,
          }, CostView))
        } catch (error) {
          console.error('[th3-token-diet] command view registration failed', error)
        }
      },
    }
  },
})
