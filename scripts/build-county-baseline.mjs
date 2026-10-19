// One-time build of the 2024 presidential result for every Texas county, the baseline the early-vote
// projection compares against. Source: the "By county" table on Wikipedia's 2024 Texas presidential page,
// which cites the Texas Secretary of State's canvass. Run: node scripts/build-county-baseline.mjs
import { writeFileSync } from "node:fs";
import { USER_AGENT } from "../ingest/config.js";
import { countyKey } from "../ingest/early-vote.js";

const PAGE_TITLE = "2024_United_States_presidential_election_in_Texas";
const OUTPUT_PATH = "public/data/tx-county-2024.json";

const response = await fetch(`https://en.wikipedia.org/w/index.php?title=${PAGE_TITLE}&action=raw`, { headers: { "User-Agent": USER_AGENT } });
if (!response.ok) throw new Error(`Wikipedia HTTP ${response.status}`);
const wikitext = await response.text();

// Isolate the table that follows the "By county" heading. Its close "|}" can share a line with other markup.
const headingIndex = wikitext.indexOf("====By county====");
if (headingIndex === -1) throw new Error("By county section not found");
const tableText = wikitext.slice(headingIndex, wikitext.indexOf("\n|}", headingIndex));

const counties = [];
for (const rowText of tableText.split(/\n\|-[^\n]*/).slice(1)) {
  // Each data cell is "| {{party shading/X}} |value"; keep what follows the last pipe on each line.
  const cells = rowText.split("\n").filter((line) => line.startsWith("|")).map((line) => line.slice(line.lastIndexOf("|") + 1).trim());
  const countyLink = rowText.match(/\[\[([^|\]]+?) County, Texas\|([^\]]+)\]\]/);
  if (!countyLink || cells.length < 10) continue;
  const toNumber = (text) => Number(String(text).replace(/[^0-9.-]/g, ""));
  // Column order: county, Trump #, Trump %, Harris #, Harris %, other #, other %, margin #, margin %, total.
  const [, trumpVotes, , harrisVotes, , otherVotes, , , , totalVotes] = cells.map((cell, index) => (index === 0 ? cell : toNumber(cell)));
  counties.push({
    name: countyLink[2].trim(),
    key: countyKey(countyLink[2]),
    trump: trumpVotes, harris: harrisVotes, other: otherVotes, total: totalVotes,
    // D-minus-R margin in percentage points of all votes cast, the sign convention used across the app.
    margin: Math.round(((harrisVotes - trumpVotes) / totalVotes) * 1000) / 10,
  });
}

if (counties.length !== 254) throw new Error(`expected 254 counties, parsed ${counties.length}`);
const statewide = counties.reduce((sum, c) => ({ trump: sum.trump + c.trump, harris: sum.harris + c.harris, total: sum.total + c.total }), { trump: 0, harris: 0, total: 0 });
writeFileSync(OUTPUT_PATH, JSON.stringify({
  source: `Wikipedia, ${PAGE_TITLE.replaceAll("_", " ")} (By county table, citing the Texas Secretary of State canvass)`,
  retrieved: new Date().toISOString().slice(0, 10),
  statewide: { ...statewide, margin: Math.round(((statewide.harris - statewide.trump) / statewide.total) * 1000) / 10 },
  counties,
}));
console.log(`wrote ${OUTPUT_PATH}: ${counties.length} counties, statewide`, statewide, `margin ${((statewide.harris - statewide.trump) / statewide.total * 100).toFixed(2)}`);
