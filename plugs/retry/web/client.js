/**
 * @th3-plug/retry — Web half.
 *
 * Two actions in the finalized assistant message's action row:
 *
 *  - **Retry** sends the prompt that turn answered once more. The Host rebuilds
 *    it from the session log, so the images of the original prompt come with it
 *    and the image fitting from `agent/pre-step` applies again.
 *  - **Edit** reads that same prompt back, lets it be changed in place, and
 *    sends the edited text with the original images.
 *
 * The Host half owns the routes (`/api/th3-retry/prompt`, `/api/th3-retry/send`);
 * this half only renders, matches the host's icon-action row, and reports a
 * failure inline without leaving the message.
 */
window.__ModuleLoader__.load({
  id: '@th3-plug/retry',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'th3-retry'
    const PROMPT_PATH = '/api/th3-retry/prompt'
    const SEND_PATH = '/api/th3-retry/send'

    const titles = {
      en: {
        retry: 'Retry',
        retryHint: 'Send the previous prompt again',
        edit: 'Edit',
        editHint: 'Edit the previous prompt, then send it again',
        editTitle: 'Edit the prompt',
        sending: 'Sending…',
        loading: 'Loading…',
        send: 'Send again',
        cancel: 'Cancel',
        images: '{count} image(s) ride along',
        noImages: '',
        failed: 'Could not send that prompt again',
        missing: 'The retry plug is not answering on the Host',
        omitted: '{count} older copy stays out of the model view',
      },
      th: {
        retry: 'ลองอีกครั้ง',
        retryHint: 'ส่งพรอมป์ก่อนหน้าอีกครั้ง',
        edit: 'แก้ไข',
        editHint: 'แก้พรอมป์ก่อนหน้า แล้วส่งอีกครั้ง',
        editTitle: 'แก้ไขพรอมป์',
        sending: 'กำลังส่ง…',
        loading: 'กำลังโหลด…',
        send: 'ส่งอีกครั้ง',
        cancel: 'ยกเลิก',
        images: 'แนบรูปไปด้วย {count} รูป',
        noImages: '',
        failed: 'ส่งพรอมป์นั้นอีกครั้งไม่สำเร็จ',
        missing: 'ไม่พบปลั๊ก retry ฝั่ง Host',
        omitted: 'ตัดรูปชุดเก่า {count} รูปออกจากสายตาของโมเดล',
      },
      zh: {
        retry: '重试',
        retryHint: '再次发送上一条提示',
        edit: '编辑',
        editHint: '编辑上一条提示后再次发送',
        editTitle: '编辑提示',
        sending: '发送中…',
        loading: '加载中…',
        send: '再次发送',
        cancel: '取消',
        images: '同时重发 {count} 张图片',
        noImages: '',
        failed: '无法再次发送该提示',
        missing: 'Host 未响应 retry 插件',
        omitted: '已从模型视图中移除 {count} 张旧图片',
      },
    }

    let t = (key, params) => fill(titles.en[key] ?? key, params)

    function fill(text, params) {
      if (params === undefined) return text
      return String(text).replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])))
    }

    /** Post one JSON body to a Host route and always resolve to its payload. */
    async function post(path, body) {
      let response
      try {
        response = await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
      let text = ''
      try {
        text = await response.text()
      } catch { /* an unreadable body falls through to the status */ }
      if (text !== '') {
        try {
          const payload = JSON.parse(text)
          if (payload !== null && typeof payload === 'object') return payload
        } catch { /* not JSON: report the status below */ }
      }
      return {
        ok: false,
        error: response.status === 404 ? t('missing') : `${t('failed')} (HTTP ${response.status})`,
      }
    }

    const CSS = `
.th3-retry{position:relative;display:inline-flex;align-items:center;gap:2px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1}
.th3-retry-action{display:inline-flex;align-items:center;gap:5px;height:calc(28px + var(--dsh-content-font-delta,0px));padding:0 7px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;line-height:1;transition:background-color .1s,color .1s}
.th3-retry-action svg{width:15px;height:15px;flex:none}
.th3-retry-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.th3-retry-action:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.th3-retry-action:disabled{opacity:.5;cursor:default}
.th3-retry-label{white-space:nowrap}
.th3-retry-notice{margin-left:8px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.th3-retry-error{margin-left:8px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-error-primary)}
.th3-retry-form{position:absolute;bottom:calc(100% + 6px);right:0;z-index:20;box-sizing:border-box;width:min(460px,calc(100vw - 48px));display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-panel);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);text-align:left}
.th3-retry-text{box-sizing:border-box;width:100%;min-height:84px;max-height:44vh;resize:vertical;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;line-height:1.5;outline:none}
.th3-retry-text:focus{border-color:var(--dsw-alias-state-business-primary)}
.th3-retry-foot{display:flex;align-items:center;gap:8px}
.th3-retry-note{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px}
.th3-retry-ghost{height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:13px}
.th3-retry-ghost:hover{background:var(--dsw-alias-interactive-bg-hover)}
.th3-retry-send{height:28px;padding:0 14px;border:0;border-radius:999px;background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-inverted);cursor:pointer;font:inherit;font-size:13px}
.th3-retry-send:disabled{opacity:.45;cursor:default}
`

    function IconRetry() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M13.2 8.4a5.2 5.2 0 1 1-1.5-4.3M13.4 2.2v3.4H10',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }))
    }

    function IconEdit() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M10.7 2.6a1.7 1.7 0 0 1 2.4 2.4l-7 7-3 .6.6-3zM9.8 3.5l2.4 2.4',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }))
    }

    /**
     * Retry / Edit for one finalized assistant message, plus the editor the Edit
     * action opens. Everything stays inside this message, so no overlay, portal,
     * or composer state is involved.
     */
    function RetryActions(props) {
      const messageId = props.messageId
      const retry = props.retry
      const readPrompt = props.readPrompt
      const useAccess = props.useAccess
      const translate = props.t ?? t
      // A peer without prompt access sees no actions; the Host refuses anyway.
      const allowed = typeof useAccess === 'function' ? useAccess('session/prompt') : true
      const [busy, setBusy] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [editing, setEditing] = React.useState(null)
      const [text, setText] = React.useState('')
      const alive = React.useRef(true)
      React.useEffect(() => () => {
        alive.current = false
      }, [])

      const run = React.useCallback(async (kind, work) => {
        if (alive.current) {
          setBusy(kind)
          setFailure(null)
          setNotice(null)
        }
        try {
          await work()
        } catch (error) {
          if (alive.current) setFailure(String(error?.message ?? error))
        } finally {
          if (alive.current) setBusy(null)
        }
      }, [])

      if (allowed === false) return null

      const resend = (edited, fallback) => run(edited === undefined ? 'retry' : 'send', async () => {
        const result = await retry(messageId, edited)
        if (!result?.ok) throw new Error(result?.error ?? fallback)
        setEditing(null)
        const omitted = Number(result.offloaded) || 0
        setNotice(omitted > 0 ? fill(translate('omitted'), { count: omitted }) : null)
      })

      const openEditor = () => run('edit', async () => {
        const result = await readPrompt(messageId)
        if (!result?.ok) throw new Error(result?.error ?? translate('failed'))
        setEditing({ images: Number(result.images) || 0 })
        setText(String(result.text ?? ''))
      })

      const closeEditor = () => {
        setEditing(null)
        setFailure(null)
      }

      const onChange = (event) => setText(event.target.value)

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          // Keep the composer's Esc-Esc stop out of a prompt being edited.
          event.stopPropagation()
          closeEditor()
          return
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          if (text.trim() !== '' && busy === null) resend(text, translate('failed'))
        }
      }

      const label = (key) => translate(key)

      return h('span', { className: 'th3-retry', 'data-th3-retry': '' },
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: 'th3-retry-action',
          'aria-label': label('retryHint'),
          title: label('retryHint'),
          disabled: busy !== null || editing !== null,
          onClick: () => resend(undefined, translate('failed')),
        },
          h(IconRetry),
          h('span', { className: 'th3-retry-label' }, busy === 'retry' ? label('sending') : label('retry'))),
        h('button', {
          type: 'button',
          className: 'th3-retry-action',
          'aria-label': label('editHint'),
          title: label('editHint'),
          disabled: busy !== null || editing !== null,
          onClick: openEditor,
        },
          h(IconEdit),
          h('span', { className: 'th3-retry-label' }, busy === 'edit' ? label('loading') : label('edit'))),
        editing === null ? null : h('div', {
          className: 'th3-retry-form',
          role: 'dialog',
          'aria-label': label('editTitle'),
        },
          h('textarea', {
            className: 'th3-retry-text',
            value: text,
            rows: 4,
            autoFocus: true,
            spellCheck: true,
            'aria-label': label('editTitle'),
            onChange,
            onKeyDown,
          }),
          h('div', { className: 'th3-retry-foot' },
            h('span', { className: 'th3-retry-note' }, editing.images > 0 ? fill(label('images'), { count: editing.images }) : ''),
            h('button', { type: 'button', className: 'th3-retry-ghost', onClick: closeEditor }, label('cancel')),
            h('button', {
              type: 'button',
              className: 'th3-retry-send',
              disabled: busy !== null || text.trim() === '',
              onClick: () => resend(text, translate('failed')),
            }, busy === 'send' ? label('sending') : label('send')))),
        failure === null ? null : h('span', { className: 'th3-retry-error', role: 'status' }, failure),
        failure === null && notice !== null ? h('span', { className: 'th3-retry-notice', role: 'status' }, notice) : null)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, titles), 'th3-retry: titles')
          const bound = ctx.locale.bind(NS)
          t = (key, params) => {
            const text = bound(key, params)
            return typeof text === 'string' && text !== key ? text : fill(titles.en[key] ?? key, params)
          }
        } catch (error) {
          console.error('[th3-retry] locale registration failed; using English titles', error)
        }
        try {
          ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
            name: 'conversation.chat.assistant-actions',
            id: 'retry',
            order: 20,
            locale: NS,
            inject: (sessionId) => ({
              retry: (messageId, text) => post(SEND_PATH, text === undefined
                ? { sessionId, messageId }
                : { sessionId, messageId, text }),
              readPrompt: (messageId) => post(PROMPT_PATH, { sessionId, messageId }),
            }),
          }, RetryActions))
        } catch (error) {
          console.error('[th3-retry] action registration failed', error)
        }
      },
    }
  },
})
