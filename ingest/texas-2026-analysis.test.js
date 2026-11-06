import { test } from "node:test";
import assert from "node:assert/strict";
import { coalition, countyAnalysis, decomposeSwing, returnRates, statewideOffices, usHouseResults, voteMethodSplit } from "./texas-2026-analysis.js";

// The Senate exit poll's 2024-vote question, as published: share of voters, then Talarico and Paxton.
const VOTE_2024 = [
  { label: "Kamala Harris (Dem)", share: 42, dem: 98, rep: 1 },
  { label: "Donald Trump (Rep)", share: 47, dem: 11, rep: 86 },
  { label: "Other", share: 2, dem: 74, rep: 16 },
  { label: "Did not vote", share: 8, dem: 81, rep: 16 },
];

test("the swing splits into turnout, switching, new voters, and the count, and the parts add up", () => {
  const split = decomposeSwing(VOTE_2024, -13.7, 12.09);
  assert.equal(split.recalled, -5.5);
  assert.equal(split.returningNow, 7.3);
  assert.equal(split.survey, 12);
  assert.deepEqual(split.steps.map((step) => step.key), ["turnout", "switched", "new", "count"]);
  assert.equal(Math.round(split.steps.reduce((total, step) => total + step.value, 0) * 10) / 10, 25.8);
  assert.equal(Math.round(split.steps[0].value), 8);
  assert.equal(Math.round(split.steps[1].value), 13);
});

test("a coalition's groups add up to the candidate's votes in the count", () => {
  const parts = coalition(VOTE_2024, "dem", 5_444_982);
  assert.equal(parts.reduce((total, part) => total + part.votes, 0), 5_444_982);
  assert.equal(parts[0].share, 75.8);
  assert.equal(parts[1].share, 9.5);
});

test("return rates: each 2024 candidate's voters who voted again, from the poll's shares and turnout", () => {
  const rates = returnRates(VOTE_2024, 9_889_704, 4_835_250, 6_393_597);
  assert.equal(rates.harris, 0.868);
  assert.equal(rates.trump, 0.734);
});

test("early and Election Day votes are split from the county returns", () => {
  const returns = { A: { races: { "tx-senate": [80, 50, 30, 100, 55, 45] } }, B: { races: { "tx-senate": [20, 5, 15, 30, 8, 22] } } };
  const split = voteMethodSplit(returns, "tx-senate");
  assert.deepEqual(split.early, { votes: 100, share: 76.9, margin: 10 });
  assert.deepEqual(split.electionDay, { votes: 30, share: 23.1, margin: -46.7 });
});

test("counties: margins against the baselines, and regions summed from their counties", () => {
  const county = (key, name, dem, rep, total) => ({ key, name, democrat: dem, republican: rep, total });
  const baselines = { elections: {
    2024: { counties: [county("HIDALGO", "Hidalgo", 49, 51, 100), county("LOVING", "Loving", 10, 90, 100)] },
    2022: { counties: [county("HIDALGO", "Hidalgo", 55, 45, 80), county("LOVING", "Loving", 10, 90, 50)] },
    2018: { counties: [county("HIDALGO", "Hidalgo", 70, 30, 70), county("LOVING", "Loving", 10, 90, 40)] },
  } };
  const returns = {
    HIDALGO: { name: "Hidalgo", races: { "tx-senate": [0, 0, 0, 90, 70, 20], "tx-governor": [0, 0, 0, 90, 65, 25] } },
    LOVING: { name: "Loving", races: { "tx-senate": [0, 0, 0, 50, 10, 40], "tx-governor": [0, 0, 0, 50, 9, 41] } },
  };
  const { counties, regions } = countyAnalysis(returns, baselines);
  const hidalgo = counties.find((c) => c.key === "HIDALGO");
  assert.equal(hidalgo.group, "Rio Grande Valley and border");
  assert.equal(hidalgo.swing, 57.6);
  const border = regions.find((r) => r.region === "Rio Grande Valley and border");
  assert.equal(border.turnoutVs2022, 1.125);
  assert.equal(border.demVsHarris, 1.429);
  assert.equal(regions.find((r) => r.region === "Rural and small-town").counties, 1);
});

test("U.S. House: winners from the federal section, with the seat's holder and rating from before", () => {
  const federal = { Races: [
    { N: "U. S. REPRESENTATIVE DISTRICT 15", Candidates: [{ N: "BOBBY PULIDO", P: "DEM", V: 600 }, { N: "MONICA DE LA CRUZ (I)", P: "REP", V: 400 }] },
    { N: "U. S. SENATOR", Candidates: [{ N: "X", P: "DEM", V: 1 }] },
  ] };
  const rows = usHouseResults(federal, [{ district: 15, incumbentParty: "R", incumbent: "Monica De La Cruz", consensus: { label: "Tossup" }, modelD: 0.5 }]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { district: 15, winner: "Bobby Pulido", party: "D", margin: 20, uncontested: false, heldBy: "R", incumbent: "Monica De La Cruz", consensus: "Tossup", modelD: 0.5 });
});

test("every statewide office: the Senate race first, then the state's, courts marked, names readable", () => {
  const offices = statewideOffices(
    { Races: [{ N: "JUSTICE, SUPREME COURT, PLACE 2 - UNEXPIRED TERM", Candidates: [{ N: "JANE DOE", P: "DEM", V: 52 }, { N: "JOHN ROE (I)", P: "REP", V: 48 }] }] },
    { Races: [{ N: "U. S. SENATOR", Candidates: [{ N: "JAMES TALARICO", P: "DEM", V: 56 }, { N: "KEN PAXTON", P: "REP", V: 44 }] }, { N: "U. S. REPRESENTATIVE DISTRICT 1", Candidates: [] }] },
  );
  assert.deepEqual(offices.map((o) => o.office), ["U.S. Senator", "Justice, Supreme Court, Place 2 (unexpired term)"]);
  assert.equal(offices[1].court, true);
  assert.equal(offices[1].republican, "John Roe");
  assert.equal(offices[1].margin, 4);
});
