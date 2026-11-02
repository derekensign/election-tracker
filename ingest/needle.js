// Election-night needle: a live projection of each Texas statewide race from partial county returns.
//
// The question the needle answers is "given the votes counted so far, how likely is each candidate to finish
// ahead?" It is a Bayesian model with a closed-form solution, so the browser and the recorder (ingest/needle-record.js)
// get identical numbers from identical inputs.
//
// The model, for one race. Each county k has two vote "cells": early votes (in person and by mail) and Election Day
// votes. The final D-minus-R margin of cell t in county k, in points, is
//
//   θ[k,t] = prior[k] + statewide + region[g(k)] + electionDay × c[k,t] + county[k] + cell[k,t]
//
//   prior[k]      the county's usual lean (a blend of 2022 governor, 2024 president, and 2018 Senate results,
//                 relative to the state), shifted so the statewide total equals the final polling average plus part
//                 of the early-vote turnout mix: 2026 early ballots came from bluer or redder counties than the 2022
//                 electorate did, and polls catch only some of that (see earlyVoteMix).
//   statewide     how far the whole state lands from the polls. Student-t (5 degrees of freedom, as in the polls
//                 model) with the polls model's spread, so with zero returns the needle is the polls model moved
//                 by the early-vote turnout mix.
//   region        five shared regional swings (big cities, Valley and border, suburbs, midsize, rural). These are
//                 what let Hidalgo's count say something about Cameron and Starr before they report.
//   realignment   how much of each county's 2022-to-2024 shift relative to the state reverses (+) or deepens (−).
//                 Counties that moved most toward Trump in 2024 (Starr, Webb, Hidalgo, El Paso) load most heavily,
//                 so a reversal read in Hidalgo carries to El Paso and Bexar. Centered so it never moves the state.
//   electionDay   how much more Democratic (+) or Republican (−) Election Day votes run than early votes. Unknown
//                 going in (prior 0 ± 6), learned once counties report both. c[k,t] is −(ED share) for the early
//                 cell and 1 − (ED share) for the Election Day cell, so the offset never moves a county's total.
//   county, cell  independent county and cell deviations (smaller counties swing more).
//
// The counted margin of a partly counted cell is a noisy read of θ[k,t]: the first precincts or the mail ballots
// need not look like the rest. Its noise variance is batchSd² × (1 − f) / f for counted share f, so a cell that is
// fully counted pins θ exactly and a cell with a handful of precincts says little.
//
// Expected votes. Early votes per county are known from the Secretary of State's turnout report. Election Day
// votes are a ratio of early votes (prior 0.35), learned by region from counties as they finish. The remaining
// Election Day turnout is uncertain and that uncertainty is added to the projection.
//
// The projected final net vote is Σ T[k,t] × θ[k,t]. Everything is Gaussian given the Student-t scale, so the
// posterior of the 8 shared effects is an 8×8 solve per scale node, each county's own deviations integrate out in
// closed form, and the win chance is a weighted sum of normal CDFs over the scale nodes.
import { COUNTY_GROUPS, RURAL_GROUP, countyGroup, countyKey } from "./early-vote.js";

/** The SOS election-night reporting system's ID and timing for the November 3, 2026 general election. */
export const NEEDLE_ELECTION = {
  enrId: 53815,
  name: "2026 NOVEMBER GENERAL ELECTION",
  // 7 p.m. Central Standard Time on November 3; El Paso and Hudspeth close an hour later (Mountain time).
  pollsClose: "2026-11-04T01:00:00Z",
  lastPollsClose: "2026-11-04T02:00:00Z",
  resultsUrl: "https://goelect.txelections.civixapps.com/ivis-enr-ui/races",
  countyFileUrl: "https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr/election/countyInfo/53815",
};

/** Tracked races and their office IDs in the SOS feed. Office names are a fallback if an ID ever changes. */
export const NEEDLE_RACES = [
  { id: "tx-senate", officeId: 5075, officeName: "U. S. SENATOR" },
  { id: "tx-governor", officeId: 3579, officeName: "GOVERNOR" },
  { id: "tx-ltgov", officeId: 4714, officeName: "LIEUTENANT GOVERNOR" },
  { id: "tx-ag", officeId: 3, officeName: "ATTORNEY GENERAL" },
  { id: "tx-comptroller", officeId: 21, officeName: "COMPTROLLER OF PUBLIC ACCOUNTS" },
  { id: "tx-railroad", officeId: 4843, officeName: "RAILROAD COMMISSIONER" },
  { id: "tx-land", officeId: 20, officeName: "COMMISSIONER OF THE GENERAL LAND OFFICE" },
  { id: "tx-agriculture", officeId: 19, officeName: "COMMISSIONER OF AGRICULTURE" },
];

export const NEEDLE_REGIONS = [...Object.keys(COUNTY_GROUPS), RURAL_GROUP];

export const NEEDLE_MODEL = {
  // County lean: weights on each past race's margin relative to the state. 2022 is the last midterm, 2024 carries
  // the latest realignment (the South Texas shift), 2018 the last high-turnout midterm with a close Senate race.
  leanWeights: { 2022: 0.45, 2024: 0.35, 2018: 0.2 },
  // Shared regional swing sd, points: how far a region's swing strays from the statewide swing. From 2018 to 2022
  // the big-city and suburban counties strayed 1–5 points from the state; Hidalgo and Cameron strayed 8–12.
  regionSd: { "Big cities": 3.5, "Rio Grande Valley and border": 8, "Suburbs": 3.5, "Midsize cities": 3.5, [RURAL_GROUP]: 3 },
  // County deviation sd = base + scale / sqrt(expected votes / referenceVotes), capped: small counties swing more.
  countySd: { base: 3, scale: 4, referenceVotes: 20000, max: 15 },
  // County deviations are Student-t with this many degrees of freedom, fit by reweighting in a few passes.
  robustDf: 4,
  robustPasses: 2,
  cellSd: 3,
  // Vote-count noise: a margin read from n votes carries about 100² × design effect / n points² of sampling noise
  // (precincts cluster, hence a design effect of 2). It widens small cells and small partial counts, so 40 votes
  // in Castro County cannot move a statewide estimate.
  samplingDesignEffect: 2,
  // Early-vote turnout mix: how much bluer (+) or redder the 2026 expected electorate's geography is than 2022's,
  // with every county at its usual lean. Likely-voter polls catch part of a turnout shift, so the starting point
  // adds `weight` of it to the polling average rather than all of it.
  earlyVoteMix: { baseline: "2022", weight: 0.5 },
  // Share of the 2022-to-2024 relative shift that reverses: 0.25 sd puts one sd at about 5 points in Hidalgo.
  // Exposure is capped so the most extreme small counties (Starr, Zavala) cannot dominate the factor.
  realignmentSd: 0.25,
  realignmentCap: 20,
  electionDayOffset: { mean: 0, sd: 8 },
  batchSd: 6,
  // Error the structure above cannot see (county types beyond the five regions, which counties count first),
  // applied to the uncounted vote: ±3 points with nothing counted, shrinking to zero as the count finishes.
  unmodeledSd: 3,
  // Election Day ballots as a ratio of early ballots. 2026 early turnout already passed 95% of the 2022 total.
  // logSd is the statewide ratio's uncertainty, regionLogSd each region's own on top of it (the turnout mix between
  // red and blue regions is partisan), countyLogSd each county's. All shrink as counties finish counting.
  electionDayRatio: { prior: 0.35, priorWeight: 300000, regionWeight: 200000, logSd: 0.25, regionLogSd: 0.2, countyLogSd: 0.15 },
  // Votes in the top race per early ballot (the rest are undervotes); down-ballot races start a little lower.
  rollOff: 0.985,
  downBallotRollOff: 0.975,
  studentDf: 5,
  mixtureNodes: 40,
};

// ---- Inputs --------------------------------------------------------------------------------------------------

/**
 * @typedef {{ key: string, name: string, region: string, early: number, registered: number, lean: number,
 *   past: Record<string, number|null> }} NeedleCounty
 */

/**
 * Per-county inputs from the morning snapshot's early-vote section: early ballots cast, region, and lean.
 * @param {Array<{ name: string, registered: number, ballots: number, past: Record<string, { margin: number }|null> }>} earlyVoteCounties
 * @param {Record<string, { margin: number }>} statewidePast snapshot.earlyVote.elections (statewide margins)
 * @returns {NeedleCounty[]}
 */
export function needleCounties(earlyVoteCounties, statewidePast, params = NEEDLE_MODEL) {
  return earlyVoteCounties.map((county) => {
    let weightedLean = 0, weightTotal = 0;
    for (const [year, weight] of Object.entries(params.leanWeights)) {
      const margin = county.past?.[year]?.margin, statewideMargin = statewidePast?.[year]?.margin;
      if (margin == null || statewideMargin == null) continue;
      weightedLean += weight * (margin - statewideMargin);
      weightTotal += weight;
    }
    // 2022-to-2024 shift relative to the state's (negative = moved toward Republicans faster than Texas did).
    const shift2024 = county.past?.["2024"]?.margin, shift2022 = county.past?.["2022"]?.margin;
    const relativeShift = shift2024 != null && shift2022 != null && statewidePast?.["2024"] && statewidePast?.["2022"]
      ? (shift2024 - shift2022) - (statewidePast["2024"].margin - statewidePast["2022"].margin) : 0;
    return {
      key: countyKey(county.name), name: county.name, region: countyGroup(county.name),
      early: county.ballots || 0, registered: county.registered || 0,
      lean: weightTotal ? round(weightedLean / weightTotal, 2) : 0,
      relativeShift: round(relativeShift, 2),
      past: Object.fromEntries(["2018", "2022", "2024"].map((year) => [year, county.past?.[year]?.margin ?? null])),
      pastTotal: Object.fromEntries(["2018", "2022", "2024"].map((year) => [year, county.past?.[year]?.total ?? null])),
    };
  });
}

/**
 * Each race's pre-election prior from the morning snapshot: polling-average margin and the polls-model win chance.
 * @param {Array<object>} texasRaces snapshot.texas.races
 */
export function needlePriors(texasRaces) {
  return NEEDLE_RACES.map((spec) => {
    const race = texasRaces.find((r) => r.id === spec.id);
    if (!race) return null;
    return {
      id: spec.id, office: race.office, democrat: race.democrat, republican: race.republican,
      prior: { margin: race.pollingAverage?.margin ?? race.pollModel?.margin ?? 0, pD: race.pollModel?.pD ?? race.pD ?? 0.5, sigma: race.pollModel?.sigma ?? 5.5 },
    };
  }).filter(Boolean);
}

// ---- The SOS county results file ---------------------------------------------------------------------------

/**
 * @typedef {{ name: string, dayReporting: number|null, ballots: number,
 *   races: Record<string, [number, number, number, number, number, number]> }} CountyReturn
 * Race arrays are [early votes, early D, early R, total votes, total D, total R]; votes include third parties.
 */

/**
 * Parse the decoded SOS county file (`/s3/enr/election/countyInfo/<id>`, after base64-decoding `upload`) into
 * compact per-county returns for the tracked races.
 * @param {Record<string, any>} countyInfo
 * @returns {Record<string, CountyReturn>} keyed by countyKey(name)
 */
export function parseCountyReturns(countyInfo, races = NEEDLE_RACES) {
  const returns = {};
  for (const county of Object.values(countyInfo || {})) {
    if (!county?.N || !county.Races) continue;
    const summary = county.Summary || {};
    // Election Day progress: polling places reported, or precincts where a county reports by precinct.
    const dayReporting = summary.NPL > 0 ? clamp(summary.PLR / summary.NPL, 0, 1) : summary.PRP > 0 ? clamp(summary.PRR / summary.PRP, 0, 1) : null;
    const entry = { name: titleCase(county.N), dayReporting, ballots: Number(summary.VC) || 0, races: {} };
    for (const spec of races) {
      const race = county.Races[spec.officeId] || Object.values(county.Races).find((r) => normalizeOffice(r.N) === normalizeOffice(spec.officeName));
      if (!race?.C) continue;
      let earlyVotes = 0, earlyD = 0, earlyR = 0, totalVotes = 0, totalD = 0, totalR = 0;
      for (const candidate of Object.values(race.C)) {
        const votes = Number(candidate.V) || 0, early = Number(candidate.EV) || 0;
        totalVotes += votes; earlyVotes += early;
        const party = String(candidate.P || "").toUpperCase();
        if (party === "DEM" || party === "D") { totalD += votes; earlyD += early; }
        if (party === "REP" || party === "R") { totalR += votes; earlyR += early; }
      }
      entry.races[spec.id] = [earlyVotes, earlyD, earlyR, totalVotes, totalD, totalR];
    }
    returns[countyKey(county.N)] = entry;
  }
  return returns;
}

function normalizeOffice(name) { return String(name || "").toUpperCase().replace(/[^A-Z]/g, ""); }
function titleCase(name) { return String(name).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bMc([a-z])/g, (_, c) => `Mc${c.toUpperCase()}`); }

// ---- Expected votes ------------------------------------------------------------------------------------------

/**
 * Election Day turnout as a ratio of early ballots, learned from counties that have substantially reported, pooled
 * to the state and then to each region. Uses the top race's votes as the ballot count.
 * @returns {{ statewide: number, byRegion: Record<string, number>, logSd: number, observedWeight: number }}
 */
export function electionDayRatios(counties, returns, params = NEEDLE_MODEL, referenceRaceId = NEEDLE_RACES[0].id) {
  const { prior, priorWeight, regionWeight, logSd } = params.electionDayRatio;
  const observations = [];
  for (const county of counties) {
    const result = returns?.[county.key];
    const race = result?.races?.[referenceRaceId];
    const reporting = result?.dayReporting ?? 0;
    if (!race || reporting < 0.5 || county.early <= 0) continue;
    const earlyBallots = Math.max(county.early, race[0] / params.rollOff);
    const dayBallots = (race[3] - race[0]) / params.rollOff / reporting;
    observations.push({ region: county.region, ratio: dayBallots / earlyBallots, weight: earlyBallots * reporting });
  }
  const pooled = (weight0, mean0, items) => (weight0 * mean0 + items.reduce((t, o) => t + o.weight * o.ratio, 0)) / (weight0 + items.reduce((t, o) => t + o.weight, 0));
  const statewide = pooled(priorWeight, prior, observations);
  const byRegion = Object.fromEntries(NEEDLE_REGIONS.map((region) => [region, pooled(regionWeight, statewide, observations.filter((o) => o.region === region))]));
  const observedWeight = observations.reduce((t, o) => t + o.weight, 0);
  const regionLogSd = Object.fromEntries(NEEDLE_REGIONS.map((region) => {
    const weight = observations.filter((o) => o.region === region).reduce((t, o) => t + o.weight, 0);
    return [region, params.electionDayRatio.regionLogSd * Math.sqrt(regionWeight / (regionWeight + weight))];
  }));
  return { statewide, byRegion, logSd: logSd * Math.sqrt(priorWeight / (priorWeight + observedWeight)), regionLogSd, observedWeight };
}

// ---- One race ------------------------------------------------------------------------------------------------

/**
 * Expected, counted, and remaining votes for each county's early and Election Day cells in one race.
 * `share` is the counted fraction of the cell's expected votes; `reporting` is the county's Election Day progress
 * (polling places reported), which also sets how much of the Election Day estimate comes from the count so far.
 */
function buildCells(counties, returns, race, ratios, params) {
  const isTopRace = race.id === NEEDLE_RACES[0].id || race.id === NEEDLE_RACES[1].id;
  // Votes in this race per top-race vote, from counties that have counted early votes (undervote differences).
  let raceEarly = 0, topEarly = 0;
  for (const county of counties) {
    const result = returns?.[county.key];
    const own = result?.races?.[race.id], top = result?.races?.[NEEDLE_RACES[0].id];
    if (own && top && top[0] > 0) { raceEarly += own[0]; topEarly += top[0]; }
  }
  const relativeRollOff = topEarly > 50000 ? raceEarly / topEarly : isTopRace ? 1 : params.downBallotRollOff / params.rollOff;

  return counties.map((county) => {
    const result = returns?.[county.key];
    const own = result?.races?.[race.id] || [0, 0, 0, 0, 0, 0];
    // Early ballots counted so far: the most early votes in any tracked race (the top race, normally).
    const topBallots = Math.max(...Object.values(result?.races || {}).map((r) => r[0]), 0);
    const earlyBallots = Math.max(county.early, topBallots / params.rollOff);
    let earlyCounted = earlyBallots > 0 ? clamp(topBallots / (params.rollOff * earlyBallots), 0, 1) : 0;
    // Counties post early votes in one batch (or mail first, a few percent). Within 5% of the turnout report is
    // the whole batch with a different undervote rate, and a county done with Election Day is done with early votes.
    if (earlyCounted >= 0.95 || (result?.dayReporting ?? 0) >= 1) earlyCounted = topBallots > 0 ? 1 : earlyCounted;
    const earlyVotes = own[0], earlyNet = own[1] - own[2];
    const expectedEarly = Math.max(earlyVotes, earlyCounted > 0.02 && earlyVotes > 0 ? earlyVotes / earlyCounted : relativeRollOff * params.rollOff * earlyBallots);

    const dayVotes = Math.max(0, own[3] - own[0]), dayNet = (own[4] - own[1]) - (own[5] - own[2]);
    const priorDay = relativeRollOff * params.rollOff * (ratios.byRegion[county.region] ?? ratios.statewide) * earlyBallots;
    let reporting = result?.dayReporting ?? 0;
    // A county that posts Election Day votes without updating its polling-place count: estimate its progress.
    if (reporting === 0 && dayVotes > 0) reporting = clamp(dayVotes / Math.max(priorDay, 1), 0.02, 0.9);
    // Remaining = (1 − reporting) × a blend of the count-based total (votes / reporting) and the prior total,
    // trusting the count more as more polling places report.
    const expectedDay = reporting >= 1 ? dayVotes : dayVotes + (1 - reporting) * (dayVotes + (1 - reporting) * priorDay);
    return {
      county,
      early: { expected: expectedEarly, votes: earlyVotes, net: earlyNet, share: expectedEarly > 0 ? clamp(earlyVotes / expectedEarly, 0, 1) : 0 },
      day: { expected: expectedDay, votes: dayVotes, net: dayNet, share: expectedDay > 0 ? clamp(dayVotes / expectedDay, 0, 1) : 0, reporting, remaining: Math.max(0, expectedDay - dayVotes) },
    };
  });
}

/**
 * Run the needle for one race.
 * @param {{ counties: NeedleCounty[], returns: Record<string, CountyReturn>|null, race: { id: string, prior: { margin: number, pD: number, sigma: number } },
 *   dayRatios?: ReturnType<typeof electionDayRatios>, params?: typeof NEEDLE_MODEL }} input
 */
export function runNeedleRace({ counties, returns, race, dayRatios = null, params = NEEDLE_MODEL }) {
  const ratios = dayRatios || electionDayRatios(counties, returns, params);
  const cells = buildCells(counties, returns, race, ratios, params);
  // The pre-election picture (no returns, prior turnout) fixes the county priors and the statewide error scale,
  // so neither drifts during the night. If more votes than expected come from blue or red places, that moves the
  // projection through the vote weights rather than being absorbed by the priors.
  const priorCells = buildCells(counties, null, race, electionDayRatios(counties, null, params), params);

  const totalExpected = sumBy(cells, (c) => c.early.expected + c.day.expected);
  const totalCounted = sumBy(cells, (c) => c.early.votes + c.day.votes);
  const countedNet = sumBy(cells, (c) => c.early.net + c.day.net);

  // County priors: lean + a constant that makes the turnout-weighted statewide prior equal the polling average
  // plus part of the early-vote turnout mix (how much bluer the 2026 electorate's geography is than 2022's).
  const priorExpected = sumBy(priorCells, (c) => c.early.expected + c.day.expected);
  const weightedLean = sumBy(priorCells, (c) => (c.early.expected + c.day.expected) * c.county.lean) / Math.max(priorExpected, 1);
  const mix = earlyVoteMix(priorCells, priorExpected, params);
  const startingMargin = race.prior.margin + mix.added;
  const shift = startingMargin - weightedLean;

  const regionIndex = Object.fromEntries(NEEDLE_REGIONS.map((region, index) => [region, index]));
  const dimension = 3 + NEEDLE_REGIONS.length; // statewide, regions..., electionDay, realignment
  const dayIndex = 1 + NEEDLE_REGIONS.length, realignIndex = dayIndex + 1;
  // Realignment exposure, centered on the expected 2026 vote so the factor moves votes between places, not the state.
  const meanShift = sumBy(priorCells, (c) => (c.early.expected + c.day.expected) * (c.county.relativeShift || 0)) / Math.max(priorExpected, 1);
  const exposure = (county) => -clamp((county.relativeShift || 0) - meanShift, -params.realignmentCap, params.realignmentCap);
  const { cellSd, batchSd } = params;
  const sampling = 1e4 * params.samplingDesignEffect;
  const cellVarianceFor = (expectedVotes) => cellSd ** 2 + sampling / Math.max(expectedVotes, 1);

  // Shared-effect prior; the statewide variance is scaled per Student-t node and calibrated to the polls model.
  const regionVariance = NEEDLE_REGIONS.map((region) => (params.regionSd[region] ?? 2.5) ** 2);
  const priorMean = new Array(dimension).fill(0);
  priorMean[dayIndex] = params.electionDayOffset.mean;
  const priorVariance = [1, ...regionVariance, params.electionDayOffset.sd ** 2, params.realignmentSd ** 2];
  const nodes = studentMixtureNodes(params.studentDf, params.mixtureNodes);
  const statewideSd = calibrateStatewideSd({
    race, nodes, totalExpected: priorExpected, beta: zeroDataBeta(priorCells, regionIndex, dimension), regionVariance,
    localVarianceZero: zeroDataLocalVariance(priorCells, params), turnoutVariance: zeroDataTurnoutVariance(priorCells, shift, params) + (params.unmodeledSd * priorExpected) ** 2,
  });
  const countyPriorOf = (county) => clamp(county.lean + shift, -98, 98);

  // Remaining Election Day turnout uncertainty, using each county's prior margin for the uncounted votes (the
  // posterior margin is close enough for a second-order term): statewide, regional, and county ratio errors.
  let turnoutShared = 0, turnoutCountyVariance = 0;
  const turnoutByRegion = Object.fromEntries(NEEDLE_REGIONS.map((region) => [region, 0]));
  for (const cell of cells) {
    const remainingNet = cell.day.remaining * countyPriorOf(cell.county);
    turnoutShared += remainingNet;
    turnoutByRegion[cell.county.region] += remainingNet;
    turnoutCountyVariance += (remainingNet * params.electionDayRatio.countyLogSd) ** 2;
  }
  const turnoutVariance = (turnoutShared * ratios.logSd) ** 2 + turnoutCountyVariance
    + NEEDLE_REGIONS.reduce((t, region) => t + (turnoutByRegion[region] * (ratios.regionLogSd?.[region] ?? 0)) ** 2, 0);
  const uncounted = sumBy(cells, (c) => Math.max(0, c.early.expected - c.early.votes) + Math.max(0, c.day.expected - c.day.votes));
  const unmodeledVariance = (params.unmodeledSd * uncounted) ** 2;
  const hasData = totalCounted > 0;

  /**
   * One solve of the model. `countyScale` inflates individual counties' deviation variances (robust reweighting).
   */
  const solve = (countyScale) => {
    const information = zeros(dimension, dimension); // Σ Hᵀ C⁻¹ H
    const score = new Array(dimension).fill(0);       // Σ Hᵀ C⁻¹ (y − prior)
    const beta = new Array(dimension).fill(0);        // net-vote loading on the shared effects
    let alpha = 0, localVariance = 0;
    const countyStates = [];
    for (const cell of cells) {
      const { county } = cell;
      const expectedTotal = cell.early.expected + cell.day.expected;
      const countyPrior = countyPriorOf(county);
      const daySharePlanned = expectedTotal > 0 ? cell.day.expected / expectedTotal : 0;
      const countySd = Math.min(params.countySd.max, params.countySd.base + params.countySd.scale / Math.sqrt(Math.max(expectedTotal, 1) / params.countySd.referenceVotes));
      const countyVariance = countySd ** 2 * (countyScale?.get(county.key) ?? 1);
      const loading = (type) => { // h: statewide, region one-hot, electionDay coefficient, realignment exposure
        const h = new Array(dimension).fill(0);
        h[0] = 1; h[1 + regionIndex[county.region]] = 1; h[dayIndex] = type === "early" ? -daySharePlanned : 1 - daySharePlanned;
        h[realignIndex] = exposure(county);
        return h;
      };
      const types = ["early", "day"];
      const expected = { early: cell.early.expected, day: cell.day.expected };
      const cellVariance = { early: cellVarianceFor(expected.early), day: cellVarianceFor(expected.day) };
      // Observed cells: counted margin y (points) with batch-order and vote-count noise.
      const observed = types.filter((type) => cell[type].votes > 0).map((type) => {
        const share = Math.min(cell[type].share, 1), uncountedShare = 1 - share;
        const noise = (batchSd ** 2) * uncountedShare / Math.max(share, 0.02) + (sampling * uncountedShare) / cell[type].votes + 0.01;
        return { type, y: (100 * cell[type].net) / cell[type].votes, noise, h: loading(type) };
      });
      // q: net-vote loading on [county, early cell, day cell].
      const q = [expectedTotal, expected.early, expected.day];
      const localPrior = [countyVariance, cellVariance.early, cellVariance.day];
      const rowOf = (type) => [1, type === "early" ? 1 : 0, type === "day" ? 1 : 0];
      for (const type of types) {
        alpha += expected[type] * countyPrior;
        const h = loading(type);
        for (let i = 0; i < dimension; i += 1) beta[i] += expected[type] * h[i];
      }
      let cInverse = null, residualPrior = [], localPart = 0;
      const countyScore = new Array(dimension).fill(0);
      if (observed.length) {
        // C = M D Mᵀ + diag(noise); with M rows [1, early?, day?], C[i][j] = countyVar + [i=j](cellVar_i + noise_i).
        const size = observed.length;
        const c = zeros(size, size);
        for (let i = 0; i < size; i += 1) for (let j = 0; j < size; j += 1) c[i][j] = countyVariance + (i === j ? cellVariance[observed[i].type] + observed[i].noise : 0);
        cInverse = invertSmall(c);
        const mdq = observed.map((o) => rowOf(o.type).reduce((t, m, index) => t + m * localPrior[index] * q[index], 0)); // M D q
        const kappa = cInverse.map((row) => row.reduce((t, value, j) => t + value * mdq[j], 0));
        const qdq = q.reduce((t, value, index) => t + value * value * localPrior[index], 0);
        localVariance += qdq - mdq.reduce((t, value, i) => t + value * kappa[i], 0);
        residualPrior = observed.map((o) => o.y - countyPrior);
        for (let i = 0; i < size; i += 1) {
          alpha += kappa[i] * residualPrior[i];
          localPart += kappa[i] * residualPrior[i];
          for (let d = 0; d < dimension; d += 1) beta[d] -= observed[i].h[d] * kappa[i];
        }
        for (let i = 0; i < size; i += 1) {
          for (let j = 0; j < size; j += 1) {
            const weight = cInverse[i][j];
            for (let a = 0; a < dimension; a += 1) {
              countyScore[a] += observed[i].h[a] * weight * residualPrior[j];
              score[a] += observed[i].h[a] * weight * residualPrior[j];
              for (let b = 0; b < dimension; b += 1) information[a][b] += observed[i].h[a] * weight * observed[j].h[b];
            }
          }
        }
      } else {
        localVariance += q.reduce((t, value, index) => t + value * value * localPrior[index], 0);
      }
      countyStates.push({ cell, countyPrior, observed, cInverse, residualPrior, localPrior, loading, countyScore, localPart, countyVariance });
    }

    // Posterior for each scale node: Λ = P0⁻¹ + J, mean = Λ⁻¹ (P0⁻¹ μ0 + score), and the marginal likelihood weight.
    const u = score.map((value, a) => value - information[a].reduce((t, x, b) => t + x * priorMean[b], 0)); // Hᵀ C⁻¹ (y − prior − H μ0)
    const nodeResults = nodes.map((node) => {
      const variance = priorVariance.slice();
      variance[0] = statewideSd ** 2 * node.varianceScale;
      const precision = information.map((row, a) => row.map((value, b) => value + (a === b ? 1 / variance[a] : 0)));
      const chol = cholesky(precision);
      const mean = choleskySolve(chol, priorMean.map((m, a) => m / variance[a] + score[a]));
      const covBeta = choleskySolve(chol, beta);
      const netMean = alpha + dot(beta, mean);
      const netVariance = Math.max(dot(beta, covBeta) + localVariance + turnoutVariance + unmodeledVariance, 1e-6);
      const logLikelihood = hasData ? 0.5 * dot(u, choleskySolve(chol, u)) - 0.5 * (sumBy(variance, Math.log) + logDetFromCholesky(chol)) : 0;
      return { weight: node.weight, mean, covBeta, netMean, netSd: Math.sqrt(netVariance), logLikelihood };
    });
    const maxLog = Math.max(...nodeResults.map((n) => n.logLikelihood));
    let weightTotal = 0;
    for (const n of nodeResults) { n.posterior = n.weight * Math.exp(n.logLikelihood - maxLog); weightTotal += n.posterior; }
    for (const n of nodeResults) n.posterior /= weightTotal;
    const sharedMean = new Array(dimension).fill(0);
    for (const n of nodeResults) for (let a = 0; a < dimension; a += 1) sharedMean[a] += n.posterior * n.mean[a];
    // Each county's influence on the projected net vote: its own votes' direct effect plus what they taught the
    // shared effects (mixture-averaged Λ⁻¹β · its score). These sum, with a data-free constant, to the projection.
    const leverage = new Array(dimension).fill(0);
    for (const n of nodeResults) for (let a = 0; a < dimension; a += 1) leverage[a] += n.posterior * n.covBeta[a];

    // Per-county posterior means (the scale nodes only move the shared means, so the mixture-averaged mean is exact).
    const countyResults = countyStates.map((state) => {
      const { cell, countyPrior, observed, cInverse, residualPrior, localPrior, loading, countyScore, localPart, countyVariance } = state;
      let localMean = [0, 0, 0];
      if (observed.length) {
        const residual = observed.map((o, i) => residualPrior[i] - dot(o.h, sharedMean));
        const solved = cInverse.map((row) => dot(row, residual));
        // E[l | y] = D Mᵀ C⁻¹ (y − prior − H μ)
        localMean = [0, 1, 2].map((index) => observed.reduce((t, o, i) => t + [1, o.type === "early" ? 1 : 0, o.type === "day" ? 1 : 0][index] * localPrior[index] * solved[i], 0));
      }
      const theta = (type) => countyPrior + dot(loading(type), sharedMean) + localMean[0] + (type === "early" ? localMean[1] : localMean[2]);
      const projectedNet = (cell.early.expected * theta("early") + cell.day.expected * theta("day")) / 100;
      const remainingMargin = (type) => {
        const remaining = cell[type].expected - cell[type].votes;
        return remaining > 0.5 ? round((cell[type].expected * theta(type) - 100 * cell[type].net) / remaining, 2) : null;
      };
      const counted = cell.early.votes + cell.day.votes;
      const expectedTotal = cell.early.expected + cell.day.expected;
      return {
        key: cell.county.key, name: cell.county.name, region: cell.county.region,
        expectedVotes: Math.round(expectedTotal), countedVotes: counted, countedNet: cell.early.net + cell.day.net,
        countedMargin: counted ? round((100 * (cell.early.net + cell.day.net)) / counted, 2) : null,
        earlyShare: round(cell.early.share, 3), dayShare: round(cell.day.share, 3), dayReporting: round(cell.day.reporting, 3),
        earlyVotes: cell.early.votes, earlyNet: cell.early.net, earlyMargin: cell.early.votes ? round((100 * cell.early.net) / cell.early.votes, 2) : null,
        dayVotes: cell.day.votes, dayNet: cell.day.net, dayMargin: cell.day.votes ? round((100 * cell.day.net) / cell.day.votes, 2) : null,
        priorMargin: round(countyPrior, 2), projectedMargin: expectedTotal ? round((100 * projectedNet) / expectedTotal, 2) : null,
        remainingMargin: { early: remainingMargin("early"), day: remainingMargin("day") },
        influence: Math.round((localPart + dot(leverage, countyScore)) / 100),
        // For the robust reweighting: this county's own deviation and its prior variance.
        deviation: localMean[0], deviationVariance: countyVariance,
      };
    });
    return { nodeResults, sharedMean, information, countyResults };
  };

  // Robust county deviations: Student-t (robustDf) by iterative reweighting. A county far from what the model
  // expected gets a wider deviation, so it reads as an unusual county rather than as the whole state moving.
  let solved = solve(null);
  for (let pass = 0; hasData && pass < params.robustPasses; pass += 1) {
    const scale = new Map();
    for (const county of solved.countyResults) {
      if (!county.countedVotes) continue;
      const standardized = county.deviation ** 2 / county.deviationVariance;
      scale.set(county.key, Math.max(1, (params.robustDf + standardized) / (params.robustDf + 1)));
    }
    solved = solve(scale);
  }
  const { nodeResults, sharedMean, information } = solved;
  const countyResults = solved.countyResults.map(({ deviation, deviationVariance, ...county }) => county);

  const pD = sumBy(nodeResults, (n) => n.posterior * normalCdf(n.netMean / n.netSd));
  const netMean = sumBy(nodeResults, (n) => n.posterior * n.netMean);
  const mixtureCdf = (net) => sumBy(nodeResults, (n) => n.posterior * normalCdf((net - n.netMean) / n.netSd));
  const quantile = (p) => bisect((net) => mixtureCdf(net) - p, netMean - 50 * totalExpected, netMean + 50 * totalExpected);

  const toMargin = (net) => net / Math.max(totalExpected, 1); // net is in vote × points, so this is the margin in points
  const sharedSd = (index) => Math.sqrt(Math.max(0, sumBy(nodeResults, (n) => n.posterior * (n.mean[index] - sharedMean[index]) ** 2) + posteriorVarianceOf(index, information, priorVariance, statewideSd, nodeResults, nodes)));
  return {
    id: race.id,
    pD: round(pD, 4),
    margin: round(toMargin(netMean), 2),
    interval80: [round(toMargin(quantile(0.1)), 2), round(toMargin(quantile(0.9)), 2)],
    expectedVotes: Math.round(totalExpected),
    countedVotes: totalCounted,
    countedShare: round(totalCounted / Math.max(totalExpected, 1), 4),
    countedMargin: totalCounted ? round((100 * countedNet) / totalCounted, 2) : null,
    countedNet,
    statewideSd: round(statewideSd, 2),
    shared: {
      statewide: { mean: round(sharedMean[0], 2), sd: round(sharedSd(0), 2) },
      regions: Object.fromEntries(NEEDLE_REGIONS.map((region, index) => [region, { mean: round(sharedMean[1 + index], 2), sd: round(sharedSd(1 + index), 2) }])),
      electionDay: { mean: round(sharedMean[dayIndex], 2), sd: round(sharedSd(dayIndex), 2) },
      realignment: { mean: round(sharedMean[realignIndex], 3), sd: round(sharedSd(realignIndex), 3) },
    },
    electionDayRatio: round(ratios.statewide, 3),
    startingPoint: { polls: race.prior.margin, turnoutMix: mix.shift, added: mix.added, margin: round(startingMargin, 2) },
    counties: countyResults,
  };
}

/** Run every tracked race against one set of returns. */
export function runNeedle({ counties, returns, races, params = NEEDLE_MODEL }) {
  const dayRatios = electionDayRatios(counties, returns, params);
  return races.map((race) => ({ ...runNeedleRace({ counties, returns, race, dayRatios, params }), office: race.office, democrat: race.democrat, republican: race.republican, prior: race.prior }));
}

/** Within-node posterior variance of one shared effect, averaged over nodes (for the reported sd). */
function posteriorVarianceOf(index, information, priorVariance, statewideSd, nodeResults, nodes) {
  let total = 0;
  nodes.forEach((node, j) => {
    const variance = priorVariance.slice();
    variance[0] = statewideSd ** 2 * node.varianceScale;
    const precision = information.map((row, a) => row.map((value, b) => value + (a === b ? 1 / variance[a] : 0)));
    const unit = new Array(precision.length).fill(0); unit[index] = 1;
    total += nodeResults[j].posterior * choleskySolve(cholesky(precision), unit)[index];
  });
  return total;
}

// ---- Calibration: with zero returns, match the polls model's win chance --------------------------------------

/**
 * The early-vote turnout mix: with every county at its usual lean, how many points bluer (+) the 2026 expected
 * electorate's geography is than the baseline year's, and the part of it added to the polls.
 */
function earlyVoteMix(priorCells, priorExpected, params) {
  const { baseline, weight } = params.earlyVoteMix || {};
  const baselineTotal = sumBy(priorCells, (c) => c.county.pastTotal?.[baseline] || 0);
  if (!weight || !baselineTotal || !priorExpected) return { shift: 0, added: 0 };
  const shift = sumBy(priorCells, (c) => ((c.early.expected + c.day.expected) / priorExpected - (c.county.pastTotal?.[baseline] || 0) / baselineTotal) * c.county.lean);
  return { shift: round(shift, 2), added: round(weight * shift, 2) };
}

function zeroDataBeta(cells, regionIndex, dimension) {
  const byRegion = new Array(dimension).fill(0);
  for (const cell of cells) {
    const total = cell.early.expected + cell.day.expected;
    byRegion[0] += total;
    byRegion[1 + regionIndex[cell.county.region]] += total;
  }
  return byRegion;
}
function zeroDataTurnoutVariance(cells, shift, params) {
  let shared = 0, county = 0;
  const byRegion = {};
  for (const cell of cells) {
    const remainingNet = cell.day.expected * clamp(cell.county.lean + shift, -98, 98);
    shared += remainingNet;
    byRegion[cell.county.region] = (byRegion[cell.county.region] || 0) + remainingNet;
    county += (remainingNet * params.electionDayRatio.countyLogSd) ** 2;
  }
  const regional = Object.values(byRegion).reduce((t, net) => t + (net * params.electionDayRatio.regionLogSd) ** 2, 0);
  return (shared * params.electionDayRatio.logSd) ** 2 + regional + county;
}
function zeroDataLocalVariance(cells, params) {
  return sumBy(cells, (cell) => {
    const total = cell.early.expected + cell.day.expected;
    const countySd = Math.min(params.countySd.max, params.countySd.base + params.countySd.scale / Math.sqrt(Math.max(total, 1) / params.countySd.referenceVotes));
    const cellVariance = (votes) => params.cellSd ** 2 + (1e4 * params.samplingDesignEffect) / Math.max(votes, 1);
    return total ** 2 * countySd ** 2 + cell.early.expected ** 2 * cellVariance(cell.early.expected) + cell.day.expected ** 2 * cellVariance(cell.day.expected);
  });
}

/**
 * The statewide sd such that, with no returns, the needle's win chance equals the polls model's. Regions,
 * counties, and turnout add their own (normal) variance, so the statewide part is a bit below the polls sigma.
 */
function calibrateStatewideSd({ race, nodes, totalExpected, beta, regionVariance, localVarianceZero, turnoutVariance }) {
  const otherVariance = (sumBy(regionVariance, (v, index) => beta[1 + index] ** 2 * v) + localVarianceZero + turnoutVariance) / Math.max(totalExpected, 1) ** 2;
  const fallback = Math.sqrt(Math.max(1, race.prior.sigma ** 2 - otherVariance));
  const { margin, pD } = race.prior;
  if (pD == null || pD <= 0.005 || pD >= 0.995 || Math.abs(margin) < 0.05 || (margin > 0) !== (pD > 0.5)) return fallback;
  const zeroDataPD = (sd) => sumBy(nodes, (node) => node.weight * normalCdf(margin / Math.sqrt(sd * sd * node.varianceScale + otherVariance)));
  // pD moves toward 0.5 as sd grows; find sd with zeroDataPD(sd) = target.
  const target = pD;
  let low = 0.3, high = 25;
  if ((zeroDataPD(low) - target) * (zeroDataPD(high) - target) > 0) return fallback;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if ((zeroDataPD(mid) - target) * (margin > 0 ? 1 : -1) > 0) low = mid; else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Equal-probability discretization of the Student-t scale mixture: statewide ~ N(0, sd² × s) with 1/s ~
 * Gamma(df/2, rate df/2). Each node carries its bin's mean variance multiplier E[s | bin].
 * @returns {Array<{ weight: number, varianceScale: number }>}
 */
export function studentMixtureNodes(df, count) {
  const key = `${df}:${count}`;
  if (MIXTURE_CACHE.has(key)) return MIXTURE_CACHE.get(key);
  const shape = df / 2, rate = df / 2, gridSize = 8000, lowest = 1e-4, highest = 40;
  const logStep = Math.log(highest / lowest) / gridSize;
  const grid = [];
  let total = 0;
  for (let i = 0; i < gridSize; i += 1) {
    const precision = lowest * Math.exp((i + 0.5) * logStep);
    const mass = Math.exp((shape - 1) * Math.log(precision) - rate * precision) * precision * logStep; // density × d(precision)
    grid.push([precision, mass]);
    total += mass;
  }
  const nodes = [];
  let binMass = 0, binVariance = 0;
  for (const [precision, mass] of grid) {
    binMass += mass; binVariance += mass / precision;
    if (binMass >= total / count && nodes.length < count - 1) { nodes.push({ weight: binMass / total, varianceScale: binVariance / binMass }); binMass = 0; binVariance = 0; }
  }
  if (binMass > 0) nodes.push({ weight: binMass / total, varianceScale: binVariance / binMass });
  MIXTURE_CACHE.set(key, nodes);
  return nodes;
}
const MIXTURE_CACHE = new Map();

// ---- What moved the needle -----------------------------------------------------------------------------------

/**
 * Explain the change between two runs of the same race: which newly counted votes surprised the model most.
 * A batch's surprise is its net vote minus what the earlier run expected from those votes (the earlier run's
 * margin for that county's uncounted votes of the same type).
 * @param {ReturnType<typeof runNeedleRace>} before
 * @param {ReturnType<typeof runNeedleRace>} after
 * @returns {{ subject: string, kind: string, votes: number, margin: number, expectedMargin: number, surprise: number, counties: number,
 *   topCounties: Array<{ name: string, type: string, votes: number, margin: number, expectedMargin: number, surprise: number }> } | null}
 */
export function explainMove(before, after) {
  const previous = new Map(before.counties.map((c) => [c.key, c]));
  const batches = [];
  for (const county of after.counties) {
    const old = previous.get(county.key);
    if (!old) continue;
    for (const type of ["early", "day"]) {
      const votesNow = type === "early" ? county.earlyVotes : county.dayVotes;
      const votesThen = type === "early" ? old.earlyVotes : old.dayVotes;
      const newVotes = votesNow - votesThen;
      if (newVotes <= 0) continue;
      const newNet = (type === "early" ? county.earlyNet - old.earlyNet : county.dayNet - old.dayNet);
      const expectedMargin = old.remainingMargin?.[type] ?? old.projectedMargin ?? old.priorMargin ?? 0;
      batches.push({ key: county.key, name: county.name, region: county.region, type, votes: newVotes, net: newNet, margin: (100 * newNet) / newVotes, expectedMargin, surprise: newNet - (newVotes * expectedMargin) / 100 });
    }
  }
  if (!batches.length) return null;
  const totalVotes = sumBy(batches, (b) => b.votes);
  const totalNet = sumBy(batches, (b) => b.net);
  const totalSurprise = sumBy(batches, (b) => b.surprise);
  const byCounty = groupBy(batches, (b) => b.key);
  const influenceBefore = new Map(before.counties.map((c) => [c.key, c.influence ?? 0]));
  const influenceAfter = new Map(after.counties.map((c) => [c.key, c.influence ?? 0]));
  // Impact: how much the projection's net vote moved on this county's account (its new votes, directly and
  // through what they taught the model about the state, its region, and Election Day).
  const countyTotals = [...byCounty.values()].map((items) => ({
    name: items[0].name, region: items[0].region, type: items.length > 1 ? "both" : items[0].type,
    votes: sumBy(items, (b) => b.votes), net: sumBy(items, (b) => b.net), surprise: sumBy(items, (b) => b.surprise),
    expectedNet: sumBy(items, (b) => (b.votes * b.expectedMargin) / 100),
    impact: (influenceAfter.get(items[0].key) ?? 0) - (influenceBefore.get(items[0].key) ?? 0),
  })).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  const absoluteImpact = sumBy(countyTotals, (c) => Math.abs(c.impact)) || 1;
  const describe = (group) => ({ votes: group.votes, margin: round((100 * group.net) / group.votes, 1), expectedMargin: round((100 * group.expectedNet) / group.votes, 1), surprise: Math.round(group.surprise), impact: Math.round(group.impact) });
  const top = countyTotals[0];
  const result = { counties: countyTotals.length, votes: totalVotes, margin: round((100 * totalNet) / totalVotes, 1), surprise: Math.round(totalSurprise), impact: Math.round(sumBy(countyTotals, (c) => c.impact)), topCounties: countyTotals.slice(0, 5).map((c) => ({ name: c.name, type: c.type, ...describe(c) })) };
  result.expectedMargin = round((100 * (totalNet - totalSurprise)) / totalVotes, 1);
  // One county carries the explanation when it moved the projection most, by a real number of votes.
  if (countyTotals.length === 1 || (Math.abs(top.impact) >= 0.45 * absoluteImpact && Math.abs(top.impact) >= 1000)) {
    return { ...result, subject: top.name, kind: top.type, ...describe(top) };
  }
  const byRegion = [...groupBy(countyTotals, (c) => c.region).entries()].map(([region, items]) => ({ region, items, votes: sumBy(items, (c) => c.votes), net: sumBy(items, (c) => c.net), surprise: sumBy(items, (c) => c.surprise), expectedNet: sumBy(items, (c) => c.expectedNet), impact: sumBy(items, (c) => c.impact) }))
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  if (Math.abs(byRegion[0].impact) >= 0.5 * absoluteImpact) {
    const region = byRegion[0];
    return { ...result, subject: region.region, kind: "region", regionCounties: region.items.length, ...describe(region) };
  }
  return { ...result, subject: `${countyTotals.length} counties`, kind: "many" };
}

// ---- The recorded night: timeline and annotated events -----------------------------------------------------

/**
 * When a move becomes an annotation: the first returns; a jump of `jump` in a single update (explained by that
 * update's votes); a slower drift of `drift` since the last annotation, once `minGapMinutes` have passed
 * (explained by everything counted since); or a change of favorite that clears 50% by `flipMargin`.
 */
export const NEEDLE_EVENT_RULES = { jump: 0.08, drift: 0.2, flipMargin: 0.05, minGapMinutes: 20, narrowingFrom: 0.25 };

/**
 * A fresh needle document from the morning snapshot: frozen model inputs and one pre-results point per race.
 * The recorder and the browser both run the model from these inputs, so a point means the same thing wherever it
 * was computed.
 * @param {object} snapshot public/data/latest.json
 */
export function createNeedleDocument(snapshot, { now = new Date().toISOString(), params = NEEDLE_MODEL } = {}) {
  const counties = needleCounties(snapshot.earlyVote.counties, snapshot.earlyVote.elections, params);
  const races = needlePriors(snapshot.texas.races);
  const runs = runNeedle({ counties, returns: null, races, params });
  const timeline = Object.fromEntries(runs.map((run) => [run.id, [timelinePoint(run, now)]]));
  return { version: 1, election: NEEDLE_ELECTION, inputs: { snapshotAsOf: snapshot.asOf, counties, races }, createdAt: now, updatedAt: now, checkedAt: now, status: null, timeline, events: [], latest: null };
}

/**
 * Fold one fetch of county returns into the document: a new point per race when anything changed, plus an event
 * wherever the needle moved enough to annotate. Mutates and returns `doc`.
 * `memory` carries model runs between calls (the run at each race's last annotation, so an annotation can explain
 * everything counted since); without it, explanations cover only the latest update.
 * @param {ReturnType<typeof createNeedleDocument>} doc
 * @param {{ returns: Record<string, CountyReturn>, fetchedAt: string, status?: object|null }} update
 * @param {{ lastRuns?: object[], eventBase?: Record<string, { run: object, p: number, t: string }> }} [memory]
 */
export function advanceNeedle(doc, { returns, fetchedAt, status = null, params = NEEDLE_MODEL, rules = NEEDLE_EVENT_RULES }, memory = {}) {
  doc.checkedAt = fetchedAt;
  if (status) doc.status = status;
  const signature = returnsSignature(returns);
  if (doc.latest?.signature === signature) return { doc, changed: false, events: [], runs: memory.lastRuns ?? null };
  const { counties, races } = doc.inputs;
  const before = memory.lastRuns ?? runNeedle({ counties, returns: doc.latest?.returns ?? null, races, params });
  const after = runNeedle({ counties, returns, races, params });
  memory.eventBase ||= {};
  const events = [];
  races.forEach((race, index) => {
    const series = (doc.timeline[race.id] ||= []);
    const lastEvent = [...doc.events].reverse().find((e) => e.race === race.id);
    const base = memory.eventBase[race.id] ?? { run: before[index], p: lastEvent?.p1 ?? series[0]?.p ?? before[index].pD, t: lastEvent?.t ?? doc.createdAt };
    const previous = { run: before[index], p: series[series.length - 1]?.p ?? before[index].pD };
    series.push(timelinePoint(after[index], fetchedAt));
    const event = describeEvent(race, base, previous, after[index], fetchedAt, rules);
    if (event) { events.push(event); memory.eventBase[race.id] = { run: after[index], p: after[index].pD, t: fetchedAt }; }
  });
  memory.lastRuns = after;
  doc.events.push(...events);
  doc.latest = { fetchedAt, signature, returns };
  doc.updatedAt = fetchedAt;
  return { doc, changed: true, events, runs: after };
}

function timelinePoint(run, t) {
  return { t, p: run.pD, m: run.margin, lo: run.interval80[0], hi: run.interval80[1], c: run.countedShare };
}

/** FNV-1a over the serialized returns: cheap change detection between fetches. */
export function returnsSignature(returns) {
  const text = JSON.stringify(returns ?? null);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `${text.length}:${hash.toString(16)}`;
}

/**
 * Turn a big enough move into an annotation: a short chart label and a sentence for the list.
 * @param {{ run: object, p: number, t: string }} base the run and needle value at the race's last annotation
 * @param {{ run: object, p: number }} previous the run and needle value just before this update
 * @returns {null | { t: string, race: string, p0: number, p1: number, kind: string, subject: string, headline: string, detail: string }}
 */
export function describeEvent(race, base, previous, after, t, rules = NEEDLE_EVENT_RULES) {
  const p1 = after.pD;
  const first = base.run.countedVotes === 0 && after.countedVotes > 0;
  const minutesSince = (Date.parse(t) - Date.parse(base.t)) / 60000;
  const jump = Math.abs(p1 - previous.p) >= rules.jump;
  const drift = Math.abs(p1 - base.p) >= rules.drift && minutesSince >= rules.minGapMinutes;
  const flip = (base.p - 0.5) * (p1 - 0.5) < 0 && Math.abs(p1 - 0.5) >= rules.flipMargin && minutesSince >= rules.minGapMinutes;
  if (!first && !jump && !drift && !flip) return null;
  // A jump is explained by this update alone; anything else by all the votes counted since the last annotation.
  const from = jump && !first ? previous : base;
  const p0 = from.p;
  const dem = lastName(race.democrat), rep = lastName(race.republican);
  const signed = (margin) => (Math.abs(margin) < 0.5 ? "even" : `${margin > 0 ? "D" : "R"}+${Math.abs(margin).toFixed(0)}`);
  const ledBy = (margin) => (Math.abs(margin) < 0.05 ? "even" : `${margin > 0 ? dem : rep} +${Math.abs(margin).toFixed(1)}`);
  const chance = percent(p0) === percent(p1) ? `${dem}'s chance held at ${percent(p1)}.` : `${dem}'s chance ${p1 >= p0 ? "rose" : "fell"} from ${percent(p0)} to ${percent(p1)}.`;
  // A change in how Election Day votes are breaking re-projects every Election Day vote still out; say so.
  const dayShift = (after.shared?.electionDay?.mean ?? 0) - (from.run.shared?.electionDay?.mean ?? 0);
  const dayCounted = sumBy(after.counties, (c) => c.dayVotes);
  const dayNote = dayCounted > 0 && Math.abs(dayShift) >= 2
    ? ` Election Day votes now look ${Math.abs(after.shared.electionDay.mean).toFixed(0)} points ${after.shared.electionDay.mean > 0 ? "more Democratic" : "more Republican"} than early votes, which moves the projection for those still uncounted.`
    : "";
  const why = explainMove(from.run, after);
  if (!why) {
    return { t, race: race.id, p0: round(p0, 4), p1: round(p1, 4), kind: "estimate", subject: "Turnout estimate", headline: "Turnout estimate revised", detail: `Counties updated how many polling places have reported, which changed the expected Election Day vote. ${chance}` };
  }
  const gap = why.margin - why.expectedMargin;
  const versusExpected = Math.abs(gap) < 1 ? "about what the model expected" : `${Math.abs(gap).toFixed(1)} points ${gap > 0 ? "more Democratic" : "more Republican"} than the model expected (${ledBy(why.expectedMargin)})`;
  const typeWords = { early: "early vote", day: "Election Day vote", both: "early and Election Day votes" };
  let label, opening;
  if (first && why.counties > 1) { label = why.subject; opening = `First returns, from ${why.counties} counties`; }
  else if (why.kind === "region") { label = why.subject; opening = `New votes from ${why.regionCounties} ${REGION_PHRASES[why.subject] || why.subject} ${why.regionCounties === 1 ? "county" : "counties"}`; }
  else if (why.kind === "many") { label = why.subject; opening = `New votes from ${why.subject}`; }
  else { label = why.kind === "both" ? why.subject : `${why.subject} ${typeWords[why.kind]}`; opening = `${why.subject} County's ${typeWords[why.kind]}`; }
  // Name the county that moved the projection most only when it moved it by a real number of votes.
  const top = why.topCounties[0];
  const grouped = why.kind === "region" || why.kind === "many" || (first && why.counties > 1);
  const biggest = grouped && Math.abs(top.impact) >= 1000 ? ` Moved it most: ${top.name}, ${ledBy(top.margin)} against an expected ${ledBy(top.expectedMargin)}.` : "";
  const versus = Math.abs(gap) < 1 ? "as expected" : `${signed(gap)} vs. expected`;
  const headline = first
    ? `First returns, ${why.counties} ${why.counties === 1 ? "county" : "counties"}`
    : grouped ? `${label}, ${versus}` : `${label} ${signed(why.margin)}${Math.abs(gap) >= 1 ? ` (exp. ${signed(why.expectedMargin)})` : ""}`;
  // Votes arriving as expected still move the needle toward the favorite, because less is left to count. Early
  // in the count that is not news, so it waits until a quarter of the vote is in.
  if (!first && Math.abs(gap) < 1 && grouped) {
    if (after.countedShare < rules.narrowingFrom) return null;
    const favorite = after.margin >= 0 ? dem : rep;
    return {
      t, race: race.id, p0: round(p0, 4), p1: round(p1, 4), kind: "narrowing", subject: why.subject,
      headline: `${favorite} holds as count hits ${Math.round(after.countedShare * 100)}%`,
      detail: `${opening} came in about as the model expected (${ledBy(why.margin)} on ${why.votes.toLocaleString("en-US")} votes).${dayNote} With less left to count, ${chance}`,
      votes: why.votes, margin: why.margin, expectedMargin: why.expectedMargin, topCounties: why.topCounties.slice(0, 3),
    };
  }
  const detail = `${opening}: ${ledBy(why.margin)} on ${why.votes.toLocaleString("en-US")} votes, ${versusExpected}.${biggest}${dayNote} ${chance}`;
  return {
    t, race: race.id, p0: round(p0, 4), p1: round(p1, 4), kind: first ? "first" : flip ? "flip" : why.kind, subject: why.subject, headline, detail,
    votes: why.votes, margin: why.margin, expectedMargin: why.expectedMargin, topCounties: why.topCounties.slice(0, 3),
  };
}

/** Region names as they read mid-sentence ("3 suburban counties"). */
const REGION_PHRASES = { "Big cities": "big-city", "Rio Grande Valley and border": "Rio Grande Valley and border", "Suburbs": "suburban", "Midsize cities": "midsize-city", [RURAL_GROUP]: "rural and small-town" };
function lastName(name) { return String(name || "").trim().split(/\s+/).pop(); }
function percent(p) { return p >= 0.995 ? ">99%" : p <= 0.005 ? "<1%" : `${Math.round(p * 100)}%`; }

// ---- Math helpers --------------------------------------------------------------------------------------------

/** Standard normal CDF (erfc via the Numerical Recipes Chebyshev fit, |error| < 1.2e-7). */
export function normalCdf(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfc = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - erfc / 2 : erfc / 2;
}
function cholesky(matrix) {
  const n = matrix.length, lower = zeros(n, n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = matrix[i][j];
      for (let k = 0; k < j; k += 1) sum -= lower[i][k] * lower[j][k];
      if (i === j) lower[i][i] = Math.sqrt(Math.max(sum, 1e-12));
      else lower[i][j] = sum / lower[j][j];
    }
  }
  return lower;
}
function choleskySolve(lower, vector) {
  const n = lower.length, y = new Array(n).fill(0), x = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) { let sum = vector[i]; for (let k = 0; k < i; k += 1) sum -= lower[i][k] * y[k]; y[i] = sum / lower[i][i]; }
  for (let i = n - 1; i >= 0; i -= 1) { let sum = y[i]; for (let k = i + 1; k < n; k += 1) sum -= lower[k][i] * x[k]; x[i] = sum / lower[i][i]; }
  return x;
}
function logDetFromCholesky(lower) { return 2 * lower.reduce((t, row, i) => t + Math.log(row[i]), 0); }
function invertSmall(matrix) {
  if (matrix.length === 1) return [[1 / matrix[0][0]]];
  const [[a, b], [c, d]] = matrix;
  const determinant = a * d - b * c;
  return [[d / determinant, -b / determinant], [-c / determinant, a / determinant]];
}
function bisect(fn, low, high) {
  for (let i = 0; i < 100; i += 1) { const mid = (low + high) / 2; if (fn(mid) > 0) high = mid; else low = mid; }
  return (low + high) / 2;
}
function zeros(rows, cols) { return Array.from({ length: rows }, () => new Array(cols).fill(0)); }
function dot(a, b) { let total = 0; for (let i = 0; i < a.length; i += 1) total += a[i] * b[i]; return total; }
function sumBy(items, pick) { let total = 0; items.forEach((item, index) => { total += pick(item, index); }); return total; }
function groupBy(items, keyOf) { const map = new Map(); for (const item of items) { const key = keyOf(item); if (!map.has(key)) map.set(key, []); map.get(key).push(item); } return map; }
function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }
function round(value, digits) { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
