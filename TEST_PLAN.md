# TEST_PLAN.md — token-diet PoC

Every FR/NFR from `SRS.md` maps to at least one happy-path and one edge case.
Tests are executable `node:test` cases in `plugs/token-diet/test/host.test.mjs`,
driven by a fake `ctx` (the repo's standard pattern, cf. `plugs/shell/test/host.test.mjs`).

## Test Matrix

| Test ID | Requirement | Scenario | Type | Expected Result |
|---------|-------------|----------|------|-----------------|
| T-1 | FR-1 | Happy path: 5,000-char all-text result, spill backend mounted | unit | Decision content replaced; single text block ≤ 2000 chars; head prefix and tail suffix preserved; one `saveText` call |
| T-2 | FR-2 | Under cap: 500-char result | unit | Same decision object returned (reference equal); no `saveText` call |
| T-3 | FR-2 | Marker content of a trimmed result | unit | Marker states omitted char count, the spill locator, and the retrieval hint |
| T-4 | FR-3 | `read` tool result over the cap | unit | Returned unchanged; no `saveText` call |
| T-5 | FR-3 | Mixed content: text + image block over the cap | unit | Returned unchanged; no `saveText` call |
| T-6 | FR-3 | Text containing the built-in spill notice marker | unit | Returned unchanged; no `saveText` call |
| T-7 | FR-3 | Text containing this plug's own marker (idempotency) | unit | Returned unchanged |
| T-8 | FR-3 | Decision carries a `value` own-property | unit | Returned unchanged; no `saveText` call |
| T-9 | FR-3 | Decision `kind: 'deny'` | unit | Returned unchanged |
| T-10 | FR-3 | PTC sub-dispatch (`exec.parent` defined), text-only | unit | Returned unchanged (dispatch-log bounding is out of scope) |
| T-11 | FR-4 | Oversized result with no `spillStore` mounted | unit | Original content kept; warning logged; no throw |
| T-12 | FR-4 | `spillStore.saveText` rejects | unit | Original content kept; warning logged; no throw; listener resolves |
| T-13 | FR-5 | Counters after two trims + one pass-through, then `/cost` | unit | Success text reports seen=3, trimmed=2, non-zero chars/tokens saved; zero-config `/cost` before any traffic reports zeros without throwing |
| T-14 | FR-6 | Config: unknown key | unit | `apply` throws at load |
| T-15 | FR-6 | Config: `headChars + tailChars` exceeds `maxResultChars` | unit | `apply` throws at load |
| T-16 | FR-6 | Config: negative / non-integer values | unit | `apply` throws at load |
| T-17 | FR-8 | `apply` with no optional services at all | unit | Registers exactly one `tools/post-execute` listener and one `cost` command; does not throw |
| T-18 | FR-1 | Surrogate-pair edge: oversized text with an emoji astride the head boundary | unit | Replacement contains no lone surrogate; total length ≤ cap |
| T-19 | NFR §5 | Population simulation: size histogram shaped like the measured session distribution (200/800/1500/2500/4000/9000/30000 chars at measured weights) through the real rule | unit | Weighted char reduction ≥ 50% at the shipped default |
| T-20 | FR-7 | Trim path makes no model call | unit | Fake ctx exposes no `llm`; trim completes with only the spill write awaited |

Not automated here — offline evidence, already executed and recorded in SRS §3/§7:
the population-level ≥50% claim over the 32 recorded local session logs
(57.4% at the 2,000-char default). T-19 guards the rule against regression with a
synthetic histogram shaped from that measurement; it is not a re-measurement.
