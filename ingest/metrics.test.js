import { test } from "node:test";
import assert from "node:assert/strict";
import { pollingAverage, ratingConsensus, seatDistribution, dedupePolls } from "./metrics.js";
import { parseTable, parseRaceRating, parseDateRange, parsePviMargin, extractTables } from "./wikitext.js";
import { detectChanges } from "./diff.js";

test("seat distribution sums to one and respects the VP tiebreak", () => {
  const races = [{ pD: 1, pR: 0, pI: 0 }, { pD: 0.5, pR: 0.5, pI: 0 }];
  const result = seatDistribution(races, { democraticCaucusNotUp: 49, republicanNotUp: 49 });
  const total = result.outcomes.reduce((s, o) => s + o.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.equal(result.control.D, 0.5); // 51 D half the time
  assert.equal(result.control.R, 0.5); // 50-50 goes to the Republican VP
  assert.equal(result.expected.D, 50.5);
});

test("independent wins reduce both parties' seats", () => {
  const result = seatDistribution([{ pD: 0, pR: 0, pI: 1 }], { democraticCaucusNotUp: 49, republicanNotUp: 50 });
  assert.equal(result.outcomes[0].other, 1);
  assert.equal(result.control.R, 1); // 50 R + VP
});

test("polling average weights recent, larger, nonpartisan polls more", () => {
  const polls = [
    { pollster: "A", endDate: "2026-10-01", sampleSize: 1000, dem: 50, rep: 44 },
    { pollster: "B", endDate: "2026-09-01", sampleSize: 1000, dem: 44, rep: 50 },
    { pollster: "C (R)", endDate: "2026-10-02", sampleSize: 600, dem: 45, rep: 47, partisan: "R" },
  ];
  const average = pollingAverage(polls, { asOf: "2026-10-04" });
  assert.equal(average.pollCount, 3); // window has 2, so minPolls pulls in the third
  assert.ok(average.margin > 0 && average.margin < 6);
});

test("dedupe merges the same poll from two feeds", () => {
  const merged = dedupePolls([
    { id: "a", pollster: "Emerson College", endDate: "2026-09-14", population: "LV", dem: 47, rep: 46 },
    { id: "b", pollster: "Emerson", endDate: "2026-09-14", population: "LV", dem: 47, rep: 46, url: "x" },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].alsoIds, ["b"]);
  assert.equal(merged[0].url, "x");
});

test("rating consensus averages the ordinal scale", () => {
  const consensus = ratingConsensus({ a: "Tossup", b: "Lean D", c: "Tilt R" });
  assert.equal(consensus.label, "Tossup");
  assert.equal(consensus.count, 3);
});

test("wikitable parser handles rowspan carry-down and templates", () => {
  const table = `{| class="wikitable"\n! Poll\n! Dates\n! Sample\n! A\n! B\n|-\n| rowspan="2" | Fox<ref>x</ref>\n| rowspan="2" | September 24–28, 2026\n| 881 (LV)\n| {{party shading/Democratic}}|'''51%'''\n| 49%\n|-\n| 1,203 (RV)\n| 53%\n| 46%\n|}`;
  const rows = parseTable(extractTables(table)[0]);
  assert.equal(rows.length, 3);
  assert.equal(rows[2][0].text.startsWith("Fox"), true);
  assert.equal(rows[2][2].text, "1,203 (RV)");
  assert.deepEqual(parseDateRange(rows[1][1].text), { start: "2026-09-24", end: "2026-09-28" });
});

test("race rating and PVI templates parse", () => {
  assert.deepEqual(parseRaceRating("{{USRaceRating|Lean|D|flip}}"), { label: "Lean D", flip: true });
  assert.deepEqual(parseRaceRating("{{USRaceRating|Tossup}}"), { label: "Tossup", flip: false });
  assert.equal(parsePviMargin("{{Shading PVI|R|55.7}}"), -55.7);
  assert.deepEqual(parseDateRange("Sep 28 – Oct 1, 2026"), { start: "2026-09-28", end: "2026-10-01" });
});

test("change detection flags rating moves and new polls", () => {
  const base = {
    usSenate: { forecasters: [{ key: "cook", name: "Cook" }], races: [{ id: "us-senate-TX", state: "TX", stateName: "Texas", ratings: { cook: "Tossup" }, odds: { polymarket: { D: 0.6 } }, polls: [], pollingAverage: { margin: 2 } }] },
    texas: { races: [] }, txHouse: { districts: [] }, txSenate: { districts: [] }, senateControl: {},
  };
  const next = structuredClone(base);
  next.usSenate.races[0].ratings.cook = "Lean D";
  next.usSenate.races[0].odds.polymarket.D = 0.65;
  next.usSenate.races[0].polls = [{ id: "p1", pollster: "Siena", endDate: "2026-10-03", dem: 50, rep: 45 }];
  const changes = detectChanges(base, next);
  assert.ok(changes.some((c) => c.type === "rating" && /Tossup → Lean D/.test(c.text)));
  assert.ok(changes.some((c) => c.type === "market"));
  assert.ok(changes.some((c) => c.type === "poll" && /Siena/.test(c.text)));
});

test("student-t cdf matches table values", async () => {
  const { studentTCdf, pollWinProbability, qualityMultiplier } = await import("./metrics.js");
  assert.ok(Math.abs(studentTCdf(0, 5) - 0.5) < 1e-9);
  assert.ok(Math.abs(studentTCdf(2.015, 5) - 0.95) < 1e-3);
  assert.ok(Math.abs(studentTCdf(-1.476, 5) - 0.1) < 1e-3);
  const even = pollWinProbability({ margin: 0, effectiveN: 5 }, { daysToElection: 30 });
  assert.equal(even.pD, 0.5);
  const sparse = pollWinProbability({ margin: 4, effectiveN: 1 }, { daysToElection: 30 });
  const dense = pollWinProbability({ margin: 4, effectiveN: 8 }, { daysToElection: 30 });
  assert.ok(sparse.pD < dense.pD, "thin polling should be less confident");
  assert.equal(qualityMultiplier({ numericGrade: 3 }), 1);
  assert.equal(qualityMultiplier(null), 0.5);
});

test("pollster matcher avoids generic-word false positives", async () => {
  const { ratePollster } = await import("./pollsters.js");
  assert.equal(ratePollster("Emerson College").pollster, "Emerson College");
  assert.equal(ratePollster("New York Times/Siena University").grade, "A+");
  assert.equal(ratePollster("Texas Southern University").matched, null);
  assert.equal(ratePollster("Nexus Strategies/Strategic Partners Solutions").matched, null);
  assert.equal(ratePollster("Texas Public Opinion Research").matched, null);
});

test("quality weighting changes the average", () => {
  const polls = [
    { pollster: "Good", endDate: "2026-10-01", sampleSize: 800, dem: 52, rep: 44 },
    { pollster: "Bad", endDate: "2026-10-01", sampleSize: 800, dem: 44, rep: 52 },
    { pollster: "Mid", endDate: "2026-09-30", sampleSize: 800, dem: 48, rep: 48 },
  ];
  const ratings = { Good: { numericGrade: 3 }, Bad: { numericGrade: 0.3 }, Mid: { numericGrade: 1.5 } };
  const weighted = pollingAverage(polls, { asOf: "2026-10-04", ratePollster: (name) => ratings[name] });
  const flat = pollingAverage(polls, { asOf: "2026-10-04" });
  assert.ok(weighted.margin > flat.margin);
  assert.ok(weighted.effectiveN < 3 && weighted.effectiveN > 1);
  assert.equal(weighted.weights.length, 3);
});

test("chamber model: environment blend and control probability behave", async () => {
  const { estimateEnvironment, runChamberModel, seatBaseline } = await import("./legislature.js");
  const env = estimateEnvironment({ genericBallotAverage: { margin: -4, pollCount: 3 }, downBallotAverages: [{ margin: -6 }, { margin: -2 }] });
  assert.equal(env.margin, -4); // 0.6×(−4) + 0.4×(−4)
  assert.equal(env.swingFrom2024, 9.7);
  const districts = [
    { district: 1, party: "R", presidentialMargin2024: -3, incumbent: "A" },
    { district: 2, party: "R", presidentialMargin2024: -40, incumbent: "B" },
    { district: 3, party: "D", presidentialMargin2024: 20, incumbent: "C", retiring: true },
  ];
  const base = seatBaseline(districts[0], env);
  assert.equal(base.incumbency, -3);
  const result = runChamberModel({ districts, notUp: { D: 0, R: 0 }, majority: 2, environment: env });
  const byDistrict = Object.fromEntries(result.seats.map((s) => [s.district, s.pD]));
  assert.ok(byDistrict[1] > 0.4 && byDistrict[1] < 0.8, `competitive seat ${byDistrict[1]}`);
  assert.ok(byDistrict[2] < 0.05, "deep-red seat stays red");
  assert.ok(byDistrict[3] > 0.95, "deep-blue open seat stays blue");
  const total = result.histogram.reduce((s, h) => s + h.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-6);
  assert.ok(result.control.D > 0.4 && result.control.D < 0.8);
});

test("rated chamber model: implied margins and control", async () => {
  const { ratingImpliedMargin, runRatedChamberModel } = await import("./legislature.js");
  assert.equal(ratingImpliedMargin("Tossup"), 0);
  assert.equal(ratingImpliedMargin("Lean R"), -5.5);
  assert.equal(ratingImpliedMargin("Safe D"), 17);
  const seats = [{ id: "a", margin: 0 }, { id: "b", margin: 10 }, { id: "c", margin: -17 }];
  const result = runRatedChamberModel({ seats, notUp: { D: 1, R: 1 }, majority: 3 });
  const total = result.histogram.reduce((s, h) => s + h.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-6);
  assert.equal(result.totalSeats, 5);
  assert.ok(result.control.D > 0.3 && result.control.D < 0.6, `control ${result.control.D}`);
});
