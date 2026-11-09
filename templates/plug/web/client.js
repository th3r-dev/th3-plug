/**
 * __PACKAGE__ — Web half.
 *
 * Runs in the Harness page. One file, plain JavaScript, no bundler: the page
 * loads it through `window.__ModuleLoader__`, and `id` must equal the package
 * name. React comes from `require('react')`; do not import other Harness
 * client packages.
 *
 * Starter behaviour: draws the `/__COMMAND__` result as a small card in the
 * chat (slot `conversation.chat.commandview`, keyed by command name).
 * Code changes reach an open window only after a page reload.
 */
window.__ModuleLoader__.load({
  id: '__PACKAGE__',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const COMMAND = '__COMMAND__'

    const CSS = `
.__ENTRY__-card{margin:4px 0;padding:10px 14px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.__ENTRY__-card[data-state=error]{color:var(--dsw-alias-state-error-primary)}
.__ENTRY__-meta{color:var(--dsw-alias-label-secondary);font-size:12px}
`

    /** props.node: { name, args, outcome: { kind, text } | null } */
    function CommandCard({ node }) {
      const outcome = node?.outcome ?? null
      const state = outcome === null ? 'running' : outcome.kind
      return h('div', { className: '__ENTRY__-card', 'data-state': state },
        h('style', null, CSS),
        h('div', { className: '__ENTRY__-meta' }, `/${COMMAND}${node?.args ?? ''}`),
        h('div', null, outcome === null ? '…' : outcome.text ?? ''))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
          name: 'conversation.chat.commandview',
          key: COMMAND,
        }, CommandCard))
      },
    }
  },
})
