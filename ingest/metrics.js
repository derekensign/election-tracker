// Derived numbers: polling averages, rating consensus, and the Senate seat distribution.
import { RATING_PRIOR_D_WIN, RATING_SCALE } from "./config.js";

const DAY_MS = 86_400_000;

/**
 * Recency- and size-weighted polling average (Democratic margin, D% − R%).
 * Window: polls ending within `windowDays` of `asOf`; if fewer than `minPolls`, fall back to the latest `minPolls`.
 * Weights: exp(−age/halfLife) × sqrt(sampleSize/600) × 0.5 if partisan/internal. Deduplicates pollster+endDate (one per pollster per field period).
 */
export function pollingAverage(polls, { asOf, windowDays = 30, halfLifeDays = 14, minPolls = 3 } = {}) {
  const asOfMs = Date.parse(asOf);
  const deduped = dedupePolls(polls).filter((p) => p.endDate && Date.parse(p.endDate) <= asOfMs + DAY_MS);
  deduped.sort((a, b) => (a.endDate < b.endDate ? 1 : -1));
  let window = deduped.filter((p) => asOfMs - Date.parse(p.endDate) <= windowDays * DAY_MS);
  if (window.length < minPolls) window = deduped.slice(0, minPolls);
  if (window.length === 0) return null;
  let weightSum = 0;
  let demSum = 0;
  let repSum = 0;
  for (const poll of window) {
    const ageDays = Math.max(0, (asOfMs - Date.parse(poll.endDate)) / DAY_MS);
    let weight = Math.exp(-ageDays / halfLifeDays) * Math.sqrt((poll.sampleSize || 600) / 600);
    if (poll.partisan || poll.internal) weight *= 0.5;
    weightSum += weight;
    demSum += poll.dem * weight;
    repSum += poll.rep * weight;
  }
  const dem = demSum / weightSum;
  const rep = repSum / weightSum;
  return {
    dem: round1(dem), rep: round1(rep), margin: round1(dem - rep),
    pollCount: window.length,
    oldest: window[window.length - 1].endDate, newest: window[0].endDate,
    windowDays, halfLifeDays,
  };
}

/** Merge VoteHub + Wikipedia copies of the same poll: same pollster stem and same end date (±1 day). */
export function dedupePolls(polls) {
  const kept = [];
  for (const poll of polls) {
    const stem = pollsterStem(poll.pollster);
    const duplicate = kept.find((k) => pollsterStem(k.pollster) === stem && k.endDate && poll.endDate && Math.abs(Date.parse(k.endDate) - Date.parse(poll.endDate)) <= DAY_MS && k.population === poll.population);
    if (duplicate) {
      // Prefer the entry with a URL and a sample size; keep the other's id so change detection still sees it.
      duplicate.alsoIds = [...(duplicate.alsoIds || []), poll.id];
      if (!duplicate.url && poll.url) duplicate.url = poll.url;
      if (!duplicate.sampleSize && poll.sampleSize) duplicate.sampleSize = poll.sampleSize;
      continue;
    }
    kept.push({ ...poll });
  }
  return kept;
}

function pollsterStem(name) {
  return (name || "").toLowerCase().replace(/\(.*?\)/g, "").replace(/university|college|research|polling|strategies|group|inc\.?|the|&|and|\/|,/g, "").replace(/[^a-z]/g, "").slice(0, 10);
}

export function ratingScore(label) {
  if (!label) return null;
  const normalized = label.replace(/Toss-?up/i, "Tossup").replace(/Solid/i, "Safe");
  return RATING_SCALE[normalized] ?? RATING_SCALE[label] ?? null;
}

export function labelForScore(score) {
  if (score === null || score === undefined) return null;
  const rounded = Math.max(-4, Math.min(4, Math.round(score)));
  return { 4: "Safe D", 3: "Likely D", 2: "Lean D", 1: "Tilt D", 0: "Tossup", "-1": "Tilt R", "-2": "Lean R", "-3": "Likely R", "-4": "Safe R" }[rounded];
}

/** Mean of forecaster scores, mapped back to a label, plus the spread (disagreement). */
export function ratingConsensus(ratings) {
  const scores = Object.values(ratings || {}).map((r) => ratingScore(typeof r === "string" ? r : r?.label)).filter((s) => s !== null);
  if (scores.length === 0) return null;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return { score: Math.round(mean * 100) / 100, label: labelForScore(mean), count: scores.length, min: Math.min(...scores), max: Math.max(...scores) };
}

export function priorFromRating(label) {
  const score = ratingScore(label);
  return score === null ? 0.5 : RATING_PRIOR_D_WIN[String(score)];
}

/**
 * Joint distribution of (Democratic-caucus seats, Republican seats) after the election, treating races as independent.
 * `races`: [{ pD, pR, pI }] summing to 1 each. Returns { seats: [{ d, r, other, probability }], control: { D, R, none }, expected }.
 */
export function seatDistribution(races, { democraticCaucusNotUp, republicanNotUp }) {
  // dp[d][r] = probability of d Democratic wins and r Republican wins among races processed so far
  let dp = new Map([[`0,0`, 1]]);
  for (const race of races) {
    const next = new Map();
    for (const [key, probability] of dp) {
      const [d, r] = key.split(",").map(Number);
      add(next, `${d + 1},${r}`, probability * race.pD);
      add(next, `${d},${r + 1}`, probability * race.pR);
      if (race.pI > 0) add(next, `${d},${r}`, probability * race.pI);
    }
    dp = next;
  }
  const outcomes = [];
  const control = { D: 0, R: 0, none: 0 };
  let expectedD = 0;
  let expectedR = 0;
  const byDemocraticSeats = new Map();
  for (const [key, probability] of dp) {
    const [dWins, rWins] = key.split(",").map(Number);
    const d = democraticCaucusNotUp + dWins;
    const r = republicanNotUp + rWins;
    const other = 100 - d - r;
    outcomes.push({ d, r, other, probability });
    expectedD += d * probability;
    expectedR += r * probability;
    // 51 seats is an outright majority; at 50 the Republican Vice President breaks the tie.
    if (d >= 51) control.D += probability;
    else if (r >= 50) control.R += probability;
    else control.none += probability;
    byDemocraticSeats.set(d, (byDemocraticSeats.get(d) || 0) + probability);
  }
  outcomes.sort((a, b) => a.d - b.d || a.r - b.r);
  const histogram = [...byDemocraticSeats.entries()].map(([d, probability]) => ({ d, probability })).sort((a, b) => a.d - b.d);
  return {
    outcomes: outcomes.filter((o) => o.probability >= 0.0005),
    histogram,
    control,
    expected: { D: Math.round(expectedD * 10) / 10, R: Math.round(expectedR * 10) / 10, other: Math.round((100 - expectedD - expectedR) * 10) / 10 },
  };
}

function add(map, key, value) { if (value > 0) map.set(key, (map.get(key) || 0) + value); }
function round1(value) { return Math.round(value * 10) / 10; }
