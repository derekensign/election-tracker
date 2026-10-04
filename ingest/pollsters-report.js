// Pollster scorecard: every pollster seen across the tracked races, with grade, volume, latest poll, and house lean.
import { ratePollster } from "./pollsters.js";

/** Collapse the spelling variants Wikipedia and VoteHub use for the same shop. */
export function canonicalPollsterName(name) {
  const cleaned = (name || "unknown").replace(/\s*\((R|D|I)\)\s*/g, " ").replace(/\s+/g, " ").trim();
  const lower = cleaned.toLowerCase();
  if (/texas southern/.test(lower)) return "Texas Southern University";
  if (/texas politics project|university of texas\/texas tribune/.test(lower)) return "University of Texas/Texas Politics Project";
  if (/new york times\/siena|nyt\/siena/.test(lower)) return "New York Times/Siena";
  if (/beacon research\s*\/\s*shaw/.test(lower)) return "Fox News (Beacon/Shaw)";
  if (/^yougov/.test(lower) && !/\//.test(lower)) return "YouGov";
  return cleaned.replace(/ University$/i, "").replace(/Siena University/i, "Siena College");
}

export function buildPollsterReport(snapshot) {
  const rows = new Map();
  const add = (poll, raceLabel, raceAverage, scope) => {
    const key = canonicalPollsterName(poll.pollster);
    if (!rows.has(key)) {
      const rating = ratePollster(key);
      rows.set(key, { pollster: key, grade: rating.grade, numericGrade: rating.numericGrade, ratedAs: rating.matched ? rating.pollster : null, pollscore: rating.pollscore, transparency: rating.transparency, polls: 0, texasPolls: 0, partisanPolls: 0, deviations: [], races: new Set(), latest: null });
    }
    const row = rows.get(key);
    row.polls += 1;
    if (scope === "texas") row.texasPolls += 1;
    if (poll.partisan || poll.internal) row.partisanPolls += 1;
    row.races.add(raceLabel);
    if (raceAverage?.margin !== null && raceAverage?.margin !== undefined) row.deviations.push(poll.dem - poll.rep - raceAverage.margin);
    if (!row.latest || (poll.endDate || "") > (row.latest.endDate || "")) row.latest = { race: raceLabel, endDate: poll.endDate, margin: Math.round((poll.dem - poll.rep) * 10) / 10, partisan: poll.partisan || null };
  };
  for (const race of snapshot.texas.races) for (const poll of race.polls || []) add(poll, `TX ${race.office}`, race.pollingAverage, "texas");
  for (const race of snapshot.usSenate.races) for (const poll of race.polls || []) add(poll, `${race.state} Senate`, race.pollingAverage, race.state === "TX" ? "texas" : "national");
  for (const district of snapshot.usHouse?.districts || []) for (const poll of district.polls || []) add(poll, district.id, district.pollingAverage, district.state === "TX" ? "texas" : "national");
  for (const poll of snapshot.txLegislature?.genericBallot?.polls || []) add(poll, "TX legislative generic ballot", snapshot.txLegislature.genericBallot.average, "texas");
  for (const poll of snapshot.usHouse?.genericBallot?.polls || []) add(poll, "Generic congressional ballot", snapshot.usHouse.genericBallot.average, "national");
  return [...rows.values()].map((row) => ({
    ...row,
    races: [...row.races].sort(),
    // House lean: mean signed deviation of the pollster's margins from each race's quality-weighted average (D-positive).
    lean: row.deviations.length ? Math.round((row.deviations.reduce((a, b) => a + b, 0) / row.deviations.length) * 10) / 10 : null,
    deviations: undefined,
  })).sort((a, b) => b.texasPolls - a.texasPolls || b.polls - a.polls || a.pollster.localeCompare(b.pollster));
}
