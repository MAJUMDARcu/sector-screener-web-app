# Sector Screener — Web App

A static, no-build-step web version of the sector quant screener: paste
fundamentals, get a ranked five-factor screen and written Buy/Hold/Sell
notes, entirely in the browser. Same scoring math and note-generation
logic as the Python/CLI version — this is a genuine port, not a
simplified rewrite (verified against the Python engine's output on the
same demo dataset before shipping; see "How this was verified" below).

## Files
- `index.html` — page structure
- `styles.css` — all styling (dark ledger theme; see the comment block
  at the top of the file for the design concept)
- `assets/engine.js` — the quant engine + note generator, ported from
  `factor_engine.py` / `note_generator.py`
- `assets/app.js` — form wiring, rendering, and the three download paths
  (CSV / Markdown / Word)
- `netlify.toml` — Netlify config (just points at the repo root; no
  build command needed, it's static files)

## Run it locally
No build step, no dependencies to install. Any static file server works:
```bash
python3 -m http.server 8000
# then open http://localhost:8000
```
Opening `index.html` directly (`file://`) also works for the core
screening flow — the sample-data button uses an inlined copy of the CSV
specifically so it doesn't depend on `fetch()`, which browsers block for
local files.

## Deploy to Netlify
Three ways, in order of simplicity:

**A. Drag-and-drop (fastest, no git needed)**
1. Go to [app.netlify.com/drop](https://app.netlify.com/drop)
2. Drag this whole folder in
3. Done — you get a live URL immediately

**B. Netlify CLI**
```bash
npm install -g netlify-cli
netlify deploy --prod --dir .
```

**C. Git-connected (auto-deploys on push)**
1. Push this folder to a GitHub/GitLab repo
2. In Netlify: "Add new site" → "Import an existing project" → pick the repo
3. Build command: leave blank. Publish directory: `.`
4. Deploy

No environment variables, no serverless functions, no backend — it's a
static site plus client-side JS.

## What runs where
- CSV parsing, scoring, ranking, and note generation: 100% client-side
  JavaScript, no network call, works offline once the page is loaded.
- "Download Word report": loads the `docx` library from a CDN
  (`cdn.jsdelivr.net`) at click-time via dynamic `import()`, since a
  ~200KB library isn't worth bundling into every page load for a feature
  most visitors won't use. Needs an internet connection; CSV and
  Markdown downloads don't.

## How this was verified
Before shipping, the JS engine was run against the same demo CSV as the
Python CLI version and the outputs were diffed — same composite scores,
same ranks, same BUY/HOLD/SELL calls, same borderline flags. The full
click-through flow (load sample data → run screen → render ledger +
notes) was simulated with jsdom and checked for the right panel counts,
rating totals, and warning states. Screenshots at desktop and mobile
widths were rendered from that verified output to check the actual
visual layout before calling this done — the ledger's diverging-bar
rows, borderline tags, note cards, and small-sample warning banner were
all confirmed to render as intended.

## Known limitations (same as the Python version, plus one)
- CSV parsing is intentionally simple (comma-split, no quoted-field
  support) — don't put commas inside a company name cell.
- Same demo-data disclaimer applies: `assets/sample_it_sector.csv` (and
  the inlined copy in `app.js`) is illustrative, made-up data on real
  company names, for exercising the pipeline only.
- Same small-sample / borderline-band behavior as the CLI — percentile
  bands get noisy under ~15 names; the tool flags this rather than
  hiding it.
- The Word-report download depends on a CDN at request time (see above);
  if a user's network blocks `cdn.jsdelivr.net`, that one button will
  fail gracefully with an inline message and suggest Markdown instead —
  CSV/Markdown downloads are unaffected.
