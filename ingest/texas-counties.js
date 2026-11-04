// Big Texas counties' own election-night results, read directly because the Secretary of State's feed lags them: at
// 8 p.m. Central on election night the state still had Williamson and Galveston at zero while their own sites had
// posted their early votes. Each county's file becomes the needle's county return (ingest/needle.js) and stands in
// for the state's when it has more votes.
//
// Harris's, LiveVoterTurnout's, and Montgomery's files split each candidate's votes into mail, early, and Election Day.
// Clarity's summaries don't, so for those counties: while the count is no bigger than the county's early vote (from
// the state's turnout report), every vote counted is an early vote; that snapshot is kept, and the rest of the count
// after it is Election Day votes. That's how the needle's early and Election Day cells stay apart.

import { parseWikipediaWinner } from "./senate-returns.js";

/** Contest names for the needle's races, as counties write them. */
const RACE_PATTERNS = {
  "tx-senate": /^(united states|u\.?\s*s\.?)\s+senat/i,
  "tx-governor": /^governor$/i,
  "tx-ltgov": /^lieutenant governor$/i,
  "tx-ag": /^attorney general$/i,
  "tx-comptroller": /^comptroller/i,
  "tx-land": /general land office|land commissioner/i,
  "tx-agriculture": /agriculture/i,
  "tx-railroad": /railroad/i,
};

/** Last name, lowercased, without suffixes or punctuation. */
function lastName(name) {
  const text = String(name || "");
  const surname = text.includes(",") ? text.slice(0, text.indexOf(",")) : text;
  const tokens = surname.toLowerCase().replace(/[^a-z\s'-]/g, " ").split(/\s+/).filter((t) => t && !["jr", "sr", "ii", "iii", "iv"].includes(t));
  return tokens.at(-1) ?? "";
}

/** A Clarity county's summary.json: each contest's name, choices with votes, precincts reporting, and ballots. */
export function parseClarityCounty(text) {
  return JSON.parse(text.replace(/^﻿/, "")).map((contest) => ({
    name: String(contest.C || "").trim(),
    choices: (contest.CH || []).map((name, i) => ({ name: String(name).replace(/\s*\([A-Z]{2,4}\)\s*$/, "").replace(/^(DEM|REP|LIB|GRN|IND)\s+/, "").trim(), votes: Number(contest.V?.[i]) || 0 })),
    reporting: Number(contest.PR) || 0,
    total: Number(contest.TP) || 0,
    ballots: Number(contest.BC) || 0,
  }));
}

const number = (value) => Number(String(value ?? "").replace(/[,%\s]/g, "")) || 0;
const cleanName = (name) => String(name).replace(/\s*\([A-Z]{1,4}\)\s*$/, "").replace(/^(DEM|REP|LIB|GRN|IND)\s+/, "").trim();

/** Harris County's resultsbyballot.json: mail (ab), early (ev), and total (tv) votes per candidate; vote centers in. */
export function parseHarris(text) {
  const data = JSON.parse(text.replace(/^﻿/, ""));
  return (data.contests || []).map((contest) => ({
    name: String(contest.t || "").trim(),
    choices: (contest.ca || []).map((name, i) => ({ name: cleanName(name), votes: number(contest.tv?.[i]), early: number(contest.ab?.[i]) + number(contest.ev?.[i]) })),
    reporting: number(data.vc), total: number(data.vt), ballots: number(data.bc),
  }));
}

/** LiveVoterTurnout's summary XML (Cameron, Ellis): a <Table> per candidate with early, mail, and Election Day votes. */
export function parseLiveVoterTurnout(xml) {
  const field = (row, name) => row.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? "";
  const contests = new Map();
  for (const [, row] of xml.matchAll(/<Table>([\s\S]*?)<\/Table>/g)) {
    const name = field(row, "RaceName").trim();
    const contest = contests.get(name) ?? { name, choices: [], reporting: 0, total: 0, ballots: 0 };
    const early = number(field(row, "EarlyVotingVotes")) + number(field(row, "MailBallotsVotes")) + number(field(row, "AbsenteeVotes"));
    contest.choices.push({ name: cleanName(field(row, "ContestantName")), votes: number(field(row, "TotalVotes")), early });
    contests.set(name, contest);
  }
  return [...contests.values()];
}

/** Montgomery County's eResults page: candidate rows numbered in order, each contest's title on its first row. */
export function parseMontgomery(html) {
  const cell = (id) => html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`))?.[1]?.trim() ?? null;
  const contests = [];
  for (let n = 0; cell(`rptCandidates_txtCandName2_${n}`) !== null; n += 1) {
    const title = cell(`rptCandidates_ContestTitle2_${n}`);
    if (title || !contests.length) contests.push({ name: title || "", choices: [], reporting: 0, total: 0, ballots: 0 });
    contests.at(-1).choices.push({
      name: cleanName(cell(`rptCandidates_txtCandName2_${n}`)), votes: number(cell(`rptCandidates_txtTotalVotes2_${n}`)),
      early: number(cell(`rptCandidates_txtABSVotes_${n}`)) + number(cell(`rptCandidates_txtEVVotes2_${n}`)),
    });
  }
  return contests;
}

/**
 * One county's contests as the needle's return for it: per race [early votes, early D, early R, total votes, total D,
 * total R], Election Day progress (precincts reporting), and ballots. `earlySnapshot` is the county's early vote from
 * its last read before precincts reported ({ raceId: [votes, D, R] }); without one, the early vote is estimated from
 * the turnout report with the count's own margin.
 * @param {{ name: string, early: number }} county the needle's county input
 * @param {ReturnType<typeof parseClarityCounty>} contests
 * @param {{ id: string, democrat: string, republican: string }[]} races the needle's races
 */
export function countyReturnFromContests(county, contests, races, earlySnapshot = null) {
  const result = { name: county.name, dayReporting: 0, ballots: 0, races: {} };
  const early = {};
  const contestFor = (race) => contests.find((c) => RACE_PATTERNS[race.id]?.test(c.name));
  // Whether the count is still all early votes, judged on the top race against the county's early turnout: some
  // counties (Bexar) mark precincts as reporting for their early votes, so precincts alone can't tell.
  const top = contestFor(races[0]);
  const topTotal = top ? top.choices.reduce((t, c) => t + c.votes, 0) : 0;
  const split = Boolean(top?.choices.some((c) => c.early != null));
  const allEarly = !split && topTotal <= county.early * 0.985 * 1.02;
  for (const race of races) {
    const contest = contestFor(race);
    if (!contest) continue;
    const find = (name) => contest.choices.find((choice) => lastName(choice.name) === lastName(name));
    const dChoice = find(race.democrat), rChoice = find(race.republican);
    const d = dChoice?.votes ?? 0, r = rChoice?.votes ?? 0, total = contest.choices.reduce((t, c) => t + c.votes, 0);
    if (!total) continue;
    let earlyPart;
    if (split) earlyPart = [contest.choices.reduce((t, c) => t + (c.early ?? 0), 0), dChoice?.early ?? 0, rChoice?.early ?? 0];
    else if (allEarly) earlyPart = [total, d, r];
    else if (earlySnapshot?.[race.id]) earlyPart = earlySnapshot[race.id];
    else {
      const votes = Math.min(total, Math.round(county.early * 0.985));
      earlyPart = [votes, Math.round((d * votes) / total), Math.round((r * votes) / total)];
    }
    result.races[race.id] = [earlyPart[0], earlyPart[1], earlyPart[2], total, d, r];
    if (allEarly) early[race.id] = earlyPart;
    if (race.id === races[0].id) {
      result.dayReporting = allEarly || !contest.total ? 0 : Math.min(1, contest.reporting / contest.total);
      result.ballots = contest.ballots || total;
    }
  }
  return { result, early: Object.keys(early).length ? early : null };
}

/** A Clarity election's summary: the current version (tiny, never cached), then that version's file. */
const clarity = (base) => async (get) => parseClarityCounty(await get(`${base}/${(await get(`${base}/current_ver.txt`)).trim()}/json/en/summary.json`));
const CLARITY = "https://results.enr.clarityelections.com";
// Clarity's CDN keeps serving a cached 502 for a busy county's usual path on election night; the same path with a
// doubled slash skips that cache and answers.
const clarityCounty = (label, path) => ({ label, url: `${CLARITY}/${path}/`, read: clarity(`${CLARITY}//${path}`) });
const minuteStamp = () => Math.floor(Date.now() / 60_000) * 60_000;

/** Counties whose own results the recorder reads, by the needle's county key. */
export const TEXAS_COUNTY_SOURCES = {
  HARRIS: { label: "Harris County Clerk", url: "https://www.harrisvotes.com/Election-Results/Live-Results", read: async (get) => parseHarris(await get(`https://appfiles.harrisvotes.com/harrisvotes/prd/Data/1126/resultsbyballot.json?nocache=${minuteStamp()}`)) },
  TARRANT: clarityCounty("Tarrant County Elections", "TX/Tarrant/127297"),
  BEXAR: clarityCounty("Bexar County Elections", "TX/Bexar/127291"),
  TRAVIS: clarityCounty("Travis County Clerk", "TX/Travis/127492"),
  FORTBEND: clarityCounty("Fort Bend County Elections", "TX/Fort_Bend/127480"),
  ELPASO: clarityCounty("El Paso County Elections", "TX/El_Paso/127348"),
  WILLIAMSON: clarityCounty("Williamson County Elections", "TX/Williamson/127488"),
  HIDALGO: clarityCounty("Hidalgo County Elections", "TX/Hidalgo/127350"),
  MONTGOMERY: { label: "Montgomery County Elections", url: "https://elections.mctx.org/", read: async (get) => parseMontgomery(await get("https://elections.mctx.org/electioninfo/eResults.aspx?ElectionId=GEN110326")) },
  GALVESTON: clarityCounty("Galveston County Clerk", "TX/Galveston/127478"),
  BELL: clarityCounty("Bell County Elections", "TX/Bell/127475"),
  CAMERON: { label: "Cameron County Elections", url: "https://www.livevoterturnout.com/ENR/camerontxenr/46/en/Index_46.html", read: async (get) => parseLiveVoterTurnout(await get("https://www.livevoterturnout.com/ENR/camerontxenr/46/summary_46.xml")) },
  ELLIS: { label: "Ellis County Elections", url: "https://www.livevoterturnout.com/ENR/ellistxenr/11/en/Index_11.html", read: async (get) => parseLiveVoterTurnout(await get("https://www.livevoterturnout.com/ENR/ellistxenr/11/summary_11.xml")) },
  MIDLAND: clarityCounty("Midland County Elections", "TX/Midland/127299"),
};

/**
 * The state's returns with each county's own count in place of the state's when the county's has more votes in the
 * top race. Returns the merged returns, the updated early snapshots, and which counties came from their own sites.
 * @param {Record<string, object>} returns the state's county returns (fetchCountyReturns)
 * @param {Record<string, Awaited<ReturnType<typeof countyReturnFromContests>>["result"]>} sites county returns from their own files
 */
export function mergeCountyReturns(returns, sites) {
  const merged = { ...returns }, used = [];
  for (const [key, site] of Object.entries(sites)) {
    const stateVotes = returns[key]?.races?.["tx-senate"]?.[3] ?? 0, siteVotes = site.races?.["tx-senate"]?.[3] ?? 0;
    if (siteVotes > stateVotes) { merged[key] = site; used.push(key); }
  }
  return { returns: merged, used };
}

/**
 * Calls for the Texas statewide races, from each race's Wikipedia page: editors fill its infobox's winner when the
 * networks call it. Pages that don't exist (some down-ballot races have none) are skipped; those races can be
 * called by hand in public/data/texas-calls.json.
 */
export const TEXAS_RACE_PAGES = {
  "tx-senate": "2026 United States Senate election in Texas",
  "tx-governor": "2026 Texas gubernatorial election",
  "tx-ltgov": "2026 Texas lieutenant gubernatorial election",
  "tx-ag": "2026 Texas Attorney General election",
  "tx-comptroller": "2026 Texas Comptroller of Public Accounts election",
  "tx-land": "2026 Texas Land Commissioner election",
  "tx-agriculture": "2026 Texas Agriculture Commissioner election",
  "tx-railroad": "2026 Texas Railroad Commission election",
};

/** The Wikipedia API URL for those pages' lead sections, where the infobox is. */
export function texasCallsUrl() {
  const titles = Object.values(TEXAS_RACE_PAGES).join("|");
  return `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&rvsection=0&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(titles)}`;
}

/**
 * The races called, by race ID: the pages' winners (matched to the race's candidates by last name), then the
 * site's manual calls on top ({ "tx-railroad": "D" }, or "none" to withdraw one).
 * @param {{ id: string, democrat: string, republican: string }[]} races
 */
export function texasRaceCalls(races, apiResponse, overrides = {}) {
  const raceByTitle = new Map(races.map((race) => [TEXAS_RACE_PAGES[race.id], race]));
  const calls = {};
  for (const page of apiResponse?.query?.pages ?? []) {
    const race = raceByTitle.get(page.title);
    const winner = race ? parseWikipediaWinner(page.revisions?.[0]?.slots?.main?.content ?? "") : null;
    if (!winner) continue;
    const party = lastName(winner.name) === lastName(race.democrat) ? "D" : lastName(winner.name) === lastName(race.republican) ? "R" : winner.party;
    calls[race.id] = { winner: party, name: winner.name, via: "Wikipedia" };
  }
  for (const [id, value] of Object.entries(overrides || {})) {
    if (id.startsWith("_")) continue;
    const race = races.find((r) => r.id === id);
    if (!race) continue;
    if (value === "none" || value === null) delete calls[id];
    else if (value === "D" || value === "R") calls[id] = { winner: value, name: value === "D" ? race.democrat : race.republican, via: "manual" };
  }
  return calls;
}
