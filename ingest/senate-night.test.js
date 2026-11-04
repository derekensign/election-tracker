import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSenateNight, calibrateRaces, mergeCalls, parseSenateCalls, runSenateNight } from "./senate-night.js";

// Four races: a safe D seat, two tossups, and an independent challenge, with 96 seats not up (49 D, 47 R), so
// Democrats need two of the four for 51.
const RACES = calibrateRaces([
  { state: "AA", stateName: "Alpha", challengerParty: "D", prior: 0.95, sigma: 5.5, republican: "R. Alpha", democrat: "D. Alpha" },
  { state: "BB", stateName: "Beta", challengerParty: "D", prior: 0.5, sigma: 5.5, republican: "R. Beta", democrat: "D. Beta" },
  { state: "CC", stateName: "Gamma", challengerParty: "D", prior: 0.5, sigma: 5.5, republican: "R. Gamma", democrat: "D. Gamma" },
  { state: "DD", stateName: "Delta", challengerParty: "I", prior: 0.3, sigma: 5.5, republican: "R. Delta", independent: "I. Delta" },
]);
const NOT_UP = { democraticCaucus: 49, republican: 47 };

test("with nothing called, each race keeps its polls-model chance", () => {
  const run = runSenateNight({ races: RACES, calls: {}, notUp: NOT_UP });
  for (const race of run.races) assert.ok(Math.abs(race.chance - RACES.find((r) => r.state === race.state).prior) < 0.002, race.state);
  assert.ok(Math.abs(run.pD + run.pR + run.pNone - 1) < 3e-4); // each is rounded to four decimals
});

test("a call pins its race and moves the others the same way", () => {
  const before = runSenateNight({ races: RACES, calls: {}, notUp: NOT_UP });
  const after = runSenateNight({ races: RACES, calls: { BB: { winner: "R" } }, notUp: NOT_UP });
  const chance = (run, state) => run.races.find((r) => r.state === state).chance;
  assert.equal(chance(after, "BB"), 0);
  assert.ok(chance(after, "CC") < chance(before, "CC") - 0.05, "a Republican win in one tossup lowers the other");
  assert.ok(after.nationalSwing.mean < 0);
  assert.ok(after.pD < before.pD);
});

test("calls are read from a marked winner or a stated result, and specials are matched by state", () => {
  const wikitext = `=== Elections leading to the next Congress ===
{| class="wikitable"
|-
! [[2026 United States Senate election in Alpha|Alpha]]
| {{Party shading/Democratic}} | Democratic
| {{Party shading/Democratic/Hold}} | Incumbent re-elected.
| nowrap | {{Plainlist |
*{{Party stripe|Democratic Party (US)}}{{Aye}} '''[[D. Alpha]]''' (Democratic) 58.0%
*{{Party stripe|Republican Party (US)}}[[R. Alpha]] (Republican) 41.0%
}}
|-
! [[2026 United States Senate special election in Beta|Beta]]<br />(Class 3)
| {{Party shading/Republican}} | Republican
| {{Party shading/Republican}} | Incumbent elected.<br />'''Republican hold.'''
| nowrap | {{Plainlist |
*{{Party stripe|Republican Party (US)}}[[R. Beta]] (Republican)
*{{Party stripe|Democratic Party (US)}}[[D. Beta]] (Democratic)
}}
|-
! [[2026 United States Senate election in Gamma|Gamma]]
| {{Party shading/Republican}} | Republican
| data-sort-value=1 | Incumbent running
| nowrap | {{Plainlist |
*{{Party stripe|Republican Party (US)}}[[R. Gamma]] (Republican)
}}
|}
== Alpha ==`;
  const calls = parseSenateCalls(wikitext, { Alpha: "AA", Beta: "BB", Gamma: "CC" });
  assert.deepEqual(Object.keys(calls).sort(), ["AA", "BB"]);
  assert.equal(calls.AA.winner, "D");
  assert.equal(calls.AA.name, "D. Alpha");
  assert.equal(calls.BB.winner, "R");
});

test("manual overrides win, and \"none\" withdraws a call", () => {
  const merged = mergeCalls({ AA: { winner: "D" }, BB: { winner: "R" } }, { BB: "none", CC: "D", _note: "ignored" });
  assert.deepEqual(Object.keys(merged).sort(), ["AA", "CC"]);
  assert.equal(merged.CC.via, "manual");
});

test("each new call is an event, and an unlikely winner is marked as an upset", () => {
  const doc = { checkedAt: null, timeline: [{ t: "2026-11-04T00:00:00Z", p: 0.6 }], events: [], latest: { calls: {} }, inputs: { races: RACES, notUp: NOT_UP } };
  advanceSenateNight(doc, { calls: { BB: { winner: "D" } }, fetchedAt: "2026-11-04T01:00:00Z" });
  assert.equal(doc.events.length, 1);
  assert.equal(doc.events[0].kind, "call"); // a tossup
  assert.match(doc.events[0].detail, /^Beta called for D\. Beta \(D\)\. On its own, it moved Democrats' chance of control from 60% to/);
  advanceSenateNight(doc, { calls: { BB: { winner: "D" }, DD: { winner: "I" } }, fetchedAt: "2026-11-04T01:02:00Z" });
  assert.equal(doc.events.length, 2);
  assert.equal(doc.events[1].kind, "upset"); // the independent had a 30% chance
  assert.match(doc.events[1].detail, /an upset: the polls gave that side 30%/);
  advanceSenateNight(doc, { calls: { BB: { winner: "D" }, DD: { winner: "I" } }, fetchedAt: "2026-11-04T01:04:00Z" });
  assert.equal(doc.timeline.length, 3, "an unchanged check adds no point");
});

test("calls landing together each show their own effect", () => {
  const doc = { checkedAt: null, timeline: [{ t: "2026-11-04T00:00:00Z", p: 0.6 }], events: [], latest: { calls: {} }, inputs: { races: RACES, notUp: NOT_UP } };
  advanceSenateNight(doc, { calls: { AA: { winner: "D" }, BB: { winner: "R" } }, fetchedAt: "2026-11-04T01:00:00Z" });
  const safe = doc.events.find((e) => e.state === "AA"), tossup = doc.events.find((e) => e.state === "BB");
  assert.ok(Math.abs(safe.p1 - safe.p0) < Math.abs(tossup.p1 - tossup.p0), "the safe seat moves control less than the tossup");
  assert.match(safe.detail, /with 1 other race called in the same check/);
});

test("projected margins: the starting margin with nothing called, the winning side of zero once called", () => {
  const open = runSenateNight({ races: RACES, calls: {}, notUp: NOT_UP });
  for (const race of open.races) assert.ok(Math.abs(race.expectedMargin - RACES.find((r) => r.state === race.state).margin) < 0.15, race.state);
  const called = runSenateNight({ races: RACES, calls: { BB: { winner: "R" }, AA: { winner: "D" } }, notUp: NOT_UP });
  const margin = (state) => called.races.find((r) => r.state === state).expectedMargin;
  assert.ok(margin("BB") < 0 && margin("AA") > 0);
  assert.ok(margin("CC") < open.races.find((r) => r.state === "CC").expectedMargin, "the Republican call drags the other tossup");
});

test("each point carries every race's chance and the national read; counts are stored without adding points", () => {
  const doc = { inputs: { races: RACES, notUp: NOT_UP }, timeline: [{ t: "2026-11-03T21:30:00Z", p: 0.5, r: RACES.map((r) => r.prior), n: 0 }], events: [], latest: { calls: {}, texas: null } };
  advanceSenateNight(doc, { calls: { BB: { winner: "D" } }, fetchedAt: "2026-11-03T23:00:00Z" });
  const point = doc.timeline.at(-1);
  assert.equal(point.r.length, RACES.length);
  assert.equal(point.r[1], 1);
  assert.ok(point.n > 0);
  const returns = { BB: { total: 100, margin: 4 } };
  const { changed } = advanceSenateNight(doc, { calls: { BB: { winner: "D" } }, returns, fetchedAt: "2026-11-03T23:02:00Z" });
  assert.equal(changed, false);
  assert.equal(doc.timeline.length, 2);
  assert.deepEqual(doc.returns, returns);
});

test("the seat distribution sums to one, puts the control chance at 51 or more, and narrows as races are called", () => {
  const open = runSenateNight({ races: RACES, calls: {}, notUp: NOT_UP });
  const total = open.seatHistogram.reduce((t, h) => t + h.probability, 0);
  assert.ok(Math.abs(total - 1) < 0.003);
  const atLeast51 = open.seatHistogram.filter((h) => h.d >= 51).reduce((t, h) => t + h.probability, 0);
  assert.ok(Math.abs(atLeast51 - open.pD) < 0.003);
  const called = runSenateNight({ races: RACES, calls: { AA: { winner: "D" }, BB: { winner: "D" } }, notUp: NOT_UP });
  assert.ok(called.seatHistogram.length < open.seatHistogram.length);
});

test("a call's party follows its winner's name, so Minnesota's DFL counts as Democratic", async () => {
  const { fixCallParties } = await import("./senate-night.js");
  const races = [{ state: "MN", democrat: "Peggy Flanagan", republican: "Michele Tafoya", independent: "Marisa Simonetti" }];
  assert.equal(fixCallParties({ MN: { winner: "other", name: "Peggy Flanagan", via: "winner marked" } }, races).MN.winner, "D");
  assert.equal(fixCallParties({ MN: { winner: "D", name: null, via: "result: Democratic hold" } }, races).MN.winner, "D");
});
