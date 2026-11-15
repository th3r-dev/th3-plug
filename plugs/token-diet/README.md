<img src="icon.svg" width="64" align="right" alt="">

# token-diet — Token Diet

`@th3-plug/token-diet` bounds every tool result **at first delivery**, so the
model never sees an oversized result in full and every later request in the
session pays the bounded size instead. The complete original text is kept in a
spill file the model can `read` or `grep`; `/cost` reports to you, the human,
what this saved — the command is never model-visible.

The built-in pipeline (`dsh-spill-policy`, `dsh-compaction-tool-result-pruner`,
`dsh-compaction-basic`) only bounds or summarizes once token pressure crosses
the compaction threshold. Mid-size tool results (~1k–8k chars) ride along
untrimmed in every later request. Measured over 32 recorded local sessions,
tool results were ~44.5% of token-step-weighted input bulk; a 2,000-char
first-delivery cap removes ~57% of that class. Because the replacement happens
before the text is ever sent, the provider's warm prompt-cache prefix stays
reusable — unlike compaction, which rewrites history and invalidates cache.

This is a proof-of-concept: see `SRS.md` and `TEST_PLAN.md` at the repo root.

## Use

Type `/cost` in the chat box and the report appears as a **stat card** in the
conversation — results seen, trimmed count and percentage, characters saved
with a savings bar, estimated tokens saved, and the active config — with a
Copy button for the raw text. The card is presentation only: the command is
never model-visible.

```
Token Diet — since load:
  tool results seen: 1,204
  trimmed: 388 (32%)
  tool-result chars: 1,938,002 → 801,071 — saved 1,136,931 (59%)
  est. tokens saved: 284,233 (4 chars/token heuristic)
  config: max 2,000 chars (head 1,500 / tail 400)
```

## What the model sees

An oversized result becomes head + marker + tail:

```
…first 1,500 characters…

[... token-diet: omitted 3,102 of 5,000 chars; full result:
/Users/…/spill/session-…/web_fetch.txt — read or grep this path ...]

…last 400 characters…
```

### Example use case: a long `web_fetch` result

A tool call fetches a paginated JSON list — 60 rows plus an error line at the
end — and comes back as a 7,733-character tool result. Without the plug, every
later request in the session carries all 7,733 characters again (~1,934
estimated tokens of the tool-result class, per the meter's 4-chars/token
heuristic).

**Input** (what the tool produced, abridged here — the plug sees all of it):

```json
HTTP/1.1 200 OK
{
  "items": [
    {"id": 1000, "name": "row-0", "status": "ok", "payload": "xxxx…"},
    {"id": 1001, "name": "row-1", "status": "ok", "payload": "xxxx…"},
    … 58 more rows …
    {"id": 1059, "name": "row-59", "status": "ok", "payload": "xxxx…"}
  ],
  "error": "E431 rate limit reached for product code 154",
  "request_id": "req_8f3a"
}
```

**Output** (what the model receives, 2,000 characters — real plug output):

```
HTTP/1.1 200 OK
{
  "items": [
    {"id": 1000, "name": "row-0", "status": "ok", "payload": "xxxx…"},
    {"id": 1001, "name": "row-1", "status": "ok", "payload": "xxxx…"},
    … head keeps the first ~1,485 characters …

[... token-diet: omitted 5,733 of 7,733 chars; full result: /Users/th33raphat/.dsh/attachments/spill/session-04cc…/web_fetch.txt — Use read with offset/limit, or grep this path to search within it. ...]

    {"id": 1059, "name": "row-59", "status": "ok", "payload": "xxxx…"}
  ],
  "error": "E431 rate limit reached for product code 154",
  "request_id": "req_8f3a"
}
```

The head keeps the response start, the tail keeps the last rows **and the
error line** — the part the agent usually needs — and the marker names the
spill file holding every omitted byte. If the model decides it needs a middle
row, it calls `read` on the locator with `offset`/`limit` (or `grep`s the
path); nothing is lost.

**Usage, this one result** (4-chars/token heuristic):

| | Before | After | Saved |
|---|---|---|---|
| Chars sent per request | 7,733 | 2,000 | 5,733 (74%) |
| Est. tokens per request | ~1,937 | ~504 | ~1,433 |
| × remaining steps in the session | — | — | multiplies |

The full original also went to the spill file (7,733 bytes), so the bounded
preview plus locator is the only thing that ever enters the session log.

Results that pass through untouched: `read` results (they are the recovery
loop for spill files), results with images (the built-in spill policy owns
image pricing), results already bounded by the built-in spill policy or by
this plug (idempotent), PTC sub-dispatch copies, and decisions that carry a
`value` or are not `accept`.

## Configuration

Defaults are in [`cordis.patch.yml`](cordis.patch.yml); override the
`th3-token-diet` row in the profile's own `cordis.patch.yml`.

| Key | Default | Meaning |
|---|---|---|
| `command` | `cost` | Slash-command name for the savings report. |
| `maxResultChars` | `2000` | Trim when the combined text of a tool result exceeds this many UTF-16 code units. |
| `headChars` | `1500` | Leading code units kept from an oversized result (errors and the start of output live here). |
| `tailChars` | `400` | Trailing code units kept (summaries and exit codes live here). |

`headChars + tailChars + 48` must fit within `maxResultChars`; invalid config
fails the plug at load. With no `spillStore` backend mounted the plug trims
nothing and says so in `/cost` — a successful tool call is never turned into
an error.

## Files

| File | Runs in | Role |
|---|---|---|
| `host/index.js` | Harness process | the `tools/post-execute` listener and the `/cost` command |
| `web/client.js` | Harness page | the `/cost` stat card in the conversation (`conversation.chat.commandview`) |
| `cordis.patch.yml` | Loader | the row this bundle inserts |
| `locale/*.json`, `icon.svg` | Plugin manager | title, description, icon |

## Test

```bash
node --test plugs/token-diet/test/*.test.mjs
```
