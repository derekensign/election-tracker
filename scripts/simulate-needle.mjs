// Simulated election night for testing the needle: draws a "true" result for every county and race, releases it
// the way Texas counties report (early votes from 7 p.m., Election Day batches until after midnight, the biggest
// counties last), builds SOS-shaped county files every two minutes, and feeds them through the real parser and
// model. Output is a needle document like the recorder's, for previewing the page with ?demo#election-night.
//
//   node scripts/simulate-needle.mjs [--seed 7] [--swing -3] [--day-offset -4] [--out public/data/needle-demo.json]
//   node scripts/simulate-needle.mjs --calibration 200     # many nights: is a 70% needle right 70% of the time?
//
// --swing moves the true statewide result from the polls (points toward Democrats); --day-offset makes Election
// Day votes that much more Democratic than early votes. Both are drawn at random when omitted.
import { readFileSync, writeFileSync } from "node:fs";
import { NEEDLE_MODEL, NEEDLE_RACES, advanceNeedle, createNeedleDocument, parseCountyReturns, runNeedle } from "../ingest/needle.js";

const BIG_COUNTIES = new Set(["HARRIS", "DALLAS", "TARRANT", "BEXAR", "TRAVIS", "COLLIN", "DENTON", "FORTBEND", "HIDALGO", "ELPASO", "WILLIAMSON", "MONTGOMERY"]);
const MOUNTAIN_TIME = new Set(["ELPASO", "HUDSPETH"]);
const POLLS_CLOSE_MS = Date.parse("2026-11-04T01:00:00Z"); // 7 p.m. Central
const MINUTE = 60_000;

/** Small seeded generator (mulberry32) so a night can be replayed exactly. */
function makeRandom(seed) {
  let state = seed >>> 0;
  const uniform = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const normal = () => { const u = Math.max(uniform(), 1e-12), v = uniform(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const studentT = (df) => { let chi = 0; for (let i = 0; i < df; i += 1) chi += normal() ** 2; return normal() / Math.sqrt(chi / df); };
  return { uniform, normal, studentT, between: (low, high) => low + (high - low) * uniform() };
}

/**
 * Draw one night: true county results for every race and a reporting schedule.
 * @param {object} doc a needle document (for its frozen county inputs and race priors)
 */
export function drawNight(doc, { seed = 1, swing = null, dayOffset = null, params = NEEDLE_MODEL } = {}) {
  const random = makeRandom(seed);
  const { counties, races } = doc.inputs;
  const statewideError = swing ?? random.studentT(5) * 5.2;
  const electionDayOffset = dayOffset ?? random.normal() * 6;
  const regionEffect = Object.fromEntries(Object.entries(params.regionSd).map(([region, sd]) => [region, random.normal() * sd]));
  // Election Day turnout: statewide, regional, and county ratio errors on the model's 0.35 prior, as the model assumes.
  const ratioPrior = params.electionDayRatio;
  const statewideRatio = ratioPrior.prior * Math.exp(random.normal() * ratioPrior.logSd);
  const regionRatio = Object.fromEntries(Object.keys(params.regionSd).map((region) => [region, statewideRatio * Math.exp(random.normal() * ratioPrior.regionLogSd)]));
  const raceEffect = Object.fromEntries(races.map((race) => [race.id, random.normal() * 1.5]));

  // Center the truth on the model's own starting point (county priors, early-vote turnout mix included), so a
  // calibration check tests the inference rather than a disagreement about where the night starts.
  const priorMargins = Object.fromEntries(runNeedle({ counties, returns: null, races, params }).map((run) => [run.id, new Map(run.counties.map((c) => [c.key, c.priorMargin]))]));
  const totalPrior = counties.reduce((t, c) => t + c.early * 1.35, 0);
  const meanShift = counties.reduce((t, c) => t + c.early * 1.35 * c.relativeShift, 0) / totalPrior;
  const realignment = random.normal() * params.realignmentSd;
  // A factor the model does not know about: small counties (which report first) swing differently from big ones.
  // Centered on the vote so it never moves the state, only the order in which the truth is revealed.
  const smallCountyEffect = random.normal() * 3;
  const smallShare = counties.filter((c) => c.early < 20000).reduce((t, c) => t + c.early, 0) / counties.reduce((t, c) => t + c.early, 0);

  const truth = counties.map((county) => {
    const dayRatio = regionRatio[county.region] * Math.exp(random.normal() * ratioPrior.countyLogSd);
    // County deviations are fat-tailed (Student-t, as the model now assumes), so a few counties land far off.
    const { base, scale: sizeScale, referenceVotes, max } = params.countySd;
    const countyEffect = random.studentT(params.robustDf) * Math.min(max, base + sizeScale / Math.sqrt(Math.max(county.early * 1.35, 1) / referenceVotes)) * Math.sqrt((params.robustDf - 2) / params.robustDf);
    const dayShare = dayRatio / (1 + dayRatio);
    const cellSpread = (votes) => Math.sqrt(params.cellSd ** 2 + (1e4 * params.samplingDesignEffect) / Math.max(votes, 1));
    const earlyCell = random.normal() * cellSpread(county.early), dayCell = random.normal() * cellSpread(county.early * dayRatio);
    const byRace = {};
    for (const race of races) {
      const base = priorMargins[race.id].get(county.key) + statewideError + raceEffect[race.id] + regionEffect[county.region] + countyEffect
        - realignment * Math.max(-params.realignmentCap, Math.min(params.realignmentCap, county.relativeShift - meanShift))
        + (county.early < 20000 ? smallCountyEffect : (-smallCountyEffect * smallShare) / (1 - smallShare));
      const earlyMargin = clampMargin(base - electionDayOffset * dayShare + earlyCell);
      const dayMargin = clampMargin(base + electionDayOffset * (1 - dayShare) + dayCell);
      const rollOff = race.id === NEEDLE_RACES[0].id || race.id === NEEDLE_RACES[1].id ? 0.985 : 0.972;
      const otherShare = race.id === NEEDLE_RACES[0].id ? 0.02 : 0.03;
      byRace[race.id] = {
        early: splitVotes(Math.round(county.early * rollOff), earlyMargin, otherShare),
        day: splitVotes(Math.round(county.early * dayRatio * rollOff), dayMargin, otherShare),
      };
    }
    // Reporting schedule, in minutes after 7 p.m. Central.
    const big = BIG_COUNTIES.has(county.key);
    const opens = MOUNTAIN_TIME.has(county.key) ? 60 : 0;
    const earlyAt = opens + (big ? random.between(15, 75) : random.between(2, 50));
    const mailFirst = random.uniform() < 0.12; // a few counties post mail ballots before in-person early votes
    const dayStart = earlyAt + random.between(30, 75);
    const dayEnd = dayStart + (big ? random.between(180, 330) : random.between(40, 200));
    const batches = Math.max(1, Math.round(big ? random.between(6, 14) : random.between(1, 5)));
    const cuts = Array.from({ length: batches - 1 }, () => random.uniform()).sort((a, b) => a - b);
    const schedule = [...cuts, 1].map((share, index) => ({ at: dayStart + (dayEnd - dayStart) * ((index + 1) / batches), share, noise: random.normal() * 5 }));
    return { county, byRace, earlyAt, mailFirst, schedule, dayRatio };
  });
  return { statewideError, electionDayOffset, regionEffect, realignment, truth };
}

function clampMargin(margin) { return Math.max(-97, Math.min(97, margin)); }
function splitVotes(total, margin, otherShare) {
  const other = Math.round(total * otherShare);
  const twoParty = total - other;
  const dem = Math.round((twoParty * (1 + margin / (100 * (1 - otherShare)))) / 2);
  return { total, dem: Math.max(0, Math.min(twoParty, dem)), rep: Math.max(0, twoParty - Math.max(0, Math.min(twoParty, dem))), other };
}

/** SOS-shaped county file (decoded) for the counts released by `minutesAfterClose`. */
export function countyFileAt(night, minutesAfterClose) {
  const file = {};
  night.truth.forEach((entry, index) => {
    const { county, byRace, earlyAt, mailFirst, schedule } = entry;
    const earlyFraction = minutesAfterClose < earlyAt - (mailFirst ? 20 : 0) ? 0 : mailFirst && minutesAfterClose < earlyAt ? 0.04 : 1;
    const doneBatches = schedule.filter((b) => minutesAfterClose >= b.at);
    const dayFraction = doneBatches.length ? doneBatches[doneBatches.length - 1].share : 0;
    // Batches arrive in an order that is not random: each one leans a few points off the county's Election Day margin.
    const dayLean = doneBatches.length && dayFraction < 1 ? doneBatches.reduce((t, b) => t + b.noise, 0) / doneBatches.length : 0;
    const pollingPlaces = Math.max(2, Math.round(county.early / 2500));
    const racesOut = {};
    for (const spec of NEEDLE_RACES) {
      const truth = byRace[spec.id];
      if (!truth) continue;
      const early = scale(truth.early, earlyFraction, 0);
      const day = scale(truth.day, dayFraction, dayLean);
      racesOut[spec.officeId] = {
        OID: spec.officeId, N: spec.officeName,
        C: {
          [`${spec.officeId}1`]: { P: "DEM", V: early.dem + day.dem, EV: early.dem },
          [`${spec.officeId}2`]: { P: "REP", V: early.rep + day.rep, EV: early.rep },
          [`${spec.officeId}3`]: { P: "LIB", V: early.other + day.other, EV: early.other },
        },
      };
    }
    file[String(index + 1)] = {
      N: county.name.toUpperCase(), Races: racesOut,
      Summary: { NPL: pollingPlaces, PLR: Math.round(pollingPlaces * dayFraction), PRP: pollingPlaces * 2, PRR: Math.round(pollingPlaces * 2 * dayFraction), VC: 0 },
    };
  });
  return file;
}

function scale(votes, fraction, leanPoints) {
  if (fraction <= 0) return { dem: 0, rep: 0, other: 0 };
  const total = votes.dem + votes.rep, shift = (fraction < 1 ? leanPoints / 200 : 0) * total;
  return { dem: Math.round((votes.dem + shift) * fraction), rep: Math.round((votes.rep - shift) * fraction), other: Math.round(votes.other * fraction) };
}

/** Run a full night through the parser, model, and event logic. */
export function simulateNight(snapshot, options = {}) {
  const startedAt = new Date(POLLS_CLOSE_MS - 30 * MINUTE).toISOString();
  const doc = createNeedleDocument(snapshot, { now: startedAt });
  const night = drawNight(doc, options);
  const memory = {};
  for (let minute = 0; minute <= (options.minutes ?? 540); minute += options.stepMinutes ?? 2) {
    const returns = parseCountyReturns(countyFileAt(night, minute));
    advanceNeedle(doc, { returns, fetchedAt: new Date(POLLS_CLOSE_MS + minute * MINUTE).toISOString() }, memory);
  }
  const finalMargins = Object.fromEntries(doc.inputs.races.map((race) => {
    const sums = night.truth.reduce((t, e) => ({ dem: t.dem + e.byRace[race.id].early.dem + e.byRace[race.id].day.dem, rep: t.rep + e.byRace[race.id].early.rep + e.byRace[race.id].day.rep, total: t.total + e.byRace[race.id].early.total + e.byRace[race.id].day.total }), { dem: 0, rep: 0, total: 0 });
    return [race.id, (100 * (sums.dem - sums.rep)) / sums.total];
  }));
  return { doc, night, finalMargins };
}

// ---- CLI -------------------------------------------------------------------------------------------------------
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1]]] : pairs), []));
  const snapshot = JSON.parse(readFileSync(new URL("../public/data/latest.json", import.meta.url), "utf8"));
  if (args.calibration) {
    // Simulation-based calibration: bucket every (night, time, race) needle reading and compare with outcomes.
    const nights = Number(args.calibration);
    const buckets = Array.from({ length: 10 }, () => ({ n: 0, p: 0, wins: 0 }));
    let brier = 0, readings = 0;
    for (let seed = 1; seed <= nights; seed += 1) {
      const { doc, finalMargins } = simulateNight(snapshot, { seed, stepMinutes: 10 });
      for (const race of doc.inputs.races) {
        const won = finalMargins[race.id] > 0 ? 1 : 0;
        for (const point of doc.timeline[race.id].slice(1)) {
          const bucket = buckets[Math.min(9, Math.floor(point.p * 10))];
          bucket.n += 1; bucket.p += point.p; bucket.wins += won;
          brier += (point.p - won) ** 2; readings += 1;
        }
      }
      if (seed % 25 === 0) console.error(`${seed} nights`);
    }
    console.log("needle bucket   readings   mean needle   share won");
    buckets.forEach((b, i) => b.n && console.log(`${String(i * 10).padStart(3)}-${String(i * 10 + 10).padEnd(4)}%   ${String(b.n).padStart(8)}   ${(100 * b.p / b.n).toFixed(1).padStart(10)}%   ${(100 * b.wins / b.n).toFixed(1).padStart(8)}%`));
    console.log(`Brier score ${(brier / readings).toFixed(4)} over ${readings} readings`);
  } else {
    const options = { seed: Number(args.seed ?? 7), swing: args.swing != null ? Number(args.swing) : null, dayOffset: args["day-offset"] != null ? Number(args["day-offset"]) : null };
    const { doc, night, finalMargins } = simulateNight(snapshot, options);
    doc.simulated = { seed: options.seed, statewideError: Math.round(night.statewideError * 10) / 10, electionDayOffset: Math.round(night.electionDayOffset * 10) / 10, finalMargins };
    const out = args.out || "public/data/needle-demo.json";
    writeFileSync(out, JSON.stringify(doc));
    console.log(`truth: statewide error ${night.statewideError.toFixed(1)}, Election Day offset ${night.electionDayOffset.toFixed(1)}, realignment ${night.realignment.toFixed(2)}`);
    for (const race of doc.inputs.races) {
      const series = doc.timeline[race.id];
      const at = (minutes) => series.find((p) => Date.parse(p.t) >= POLLS_CLOSE_MS + minutes * MINUTE) || series[series.length - 1];
      console.log(`${race.id.padEnd(15)} prior ${(100 * series[0].p).toFixed(0)}%  7:30 ${(100 * at(30).p).toFixed(0)}%  8:30 ${(100 * at(90).p).toFixed(0)}%  10:00 ${(100 * at(180).p).toFixed(0)}%  final ${(100 * series[series.length - 1].p).toFixed(1)}%  margin ${series[series.length - 1].m} (true ${finalMargins[race.id].toFixed(2)})  events ${doc.events.filter((e) => e.race === race.id).length}`);
    }
    for (const event of doc.events.filter((e) => e.race === "tx-senate")) console.log(`  ${new Date(event.t).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })}  ${event.headline}  —  ${event.detail}`);
    console.log(`wrote ${out} (${(JSON.stringify(doc).length / 1024).toFixed(0)} KB)`);
  }
}
