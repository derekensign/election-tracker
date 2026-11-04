// Live U.S. Senate returns from the states' own election-night files, for the Senate Election Night table. They are
// shown, not modeled: states count early, mail, and Election Day votes in different orders, so a partial count can
// mislead, and the control model moves on calls (and on Texas through the Texas needle) instead.
//
// Each parser takes a file's text and returns { candidates: [{ name, party, votes }], units }, where units is how far
// along the count is in the state's own terms: { reporting, total, kind } with kind "precincts", "counties", or
// "localities". Formats and URLs were checked against each state's pre-staged 2026 file (zero votes) on November 3,
// 2026. Not read, so their races move on calls: Ohio and Kansas (they refuse requests from cloud servers like the
// recorder's; their parsers stay here, tested, in case that changes), Michigan (bot challenge), Kentucky (its
// acceptable-use policy restricts automated reads), Oklahoma and Tennessee (blocked), and Maine, New Hampshire,
// Mississippi, Wyoming, Illinois, New Jersey, and Massachusetts (no machine-readable statewide file).

/** Last name, lowercased, without suffixes or punctuation: "Michael Whatley Jr." → "whatley"; "Peltola, Mary" → "peltola". */
function lastName(name) {
  const text = String(name || "");
  const surname = text.includes(",") ? text.slice(0, text.indexOf(",")) : text;
  const tokens = surname.toLowerCase().replace(/[^a-z\s'-]/g, " ").split(/\s+/).filter((t) => t && !["jr", "sr", "ii", "iii", "iv"].includes(t));
  return tokens.at(-1) ?? "";
}

/** "DEM", "DFL", "Dem", "Democratic Party", "REP", "R", … → "D" | "R" | "other". */
function partyCode(raw) {
  const code = String(raw || "").trim().toUpperCase();
  if (["DEM", "D", "DFL", "DEMOCRAT", "DEMOCRATIC"].includes(code) || /^DEMOCRATIC( PARTY|[–-]FARMER)/.test(code)) return "D";
  if (["REP", "R", "GOP", "REPUBLICAN"].includes(code) || /^REPUBLICAN PARTY/.test(code)) return "R";
  return "other";
}

const number = (value) => Number(String(value ?? "").replace(/,/g, "")) || 0;
const asArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
const withoutBom = (text) => text.replace(/^﻿/, "");

/** Sum rows that repeat per county: votes by candidate key, and each county's progress once. */
function sumCounties(rows, { key, name, party, votes, county, reporting, total }) {
  const byCandidate = new Map(), counties = new Map();
  for (const row of rows) {
    const entry = byCandidate.get(key(row)) ?? { name: name(row), party: party(row), votes: 0 };
    entry.votes += number(votes(row));
    byCandidate.set(key(row), entry);
    counties.set(county(row), { reporting: number(reporting(row)), total: number(total(row)) });
  }
  const sum = (field) => [...counties.values()].reduce((t, c) => t + c[field], 0);
  return { candidates: [...byCandidate.values()], units: { reporting: sum("reporting"), total: sum("total"), kind: "precincts" } };
}

/** A CSV line, honoring double-quoted fields. */
function csvCells(line) {
  const cells = [];
  let cell = "", quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) { if (c === '"' && line[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false; else cell += c; }
    else if (c === '"') quoted = true;
    else if (c === ",") { cells.push(cell); cell = ""; }
    else cell += c;
  }
  cells.push(cell);
  return cells;
}

/** North Carolina: a JSON array of statewide rows, one per candidate per contest. */
export function parseNorthCarolina(text) {
  const rows = JSON.parse(withoutBom(text)).filter((row) => /^US SENATE\b/i.test(row.cnm || ""));
  if (!rows.length) throw new Error("no US SENATE contest in the file");
  return {
    candidates: rows.map((row) => ({ name: row.bnm, party: row.pty, votes: number(row.vct) })),
    units: { reporting: number(rows[0].prt), total: number(rows[0].ptl), kind: "precincts" },
  };
}

/** Florida: tab-separated rows, one per candidate per county; race code USS. */
export function parseFlorida(text) {
  const [header, ...lines] = withoutBom(text).split(/\r?\n/).filter(Boolean);
  const columns = header.split("\t").map((c) => c.trim());
  const at = (name) => { const i = columns.indexOf(name); if (i === -1) throw new Error(`no ${name} column`); return i; };
  const race = at("RaceCode"), county = at("CountyCode"), precincts = at("Precincts"), reporting = at("PrecinctsReporting");
  const last = at("CanNameLast"), first = at("CanNameFirst"), party = at("PartyCode"), votes = at("CanVotes");
  const rows = lines.map((line) => line.split("\t")).filter((cells) => cells[race]?.trim() === "USS");
  if (!rows.length) throw new Error("no USS rows in the file");
  return sumCounties(rows, {
    key: (c) => `${c[first].trim()} ${c[last].trim()}`, name: (c) => `${c[first].trim()} ${c[last].trim()}`, party: (c) => c[party].trim(), votes: (c) => c[votes],
    county: (c) => c[county], reporting: (c) => c[reporting], total: (c) => c[precincts],
  });
}

/** Minnesota: semicolon-separated statewide rows for the office, one per candidate. */
export function parseMinnesota(text) {
  const rows = withoutBom(text).split(/\r?\n/).filter(Boolean).map((line) => line.split(";")).filter((cells) => /U\.S\. Senator/i.test(cells[4] || ""));
  if (!rows.length) throw new Error("no U.S. Senator rows in the file");
  return {
    candidates: rows.map((cells) => ({ name: cells[7], party: cells[10], votes: number(cells[13]) })),
    units: { reporting: number(rows[0][11]), total: number(rows[0][12]), kind: "precincts" },
  };
}

/**
 * Clarity ENR (Iowa, South Carolina, Colorado, and Michigan counties): summary.json, contests with parallel name, party,
 * and vote arrays. PR/TP count counties in a state's file and precincts in a county's (`kind`).
 */
export function parseClarity(text, contestPattern, kind = "counties") {
  const contest = JSON.parse(withoutBom(text)).find((c) => contestPattern.test(c.C || ""));
  if (!contest) throw new Error("no Senate contest in summary.json");
  return {
    // Some states prefix names with the party code ("DEM Annie Andrews").
    candidates: contest.CH.map((name, i) => ({ name: contest.P?.[i] && name.startsWith(`${contest.P[i]} `) ? name.slice(contest.P[i].length + 1) : name, party: contest.P?.[i] ?? "", votes: number(contest.V?.[i]) })),
    // A county can report before it has votes.
    units: { reporting: number(contest.PR), total: number(contest.TP), kind },
  };
}

/** Enhanced Voting (Georgia, Idaho, Rhode Island, Virginia): the election's /data file. */
export function parseEnhancedVoting(text, contestPattern, kind = "counties") {
  const data = JSON.parse(withoutBom(text));
  const english = (texts) => asArray(texts).find((t) => t.languageId === "en")?.text ?? asArray(texts)[0]?.text ?? "";
  const item = data.ballotItems.find((b) => contestPattern.test(english(b.name)));
  if (!item) throw new Error("no Senate contest in the data");
  return {
    // Names carry tags like "Jon Ossoff (I) (Dem)": incumbent, then party.
    candidates: item.summaryResults.ballotOptions.map((o) => ({ name: english(o.name).replace(/(\s*\([A-Za-z]{1,12}\))+$/, "").trim(), party: o.party?.abbreviation ?? "", votes: number(o.voteCount) })),
    units: item.reportingStatus ? { reporting: number(item.reportingStatus.reportingUnits), total: number(item.reportingStatus.totalUnits), kind } : null,
  };
}

/** The ResultsAjax service (South Dakota, Oregon): one row per candidate per county. */
export function parseResultsAjax(text) {
  const rows = JSON.parse(withoutBom(text)).d ?? [];
  if (!rows.length) throw new Error("no rows");
  return sumCounties(rows, {
    key: (r) => r.CandidateID, name: (r) => String(r.calcCandidate).replace(/\s+/g, " ").trim(), party: (r) => r.PartyCode ?? r.PartyName ?? "", votes: (r) => r.calcCandidateVotes,
    county: (r) => r.CountyID, reporting: (r) => r.PrecinctsReporting, total: (r) => r.TotalPrecincts,
  });
}

/** The same vendor's statewide CSV (Nebraska, New Mexico): one row per candidate, progress as "12/1322". */
export function parseResultsCsv(text, racePattern) {
  const [header, ...lines] = withoutBom(text).split(/\r?\n/).filter((line) => line.trim()).map(csvCells);
  const columns = header.map((c) => c.trim());
  const rows = lines.map((cells) => Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ""]))).filter((row) => racePattern.test(row.RaceName || ""));
  if (!rows.length) throw new Error("no Senate rows in the CSV");
  const [reporting, total] = String(rows[0].PrecinctsReporting).replace(/[="]/g, "").split("/").map(number);
  return {
    candidates: rows.map((row) => ({ name: row.CandidateName.replace(/\s+/g, " ").trim(), party: row.PartyCode, votes: number(row.CandidateVotes) })),
    units: { reporting, total, kind: "precincts" },
  };
}

/** Ohio: one entry per county; sum them. */
export function parseOhio(text) {
  const counties = JSON.parse(withoutBom(text)).contestList ?? [];
  if (!counties.length) throw new Error("no counties in the contest");
  const rows = counties.flatMap((county) => county.candidatesRunning.map((candidate) => ({ county, candidate })));
  return sumCounties(rows, {
    key: (r) => r.candidate.primaryCandidate, name: (r) => r.candidate.primaryCandidate, party: (r) => r.candidate.candidateParty, votes: (r) => r.candidate.vCount,
    county: (r) => r.county, reporting: (r) => r.county.reportedPrecincts, total: (r) => r.county.totalPrecincts,
  });
}

/** Alaska: statewide.js (plain JSON), contests and candidates by index; names are "Last, First (PARTY)". */
export function parseAlaska(text) {
  const results = JSON.parse(withoutBom(text));
  const contest = results.totals.find((c) => results.contestNames[c.n] === "U.S. Senator");
  if (!contest) throw new Error("no U.S. Senator contest");
  return {
    candidates: contest.c.map((entry) => {
      const raw = results.candidateNames[entry.n], [, label = raw, party = ""] = raw.match(/^(.*?)\s*\(([A-Z/]+)\)$/) ?? [];
      const [last, first] = label.split(/,\s*/);
      return { name: first ? `${first} ${last}` : label, party, votes: number(entry.t) };
    }),
    units: { reporting: number(contest.r), total: number(contest.p), kind: "precincts" },
  };
}

/** Kansas: static HTML; the "United States Senate" block, with names like "D-Adam Hamilton". */
export function parseKansas(html) {
  const start = html.indexOf("<h3>United States Senate</h3>");
  if (start === -1) throw new Error("no United States Senate block");
  const block = html.slice(start, html.indexOf("<!-- end of .race-candidate-list -->", start));
  const [, reporting, total] = block.match(/Precincts Reporting:\s*([\d,]+)\s*of\s*([\d,]+)/) ?? [];
  const candidates = [...block.matchAll(/<div class='col-6'>\s*<p>([^<]+)<\/p>\s*<\/div>\s*<div class='col-2'>\s*<p>([\d,]+)<\/p>/g)]
    .map(([, label, votes]) => ({ label: label.replace(/&nbsp;/g, " ").trim(), votes }))
    .filter((row) => row.label !== "Total Votes")
    .map((row) => { const [, party = "", name = row.label] = row.label.match(/^([A-Z])-(.*)$/) ?? []; return { name, party, votes: number(row.votes) }; });
  if (!candidates.length) throw new Error("no candidates in the block");
  return { candidates, units: reporting ? { reporting: number(reporting), total: number(total), kind: "precincts" } : null };
}

/** Louisiana: the votes file, joined to tonight's candidate IDs (fixed for the election, from its races file). */
export function parseLouisiana(text) {
  const names = { 124654: "Jamie Davis (DEM)", 124655: "Julia Letlow (REP)" };
  const race = asArray(JSON.parse(withoutBom(text)).Races?.Race).find((r) => String(r.ID) === "67997");
  if (!race) throw new Error("no race 67997 (U.S. Senator)");
  return {
    candidates: asArray(race.Choice).map((choice) => { const [, name, party] = (names[choice.ID] ?? `${choice.ID} ()`).match(/^(.*)\s+\(([^)]*)\)$/); return { name, party, votes: number(choice.VoteTotal) }; }),
    units: { reporting: number(race.PrecinctsReporting), total: number(race.PrecinctsExpected), kind: "precincts" },
  };
}

/** Arkansas: the Senate contest's results, joined to tonight's candidate IDs (fixed for the election). */
export function parseArkansas(text) {
  const names = { "342d2707-ef1d-46e0-a6a5-a90c0ac9ac6d": ["Tom Cotton", "REP"], "849fd18d-cf1f-4215-9fd3-097aa99b3532": ["Jeff Wadlin", "LIB"], "34854720-5dc4-4515-bed4-74fe6dc9c8a6": ["Hallie Shoffner", "DEM"] };
  const contest = JSON.parse(withoutBom(text)).response;
  if (!contest?.choices) throw new Error("no contest results");
  return {
    candidates: contest.choices.map((choice) => ({ name: names[choice.choiceID]?.[0] ?? choice.choiceID, party: names[choice.choiceID]?.[1] ?? "", votes: number(choice.totalVotes) })),
    units: { reporting: number(contest.precinctsReporting), total: number(contest.totalPrecincts), kind: "precincts" },
  };
}

/** Washtenaw County, Michigan: a static HTML page; the "US Senate" block's rows are name, early, absentee, Election Day, total. */
export function parseWashtenaw(html) {
  const start = html.search(/<td class="headertr" colspan="4">US Senate<\/td>/);
  if (start === -1) throw new Error("no US Senate block");
  const next = html.indexOf('class="headertr" colspan="4"', start + 40);
  const block = html.slice(start, next === -1 ? undefined : next);
  const candidates = [];
  for (const row of block.split(/<tr>/).slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/&nbsp;/g, " ").replace(/<[^>]+>/g, "").trim());
    if (cells.length < 5 || /write-ins/i.test(cells[0])) continue;
    candidates.push({ name: cells[0], party: "", votes: number(cells[4]) });
  }
  if (!candidates.length) throw new Error("no candidates in the US Senate block");
  const total = html.match(/Precincts Total:<\/td>\s*<td[^>]*>([\d,]+)/)?.[1], counted = html.match(/Precincts Fully Counted:<\/t[hd]>\s*<td[^>]*>([\d,]+)/)?.[1];
  return { candidates, units: total ? { reporting: number(counted), total: number(total), kind: "precincts" } : null };
}

/** Delaware: statewide rows by contest. */
export function parseDelaware(text) {
  const rows = JSON.parse(withoutBom(text)).filter((row) => row["Contest Title"] === "U.S. Senator");
  if (!rows.length) throw new Error("no U.S. Senator rows");
  return {
    candidates: rows.map((row) => ({ name: row["Candidate Name"], party: row["Party Name"], votes: number(row["Total Votes"]) })),
    units: { reporting: number(rows[0]["Precincts Reported"]), total: number(rows[0]["Total Precincts"]), kind: "precincts" },
  };
}

/** Wikitext to plain text: links to their labels, without bold, refs, templates, tags, or parentheticals. */
function plainWikitext(text) {
  return String(text ?? "")
    .replace(/<ref[^>]*\/>/g, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, "$1")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/'{2,}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ").trim();
}

/**
 * Unofficial counts from a 2026 Senate election page's infobox, as Wikipedia's editors fill it in from news reports
 * through the night: nominees, parties, popular votes, and "reporting" (a percent). Null until there are votes.
 * Commented-out parameters don't count.
 */
export function parseWikipediaInfobox(wikitext) {
  const text = String(wikitext).replace(/<!--[\s\S]*?-->/g, "");
  const start = text.indexOf("{{Infobox election");
  if (start === -1) return null;
  let depth = 0, end = text.length;
  for (let i = start; i < text.length - 1; i += 1) {
    const pair = text.slice(i, i + 2);
    if (pair === "{{") { depth += 1; i += 1; }
    else if (pair === "}}") { depth -= 1; i += 1; if (depth === 0) { end = i + 1; break; } }
  }
  const params = {};
  for (const line of text.slice(start, end).split("\n")) {
    const match = line.match(/^\s*\|\s*([a-z_]+\d*)\s*=\s*(.*)$/i);
    if (match) params[match[1].toLowerCase()] = match[2];
  }
  const candidates = [];
  for (let n = 1; n <= 8; n += 1) {
    const name = params[`nominee${n}`] ?? params[`candidate${n}`];
    if (name == null) continue;
    candidates.push({ name: plainWikitext(name), party: plainWikitext(params[`party${n}`]), votes: number(plainWikitext(params[`popular_vote${n}`])) });
  }
  if (!candidates.some((c) => c.votes > 0)) return null;
  const reporting = plainWikitext(params.reporting).replace(/[^\d.]/g, "");
  return {
    candidates,
    units: reporting ? { reporting: Math.min(100, Number(reporting)), total: 100, kind: "percent" } : null,
    lastUpdate: [plainWikitext(params.last_update), plainWikitext(params.time_zone)].filter(Boolean).join(" ") || null,
  };
}

/**
 * The winner a race's own Wikipedia page names, when its editors have filled in the infobox's after_election (left
 * blank until a race is called): { name, party } with party "D", "R", "I", or "other", or null.
 */
export function parseWikipediaWinner(wikitext) {
  const text = String(wikitext).replace(/<!--[\s\S]*?-->/g, "");
  const start = text.indexOf("{{Infobox election");
  if (start === -1) return null;
  const field = (name) => text.slice(start).match(new RegExp(`\\n\\s*\\|\\s*${name}\\s*=([^\\n]*)`))?.[1]?.trim() ?? "";
  const raw = field("after_election");
  if (!/\[\[/.test(raw)) return null; // blank, or a placeholder like "TBD"
  const name = plainWikitext(raw);
  const party = plainWikitext(field("after_party")).toUpperCase();
  if (!name) return null;
  // Parties appear as "Democratic Party (United States)" or a state party, like "Texas Democratic Party".
  return { name, party: /DEMOCRAT/.test(party) ? "D" : /REPUBLICAN/.test(party) ? "R" : /INDEPENDENT/.test(party) ? "I" : "other" };
}

/** Calls from the races' own pages, from the same API response wikipediaReturns reads. */
export function wikipediaPageCalls(races, apiResponse) {
  const byTitle = new Map(races.map((race) => [wikipediaPageTitle(race), race]));
  const calls = {};
  for (const page of apiResponse?.query?.pages ?? []) {
    const race = byTitle.get(page.title);
    const winner = race ? parseWikipediaWinner(page.revisions?.[0]?.slots?.main?.content ?? "") : null;
    if (winner) calls[race.state] = { winner: winner.party, name: winner.name, via: "state page" };
  }
  return calls;
}

/** A race's Wikipedia page. */
export function wikipediaPageTitle(race) {
  return `2026 United States Senate ${race.special ? "special " : ""}election in ${race.stateName}`;
}

/**
 * Unofficial counts from one Wikipedia API response covering the races' pages (prop=revisions, rvprop=content|
 * timestamp, rvsection=0, formatversion=2): the only counts for states with no official file (SENATE_RETURN_GAPS),
 * and a fallback when a state's file fails. Pages with no votes yet are left out.
 */
export function wikipediaReturns(races, apiResponse, fetchedAt) {
  const byTitle = new Map(races.filter((race) => race.state !== "TX").map((race) => [wikipediaPageTitle(race), race]));
  const returns = {};
  for (const page of apiResponse?.query?.pages ?? []) {
    const race = byTitle.get(page.title), revision = page.revisions?.[0];
    const parsed = race && revision ? parseWikipediaInfobox(revision.slots?.main?.content ?? "") : null;
    if (!parsed) continue;
    returns[race.state] = {
      ...summarizeReturns(race, parsed), unofficial: true, source: "Wikipedia (unofficial)", lastUpdate: parsed.lastUpdate, edited: revision.timestamp,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`, fetchedAt,
    };
  }
  return returns;
}

/**
 * The Wikipedia API URL for every race's page: only each page's lead section, where the infobox is, so about 100 KB
 * in all. Its counts (but Texas's, which the Texas needle covers) and its winners are read. Add origin=* when a
 * browser reads it.
 */
export function wikipediaReturnsUrl(races, { browser = false } = {}) {
  const titles = races.map(wikipediaPageTitle).join("|");
  return `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content%7Ctimestamp&rvslots=main&rvsection=0&redirects=1&format=json&formatversion=2${browser ? "&origin=*" : ""}&titles=${encodeURIComponent(titles)}`;
}

/** Each state's count: its official file when that read is current, else Wikipedia's, else the last official one. */
export function mergeReturns(official = {}, unofficial = {}) {
  const merged = {};
  for (const state of new Set([...Object.keys(official), ...Object.keys(unofficial)])) {
    const file = official[state];
    merged[state] = file && !file.stale && !file.unofficial ? file : unofficial[state] ?? file;
  }
  return merged;
}

/**
 * Why each state with a Senate race but no file above has no live count: a short reason for the table and a longer
 * one for the race's detail. Their races still move on calls.
 */
export const SENATE_RETURN_GAPS = {
  OH: ["blocks cloud servers", "Ohio's results site refuses requests from cloud servers like the site's recorder"],
  KS: ["blocks cloud servers", "Kansas's results site refuses requests from cloud servers like the site's recorder"],
  MI: ["behind a bot check", "Michigan's results site puts automated readers behind a bot check, which the site doesn't try to get past"],
  KY: ["no automated reads", "Kentucky's terms restrict automated reads of its results site"],
  OK: ["site blocked us", "Oklahoma's results site blocked the site's test reads"],
  TN: ["site blocked us", "Tennessee's results site blocked the site's test reads"],
  MT: ["site blocked us", "Montana's results site blocked the site's test reads"],
  ME: ["no statewide file", "Maine has no statewide results file on election night; its towns report their own counts"],
  NH: ["no statewide file", "New Hampshire has no statewide results file on election night; its towns report their own counts"],
  MA: ["no statewide file", "Massachusetts has no statewide results file on election night; its towns report their own counts"],
  MS: ["no statewide file", "Mississippi posts county PDFs after the election rather than a live file"],
  WY: ["PDFs only", "Wyoming posts PDFs as its counties finish"],
  IL: ["local offices report", "Illinois's 108 local election offices each post their own results; the state publishes after certification"],
  NJ: ["county clerks report", "New Jersey's 21 county clerks each post their own results; the state publishes after certification"],
  AL: ["web page only", "Alabama posts its results as a web page, not a file the site can read"],
  WV: ["file not posted", "West Virginia hadn't posted tonight's results file when the site was set up"],
};

/** A Clarity election: read the current version (tiny, never cached), then that version's summary. */
const clarity = (base, contestPattern, kind) => async (get) => parseClarity(await get(`${base}/${(await get(`${base}/current_ver.txt`)).trim()}/json/en/summary.json`), contestPattern, kind);
const bust = (url) => `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;

/**
 * Each state with an official file for tonight: a label, a page a person can open, and how to read it (`read` gets
 * a function that fetches a URL's text). Texas comes from the Texas needle instead.
 */
export const SENATE_RETURN_SOURCES = {
  NC: { label: "N.C. State Board of Elections", url: "https://er.ncsbe.gov/?election_dt=11/03/2026", read: async (get) => parseNorthCarolina(await get(bust("https://er.ncsbe.gov/enr/20261103/data/results_0.txt"))) },
  FL: { label: "Florida Division of Elections", url: "https://results.elections.myflorida.com/", read: async (get) => parseFlorida(await get(bust("https://flelectionfiles.floridados.gov/enightfilespublic/20261103_ElecResultsFL.txt"))) },
  MN: { label: "Minnesota Secretary of State", url: "https://electionresults.sos.mn.gov/", read: async (get) => parseMinnesota(await get(bust("https://electionresultsfiles.sos.mn.gov/20261103/ussenate.txt"))) },
  IA: { label: "Iowa Secretary of State", url: "https://electionresults.iowa.gov/IA/127077/", read: clarity("https://electionresults.iowa.gov/IA/127077", /^United States Senator$/i) },
  SC: { label: "S.C. Election Commission", url: "https://www.enr-scvotes.org/SC/127300/", read: clarity("https://www.enr-scvotes.org/SC/127300", /^U\.?\s*S\.?\s+Senate$/i) },
  CO: { label: "Colorado Secretary of State", url: "https://results.enr.clarityelections.com/CO/127407/", read: clarity("https://results.enr.clarityelections.com/CO/127407", /^United States Senator$/i) },
  GA: { label: "Georgia Secretary of State", url: "https://results.sos.ga.gov/results/public/Georgia/elections/11032026GeneralAndSpecialElection", read: async (get) => parseEnhancedVoting(await get("https://results.sos.ga.gov/results/public/api/elections/Georgia/11032026GeneralAndSpecialElection/data"), /^US Senate$/i, "counties") },
  ID: { label: "Idaho Secretary of State", url: "https://results.voteidaho.gov/", read: async (get) => parseEnhancedVoting(await get("https://results.voteidaho.gov/results/public/api/elections/id/nov2026/data"), /^United States Senator$/i, "counties") },
  RI: { label: "Rhode Island Board of Elections", url: "https://electionresults.ri.gov/", read: async (get) => parseEnhancedVoting(await get("https://electionresults.ri.gov/results/public/api/elections/rhodeisland/2026StatewideGeneralElection/data"), /^Senator in Congress$/i, "localities") },
  VA: { label: "Virginia Department of Elections", url: "https://enr.elections.virginia.gov/", read: async (get) => parseEnhancedVoting(await get("https://enr.elections.virginia.gov/results/public/api/elections/virginia/2026-November-General/data"), /^Member, United States Senate$/i, "localities") },
  AK: { label: "Alaska Division of Elections", url: "https://www.elections.alaska.gov/enr/26GENR/", read: async (get) => parseAlaska(await get(`https://www.elections.alaska.gov/enr/26GENR/results/statewide.js?d=${Date.now()}`)) },
  NE: { label: "Nebraska Secretary of State", url: "https://electionresults.nebraska.gov/", read: async (get) => parseResultsCsv(await get("https://electionresults.nebraska.gov/resultsCSV.aspx?text=All&type=SW&map=CTY"), /United States Senator/i) },
  NM: { label: "New Mexico Secretary of State", url: "https://electionresults.sos.nm.gov/", read: async (get) => parseResultsCsv(await get("https://electionresults.sos.nm.gov/resultsCSV.aspx?text=All&type=FED&map=CTY"), /^United States Senator$/i) },
  LA: { label: "Louisiana Secretary of State", url: "https://voterportal.sos.la.gov/graphical", read: async (get) => parseLouisiana(await get("https://voterportal.sos.la.gov/ElectionResults/ElectionResults/Data?blob=20261103/Votes_Multiparish.htm")) },
  AR: { label: "Arkansas Secretary of State", url: "https://arkansas.tally-enr.com/", read: async (get) => parseArkansas(await get("https://enr-results-api.totalresults.com/Contest/GetSingleContestResults?cId=arkansas&electionID=11b07106-031e-4d7c-911a-d01fb473d6dd&contestType=Federal&contestID=eafd140a-9378-43a2-bd6d-f8661524139b")) },
  SD: { label: "South Dakota Secretary of State", url: "https://electionresults.sd.gov/", read: async (get) => parseResultsAjax(await get("https://sdresws.azurewebsites.us/ResultsAjax.svc/GetMapData?type=SWR&category=CTY&raceID=14412&osn=110&county=0&party=0")) },
  OR: { label: "Oregon Secretary of State", url: "https://results.oregonvotes.gov/", read: async (get) => parseResultsAjax(await get("https://orresultswebservices.azureedge.us/ResultsAjax.svc/GetMapData?type=FED&category=CTY&raceID=300038695&osn=0&county=0&party=0")) },
  DE: { label: "Delaware Department of Elections", url: "https://elections.delaware.gov/results/enr/GE2026.html", read: async (get) => parseDelaware(await get(bust("https://elections.delaware.gov/results/enr/Election_StatewideResults_ID_GE2026.json"))) },
};

/**
 * States read through the Raspberry Pi relay (relay/pi-relay.py) because they refuse cloud servers: the relay drops
 * each response, unparsed, into relay.json, and the recorder parses it here.
 */
export const SENATE_RELAY_SOURCES = {
  OH: { label: "Ohio Secretary of State", url: "https://liveresults.ohiosos.gov/", parse: parseOhio },
  // Virginia's file answered the recorder this afternoon and started refusing it on election night.
  VA: { label: "Virginia Department of Elections", url: "https://enr.elections.virginia.gov/", parse: (text) => parseEnhancedVoting(text, /^Member, United States Senate$/i, "localities") },
};

/**
 * Counts from the relay's file when it's fresh (relayed within `maxAgeMs`): each relayed state's response parsed and
 * summarized like any other official file. A stale or missing relay gives nothing, and Wikipedia covers those states.
 */
export function relayReturns(races, relay, { now = Date.now(), maxAgeMs = 6 * 60_000 } = {}) {
  if (relay?.kind !== "senate-relay" || !(now - Date.parse(relay.relayedAt) < maxAgeMs)) return {};
  const raceByState = new Map(races.map((race) => [race.state, race]));
  const returns = {};
  for (const [state, source] of Object.entries(SENATE_RELAY_SOURCES)) {
    const file = relay.files?.[state], race = raceByState.get(state);
    if (!race || file?.status !== 200 || typeof file.body !== "string") continue;
    try {
      returns[state] = { ...summarizeReturns(race, source.parse(file.body)), source: source.label, url: source.url, fetchedAt: file.fetchedAt, relayed: true };
    } catch {
      // A malformed relayed file is skipped; Wikipedia's count stands in.
    }
  }
  return returns;
}

/**
 * Big counties' own official files, for states whose statewide site the recorder can't read (Michigan and Kansas put
 * theirs behind bot checks). Summed, they're a partial count, shown as "big counties only" beside the same counties'
 * 2024 presidential result, never as the state's count. Each county: a name, how to read it, and its 2024 vote
 * ({ dem, rep, total }). `stateTotal2024` is the state's whole 2024 presidential vote, for the share these cover.
 */
export const SENATE_COUNTY_SOURCES = {
  // Six of Michigan's ten biggest counties, about 36% of its 2024 vote (Harris +6.2 among them; Trump won the state
  // by 1.4). Wayne, Kent, and Kalamazoo turn automated readers away; Livingston posts PDFs. 2024 votes from Wikipedia.
  MI: {
    label: "Michigan's biggest counties",
    stateTotal2024: 5664186,
    counties: [
      { name: "Oakland", url: "https://results.enr.clarityelections.com/MI/Oakland/127284/", read: clarity("https://results.enr.clarityelections.com/MI/Oakland/127284", /^United States Senator$/i, "precincts"), president2024: { dem: 419519, rep: 337791, total: 772145 } },
      { name: "Macomb", url: "https://results.enr.clarityelections.com/MI/Macomb/127293/", read: clarity("https://results.enr.clarityelections.com/MI/Macomb/127293", /^United States Senator$/i, "precincts"), president2024: { dem: 214977, rep: 284660, total: 509152 } },
      { name: "Genesee", url: "https://results.enr.clarityelections.com/MI/Genesee/127354/", read: clarity("https://results.enr.clarityelections.com/MI/Genesee/127354", /^United States Senator$/i, "precincts"), president2024: { dem: 114670, rep: 105303, total: 223268 } },
      { name: "Ottawa", url: "https://results.enr.clarityelections.com/MI/Ottawa/127391/", read: clarity("https://results.enr.clarityelections.com/MI/Ottawa/127391", /^United States Senator$/i, "precincts"), president2024: { dem: 69653, rep: 106133, total: 178507 } },
      { name: "Ingham", url: "https://app.enhancedvoting.com/results/public/ingham-county-mi/elections/NovemberElection11032026", read: async (get) => parseEnhancedVoting(await get("https://app.enhancedvoting.com/results/public/api/elections/ingham-county-mi/NovemberElection11032026/data"), /^United States Senator$/i, "precincts"), president2024: { dem: 94542, rep: 50564, total: 148101 } },
      { name: "Washtenaw", url: "https://electionresults.ewashtenaw.org/electionreporting/nov2026/index.jsp", read: async (get) => parseWashtenaw(await get(bust("https://electionresults.ewashtenaw.org/electionreporting/nov2026/index.jsp"))), president2024: { dem: 157152, rep: 58844, total: 221542 } },
    ],
  },
};

/**
 * The counties read this pass, combined: candidates matched by last name across counties (formats differ), precincts
 * summed, and the 2024 margin and vote share of exactly the counties that answered.
 * @param {{ challenger: string|null, challengerParty: "D"|"I", republican: string|null }} race
 * @param {{ name: string, parsed: { candidates: { name: string, party: string, votes: number }[], units?: object|null }, president2024: { dem: number, rep: number, total: number } }[]} counties
 */
export function combineCounties(race, counties, stateTotal2024) {
  const byName = new Map();
  let reporting = 0, total = 0, precinctsKnown = true;
  for (const { parsed } of counties) {
    for (const candidate of parsed.candidates) {
      const key = lastName(candidate.name);
      const entry = byName.get(key) ?? { name: candidate.name, party: candidate.party, votes: 0 };
      entry.votes += candidate.votes;
      byName.set(key, entry);
    }
    if (parsed.units?.kind === "precincts") { reporting += parsed.units.reporting; total += parsed.units.total; } else precinctsKnown = false;
  }
  const summary = summarizeReturns(race, { candidates: [...byName.values()], units: precinctsKnown && total ? { reporting, total, kind: "precincts" } : null });
  const dem = counties.reduce((t, c) => t + c.president2024.dem, 0), rep = counties.reduce((t, c) => t + c.president2024.rep, 0), votes2024 = counties.reduce((t, c) => t + c.president2024.total, 0);
  return {
    ...summary,
    counties: counties.map((c) => c.name),
    president2024Margin: votes2024 ? Math.round((1000 * (dem - rep)) / votes2024) / 10 : null,
    share2024: stateTotal2024 ? Math.round((1000 * votes2024) / stateTotal2024) / 1000 : null,
  };
}

/**
 * One state's parsed file, summarized against its race: the challenger (the Democrat, or the independent where an
 * independent is the Republican's main opponent) and the Republican found by last name and party, then last name,
 * then party (Alaska has two Sullivans on the ballot).
 * @param {{ challenger: string|null, challengerParty: "D"|"I", republican: string|null }} race
 * @param {{ candidates: { name: string, party: string, votes: number }[], units?: { reporting: number, total: number, kind: string } | null }} parsed
 */
export function summarizeReturns(race, parsed) {
  const candidates = parsed.candidates.map((c) => ({ name: c.name, party: partyCode(c.party), votes: c.votes })).sort((a, b) => b.votes - a.votes);
  const find = (name, party) => (name && party && candidates.find((c) => lastName(c.name) === lastName(name) && c.party === party))
    ?? (name && candidates.find((c) => lastName(c.name) === lastName(name)))
    ?? (party ? candidates.find((c) => c.party === party) : undefined);
  const challenger = find(race.challenger, race.challengerParty === "D" ? "D" : null);
  const republican = find(race.republican, "R");
  if (challenger) challenger.party = race.challengerParty;
  if (republican) republican.party = "R";
  const total = candidates.reduce((t, c) => t + c.votes, 0);
  return {
    total,
    challengerVotes: challenger?.votes ?? null,
    republicanVotes: republican?.votes ?? null,
    margin: total && challenger && republican ? Math.round((10000 * (challenger.votes - republican.votes)) / total) / 100 : null,
    units: parsed.units ?? null,
    candidates,
  };
}
