// Big Texas counties' own election-night results, read directly because the Secretary of State's feed lags them: at
// 8 p.m. Central on election night the state still had Williamson and Galveston at zero while their own sites had
// posted their early votes. Each county's file becomes the needle's county return (ingest/needle.js) and stands in
// for the state's when it has more votes.
//
// Counties post early and mail votes first. Until Election Day precincts report, every vote counted is an early vote;
// that snapshot is kept, and once precincts report the rest of the count is Election Day votes. The county files
// don't split votes by type, so this is how the needle's early and Election Day cells stay apart.

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
  for (const race of races) {
    const contest = contests.find((c) => RACE_PATTERNS[race.id]?.test(c.name));
    if (!contest) continue;
    const votesFor = (name) => contest.choices.find((choice) => lastName(choice.name) === lastName(name))?.votes ?? 0;
    const d = votesFor(race.democrat), r = votesFor(race.republican), total = contest.choices.reduce((t, c) => t + c.votes, 0);
    if (!total) continue;
    let earlyPart;
    if (contest.reporting === 0) earlyPart = [total, d, r];
    else if (earlySnapshot?.[race.id]) earlyPart = earlySnapshot[race.id];
    else {
      const votes = Math.min(total, Math.round(county.early * 0.985));
      earlyPart = [votes, Math.round((d * votes) / total), Math.round((r * votes) / total)];
    }
    result.races[race.id] = [earlyPart[0], earlyPart[1], earlyPart[2], total, d, r];
    if (contest.reporting === 0) early[race.id] = earlyPart;
    if (race.id === "tx-senate") {
      result.dayReporting = contest.total ? Math.min(1, contest.reporting / contest.total) : 0;
      result.ballots = contest.ballots || total;
    }
  }
  return { result, early: Object.keys(early).length ? early : null };
}

/** A Clarity election's summary: the current version (tiny, never cached), then that version's file. */
const clarity = (base) => async (get) => parseClarityCounty(await get(`${base}/${(await get(`${base}/current_ver.txt`)).trim()}/json/en/summary.json`));

/** Counties whose own results the recorder reads, by the needle's county key. */
export const TEXAS_COUNTY_SOURCES = {
  TRAVIS: { label: "Travis County Clerk", url: "https://results.enr.clarityelections.com/TX/Travis/127492/", read: clarity("https://results.enr.clarityelections.com/TX/Travis/127492") },
  WILLIAMSON: { label: "Williamson County Elections", url: "https://results.enr.clarityelections.com/TX/Williamson/127488/", read: clarity("https://results.enr.clarityelections.com/TX/Williamson/127488") },
  GALVESTON: { label: "Galveston County Clerk", url: "https://results.enr.clarityelections.com/TX/Galveston/127478/", read: clarity("https://results.enr.clarityelections.com/TX/Galveston/127478") },
  ELPASO: { label: "El Paso County Elections", url: "https://results.enr.clarityelections.com/TX/El_Paso/127348/", read: clarity("https://results.enr.clarityelections.com/TX/El_Paso/127348") },
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
