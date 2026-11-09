# th3-plug

Plugins ("plugs") for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
Each plug is a self-contained Harness bundle under `plugs/<name>/` that you
install straight from its folder.

## Plugs

| Plug | Package | What it does |
|---|---|---|
| [`shell`](plugs/shell/README.md) | `@th3-plug/shell` | Run local shell commands from the chat box with `!cmd` or `/sh cmd`, without calling the AI agent. zsh completions and history while typing; output shown as a reply-style terminal block. |

## Layout

```
th3-plug/
├─ plugs/<name>/            one Harness bundle per folder
│  ├─ package.json          @th3-plug/<name>, exports, dsh.bundle / dsh.client
│  ├─ cordis.patch.yml      the Loader row (id th3-<name>) and its default config
│  ├─ host/                 Host half: runs in the Harness process (Node)
│  ├─ web/client.js         Web half (optional): runs in the Harness page
│  ├─ locale/*.json         meta.title / meta.description for the plugin manager
│  ├─ icon.svg              plugin manager icon (≤ 256 KiB)
│  ├─ test/*.test.mjs       node:test, no dependencies
│  └─ README.md
├─ templates/plug/          what `npm run new` copies
├─ scripts/
│  ├─ new-plug.mjs          scaffold a plug
│  └─ check.mjs             validate plugs before installing
└─ docs/dsh-notes.md        Harness APIs these plugs use, install flow, traps
```

No build step and no dependencies: plain ES modules for the Host half, one
plain-JavaScript file for the Web half.

## Work on a plug

```bash
npm run new -- my-plug --web --title "My plug"   # scaffold plugs/my-plug
npm run check                                     # validate every plug
npm test                                          # node:test for every plug
npm run verify                                    # both
```

Clone the repo, then install or update a plug in your Harness profile by
asking the agent in DeepSeek Harness (use the absolute path of your clone):

```bash
git clone https://github.com/th3r-dev/th3-plug.git
```

> install bundle /absolute/path/to/th3-plug/plugs/shell

The profile links the folder, so later edits are read from here. Code changes
need the bundle removed and installed again, and an open window needs a reload
for Web changes. The full flow is in [docs/dsh-notes.md](docs/dsh-notes.md#install-and-update).

## Conventions

- Folder `plugs/<name>` ↔ package `@th3-plug/<name>` ↔ Loader row id `th3-<name>`.
- Tunable values go in the row's `config` with defaults in `cordis.patch.yml`,
  never hard-coded paths or user data.
- Register everything inside `apply` through `ctx.effect` / `ctx.on` so
  unloading a plug removes all of it.
- Web UI uses `--dsw-alias-*` theme tokens and a class prefix of the row id.
- Every plug ships a README, en + th locale metadata, an icon and tests;
  `npm run check` enforces the mechanical parts.

## License

MIT — see [LICENSE](LICENSE).
