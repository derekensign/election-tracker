import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEarlyVote, compareDayWith2018, countyGroup, groupBreakdown, mergeCountyReports, countyKey, earlyVotingDayNumber, geographyAgainst, geographyLean, isReadable, percentChange } from "./early-vote.js";

test("countyKey matches SOS and Wikipedia spellings", () => {
  assert.equal(countyKey("DE WITT"), countyKey("DeWitt"));
  assert.equal(countyKey("LA SALLE"), countyKey("La Salle"));
  assert.equal(countyKey("EL PASO"), countyKey("El Paso"));
});

test("geographyLean weights margins and skips counties without a margin", () => {
  // 300 at D+10 and 100 at R+30 average to Even.
  assert.equal(geographyLean([{ ballots: 300, margin: 10 }, { ballots: 100, margin: -30 }, { ballots: 50, margin: null }]), 0);
  assert.equal(geographyLean([{ ballots: 0, margin: 5 }]), null);
});

test("geographyAgainst compares with the same reporting counties only", () => {
  // Only the D+20 county has reported, so the like-for-like baseline is D+20 and there is no shift.
  const counties = [{ ballots: 50, past: { x: { margin: 20, total: 100 } } }, { ballots: 0, past: { x: { margin: -40, total: 300 } } }];
  assert.deepEqual(geographyAgainst(counties, "x"), { lean: 20, reportingBaseline: 20, shift: 0 });
});

test("isReadable needs broad in-person reporting", () => {
  assert.equal(isReadable({ countiesWithInPerson: 24, inPerson: 1440, ballots: 57341 }), false);
  assert.equal(isReadable({ countiesWithInPerson: 230, inPerson: 400, ballots: 1000 }), false);
  assert.equal(isReadable({ countiesWithInPerson: 230, inPerson: 600, ballots: 1000 }), true);
});

test("earlyVotingDayNumber counts the first in-person day as day 1", () => {
  assert.equal(earlyVotingDayNumber("2026-10-19", "2026-10-19"), 1);
  assert.equal(earlyVotingDayNumber("2026-10-21", "2026-10-19"), 3);
  assert.equal(earlyVotingDayNumber("2026-10-14", "2026-10-19"), -4);
});

test("buildEarlyVote: matching past turnout reproduces the past margin; 2018 pace lines up by day", () => {
  const election = (margins) => ({ label: "x", office: "x", democrat: "D", republican: "R", statewide: { margin: -5, total: 400 }, counties: [{ name: "Blue", key: "BLUE", margin: margins[0], total: 100 }, { name: "Red", key: "RED", margin: margins[1], total: 300 }] });
  const baselines = { elections: { 2024: election([20, -40 / 3]), 2018: election([30, -10]) } };
  const report = (date, blue, red) => ({ date, updated: date, counties: [
    { name: "BLUE", registered: 200, inPerson: blue, mail: 0, inPersonOnDate: 0 },
    { name: "RED", registered: 600, inPerson: red, mail: 0, inPersonOnDate: 0 },
  ] });
  const benchmark2018 = { firstInPersonDay: "2018-10-22", countyKeys: ["BLUE"], days: [{ date: "2018-10-22", dayNumber: 1, total: { ballots: 50, registered: 180 }, counties: [{ key: "BLUE", ballots: 50 }] }, { date: "2018-10-23", dayNumber: 2, total: { ballots: 80, registered: 180 }, counties: [{ key: "BLUE", ballots: 80 }] }] };
  const result = buildEarlyVote({ electionName: "TEST", earlyVotingDates: ["2026-10-18", "2026-10-19", "2026-10-20"], reports: [report("2026-10-18", 1, 1), report("2026-10-19", 10, 10), report("2026-10-20", 100, 300)] }, baselines, benchmark2018);
  assert.deepEqual(result.geography.byElection["2024"], { lean: -5, reportingBaseline: -5, shift: 0 });
  assert.equal(result.daily[0].pace2018, undefined); // October 18 is before in-person day 1
  assert.equal(result.daily[1].pace2018.ballots2018, 50);
  assert.deepEqual([result.pace2018.dayNumber, result.pace2018.ballots2026, result.pace2018.ballots2018, result.pace2018.ratio], [2, 100, 80, 1.25]);
  assert.equal(result.counties.find((c) => c.name === "Blue").sameDay2018, 80);
  assert.equal(result.totals.shareOfPastTotal["2024"], 1);
  assert.deepEqual(result.unmatchedCounties, []);
});

test("buildEarlyVote leaves out the run date's in-progress report", () => {
  const baselines = { elections: { 2024: { label: "x", office: "x", democrat: "D", republican: "R", statewide: { margin: 0, total: 10 }, counties: [{ name: "A", key: "A", margin: 0, total: 10 }] } } };
  const report = (date, inPerson) => ({ date, updated: date, counties: [{ name: "A", registered: 20, inPerson, mail: 1, inPersonOnDate: 0 }] });
  const turnout = { electionName: "T", earlyVotingDates: [], reports: [report("2026-10-19", 5), report("2026-10-20", 1)] };
  const result = buildEarlyVote(turnout, baselines, null, { asOf: "2026-10-20" });
  assert.equal(result.reportDate, "2026-10-19");
  assert.equal(result.daily.length, 1);
  assert.equal(result.inProgress, false);
  assert.equal(buildEarlyVote({ ...turnout, reports: [report("2026-10-20", 1)] }, baselines, null, { asOf: "2026-10-20" }).inProgress, true);
});

test("isReadable also needs most registered voters covered", () => {
  assert.equal(isReadable({ countiesWithInPerson: 204, inPerson: 419376, ballots: 496002, registeredCoverage: 0.64 }), false);
  assert.equal(isReadable({ countiesWithInPerson: 230, inPerson: 600, ballots: 1000, registeredCoverage: 0.9 }), true);
});

test("percentChange", () => {
  assert.equal(percentChange(110, 100), 0.1);
  assert.equal(percentChange(53, 100), -0.47);
  assert.equal(percentChange(5, 0), null);
});

test("compareDayWith2018 skips counties that haven't posted, instead of reading them as a collapse", () => {
  const day2018 = { date: "2018-10-22", counties: [
    { key: "DALLAS", name: "Dallas", registered: 100, inPerson: 1000, inPersonOnDate: 1000, mail: 200 },
    { key: "HARRIS", name: "Harris", registered: 200, inPerson: 2000, inPersonOnDate: 2000, mail: 400 },
  ] };
  const counties2026 = [
    { key: "DALLAS", displayName: "Dallas", registered: 120, inPerson: 1100, inPersonOnDate: 1100, mail: 100 },
    { key: "HARRIS", displayName: "Harris", registered: 240, inPerson: 4, inPersonOnDate: 4, mail: 300 },
  ];
  const result = compareDayWith2018(counties2026, day2018);
  assert.equal(result.countiesReported, 1);
  assert.deepEqual(result.notReported, ["Harris"]);
  assert.deepEqual(result.inPersonDay, { y2026: 1100, y2018: 1000, change: 0.1 });
  assert.equal(result.coverageOf2018, 0.333);
  // Dallas mail (100 against 200) and Harris mail (300 against 400) both count as posted.
  assert.deepEqual(result.mailRunning, { y2026: 400, y2018: 600, change: -0.333 });
  assert.equal(result.mailCountiesReported, 2);
  assert.equal(result.counties.find((c) => c.name === "Harris").inPersonRunning.change, null);
});

test("compareDayWith2018 treats a county with almost no mail ballots as not having posted mail", () => {
  const day2018 = { date: "2018-10-22", counties: [{ key: "PARKER", name: "Parker", registered: 90, inPerson: 4000, inPersonOnDate: 4000, mail: 1883 }] };
  const result = compareDayWith2018([{ key: "PARKER", displayName: "Parker", registered: 130, inPerson: 5900, inPersonOnDate: 5900, mail: 0 }], day2018);
  assert.equal(result.mailCountiesReported, 0);
  assert.equal(result.mailRunning.change, null);
  assert.equal(result.counties[0].mailRunning.change, null);
  assert.equal(result.countiesReported, 1);
});

test("mergeCountyReports uses a county's own count when the state feed is behind", () => {
  const state = (date, inPerson, inPersonOnDate, mail) => ({ date, counties: [{ name: "HARRIS", registered: 100, inPerson, inPersonOnDate, mail }, { name: "DALLAS", registered: 100, inPerson: 50, inPersonOnDate: 50, mail: 5 }] });
  const reports = [state("2026-10-18", 0, 0, 20000), state("2026-10-19", 4, 4, 22028), state("2026-10-20", 7458, 423, 22028)];
  const harris = { county: "Harris", sourceUrl: "x", inPersonByDate: { "2026-10-19": 104659, "2026-10-20": 90000 }, mail: 24794 };
  const { reports: merged, used } = mergeCountyReports(reports, [harris]);
  const harrisOn = (i) => merged[i].counties.find((c) => c.name === "HARRIS");
  assert.equal(harrisOn(0).inPerson, 0); // county report starts on the 19th
  assert.deepEqual([harrisOn(1).inPerson, harrisOn(1).inPersonOnDate, harrisOn(1).mail], [104659, 104659, 22028]); // mail only on the latest date
  assert.deepEqual([harrisOn(2).inPerson, harrisOn(2).inPersonOnDate, harrisOn(2).mail], [194659, 90000, 24794]);
  assert.equal(merged[1].counties.find((c) => c.name === "DALLAS").inPerson, 50); // untouched
  assert.deepEqual(used.Harris.inPersonDates, ["2026-10-19", "2026-10-20"]);
  assert.equal(used.Harris.mail, true);
});

test("mergeCountyReports keeps the state's count when it is higher, and handles cumulative-only reports", () => {
  const reports = [{ date: "2026-10-19", counties: [{ name: "BEXAR", registered: 1, inPerson: 50000, inPersonOnDate: 50000, mail: 9 }] }];
  const { reports: merged, used } = mergeCountyReports(reports, [{ county: "Bexar", sourceUrl: "x", inPersonThrough: { date: "2026-10-19", inPerson: 42776 }, mail: null }]);
  assert.equal(merged[0].counties[0].inPerson, 50000);
  assert.deepEqual(used, {});
});

test("buildEarlyVote compares with other years' daily reports for the counties they cover", () => {
  const baselines = { elections: { 2024: { label: "x", office: "x", democrat: "D", republican: "R", statewide: { margin: 0, total: 100 }, counties: [{ name: "Harris", key: "HARRIS", margin: 0, total: 100 }, { name: "Travis", key: "TRAVIS", margin: 0, total: 100 }] } } };
  const report = { date: "2026-10-19", updated: null, counties: [{ name: "HARRIS", registered: 10, inPerson: 120, inPersonOnDate: 120, mail: 0 }, { name: "TRAVIS", registered: 10, inPerson: 50, inPersonOnDate: 50, mail: 0 }] };
  const benchmark2022 = { firstInPersonDay: "2022-10-24", sources: { Harris: "u" }, days: [{ date: "2022-10-24", dayNumber: 1, total: { inPerson: 100, inPersonOnDate: 100 }, counties: [{ key: "HARRIS", name: "Harris", registered: null, inPerson: 100, inPersonOnDate: 100, mail: null }] }, { date: "2022-10-25", dayNumber: 2, total: { inPerson: 190, inPersonOnDate: 90 }, counties: [] }] };
  const result = buildEarlyVote({ electionName: "T", earlyVotingDates: [], reports: [report] }, baselines, null, { asOf: "2026-10-20", otherBenchmarks: { 2022: benchmark2022 } });
  const v = result.versusYears["2022"];
  assert.deepEqual(v.days[0].inPersonDay, { y2026: 120, y2018: 100, change: 0.2 }); // Travis isn't in the 2022 file, so it is left out
  assert.equal(v.days[1].date2026, null);
  assert.equal(v.days[1].inPersonRunningThen, 190);
  assert.equal(v.latestCounties[0].inPersonRunning.change, 0.2);
  assert.equal(v.latestCounties[0].registered.change, null); // no 2022 registration figures
});

test("compareDayWith2018 treats a county that hasn't posted today's votes as not posted, even with earlier days in", () => {
  const day2018 = { date: "2018-10-24", counties: [{ key: "BEXAR", name: "Bexar", registered: 1, inPerson: 100000, inPersonOnDate: 30000, mail: 0 }] };
  // Days 1-2 are in (90,000), day 3 shows only 500 so far.
  const result = compareDayWith2018([{ key: "BEXAR", displayName: "Bexar", registered: 1, inPerson: 90500, inPersonOnDate: 500, mail: 0 }], day2018);
  assert.equal(result.countiesReported, 0);
  assert.deepEqual(result.notReported, ["Bexar"]);
});

test("countyGroup and groupBreakdown", () => {
  assert.equal(countyGroup("HARRIS"), "Big cities");
  assert.equal(countyGroup("DE WITT"), "Rural and small-town");
  assert.equal(countyGroup("FORT BEND"), "Suburbs");
  const counties = [
    { name: "Harris", ballots: 100, registered: 1000, past: { 2022: { total: 400 }, 2024: { total: 500, margin: 5 } } },
    { name: "Dallas", ballots: 100, registered: 1000, past: { 2022: { total: 600 }, 2024: { total: 500, margin: 25 } } },
  ];
  const v18 = [{ name: "Harris", reported: true, inPersonRunning: { y2026: 150, y2018: 100 } }, { name: "Dallas", reported: false, inPersonRunning: { y2026: 1, y2018: 100 } }];
  const big = groupBreakdown(counties, v18).find((g) => g.group === "Big cities");
  assert.deepEqual([big.counties, big.ballots, big.shareOf2022Vote, big.margin2024], [2, 200, 0.2, 15]);
  assert.deepEqual(big.versus2018, { counties: 1, change: 0.5 }); // Dallas hasn't posted, so it is left out
});
