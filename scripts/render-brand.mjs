#!/usr/bin/env node
/**
 * Render brand/*.svg to the PNG sizes in brand/png/ with headless Chrome.
 * The SVGs are the source of truth; never edit a PNG by hand.
 *
 *   node scripts/render-brand.mjs
 *
 * CHROME=/path/to/chrome overrides the browser.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BRAND = join(ROOT, 'brand')
const OUT = join(BRAND, 'png')

// Every plug's icon.svg also gets a 180 px PNG (marketplace tiles accept rasters only).
const PLUG_ICONS = existsSync(join(ROOT, 'plugs'))
  ? readdirSync(join(ROOT, 'plugs')).filter(name => existsSync(join(ROOT, 'plugs', name, 'icon.svg')))
  : []

const JOBS = [
  ...[16, 32, 48, 64, 128, 256, 512, 1024].map(size => ({ svg: 'app-icon.svg', png: `app-icon-${size}.png`, w: size, h: size })),
  { svg: 'logo-mark.svg', png: 'logo-mark-512.png', w: 445, h: 512 },
  { svg: 'banner.svg', png: 'banner.png', w: 1280, h: 400 },
  { svg: 'social-preview.svg', png: 'social-preview.png', w: 1280, h: 640 },
  ...PLUG_ICONS.map(name => ({ svgPath: join(ROOT, 'plugs', name, 'icon.svg'), out: join(ROOT, 'plugs', name, 'assets', 'icon-180.png'), w: 180, h: 180 })),
]

const candidates = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)
const chrome = candidates.find(path => existsSync(path))
if (!chrome) {
  console.error('error: Chrome not found; set CHROME=/path/to/chrome')
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'th3-brand-'))
let failed = 0
for (const job of JOBS) {
  const page = join(scratch, 'page.html')
  writeFileSync(page, `<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{display:block;width:${job.w}px;height:${job.h}px}</style></head><body><img src="${pathToFileURL(job.svgPath ?? join(BRAND, job.svg)).href}"></body></html>`)
  const target = job.out ?? join(OUT, job.png)
  mkdirSync(dirname(target), { recursive: true })
  const result = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    '--default-background-color=00000000', '--force-device-scale-factor=1',
    `--window-size=${job.w},${job.h}`, `--screenshot=${target}`, pathToFileURL(page).href,
  ], { encoding: 'utf8' })
  if (result.status !== 0 || !existsSync(target)) {
    console.error(`✖ ${job.png ?? job.out}: ${result.stderr?.trim().split('\n').pop() ?? 'failed'}`)
    failed++
  } else {
    console.log(`✔ ${job.png ?? job.out.slice(ROOT.length + 1)} (${job.w}×${job.h})`)
  }
}
rmSync(scratch, { recursive: true, force: true })
process.exit(failed > 0 ? 1 : 0)
