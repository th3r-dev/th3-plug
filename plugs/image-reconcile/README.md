<img src="icon.svg" width="64" align="right" alt="">

# image-reconcile — keep only the images a route can accept

`@th3-plug/image-reconcile`: a route with a small per-request image budget
stops failing every turn. Before each model request the plug resolves the
image budget for that route, keeps the newest images that fit, and records the
rest as omitted, so the Harness sends its own note for them instead of the
image bytes.

This is the loop it breaks:

```
turn 1  read_image  → 1 image in history
…
turn 9  read_image  → 9 images in history
turn 10 request     → provider: too many images (cap 8)
turn 11 request     → same 9 images again → same failure
```

Deleting history is not an option, and `/compact` throws away more than the
images. This plug changes only what the *request* carries.

## Use

Install the bundle. Before every model step the plug resolves the budget for
that step's model and omits the oldest images over it.

Budget sources, in priority order:

| Order | Source | Example |
|---|---|---|
| 1 | `limits` config, `provider/model` then `provider` key | `tokenme: 8` |
| 2 | **probed** — measured by `/imagereconcile probe` this process | the command's report |
| 3 | **documented** — provider docs (see [Known budgets](#known-budgets)) | `deepseek: 600` |
| 4 | **observed** — a cap recorded from a real refusal in this profile | `tokenme: 8` |
| 5 | `defaultLimit` — only if you set it above 0 | `defaultLimit: 100` |
| 6 | **none** — the route is left alone | — |

A route with no known budget is **not guessed at**: guessing 8 for a model
that accepts hundreds would permanently omit images for no reason. The plug
leaves the images in place, logs one warning, and a later image refusal
suggests the probe.

Watch or trigger it in the open session:

```
/imagereconcile
```

```
Image Reconcile: kept the newest 8 image(s); omitted 3 older one(s) — each now
reaches the model as a text note naming the stored file. Image budget: 8
image(s) per request, observed in this profile (confirm it with
/imagereconcile probe).
```

## Known budgets

What the docs say (checked 2026-11-15):

| Route | Budget | Source |
|---|---|---|
| `deepseek`, `deepseek-account` | 600 images/request | [DeepSeek vision guide](https://api-docs.deepseek.com/guides/vision) — "Max images per request: 600" for `deepseek-flash` (served by DeepSeek-V4.1-Flash-1017). Also 48 MiB request body, 32 MiB per image, 8192 px/side (4096 with 15+ images). |
| `openai` | 1,500 images/request | [OpenAI images and vision](https://developers.openai.com/api/docs/guides/images-vision) — "Image count: Up to 1,500 images per request". |
| `tokenme` | 8 (observed) | not documented — the gateway's docs sit behind Cloudflare. The cap is the *observed* refusal in this profile; measure it with the probe. |
| `anthropic` | 100 or 600, by model | [Claude vision](https://platform.claude.com/docs/en/build-with-claude/vision) — 100/request for 200k-context models, 600 for the rest. Not pinned here because the split needs the model's context window; probe it. |
| `google` | not stated in a page this plug could fetch | probe it. |

The same model behind two gateways can have two different caps, which is why
the budget is keyed by **provider first**, and can be narrowed to
`provider/model`.

## Measuring a budget (the probe)

Where the docs give no number, the plug measures it. The probe sends a few
**tiny real API requests** through the profile's own credentials, so it only
runs when you ask for it — typing the command is that permission:

```
/imagereconcile probe
/imagereconcile probe tokenme
/imagereconcile probe tokenme/deepseek-ai/deepseek-v4.1-flash-1017
```

- no argument — the route of the current model;
- `provider` — every model of that provider;
- `provider/model…` — exactly that route (model ids may contain `/`).

The probe sends 1×1 test images, each a different colour (so a gateway that
deduplicates identical files cannot inflate the count): a baseline at 1, then a
binary search around the first refusal (9, 32, 100, then narrowing). It
reports:

```
Image Reconcile probe: tokenme/deepseek-ai/deepseek-v4.1-flash-1017 accepts up
to 8 image(s) per request (5 small test request(s)). Learned for this process;
add this to the imagereconcile row to keep it: limits: { "tokenme/…": 8 }
```

The learning lasts for the running process. The printed `limits:` line is
what makes it permanent: it is the config source, above everything else. A
route that keeps accepting is reported as "at least 100" (the search stops
there). If even a single-image request fails, the probe says the measurement
was inconclusive instead of guessing.

The probe checks the route's modalities first, so a text-only model is reported
as having no image budget rather than sent test images.

## How it works

A request is assembled from the **whole durable history** every step, so a
pre-step listener cannot rewrite what is already logged — it only sees the
messages entering that step. The Harness has one supported way to leave a
stored occurrence out of a request: the `image/offload` decision.

1. Before a step, resolve the route's image budget (see the table above).
2. Walk `session.surface.nodes` in model order. Skip assistant nodes; count
   the image blocks in `user/message` and `tool/result`, and add the images
   still entering with the step.
3. If the total is over the budget, select the oldest excess occurrences.
4. Append one `session.append('image/offload', { targets })` with them.

The projection owned by
[`dsh-compaction-image-offload`](https://www.npmjs.com/package/@deepseek-ai/dsh-compaction-image-offload)
marks those occurrences. Every later request — this one, the next turn, after
resume and replay — renders each marked image as the Harness placeholder:

```
[image omitted to fit request image limits; <attachment id>. No local
normalized image path is available; ask the user to attach it again if needed.]
```

With a readable attachment path the note names it instead, so the model can
`read_image` the stored copy again if it truly needs that picture.

The ordering is "newest wins": images read by the current tool result stay
while older pictures from earlier turns become notes. The decision is durable
and idempotent — a second pass sees the marks and writes nothing.

### Why not strip images from the request directly?

The derived history is built before the step's batch is committed, and
`agent/pre-step` only hands over the messages still *entering* the session.
Filtering them would fix one new message and leave every stored image in the
history untouched; the next request would resend them. `image/offload` is the
only decision the session store interprets, and it applies on every rebuild.

The plug records nothing when the projection is not mounted (for example, a
composition without `dsh-compaction-image-offload`): an uninterpreted event
would make the session refuse to reopen. It logs one warning instead and leaves
the request as it was.

## Configuration

Defaults are in [`cordis.patch.yml`](cordis.patch.yml); override the
`th3-image-reconcile` row in the profile's own `cordis.patch.yml`.

| Key | Default | Meaning |
|---|---|---|
| `limits` | `{}` | budgets you pin, keyed by `provider` or `provider/model`; beats every other source, e.g. `{ tokenme: 8 }` |
| `defaultLimit` | `0` | budget for routes with no known limit; `0` leaves them alone |
| `enabled` | `true` | `false` turns the plug off without removing it |
| `command` | `imagereconcile` | slash command that trims, prints the budget, and probes; empty string disables it |
| `probeTimeoutMs` | `60000` | abort budget for one probe request |

DSH does not expose an image-count limit in model info — adapters report a
byte or dimension bound — which is why the budget comes from config, a probe,
or docs, and why an unknown route is left alone instead of defaulted.

## Effects and limits

- **The omission is permanent for the session.** An offloaded image binds to
  that occurrence; switching back to a bigger model does not restore it. The
  read-only path in the note is the recovery.
- **It costs provider cache reuse** from the first changed message, because an
  old image became text. This happens once per omitted image, not per turn.
- **New images cannot be omitted before they are logged.** A single prompt with
  more images than the budget still exceeds it; the plug logs a warning, and
  the Harness's own `IMAGE_OFFLOAD_REQUIRED` recovery handles the refusal.
- **Only input images count.** Assistant output has no image blocks; system and
  runtime-context messages carry text.
- **A probed value lives until restart** unless you paste the printed
  `limits:` line into the row.

## Files

| File | Runs in | Role |
|---|---|---|
| `host/index.js` | Harness process | `agent/pre-step` listener, refusal hint, `/imagereconcile` |
| `host/trim.js` | Harness process | occurrence walk, budget selection, `image/offload` append |
| `host/limits.js` | Harness process | budget resolution: config → probed → documented → observed → default → none |
| `host/probe.js` | Harness process | measures a route's budget with tiny test images |
| `cordis.patch.yml` | Loader | the row this bundle inserts |
| `locale/*.json`, `icon.svg` | Plugin manager | title, description, icon |
| `test/*.test.mjs` | `node --test` | fake session, Host context, and provider, no dependencies |

## Test

```bash
node --test plugs/image-reconcile/test/*.test.mjs
```
