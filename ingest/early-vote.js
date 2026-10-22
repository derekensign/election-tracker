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
// Counties with in-person votes must hold at least this share of registered voters. Two hundred small
// counties can report while Harris, Tarrant, and Collin haven't, and that mix is not the state.
export const READABLE_MIN_REGISTERED_COVERAGE = 0.8;
// A big county counts as having reported its in-person votes through day N once its 2026 running in-person
// total reaches this share of its 2018 total through the same day. Counties that haven't uploaded show a
// handful of votes (Harris posted 4 on the evening of day 1), so anything under a quarter of 2018's pace
// is treated as not posted yet rather than as a 75% collapse.
export const REPORTED_MIN_SHARE_OF_2018 = 0.25;
// For the statewide geography check (no per-county 2018 days outside the big 30), a county has posted its
// in-person votes once its in-person rate per registered voter is at least this share of the statewide rate.
export const POSTED_MIN_SHARE_OF_STATE_RATE = 0.25;
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
export function isReadable({ countiesWithInPerson, inPerson, ballots, registeredCoverage = 1 }) {
  return countiesWithInPerson >= READABLE_MIN_COUNTIES && ballots > 0 && inPerson / ballots >= READABLE_MIN_IN_PERSON_SHARE && registeredCoverage >= READABLE_MIN_REGISTERED_COVERAGE;
}

/** Percent change from `before` to `after` as a fraction (0.12 = up 12%), or null without a base. */
export function percentChange(after, before) { return before ? Math.round(((after - before) / before) * 1000) / 1000 : null; }

/**
 * Compare one 2026 early-voting day with the same in-person day of 2018, county by county, for the 30 largest
 * counties. Only counties that have posted their in-person votes through that day are compared, so a county
 * that hasn't uploaded yet doesn't read as a collapse.
 * @param {Array<{ key: string, displayName: string, registered: number, inPerson: number, inPersonOnDate: number, mail: number }>} counties2026
 * @param {{ date: string, counties: Array<{ key: string, name: string, registered: number, inPerson: number, inPersonOnDate: number, mail: number }> }} day2018
 */
export function compareDayWith2018(counties2026, day2018) {
  const byKey2026 = new Map(counties2026.map((c) => [c.key, c]));
  const counties = day2018.counties.map((old) => {
    const now = byKey2026.get(old.key);
    // Posted means both the running total AND that day's own count look complete. Checking only the running
    // total let a county that had posted days 1-2 but not yet day 3 count as posted, which showed day 3 of
    // 2026 as a 27% drop from 2018 on the morning of October 22.
    const reported = Boolean(now)
      && now.inPerson >= REPORTED_MIN_SHARE_OF_2018 * old.inPerson
      && now.inPersonOnDate >= REPORTED_MIN_SHARE_OF_2018 * old.inPersonOnDate;
    // Mail gets the same rule on its own: many counties post in-person votes but no mail (Parker showed 0).
    const mailReported = Boolean(now) && old.mail > 0 && now.mail >= REPORTED_MIN_SHARE_OF_2018 * old.mail;
    return {
      name: now?.displayName ?? old.name, key: old.key, reported, mailReported,
      source: now?.inPersonSource === "county" ? "county" : "state", // where the in-person count came from
      inPersonDay: { y2026: now?.inPersonOnDate ?? 0, y2018: old.inPersonOnDate },
      inPersonRunning: { y2026: now?.inPerson ?? 0, y2018: old.inPerson, change: reported ? percentChange(now.inPerson, old.inPerson) : null },
      mailRunning: { y2026: now?.mail ?? 0, y2018: old.mail, change: mailReported ? percentChange(now.mail, old.mail) : null },
      registered: { y2026: now?.registered ?? null, y2018: old.registered, change: now?.registered ? percentChange(now.registered, old.registered) : null },
    };
  });
  const reported = counties.filter((c) => c.reported);
  const sum = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0);
  const pair = (rows, field) => {
    const y2026 = sum(rows, (c) => c[field].y2026), y2018 = sum(rows, (c) => c[field].y2018);
    return { y2026, y2018, change: rows.length ? percentChange(y2026, y2018) : null };
  };
  return {
    countiesReported: reported.length,
    countiesTotal: counties.length,
    notReported: counties.filter((c) => !c.reported).map((c) => c.name),
    // How much of 2018's in-person vote the reporting counties stood for, so a small sample reads as one.
    coverageOf2018: Math.round((sum(reported, (c) => c.inPersonRunning.y2018) / Math.max(1, sum(counties, (c) => c.inPersonRunning.y2018))) * 1000) / 1000,
    inPersonDay: pair(reported, "inPersonDay"),
    inPersonRunning: pair(reported, "inPersonRunning"),
    mailRunning: pair(counties.filter((c) => c.mailReported), "mailRunning"),
    mailCountiesReported: counties.filter((c) => c.mailReported).length,
    registered: pair(reported, "registered"),
    counties,
  };
}

/** In-person early-voting day number for a date: the first in-person day is day 1; earlier dates are ≤ 0. */
export function earlyVotingDayNumber(date, firstInPersonDay) {
  return Math.round((Date.parse(date) - Date.parse(firstInPersonDay)) / DAY_MS) + 1;
}

/**
 * Fold county election offices' own reports into the Secretary of State's daily reports. For each county and
 * report date, the county's cumulative in-person count through that date replaces the state's when it is
 * higher: the state feed lags, and it is never ahead of a county's own count. Mail ballots from a county report
 * are as of the report, so they only update the latest report date. Returns new reports plus, per county, what
 * was used.
 * @param {Array<{ date: string, counties: Array<{ name: string, inPerson: number, inPersonOnDate: number, mail: number }> }>} reports
 * @param {Array<{ county: string, sourceUrl: string, inPersonByDate?: Record<string, number>, inPersonThrough?: { date: string, inPerson: number }, mail?: number|null }>} countyReports
 */
export function mergeCountyReports(reports, countyReports) {
  const byKey = new Map(countyReports.map((report) => [countyKey(report.county), report]));
  const used = {};
  const latestDate = reports[reports.length - 1]?.date;
  // Each county's cumulative in-person count through a date, or null when its report doesn't cover that date.
  const countyCumulative = (report, date) => {
    if (report.inPersonByDate) {
      const days = Object.keys(report.inPersonByDate).sort();
      if (!days.length || days[0] > date) return null;
      return days.filter((day) => day <= date).reduce((sum, day) => sum + report.inPersonByDate[day], 0);
    }
    if (report.inPersonThrough && report.inPersonThrough.date <= date) return report.inPersonThrough.inPerson;
    return null;
  };
  const previousMerged = new Map(); // county key -> merged cumulative in-person through the previous report date
  const merged = reports.map((report) => ({
    ...report,
    counties: report.counties.map((county) => {
      const key = countyKey(county.name);
      const countyReport = byKey.get(key);
      let result = county;
      if (countyReport) {
        const cumulative = countyCumulative(countyReport, report.date);
        if (cumulative != null && cumulative > county.inPerson) {
          const before = previousMerged.get(key) ?? (county.inPerson - county.inPersonOnDate);
          result = { ...result, inPerson: cumulative, inPersonOnDate: Math.max(0, cumulative - before), inPersonSource: "county" };
          (used[countyReport.county] ??= { sourceUrl: countyReport.sourceUrl, inPersonDates: [], mail: false }).inPersonDates.push(report.date);
        }
        if (report.date === latestDate && countyReport.mail != null && countyReport.mail > county.mail) {
          result = { ...result, mail: countyReport.mail, mailSource: "county" };
          (used[countyReport.county] ??= { sourceUrl: countyReport.sourceUrl, inPersonDates: [], mail: false }).mail = true;
        }
      }
      previousMerged.set(key, result.inPerson);
      return result;
    }),
  }));
  return { reports: merged, used };
}

/**
 * Build the early-vote section of the snapshot.
 * @param {{ reports: Array<{ date: string, updated: string|null, counties: Array<object> }>, earlyVotingDates: string[], electionName: string }} turnout
 * @param {{ elections: Record<string, { label: string, democrat: string, republican: string, statewide: { margin: number, total: number }, counties: Array<{ name: string, key: string, margin: number, total: number }> }> }} baselines
 * @param {{ firstInPersonDay: string, countyKeys: string[], days: Array<{ date: string, dayNumber: number, total: { ballots: number, registered: number }, counties: Array<{ key: string, ballots: number }> }> }|null} benchmark2018
 * @param {{ firstInPersonDay?: string, asOf?: string|null, countyReports?: Array<object>, otherBenchmarks?: Record<string, object> }} [options]
 *   otherBenchmarks: 2022 and 2024 daily county reports in the 2018 file's shape (fewer counties, no mail). asOf: the run date;
 *   reports on or after it are in progress. countyReports: county election offices' own counts (see mergeCountyReports).
 */
export function buildEarlyVote(turnout, baselines, benchmark2018 = null, { firstInPersonDay = "2026-10-19", asOf = null, countyReports = [], otherBenchmarks = {} } = {}) {
  const finishedReports = asOf ? turnout.reports.filter((report) => report.date < asOf) : turnout.reports;
  const { reports: completeReports, used: countySourcesUsed } = mergeCountyReports(finishedReports, countyReports);
  const reports = completeReports.length ? completeReports : mergeCountyReports(turnout.reports, countyReports).reports;
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
      countiesWithInPerson: 0, registeredCoverage: 0, // filled in below
      geography: Object.fromEntries(electionIds.map((id) => [id, geographyAgainst(counties, id)])),
    };
    // Which counties have really posted in-person votes: a token handful (Harris showed 4) doesn't count.
    const registeredTotal = sum(counties, "registered");
    const statewideInPersonRate = registeredTotal ? day.inPerson / registeredTotal : 0;
    const posted = counties.filter((c) => c.registered && c.inPerson > 0 && c.inPerson / c.registered >= POSTED_MIN_SHARE_OF_STATE_RATE * statewideInPersonRate);
    day.countiesWithInPerson = posted.length;
    day.registeredCoverage = registeredTotal ? Math.round((sum(posted, "registered") / registeredTotal) * 1000) / 1000 : 0;
    day.countiesNotPosted = counties.filter((c) => c.registered >= 150_000 && !posted.includes(c)).map((c) => c.displayName); // big ones only
    day.readable = isReadable(day);
    // Same 30 counties, same in-person day number, 2018 against 2026.
    const benchmarkDay = day.dayNumber >= 1 ? benchmark2018?.days?.[day.dayNumber - 1] : null;
    if (benchmarkDay) {
      const { counties: countyComparisons, ...comparison } = compareDayWith2018(counties, benchmarkDay);
      day.versus2018 = { dayNumber: day.dayNumber, date2018: benchmarkDay.date, ...comparison };
      day.versus2018Counties = countyComparisons; // dropped from all but the latest day below, to keep the file small
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
    // The same day-matched comparison against 2022 and 2024, for the counties whose daily reports survive.
    day.versusOther = {};
    for (const [year, benchmark] of Object.entries(otherBenchmarks)) {
      const dayThen = day.dayNumber >= 1 ? benchmark.days?.[day.dayNumber - 1] : null;
      if (dayThen) day.versusOther[year] = { dayNumber: day.dayNumber, ...compareDayWith2018(counties, dayThen) };
    }
    return day;
  });

  const latestCounties = joinCounties(latestReport);
  const latestDay = daily[daily.length - 1];
  const versus2018Counties = latestDay.versus2018Counties ?? null;
  for (const day of daily) delete day.versus2018Counties;
  // Per past year: each compared day (county rows trimmed), the latest day's county rows, and the days still to come.
  const versusYears = {};
  for (const [year, benchmark] of Object.entries(otherBenchmarks)) {
    const comparedDays = daily.filter((d) => d.versusOther?.[year]);
    const latestCountyRows = comparedDays.length ? comparedDays[comparedDays.length - 1].versusOther[year].counties : null;
    versusYears[year] = {
      firstInPersonDay: benchmark.firstInPersonDay,
      counties: (benchmark.days?.[0]?.counties || []).map((c) => c.name),
      sources: benchmark.sources ?? null,
      days: benchmark.days.map((dayThen) => {
        const compared = comparedDays.find((d) => d.versusOther[year].dayNumber === dayThen.dayNumber);
        if (!compared) return { dayNumber: dayThen.dayNumber, dateThen: dayThen.date, date2026: null, inPersonDayThen: dayThen.total.inPersonOnDate, inPersonRunningThen: dayThen.total.inPerson };
        const { counties: _countyRows, ...summary } = compared.versusOther[year];
        return { date2026: compared.date, dateThen: dayThen.date, ...summary };
      }),
      latestCounties: latestCountyRows,
    };
  }
  for (const day of daily) delete day.versusOther;
  const registered = latestCounties.reduce((total, county) => total + (county.registered || 0), 0);
  const benchmarkLatest = latestDay.pace2018 ? new Map(benchmark2018.days[latestDay.pace2018.dayNumber - 1].counties.map((c) => [c.key, c.ballots])) : null;

  return {
    source: "Texas Secretary of State, Early Voting Turnout (unofficial, as reported by counties)",
    sourceUrl: "https://goelect.txelections.civixapps.com/ivis-evr-ui/evr",
    electionName: turnout.electionName,
    reportDate: latestReport.date,
    updated: latestReport.updated,
    // Counties whose numbers came from their own election office because the state feed was behind.
    countySources: countySourcesUsed,
    // True only when every report is still in progress (the very first run of early voting).
    inProgress: !finishedReports.length && Boolean(asOf),
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
      registeredCoverage: latestDay.registeredCoverage,
      bigCountiesNotPosted: latestDay.countiesNotPosted,
      readableRule: { minCountiesWithInPerson: READABLE_MIN_COUNTIES, minInPersonShare: READABLE_MIN_IN_PERSON_SHARE, minRegisteredCoverage: READABLE_MIN_REGISTERED_COVERAGE },
      byElection: latestDay.geography, // positive shift: ballots come from the bluer of the reporting counties
    },
    pace2018: latestDay.pace2018 ?? null,
    // Day-matched comparisons with 2022 and 2024 for the big counties whose daily reports still exist.
    versusYears,
    // Day-by-day comparison with 2018 (30 largest counties), plus the 2018-only days still to come.
    versus2018: benchmark2018 ? {
      days: benchmark2018.days.map((day2018) => {
        const day2026 = daily.find((d) => d.versus2018?.dayNumber === day2018.dayNumber);
        return day2026 ? { date2026: day2026.date, ...day2026.versus2018 } : { dayNumber: day2018.dayNumber, date2018: day2018.date, date2026: null, inPersonDay2018: day2018.total.inPersonOnDate, inPersonRunning2018: day2018.total.inPerson };
      }),
      latestCounties: versus2018Counties,
    } : null,
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
