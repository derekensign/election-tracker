import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAlaska, parseClarity, parseEnhancedVoting, parseFlorida, parseKansas, parseMinnesota, parseNorthCarolina, parseOhio, parseResultsAjax, parseResultsCsv, summarizeReturns } from "./senate-returns.js";

// Shapes copied from the states' pre-staged 2026 files, with votes filled in.
const NORTH_CAROLINA = JSON.stringify([
  { cid: "0", cnm: "US SENATE (VOTE FOR 1)", bnm: "Michael Dublin", pty: "GRE", vct: "1000", prt: "500", ptl: "2626" },
  { cid: "0", cnm: "US SENATE (VOTE FOR 1)", bnm: "Roy Cooper", pty: "DEM", vct: "52000", prt: "500", ptl: "2626" },
  { cid: "0", cnm: "US SENATE (VOTE FOR 1)", bnm: "Michael Whatley", pty: "REP", vct: "47000", prt: "500", ptl: "2626" },
  { cid: "1", cnm: "NC SUPREME COURT ASSOCIATE JUSTICE", bnm: "Someone Else", pty: "DEM", vct: "9", prt: "1", ptl: "2626" },
]);
const FLORIDA = [
  "ElectionDate\tPartyCode\tPartyName\tRaceCode\tRaceName\tCountyCode\tCountyName\tJuris1num\tJuris2num\tPrecincts\tPrecinctsReporting\tCanNameLast\tCanNameFirst\tCanNameMiddle\tCanVotes",
  "11/03/2026\tREP\tRepublican Party\tUSS\tUnited States Senator\tALA\tAlachua\t \t \t63\t10\tMoody\tAshley\t\t300",
  "11/03/2026\tDEM\tDemocratic Party\tUSS\tUnited States Senator\tALA\tAlachua\t \t \t63\t10\tNixon\tAngie\t\t500",
  "11/03/2026\tNPA\tNo Party Affiliation\tUSS\tUnited States Senator\tALA\tAlachua\t \t \t63\t10\tGillespie\tNeil\t\t20",
  "11/03/2026\tREP\tRepublican Party\tUSS\tUnited States Senator\tBAK\tBaker\t \t \t9\t9\tMoody\tAshley\t\t700",
  "11/03/2026\tDEM\tDemocratic Party\tUSS\tUnited States Senator\tBAK\tBaker\t \t \t9\t9\tNixon\tAngie\t\t200",
  "11/03/2026\tNPA\tNo Party Affiliation\tUSS\tUnited States Senator\tBAK\tBaker\t \t \t9\t9\tGillespie\tNeil\t\t10",
  "11/03/2026\tREP\tRepublican Party\tGOV\tGovernor\tBAK\tBaker\t \t \t9\t9\tDonalds\tByron\t\t999",
].join("\n");
const MINNESOTA = [
  "MN;;;0102;U.S. Senator;;1001;Marisa Simonetti;;;IND;100;4105;500;0.50;100000",
  "MN;;;0102;U.S. Senator;;0403;Peggy Flanagan;;;DFL;100;4105;51000;51.00;100000",
  "MN;;;0102;U.S. Senator;;0304;Michele Tafoya;;;R;100;4105;48000;48.00;100000",
  "MN;;;0102;U.S. Senator;;9901;WRITE-IN;;;WI;100;4105;500;0.50;100000",
].join("\n");
const race = (challenger, republican, challengerParty = "D") => ({ challenger, challengerParty, republican });

test("North Carolina: the Senate contest only, with precincts", () => {
  const summary = summarizeReturns(race("Roy Cooper", "Michael Whatley"), parseNorthCarolina(NORTH_CAROLINA));
  assert.equal(summary.total, 100000);
  assert.equal(summary.margin, 5);
  assert.deepEqual(summary.units, { reporting: 500, total: 2626, kind: "precincts" });
  assert.equal(summary.candidates[0].name, "Roy Cooper");
});

test("Florida: counties summed, each county's precincts counted once, other races ignored", () => {
  const parsed = parseFlorida(FLORIDA);
  assert.deepEqual(parsed.units, { reporting: 19, total: 72, kind: "precincts" });
  const summary = summarizeReturns(race("Angie Nixon", "Ashley Moody"), parsed);
  assert.equal(summary.total, 1730);
  assert.equal(summary.challengerVotes, 700);
  assert.equal(summary.republicanVotes, 1000);
  assert.equal(summary.margin, -17.34);
});

test("Minnesota: DFL counts as the Democrat", () => {
  const summary = summarizeReturns(race("Peggy Flanagan", "Michele Tafoya"), parseMinnesota(MINNESOTA));
  assert.equal(summary.margin, 3);
  assert.equal(summary.candidates.find((c) => c.name === "Peggy Flanagan").party, "D");
});

test("Clarity: the party prefix is stripped, and progress counts counties", () => {
  const summary = JSON.stringify([
    { C: "U.S.  Senate", CH: ["REP Darline Graham", "DEM Annie Andrews", "Write-In"], P: ["REP", "DEM", ""], V: [480, 500, 20], PR: 12, TP: 46 },
    { C: "Governor", CH: ["REP X"], P: ["REP"], V: [9], PR: 1, TP: 46 },
  ]);
  const parsed = parseClarity(summary, /^U\.?\s*S\.?\s+Senate$/i);
  assert.deepEqual(parsed.units, { reporting: 12, total: 46, kind: "counties" });
  assert.equal(summarizeReturns(race("Annie Andrews", "Darline Graham"), parsed).margin, 2);
});

test("Enhanced Voting: English names, without the incumbent and party tags", () => {
  const data = JSON.stringify({ ballotItems: [
    { name: [{ languageId: "en", text: "State Senate - District 1" }], summaryResults: { ballotOptions: [] } },
    { name: [{ languageId: "en", text: "US Senate" }], reportingStatus: { reportingUnits: 40, totalUnits: 159 }, summaryResults: { ballotOptions: [
      { name: [{ languageId: "en", text: "Mike Collins (Rep)" }], party: { abbreviation: "Rep" }, voteCount: 450 },
      { name: [{ languageId: "en", text: "Jon Ossoff (I) (Dem)" }], party: { abbreviation: "Dem" }, voteCount: 550 },
    ] } },
  ] });
  const parsed = parseEnhancedVoting(data, /^US Senate$/i);
  assert.deepEqual(parsed.candidates.map((c) => c.name), ["Mike Collins", "Jon Ossoff"]);
  assert.equal(summarizeReturns(race("Jon Ossoff", "Mike Collins"), parsed).margin, 10);
});

test("Alaska: names flipped to first-last, and the Republican Sullivan, not the other one", () => {
  const statewide = JSON.stringify({
    contestNames: ["Governor", "U.S. Senator"],
    candidateNames: ["Heikes, Gerald L. (REP)", "Peltola, Mary (DEM)", "Sullivan, Daniel J. Jr.", "Sullivan, Dan S. (REP)"],
    totals: [{ n: 1, r: 100, p: 403, c: [{ n: 0, t: 50 }, { n: 1, t: 470 }, { n: 2, t: 30 }, { n: 3, t: 450 }] }],
  });
  const summary = summarizeReturns(race("Mary Peltola", "Dan S. Sullivan"), parseAlaska(statewide));
  assert.equal(summary.republicanVotes, 450);
  assert.equal(summary.margin, 2);
  assert.ok(summary.candidates.some((c) => c.name === "Mary Peltola"));
});

test("Ohio and the ResultsAjax service: counties summed, each county's precincts once", () => {
  const ohio = JSON.stringify({ contestList: [
    { reportedPrecincts: 10, totalPrecincts: 20, candidatesRunning: [{ primaryCandidate: "Sherrod Brown", candidateParty: "D", vCount: 300 }, { primaryCandidate: "Jon Husted", candidateParty: "R", vCount: 200 }] },
    { reportedPrecincts: 5, totalPrecincts: 5, candidatesRunning: [{ primaryCandidate: "Sherrod Brown", candidateParty: "D", vCount: 100 }, { primaryCandidate: "Jon Husted", candidateParty: "R", vCount: 400 }] },
  ] });
  const parsedOhio = parseOhio(ohio);
  assert.deepEqual(parsedOhio.units, { reporting: 15, total: 25, kind: "precincts" });
  assert.equal(summarizeReturns(race("Sherrod Brown", "Jon Husted"), parsedOhio).margin, -20);
  const ajax = JSON.stringify({ d: [
    { CandidateID: 1, calcCandidate: "Mike  Rounds", PartyCode: "REP", calcCandidateVotes: 600, CountyID: 1, PrecinctsReporting: 3, TotalPrecincts: 4 },
    { CandidateID: 2, calcCandidate: "Brian L Bengs", PartyCode: "IND", calcCandidateVotes: 400, CountyID: 1, PrecinctsReporting: 3, TotalPrecincts: 4 },
  ] });
  const summary = summarizeReturns(race("Brian L Bengs", "Mike Rounds", "I"), parseResultsAjax(ajax));
  assert.equal(summary.margin, -20);
  assert.deepEqual(summary.units, { reporting: 3, total: 4, kind: "precincts" });
});

test("Nebraska's CSV: Excel-escaped progress and doubled spaces", () => {
  const csv = 'RaceName,CandidateName,PartyCode,CandidateVotes,PrecinctsReporting,\n"For United States Senator - 6  Year Term","Pete  Ricketts",REP,480,"=""200/1322""",\n"For United States Senator - 6  Year Term","Dan Osborn",PET,520,"=""200/1322""",\n"For Governor","X",REP,1,"=""1/1""",';
  const parsed = parseResultsCsv(csv, /United States Senator/i);
  assert.deepEqual(parsed.units, { reporting: 200, total: 1322, kind: "precincts" });
  assert.equal(summarizeReturns(race("Dan Osborn", "Pete Ricketts", "I"), parsed).margin, 4);
});

test("Kansas's HTML block", () => {
  const html = "<h3>United States Senate</h3><p>Precincts Reporting: 1,200 of 4,168</p><div class='col-6'>\n<p>D-Adam Hamilton</p>\n</div>\n<div class='col-2'>\n<p>51,000</p><div class='col-6'>\n<p>R-Roger Marshall</p>\n</div>\n<div class='col-2'>\n<p>49,000</p><div class='col-6'>\n<p>Total Votes</p>\n</div>\n<div class='col-2'>\n<p>100,000</p><!-- end of .race-candidate-list -->";
  const parsed = parseKansas(html);
  assert.deepEqual(parsed.units, { reporting: 1200, total: 4168, kind: "precincts" });
  assert.equal(summarizeReturns(race("Adam Hamilton", "Roger Marshall"), parsed).margin, 2);
});

test("An independent challenger is found by name, whatever the file calls the party", () => {
  const parsed = { candidates: [{ name: "Pete Ricketts", party: "REP", votes: 480 }, { name: "Dan Osborn", party: "NP", votes: 520 }], units: null };
  const summary = summarizeReturns(race("Dan Osborn", "Pete Ricketts", "I"), parsed);
  assert.equal(summary.margin, 4);
  assert.equal(summary.candidates[0].party, "I");
});

test("No votes yet: no margin", () => {
  const empty = NORTH_CAROLINA.replace(/"vct":"\d+"/g, '"vct":"0"');
  assert.equal(summarizeReturns(race("Roy Cooper", "Michael Whatley"), parseNorthCarolina(empty)).margin, null);
});

test("Wikipedia's infobox: live counts once editors fill them in, nothing before, commented-out fields ignored", async () => {
  const { parseWikipediaInfobox, wikipediaReturns } = await import("./senate-returns.js");
  const page = (reporting, votes) => `Intro {{Infobox election
| election_name = 2026 United States Senate election in Maine
| ongoing = yes
${reporting == null ? "<!--\n| reporting = 0\n-->" : `| reporting = ${reporting}`}
| last_update = 9:42 PM
| time_zone = [[Eastern Standard Time|EST]]
| nominee1 = [[Susan Collins]]
| party1 = Republican Party (United States)
| popular_vote1 = ${votes[0]}
| percentage1 =
| nominee2 = [[Troy Jackson]] <!-- note -->(replacing [[Graham Platner]])
| party2 = Democratic Party (United States)
| popular_vote2 = ${votes[1]}<ref>{{cite web|title=AP}}</ref>
}}
Body.`;
  assert.equal(parseWikipediaInfobox(page(null, ["", ""])), null);
  const parsed = parseWikipediaInfobox(page("45%", ["'''150,000'''", "160,000"]));
  assert.deepEqual(parsed.units, { reporting: 45, total: 100, kind: "percent" });
  assert.equal(parsed.lastUpdate, "9:42 PM EST");
  const races = [{ state: "ME", stateName: "Maine", special: false, challenger: "Troy Jackson", challengerParty: "D", republican: "Susan Collins" }];
  const response = { query: { pages: [{ title: "2026 United States Senate election in Maine", revisions: [{ timestamp: "2026-11-04T02:43:00Z", slots: { main: { content: page("45", ["150,000", "160,000"]) } } }] }] } };
  const { ME } = wikipediaReturns(races, response, "2026-11-04T02:44:00Z");
  assert.equal(ME.unofficial, true);
  assert.equal(ME.margin, 3.23);
  assert.equal(ME.candidates[0].name, "Troy Jackson");
});

test("Merging counts: a current official file wins, Wikipedia fills gaps and failed files", async () => {
  const { mergeReturns } = await import("./senate-returns.js");
  const merged = mergeReturns(
    { NC: { total: 10 }, VA: { total: 5, stale: true } },
    { NC: { total: 99, unofficial: true }, VA: { total: 7, unofficial: true }, ME: { total: 3, unofficial: true } },
  );
  assert.equal(merged.NC.total, 10);
  assert.equal(merged.VA.total, 7);
  assert.equal(merged.ME.total, 3);
});

test("The Pi relay: a fresh relayed file is parsed like any state's; a stale or broken one gives nothing", async () => {
  const { relayReturns } = await import("./senate-returns.js");
  const races = [{ state: "OH", stateName: "Ohio", special: true, challenger: "Sherrod Brown", challengerParty: "D", republican: "Jon Husted" }];
  const body = JSON.stringify({ contestList: [{ reportedPrecincts: 10, totalPrecincts: 20, candidatesRunning: [{ primaryCandidate: "Sherrod Brown", candidateParty: "D", vCount: 550 }, { primaryCandidate: "Jon Husted", candidateParty: "R", vCount: 450 }] }] });
  const relay = (relayedAt, file) => ({ kind: "senate-relay", relayedAt, files: { OH: file } });
  const now = Date.parse("2026-11-04T01:00:00Z");
  const fresh = relayReturns(races, relay("2026-11-04T00:58:00Z", { status: 200, body, fetchedAt: "2026-11-04T00:58:00Z" }), { now });
  assert.equal(fresh.OH.margin, 10);
  assert.equal(fresh.OH.relayed, true);
  assert.deepEqual(relayReturns(races, relay("2026-11-04T00:40:00Z", { status: 200, body }), { now }), {});
  assert.deepEqual(relayReturns(races, relay("2026-11-04T00:59:00Z", { status: 403, error: "HTTP 403" }), { now }), {});
  assert.deepEqual(relayReturns(races, relay("2026-11-04T00:59:00Z", { status: 200, body: "<html>" }), { now }), {});
});

test("Big counties: candidates matched by last name across formats, precincts summed, 2024 margin of the same counties", async () => {
  const { combineCounties } = await import("./senate-returns.js");
  const race = { challenger: "Abdul El-Sayed", challengerParty: "D", republican: "Mike Rogers" };
  const combined = combineCounties(race, [
    { name: "Oakland", parsed: { candidates: [{ name: "Abdul El-Sayed", party: "DEM", votes: 600 }, { name: "Mike Rogers", party: "REP", votes: 400 }], units: { reporting: 10, total: 100, kind: "precincts" } }, president2024: { dem: 550, rep: 430, total: 1000 } },
    { name: "Macomb", parsed: { candidates: [{ name: "EL-SAYED, ABDUL", party: "DEM", votes: 400 }, { name: "ROGERS, MIKE", party: "REP", votes: 600 }], units: { reporting: 5, total: 50, kind: "precincts" } }, president2024: { dem: 400, rep: 580, total: 1000 } },
  ], 10000);
  assert.equal(combined.total, 2000);
  assert.equal(combined.margin, 0);
  assert.deepEqual(combined.units, { reporting: 15, total: 150, kind: "precincts" });
  assert.equal(combined.president2024Margin, -3);
  assert.equal(combined.share2024, 0.2);
  assert.deepEqual(combined.counties, ["Oakland", "Macomb"]);
});

test("a state page's winner: filled after_election and after_party; blank or placeholder means no call", async () => {
  const { parseWikipediaWinner } = await import("./senate-returns.js");
  const page = (after, party) => `{{Infobox election\n| election_name = x\n| before_election = [[Jon Husted]]\n| after_election = ${after}\n| after_party = ${party}\n}}`;
  assert.deepEqual(parseWikipediaWinner(page("[[Sherrod Brown]]", "Democratic Party (United States)")), { name: "Sherrod Brown", party: "D" });
  assert.deepEqual(parseWikipediaWinner(page("[[Dan Osborn]]", "Independent politician")), { name: "Dan Osborn", party: "I" });
  assert.equal(parseWikipediaWinner(page("", "")), null);
  assert.equal(parseWikipediaWinner(page("TBD", "")), null);
  assert.equal(parseWikipediaWinner(`{{Infobox election\n<!--\n| after_election = [[Sherrod Brown]]\n-->\n}}`), null);
});
