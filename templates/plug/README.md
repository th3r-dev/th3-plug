<img src="icon.svg" width="64" align="right" alt="">

# __NAME__ — __TITLE__

`__PACKAGE__`: __DESCRIPTION__

## Use

Type `/__COMMAND__ hello` in the chat box.

## Configuration

Defaults are in [`cordis.patch.yml`](cordis.patch.yml); override the
`__ENTRY__` row in the profile's own `cordis.patch.yml`.

| Key | Default | Meaning |
|---|---|---|
| `command` | `__COMMAND__` | slash-command name |

## Files

| File | Runs in | Role |
|---|---|---|
| `host/index.js` | Harness process | commands, events, routes |
| `web/client.js` | Harness page | slots, React views |
| `cordis.patch.yml` | Loader | the row this bundle inserts |
| `locale/*.json`, `icon.svg` | Plugin manager | title, description, icon |

## Test

```bash
node --test plugs/__NAME__/test/*.test.mjs
```
