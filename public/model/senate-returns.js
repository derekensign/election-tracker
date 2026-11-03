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

/** "DEM", "DFL", "Dem", "Democratic", "REP", "R", … → "D" | "R" | "other". */
function partyCode(raw) {
  const code = String(raw || "").trim().toUpperCase();
  if (["DEM", "D", "DFL", "DEMOCRAT", "DEMOCRATIC"].includes(code)) return "D";
  if (["REP", "R", "GOP", "REPUBLICAN"].includes(code)) return "R";
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

/** Clarity ENR (Iowa, South Carolina, Colorado): summary.json, contests with parallel name, party, and vote arrays. */
export function parseClarity(text, contestPattern) {
  const contest = JSON.parse(withoutBom(text)).find((c) => contestPattern.test(c.C || ""));
  if (!contest) throw new Error("no Senate contest in summary.json");
  return {
    // Some states prefix names with the party code ("DEM Annie Andrews").
    candidates: contest.CH.map((name, i) => ({ name: contest.P?.[i] && name.startsWith(`${contest.P[i]} `) ? name.slice(contest.P[i].length + 1) : name, party: contest.P?.[i] ?? "", votes: number(contest.V?.[i]) })),
    // At the state level these count counties, and a county can report before it has votes.
    units: { reporting: number(contest.PR), total: number(contest.TP), kind: "counties" },
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

/** Delaware: statewide rows by contest. */
export function parseDelaware(text) {
  const rows = JSON.parse(withoutBom(text)).filter((row) => row["Contest Title"] === "U.S. Senator");
  if (!rows.length) throw new Error("no U.S. Senator rows");
  return {
    candidates: rows.map((row) => ({ name: row["Candidate Name"], party: row["Party Name"], votes: number(row["Total Votes"]) })),
    units: { reporting: number(rows[0]["Precincts Reported"]), total: number(rows[0]["Total Precincts"]), kind: "precincts" },
  };
}

/** A Clarity election: read the current version (tiny, never cached), then that version's summary. */
const clarity = (base, contestPattern) => async (get) => parseClarity(await get(`${base}/${(await get(`${base}/current_ver.txt`)).trim()}/json/en/summary.json`), contestPattern);
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
