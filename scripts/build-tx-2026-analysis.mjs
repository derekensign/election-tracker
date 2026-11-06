// Writes public/data/tx-2026-analysis.json, the "How Texas flipped" page's data (ingest/texas-2026-analysis.js).
// The daily build refreshes it too; run this to refresh it by hand: node scripts/build-tx-2026-analysis.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTexas2026Analysis } from "../ingest/texas-2026-analysis.js";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const analysis = await buildTexas2026Analysis(dataDir);
writeFileSync(join(dataDir, "tx-2026-analysis.json"), JSON.stringify(analysis));
const senate = analysis.swing["tx-senate"].decomposition;
console.log(`wrote tx-2026-analysis.json: ${analysis.counties.length} counties, state file updated ${analysis.lastUpdated}; Senate swing ${senate.swing} = ${senate.steps.map((step) => `${step.key} ${step.value}`).join(" + ")}`);
