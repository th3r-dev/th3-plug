# th3-plug brand

**Name:** always lowercase `th3-plug`, with the hyphen. A single plugin is a
"plug" (`the shell plug`). Never "Th3Plug", "TH3 Plug" or "th3plug".

**Idea:** a plug whose face is a shell prompt (`>_`), held in the split
octagon of the th3r-dev avatar: gold on the left, ink on the right. Small
things you plug into DeepSeek Harness, built by a developer for real work.

**Tagline:** *Plugs for DeepSeek Harness.*
**Voice:** plain and practical, short sentences, the same tone as the
`th3-skills` READMEs. Say what the plug does on the user's machine; show the
command before the explanation. No hype, no exclamation marks.

## Logo

| File | Use |
|---|---|
| `app-icon.svg` | the badge: plug on the split octagon. Repo avatar, favicons, social images (min 16 px) |
| `logo-mark.svg` | the plug alone, gold. On any background where the badge is too heavy (min 20 px) |
| `banner.svg` | README header, 1280×400 |
| `social-preview.svg` | GitHub social preview / Open Graph, 1280×640 |
| `png/` | rendered sizes — regenerate with `npm run brand`, never edit by hand |

Clear space around the badge: 1/8 of its width. Keep the gold half on the
left. Don't recolor the halves, rotate the octagon, or add shadows or
gradients. On a dark background the badge gets a 1/64-width `#4A5562` outline
so its ink half still reads (as in the banners).

**Wordmark:** `th3-plug` in the display stack, weight 700, tracking -0.02em,
paper on ink (or ink on paper) with the hyphen in gold.

## Plug icons

Every plug ships its own `icon.svg` in one family: a rounded ink octagon
tile with a thin deep-gold ring, and **one gold glyph** for the plug's job
(paper for a secondary stroke). Keep it readable at 20 px.

| Plug | Glyph |
|---|---|
| `shell` | `!_` — the bang that runs a command |
| template | the plug — replace it in a new plug |

## Color

| Token | Hex | Use |
|---|---|---|
| gold | `#F2C33F` | the badge's left half, glyphs, accents |
| deepGold | `#C0841F` | rings, prongs on the mark, gold text on light (large only) |
| ink | `#182028` | the badge's right half, backgrounds, text on light |
| slate | `#2A333D` | raised surfaces on ink (pills, cards) |
| outline | `#4A5562` | badge outline on dark |
| mist | `#A9B2BC` | secondary text on ink |
| paper | `#FBFAF6` | the plug body, text on ink, light backgrounds |
| sky | `#3399C8` | links and focus (the avatar's goggles) |

Gold is an accent: keep it under ~15% of a surface, except inside the badge.
Gold text on paper fails contrast — use ink text with a gold mark instead.

Inside the DeepSeek Harness UI, plugs use the Harness theme tokens
(`--dsw-alias-*`), not these colors. Brand colors are for icons, the repo and
docs.

## Type

System fonts, no downloads:

- Display / UI: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", Helvetica, Arial, sans-serif`
- Code: `ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace`

Machine-readable tokens: [`tokens.json`](tokens.json).
