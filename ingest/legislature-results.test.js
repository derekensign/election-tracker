import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLegislativeResults } from "./sources/sos-results.js";

// The shape of the state's election file's Districted section, with made-up votes.
const DISTRICTED = {
  Races: [
    { N: "STATE REPRESENTATIVE DISTRICT 14", T: 1000, Candidates: [
      { N: "PAUL DYSON (I)", P: "REP", V: 480 },
      { N: "JANET TYCELIA DUDDING", P: "DEM", V: 500 },
      { N: "JEFF MILLER", P: "LIB", V: 20 },
    ] },
    { N: "STATE REPRESENTATIVE DISTRICT 22", T: 900, Candidates: [{ N: "CHRISTIAN HAYES (I)", P: "DEM", V: 900 }] },
    { N: "STATE REPRESENTATIVE DISTRICT 49", T: 1000, Candidates: [{ N: "GINA HINOJOSA (I)", P: "DEM", V: 900 }, { N: "SOMEONE GREEN", P: "GRN", V: 100 }] },
    { N: "STATE SENATOR, DISTRICT 1", T: 300, Candidates: [{ N: "BRYAN HUGHES (I)", P: "REP", V: 200 }, { N: "LATICIA AMBROZ", P: "DEM", V: 100 }] },
    { N: "U. S. REPRESENTATIVE DISTRICT 14", T: 5, Candidates: [{ N: "NOT A LEGISLATOR", P: "DEM", V: 5 }] },
  ],
};

test("Texas House and Senate races: candidates by votes, the leader, and the margin; other races ignored", () => {
  const results = parseLegislativeResults(DISTRICTED, "Nov 04, 2026 22:48:37");
  assert.equal(results.lastUpdated, "Nov 04, 2026 22:48:37");
  assert.deepEqual(Object.keys(results.house), ["14", "22", "49"]);
  assert.deepEqual(Object.keys(results.senate), ["1"]);
  const close = results.house[14];
  assert.deepEqual(close.candidates.map((c) => [c.name, c.party, c.incumbent]), [
    ["Janet Tycelia Dudding", "D", false], ["Paul Dyson", "R", true], ["Jeff Miller", "L", false],
  ]);
  assert.equal(close.leader, "D");
  assert.equal(close.margin, 2);
  assert.equal(close.lead, 2);
  assert.equal(close.uncontested, false);
  assert.equal(results.senate[1].margin, -33.3);
  assert.equal(results.senate[1].leaderName, "Bryan Hughes");
});

test("An unopposed race has no margin or lead; a race without a Republican uses the leader's lead", () => {
  const results = parseLegislativeResults(DISTRICTED);
  assert.equal(results.house[22].uncontested, true);
  assert.equal(results.house[22].lead, null);
  assert.equal(results.house[22].margin, null);
  assert.equal(results.house[49].lead, 80);
  assert.equal(results.house[49].margin, 80);
});
