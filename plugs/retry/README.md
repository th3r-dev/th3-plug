<img src="icon.svg" width="64" align="right" alt="">

# retry — retry and edit a prompt, with images that fit

`@th3-plug/retry`: when a request is refused because an image is too big, the
plug fits the image and gives you a button to send the same prompt again.
No retyping, no re-attaching, no resizing in another app.

- **Retry.** A **Retry** action under a reply sends the prompt that turn
  answered once more. The Host rebuilds it from the session log, so the
  original images go with it.
- **Edit, then send.** **Edit** opens that prompt in place. Change the text,
  press **Send again** (`Cmd/Ctrl+Enter`), and the edited text is sent with the
  same images.
- **Images fit the route.** Before a request leaves the machine, an image whose
  longest edge is over the cap is replaced in that request by a smaller durable
  copy of the same picture. The transcript keeps the original.

This is the error it removes:

```
{"type":"error","error":{"type":"invalid_request_error","message":"messages.10.content.2.image.source.base64.data:
At least one of the image dimensions exceed max allowed size for many-image requests: 3000 pixels"},
"request_id":"req_011Cgu9ctkh5r5KMHCALTWUx"}
```

A tall screenshot is the usual cause: providers cap the *pixel budget* of one
image and the *edge* of one image separately, so a 1080×4000 capture passes
the pixel budget and still busts the edge. The plug caps the edge.

## Use

Install the bundle, reload the window, and send a message with an image. The
action row under the reply gains two actions beside Copy and Branch:

```
[copy] [↻ Retry] [✎ Edit] [branch]
```

- **Retry** — sends the prompt again. Use it after a turn failed, after you
  switched to a model with more room, or whenever you want the same question
  answered twice.
- **Edit** — opens a small editor above the actions with the prompt's own text
  (and "2 image(s) ride along" when it carried images). **Cancel** or `Esc`
  closes it. **Send again** sends the changed text with the original images.

Both actions start a *new* turn. The prompt and the failed reply stay in the
transcript, so the log still reads the way it happened.

## Images

The picture the model receives is a *projection* of the durable attachment:
the Harness already re-encodes every image per route, which is why the plug
does not carry an image library of its own. It asks the mounted attachment
service for one more, smaller version:

```
width, height = capped so the longest edge is maxEdge
bytes         = readImageRequest(ref, { width, height, maxBytes })
new attachment = saveImages([{ mediaType, data }])         // content-addressed
```

Measured on this machine through the app's own encoder: a 1080×4000 PNG of
68 KB (the tall-screenshot shape that trips the 3000-pixel cap) becomes a
540×2000 WebP of 2 KB, long edge 2000.

The message the request carries then holds the small reference. For a message
that is still entering the session, that small reference is what the log
records, so it is fixed once and for good. The same image is projected once: the
result is cached per image and target, and the attachment store is
content-addressed, so a retry costs nothing the second time.

### An image that is already in the log

A request is assembled from the whole durable history, so an image accepted
*before* the plug was installed cannot be replaced on its way out — it keeps its
size in the log and every later request carries it again. That is the session
where the error already happened, and it needs a different answer.

The Harness has exactly one way to leave a stored occurrence out of a request:
an `image/offload` decision, which every later request renders as placeholder
text naming the attachment. That event belongs to
[`dsh-compaction-image-offload`](https://www.npmjs.com/package/@deepseek-ai/dsh-compaction-image-offload),
which the shipped `dsh` composition mounts. When it is mounted, the plug uses it:

- a request refused for image dimensions marks the oversized occurrences and
  retries the step, so the turn finishes instead of failing;
- a **Retry** or **Edit** marks them before the new prompt is sent, so the model
  reads the picture once — the fresh, fitted copy — and a placeholder for the
  old one. The actions say how many copies were left out.

When that projection is not mounted the plug records nothing (an event nothing
interprets would make the session refuse to reopen) and the request fails as it
did before.

### Why not `image-resize-compress`

`npm i image-resize-compress` was the suggested route. That package wraps a
browser canvas, and a Client plugin cannot import an npm package at all: the page
loads one plain-JavaScript module whose only available import is `react`, so the
library would have to be bundled and vendored into `web/client.js`. The Host path
above is simpler and better placed — it uses the encoder the Harness already
ships, needs no dependency, and it fixes images that are *already* in the
session, which an attach-time canvas resize could never reach.

## Which prompt a reply retries

The Host walks the session's durable messages back from the reply and takes the
nearest ordinary user prompt, so steering lines and injected context are never
re-sent. If the reply's own message was shadowed by compaction, the newest
prompt is used instead.

## Configuration

Defaults are in [`cordis.patch.yml`](cordis.patch.yml); override the
`th3-retry` row in the profile's own `cordis.patch.yml`.

| Key | Default | Meaning |
|---|---|---|
| `maxEdge` | `2000` | longest image edge, in pixels, one model request may carry; 2000 is under every documented many-image cap (the error above quotes 3000) |
| `maxBytes` | `1048576` | encoded-byte target for one shrunken image |
| `shrink` | `true` | fit oversized request images; `false` keeps only the Retry and Edit actions |
| `offload` | `true` | leave an image committed before this plug out of later requests, through the `image/offload` decision |

## What the model sees

- The request carries the smaller image and the usual image handle line, so
  the model is told the dimensions it actually got.
- A retry is an ordinary user message, so it is part of the session log and of
  every later request. It costs its own tokens.
- When the session's model is known to be text-only, a resend keeps the text
  and leaves the images out instead of failing.
- An occurrence left out through `image/offload` becomes placeholder text naming
  the attachment; the transcript still shows the picture, the model does not.

## Not covered

- Only ordinary prompts are retried. Steering lines, injected context and tool
  results are not offered as a retry.
- Retry does not roll the transcript back. Removing the failed turn is not a
  thing a plugin may do to a session log.
- Attachments are never deleted, so a shrunken copy of an image stays on disk
  beside the original.
- The omission path needs `@deepseek-ai/dsh-compaction-image-offload`. Without
  it only new images are fitted.
- Editing changes the text, not the images: adding or removing a picture goes
  through the composer.

## Files

| File | Role |
|---|---|
| `host/index.js` | wiring: the `agent/pre-step` image fitting and the two authenticated routes |
| `host/images.js` | shrinking one request batch through the attachment service |
| `host/offload.js` | leaving a stored, oversized image out of later requests |
| `host/retry.js` | which prompt a reply retries, what a resend carries, the geometry |
| `web/client.js` | the Retry and Edit actions and the editor they open |
| `cordis.patch.yml` | the row this bundle inserts |
| `locale/*.json`, `icon.svg` | title, description, icon |

## Test

```bash
node --test plugs/retry/test/*.test.mjs
```

`test/host.test.mjs` covers the geometry, the prompt lookup, the shrinking and
the omission against fake services. `test/client.test.mjs` renders the actions
with a small React stand-in and a stubbed `fetch`, so the two request bodies,
the editor, Escape, `Cmd/Ctrl+Enter` and the failure text are all exercised
without a browser.
