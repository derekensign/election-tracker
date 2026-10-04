# Texas Polls Tracker

A static dashboard, refreshed every morning, for the 2026 Texas statewide races, the Texas Legislature, and the national U.S. Senate map. It shows polls, forecaster ratings, prediction-market odds, and a seat-distribution forecast, and highlights what moved since the previous day.

Live site: **https://texas-race-tracker.vercel.app** (Vercel, auto-deploys from `main`). Data snapshots are committed to `public/data/` by a GitHub Actions cron.

## What it tracks

| Section | Content |
|---|---|
| What moved | Rating changes, poll-model or market moves ≥ 3 pts, new polls, polling-average moves ≥ 1 pt, control-odds moves, since the previous snapshot |
| Hero board | Texas U.S. Senate, Texas Governor, and U.S. Senate control as split probability bars under the selected model |
| U.S. Senate control | Current 47 D-caucus / 53 R; polls-model and market-derived Poisson-binomial seat distributions; Polymarket control odds; Kalshi Democratic-seat distribution (caucus-counted) |
| U.S. Senate map | All 35 seats shaded by the average of ten forecasters (Cook, DDHQ, Economist, FiftyPlusOne, Fox, Inside Elections, RCP, Sabato, Silver Bulletin, Split Ticket); battleground table with polls, odds, and trends |
| Texas statewide | Senate, Governor, Lt. Governor, AG, Comptroller, Railroad Commissioner, Land Commissioner, Agriculture Commissioner: polling average, latest poll, ratings, Kalshi and Polymarket odds (thin markets flagged), per-race poll lists and published aggregates |
| Texas House / Senate | District maps (TLC plans H2316 / S2168) colored by State Navigate rating or party held, or by 2024 presidential margin; rated-district tables; Kalshi chamber odds |

## Sources

- **Polymarket** Gamma API (public): per-race winner markets, Senate and House control.
- **Kalshi** public market data: Texas statewide races (including the down-ballot ones Polymarket lacks), the Democratic Senate seat-count market, Texas House control and seat count, "how many Texas statewide races Democrats win".
- **VoteHub** public polls feed: Senate, governor, and attorney-general polls nationwide.
- **Wikipedia** (CC BY-SA 4.0) via the MediaWiki API: the national Senate ratings table, each Texas race's Predictions and Polling tables (including aggregator averages from 270toWin, RCP, DDHQ, Silver Bulletin, FiftyPlusOne, Texas Tribune), and the Texas House / Senate by-district and competitive-district tables.
- **Texas Legislative Council** district plans (public domain), converted to TopoJSON once with `npm run build:geo`.
- **us-atlas** state boundaries.

Sources are fetched independently; if one fails, the previous snapshot's values for that source are reused and the page says so.

## Two probability models, one toggle

The page header switches every win probability, the hero board, the seat distribution, and the map's probability mode between:

- **Polls model** (default). Each race's quality-weighted polling average is converted to a Democratic win probability with a Student-t error model (5 degrees of freedom): σ = √(5.5² + (0.05 × days to election)² + 3² / effective polls). 5.5 points approximates the historical RMSE of final statewide polling averages; the time term adds about 1.5 points a month out; the sparsity term widens thinly polled races (effective polls is the Kish effective sample size of the weights). Races with no polls fall back to the forecaster-rating prior and are labelled.
- **Prediction markets**. Polymarket first, then Kalshi, then the rating prior; thin markets (< $10k traded) are shown but not used as the primary number.

`?model=markets` in the URL selects the market view; the choice is remembered in localStorage.

## Method notes

- **Polling average**: polls from the last 30 days (minimum three), weighted by recency (14-day half-life), sample size (√(n/600)), and pollster quality. Partisan/internal polls are halved. VoteHub and Wikipedia copies of the same poll are merged.
- **Pollster quality**: FiveThirtyEight's pollster ratings (`ingest/data/pollster-ratings-538.csv`, 2024 methodology, vendored from github.com/fivethirtyeight/data). The 0–3 numeric grade maps to a 0.35×–1.0× weight; pollsters not in the file get 0.5×. Name matching lives in `ingest/pollsters.js` (aliases plus token overlap); each poll's grade and final weight are shown in the race detail tables. Silver Bulletin's newer ratings are paywalled and are not used.
- **Consensus rating**: mean of forecaster ratings on a −4 (Safe R) … 0 (Tossup) … +4 (Safe D) scale, mapped back to a label.
- **Rating prior** (used where neither polls nor markets exist): Safe 98.5%, Likely 90%, Lean 75%, Tilt 60%, Tossup 50%.
- **Seat distributions**: Poisson-binomial over the 35 races, assuming independence, for both models. Real outcomes are correlated, so the tails are understated; the Kalshi market distribution is shown alongside for comparison. Control: D needs 51; at 50–50 the Republican Vice President breaks the tie.
- **Thin market**: under $10k traded. Odds from thin markets are shown but not used as the primary probability.

## Design

Archivo (variable width) for the nameplate, headings, figures, and tables; Source Serif 4 for running text. No cards: sections are separated by rules and whitespace, figures sit in a ruled strip, and deltas are colored by the party they move toward (blue toward Democrats, red toward Republicans). Rating colors were checked with a color-vision-deficiency validator.

## Running locally

```sh
npm install                 # dev deps only (TopoJSON tooling for build:geo)
node ingest/build.js        # writes public/data/latest.json, history/<date>.json, series.json
npm run serve               # http://localhost:8787
npm test
```

`node ingest/build.js --dry-run` fetches everything without writing.

## Automation

`.github/workflows/daily.yml` runs at 12:00 UTC daily (7 am Central), commits `public/data/`, and pushes; Vercel redeploys from the push. Trigger it manually from the Actions tab with "Run workflow".

## Adding a race or source

- Texas races: `ingest/config.js` → `TEXAS_STATEWIDE_RACES` (Wikipedia page, candidates, VoteHub type, market ids).
- Senate market ids: `SENATE_MARKETS`.
- New data source: add a module in `ingest/sources/`, call it from `ingest/build.js` under `guard()` so a failure degrades gracefully.

## License

MIT. Wikipedia-derived data is CC BY-SA 4.0; market data belongs to the respective exchanges.
