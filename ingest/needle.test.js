import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceNeedle, explainMove, normalCdf, parseCountyReturns, runNeedleRace, studentMixtureNodes } from "./needle.js";
import { studentTCdf } from "./metrics.js";

// A three-county toy state: a blue city, a red rural county, a swingy suburb.
const COUNTIES = [
  { key: "CITY", name: "City", region: "Big cities", early: 400000, registered: 900000, lean: 22, relativeShift: -3, past: {} },
  { key: "FARM", name: "Farm", region: "Rural and small-town", early: 150000, registered: 300000, lean: -45, relativeShift: 2, past: {} },
  { key: "BURB", name: "Burb", region: "Suburbs", early: 250000, registered: 500000, lean: -4, relativeShift: 1, past: {} },
];
const RACE = { id: "tx-senate", prior: { margin: 2, pD: 0.62, sigma: 5.5 } };

/** Returns for one county: [early votes, early D, early R, total votes, total D, total R]. */
function countyReturn(name, dayReporting, early, total) {
  return { name, dayReporting, ballots: 0, races: { "tx-senate": [...early, ...total] } };
}

test("the Student-t scale mixture matches the t distribution the polls model uses", () => {
  const nodes = studentMixtureNodes(5, 40);
  assert.ok(Math.abs(nodes.reduce((t, n) => t + n.weight, 0) - 1) < 1e-9);
  for (const x of [0.5, 1, 2, 3]) {
    const mixture = nodes.reduce((t, n) => t + n.weight * normalCdf(x / Math.sqrt(n.varianceScale)), 0);
    assert.ok(Math.abs(mixture - studentTCdf(x, 5)) < 0.002, `t5 cdf at ${x}`);
  }
});

test("with nothing counted the needle is the polls model", () => {
  const run = runNeedleRace({ counties: COUNTIES, returns: null, race: RACE });
  assert.ok(Math.abs(run.pD - 0.62) < 0.002, `pD ${run.pD}`);
  assert.ok(Math.abs(run.margin - 2) < 0.05, `margin ${run.margin}`);
  assert.equal(run.countedVotes, 0);
});

test("the starting point adds half of the early-vote turnout mix to the polls", () => {
  // 2026 early ballots lean toward the blue city compared with the 2022 electorate (city 50% of ballots, 40% in 2022).
  const counties = COUNTIES.map((c) => ({ ...c, pastTotal: { 2022: { CITY: 400000, FARM: 300000, BURB: 300000 }[c.key] } }));
  const run = runNeedleRace({ counties, returns: null, race: RACE });
  const share2026 = { CITY: 0.5, FARM: 0.1875, BURB: 0.3125 }, share2022 = { CITY: 0.4, FARM: 0.3, BURB: 0.3 };
  const mix = counties.reduce((t, c) => t + (share2026[c.key] - share2022[c.key]) * c.lean, 0);
  assert.ok(Math.abs(run.startingPoint.turnoutMix - mix) < 0.05, `mix ${run.startingPoint.turnoutMix} vs ${mix}`);
  assert.ok(Math.abs(run.margin - (RACE.prior.margin + mix / 2)) < 0.05, `margin ${run.margin}`);
  assert.ok(run.pD > RACE.prior.pD, "a bluer turnout mix raises the Democrat's starting chance");
});

test("a fully counted race is certain and lands on the counted margin", () => {
  const returns = {
    CITY: countyReturn("City", 1, [394000, 236000, 150000], [532000, 318000, 205000]),
    FARM: countyReturn("Farm", 1, [147000, 40000, 105000], [199000, 54000, 142000]),
    BURB: countyReturn("Burb", 1, [246000, 118000, 124000], [332000, 158000, 169000]),
  };
  const run = runNeedleRace({ counties: COUNTIES, returns, race: RACE });
  const countedNet = (318000 + 54000 + 158000) - (205000 + 142000 + 169000);
  assert.equal(run.countedNet, countedNet);
  assert.ok(run.pD > 0.999, `pD ${run.pD}`);
  assert.ok(Math.abs(run.margin - (100 * countedNet) / (532000 + 199000 + 332000)) < 0.01, `margin ${run.margin}`);
});

test("early votes running ahead of the priors raise the needle; a worse Election Day lowers it", () => {
  // A race that starts even. Every county's early vote is 3 points more Democratic than its prior.
  const race = { id: "tx-senate", prior: { margin: 0.3, pD: 0.52, sigma: 5.5 } };
  const base = runNeedleRace({ counties: COUNTIES, returns: null, race });
  const priorOf = Object.fromEntries(base.counties.map((c) => [c.key, c.priorMargin]));
  const votesAt = (votes, margin) => { const dem = Math.round((votes * (1 + margin / 100)) / 2); return [votes, dem, votes - dem]; };
  const early = (county) => votesAt(Math.round(county.early * 0.985), priorOf[county.key] + 3);
  const earlyOnly = Object.fromEntries(COUNTIES.map((c) => [c.key, countyReturn(c.name, 0, early(c), early(c))]));
  const afterEarly = runNeedleRace({ counties: COUNTIES, returns: earlyOnly, race });
  assert.ok(afterEarly.pD > base.pD + 0.1, `pD ${base.pD} -> ${afterEarly.pD}`);

  // Half of each county's Election Day vote then comes in 12 points more Republican than its early vote, which
  // is what the prior expects if the state is right on the polls and Election Day runs 12 points redder.
  const withDay = Object.fromEntries(COUNTIES.map((c) => {
    const e = early(c), day = votesAt(Math.round(c.early * 0.35 * 0.985 * 0.5), priorOf[c.key] + 3 - 12);
    return [c.key, countyReturn(c.name, 0.5, e, [e[0] + day[0], e[1] + day[1], e[2] + day[2]])];
  }));
  const afterDay = runNeedleRace({ counties: COUNTIES, returns: withDay, race });
  assert.ok(afterDay.shared.electionDay.mean < -4, `election-day offset ${afterDay.shared.electionDay.mean}`);
  assert.ok(afterDay.pD < afterEarly.pD - 0.05, `pD ${afterEarly.pD} -> ${afterDay.pD}`);
});

test("county file parsing splits early and Election Day votes by party", () => {
  const file = {
    101: {
      N: "DE WITT",
      Summary: { NPL: 0, PLR: 0, PRP: 20, PRR: 5, VC: 9000 },
      Races: {
        5075: { N: "U. S. SENATOR ", C: { a: { P: "DEM", V: 3000, EV: 2000 }, b: { P: "REP", V: 5600, EV: 4000 }, c: { P: "L", V: 100, EV: 60 } } },
        3579: { N: "GOVERNOR", C: { a: { P: "DEM", V: 2900, EV: 1900 }, b: { P: "REP", V: 5700, EV: 4100 } } },
      },
    },
  };
  const returns = parseCountyReturns(file);
  assert.deepEqual(Object.keys(returns), ["DEWITT"]);
  assert.equal(returns.DEWITT.name, "De Witt");
  assert.equal(returns.DEWITT.dayReporting, 0.25); // no polling-place count, so precincts
  assert.deepEqual(returns.DEWITT.races["tx-senate"], [6060, 2000, 4000, 8700, 3000, 5600]);
  assert.deepEqual(returns.DEWITT.races["tx-governor"], [6000, 1900, 4100, 8600, 2900, 5700]);
});

test("the explanation names the batch that surprised the model most", () => {
  const before = runNeedleRace({ counties: COUNTIES, returns: null, race: RACE });
  const expected = Object.fromEntries(before.counties.map((c) => [c.key, c.priorMargin]));
  const batch = (county, points) => { const votes = Math.round(county.early * 0.985), dem = Math.round((votes * (1 + (expected[county.key] + points) / 100)) / 2); return [votes, dem, votes - dem]; };
  const returns = {
    CITY: countyReturn("City", 0, batch(COUNTIES[0], 9), batch(COUNTIES[0], 9)),
    FARM: countyReturn("Farm", 0, batch(COUNTIES[1], 1), batch(COUNTIES[1], 1)),
  };
  const after = runNeedleRace({ counties: COUNTIES, returns, race: RACE });
  const why = explainMove(before, after);
  assert.equal(why.subject, "City");
  assert.equal(why.kind, "early");
  assert.ok(Math.abs(why.margin - why.expectedMargin - 9) < 0.3, `gap ${why.margin - why.expectedMargin}`);
});

test("the document gains a point only when returns change, and annotates the first returns", () => {
  const doc = {
    createdAt: "2026-11-04T00:30:00Z", events: [], latest: null,
    inputs: { counties: COUNTIES, races: [{ ...RACE, office: "U.S. Senate", democrat: "James Talarico", republican: "Ken Paxton" }] },
    timeline: { "tx-senate": [{ t: "2026-11-04T00:30:00Z", p: 0.62, m: 2, c: 0 }] },
  };
  const returns = { CITY: countyReturn("City", 0, [394000, 236000, 150000], [394000, 236000, 150000]) };
  const memory = {};
  advanceNeedle(doc, { returns, fetchedAt: "2026-11-04T01:05:00Z" }, memory);
  advanceNeedle(doc, { returns, fetchedAt: "2026-11-04T01:07:00Z" }, memory);
  assert.equal(doc.timeline["tx-senate"].length, 2);
  assert.equal(doc.checkedAt, "2026-11-04T01:07:00Z");
  assert.equal(doc.events.length, 1);
  assert.equal(doc.events[0].kind, "first");
  assert.match(doc.events[0].detail, /City County's early vote: Talarico \+/);
});
