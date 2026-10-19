// Early-vote turnout by county, compared against each county's 2024 presidential result.
//
// Texas has no party registration, so nobody can say who early voters voted for. What the county counts
// do show is WHERE the ballots are coming from. The "geography lean" asks: if every county voted exactly as
// it did in 2024, what statewide margin would the ballots cast so far add up to? Comparing that to the
// 2024 statewide margin shows whether this year's early vote is coming disproportionately from Democratic
// or Republican parts of the state. It is a turnout signal, not a vote count.
//
// Two guards keep it honest early on:
// - Like-for-like baseline. Counties report on different schedules (some post mail ballots daily, many post
//   nothing for days), so the comparison is against the 2024 margin of the counties that HAVE reported,
//   weighted by their 2024 vote totals. Otherwise "which counties have reported" masquerades as a shift.
// - Readiness. Until in-person voting is broadly reported, the mix is mostly mail ballots, whose geography
//   is different. `readable` stays false until at least READABLE_MIN_COUNTIES report in-person votes and
//   in-person ballots are at least READABLE_MIN_IN_PERSON_SHARE of the total.
export const READABLE_MIN_COUNTIES = 200;
export const READABLE_MIN_IN_PERSON_SHARE = 0.5;

/** County names differ in spacing and case across sources ("DE WITT", "DeWitt"); compare on letters only. */
export function countyKey(name) { return String(name).toUpperCase().replace(/[^A-Z]/g, ""); }

/**
 * Ballot-weighted average of county 2024 margins: Σ ballots_c × margin_c / Σ ballots_c.
 * @param {Array<{ ballots: number, margin2024: number|null }>} counties
 * @returns {number|null} D-minus-R points, or null when no ballots have been matched to a 2024 county
 */
export function geographyLean(counties) {
  let weightedMarginSum = 0, ballotSum = 0;
  for (const county of counties) {
    if (county.margin2024 == null || !county.ballots) continue;
    weightedMarginSum += county.ballots * county.margin2024;
    ballotSum += county.ballots;
  }
  return ballotSum ? Math.round((weightedMarginSum / ballotSum) * 10) / 10 : null;
}

/**
 * 2024 margin of only the counties that have reported any 2026 ballots, weighted by their 2024 vote totals.
 * @param {Array<{ ballots: number, margin2024: number|null, total2024: number|null }>} counties
 */
export function reportingCountiesBaseline(counties) {
  return geographyLean(counties.filter((county) => county.ballots > 0 && county.total2024).map((county) => ({ ballots: county.total2024, margin2024: county.margin2024 })));
}

/** Whether the early vote is broad enough that its geography means something. */
export function isReadable({ countiesWithInPerson, inPerson, ballots }) {
  return countiesWithInPerson >= READABLE_MIN_COUNTIES && ballots > 0 && inPerson / ballots >= READABLE_MIN_IN_PERSON_SHARE;
}

/**
 * Build the early-vote section of the snapshot from SOS reports and the 2024 county baseline.
 * @param {{ reports: Array<{ date: string, updated: string|null, counties: Array<object> }>, earlyVotingDates: string[], electionName: string }} turnout
 * @param {{ statewide: { margin: number, total: number }, counties: Array<{ name: string, key: string, margin: number, total: number }> }} baseline
 */
export function buildEarlyVote(turnout, baseline) {
  const baselineByKey = new Map(baseline.counties.map((county) => [county.key, county]));
  const latestReport = turnout.reports[turnout.reports.length - 1];
  if (!latestReport) return null;

  // Join each report's counties to their 2024 result once, so the daily series and the latest view agree.
  const joinCounties = (report) => report.counties.map((county) => {
    const result2024 = baselineByKey.get(countyKey(county.name)) ?? null;
    const ballots = (county.inPerson || 0) + (county.mail || 0);
    return { ...county, ballots, margin2024: result2024?.margin ?? null, total2024: result2024?.total ?? null, displayName: result2024?.name ?? county.name };
  });

  const daily = turnout.reports.map((report) => {
    const counties = joinCounties(report);
    const sum = (field) => counties.reduce((total, county) => total + (county[field] || 0), 0);
    return {
      date: report.date,
      inPerson: sum("inPerson"),
      mail: sum("mail"),
      ballots: sum("ballots"),
      inPersonOnDate: sum("inPersonOnDate"),
      geographyLean: geographyLean(counties),
      reportingBaseline2024: reportingCountiesBaseline(counties),
      countiesReporting: counties.filter((county) => county.ballots > 0).length,
      countiesWithInPerson: counties.filter((county) => county.inPerson > 0).length,
    };
  });
  for (const day of daily) {
    day.shiftFrom2024 = day.geographyLean == null || day.reportingBaseline2024 == null ? null : Math.round((day.geographyLean - day.reportingBaseline2024) * 10) / 10;
    day.readable = isReadable(day);
  }

  const latestCounties = joinCounties(latestReport);
  const registered = latestCounties.reduce((total, county) => total + (county.registered || 0), 0);
  const latestDay = daily[daily.length - 1];
  const unmatched = latestCounties.filter((county) => county.margin2024 == null).map((county) => county.name);
  const firstInPersonDay = turnout.earlyVotingDates.find((date) => date >= "2026-10-19") ?? null;

  return {
    source: "Texas Secretary of State, Early Voting Turnout (unofficial, as reported by counties)",
    sourceUrl: "https://goelect.txelections.civixapps.com/ivis-evr-ui/evr",
    electionName: turnout.electionName,
    reportDate: latestReport.date,
    updated: latestReport.updated,
    earlyVotingDates: turnout.earlyVotingDates,
    firstInPersonDay,
    registered,
    totals: {
      ballots: latestDay.ballots, inPerson: latestDay.inPerson, mail: latestDay.mail,
      shareOfRegistered: registered ? round4(latestDay.ballots / registered) : null,
      shareOf2024Total: round4(latestDay.ballots / baseline.statewide.total),
    },
    geography: {
      lean: latestDay.geographyLean,
      statewide2024: baseline.statewide.margin,
      reportingBaseline2024: latestDay.reportingBaseline2024,
      // Positive: ballots so far come from the more Democratic of the reporting counties, relative to 2024.
      shiftFrom2024: latestDay.shiftFrom2024,
      readable: latestDay.readable,
      countiesReporting: latestDay.countiesReporting,
      countiesWithInPerson: latestDay.countiesWithInPerson,
      readableRule: { minCountiesWithInPerson: READABLE_MIN_COUNTIES, minInPersonShare: READABLE_MIN_IN_PERSON_SHARE },
    },
    daily,
    counties: latestCounties
      .map((county) => ({
        name: county.displayName, registered: county.registered, inPerson: county.inPerson, mail: county.mail, ballots: county.ballots,
        shareOfRegistered: county.registered ? round4(county.ballots / county.registered) : null,
        shareOf2024Total: county.total2024 ? round4(county.ballots / county.total2024) : null,
        margin2024: county.margin2024, total2024: county.total2024,
      }))
      .sort((a, b) => b.ballots - a.ballots),
    unmatchedCounties: unmatched,
  };
}

function round4(value) { return Math.round(value * 10000) / 10000; }
