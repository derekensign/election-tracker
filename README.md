# Texas Polls Tracker

A static dashboard, refreshed every morning, for the 2026 Texas statewide races, the Texas Legislature, and the national U.S. Senate and House. It shows polls, forecaster ratings, and seat-distribution forecasts from a quality-weighted polling model, and highlights what moved since the previous day. Prediction markets are deliberately not used.

Live site: **https://texas-race-tracker.vercel.app** (Vercel, auto-deploys from `main`). Data snapshots are committed to `public/data/` by a GitHub Actions cron.

## What it tracks

| Section | Content |
|---|---|
| What moved | Rating changes, poll-model moves ≥ 3 pts, new polls, polling-average moves ≥ 1 pt, control-odds moves, since the previous snapshot |
| Hero board | Texas U.S. Senate, Texas Governor, and U.S. Senate control as split probability bars under the selected model |
| Election night (`#election-night`) | Live needles for all eight Texas statewide races from the Secretary of State's county returns; win chance and projected margin through the night with annotated moves; counties to watch against 2022 and 2024. The default tab from 6 p.m. Central on November 3 |
| U.S. Senate control | Current 47 D-caucus / 53 R; polls-model Poisson-binomial seat distribution and control odds |
| U.S. Senate map | All 35 seats shaded by the average of ten forecasters (Cook, DDHQ, Economist, FiftyPlusOne, Fox, Inside Elections, RCP, Sabato, Silver Bulletin, Split Ticket); battleground table with polls, model odds, and trends |
| Texas statewide | Senate, Governor, Lt. Governor, AG, Comptroller, Railroad Commissioner, Land Commissioner, Agriculture Commissioner: polling average, latest poll, ratings, polls-model odds, per-race poll lists and published aggregates |
| U.S. House | National competitive-district ratings (ten forecasters, ~144 seats), our rated-seat model for control and expected seats, the generic congressional ballot (VoteHub polls plus published aggregates), and a zoomable Texas congressional map (2025 Plan C2333) with ratings for all 38 districts and district polls where they exist |
| Governors | All 36 governorships: Wikipedia ratings table (seven forecasters), candidates from the race summary, VoteHub polls, polls model, map and tables |
| Texas courts and SBOE | Supreme Court, Court of Criminal Appeals, and State Board of Education nominees; a statewide-environment baseline for judicial seats |
| Early vote | Daily early-vote turnout for all 254 counties from the Texas Secretary of State's public Early Voting Turnout report, compared with each county's 2024 presidential result (`ingest/early-vote.js`), and against the March 2026 primaries: where early ballots come from by each county's Democratic share of primary ballots, and early ballots per primary voter by county type |
| Morning digest | Templated daily briefing with an archive and copy-as-text; `public/data/digest.txt` is the plain-text version for a future chat or email post |
| Scenarios | Browser-side re-runs of the Texas Legislature, U.S. Senate, and U.S. House models with sliders for environment, elasticity, incumbency, rating weight, and uniform polling error |
| Trends | Daily series for the marquee numbers plus a dated log of every rating and model change |
| Pollsters | Scorecard: 538 grade, volume, house lean against the race averages, latest poll |
| Texas House / Senate | Our own seat model (fundamentals + statewide environment + incumbency, blended with State Navigate ratings), chamber seat distributions and control odds, zoomable district maps (TLC plans H2316 / S2168) colored by model probability, rating, or 2024 margin; the legislative generic-ballot poll table |

## Sources

- **VoteHub** public polls feed: Senate, governor, and attorney-general polls nationwide.
- **Wikipedia** (CC BY-SA 4.0) via the MediaWiki API: the national Senate and governor ratings and race-summary tables (ratings and candidates), the House ratings page, each Texas race's Predictions and Polling tables (including aggregator averages from 270toWin, RCP, DDHQ, Silver Bulletin, FiftyPlusOne, Texas Tribune), the Texas congressional, Supreme Court, and SBOE pages, and the Texas House / Senate by-district and competitive-district tables.
- **Texas Legislative Council** district plans (public domain), converted to TopoJSON once with `npm run build:geo`.
- **Texas Secretary of State election-night results**: live county returns for the election-night needle, and the certified March 2026 primaries by county (`public/data/tx-primaries-2026.json`, built once by `node scripts/build-primaries-2026.mjs`; ballots per primary are the votes in each county's most-voted statewide race, since the file's own votes-cast field is wrong in places).
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

## Early vote data

Early-vote counts come from the file service behind the SOS "Early Voting Turnout (current)" app (`ingest/sources/sos-early-vote.js`). Only county totals are read; the voter-by-voter roster the same service offers is never requested. The 2024 county baseline in `public/data/tx-county-2024.json` is built once by `node scripts/build-county-baseline.mjs`. The older SOS site at earlyvoting.texas-election.com is behind a bot wall and is not used.

## Election-night needle

`ingest/needle.js` projects each statewide race from partial county returns. It is pure JavaScript, published to `public/model/` like the Scenarios models, so the recorder and the browser get identical numbers from identical inputs.

- **Model.** Each county's early and Election Day votes are modeled separately. A county's prior is its usual lean (2022 governor 45%, 2024 president 35%, 2018 Senate 20%, relative to the state), shifted so the turnout-weighted state equals the final polling average plus half of the early-vote turnout mix (how much bluer the 2026 expected electorate's geography is than 2022's, about 2.4 points); with nothing counted the needle is the polls model moved by that mix. Returns teach eight shared effects in closed form: the statewide miss from the polls (Student-t, calibrated to the polls model), five regional swings, how much each county's 2022-to-2024 shift reverses, and how differently Election Day votes break from early votes. County deviations are fat-tailed (reweighted Student-t), partial counts carry batch and vote-count noise, and an extra ±3-point cushion on the uncounted vote keeps it from being sure too early. Expected votes are each county's early ballots (from the turnout report) plus Election Day at 35% of early, learned by region as counties finish.
- **Annotations.** The first returns, any update that moves the needle 8 points, and slower drifts of 20 points become events, explained by the counties whose new votes moved the projection most.
- **Data.** `goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr/election/countyInfo/53815` (the feed behind results.texas-election.com): every county, every race, early votes broken out, polling places reported. `ingest/sources/sos-results.js` reads it.
- **Recorder.** `ingest/needle-record.js` polls every two minutes and commits `needle.json` (inputs, a point per race per change, events, latest returns) to the `needle-data` branch, which Vercel does not build (`git.deploymentEnabled`). The page reads it from raw.githubusercontent.com (about a five-minute CDN cache). `.github/workflows/needle.yml` starts it at 6:20 pm Central on November 3, with two backup starts; a restarted run resumes from `needle.json`. Start it by hand with `gh workflow run needle.yml`.
- **AWS recorder (primary).** `aws/needle-template.yaml` (stack `election-tracker-needle`, personal account, us-east-1): an EventBridge rule runs the Lambda `election-tracker-needle` every two minutes from 00:00 to 13:58 UTC on November 4 (6 pm to 8 am Central). Each run is one recorder pass (`aws/needle/index.mjs` with the ingest modules bundled unchanged) and writes `needle.json` gzipped to a public S3 object with a 20-second cache. Deploy with `AWS_PROFILE=personal ./aws/deploy-needle.sh`; test a pass with `AWS_PROFILE=personal aws lambda invoke --function-name election-tracker-needle /dev/stdout`. The page prefers it whenever its last check is under six minutes old, then the GitHub recorder (under twelve).
- **Fallback.** If both recorder files are missing or stale, the browser reads the state's feed itself every three minutes (only while the tab is visible), folds it into the recorder's history, and keeps that copy in localStorage.
- **Testing.** `node scripts/simulate-needle.mjs --seed 6` simulates a night through the real parser and model and writes `public/data/needle-demo.json` (gitignored); open `/?demo#election-night` to preview it. `--calibration 120` runs 120 nights and compares needle readings with outcomes (currently cautious: 75% readings won 85% of the time).

## Senate night

`#senate-night` tracks control of the U.S. Senate on election night. There is no free live feed of every state's returns, so it runs on race calls: the networks' calls as editors post them to Wikipedia's 2026 Senate elections page (`parseSenateCalls` reads the winner marked {{Aye}} or a "gain"/"hold"/"re-elected" result), plus manual overrides in `public/data/senate-calls.json` (set a state to D, R, I, or other, or `none` to withdraw a call, and push). Texas uses the live Texas needle.

`ingest/senate-night.js` has one national factor: each race's challenger margin is its polls-model chance turned into a margin, plus a shared polling miss (Student-t) and the state's own error. Calls are hard evidence on the shared miss and the Texas needle's statewide read is soft evidence, so a surprise call moves every race still out; the seat count is mixed over the posterior. With nothing called each race matches the polls model, but control is less certain than the U.S. Senate tab's independent-race figure. When several races are called in one check, each event shows its own effect given the others.

The Lambda `election-tracker-senate-night` (same stack as the Texas recorder, `aws/senate/index.mjs`) runs every two minutes from 22:00 UTC November 3 (the first Senate poll closings) to 13:58 UTC November 4 and writes `senate.json` beside `needle.json`. If it goes quiet, the page reads Wikipedia's API itself.

The tab also has a Senate-floor seat chart, a map, and a race table laid out like the Texas county table: each race's count so far against the last race for its seat, the 2024 presidential margin, and its polls, plus the projection and chance now. A row opens to its votes and to why its chance moved (from the per-race chances on every timeline point). Counts come from the states' official results files listed in `ingest/senate-returns.js` (`SENATE_RETURN_SOURCES`: 18 states, from Clarity, Enhanced Voting, and other formats), read by the Lambda; they're stored in `senate.json` as `returns` and shown, not modeled. Ohio and Kansas refuse requests from cloud servers, and Michigan, Kentucky, Maine, New Hampshire, Mississippi, and a few safe states have no file the site can read (`SENATE_RETURN_GAPS` says why for each). For those, and for any state whose file fails, the table shows unofficial counts from the race's Wikipedia infobox, which editors fill in from news reports through the night (one API request for every page's lead section, about 100 KB; `wikipediaReturns`). A current official file always wins (`mergeReturns`). Ohio answers a home connection, though, so a Raspberry Pi at home (the construction-cam Pi, `derekat@192.168.1.105`) relays it: `relay/pi-relay.py` (Python standard library only) runs from the Pi's user crontab every two minutes, reads Ohio's results API (and Virginia's, whose file started refusing the recorder on election night), and PUTs the responses unparsed to `relay.json` in the bucket. The bucket policy accepts that one object only from the home IP (`RelaySourceIp` in the template), so the Pi holds no AWS keys; the recorder parses it with `parseOhio` (`relayReturns`) and falls back to Wikipedia when the relay is more than six minutes old. The Pi's log is `~/election-relay/relay.log`; the script stops itself after 8 a.m. Central November 4, and `crontab -e` on the Pi removes the line. Michigan's statewide site sits behind a bot check too, so the recorder also reads six of its biggest counties' own official files (`SENATE_COUNTY_SOURCES`: Oakland, Macomb, Genesee, and Ottawa on Clarity, Ingham on Enhanced Voting, and Washtenaw's HTML page; about 36% of the state's 2024 vote) and stores their sum as `countyReturns.MI`. The page shows it as "big counties only", beside the same counties' 2024 presidential margin, never as the state's count. Wayne, Kent, and Kalamazoo turn automated readers away; Kansas's biggest counties post PDFs, so Kansas has no county count. To test reachability from the Lambda's own network: `aws lambda invoke --function-name election-tracker-senate-night --cli-binary-format raw-in-base64-out --payload '{"probe": ["https://…"]}' /dev/stdout`. Alaska's server leaves an intermediate certificate out of its handshake; `aws/senate/extra-ca.pem` supplies it through `NODE_EXTRA_CA_CERTS`. Benchmarks (each seat's last race, the 2024 presidential margin, and 2022 turnout as the baseline for the share counted) are in `public/data/senate-benchmarks.json`, compiled from Wikipedia with the sources listed in the file.

## Ask the data

The Ask tab sends each question to OpenAI with a fresh digest of the page's data (`buildAskContext` in `public/app.js`, about 10k tokens), under the instructions in `ingest/ask-prompt.js` (never call races, use only the digest). Two ways to pay for it:

- **The site's key, behind a password.** `api/ask.js` is a Vercel function that holds the key: set `OPENAI_API_KEY` and `ASK_PASSWORD` (optionally `ASK_MODEL`) in the Vercel project's environment variables and redeploy. The browser sends only the password; wrong passwords wait and get nothing; requests are size-capped and answers capped at 4,000 tokens. `GET /api/ask` reports only whether it is set up. Locally, `scripts/serve.mjs` serves the same handler (set the variables in its environment; `OPENAI_BASE_URL` points it at a stand-in for tests).
- **The visitor's own key.** Typed into the tab, kept in sessionStorage (localStorage only if remembered), and sent only to api.openai.com.

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
