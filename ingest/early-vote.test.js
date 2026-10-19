import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEarlyVote, countyKey, geographyLean, isReadable, reportingCountiesBaseline } from "./early-vote.js";

test("countyKey matches SOS and Wikipedia spellings", () => {
  assert.equal(countyKey("DE WITT"), countyKey("DeWitt"));
  assert.equal(countyKey("LA SALLE"), countyKey("La Salle"));
  assert.equal(countyKey("MCMULLEN"), countyKey("McMullen"));
});

test("geographyLean weights county margins by ballots and skips unmatched counties", () => {
  // 300 ballots at D+10 and 100 at R+30 average to Even.
  assert.equal(geographyLean([{ ballots: 300, margin2024: 10 }, { ballots: 100, margin2024: -30 }, { ballots: 50, margin2024: null }]), 0);
  assert.equal(geographyLean([{ ballots: 0, margin2024: 5 }]), null);
});

test("buildEarlyVote reproduces the 2024 margin when turnout matches 2024 exactly", () => {
  const baseline = { statewide: { margin: -5, total: 400 }, counties: [{ name: "Blue", key: "BLUE", margin: 20, total: 100 }, { name: "Red", key: "RED", margin: -40 / 3, total: 300 }] };
  const report = (date, blueBallots, redBallots) => ({ date, updated: date, counties: [
    { name: "BLUE", registered: 200, inPerson: blueBallots, mail: 0, inPersonOnDate: 0 },
    { name: "RED", registered: 600, inPerson: redBallots, mail: 0, inPersonOnDate: 0 },
  ] });
  const result = buildEarlyVote({ electionName: "TEST", earlyVotingDates: ["2026-10-19", "2026-10-20"], reports: [report("2026-10-19", 10, 10), report("2026-10-20", 100, 300)] }, baseline);
  assert.equal(result.geography.lean, -5);
  assert.equal(result.geography.reportingBaseline2024, -5);
  assert.equal(result.geography.shiftFrom2024, 0);
  assert.equal(result.daily[0].geographyLean, 3.3); // equal ballots from each county: (20 − 13.33) / 2
  assert.equal(result.totals.ballots, 400);
  assert.equal(result.totals.shareOf2024Total, 1);
  assert.deepEqual(result.unmatchedCounties, []);
});

test("reporting-counties baseline ignores counties with no ballots yet", () => {
  // Only the D+20 county has reported, so the like-for-like 2024 baseline is D+20, not the statewide figure.
  const counties = [{ ballots: 50, margin2024: 20, total2024: 100 }, { ballots: 0, margin2024: -40, total2024: 300 }];
  assert.equal(reportingCountiesBaseline(counties), 20);
});

test("isReadable needs broad in-person reporting", () => {
  assert.equal(isReadable({ countiesWithInPerson: 24, inPerson: 1440, ballots: 57341 }), false);
  assert.equal(isReadable({ countiesWithInPerson: 230, inPerson: 400, ballots: 1000 }), false);
  assert.equal(isReadable({ countiesWithInPerson: 230, inPerson: 600, ballots: 1000 }), true);
});
