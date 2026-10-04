// Orchestrates one daily snapshot: fetch every source, derive metrics, diff against the previous day, write public/data.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_MARKETS, SENATE_MARKETS, SENATE_SEATS_NOT_UP, SENATE_STATES, TEXAS_LEGISLATURE, TEXAS_STATEWIDE_RACES,
  THIN_MARKET_VOLUME_USD, US_HOUSE, US_SENATE_WIKIPEDIA_PAGE,
} from "./config.js";
import * as polymarket from "./sources/polymarket.js";
import * as kalshi from "./sources/kalshi.js";
import * as votehub from "./sources/votehub.js";
import * as wikipedia from "./sources/wikipedia.js";
import { dedupePolls, pollWinProbability, pollingAverage, priorFromRating, ratingConsensus, ratingScore, seatDistribution } from "./metrics.js";
import { ratePollster } from "./pollsters.js";
import { estimateEnvironment, ratingImpliedMargin, runChamberModel, runRatedChamberModel } from "./legislature.js";

const ELECTION_DAY = "2026-11-03";
import { detectChanges } from "./diff.js";
import { sequential } from "./http.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "public", "data");
const HISTORY_DIR = join(DATA_DIR, "history");
const DRY_RUN = process.argv.includes("--dry-run");

export async function build() {
  const generatedAt = new Date();
  const asOf = chicagoDate(generatedAt);
  const previous = loadPreviousSnapshot(asOf);
  const sources = {};
  const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

  // ---- Fetch everything, tolerating individual source failures -------------------------------------------
  const [polymarketData, kalshiData, votehubPolls, wikiPages] = await Promise.all([
    guard("polymarket", sources, log, fetchPolymarket),
    guard("kalshi", sources, log, fetchKalshi),
    guard("votehub", sources, log, votehub.fetchAllPolls),
    guard("wikipedia", sources, log, fetchWikipedia),
  ]);

  // ---- U.S. Senate -----------------------------------------------------------------------------------------
  const senateTable = wikiPages?.senate ? wikipedia.parseSenateRatingsTable(wikiPages.senate.wikitext) : previous?.usSenate ?? { forecasters: [], races: {} };
  const forecasters = senateTable.forecasters?.length ? senateTable.forecasters : previous?.usSenate?.forecasters ?? [];
  const senateRaces = Object.entries(SENATE_STATES).map(([state, stateName]) => {
    const wikiRace = senateTable.races?.[stateName] ?? previous?.usSenate?.races?.find((r) => r.state === state);
    const previousRace = previous?.usSenate?.races?.find((r) => r.state === state);
    const ratings = wikiRace?.ratings ?? previousRace?.ratings ?? {};
    const consensus = ratingConsensus(ratings);
    const odds = {
      polymarket: polymarketData?.senate?.[state] ?? (sources.polymarket.ok ? null : previousRace?.odds?.polymarket ?? null),
      kalshi: kalshiData?.senate?.[state] ?? (sources.kalshi.ok ? null : previousRace?.odds?.kalshi ?? null),
    };
    const candidates = odds.polymarket?.candidates ?? odds.kalshi?.candidates ?? previousRace?.candidates ?? {};
    const rawPolls = votehubPolls && candidates.D && candidates.R
      ? votehub.pollsForRace(votehubPolls, { pollType: "us-senator", stateName, democrat: candidates.D, republican: candidates.R })
      : (sources.votehub.ok ? [] : previousRace?.polls ?? []);
    const polls = sortPolls(dedupePolls(rawPolls));
    const probabilities = raceProbabilities(odds, consensus?.label);
    const average = pollingAverage(polls, { asOf, ratePollster });
    return {
      id: `us-senate-${state}`, state, stateName,
      special: Boolean(wikiRace?.special), incumbentParty: wikiRace?.incumbentParty ?? null, incumbent: wikiRace?.incumbent ?? null, pvi: wikiRace?.pvi ?? null,
      candidates, ratings, consensus, odds, polls: polls.slice(0, 40),
      pollingAverage: average,
      pollModel: pollModelFor(average, consensus?.label, asOf, { hasIndependent: Boolean(candidates.I && !candidates.D) }),
      ...probabilities,
    };
  });

  // ---- Senate control & seat distribution ------------------------------------------------------------------
  const notUp = { democraticCaucusNotUp: SENATE_SEATS_NOT_UP.democraticCaucus, republicanNotUp: SENATE_SEATS_NOT_UP.republican };
  const derived = seatDistribution(senateRaces.map((r) => ({ pD: r.pD, pR: r.pR, pI: r.pI })), notUp);
  // Poll model: races with polls use the polling average; Nebraska-style independent races keep their market/prior split.
  const pollModel = seatDistribution(senateRaces.map((r) => (r.pollModel?.pD != null && !(r.pI > 0)
    ? { pD: r.pollModel.pD, pR: 1 - r.pollModel.pD, pI: 0 }
    : { pD: r.pD, pR: r.pR, pI: r.pI })), notUp);
  const kalshiSeats = kalshiData?.senateSeats ?? (sources.kalshi.ok ? null : previous?.senateControl?.kalshiSeats ?? null);
  const senateControl = {
    current: { democraticCaucus: 47, republican: 53, note: "Democratic caucus includes independents Sanders (VT) and King (ME), neither up in 2026." },
    notUp: SENATE_SEATS_NOT_UP,
    polymarket: polymarketData?.senateControl ?? (sources.polymarket.ok ? null : previous?.senateControl?.polymarket ?? null),
    usHousePolymarket: polymarketData?.houseControl ?? (sources.polymarket.ok ? null : previous?.senateControl?.usHousePolymarket ?? null),
    kalshiSeats,
    derived,
    pollModel,
    electionDay: ELECTION_DAY,
  };

  // ---- Texas statewide -------------------------------------------------------------------------------------
  const texasRaces = TEXAS_STATEWIDE_RACES.map((race) => {
    const previousRace = previous?.texas?.races?.find((r) => r.id === race.id);
    const page = wikiPages?.texas?.[race.id];
    const ratings = page ? wikipedia.parseRacePredictions(page.wikitext) : previousRace?.ratings ?? {};
    const polling = page ? wikipedia.parseRacePolling(page.wikitext, race) : { aggregates: previousRace?.aggregates ?? [], polls: [] };
    const votehubRacePolls = votehubPolls && race.votehubType
      ? votehub.pollsForRace(votehubPolls, { pollType: race.votehubType, stateName: "Texas", democrat: race.democrat, republican: race.republican })
      : [];
    const merged = page || votehubRacePolls.length ? [...votehubRacePolls, ...polling.polls] : previousRace?.polls ?? [];
    const polls = sortPolls(dedupePolls(merged));
    const odds = {
      polymarket: polymarketData?.texas?.[race.id] ?? (sources.polymarket.ok ? null : previousRace?.odds?.polymarket ?? null),
      kalshi: kalshiData?.texas?.[race.id] ?? (sources.kalshi.ok ? null : previousRace?.odds?.kalshi ?? null),
    };
    const consensus = ratingConsensus(ratings);
    const average = pollingAverage(polls, { asOf, ratePollster });
    return {
      id: race.id, office: race.office, democrat: race.democrat, republican: race.republican,
      wikipediaUrl: page?.url ?? previousRace?.wikipediaUrl ?? `https://en.wikipedia.org/wiki/${race.wikipedia}`,
      ratings, consensus, odds,
      polls: polls.slice(0, 40), pollingAverage: average, aggregates: polling.aggregates,
      pollModel: pollModelFor(average, consensus?.label, asOf, { allowPrior: false }),
      ...raceProbabilities(odds, consensus?.label, { allowPrior: false }),
    };
  });
  const texas = {
    races: texasRaces,
    statewideDemWins: kalshiData?.statewideDemWins ?? (sources.kalshi.ok ? null : previous?.texas?.statewideDemWins ?? null),
  };

  // ---- Texas Legislature -----------------------------------------------------------------------------------
  // Legislative generic ballot ("which party's candidate for the Texas House") lives on the House page.
  const genericBallotPolls = wikiPages?.txHouse
    ? sortPolls(dedupePolls(wikipedia.parseRacePolling(wikiPages.txHouse.wikitext, { democrat: "Democratic", republican: "Republican" }).polls))
    : previous?.txLegislature?.genericBallot?.polls ?? [];
  // The generic ballot is polled every few months, so it gets a slower decay and a wider window than candidate races.
  const genericBallotAverage = pollingAverage(genericBallotPolls, { asOf, ratePollster, windowDays: 120, halfLifeDays: 45 });
  const downBallotAverages = texasRaces.filter((r) => !["tx-senate", "tx-governor"].includes(r.id)).map((r) => r.pollingAverage);
  const environment = estimateEnvironment({ genericBallotAverage, downBallotAverages });
  const txLegislature = { genericBallot: { polls: genericBallotPolls.slice(0, 20), average: genericBallotAverage }, environment };
  const txHouse = buildChamber("house", wikiPages?.txHouse, previous?.txHouse, {
    control: kalshiData?.txHouseControl ?? (sources.kalshi.ok ? null : previous?.txHouse?.control?.kalshi ?? null),
    demSeats: kalshiData?.txHouseDemSeats ?? (sources.kalshi.ok ? null : previous?.txHouse?.demSeats ?? null),
    environment,
  });
  const txSenate = buildChamber("senate", wikiPages?.txSenate, previous?.txSenate, { environment });

  // ---- U.S. House -------------------------------------------------------------------------------------------
  const usHouse = buildUsHouse({ pages: wikiPages?.usHouse, previous: previous?.usHouse, votehubPolls, kalshiSeats: kalshiData?.usHouseSeats, polymarketControl: polymarketData?.houseControl, sources, asOf });

  const snapshot = {
    version: 1, generatedAt: generatedAt.toISOString(), asOf, sources,
    usSenate: { forecasters, races: senateRaces },
    senateControl, texas, txLegislature, txHouse, txSenate, usHouse,
  };
  snapshot.changes = detectChanges(previous, snapshot);
  snapshot.previousAsOf = previous?.asOf ?? null;

  if (DRY_RUN) {
    log(`dry run: ${snapshot.changes.length} changes; not writing`);
    return snapshot;
  }
  mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileSync(join(HISTORY_DIR, `${asOf}.json`), JSON.stringify(snapshot));
  writeFileSync(join(DATA_DIR, "latest.json"), JSON.stringify(snapshot));
  writeFileSync(join(DATA_DIR, "series.json"), JSON.stringify(buildSeries()));
  log(`wrote snapshot ${asOf} (${snapshot.changes.length} changes)`);
  return snapshot;
}

// ---- Source fetchers ----------------------------------------------------------------------------------------
async function fetchPolymarket() {
  const senate = {};
  await Promise.all(Object.entries(SENATE_MARKETS).map(async ([state, ids]) => {
    if (!ids.polymarket) return;
    try {
      const event = await polymarket.fetchEvent(ids.polymarket);
      senate[state] = withThinFlag(polymarket.partyProbabilities(event, ids.candidates || {}), event.volumeUsd, event.url);
    } catch (error) { console.warn(`  polymarket ${state}: ${error.message}`); }
  }));
  const texas = {};
  await Promise.all(TEXAS_STATEWIDE_RACES.map(async (race) => {
    if (!race.polymarket) return;
    try {
      const event = await polymarket.fetchEvent(race.polymarket);
      texas[race.id] = withThinFlag(polymarket.partyProbabilities(event), event.volumeUsd, event.url);
    } catch (error) { console.warn(`  polymarket ${race.id}: ${error.message}`); }
  }));
  const senateEvent = await polymarket.fetchEvent(CONTROL_MARKETS.usSenate.polymarket);
  const houseEvent = await polymarket.fetchEvent(CONTROL_MARKETS.usHouse.polymarket);
  return {
    senate, texas,
    senateControl: { ...polymarket.controlProbabilities(senateEvent), url: senateEvent.url },
    houseControl: { ...polymarket.controlProbabilities(houseEvent), url: houseEvent.url },
  };
}

async function fetchKalshi() {
  // Kalshi rate-limits bursts, so requests run one at a time.
  const senate = {};
  await sequential(Object.entries(SENATE_MARKETS).filter(([, ids]) => ids.kalshi), async ([state, ids]) => {
    try {
      const markets = await kalshi.fetchMarkets({ seriesTicker: ids.kalshi });
      const probabilities = kalshi.partyProbabilities(markets, { democrat: ids.candidates?.D, republican: ids.candidates?.R });
      if (probabilities.D !== null || probabilities.R !== null) senate[state] = kalshiWithFlags(probabilities, ids.kalshi);
    } catch (error) { console.warn(`  kalshi ${state}: ${error.message}`); }
  });
  const texas = {};
  await sequential(TEXAS_STATEWIDE_RACES.filter((race) => race.kalshi), async (race) => {
    try {
      const markets = await kalshi.fetchMarkets({ seriesTicker: race.kalshi });
      texas[race.id] = kalshiWithFlags(kalshi.partyProbabilities(markets, race), race.kalshi);
    } catch (error) { console.warn(`  kalshi ${race.id}: ${error.message}`); }
  });
  const seatMarkets = await kalshi.fetchMarkets({ eventTicker: CONTROL_MARKETS.usSenate.kalshiSeatsEvent });
  const buckets = kalshi.seatDistribution(seatMarkets);
  const controlD = buckets.filter((b) => bucketMinimumSeats(b.key) >= 51).reduce((sum, b) => sum + (b.normalized ?? 0), 0);
  const senateSeats = {
    event: CONTROL_MARKETS.usSenate.kalshiSeatsEvent, url: `https://kalshi.com/markets/${CONTROL_MARKETS.usSenate.kalshiSeatsEvent.split("-")[0].toLowerCase()}`,
    buckets, controlD: round3(controlD),
    volumeContracts: buckets.reduce((sum, b) => sum + b.volumeContracts, 0),
    note: "Kalshi counts independents with the party they caucus with, so these are Democratic-caucus seats.",
  };
  const txHouseMarkets = await kalshi.fetchMarkets({ seriesTicker: CONTROL_MARKETS.txHouse.kalshi });
  const txHouseControl = kalshiWithFlags(kalshi.partyProbabilities(txHouseMarkets, {}), CONTROL_MARKETS.txHouse.kalshi);
  const txHouseDemSeats = await fetchBuckets(CONTROL_MARKETS.txHouse.kalshiSeatsSeries);
  const statewideDemWins = await fetchBuckets(CONTROL_MARKETS.txStatewideDemWins.kalshiSeries);
  const usHouseSeats = await fetchBuckets(US_HOUSE.kalshiSeatsSeries);
  return { senate, texas, senateSeats, txHouseControl, txHouseDemSeats, statewideDemWins, usHouseSeats };
}

async function fetchBuckets(seriesTicker) {
  try {
    const markets = await kalshi.fetchMarkets({ seriesTicker });
    return markets
      .filter((m) => m.probability !== null)
      .map((m) => ({ ticker: m.ticker, label: m.outcome || m.title, probability: m.probability, yesBid: m.yesBid, yesAsk: m.yesAsk, volumeContracts: m.volumeContracts }))
      .sort((a, b) => numericIn(a.label) - numericIn(b.label));
  } catch (error) { console.warn(`  kalshi ${seriesTicker}: ${error.message}`); return null; }
}

async function fetchWikipedia() {
  const senate = await wikipedia.fetchWikitext(US_SENATE_WIKIPEDIA_PAGE);
  const texas = {};
  for (const race of TEXAS_STATEWIDE_RACES) {
    try { texas[race.id] = await wikipedia.fetchWikitext(race.wikipedia); } catch (error) { console.warn(`  wikipedia ${race.id}: ${error.message}`); }
  }
  const txHouse = await wikipedia.fetchWikitext(TEXAS_LEGISLATURE.house.wikipedia);
  const txSenate = await wikipedia.fetchWikitext(TEXAS_LEGISLATURE.senate.wikipedia);
  const usHouse = {};
  for (const [key, page] of [["national", US_HOUSE.wikipedia], ["ratings", US_HOUSE.ratingsPage], ["texas", US_HOUSE.texasPage]]) {
    try { usHouse[key] = await wikipedia.fetchWikitext(page); } catch (error) { console.warn(`  wikipedia us-house ${key}: ${error.message}`); }
  }
  return { senate, texas, txHouse, txSenate, usHouse };
}

// ---- Helpers ------------------------------------------------------------------------------------------------
async function guard(name, sources, log, fetcher) {
  const startedAt = Date.now();
  try {
    const result = await fetcher();
    sources[name] = { ok: true, fetchedAt: new Date().toISOString(), durationMs: Date.now() - startedAt };
    log(`${name}: ok (${Date.now() - startedAt} ms)`);
    return result;
  } catch (error) {
    sources[name] = { ok: false, error: error.message, fetchedAt: new Date().toISOString(), usedPrevious: true };
    log(`${name}: FAILED — ${error.message}; using previous snapshot values`);
    return null;
  }
}

function withThinFlag(probabilities, volumeUsd, url) {
  // A party with no market in a two- or three-way race has ~0 chance (e.g. Nebraska has no viable Democrat).
  const present = ["D", "R", "I"].filter((party) => probabilities[party] !== null);
  if (present.length >= 2) for (const party of ["D", "R"]) if (probabilities[party] === null) probabilities[party] = 0;
  const total = (probabilities.D ?? 0) + (probabilities.R ?? 0) + (probabilities.I ?? 0);
  return {
    ...probabilities,
    D: probabilities.D === null ? null : round3(probabilities.D / (total || 1)),
    R: probabilities.R === null ? null : round3(probabilities.R / (total || 1)),
    I: probabilities.I === null ? null : round3(probabilities.I / (total || 1)),
    volumeUsd: Math.round(volumeUsd), thin: volumeUsd < THIN_MARKET_VOLUME_USD, url,
  };
}

function kalshiWithFlags(probabilities, seriesTicker) {
  const total = (probabilities.D ?? 0) + (probabilities.R ?? 0);
  return {
    D: probabilities.D === null ? null : round3(probabilities.D / (total || 1)),
    R: probabilities.R === null ? null : round3(probabilities.R / (total || 1)),
    rawD: probabilities.D, rawR: probabilities.R,
    candidates: probabilities.candidates,
    volumeContracts: Math.round(probabilities.volumeContracts), spread: probabilities.spread,
    thin: probabilities.volumeContracts < THIN_MARKET_VOLUME_USD, // contracts are $1 each at settlement
    url: `https://kalshi.com/markets/${seriesTicker.toLowerCase()}`,
  };
}

/**
 * Poll-based win probability for a race. With no usable polls, fall back to the rating prior (flagged) or null.
 * Independent-vs-Republican races (no Democrat) are left to the market/prior path.
 */
function pollModelFor(average, consensusLabel, asOf, { allowPrior = true, hasIndependent = false } = {}) {
  const daysToElection = Math.max(0, Math.round((Date.parse(ELECTION_DAY) - Date.parse(asOf)) / 86_400_000));
  if (average && !hasIndependent) {
    const result = pollWinProbability(average, { daysToElection });
    return { ...result, source: "polls", qualityWeighted: average.qualityWeighted };
  }
  if (!allowPrior || hasIndependent) return null;
  const pD = priorFromRating(consensusLabel);
  return { pD, sigma: null, margin: null, effectiveN: 0, daysToElection, source: "rating prior" };
}

/** Win probabilities for a race: Polymarket first, then Kalshi, then a rating-based prior. */
function raceProbabilities(odds, consensusLabel, { allowPrior = true } = {}) {
  const pm = odds.polymarket;
  if (pm && pm.D !== null && pm.R !== null && !pm.thin) {
    return { pD: pm.D, pR: pm.R, pI: pm.I ?? 0, probabilitySource: "polymarket" };
  }
  const ks = odds.kalshi;
  if (ks && ks.D !== null && ks.R !== null) return { pD: ks.D, pR: ks.R, pI: 0, probabilitySource: "kalshi" };
  if (pm && pm.D !== null && pm.R !== null) return { pD: pm.D, pR: pm.R, pI: pm.I ?? 0, probabilitySource: "polymarket (thin)" };
  if (!allowPrior) return { pD: null, pR: null, pI: 0, probabilitySource: null };
  const pD = priorFromRating(consensusLabel);
  return { pD, pR: 1 - pD, pI: 0, probabilitySource: "rating prior" };
}

function buildChamber(kind, page, previousChamber, { control, demSeats, environment }) {
  const config = TEXAS_LEGISLATURE[kind];
  const parsed = page ? wikipedia.parseLegislativeChamber(page.wikitext) : null;
  const districts = parsed?.districts?.length ? parsed.districts : previousChamber?.districts ?? [];
  const ratingCounts = {};
  for (const district of districts) if (district.rating) ratingCounts[district.rating] = (ratingCounts[district.rating] || 0) + 1;
  // Expected post-election Democratic seats: seats not up or unrated keep their party; rated seats use the rating prior.
  const upForElection = districts.length;
  let expectedD = 0;
  for (const district of districts) {
    if (district.rating) expectedD += priorFromRating(district.rating);
    else expectedD += district.party === "D" ? 1 : 0;
  }
  const notUpD = kind === "senate" ? config.current.D - districts.filter((d) => d.party === "D").length : 0;
  const notUpR = kind === "senate" ? config.current.R - districts.filter((d) => d.party === "R").length : 0;
  const model = runChamberModel({ districts, notUp: { D: Math.max(0, notUpD), R: Math.max(0, notUpR) }, majority: config.majority, environment });
  const modelBySeat = new Map((model?.seats || []).map((seat) => [seat.district, seat]));
  for (const district of districts) {
    const seat = modelBySeat.get(district.district);
    district.modelD = seat?.pD ?? null;
    district.modelBaseline = seat?.baseline ?? null;
  }
  return {
    seats: config.seats, majority: config.majority, current: config.current, upForElection,
    wikipediaUrl: page?.url ?? previousChamber?.wikipediaUrl ?? `https://en.wikipedia.org/wiki/${config.wikipedia}`,
    ratingSource: parsed?.ratingSource ?? previousChamber?.ratingSource ?? null,
    chamberPredictions: parsed?.chamberPredictions ?? previousChamber?.chamberPredictions ?? {},
    districts,
    summary: { ratingCounts, expectedD: Math.round((expectedD + Math.max(0, notUpD)) * 10) / 10, competitive: districts.filter((d) => d.rating && ratingScore(d.rating) !== null && Math.abs(ratingScore(d.rating)) <= 2).length },
    control: control ? { kalshi: control } : previousChamber?.control ?? null,
    demSeats: demSeats ?? null,
    model: model ? { environment: model.environment, params: model.params, histogram: model.histogram, control: model.control, expected: model.expected, majority: model.majority, totalSeats: model.totalSeats, notUp: model.notUp } : null,
  };
}

/**
 * U.S. House: national ratings table (144 competitive seats), the Texas congressional page (ratings for all 38
 * districts plus district polls), the generic ballot (VoteHub + Wikipedia aggregates), markets, and our model.
 */
function buildUsHouse({ pages, previous, votehubPolls, kalshiSeats, polymarketControl, sources, asOf }) {
  const ratingsTable = pages?.ratings ? wikipedia.parseHouseRatingsTable(pages.ratings.wikitext) : null;
  const forecasters = ratingsTable?.forecasters ?? previous?.forecasters ?? [];
  const national = pages?.national ? wikipedia.parseHouseNationalPage(pages.national.wikitext) : null;
  const composition = national?.composition ?? previous?.composition ?? US_HOUSE.compositionFallback;
  const texasPage = pages?.texas ? wikipedia.parseTexasCongressPage(pages.texas.wikitext) : null;

  // Generic ballot: VoteHub national polls (Dem/Rep answers) plus Wikipedia aggregator averages.
  const genericPolls = votehubPolls
    ? sortPolls(dedupePolls(votehubPolls.filter((p) => p.poll_type === "generic-ballot" && String(p.subject) === "2026").map((poll) => {
        const dem = (poll.answers || []).find((a) => /^dem/i.test(a.choice)); const rep = (poll.answers || []).find((a) => /^rep/i.test(a.choice));
        return dem && rep ? { source: "votehub", id: `votehub:${poll.id}`, pollster: poll.pollster, sponsors: poll.sponsors || [], startDate: poll.start_date, endDate: poll.end_date, sampleSize: poll.sample_size ?? null, population: (poll.population || "").toUpperCase() || null, partisan: poll.partisan || null, internal: Boolean(poll.internal), dem: dem.pct, rep: rep.pct, url: poll.url || null } : null;
      }).filter(Boolean)))
    : previous?.genericBallot?.polls ?? [];
  const genericAverage = pollingAverage(genericPolls, { asOf, ratePollster });

  // Rated districts: national table first; Texas districts also get the Texas page's per-district ratings and polls.
  const rated = (ratingsTable?.districts ?? previous?.districts?.filter((d) => d.nationallyRated) ?? []).map((d) => ({ ...d, nationallyRated: true }));
  const byId = new Map(rated.map((d) => [d.id, d]));
  for (const tx of texasPage?.districts ?? []) {
    const id = `TX-${tx.district}`;
    const ratings = Object.fromEntries(Object.entries(tx.ratings).map(([k, v]) => [k, v.label]));
    const existing = byId.get(id);
    const polls = sortPolls(dedupePolls(tx.polls));
    const average = pollingAverage(polls, { asOf, ratePollster, minPolls: 1 });
    if (existing) { existing.texasRatings = tx.ratings; existing.polls = polls.slice(0, 20); existing.pollingAverage = average; }
    else {
      // Not on the national competitive list: the holding party is inferred from the (safe) consensus rating.
      const side = Object.values(ratings).some((l) => /D$/.test(l)) && !Object.values(ratings).some((l) => /R$/.test(l)) ? "D" : Object.values(ratings).some((l) => /R$/.test(l)) ? "R" : null;
      byId.set(id, { id, state: "TX", district: tx.district, incumbentParty: side, heldInferred: true, incumbent: null, pvi: null, open: false, flip: false, ratings, texasRatings: tx.ratings, polls: polls.slice(0, 20), pollingAverage: average, nationallyRated: false });
    }
  }
  const districts = [...byId.values()].map((d) => {
    const consensus = ratingConsensus(d.ratings);
    const impliedMargin = ratingImpliedMargin(consensus?.label);
    // District polls (Texas only, so far) are blended half-and-half with the rating-implied margin when at least two exist.
    const pollMargin = d.pollingAverage && d.pollingAverage.pollCount >= 2 ? d.pollingAverage.margin : null;
    const margin = impliedMargin === null ? null : pollMargin === null ? impliedMargin : Math.round((0.5 * impliedMargin + 0.5 * pollMargin) * 10) / 10;
    return { ...d, consensus, impliedMargin, pollMargin, margin };
  });
  // Seats outside the modeled set keep their party. Modeled open seats and the vacancies overlap in the
  // composition counts, so the fixed pool is trimmed proportionally to make the chamber total exactly 435.
  const modeledD = districts.filter((d) => d.incumbentParty === "D").length;
  const modeledR = districts.filter((d) => d.incumbentParty === "R").length;
  let fixedD = Math.max(0, composition.D - modeledD);
  let fixedR = Math.max(0, composition.R - modeledR);
  const excess = fixedD + fixedR + districts.length - US_HOUSE.seats;
  if (excess > 0) { const trimD = Math.round(excess * fixedD / (fixedD + fixedR)); fixedD -= trimD; fixedR -= excess - trimD; }
  const notUp = { D: fixedD, R: fixedR };
  const model = runRatedChamberModel({ seats: districts.map((d) => ({ id: d.id, margin: d.margin, party: d.incumbentParty })), notUp, majority: US_HOUSE.majority });
  const modelById = new Map(model.seats.map((seat) => [seat.id, seat]));
  for (const d of districts) d.modelD = modelById.get(d.id)?.pD ?? null;

  // Kalshi "at least N seats" ladder -> P(D ≥ 218) and an implied distribution over the ladder steps.
  let kalshi = null;
  if (kalshiSeats?.length) {
    const ladder = kalshiSeats.map((b) => ({ atLeast: Number((b.label.match(/\d+/) || [])[0]), probability: b.probability, volumeContracts: b.volumeContracts })).filter((b) => Number.isFinite(b.atLeast)).sort((a, b) => a.atLeast - b.atLeast);
    const majorityStep = ladder.find((b) => b.atLeast === US_HOUSE.majority) || ladder.filter((b) => b.atLeast <= US_HOUSE.majority).pop();
    kalshi = { ladder, controlD: majorityStep ? round3(majorityStep.probability) : null, volumeContracts: Math.round(ladder.reduce((s, b) => s + b.volumeContracts, 0)), url: `https://kalshi.com/markets/${US_HOUSE.kalshiSeatsSeries.toLowerCase()}` };
  } else if (!sources.kalshi.ok) kalshi = previous?.markets?.kalshi ?? null;

  return {
    seats: US_HOUSE.seats, majority: US_HOUSE.majority, composition,
    forecasters,
    districts: districts.sort((a, b) => Math.abs((a.modelD ?? 0.5) - 0.5) - Math.abs((b.modelD ?? 0.5) - 0.5)),
    genericBallot: { polls: genericPolls.slice(0, 30), average: genericAverage, aggregates: national?.aggregates ?? previous?.genericBallot?.aggregates ?? [] },
    texasStatewidePolls: texasPage ? sortPolls(dedupePolls(texasPage.statewidePolls)).slice(0, 12) : previous?.texasStatewidePolls ?? [],
    model: { ...model, seats: undefined, notUp, ratedCount: districts.length },
    markets: { polymarket: polymarketControl ?? (sources.polymarket.ok ? null : previous?.markets?.polymarket ?? null), kalshi },
    pages: { national: pages?.national?.url ?? previous?.pages?.national ?? null, ratings: pages?.ratings?.url ?? previous?.pages?.ratings ?? null, texas: pages?.texas?.url ?? previous?.pages?.texas ?? null },
  };
}

function loadPreviousSnapshot(asOf) {
  if (!existsSync(HISTORY_DIR)) return null;
  const files = readdirSync(HISTORY_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < asOf).sort();
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(HISTORY_DIR, files[files.length - 1]), "utf8"));
}

/** Compact per-day time series for sparklines, rebuilt from every history file. */
function buildSeries() {
  const files = readdirSync(HISTORY_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.map((file) => {
    const s = JSON.parse(readFileSync(join(HISTORY_DIR, file), "utf8"));
    const races = {};
    for (const race of [...s.usSenate.races, ...s.texas.races]) {
      races[race.id] = { pm: race.odds?.polymarket?.D ?? null, ks: race.odds?.kalshi?.D ?? null, poll: race.pollingAverage?.margin ?? null, pollModel: race.pollModel?.pD ?? null, rating: race.consensus?.score ?? null };
    }
    return {
      date: s.asOf,
      control: { polymarket: s.senateControl?.polymarket?.D ?? null, kalshi: s.senateControl?.kalshiSeats?.controlD ?? null, derived: s.senateControl?.derived?.control?.D ?? null, pollModel: s.senateControl?.pollModel?.control?.D ?? null },
      expectedD: s.senateControl?.derived?.expected?.D ?? null,
      pollModelExpectedD: s.senateControl?.pollModel?.expected?.D ?? null,
      txHouseExpectedD: s.txHouse?.summary?.expectedD ?? null,
      txHouseModel: { control: s.txHouse?.model?.control?.D ?? null, expectedD: s.txHouse?.model?.expected?.D ?? null },
      txSenateModel: { control: s.txSenate?.model?.control?.D ?? null, expectedD: s.txSenate?.model?.expected?.D ?? null },
      txEnvironment: s.txLegislature?.environment?.margin ?? null,
      usHouse: { control: s.usHouse?.model?.control?.D ?? null, expectedD: s.usHouse?.model?.expected?.D ?? null, generic: s.usHouse?.genericBallot?.average?.margin ?? null, polymarket: s.usHouse?.markets?.polymarket?.D ?? null },
      races,
    };
  });
}

function sortPolls(polls) { return [...polls].sort((a, b) => ((b.endDate || "") > (a.endDate || "") ? 1 : -1)); }
function bucketMinimumSeats(key) { return key.startsWith("<") ? 0 : key.startsWith(">") ? Number(key.slice(1)) + 1 : Number(key); }
function numericIn(text) { const m = String(text).match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : 0; }
function round3(value) { return value === null || value === undefined ? null : Math.round(value * 1000) / 1000; }
function chicagoDate(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  build().catch((error) => { console.error(error); process.exit(1); });
}
