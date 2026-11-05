// Write public/data/tx-legislature-results.json from the Texas Secretary of State's election file: every Texas House
// and Senate race's candidates and votes. The daily build (ingest/build.js) refreshes it each morning; run this to
// refresh it in between.
//   node scripts/build-tx-legislature-results.mjs
import { writeFileSync } from "node:fs";
import { fetchLegislativeResults } from "../ingest/sources/sos-results.js";

const results = await fetchLegislativeResults();
const path = new URL("../public/data/tx-legislature-results.json", import.meta.url);
writeFileSync(path, JSON.stringify({ election: "2026-11-03", fetchedAt: new Date().toISOString(), ...results }));
console.log(`wrote ${Object.keys(results.house).length} House and ${Object.keys(results.senate).length} Senate races (state file updated ${results.lastUpdated})`);
