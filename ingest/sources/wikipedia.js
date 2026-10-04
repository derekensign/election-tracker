// Wikipedia (CC BY-SA 4.0) via the MediaWiki API: forecaster rating tables, poll tables, and legislative district tables.
import { fetchJson } from "../http.js";
import {
  extractTables, findSection, parseDateRange, parsePartyShading, parsePercent, parsePviMargin,
  parseRaceRating, parseTable, plainText, stripRefs,
} from "../wikitext.js";

const API = "https://en.wikipedia.org/w/api.php";

export async function fetchWikitext(pageTitle) {
  const data = await fetchJson(`${API}?action=parse&page=${encodeURIComponent(pageTitle)}&prop=wikitext|revid&format=json&formatversion=2`);
  if (!data?.parse?.wikitext) throw new Error(`No wikitext for ${pageTitle}`);
  return { title: data.parse.title, revisionId: data.parse.revid, wikitext: data.parse.wikitext, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitle)}` };
}

/**
 * National Senate page, "Predictions" table: one row per seat, one column per forecaster.
 * Returns { forecasters: [{ key, name, asOf }], races: { "Texas": { incumbentParty, pvi, ratings: { Cook: "Tossup", ... }, special } } }
 */
export function parseSenateRatingsTable(wikitext, { rowPattern = /^\s*\[\[2026 United States Senate (?:special )?election in/, pageLabel = "Senate page" } = {}) {
  const section = findSection(wikitext, /^Predictions$/i, { last: false });
  if (!section) throw new Error(`${pageLabel}: Predictions section not found`);
  const table = extractTables(section.body)[0];
  const rows = parseTable(table);
  // Header: two rows; the second lists State, PVI, Senator, Last election, then forecasters.
  const headerRow = rows.find((row) => row.length >= 8 && row.every((cell) => cell.header) && /State/i.test(row[0].text));
  if (!headerRow) throw new Error(`${pageLabel}: header row not found`);
  const forecasters = headerRow.slice(4).map((cell) => parseForecasterHeader(cell.text));
  const races = {};
  for (const row of rows) {
    if (row.some((cell) => cell.header && rowPattern.test(cell.text))) {
      const stateCell = row[0].text;
      const stateName = plainText(stateCell).replace(/\s*\(special\)\s*/i, "").trim();
      const special = /special/i.test(stateCell);
      const incumbentParty = parsePartyShading(cellMarkup(row[2])) || parsePartyShading(cellMarkup(row[3]));
      const pviMatch = (row[1]?.text || "").match(/Shading PVI\s*\|\s*([DR])\s*\|\s*([\d.]+)/i);
      const pvi = pviMatch ? `${pviMatch[1].toUpperCase()}+${pviMatch[2]}` : (/EVEN/i.test(row[1]?.text || "") ? "EVEN" : null);
      const incumbent = plainText(row[2]?.text || "");
      const ratings = {};
      row.slice(4).forEach((cell, index) => {
        const rating = parseRaceRating(cell.text);
        if (rating && forecasters[index]) ratings[forecasters[index].key] = rating.label;
      });
      races[stateName] = { special, incumbentParty, incumbent, pvi, ratings };
    }
  }
  return { forecasters, races };
}

function parseForecasterHeader(text) {
  const cleaned = stripRefs(text);
  const nameMatch = cleaned.match(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/);
  const name = nameMatch ? nameMatch[1].trim() : plainText(cleaned).split(" ")[0];
  const dateMatch = plainText(cleaned).match(/([A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s*\d{4})/);
  const key = canonicalForecaster(name);
  return { key, name: FORECASTER_NAMES[key] || name, asOf: dateMatch ? normalizeDate(dateMatch[1]) : null };
}

const FORECASTER_NAMES = {
  cook: "Cook Political Report", ddhq: "Decision Desk HQ", economist: "The Economist", fpo: "FiftyPlusOne",
  fox: "Fox News", ie: "Inside Elections", rcp: "RealClearPolitics", sabato: "Sabato's Crystal Ball",
  silver: "Silver Bulletin", st: "Split Ticket", cbs: "CBS News", statenavigate: "State Navigate",
};

export function canonicalForecaster(name) {
  const n = name.toLowerCase();
  if (/cook/.test(n)) return "cook";
  if (/ddhq|decision desk/.test(n)) return "ddhq";
  if (/econ/.test(n)) return "economist";
  if (/fpo|fiftyplusone/.test(n)) return "fpo";
  if (/fox/.test(n)) return "fox";
  if (/^ie$|inside elections/.test(n)) return "ie";
  if (/rcp|realclear/.test(n)) return "rcp";
  if (/sabato/.test(n)) return "sabato";
  if (/silver/.test(n)) return "silver";
  if (/^st$|split ticket/.test(n)) return "st";
  if (/cbs/.test(n)) return "cbs";
  if (/state navigate/.test(n)) return "statenavigate";
  return n.replace(/[^a-z0-9]+/g, "");
}

function normalizeDate(text) {
  const parsed = parseDateRange(text);
  return parsed ? parsed.end : null;
}

/** National governors page: same table shape as the Senate page, rows link to "2026 <State> gubernatorial election". */
export function parseGovernorRatingsTable(wikitext) {
  return parseSenateRatingsTable(wikitext, { rowPattern: /^\s*\[\[2026 [A-Za-z ]+ gubernatorial election/, pageLabel: "Governors page" });
}

/**
 * "2026 United States House of Representatives election ratings": one row per competitive district.
 * Returns { forecasters, districts: [{ id: "TX-15", state, district, incumbentParty, incumbent, pvi, ratings }] }.
 */
export function parseHouseRatingsTable(wikitext) {
  const section = findSection(wikitext, /Latest published ratings/i, { last: false }) || findSection(wikitext, /^Election ratings$/i, { last: false });
  if (!section) throw new Error("House ratings page: ratings section not found");
  const rows = parseTable(extractTables(section.body)[0]);
  const headerRow = rows.find((row) => row.length >= 10 && row.every((c) => c.header) && /District/i.test(row[0].text));
  if (!headerRow) throw new Error("House ratings page: header row not found");
  const forecasters = headerRow.slice(4).map((cell) => parseForecasterHeader(cell.text));
  const districts = [];
  for (const row of rows) {
    const match = (row[0]?.text || "").match(/\{\{\s*[Uu]shr\s*\|\s*([A-Z]{2})\s*\|\s*(\d+|AL)/);
    if (!match) continue;
    const ratings = {};
    row.slice(4).forEach((cell, index) => { const rating = parseRaceRating(cell.text); if (rating && forecasters[index]) ratings[forecasters[index].key] = rating.label; });
    const flip = row.slice(4).some((cell) => /flip/i.test(cell.text));
    const incumbentParty = parsePartyShading(cellMarkup(row[2])) || parsePartyShading(cellMarkup(row[3]));
    const pviText = plainText(row[1]?.text || "");
    districts.push({
      id: `${match[1]}-${match[2]}`, state: match[1], district: match[2] === "AL" ? "AL" : Number(match[2]),
      incumbentParty, incumbent: plainText(row[2]?.text || "") || null, pvi: pviText || null, open: !incumbentParty, flip, ratings,
    });
  }
  return { forecasters, districts };
}

/**
 * "2026 United States House of Representatives elections in Texas": a section per district with
 * ====Predictions==== and general-election ====Polling==== tables, plus a statewide congressional generic ballot.
 */
export function parseTexasCongressPage(wikitext) {
  const districts = [];
  const headingPattern = /^==\s*District (\d+)\s*==\s*$/gm;
  const headings = [...wikitext.matchAll(headingPattern)].map((m) => ({ district: Number(m[1]), start: m.index, end: m.index + m[0].length }));
  headings.forEach((heading, index) => {
    const body = wikitext.slice(heading.end, headings[index + 1]?.start ?? wikitext.length);
    const general = findSection(body, /^General election$/i, { last: false });
    const scope = general ? general.body : body;
    const predictions = findSection(scope, /^Predictions$/i, { last: true });
    const ratings = {};
    if (predictions) {
      const table = extractTables(predictions.body)[0];
      for (const row of parseTable(table || "")) {
        if (row.length < 2 || row[0].header) continue;
        const rating = parseRaceRating(row[1].text);
        if (!rating) continue;
        const name = plainText(row[0].text);
        ratings[canonicalForecaster(name)] = { name: FORECASTER_NAMES[canonicalForecaster(name)] || name, label: rating.label, asOf: row[2] ? normalizeDate(plainText(row[2].text)) : null };
      }
    }
    const polling = general ? findSection(general.body, /^Polling$/i, { last: true }) : null;
    const polls = polling ? parseRacePolling(wikitext, { sectionBody: polling.body, partyFromHeader: true }).polls : [];
    districts.push({ district: heading.district, ratings, polls });
  });
  const statewide = findSection(wikitext, /^Statewide polling$/i, { last: false });
  const statewidePolls = statewide ? parseRacePolling(wikitext, { democrat: "Democratic", republican: "Republican", sectionBody: statewide.body }).polls : [];
  return { districts, statewidePolls };
}

/**
 * Texas judicial / State Board of Education pages: one `== Place N ==` / `== District N ==` / `== Chief Justice ==`
 * section per race, each with an {{Infobox election}} naming the nominees. Returns [{ race, nominees: [{ name, party }], incumbent }].
 */
export function parseInfoboxRaces(wikitext, { sectionPattern = /^==\s*(Chief Justice|Place \d+|District \d+(?: \(special\))?)\s*==\s*$/gm } = {}) {
  const headings = [...wikitext.matchAll(sectionPattern)].map((m) => ({ race: m[1], start: m.index, end: m.index + m[0].length }));
  return headings.map((heading, index) => {
    const body = wikitext.slice(heading.end, headings[index + 1]?.start ?? wikitext.length);
    const field = (name) => { const m = body.match(new RegExp(`^\\|\\s*${name}\\s*=\\s*(.*)$`, "m")); return m ? plainText(m[1]).trim() : ""; };
    const nominees = [];
    for (let i = 1; i <= 4; i += 1) {
      const name = field(`nominee${i}`);
      if (!name) continue;
      const party = field(`party${i}`);
      nominees.push({ name, party: /Republican/i.test(party) ? "R" : /Democrat/i.test(party) ? "D" : /Libertarian/i.test(party) ? "L" : /Green/i.test(party) ? "G" : party || null });
    }
    if (nominees.length === 0) nominees.push(...nomineesFromPrimaries(body));
    const incumbent = field("before_election") || nominees.find((n) => /incumbent/i.test(n.note || ""))?.name || "";
    const incumbentParty = /Republican/i.test(field("before_party")) ? "R" : /Democrat/i.test(field("before_party")) ? "D" : (nominees.find((n) => /incumbent/i.test(n.note || ""))?.party ?? null);
    const predictions = findSection(body, /^Predictions$/i, { last: true });
    const ratings = {};
    if (predictions) for (const row of parseTable(extractTables(predictions.body)[0] || "")) { const rating = row[1] ? parseRaceRating(row[1].text) : null; if (rating) ratings[canonicalForecaster(plainText(row[0].text))] = rating.label; }
    return { race: heading.race, nominees, incumbent: incumbent || null, incumbentParty, ratings };
  });
}

/** Nominees from "<Party> primary" → "Nominee" bullet lists, at whatever heading depth the page uses. */
export function nomineesFromPrimaries(body) {
  const nominees = [];
  const headingPattern = /^(={3,6})\s*(.+?)\s*=+\s*$/gm;
  const headings = [...body.matchAll(headingPattern)].map((m) => ({ level: m[1].length, title: m[2].trim(), start: m.index, end: m.index + m[0].length }));
  headings.forEach((h, index) => {
    const partyMatch = h.title.match(/^(Republican|Democratic|Libertarian|Green) primary$/i);
    if (!partyMatch) return;
    const partyEnd = headings.slice(index + 1).find((x) => x.level <= h.level);
    const partyBody = body.slice(h.end, partyEnd ? partyEnd.start : undefined);
    const nomineeHeading = [...partyBody.matchAll(/^(={4,6})\s*Nominee\s*=+\s*$/gm)][0];
    if (!nomineeHeading) return;
    const after = partyBody.slice(nomineeHeading.index + nomineeHeading[0].length);
    const bullet = after.match(/^\*\s*(.+)$/m);
    if (!bullet) return;
    const text = plainText(bullet[1]);
    const [name, ...rest] = text.split(",");
    nominees.push({ name: name.trim(), party: partyMatch[1][0], note: rest.join(",").trim() || null });
  });
  return nominees;
}

/** Court of Criminal Appeals nominees live only on the "2026 Texas elections" page as bullet lists under each Place. */
export function parseCriminalAppeals(wikitext) {
  const section = findSection(wikitext, /^Texas Court of Criminal Appeals$/i, { last: false });
  if (!section) return [];
  const places = [...section.body.matchAll(/^====\s*(Place \d+)\s*====\s*$/gm)].map((m) => ({ race: m[1], start: m.index, end: m.index + m[0].length }));
  return places.map((place, index) => {
    const body = section.body.slice(place.end, places[index + 1]?.start ?? undefined);
    const nominees = nomineesFromPrimaries(body);
    const incumbentNominee = nominees.find((n) => /incumbent/i.test(n.note || ""));
    return { race: place.race, nominees, incumbent: incumbentNominee?.name || null, incumbentParty: incumbentNominee?.party ?? "R", ratings: {} };
  });
}

/** National House page: "Generic congressional ballot aggregate polls" table -> aggregator averages, and the infobox seat counts. */
export function parseHouseNationalPage(wikitext) {
  const section = findSection(wikitext, /Generic congressional ballot aggregate polls/i, { last: false });
  const aggregates = section ? parseRacePolling(wikitext, { democrat: "Democrats", republican: "Republicans", sectionBody: section.body }).aggregates : [];
  const seats = (key) => { const m = wikitext.match(new RegExp(`^\\|\\s*${key}\\s*=\\s*(\\d+)`, "m")); return m ? Number(m[1]) : null; };
  const party1 = (wikitext.match(/^\|\s*party1\s*=\s*(.+)$/m) || [])[1] || "";
  const first = seats("seats_before1"), second = seats("seats_before2");
  const composition = first !== null && second !== null ? (/Republican/i.test(party1) ? { R: first, D: second } : { D: first, R: second }) : null;
  return { aggregates, composition };
}

/**
 * A race page's "Predictions" table (Source | Ranking | As of) -> { cook: { label, asOf }, ... }.
 * Looks inside the General election section when present (primary pages have none).
 */
export function parseRacePredictions(wikitext) {
  const general = findSection(wikitext, /^General election$/i, { last: false });
  const section = findSection(wikitext, /^Predictions$/i, { afterIndex: general ? general.start : 0, last: false });
  if (!section) return {};
  const table = extractTables(section.body)[0];
  if (!table) return {};
  const ratings = {};
  for (const row of parseTable(table)) {
    if (row.length < 2 || row[0].header) continue;
    const rating = parseRaceRating(row[1].text) || parseRaceRating(row.map((c) => c.text).join(" "));
    if (!rating) continue;
    const sourceName = plainText(row[0].text);
    const asOfCell = row[2] ? plainText(row[2].text) : "";
    ratings[canonicalForecaster(sourceName)] = { name: FORECASTER_NAMES[canonicalForecaster(sourceName)] || sourceName, label: rating.label, asOf: normalizeDate(asOfCell) };
  }
  return ratings;
}

/**
 * The general-election "Polling" section of a race page.
 * Returns { aggregates: [...], polls: [...] } with candidate columns mapped to D/R by candidate last names.
 */
export function parseRacePolling(wikitext, { democrat, republican, sectionBody = null, partyFromHeader = false }) {
  let body = sectionBody;
  if (body === null) {
    const general = findSection(wikitext, /^General election$/i, { last: false });
    const section = findSection(wikitext, /^Polling$/i, { afterIndex: general ? general.start : 0, last: true });
    if (!section) return { aggregates: [], polls: [] };
    body = section.body;
  }
  const aggregates = [];
  const polls = [];
  const demLast = democrat ? lastName(democrat) : null;
  const repLast = republican ? lastName(republican) : null;
  for (const table of extractTables(body)) {
    const rows = parseTable(table);
    const headerRow = rows.find((row) => row.filter((c) => c.header).length >= 4);
    if (!headerRow) continue;
    const headers = headerRow.map((cell) => plainText(cell.text).toLowerCase());
    let demIndex = demLast ? headers.findIndex((h) => h.includes(demLast)) : -1;
    let repIndex = repLast ? headers.findIndex((h) => h.includes(repLast)) : -1;
    if ((demIndex === -1 || repIndex === -1) && partyFromHeader) {
      // Candidate headers like "Monica De La Cruz (R)" / generic "Democratic" / "Democrats".
      demIndex = headers.findIndex((h) => /\((d|dem)\)|^democrat/.test(h));
      repIndex = headers.findIndex((h) => /\((r|rep|gop)\)|^republican/.test(h));
    }
    if (demIndex === -1 || repIndex === -1) continue; // e.g., hypothetical matchup tables
    const dateIndex = headers.findIndex((h) => /date/.test(h));
    const isAggregate = headers.some((h) => /aggregat|source of poll/.test(h));
    const sampleIndex = headers.findIndex((h) => /sample/.test(h));
    const moeIndex = headers.findIndex((h) => /margin.*error|moe/.test(h));
    const undecidedIndex = headers.findIndex((h) => /undecided/.test(h));
    for (const row of rows) {
      if (row === headerRow || row.every((c) => c.header) || row.length < Math.max(demIndex, repIndex) + 1) continue;
      const firstText = plainText(row[0].text);
      if (/^average$/i.test(firstText) || !firstText) continue;
      const dem = parsePercent(row[demIndex].text);
      const rep = parsePercent(row[repIndex].text);
      if (dem === null || rep === null) continue;
      const dates = dateIndex >= 0 ? parseDateRange(row[dateIndex].text) : null;
      const urlMatch = row[0].text.match(/\|\s*url\s*=\s*(\S+)/);
      if (isAggregate) {
        const updatedIndex = headers.findIndex((h) => /updated/.test(h));
        aggregates.push({
          source: firstText, dem, rep, margin: round1(dem - rep),
          through: dates ? dates.end : null,
          updated: updatedIndex >= 0 ? (parseDateRange(row[updatedIndex].text)?.end ?? null) : null,
          url: urlMatch ? urlMatch[1] : null,
        });
        continue;
      }
      const sampleText = sampleIndex >= 0 ? plainText(row[sampleIndex].text) : "";
      const sampleMatch = sampleText.match(/([\d,]+)\s*\(?\s*(LV|RV|A|V)?/i);
      const partisanMatch = firstText.match(/\((R|D)\)\s*$/) || firstText.match(/\((R|D)\)/);
      polls.push({
        source: "wikipedia",
        id: `wikipedia:${slug(firstText)}:${dates ? dates.end : "undated"}:${sampleText.replace(/\s+/g, "")}`,
        pollster: firstText.replace(/\s*\((R|D)\)\s*/g, " ").replace(/\s+/g, " ").trim(),
        sponsors: [],
        startDate: dates ? dates.start : null,
        endDate: dates ? dates.end : null,
        sampleSize: sampleMatch ? Number(sampleMatch[1].replace(/,/g, "")) : null,
        population: sampleMatch && sampleMatch[2] ? sampleMatch[2].toUpperCase() : null,
        marginOfError: moeIndex >= 0 ? parsePercent(row[moeIndex].text) : null,
        partisan: partisanMatch ? partisanMatch[1] : null,
        internal: /internal/i.test(row[0].text),
        dem, rep,
        undecided: undecidedIndex >= 0 ? parsePercent(row[undecidedIndex].text) : null,
        url: urlMatch ? urlMatch[1] : null,
      });
    }
  }
  return { aggregates, polls };
}

/**
 * Legislative chamber page: "By district" table (every seat: incumbent, party, 2024 presidential margin)
 * and "Competitive districts" table (State Navigate ratings). Returns { districts: [...], ratingSource }.
 */
export function parseLegislativeChamber(wikitext) {
  const byDistrict = findSection(wikitext, /^By district$/i);
  const districts = new Map();
  if (byDistrict) {
    const table = extractTables(byDistrict.body)[0];
    for (const row of parseTable(table || "")) {
      if (row.every((c) => c.header) || row.length < 4) continue;
      const numberMatch = plainText(row[0].text).match(/(\d+)/);
      if (!numberMatch) continue;
      const district = Number(numberMatch[1]);
      const incumbentText = plainText(row[2].text);
      const party = parsePartyShading(cellMarkup(row[3])) || parsePartyFromLabel(row[4]?.text || "");
      districts.set(district, {
        district,
        incumbent: incumbentText.replace(/[†‡]/g, "").trim() || null,
        retiring: /†/.test(incumbentText),
        defeatedInPrimary: /‡/.test(incumbentText),
        party,
        presidentialMargin2024: parsePviMargin(row[1].text),
        rating: null,
        ratingSource: null,
        flip: false,
      });
    }
  }
  const competitive = findSection(wikitext, /^Competitive districts$/i);
  let ratingSource = null;
  if (competitive) {
    const table = extractTables(competitive.body)[0];
    const rows = parseTable(table || "");
    const headerRow = rows.find((row) => row.some((c) => c.header));
    const ratingHeader = headerRow ? headerRow[headerRow.length - 1] : null;
    if (ratingHeader) {
      const name = plainText(ratingHeader.text.replace(/\{\{Efn[\s\S]*?\}\}/gi, ""));
      const asOf = name.match(/([A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s*\d{4})/);
      ratingSource = { name: name.replace(/\s*[A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s*\d{4}.*$/, "").trim() || "State Navigate", asOf: asOf ? normalizeDate(asOf[1]) : null };
    }
    for (const row of rows) {
      if (row.every((c) => c.header) || row.length < 3) continue;
      const numberMatch = plainText(row[0].text).match(/(\d+)/);
      if (!numberMatch) continue;
      const district = Number(numberMatch[1]);
      const rating = parseRaceRating(row[row.length - 1].text);
      const entry = districts.get(district) || { district, incumbent: plainText(row[1].text) || null, party: parsePartyShading(cellMarkup(row[1])), presidentialMargin2024: null };
      if (rating) { entry.rating = rating.label; entry.flip = rating.flip; entry.ratingSource = ratingSource?.name || null; }
      if (!entry.party) entry.party = parsePartyShading(cellMarkup(row[1]));
      districts.set(district, entry);
    }
  }
  const chamberPredictions = parseLegislativeChamberPredictions(wikitext);
  return { districts: [...districts.values()].sort((a, b) => a.district - b.district), ratingSource, chamberPredictions };
}

function parseLegislativeChamberPredictions(wikitext) {
  const predictions = findSection(wikitext, /^Predictions$/i, { last: false });
  if (!predictions) return {};
  const statewide = findSection(predictions.body, /^Statewide$/i, { last: false }) || { body: predictions.body };
  const table = extractTables(statewide.body)[0];
  if (!table) return {};
  const out = {};
  for (const row of parseTable(table)) {
    if (row.every((c) => c.header) || row.length < 2) continue;
    const rating = parseRaceRating(row[1].text);
    if (!rating) continue;
    const name = plainText(row[0].text);
    out[canonicalForecaster(name)] = { name, label: rating.label, asOf: row[2] ? normalizeDate(plainText(row[2].text)) : null };
  }
  return out;
}

function parsePartyFromLabel(text) {
  const t = plainText(text).toLowerCase();
  if (/^dem/.test(t)) return "D";
  if (/^rep/.test(t)) return "R";
  if (/^ind/.test(t)) return "I";
  return null;
}

function lastName(fullName) { return fullName.trim().split(/\s+/).pop().toLowerCase(); }
function cellMarkup(cell) { return cell ? `${cell.attributes || ""} ${cell.text || ""}` : ""; }
function slug(text) { return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function round1(value) { return Math.round(value * 10) / 10; }
