// Seat-level model for the Texas House and Senate: fundamentals (2024 presidential margin + statewide swing +
// incumbency) with a two-level error model (shared statewide error, independent district error), optionally
// blended with a published district rating. Produces per-seat Democratic win probabilities and a chamber
// seat distribution. All constants are documented assumptions, not fitted parameters.
import { priorFromRating, seatDistribution, studentTCdf } from "./metrics.js";

export const LEGISLATURE_MODEL = {
  // Texas 2024: Trump 56.14%, Harris 42.47%. Districts' 2024 presidential margins are measured against this.
  statewidePresidentialMargin2024: -13.67,
  // Share of a statewide swing that shows up in a legislative district (down-ballot races move less than the top).
  swingElasticity: 0.75,
  // Points an incumbent who is running again adds for their party; open seats get nothing.
  incumbencyBonus: 3.0,
  // Student-t scales: statewide environment error (shared by every seat) and district-level idiosyncratic error.
  environmentSigma: 4.5,
  districtSigma: 6.0,
  degreesOfFreedom: 5,
  // Weight on a published district rating (State Navigate) when blending in log-odds; the rest is fundamentals.
  ratingWeight: 0.5,
  environmentGridPoints: 21,
};

/**
 * Statewide environment: the Democratic margin a generic down-ballot Republican-vs-Democrat race would show today.
 * Blend of the legislative generic-ballot polling average (60%) and the mean of down-ballot statewide race averages (40%).
 */
export function estimateEnvironment({ genericBallotAverage, downBallotAverages }) {
  const downBallot = downBallotAverages.filter((a) => a && a.margin !== null && a.margin !== undefined);
  const downBallotMean = downBallot.length ? downBallot.reduce((s, a) => s + a.margin, 0) / downBallot.length : null;
  const generic = genericBallotAverage?.margin ?? null;
  let margin;
  if (generic !== null && downBallotMean !== null) margin = 0.6 * generic + 0.4 * downBallotMean;
  else margin = generic ?? downBallotMean;
  if (margin === null || margin === undefined) return null;
  return {
    margin: round1(margin),
    genericBallot: generic === null ? null : round1(generic),
    genericBallotPolls: genericBallotAverage?.pollCount ?? 0,
    downBallotMean: downBallotMean === null ? null : round1(downBallotMean),
    downBallotRaces: downBallot.length,
    swingFrom2024: round1(margin - LEGISLATURE_MODEL.statewidePresidentialMargin2024),
  };
}

/** Deterministic part of a seat's forecast margin (D-positive), before any environment error. */
export function seatBaseline(district, environment, params = LEGISLATURE_MODEL) {
  if (district.presidentialMargin2024 === null || district.presidentialMargin2024 === undefined) return null;
  const swing = environment.margin - params.statewidePresidentialMargin2024;
  const incumbentRunning = district.party && !district.retiring && !district.defeatedInPrimary && Boolean(district.incumbent);
  const incumbency = incumbentRunning ? (district.party === "D" ? params.incumbencyBonus : district.party === "R" ? -params.incumbencyBonus : 0) : 0;
  return {
    presidential: district.presidentialMargin2024,
    swing: round1(params.swingElasticity * swing),
    incumbency,
    margin: round1(district.presidentialMargin2024 + params.swingElasticity * swing + incumbency),
    incumbentRunning,
  };
}

/** Student-t quantile by bisection on the CDF (only needed for the environment grid). */
function studentTQuantile(p, df) {
  let lo = -40; let hi = 40;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function logit(p) { const q = Math.min(0.999, Math.max(0.001, p)); return Math.log(q / (1 - q)); }
function inverseLogit(x) { return 1 / (1 + Math.exp(-x)); }

/**
 * Run the chamber model.
 * `districts`: seats up for election ({ district, party, presidentialMargin2024, incumbent, retiring, defeatedInPrimary, rating }).
 * `notUp`: { D, R } seats not on the ballot. Returns { environment, seats: [...], distribution, control, expected }.
 */
export function runChamberModel({ districts, notUp, majority, environment, params = LEGISLATURE_MODEL }) {
  if (!environment) return null;
  const { degreesOfFreedom: df, environmentGridPoints: K } = params;
  // Environment error grid: equal-probability t quantiles, so averaging over the grid integrates the shared error.
  const grid = Array.from({ length: K }, (_, k) => studentTQuantile((k + 0.5) / K, df) * params.environmentSigma);
  const seatBaselines = districts.map((d) => seatBaseline(d, environment, params));
  const perSeatAccumulator = districts.map(() => 0);
  let mixedHistogram = new Map();
  let controlD = 0;
  let expectedD = 0;
  for (const environmentError of grid) {
    const races = districts.map((district, index) => {
      const base = seatBaselines[index];
      let pD;
      if (!base) pD = district.party === "D" ? 0.97 : district.party === "R" ? 0.03 : 0.5;
      else {
        const margin = base.margin + params.swingElasticity * environmentError;
        pD = studentTCdf(margin / params.districtSigma, df);
        if (district.rating) pD = inverseLogit((1 - params.ratingWeight) * logit(pD) + params.ratingWeight * logit(priorFromRating(district.rating)));
      }
      perSeatAccumulator[index] += pD / K;
      return { pD, pR: 1 - pD, pI: 0 };
    });
    const dist = seatDistribution(races, { democraticCaucusNotUp: notUp.D, republicanNotUp: notUp.R });
    for (const { d, probability } of dist.histogram) mixedHistogram.set(d, (mixedHistogram.get(d) || 0) + probability / K);
    controlD += dist.histogram.filter((h) => h.d >= majority).reduce((s, h) => s + h.probability, 0) / K;
    expectedD += dist.expected.D / K;
  }
  const histogram = [...mixedHistogram.entries()].map(([d, probability]) => ({ d, probability })).sort((a, b) => a.d - b.d);
  const seats = districts.map((district, index) => ({
    district: district.district,
    pD: Math.round(perSeatAccumulator[index] * 1000) / 1000,
    baseline: seatBaselines[index],
    ratingUsed: district.rating || null,
  }));
  const totalSeats = notUp.D + notUp.R + districts.length;
  return {
    environment,
    params,
    seats,
    histogram,
    control: { D: Math.round(controlD * 1000) / 1000, R: Math.round((1 - controlD) * 1000) / 1000 },
    expected: { D: Math.round(expectedD * 10) / 10, R: Math.round((totalSeats - expectedD) * 10) / 10 },
    majority, totalSeats, notUp,
  };
}

function round1(value) { return Math.round(value * 10) / 10; }
