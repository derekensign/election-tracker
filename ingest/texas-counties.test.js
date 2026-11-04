import { test } from "node:test";
import assert from "node:assert/strict";
import { countyReturnFromContests, mergeCountyReturns, parseClarityCounty } from "./texas-counties.js";

const RACES = [{ id: "tx-senate", democrat: "James Talarico", republican: "Ken Paxton" }, { id: "tx-governor", democrat: "Gina Hinojosa", republican: "Greg Abbott" }];
const COUNTY = { name: "Williamson", early: 232996 };
const summary = (reporting, senate, governor) => JSON.stringify([
  { C: "United States Senator", CH: ["Ken Paxton (REP)", "James Talarico (DEM)", "Ted Brown (LIB)"], V: senate, PR: reporting, TP: 177, BC: senate.reduce((a, b) => a + b, 0) },
  { C: "Governor", CH: ["Greg Abbott", "Gina Hinojosa"], V: governor, PR: reporting, TP: 177, BC: 0 },
  { C: "County Judge", CH: ["X", "Y"], V: [1, 2], PR: reporting, TP: 177, BC: 0 },
]);

test("before Election Day precincts report, every vote counted is early, and it's kept as the early snapshot", () => {
  const { result, early } = countyReturnFromContests(COUNTY, parseClarityCounty(summary(0, [87260, 141285, 4013], [90000, 138000])), RACES);
  assert.deepEqual(result.races["tx-senate"], [232558, 141285, 87260, 232558, 141285, 87260]);
  assert.equal(result.dayReporting, 0);
  assert.deepEqual(early["tx-senate"], [232558, 141285, 87260]);
});

test("once precincts report, the snapshot stays the early vote and the rest is Election Day", () => {
  const snapshot = { "tx-senate": [232558, 141285, 87260] };
  const { result, early } = countyReturnFromContests(COUNTY, parseClarityCounty(summary(60, [120000, 170000, 5000], [125000, 165000])), RACES, snapshot);
  assert.deepEqual(result.races["tx-senate"], [232558, 141285, 87260, 295000, 170000, 120000]);
  assert.ok(Math.abs(result.dayReporting - 60 / 177) < 1e-9);
  assert.equal(early, null);
});

test("a county's own count replaces the state's only when it has more votes", () => {
  const state = { WILLIAMSON: { races: { "tx-senate": [0, 0, 0, 0, 0, 0] } }, DENTON: { races: { "tx-senate": [10, 6, 4, 10, 6, 4] } } };
  const sites = { WILLIAMSON: { races: { "tx-senate": [5, 3, 2, 5, 3, 2] } }, DENTON: { races: { "tx-senate": [8, 5, 3, 8, 5, 3] } } };
  const { returns, used } = mergeCountyReturns(state, sites);
  assert.deepEqual(used, ["WILLIAMSON"]);
  assert.equal(returns.DENTON.races["tx-senate"][3], 10);
});

test("vote-type splits from Harris, LiveVoterTurnout, and Montgomery become the early and Election Day cells", async () => {
  const { parseHarris, parseLiveVoterTurnout, parseMontgomery } = await import("./texas-counties.js");
  const harris = JSON.stringify({ vc: 100, vt: 623, bc: 0, contests: [{ t: "United States Senator", ca: ["KEN PAXTON (REP)", "JAMES TALARICO (DEM)"], ab: [10, 20], ev: [300, 500], tv: [400, 600] }] });
  const lvt = "<NewDataSet><Table><RaceName>US Senator</RaceName><ContestantName>REP Ken Paxton</ContestantName><EarlyVotingVotes>300</EarlyVotingVotes><MailBallotsVotes>10</MailBallotsVotes><ElectionDayVotes>90</ElectionDayVotes><TotalVotes>400</TotalVotes></Table><Table><RaceName>US Senator</RaceName><ContestantName>DEM James Talarico</ContestantName><EarlyVotingVotes>500</EarlyVotingVotes><MailBallotsVotes>20</MailBallotsVotes><ElectionDayVotes>80</ElectionDayVotes><TotalVotes>600</TotalVotes></Table></NewDataSet>";
  const montgomery = '<td id="rptCandidates_ContestTitle2_0" class="myContest">United States Senator</td><td id="rptCandidates_txtCandName2_0">Ken Paxton (REP)</td><td id="rptCandidates_txtABSVotes_0">10</td><td id="rptCandidates_txtEVVotes2_0">300</td><td id="rptCandidates_txtTotalVotes2_0">400</td><td id="rptCandidates_txtCandName2_1">James Talarico (DEM)</td><td id="rptCandidates_txtABSVotes_1">20</td><td id="rptCandidates_txtEVVotes2_1">500</td><td id="rptCandidates_txtTotalVotes2_1">600</td>';
  for (const contests of [parseHarris(harris), parseLiveVoterTurnout(lvt), parseMontgomery(montgomery)]) {
    const { result } = countyReturnFromContests(COUNTY, contests, RACES);
    assert.deepEqual(result.races["tx-senate"], [830, 520, 310, 1000, 600, 400]);
  }
});
