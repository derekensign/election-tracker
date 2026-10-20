// Early-vote turnout by county, compared against past Texas elections.
//
// Texas has no party registration, so nobody can say who early voters voted for. What the county counts
// do show is WHERE the ballots are coming from. The "geography lean" asks: if every county voted exactly as
// it did in a past election, what statewide margin would the ballots cast so far add up to? It is computed
// against three baselines: 2024 president (Trump-Harris), 2022 governor (Abbott-O'Rourke), and 2018 U.S. Senate
// (Cruz-O'Rourke). It is a turnout signal, not a vote count.
//
// Two guards keep it honest early on:
// - Like-for-like baseline. Counties report on different schedules (some post mail ballots daily, many post
//   nothing for days), so the comparison is against the past margin of the counties that HAVE reported,
//   weighted by their past vote totals. Otherwise "which counties have reported" masquerades as a shift.
// - Readiness. Until in-person voting is broadly reported, the mix is mostly mail ballots, whose geography
//   is different. `readable` stays false until at least READABLE_MIN_COUNTIES report in-person votes and
//   in-person ballots are at least READABLE_MIN_IN_PERSON_SHARE of the total.
//
// Days still in progress are left out. The SOS file for a date fills in as counties upload, mostly overnight,
// so on the run date itself the in-person count is far from complete. The 2018 pages it is compared with were
// end-of-day totals. Only report dates before `asOf` count, unless no earlier report exists yet.
//
// Pace against 2018 uses the SOS's 2018 daily reports, which cover only the 30 largest counties, so that
// comparison sums the same 30 counties in 2026 and lines days up by in-person early-voting day number.
export const READABLE_MIN_COUNTIES = 200;
export const READABLE_MIN_IN_PERSON_SHARE = 0.5;
const DAY_MS = 86_400_000;

/** County names differ in spacing and case across sources ("DE WITT", "DeWitt"); compare on letters only. */
export function countyKey(name) { return String(name).toUpperCase().replace(/[^A-Z]/g, ""); }

/**
 * Weighted average of county margins: Σ weight_c × margin_c / Σ weight_c.
 * @param {Array<{ ballots: number, margin: number|null }>} counties `ballots` is the weight
 * @returns {number|null} D-minus-R points, or null when nothing has weight
 */
export function geographyLean(counties) {
  let weightedMarginSum = 0, weightSum = 0;
  for (const county of counties) {
    if (county.margin == null || !county.ballots) continue;
    weightedMarginSum += county.ballots * county.margin;
    weightSum += county.ballots;
  }
  return weightSum ? Math.round((weightedMarginSum / weightSum) * 10) / 10 : null;
}

/**
 * Lean of the ballots so far against one past election, and that election's result in the same counties.
 * @param {Array<{ ballots: number, past: Record<string, { margin: number, total: number }|undefined> }>} counties
 * @param {string} electionId
 */
export function geographyAgainst(counties, electionId) {
  const lean = geographyLean(counties.map((c) => ({ ballots: c.ballots, margin: c.past[electionId]?.margin ?? null })));
  // Like-for-like: only counties with 2026 ballots, weighted by their own past vote totals.
  const reportingBaseline = geographyLean(counties.filter((c) => c.ballots > 0).map((c) => ({ ballots: c.past[electionId]?.total ?? 0, margin: c.past[electionId]?.margin ?? null })));
  const shift = lean == null || reportingBaseline == null ? null : Math.round((lean - reportingBaseline) * 10) / 10;
  return { lean, reportingBaseline, shift };
}

/** Whether the early vote is broad enough that its geography means something. */
export function isReadable({ countiesWithInPerson, inPerson, ballots }) {
  return countiesWithInPerson >= READABLE_MIN_COUNTIES && ballots > 0 && inPerson / ballots >= READABLE_MIN_IN_PERSON_SHARE;
}

/** In-person early-voting day number for a date: the first in-person day is day 1; earlier dates are ≤ 0. */
export function earlyVotingDayNumber(date, firstInPersonDay) {
  return Math.round((Date.parse(date) - Date.parse(firstInPersonDay)) / DAY_MS) + 1;
}

/**
 * Build the early-vote section of the snapshot.
 * @param {{ reports: Array<{ date: string, updated: string|null, counties: Array<object> }>, earlyVotingDates: string[], electionName: string }} turnout
 * @param {{ elections: Record<string, { label: string, democrat: string, republican: string, statewide: { margin: number, total: number }, counties: Array<{ name: string, key: string, margin: number, total: number }> }> }} baselines
 * @param {{ firstInPersonDay: string, countyKeys: string[], days: Array<{ date: string, dayNumber: number, total: { ballots: number, registered: number }, counties: Array<{ key: string, ballots: number }> }> }|null} benchmark2018
 * @param {{ firstInPersonDay?: string, asOf?: string|null }} [options] asOf: the run date; reports on or after it are in progress
 */
export function buildEarlyVote(turnout, baselines, benchmark2018 = null, { firstInPersonDay = "2026-10-19", asOf = null } = {}) {
  const completeReports = asOf ? turnout.reports.filter((report) => report.date < asOf) : turnout.reports;
  const reports = completeReports.length ? completeReports : turnout.reports;
  const latestReport = reports[reports.length - 1];
  if (!latestReport) return null;
  const electionIds = Object.keys(baselines.elections).sort().reverse(); // newest first: 2024, 2022, 2018
  const baselineByElection = Object.fromEntries(electionIds.map((id) => [id, new Map(baselines.elections[id].counties.map((c) => [c.key, c]))]));
  const benchmarkKeys = new Set(benchmark2018?.countyKeys ?? []);

  // Join a report's counties to every past result once, so the daily series and the latest view agree.
  const joinCounties = (report) => report.counties.map((county) => {
    const key = countyKey(county.name);
    const past = Object.fromEntries(electionIds.map((id) => [id, baselineByElection[id].get(key)]));
    const displayName = past[electionIds[0]]?.name ?? county.name;
    return { ...county, key, displayName, ballots: (county.inPerson || 0) + (county.mail || 0), past };
  });

  const daily = reports.map((report) => {
    const counties = joinCounties(report);
    const sum = (rows, field) => rows.reduce((total, county) => total + (county[field] || 0), 0);
    const day = {
      date: report.date,
      dayNumber: earlyVotingDayNumber(report.date, firstInPersonDay),
      inPerson: sum(counties, "inPerson"), mail: sum(counties, "mail"), ballots: sum(counties, "ballots"),
      inPersonOnDate: sum(counties, "inPersonOnDate"),
      countiesReporting: counties.filter((c) => c.ballots > 0).length,
      countiesWithInPerson: counties.filter((c) => c.inPerson > 0).length,
      geography: Object.fromEntries(electionIds.map((id) => [id, geographyAgainst(counties, id)])),
    };
    day.readable = isReadable(day);
    // Same 30 counties, same in-person day number, 2018 against 2026.
    const benchmarkDay = day.dayNumber >= 1 ? benchmark2018?.days?.[day.dayNumber - 1] : null;
    if (benchmarkDay) {
      const largestCounties = counties.filter((c) => benchmarkKeys.has(c.key));
      const ballots = sum(largestCounties, "ballots"), registered = sum(largestCounties, "registered");
      day.pace2018 = {
        dayNumber: day.dayNumber, date2018: benchmarkDay.date,
        ballots2026: ballots, ballots2018: benchmarkDay.total.ballots,
        ratio: round4(ballots / benchmarkDay.total.ballots),
        // Texas added registered voters since 2018, so also compare turnout as a share of registered.
        shareOfRegistered2026: registered ? round4(ballots / registered) : null,
        shareOfRegistered2018: round4(benchmarkDay.total.ballots / benchmarkDay.total.registered),
      };
    }
    return day;
  });

  const latestCounties = joinCounties(latestReport);
  const latestDay = daily[daily.length - 1];
  const registered = latestCounties.reduce((total, county) => total + (county.registered || 0), 0);
  const benchmarkLatest = latestDay.pace2018 ? new Map(benchmark2018.days[latestDay.pace2018.dayNumber - 1].counties.map((c) => [c.key, c.ballots])) : null;

  return {
    source: "Texas Secretary of State, Early Voting Turnout (unofficial, as reported by counties)",
    sourceUrl: "https://goelect.txelections.civixapps.com/ivis-evr-ui/evr",
    electionName: turnout.electionName,
    reportDate: latestReport.date,
    updated: latestReport.updated,
    // True only when every report is still in progress (the very first run of early voting).
    inProgress: !completeReports.length && Boolean(asOf),
    earlyVotingDates: turnout.earlyVotingDates,
    firstInPersonDay,
    registered,
    elections: Object.fromEntries(electionIds.map((id) => {
      const { label, office, democrat, republican, statewide } = baselines.elections[id];
      return [id, { label, office, democrat, republican, margin: statewide.margin, total: statewide.total }];
    })),
    totals: {
      ballots: latestDay.ballots, inPerson: latestDay.inPerson, mail: latestDay.mail,
      shareOfRegistered: registered ? round4(latestDay.ballots / registered) : null,
      shareOfPastTotal: Object.fromEntries(electionIds.map((id) => [id, round4(latestDay.ballots / baselines.elections[id].statewide.total)])),
    },
    geography: {
      readable: latestDay.readable,
      countiesReporting: latestDay.countiesReporting,
      countiesWithInPerson: latestDay.countiesWithInPerson,
      readableRule: { minCountiesWithInPerson: READABLE_MIN_COUNTIES, minInPersonShare: READABLE_MIN_IN_PERSON_SHARE },
      byElection: latestDay.geography, // positive shift: ballots come from the bluer of the reporting counties
    },
    pace2018: latestDay.pace2018 ?? null,
    // The full 2018 curve (cumulative ballots in the 30 counties on in-person days 1 to 12), for the chart.
    benchmark2018: benchmark2018 ? { firstInPersonDay: benchmark2018.firstInPersonDay, counties: benchmark2018.countyKeys.length, cumulativeBallots: benchmark2018.days.map((d) => d.total.ballots) } : null,
    daily,
    counties: latestCounties
      .map((county) => ({
        name: county.displayName, registered: county.registered, inPerson: county.inPerson, mail: county.mail, ballots: county.ballots,
        shareOfRegistered: county.registered ? round4(county.ballots / county.registered) : null,
        past: Object.fromEntries(electionIds.map((id) => [id, county.past[id] ? { margin: county.past[id].margin, total: county.past[id].total, share: round4(county.ballots / county.past[id].total) } : null])),
        sameDay2018: benchmarkLatest?.get(county.key) ?? null,
      }))
      .sort((a, b) => b.ballots - a.ballots),
    unmatchedCounties: latestCounties.filter((county) => electionIds.some((id) => !county.past[id])).map((county) => county.name),
  };
}

function round4(value) { return Math.round(value * 10000) / 10000; }
