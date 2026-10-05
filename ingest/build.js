// Orchestrates one daily snapshot: fetch every source, derive metrics, diff against the previous day, write public/data.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SENATE_SEATS_NOT_UP, SENATE_STATES, TEXAS_LEGISLATURE, TEXAS_STATEWIDE_RACES,
  US_HOUSE, US_SENATE_WIKIPEDIA_PAGE, GOVERNOR_STATES, GOVERNORS_WIKIPEDIA_PAGE, TEXAS_COURTS,
} from "./config.js";
import * as votehub from "./sources/votehub.js";
import * as wikipedia from "./sources/wikipedia.js";
import { dedupePolls, pollWinProbability, pollingAverage, priorFromRating, ratingConsensus, ratingScore, seatDistribution } from "./metrics.js";
import { ratePollster } from "./pollsters.js";
import { estimateEnvironment, ratingImpliedMargin, runChamberModel, runRatedChamberModel } from "./legislature.js";
import { buildDigest } from "./digest.js";
import { buildPollsterReport } from "./pollsters-report.js";

const ELECTION_DAY = "2026-11-03";
import { detectChanges } from "./diff.js";

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
  const [votehubPolls, wikiPages] = await Promise.all([
    guard("votehub", sources, log, votehub.fetchAllPolls),
    guard("wikipedia", sources, log, fetchWikipedia),
  ]);

  // ---- U.S. Senate -----------------------------------------------------------------------------------------
  const senateTable = wikiPages?.senate ? wikipedia.parseSenateRatingsTable(wikiPages.senate.wikitext) : previous?.usSenate ?? { forecasters: [], races: {} };
  const forecasters = senateTable.forecasters?.length ? senateTable.forecasters : previous?.usSenate?.forecasters ?? [];
  const senateCandidates = wikiPages?.senate ? wikipedia.parseRaceSummaryCandidates(wikiPages.senate.wikitext, /^\s*\[\[2026 United States Senate (?:special )?election in/) : {};
  const senateRaces = Object.entries(SENATE_STATES).map(([state, stateName]) => {
    const wikiRace = senateTable.races?.[stateName] ?? previous?.usSenate?.races?.find((r) => r.state === state);
    const previousRace = previous?.usSenate?.races?.find((r) => r.state === state);
    const ratings = wikiRace?.ratings ?? previousRace?.ratings ?? {};
    const consensus = ratingConsensus(ratings);
    const summary = senateCandidates[stateName];
    const candidates = summary ? { D: summary.D, R: summary.R, I: summary.I } : previousRace?.candidates ?? {};
    // Races with no major Democrat (Nebraska's independent) are polled as independent vs Republican.
    const democraticSide = candidates.D || candidates.I;
    const rawPolls = votehubPolls && democraticSide && candidates.R
      ? votehub.pollsForRace(votehubPolls, { pollType: "us-senator", stateName, democrat: democraticSide, republican: candidates.R })
      : (sources.votehub.ok ? [] : previousRace?.polls ?? []);
    const polls = sortPolls(dedupePolls(rawPolls));
    const average = pollingAverage(polls, { asOf, ratePollster });
    const independentRace = Boolean(!candidates.D && candidates.I);
    const pollModel = pollModelFor(average, consensus?.label, asOf);
    const probabilities = independentRace
      ? { pD: 0, pR: 1 - (pollModel?.pD ?? 0.5), pI: pollModel?.pD ?? 0.5, probabilitySource: pollModel?.source ?? "rating prior" }
      : { pD: pollModel?.pD ?? 0.5, pR: 1 - (pollModel?.pD ?? 0.5), pI: 0, probabilitySource: pollModel?.source ?? "rating prior" };
    return {
      id: `us-senate-${state}`, state, stateName,
      special: Boolean(wikiRace?.special), incumbentParty: wikiRace?.incumbentParty ?? null, incumbent: wikiRace?.incumbent ?? null, pvi: wikiRace?.pvi ?? null,
      candidates, otherCandidates: summary?.others ?? [], independentRace, ratings, consensus, polls: polls.slice(0, 40),
      pollingAverage: average, pollModel,
      ...probabilities,
    };
  });

  // ---- Senate control & seat distribution ------------------------------------------------------------------
  const notUp = { democraticCaucusNotUp: SENATE_SEATS_NOT_UP.democraticCaucus, republicanNotUp: SENATE_SEATS_NOT_UP.republican };
  const pollModel = seatDistribution(senateRaces.map((r) => ({ pD: r.pD, pR: r.pR, pI: r.pI })), notUp);
  const senateControl = {
    current: { democraticCaucus: 47, republican: 53, note: "Democratic caucus includes independents Sanders (VT) and King (ME), neither up in 2026." },
    notUp: SENATE_SEATS_NOT_UP,
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
    const consensus = ratingConsensus(ratings);
    const average = pollingAverage(polls, { asOf, ratePollster });
    const pollModel = pollModelFor(average, consensus?.label, asOf, { allowPrior: false });
    return {
      id: race.id, office: race.office, democrat: race.democrat, republican: race.republican,
      wikipediaUrl: page?.url ?? previousRace?.wikipediaUrl ?? `https://en.wikipedia.org/wiki/${race.wikipedia}`,
      ratings, consensus,
      polls: polls.slice(0, 40), pollingAverage: average, aggregates: polling.aggregates,
      pollModel, pD: pollModel?.pD ?? null, pR: pollModel ? 1 - pollModel.pD : null, pI: 0, probabilitySource: pollModel?.source ?? null,
    };
  });
  const texas = { races: texasRaces };

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
  const txHouse = buildChamber("house", wikiPages?.txHouse, previous?.txHouse, { environment });
  const txSenate = buildChamber("senate", wikiPages?.txSenate, previous?.txSenate, { environment });

  // ---- Governors --------------------------------------------------------------------------------------------
  const governors = buildGovernors({ page: wikiPages?.governors, previous: previous?.governors, votehubPolls, sources, asOf, texasGovernor: texasRaces.find((r) => r.id === "tx-governor") });

  // ---- Texas courts and SBOE --------------------------------------------------------------------------------
  const txCourts = buildTexasCourts({ pages: wikiPages?.courts, previous: previous?.txCourts, environment });

  // ---- U.S. House -------------------------------------------------------------------------------------------
  const usHouse = buildUsHouse({ pages: wikiPages?.usHouse, previous: previous?.usHouse, votehubPolls, sources, asOf });

  const snapshot = {
    version: 1, generatedAt: generatedAt.toISOString(), asOf, sources,
    usSenate: { forecasters, races: senateRaces },
    senateControl, texas, txLegislature, txHouse, txSenate, usHouse, governors, txCourts,
  };
  snapshot.changes = detectChanges(previous, snapshot);
  snapshot.previousAsOf = previous?.asOf ?? null;
  snapshot.digest = buildDigest(snapshot);
  snapshot.pollsters = buildPollsterReport(snapshot);

  if (DRY_RUN) {
    log(`dry run: ${snapshot.changes.length} changes; not writing`);
    return snapshot;
  }
  mkdirSync(HISTORY_DIR, { recursive: true });
  // The Scenarios tab runs the same model code in the browser; publish the pure modules verbatim.
  mkdirSync(join(ROOT, "public", "model"), { recursive: true });
  for (const file of ["config.js", "metrics.js", "legislature.js"]) copyFileSync(join(ROOT, "ingest", file), join(ROOT, "public", "model", file));
  writeFileSync(join(HISTORY_DIR, `${asOf}.json`), JSON.stringify(snapshot));
  writeFileSync(join(DATA_DIR, "latest.json"), JSON.stringify(snapshot));
  writeFileSync(join(DATA_DIR, "series.json"), JSON.stringify(buildSeries()));
  writeFileSync(join(DATA_DIR, "changelog.json"), JSON.stringify(buildChangelog()));
  writeFileSync(join(DATA_DIR, "digest.txt"), snapshot.digest.text);
  log(`wrote snapshot ${asOf} (${snapshot.changes.length} changes)`);
  return snapshot;
}

// ---- Source fetchers ----------------------------------------------------------------------------------------
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
  let governors = null;
  try { governors = await wikipedia.fetchWikitext(GOVERNORS_WIKIPEDIA_PAGE); } catch (error) { console.warn(`  wikipedia governors: ${error.message}`); }
  const courts = {};
  for (const [key, page] of [["supreme", TEXAS_COURTS.supremeCourtPage], ["sboe", TEXAS_COURTS.sboePage], ["elections", TEXAS_COURTS.electionsPage]]) {
    try { courts[key] = await wikipedia.fetchWikitext(page); } catch (error) { console.warn(`  wikipedia courts ${key}: ${error.message}`); }
  }
  return { senate, texas, txHouse, txSenate, usHouse, governors, courts };
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

/**
 * Poll-based win probability for a race. With no usable polls, fall back to the rating prior (flagged) or null.
 */
function pollModelFor(average, consensusLabel, asOf, { allowPrior = true } = {}) {
  const daysToElection = Math.max(0, Math.round((Date.parse(ELECTION_DAY) - Date.parse(asOf)) / 86_400_000));
  if (average) {
    const result = pollWinProbability(average, { daysToElection });
    return { ...result, source: "polls", qualityWeighted: average.qualityWeighted };
  }
  if (!allowPrior) return null;
  const pD = priorFromRating(consensusLabel);
  return { pD, sigma: null, margin: null, effectiveN: 0, daysToElection, source: "rating prior" };
}

function buildChamber(kind, page, previousChamber, { environment }) {
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
    model: model ? { environment: model.environment, params: model.params, histogram: model.histogram, control: model.control, expected: model.expected, majority: model.majority, totalSeats: model.totalSeats, notUp: model.notUp } : null,
  };
}

/**
 * Texas Supreme Court, Court of Criminal Appeals, and State Board of Education: nominees from Wikipedia and a baseline
 * probability from the statewide environment (these races track the generic down-ballot vote).
 */
function buildTexasCourts({ pages, previous, environment }) {
  const supreme = pages?.supreme ? wikipedia.parseInfoboxRaces(pages.supreme.wikitext).map((r) => ({ ...r, body: "Texas Supreme Court" })) : previous?.races?.filter((r) => r.body === "Texas Supreme Court") ?? [];
  const cca = pages?.elections ? wikipedia.parseCriminalAppeals(pages.elections.wikitext).map((r) => ({ ...r, body: "Court of Criminal Appeals" })) : previous?.races?.filter((r) => r.body === "Court of Criminal Appeals") ?? [];
  const sboe = pages?.sboe ? wikipedia.parseInfoboxRaces(pages.sboe.wikitext).map((r) => ({ ...r, body: "State Board of Education" })) : previous?.races?.filter((r) => r.body === "State Board of Education") ?? [];
  // Statewide judicial races run close to the generic down-ballot environment; SBOE districts are not modeled (no district data).
  const statewideModel = environment ? pollWinProbability({ margin: environment.margin, effectiveN: 4 }, { daysToElection: Math.max(0, Math.round((Date.parse(ELECTION_DAY) - Date.now()) / 86_400_000)), finalError: 6 }) : null;
  const races = [...supreme, ...cca, ...sboe].map((r) => ({
    id: `${r.body}-${r.race}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"), body: r.body, race: r.race, nominees: r.nominees, incumbent: r.incumbent, incumbentParty: r.incumbentParty,
    ratings: r.ratings, pollModel: r.body === "State Board of Education" ? null : statewideModel ? { pD: statewideModel.pD, source: "statewide environment" } : null,
  }));
  return { races, environment: environment?.margin ?? null, pages: { supreme: pages?.supreme?.url ?? previous?.pages?.supreme ?? null, sboe: pages?.sboe?.url ?? previous?.pages?.sboe ?? null, elections: pages?.elections?.url ?? previous?.pages?.elections ?? null } };
}

/** Governors: ratings table and candidates from the national page, VoteHub polls, polls model. */
function buildGovernors({ page, previous, votehubPolls, sources, asOf, texasGovernor }) {
  const table = page ? wikipedia.parseGovernorRatingsTable(page.wikitext) : null;
  const forecasters = table?.forecasters ?? previous?.forecasters ?? [];
  const summary = page ? wikipedia.parseRaceSummaryCandidates(page.wikitext, /^\s*\[\[2026 [A-Za-z ]+ gubernatorial election/) : {};
  const races = Object.entries(GOVERNOR_STATES).map(([state, stateName]) => {
    const wikiRace = table?.races?.[stateName];
    const previousRace = previous?.races?.find((r) => r.state === state);
    const ratings = wikiRace?.ratings ?? previousRace?.ratings ?? {};
    const consensus = ratingConsensus(ratings);
    const candidates = summary[stateName] ? { D: summary[stateName].D, R: summary[stateName].R, I: summary[stateName].I } : previousRace?.candidates ?? {};
    const rawPolls = votehubPolls && candidates.D && candidates.R
      ? votehub.pollsForRace(votehubPolls, { pollType: "governor", stateName, democrat: candidates.D, republican: candidates.R })
      : (sources.votehub.ok ? [] : previousRace?.polls ?? []);
    const polls = sortPolls(dedupePolls(state === "TX" && texasGovernor ? texasGovernor.polls : rawPolls));
    const average = state === "TX" && texasGovernor ? texasGovernor.pollingAverage : pollingAverage(polls, { asOf, ratePollster });
    const pollModel = pollModelFor(average, consensus?.label, asOf);
    return { id: `governor-${state}`, state, stateName, incumbentParty: wikiRace?.incumbentParty ?? previousRace?.incumbentParty ?? null, incumbent: wikiRace?.incumbent ?? previousRace?.incumbent ?? null, pvi: wikiRace?.pvi ?? null, candidates, ratings, consensus, polls: polls.slice(0, 30), pollingAverage: average, pollModel, pD: pollModel?.pD ?? null, probabilitySource: pollModel?.source ?? null };
  });
  return { forecasters, races, pageUrl: page?.url ?? previous?.pageUrl ?? `https://en.wikipedia.org/wiki/${GOVERNORS_WIKIPEDIA_PAGE}` };
}

/**
 * U.S. House: national ratings table (144 competitive seats), the Texas congressional page (ratings for all 38
 * districts plus district polls), the generic ballot (VoteHub + Wikipedia aggregates), markets, and our model.
 */
function buildUsHouse({ pages, previous, votehubPolls, sources, asOf }) {
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

  return {
    seats: US_HOUSE.seats, majority: US_HOUSE.majority, composition,
    forecasters,
    districts: districts.sort((a, b) => Math.abs((a.modelD ?? 0.5) - 0.5) - Math.abs((b.modelD ?? 0.5) - 0.5)),
    genericBallot: { polls: genericPolls.slice(0, 30), average: genericAverage, aggregates: national?.aggregates ?? previous?.genericBallot?.aggregates ?? [] },
    texasStatewidePolls: texasPage ? sortPolls(dedupePolls(texasPage.statewidePolls)).slice(0, 12) : previous?.texasStatewidePolls ?? [],
    model: { ...model, seats: undefined, notUp, ratedCount: districts.length },
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
    for (const race of [...s.usSenate.races, ...s.texas.races, ...(s.governors?.races || [])]) {
      races[race.id] = { poll: race.pollingAverage?.margin ?? null, pollModel: race.pollModel?.pD ?? null, rating: race.consensus?.score ?? null };
    }
    return {
      date: s.asOf,
      control: { pollModel: s.senateControl?.pollModel?.control?.D ?? null },
      pollModelExpectedD: s.senateControl?.pollModel?.expected?.D ?? null,
      txHouseExpectedD: s.txHouse?.summary?.expectedD ?? null,
      txHouseModel: { control: s.txHouse?.model?.control?.D ?? null, expectedD: s.txHouse?.model?.expected?.D ?? null },
      txSenateModel: { control: s.txSenate?.model?.control?.D ?? null, expectedD: s.txSenate?.model?.expected?.D ?? null },
      txEnvironment: s.txLegislature?.environment?.margin ?? null,
      usHouse: { control: s.usHouse?.model?.control?.D ?? null, expectedD: s.usHouse?.model?.expected?.D ?? null, generic: s.usHouse?.genericBallot?.average?.margin ?? null },
      races,
    };
  });
}

/** Every day's digest headline and change list, oldest first, for the Trends and Digest archive views. */
function buildChangelog() {
  const files = readdirSync(HISTORY_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.map((file) => {
    const s = JSON.parse(readFileSync(join(HISTORY_DIR, file), "utf8"));
    return { date: s.asOf, headline: s.digest?.headline ?? null, changes: (s.changes || []).filter((c) => c.type !== "baseline").map((c) => ({ type: c.type, text: c.text, raceId: c.raceId ?? null })) };
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
