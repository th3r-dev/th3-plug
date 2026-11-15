# SRS: token-diet — a DeepSeek Harness plug that trims tool results before they are ever sent

## 1. Purpose

Can a third-party DeepSeek Harness plug ("plug") in this repo reduce the input-token
cost of an agent session measurably, by bounding every tool result at first delivery
(`tools/post-execute`) instead of waiting for the built-in compaction pipeline to act
under pressure? The built-in chain (`dsh-spill-policy`, `dsh-compaction-tool-result-pruner`,
`dsh-compaction-basic`) only bounds or summarizes once token pressure crosses the
compaction threshold, so mid-size tool results (≈1k–8k chars) ride along untrimmed in
every later request of a session. Measured across 32 recorded local session logs
(3,909 model steps, 4,233 tool results), tool results are ≈44.5% of the token-step-weighted
input bulk, and a 2,000-char first-delivery cap would have removed ≈57% of that class.
This PoC proves the missing lever is implementable as an installable plug without
breaking replay, cache locality, or the built-in pipeline.

## 2. Scope

- In scope: one Host-half plug (`@th3-plug/token-diet`) that bounds accepted tool-result
  text at `tools/post-execute`, preserves the full text in a spill file, reports
  cumulative savings through a `/cost` human command, and passes a `npm run verify` gate.
- Out of scope: compressing assistant reasoning or text, shrinking tool-call arguments,
  prompt-cache routing changes, any Web-half UI, PTC dispatch-log bounding
  (`tools/ptc-dispatch-log`), per-tool policies, persistent (cross-restart) counters,
  and changing any built-in package or the base composition.

## 3. Background / Prior Art

- Built-in pipeline (verified from the installed 0.2.x package sources): `dsh-token-meter`
  prices messages with a fixed 4-chars-per-token heuristic; `dsh-spill-policy` bounds
  accepted tool results to `maxInlineTokens: 12500` with a recoverable spill file;
  `dsh-compaction-tool-result-pruner` trims results > 8,192 chars — but only after a
  compaction trigger qualifies; `dsh-compaction-basic` then summarizes history at
  `floor(min(W×0.8, W−O−B))` pressure. Nothing touches results between ~1k and ~8k
  chars while the session is below pressure, although they are re-sent every step.
- Replacement point and cache economics: post-execute replacement is append-only
  relative to the already-sent prefix, so the provider's warm KV-cache prefix stays
  reusable; the built-in pruner/compaction replace history and invalidate reuse from
  the first changed token. Trimming before first send is therefore the cheapest point.
- Mechanism verified in the installed `dsh-spill-policy` source: a prepended/appended
  `ctx.on('tools/post-execute', async (exec, result, next) => …)` listener calls
  `await next()` first, reads `decision.content ?? result.content` when
  `decision.kind === 'accept'` and no `value` own-property exists, and replaces content
  by returning `{ kind: 'accept', content: newBlocks }`; it skips `exec.name === 'read'`
  and degrades fail-open on any error. Full text is kept via
  `ctx.get('spillStore').saveText({ owner: { sessionId: exec.agent?.session.header.id },
  source: { kind: 'tool', toolName, callId, label }, suggestedName, content })`
  → `{ locator, bytes, retrievalHint }`; `ctx.get('tokenMeter').estimateMessage(message)`
  returns a heuristic token number.
- Measured cost distribution (analysis over `~/.dsh/sessions/*/session.v4.jsonl.zstd`,
  token-step-weighted = chars × remaining steps): tool results 44.5%, assistant
  messages (incl. reasoning) 34.3%, tool-call arguments 26.3%, user 13.6%, system 1.2%.
  First-delivery caps save: 1,000 chars → 72.5%, 2,000 → 57.4%, 4,000 → 38.6%,
  8,000 (built-in threshold) → 21.2% of the tool-result class.
- Repo conventions (`AGENTS.md`, `docs/dsh-notes.md`): host code is dependency-free ES
  modules; optional services via `ctx.get()`; own locale namespace; every behaviour gets
  a `node:test` with a fake ctx; command results are never model-visible (correct for
  a human-only `/cost` readout).

## 4. Functional Requirements

- FR-1: When a `tools/post-execute` decision is `accept` with no `value` own-property,
  the result blocks are all `text`, the tool is not `read`, the text carries no
  spill-notice marker (neither the built-in's nor this plug's), a spill backend is
  mounted, and the combined text exceeds `maxResultChars`, the plug shall return
  `{ kind: 'accept', content }` where the text is head + marker + tail of total
  length ≤ `maxResultChars`.
- FR-2: The marker shall state the omitted character count and, when the spill save
  succeeded, the full-content locator and its retrieval hint; when the text is at most
  `maxResultChars`, the plug shall return the incoming decision unchanged (same object).
- FR-3: The plug shall pass through unchanged: `read` results; results containing any
  non-text block; results whose text contains a spill-notice marker; decisions with a
  `value` own-property or `kind !== 'accept'`.
- FR-4: When no `spillStore` backend is mounted, or `saveText` rejects, the plug shall
  leave the original content inline and log a warning (best-effort, never turning a
  successful tool call into an error).
- FR-5: The plug shall accumulate counters (results seen, results trimmed, original
  chars, sent chars, estimated input tokens saved) and the `/cost` command shall return
  a success text reporting them; the command shall have no model-visible effect.
- FR-6: The plug shall validate config at load: unknown keys rejected; `headChars +
  tailChars + marker ≤ maxResultChars`; non-integer or negative values rejected.
- FR-7 (NFR): The trim path shall make no model call; the only awaited I/O is the local
  spill save; the plug shall add zero npm dependencies and run on Node ≥ 20.
- FR-8: `apply` shall register exactly one `tools/post-execute` listener and one `cost`
  command through `ctx.on` / `ctx.commands`, and shall not throw when the optional
  `spillStore` or `tokenMeter` services are absent.

## 5. Non-Functional Requirements

- Savings efficiency: at the shipped default (`maxResultChars: 2000`), the trim rule
  removes ≥ 50% of the tool-result char-steps measured over the 32 recorded local
  sessions (baseline measurement: 57.4%).
- Replay safety: the plug appends no new session event types; replacements ride the
  pipeline's own decision replacement.
- Latency: the decision adds no synchronous work beyond slicing strings and one
  awaited local file write for oversized results.

## 6. Assumptions

- A1: Host-half only; `/cost` renders as a normal command result card. Rationale: the
  PoC question is cost, not UI; the repo's command view already draws results.
- A2: Default `maxResultChars: 2000`, `headChars: 1500`, `tailChars: 400`. Rationale:
  the measured savings curve (57.4% at 2,000 vs 21.2% at the built-in 8,192) against
  keeping enough head (where errors/start of output live) and tail (where summaries and
  exit codes live); user-tunable via `cordis.patch.yml` config.
- A3: Only all-text results are rewritten; mixed text+image results pass through.
  Rationale: keeps v1 simple; the built-in spill-policy and pruner still cover rich
  content, and they own image pricing.
- A4: A result already containing the built-in spill notice ("Full formatted result
  stored at:") passes through. Rationale: one bounded-write owner per result; the
  built-in already replaced it with a recoverable preview.
- A5: The listener registers appended (not prepended), so it runs downstream of the
  built-in spill-policy in the waterfall. Rationale: converges with the built-in in
  both orders and keeps the diff surface minimal.
- A6: Counters live in process memory and reset on app restart. Rationale: PoC scope;
  a full build would persist per-session stats in a storage domain.
- A7: Spill `suggestedName` is `"<toolName>.txt"`, mirroring the built-in policy;
  the backend sanitizes the name.
- A8: Estimated tokens saved use `ctx.tokenMeter.estimateMessage` when mounted, else
  the same 4-chars-per-token heuristic inline. Rationale: both are the fixed heuristic;
  the meter is optional so the plug loads without it.
- A9: The ticket tracker is GitHub Issues (`gh`); no Jira/Monday MCP is connected.
- A10: The user's uncommitted work in the working tree (`plugs/retry/web/client.js`,
  `plugs/image-reconcile/`) is left untouched and uncommitted by this PoC.

## 7. Success Criteria

1. `npm run verify` (manifest/exports/patch/locale/icon checks + `node:test`) passes
   with the new plug's tests green.
2. Unit-level: replaying a recorded oversized tool result through the listener yields
   a replacement whose text length ≤ `maxResultChars`, whose omitted-char count matches
   original minus head/tail, and whose spill file received the full original text.
3. Population-level: applying the shipped default rule to the measured tool-result
   population of the 32 recorded local sessions removes ≥ 50% of tool-result
   char-steps (measured 57.4% at 2,000 chars).
4. The `/cost` command reports non-zero counters after a scripted trim run.
