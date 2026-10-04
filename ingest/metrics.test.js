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
