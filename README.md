# Texas Polls Tracker

A static dashboard, refreshed every morning, for the 2026 Texas statewide races, the Texas Legislature, and the national U.S. Senate and House. It shows polls, forecaster ratings, and seat-distribution forecasts from a quality-weighted polling model, and highlights what moved since the previous day. Prediction markets are deliberately not used.

Live site: **https://texas-race-tracker.vercel.app** (Vercel, auto-deploys from `main`). Data snapshots are committed to `public/data/` by a GitHub Actions cron.

## What it tracks

| Section | Content |
|---|---|
| What moved | Rating changes, poll-model moves ≥ 3 pts, new polls, polling-average moves ≥ 1 pt, control-odds moves, since the previous snapshot |
| Hero board | Texas U.S. Senate, Texas Governor, and U.S. Senate control as split probability bars under the selected model |
| U.S. Senate control | Current 47 D-caucus / 53 R; polls-model Poisson-binomial seat distribution and control odds |
| U.S. Senate map | All 35 seats shaded by the average of ten forecasters (Cook, DDHQ, Economist, FiftyPlusOne, Fox, Inside Elections, RCP, Sabato, Silver Bulletin, Split Ticket); battleground table with polls, model odds, and trends |
| Texas statewide | Senate, Governor, Lt. Governor, AG, Comptroller, Railroad Commissioner, Land Commissioner, Agriculture Commissioner: polling average, latest poll, ratings, polls-model odds, per-race poll lists and published aggregates |
| U.S. House | National competitive-district ratings (ten forecasters, ~144 seats), our rated-seat model for control and expected seats, the generic congressional ballot (VoteHub polls plus published aggregates), and a zoomable Texas congressional map (2025 Plan C2333) with ratings for all 38 districts and district polls where they exist |
| Governors | All 36 governorships: Wikipedia ratings table (seven forecasters), candidates from the race summary, VoteHub polls, polls model, map and tables |
| Texas courts and SBOE | Supreme Court, Court of Criminal Appeals, and State Board of Education nominees; a statewide-environment baseline for judicial seats |
| Early vote | Scaffold for daily Texas early-voting turnout against 2022 and 2024, fed by a hand-entered `public/data/early-vote.json` (the Secretary of State's site is bot-walled and is not scraped) |
| Morning digest | Templated daily briefing with an archive and copy-as-text; `public/data/digest.txt` is the plain-text version for a future chat or email post |
| Scenarios | Browser-side re-runs of the Texas Legislature, U.S. Senate, and U.S. House models with sliders for environment, elasticity, incumbency, rating weight, and uniform polling error |
| Trends | Daily series for the marquee numbers plus a dated log of every rating and model change |
| Pollsters | Scorecard: 538 grade, volume, house lean against the race averages, latest poll |
| Texas House / Senate | Our own seat model (fundamentals + statewide environment + incumbency, blended with State Navigate ratings), chamber seat distributions and control odds, zoomable district maps (TLC plans H2316 / S2168) colored by model probability, rating, or 2024 margin; the legislative generic-ballot poll table |

## Sources

- **VoteHub** public polls feed: Senate, governor, and attorney-general polls nationwide.
- **Wikipedia** (CC BY-SA 4.0) via the MediaWiki API: the national Senate and governor ratings and race-summary tables (ratings and candidates), the House ratings page, each Texas race's Predictions and Polling tables (including aggregator averages from 270toWin, RCP, DDHQ, Silver Bulletin, FiftyPlusOne, Texas Tribune), the Texas congressional, Supreme Court, and SBOE pages, and the Texas House / Senate by-district and competitive-district tables.
- **Texas Legislative Council** district plans (public domain), converted to TopoJSON once with `npm run build:geo`.
- **us-atlas** state boundaries.

Sources are fetched independently; if one fails, the previous snapshot's values for that source are reused and the page says so.

## Method notes

- **Polling average**: polls from the last 30 days (minimum three), weighted by recency (14-day half-life), sample size (√(n/600)), and pollster quality. Partisan/internal polls are halved. VoteHub and Wikipedia copies of the same poll are merged.
- **Pollster quality**: FiveThirtyEight's pollster ratings (`ingest/data/pollster-ratings-538.csv`, 2024 methodology, vendored from github.com/fivethirtyeight/data). The 0–3 numeric grade maps to a 0.35×–1.0× weight; pollsters not in the file get 0.5×. Name matching lives in `ingest/pollsters.js` (aliases plus token overlap); each poll's grade and final weight are shown in the race detail tables. Silver Bulletin's newer ratings are paywalled and are not used.
- **Consensus rating**: mean of forecaster ratings on a −4 (Safe R) … 0 (Tossup) … +4 (Safe D) scale, mapped back to a label.
- **Rating prior** (used where a race has no polls): Safe 98.5%, Likely 90%, Lean 75%, Tilt 60%, Tossup 50%.
- **Seat distributions**: Poisson-binomial over the races in a chamber, assuming independence beyond the shared error term, so the tails are understated. Control: D needs 51 in the Senate; at 50–50 the Republican Vice President breaks the tie.

## Design

Archivo (variable width) for the nameplate, headings, figures, and tables; Source Serif 4 for running text. No cards: sections are separated by rules and whitespace, figures sit in a ruled strip, and deltas are colored by the party they move toward (blue toward Democrats, red toward Republicans). Rating colors were checked with a color-vision-deficiency validator.

## Vote panel

A dialog that opens 12 seconds after load, at most once a week per browser and once more when the phase changes (early voting opening, Election Day), and a permanent "Where and when to vote" button carry the message that polls are not votes, the key Texas dates with countdowns, and a county election-office finder. `scripts/build-counties.mjs` parses the Secretary of State's county directory (all 254 offices: title, official, address, phone, email) and extracts Texas county boundaries from us-atlas so "Use my location" resolves to a county entirely in the browser. The 22 largest counties link to their own voter sites; the rest link to the SOS listing. Visitors outside Texas get vote.gov, Vote.org, and usa.gov links. A strip under the masthead shows the next key date or the open early-voting window.

## Early vote data entry

`public/data/early-vote.json` holds `days` (one object per early-voting day: `{ "date": "2026-10-19", "inPerson": 0, "mail": 0 }`) and `benchmarks` for 2024 and 2022 in the same shape, plus `registeredVoters`. Paste the Secretary of State's statewide daily totals; the tab draws cumulative curves and same-day comparisons once the first day is in. The SOS site is behind a bot wall, so this is deliberately manual.

## Running locally

```sh
npm install                 # dev deps only (TopoJSON tooling for build:geo)
node ingest/build.js        # writes public/data/latest.json, history/<date>.json, series.json
npm run serve               # http://localhost:8787
npm test
```

`node ingest/build.js --dry-run` fetches everything without writing.

## Automation

`.github/workflows/daily.yml` builds the snapshot, commits `public/data/`, and pushes; Vercel redeploys from the push. It is started three ways, any one of which is enough (the build is idempotent):

1. GitHub's own schedule at 12:07 UTC and 13:37 UTC (7:07 and 8:37 am Central). GitHub skipped both on the first two mornings, so it is not relied on alone.
2. **AWS EventBridge at 12:12 UTC** firing `aws/dispatch/index.mjs`, a Lambda in the personal account that calls GitHub's workflow-dispatch API. Deploy with `AWS_PROFILE=personal ./aws/deploy.sh` (stack `election-tracker-dispatch`, us-east-1). The GitHub token lives in Secrets Manager as `election-tracker/github-dispatch-token`; it is currently the `gh` CLI's OAuth token, which stops working if you ever run `gh auth logout` or `gh auth refresh`. To swap in a fine-grained PAT (Actions: write on this repo): `aws secretsmanager put-secret-value --secret-id election-tracker/github-dispatch-token --secret-string '<pat>'`, no redeploy needed.
3. Manually: the Actions tab's "Run workflow", or `gh workflow run daily.yml`.

The workflow fails rather than publishing if the snapshot date is not today's Central date.

## Adding a race or source

- Texas races: `ingest/config.js` → `TEXAS_STATEWIDE_RACES` (Wikipedia page, candidates, VoteHub type).
- New data source: add a module in `ingest/sources/`, call it from `ingest/build.js` under `guard()` so a failure degrades gracefully.

## License

MIT. Wikipedia-derived data is CC BY-SA 4.0; FiveThirtyEight's pollster ratings are redistributed under their original terms.
