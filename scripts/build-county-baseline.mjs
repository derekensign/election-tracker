// One-time build of past Texas county results, the baselines the early-vote comparisons use.
// Source: the "By county" tables on each race's Wikipedia page (which cite the Secretary of State canvass).
// Output: public/data/tx-county-baselines.json. Run: node scripts/build-county-baseline.mjs
import { writeFileSync } from "node:fs";
import { USER_AGENT } from "../ingest/config.js";
import { countyKey } from "../ingest/early-vote.js";

const OUTPUT_PATH = "public/data/tx-county-baselines.json";

/** Each race, with its official statewide totals so a parsing slip fails loudly instead of shipping. */
const ELECTIONS = [
  { id: "2024", label: "2024 president", office: "President", democrat: "Harris", republican: "Trump", page: "2024_United_States_presidential_election_in_Texas", expected: { republican: 6393597, democrat: 4835250 } },
  { id: "2022", label: "2022 governor", office: "Governor", democrat: "O'Rourke", republican: "Abbott", page: "2022_Texas_gubernatorial_election", expected: { republican: 4437099, democrat: 3553656 } },
  { id: "2018", label: "2018 U.S. Senate", office: "U.S. Senate", democrat: "O'Rourke", republican: "Cruz", page: "2018_United_States_Senate_election_in_Texas", expected: { republican: 4260553, democrat: 4045632 } },
];

/**
 * Parse a "By county" results table. Every Texas table used here has the same column order:
 * county, R votes, R %, D votes, D %, other votes, other %, margin votes, margin %, total votes.
 * Rows come in two layouts: one cell per line ("| attrs |value") or one row per line ("cell||cell||...").
 * @param {string} wikitext
 * @returns {Array<{ name: string, key: string, republican: number, democrat: number, total: number, margin: number }>}
 */
export function parseCountyResultsTable(wikitext) {
  const headingIndex = wikitext.indexOf("====By county====");
  if (headingIndex === -1) throw new Error("By county section not found");
  // The results table is the one containing the first county link; a legend table can come before it.
  const firstCountyIndex = wikitext.indexOf("County, Texas|", headingIndex);
  const tableStart = wikitext.lastIndexOf("{|", firstCountyIndex);
  const tableText = wikitext.slice(tableStart, wikitext.indexOf("\n|}", firstCountyIndex));
  const counties = [];
  for (const rowText of tableText.split(/\n\|-[^\n]*/).slice(1)) {
    const countyLink = rowText.match(/\[\[([^|\]]+?) County, Texas\|([^\]]+)\]\]/);
    if (!countyLink) continue;
    // Replace links with their label so the pipes inside [[...|...]] don't split cells, then split on
    // both cell separators and keep the text after any "attributes |" prefix.
    const flattened = rowText.replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, "$1").replace(/'''/g, "");
    const cells = flattened.split(/\n\||\|\|/).map((cell) => cell.replace(/^\|/, "")).map((cell) => cell.slice(cell.lastIndexOf("|") + 1).trim()).filter((cell, index) => index > 0 || cell);
    const numbers = cells.map((cell) => Number(cell.replace(/[^0-9.-]/g, "")));
    if (cells.length < 10) continue;
    const republican = numbers[1], democrat = numbers[3], total = numbers[9];
    counties.push({ name: countyLink[2].trim(), key: countyKey(countyLink[2]), republican, democrat, total, margin: Math.round(((democrat - republican) / total) * 1000) / 10 });
  }
  return counties;
}

const output = { source: "Wikipedia county results tables, citing the Texas Secretary of State canvass", retrieved: new Date().toISOString().slice(0, 10), elections: {} };
for (const election of ELECTIONS) {
  const response = await fetch(`https://en.wikipedia.org/w/index.php?title=${election.page}&action=raw`, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${election.page}: HTTP ${response.status}`);
  const counties = parseCountyResultsTable(await response.text());
  if (counties.length !== 254) throw new Error(`${election.id}: expected 254 counties, parsed ${counties.length}`);
  const statewide = counties.reduce((sum, c) => ({ republican: sum.republican + c.republican, democrat: sum.democrat + c.democrat, total: sum.total + c.total }), { republican: 0, democrat: 0, total: 0 });
  // Some tables cite unofficial returns (the 2022 one cites NBC), so allow a small gap from the official
  // canvass but record it. More than 0.2% means the parse went wrong.
  const gapFromOfficial = { republican: statewide.republican - election.expected.republican, democrat: statewide.democrat - election.expected.democrat };
  for (const party of ["republican", "democrat"]) {
    if (Math.abs(gapFromOfficial[party]) / election.expected[party] > 0.002) {
      throw new Error(`${election.id}: ${party} county sum ${statewide[party]} is more than 0.2% from the official ${election.expected[party]}`);
    }
  }
  statewide.gapFromOfficial = gapFromOfficial;
  statewide.margin = Math.round(((statewide.democrat - statewide.republican) / statewide.total) * 1000) / 10;
  const { expected, ...meta } = election;
  output.elections[election.id] = { ...meta, source: `https://en.wikipedia.org/wiki/${election.page}`, statewide, counties };
  console.log(`${election.id}: 254 counties, ${election.republican} ${statewide.republican.toLocaleString()} / ${election.democrat} ${statewide.democrat.toLocaleString()} / total ${statewide.total.toLocaleString()}, margin ${statewide.margin}`);
}
writeFileSync(OUTPUT_PATH, JSON.stringify(output));
console.log(`wrote ${OUTPUT_PATH}`);
