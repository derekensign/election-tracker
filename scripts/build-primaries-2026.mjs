// One-time build of the March 3, 2026 primary turnout by county and party, the baseline for the early-vote tab's
// primaries check. Source: the Secretary of State's election-night file service (the same feed as the needle),
// Republican primary 53813 and Democratic primary 53814, both certified. Only county totals are read.
//
// A county's ballots in each primary are the votes in its most-voted statewide race (U.S. Senate or governor):
// the file's own "votes cast" field is wrong in places (Travis shows 800,758 Democratic ballots; Bexar's two
// primaries show identical counts), while race totals add up. Undervotes make this a slight undercount for both.
// Output: public/data/tx-primaries-2026.json. Run: node scripts/build-primaries-2026.mjs
import { writeFileSync } from "node:fs";
import { USER_AGENT } from "../ingest/config.js";
import { countyKey } from "../ingest/early-vote.js";

const OUTPUT_PATH = "public/data/tx-primaries-2026.json";
const ENR_URL = "https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr/election/countyInfo";
const PRIMARIES = { dem: { id: 53814, name: "2026 Democratic primary" }, rep: { id: 53813, name: "2026 Republican primary" } };
// U.S. Senate, governor, lieutenant governor, attorney general: every county had at least one contested.
const STATEWIDE_OFFICES = [5075, 3579, 4714, 3];

/** Each county's votes in its most-voted statewide race, for one primary. */
async function primaryBallots(id) {
  const response = await fetch(`${ENR_URL}/${id}`, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!response.ok) throw new Error(`primary ${id}: HTTP ${response.status}`);
  const counties = JSON.parse(Buffer.from((await response.json()).upload, "base64").toString("utf8"));
  const byCounty = new Map();
  for (const county of Object.values(counties)) {
    const ballots = Math.max(0, ...STATEWIDE_OFFICES.map((office) => Number(county.Races?.[office]?.T) || 0));
    byCounty.set(countyKey(county.N), { name: county.N, ballots });
  }
  return byCounty;
}

const [dem, rep] = await Promise.all([primaryBallots(PRIMARIES.dem.id), primaryBallots(PRIMARIES.rep.id)]);
if (dem.size !== 254 || rep.size !== 254) throw new Error(`expected 254 counties, got ${dem.size} and ${rep.size}`);
const counties = [...dem.keys()].map((key) => ({ key, dem: dem.get(key).ballots, rep: rep.get(key)?.ballots ?? 0 }));
const statewide = counties.reduce((t, c) => ({ dem: t.dem + c.dem, rep: t.rep + c.rep }), { dem: 0, rep: 0 });
statewide.demShare = Math.round((statewide.dem / (statewide.dem + statewide.rep)) * 1000) / 1000;
writeFileSync(OUTPUT_PATH, JSON.stringify({
  source: "Texas Secretary of State election-night results, 2026 primaries (certified), county totals",
  retrieved: new Date().toISOString().slice(0, 10),
  method: "Ballots per primary are the votes in each county's most-voted statewide race (U.S. Senate or governor).",
  primaries: PRIMARIES, statewide, counties,
}));
console.log(`wrote ${OUTPUT_PATH}: Democratic ${statewide.dem.toLocaleString()}, Republican ${statewide.rep.toLocaleString()}, ${(100 * statewide.demShare).toFixed(1)}% Democratic`);
