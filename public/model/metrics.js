// Derived numbers: polling averages, rating consensus, and the Senate seat distribution.
import { RATING_PRIOR_D_WIN, RATING_SCALE } from "./config.js";

const DAY_MS = 86_400_000;

/**
 * Recency- and size-weighted polling average (Democratic margin, D% − R%).
 * Window: polls ending within `windowDays` of `asOf`; if fewer than `minPolls`, fall back to the latest `minPolls`.
 * Weights: exp(−age/halfLife) × sqrt(sampleSize/600) × 0.5 if partisan/internal. Deduplicates pollster+endDate (one per pollster per field period).
 */
export function pollingAverage(polls, { asOf, windowDays = 30, halfLifeDays = 14, minPolls = 3, ratePollster = null } = {}) {
  const asOfMs = Date.parse(asOf);
  const deduped = dedupePolls(polls).filter((p) => p.endDate && Date.parse(p.endDate) <= asOfMs + DAY_MS);
  deduped.sort((a, b) => (a.endDate < b.endDate ? 1 : -1));
  let window = deduped.filter((p) => asOfMs - Date.parse(p.endDate) <= windowDays * DAY_MS);
  if (window.length < minPolls) window = deduped.slice(0, minPolls);
  if (window.length === 0) return null;
  let weightSum = 0;
  let weightSquares = 0;
  let demSum = 0;
  let repSum = 0;
  const weighted = [];
  for (const poll of window) {
    const ageDays = Math.max(0, (asOfMs - Date.parse(poll.endDate)) / DAY_MS);
    const rating = ratePollster ? ratePollster(poll.pollster) : null;
    const quality = ratePollster ? qualityMultiplier(rating) : 1;
    let weight = Math.exp(-ageDays / halfLifeDays) * Math.sqrt((poll.sampleSize || 600) / 600) * quality;
    if (poll.partisan || poll.internal) weight *= 0.5;
    weightSum += weight;
    weightSquares += weight * weight;
    demSum += poll.dem * weight;
    repSum += poll.rep * weight;
    weighted.push({ id: poll.id, pollster: poll.pollster, endDate: poll.endDate, weight: Math.round(weight * 1000) / 1000, grade: rating?.grade ?? null, numericGrade: rating?.numericGrade ?? null, ratedAs: rating?.matched ? rating.pollster : null });
  }
  const dem = demSum / weightSum;
  const rep = repSum / weightSum;
  // Kish effective sample size: how many equally-weighted polls this average is worth.
  const effectiveN = weightSum * weightSum / weightSquares;
  return {
    dem: round1(dem), rep: round1(rep), margin: round1(dem - rep),
    pollCount: window.length, effectiveN: Math.round(effectiveN * 10) / 10,
    oldest: window[window.length - 1].endDate, newest: window[0].endDate,
    windowDays, halfLifeDays, qualityWeighted: Boolean(ratePollster),
    weights: weighted,
  };
}

/** 3.0 → 1.0, 1.5 → 0.675, 0 → 0.35; unrated pollsters 0.5. */
export function qualityMultiplier(rating) {
  if (!rating || rating.numericGrade === null || rating.numericGrade === undefined) return 0.5;
  return 0.35 + 0.65 * (rating.numericGrade / 3);
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
  const hasIndependents = races.some((race) => race.pI > 0);
  // Fast path (no third-party candidates): a plain Poisson-binomial over Democratic wins, O(n²).
  if (!hasIndependents) {
    let dp = new Float64Array(races.length + 1);
    dp[0] = 1;
    races.forEach((race, index) => {
      const next = new Float64Array(races.length + 1);
      for (let d = 0; d <= index; d += 1) {
        if (dp[d] === 0) continue;
        next[d + 1] += dp[d] * race.pD;
        next[d] += dp[d] * (1 - race.pD);
      }
      dp = next;
    });
    const outcomes = [];
    const histogram = [];
    const control = { D: 0, R: 0, none: 0 };
    let expectedD = 0;
    for (let wins = 0; wins <= races.length; wins += 1) {
      const probability = dp[wins];
      if (probability === 0) continue;
      const d = democraticCaucusNotUp + wins;
      const r = republicanNotUp + races.length - wins;
      expectedD += d * probability;
      if (d >= 51) control.D += probability; else if (r >= 50) control.R += probability; else control.none += probability;
      histogram.push({ d, probability });
      if (probability >= 0.0005) outcomes.push({ d, r, other: 0, probability });
    }
    const total = democraticCaucusNotUp + republicanNotUp + races.length;
    return { outcomes, histogram, control, expected: { D: Math.round(expectedD * 10) / 10, R: Math.round((total - expectedD) * 10) / 10, other: 0 } };
  }
  // General path: joint distribution over (Democratic wins, Republican wins); the remainder are independents.
  const n = races.length + 1;
  let dp = new Map([[0, 1]]); // key = d * n + r
  for (const race of races) {
    const next = new Map();
    for (const [key, probability] of dp) {
      const d = Math.floor(key / n);
      const r = key % n;
      add(next, (d + 1) * n + r, probability * race.pD);
      add(next, d * n + r + 1, probability * race.pR);
      if (race.pI > 0) add(next, key, probability * race.pI);
    }
    dp = next;
  }
  const outcomes = [];
  const control = { D: 0, R: 0, none: 0 };
  let expectedD = 0;
  let expectedR = 0;
  const byDemocraticSeats = new Map();
  for (const [key, probability] of dp) {
    const dWins = Math.floor(key / n);
    const rWins = key % n;
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

// ---- Poll-based win probability --------------------------------------------------------------------------------

/**
 * Student-t CDF via the regularized incomplete beta function (Numerical Recipes betacf).
 * Fat tails matter here: polling misses of 2–3 sigma happen more often than a normal predicts.
 */
export function studentTCdf(t, df) {
  const x = df / (df + t * t);
  const tail = 0.5 * regularizedIncompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

function regularizedIncompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBeta = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  if (x < (a + 1) / (a + b + 2)) return Math.exp(logBeta) * betaContinuedFraction(x, a, b) / a;
  return 1 - Math.exp(logBeta) * betaContinuedFraction(1 - x, b, a) / b;
}

function betaContinuedFraction(x, a, b) {
  const tiny = 1e-30;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny; c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny; d = 1 / d; h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny; c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny; d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 3e-14) break;
  }
  return h;
}

function logGamma(z) {
  const coefficients = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z; let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let series = 1.000000000190015;
  for (const coefficient of coefficients) series += coefficient / (y += 1);
  return -tmp + Math.log(2.5066282746310005 * series / x);
}

/**
 * Convert a polling average into a Democratic win probability.
 * Error model (D margin, points): Student-t with df 5 and scale
 *   sigma = sqrt(finalError² + (timeDrift × daysToElection)² + sparsity² / effectiveN)
 * finalError 5.5 ≈ historical RMSE of final statewide polling averages (Senate/governor, 2006–2024);
 * timeDrift 0.05/day adds ~1.5 pts a month out; sparsity 3.0 inflates thinly-polled races.
 */
export function pollWinProbability(average, { daysToElection = 0, finalError = 5.5, timeDrift = 0.05, sparsity = 3.0, df = 5 } = {}) {
  if (!average || average.margin === null || average.margin === undefined) return null;
  const effectiveN = Math.max(0.5, average.effectiveN ?? average.pollCount ?? 1);
  const sigma = Math.sqrt(finalError ** 2 + (timeDrift * Math.max(0, daysToElection)) ** 2 + (sparsity ** 2) / effectiveN);
  const pD = studentTCdf(average.margin / sigma, df);
  return { pD: Math.round(pD * 1000) / 1000, sigma: Math.round(sigma * 100) / 100, margin: average.margin, effectiveN: Math.round(effectiveN * 10) / 10, daysToElection };
}
