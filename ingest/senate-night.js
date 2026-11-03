// Election-night U.S. Senate control: the chance each party controls the Senate as races are called.
//
// There is no free live feed of every state's returns, so this runs on race calls (from the 2026 Senate elections
// page on Wikipedia, where editors post network calls, plus manual overrides), the live Texas needle, and each race's
// pre-election chance from the site's polls model.
//
// The model has one national factor. Each race's challenger (the Democrat, or the independent where the Democrat
// stepped aside) has a margin m[s] + ε + e[s]: ε is a polling miss shared by every state (Student-t), e[s] the
// state's own error. m[s] is set so that with nothing called the race's chance equals the polls model's. A call is
// hard evidence on ε (that race's margin landed on the winner's side), and the Texas needle's read of how far Texas
// is running from its polls is soft evidence. The posterior over ε (a grid) reweights every race still out, and the
// seat count is mixed over ε, so a surprise in one state moves the others. Given ε, races are independent.
import { normalCdf } from "./needle.js";
import { seatDistribution } from "./metrics.js";

export const SENATE_NIGHT_MODEL = {
  // The shared polling miss: Student-t with 5 degrees of freedom and this scale, in points of margin. Its sd is
  // about 4.5, most of a typical race's 5.5-point polls-model spread; the state's own error takes the rest.
  nationalScale: 3.5,
  nationalDf: 5,
  minimumStateSd: 2.5,
  ratingOnlySigma: 7, // races with no polls get a wider spread
  // How far a state's polling miss strays from the national one, for reading Texas as evidence about ε.
  stateMissSd: 3,
  grid: { from: -25, to: 25, step: 0.25 },
  majority: 51, // a 50–50 Senate goes to Republicans: the vice president (Vance) breaks ties
};
export const SENATE_NIGHT_EVENT_RULES = { bigMove: 0.08 };

/**
 * The 35 races from the morning snapshot, with each challenger's pre-election chance and spread.
 * @param {object} snapshot public/data/latest.json
 */
export function senateNightRaces(snapshot, params = SENATE_NIGHT_MODEL) {
  return snapshot.usSenate.races.map((race) => {
    const challengerParty = (race.pI ?? 0) > (race.pD ?? 0) ? "I" : "D";
    const p = challengerParty === "I" ? race.pI : race.pD;
    return {
      state: race.state, stateName: race.stateName, special: Boolean(race.special), incumbentParty: race.incumbentParty,
      challengerParty, challenger: race.candidates?.[challengerParty] ?? null, republican: race.candidates?.R ?? null,
      democrat: race.candidates?.D ?? null, independent: race.candidates?.I ?? null,
      prior: Math.min(0.999, Math.max(0.001, p ?? 0.5)),
      sigma: race.pollModel?.sigma ?? params.ratingOnlySigma,
      rating: race.consensus?.label ?? null,
      pollMargin: race.pollingAverage?.margin ?? null, // challenger minus Republican
    };
  });
}

/** The posterior grid for ε, starting from the Student-t prior. */
function nationalGrid(params) {
  const { from, to, step } = params.grid;
  const points = [];
  for (let e = from; e <= to + 1e-9; e += step) {
    const z = e / params.nationalScale;
    points.push({ e, weight: (1 + (z * z) / params.nationalDf) ** (-(params.nationalDf + 1) / 2) });
  }
  const total = points.reduce((t, p) => t + p.weight, 0);
  for (const p of points) p.weight /= total;
  return points;
}
function nationalVariance(grid) { return grid.reduce((t, p) => t + p.weight * p.e * p.e, 0); }

/**
 * Margin and state spread for each race such that, with nothing called, its chance equals the polls model's:
 * Σ prior(ε) Φ((m + ε) / sd) = p, solved by bisection.
 */
export function calibrateRaces(races, params = SENATE_NIGHT_MODEL) {
  const grid = nationalGrid(params), variance = nationalVariance(grid);
  return races.map((race) => {
    const sd = Math.sqrt(Math.max(params.minimumStateSd ** 2, race.sigma ** 2 - variance));
    const chance = (m) => grid.reduce((t, p) => t + p.weight * normalCdf((m + p.e) / sd), 0);
    let low = -80, high = 80;
    for (let i = 0; i < 60; i += 1) { const mid = (low + high) / 2; if (chance(mid) < race.prior) low = mid; else high = mid; }
    return { ...race, margin: (low + high) / 2, sd };
  });
}

/**
 * Senate control from calls and the live Texas race.
 * @param {{ races: ReturnType<typeof calibrateRaces>, calls: Record<string, { winner: "D"|"R"|"I"|"other" }>,
 *   texas?: { pD: number, margin?: number, statewide?: { mean: number, sd: number }, counted?: number } | null,
 *   notUp: { democraticCaucus: number, republican: number } }} input
 */
export function runSenateNight({ races, calls = {}, texas = null, notUp, params = SENATE_NIGHT_MODEL }) {
  const grid = nationalGrid(params);
  // Evidence on ε: each call says the challenger's margin landed above or below zero.
  const posterior = grid.map((point) => {
    let weight = point.weight;
    for (const race of races) {
      const call = calls[race.state];
      if (!call) continue;
      const challengerWins = normalCdf((race.margin + point.e) / race.sd);
      weight *= call.winner === race.challengerParty ? challengerWins : 1 - challengerWins;
    }
    // The Texas needle's statewide read (points the state runs from its polls) once votes are counted.
    if (texas?.statewide && texas.counted > 0 && !calls.TX) {
      const spread = Math.sqrt(texas.statewide.sd ** 2 + params.stateMissSd ** 2);
      weight *= Math.exp(-0.5 * ((texas.statewide.mean - point.e) / spread) ** 2);
    }
    return { e: point.e, weight };
  });
  const total = posterior.reduce((t, p) => t + p.weight, 0);
  if (!(total > 0)) throw new Error("the calls are inconsistent with every national swing on the grid");
  for (const p of posterior) p.weight /= total;

  const chanceAt = (race, e) => {
    const call = calls[race.state];
    if (call) return { pD: call.winner === "D" ? 1 : 0, pR: call.winner === "R" ? 1 : 0, pI: call.winner === "I" || call.winner === "other" ? 1 : 0 };
    const challenger = race.state === "TX" && texas && texas.counted > 0 ? texas.pD : normalCdf((race.margin + e) / race.sd);
    return race.challengerParty === "I" ? { pD: 0, pR: 1 - challenger, pI: challenger } : { pD: challenger, pR: 1 - challenger, pI: 0 };
  };
  // The challenger's expected margin: the needle's projection for a live Texas count; for a called race, the mean
  // of the side of zero the call puts it on.
  const marginAt = (race, e) => {
    const call = calls[race.state], mean = race.margin + e;
    if (!call) return race.state === "TX" && texas?.margin != null && texas.counted > 0 ? texas.margin : mean;
    const z = mean / race.sd, density = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    const won = call.winner === race.challengerParty, tail = Math.max(won ? normalCdf(z) : 1 - normalCdf(z), 1e-12);
    return won ? mean + (race.sd * density) / tail : mean - (race.sd * density) / tail;
  };
  const control = { D: 0, R: 0, none: 0 };
  let expectedD = 0, epsilonMean = 0, epsilonSq = 0;
  const perRace = races.map(() => 0), perRaceMargin = races.map(() => 0);
  for (const point of posterior) {
    if (point.weight < 1e-7) continue;
    const chances = races.map((race) => chanceAt(race, point.e));
    const seats = seatDistribution(chances, { democraticCaucusNotUp: notUp.democraticCaucus, republicanNotUp: notUp.republican });
    control.D += point.weight * seats.control.D; control.R += point.weight * seats.control.R; control.none += point.weight * seats.control.none;
    expectedD += point.weight * seats.expected.D;
    epsilonMean += point.weight * point.e; epsilonSq += point.weight * point.e * point.e;
    chances.forEach((c, i) => { perRace[i] += point.weight * (races[i].challengerParty === "I" ? c.pI : c.pD); });
    races.forEach((race, i) => { perRaceMargin[i] += point.weight * marginAt(race, point.e); });
  }
  // Grid points too unlikely to matter were skipped; renormalize over the ones used.
  const used = control.D + control.R + control.none;
  const share = (value) => Math.round((value / used) * 10000) / 10000;
  const called = { D: 0, R: 0, I: 0 };
  for (const race of races) { const w = calls[race.state]?.winner; if (w === "D") called.D += 1; else if (w === "R") called.R += 1; else if (w) called.I += 1; }
  return {
    pD: share(control.D), pR: share(control.R), pNone: share(control.none),
    expectedD: Math.round((expectedD / used) * 10) / 10,
    nationalSwing: { mean: Math.round((epsilonMean / used) * 100) / 100, sd: Math.round(Math.sqrt(Math.max(0, epsilonSq / used - (epsilonMean / used) ** 2)) * 100) / 100 },
    called, uncalled: races.length - called.D - called.R - called.I,
    races: races.map((race, i) => ({ state: race.state, challengerParty: race.challengerParty, prior: race.prior, chance: Math.round((perRace[i] / used) * 1000) / 1000, expectedMargin: Math.round((perRaceMargin[i] / used) * 10) / 10, call: calls[race.state] ?? null })),
  };
}

// ---- Calls from Wikipedia ------------------------------------------------------------------------------------

/**
 * Race calls from the "Elections leading to the next Congress" table of the 2026 Senate elections page: a winner
 * marked {{Aye}} (or a check) in the candidate list, or a result like "Democratic gain." / "Incumbent re-elected."
 * @param {string} wikitext
 * @param {Record<string, string>} codeByStateName e.g. { Texas: "TX" }
 * @returns {Record<string, { winner: "D"|"R"|"I"|"other", name: string|null, via: string }>}
 */
export function parseSenateCalls(wikitext, codeByStateName) {
  const start = wikitext.indexOf("Elections leading to the next Congress");
  if (start === -1) return {};
  const nextHeading = wikitext.slice(start + 40).search(/\n==[^=]/);
  const table = wikitext.slice(start, nextHeading === -1 ? undefined : start + 40 + nextHeading);
  const calls = {};
  for (const row of table.split(/\n\|-/)) {
    const stateMatch = row.match(/\n?!\s*\[\[2026 United States Senate (?:special )?election in ([^|\]]+)\|/);
    if (!stateMatch) continue;
    const code = codeByStateName[stateMatch[1].trim()];
    if (!code) continue;
    const partyOf = (text) => (/\(Democratic/.test(text) ? "D" : /\(Republican/.test(text) ? "R" : /\(Independent/.test(text) ? "I" : "other");
    const candidateLines = row.split("\n").filter((line) => line.trim().startsWith("*"));
    const winnerLine = candidateLines.find((line) => /\{\{\s*(aye|ya|yes check|check mark|tick|✓)\s*\}\}/i.test(line));
    if (winnerLine) {
      const name = (winnerLine.match(/'''\[\[(?:[^|\]]*\|)?([^\]]+)\]\]'''/) || winnerLine.match(/'''([^']+)'''/) || [])[1] ?? null;
      calls[code] = { winner: partyOf(winnerLine), name, via: "winner marked" };
      continue;
    }
    // No marked winner yet: the Results cell, when it states an outcome.
    const result = row.match(/\b(Democratic|Republican|Independent) (gain|hold)\b/);
    if (result) { calls[code] = { winner: { Democratic: "D", Republican: "R", Independent: "I" }[result[1]], name: null, via: `result: ${result[1]} ${result[2]}` }; continue; }
    if (/Incumbent re-?elected/i.test(row)) {
      const incumbentParty = row.match(/\{\{Party shading\/(Democratic|Republican|Independent)\}\}\s*\|\s*(Democratic|Republican|Independent)/);
      if (incumbentParty) calls[code] = { winner: { Democratic: "D", Republican: "R", Independent: "I" }[incumbentParty[2]], name: null, via: "result: incumbent re-elected" };
    }
  }
  return calls;
}

/** Wikipedia calls with manual overrides on top: a state set to a party wins; set to "none" it is uncalled. */
export function mergeCalls(wikipediaCalls, overrides = {}) {
  const merged = { ...wikipediaCalls };
  for (const [state, value] of Object.entries(overrides || {})) {
    if (state.startsWith("_")) continue;
    if (value === "none" || value === null) delete merged[state];
    else if (["D", "R", "I", "other"].includes(value)) merged[state] = { winner: value, name: null, via: "manual" };
  }
  return merged;
}

// ---- The recorded night -------------------------------------------------------------------------------------

/** A fresh Senate-night document from the morning snapshot: frozen races and one pre-results point. */
export function createSenateNightDocument(snapshot, { now = new Date().toISOString(), params = SENATE_NIGHT_MODEL } = {}) {
  const races = calibrateRaces(senateNightRaces(snapshot, params), params);
  const notUp = snapshot.senateControl.notUp;
  const run = runSenateNight({ races, calls: {}, texas: null, notUp, params });
  return {
    version: 1, kind: "senate-night", createdAt: now, updatedAt: now, checkedAt: now, snapshotAsOf: snapshot.asOf,
    inputs: { races, notUp }, timeline: [{ t: now, p: run.pD, e: run.expectedD, called: run.called, n: run.nationalSwing.mean, r: run.races.map((race) => race.chance) }], events: [], latest: { calls: {}, texas: null }, returns: {},
  };
}

/**
 * Fold one check into the document: a point when a call or the Texas needle changed, an event for each new call and
 * for any big move. The states' counts (`returns`, from summarizeReturns) are stored as shown and never add a point
 * on their own. Mutates and returns `doc`.
 */
export function advanceSenateNight(doc, { calls, texas = null, returns = null, fetchedAt, params = SENATE_NIGHT_MODEL, rules = SENATE_NIGHT_EVENT_RULES }) {
  doc.checkedAt = fetchedAt;
  if (returns) doc.returns = returns;
  const signature = JSON.stringify({ calls: Object.fromEntries(Object.entries(calls).map(([s, c]) => [s, c.winner]).sort()), texas: texas ? [Math.round(texas.pD * 1000), texas.counted, Math.round((texas.margin ?? 0) * 10)] : null });
  if (doc.latest?.signature === signature) return { doc, changed: false, events: [] };
  const { races, notUp } = doc.inputs;
  const run = runSenateNight({ races, calls, texas, notUp, params });
  const last = doc.timeline[doc.timeline.length - 1];
  const previousCalls = doc.latest?.calls ?? {};
  const events = [];
  const pct = (p) => (p >= 0.995 ? ">99%" : p <= 0.005 ? "<1%" : `${Math.round(p * 100)}%`);
  const partyWord = { D: "Democrats", R: "Republicans", I: "an independent", other: "a third-party candidate" };
  const newCalls = races.filter((race) => calls[race.state] && previousCalls[race.state]?.winner !== calls[race.state].winner);
  for (const race of newCalls) {
    const call = calls[race.state];
    const winnerName = call.name || (call.winner === "R" ? race.republican : call.winner === "D" ? race.democrat : call.winner === "I" ? race.independent : null);
    const upset = (call.winner === race.challengerParty ? race.prior : 1 - race.prior) < 0.35;
    // When several races are called in one check, each event shows its own effect: control with every other
    // call in, without and then with this one.
    const { [race.state]: _withoutThis, ...others } = calls;
    const p0 = newCalls.length > 1 ? runSenateNight({ races, calls: others, texas, notUp, params }).pD : last.p;
    events.push({
      t: fetchedAt, kind: upset ? "upset" : "call", state: race.state, winner: call.winner, p0, p1: run.pD,
      headline: `${race.stateName} for ${winnerName ? `${winnerName} (${call.winner})` : partyWord[call.winner]}`,
      detail: `${race.stateName}${race.special ? " (special)" : ""} called for ${winnerName ? `${winnerName} (${call.winner})` : partyWord[call.winner]}${upset ? `, an upset: the polls gave that side ${pct(call.winner === race.challengerParty ? race.prior : 1 - race.prior)}` : ""}. ${pct(run.pD) === pct(p0) ? `Democrats' chance of control held at ${pct(run.pD)}` : `On its own, it moved Democrats' chance of control from ${pct(p0)} to ${pct(run.pD)}`}${newCalls.length > 1 ? `, with ${newCalls.length - 1} other ${newCalls.length === 2 ? "race" : "races"} called in the same check` : ""}.`,
    });
  }
  for (const state of Object.keys(previousCalls)) {
    if (!calls[state]) events.push({ t: fetchedAt, kind: "uncall", state, p0: last.p, p1: run.pD, headline: `${state} call withdrawn`, detail: `The ${state} call was withdrawn or corrected; it counts as uncalled again. Democrats' chance of control ${pct(last.p)} to ${pct(run.pD)}.` });
  }
  if (!events.length && Math.abs(run.pD - last.p) >= rules.bigMove) {
    events.push({ t: fetchedAt, kind: "texas", p0: last.p, p1: run.pD, headline: "Texas count moves control", detail: `The Texas count moved Talarico's chance to ${pct(texas?.pD ?? 0)}; Democrats' chance of control ${run.pD >= last.p ? "rose" : "fell"} from ${pct(last.p)} to ${pct(run.pD)}.` });
  }
  doc.timeline.push({ t: fetchedAt, p: run.pD, e: run.expectedD, called: run.called, n: run.nationalSwing.mean, r: run.races.map((race) => race.chance) });
  doc.events.push(...events);
  doc.latest = { signature, calls, texas, run };
  doc.updatedAt = fetchedAt;
  return { doc, changed: true, events, run };
}
