// One-off: Texas county election offices (Secretary of State directory) + county boundaries for the vote finder.
// Usage: node scripts/build-counties.mjs <county.shtml> <counties-10m.json> [<countywide-polling.shtml>]
import { readFileSync, writeFileSync } from "node:fs";
import * as topojsonClient from "topojson-client";
import * as topojsonServer from "topojson-server";

const [directoryPath, countiesTopoPath, countywidePath] = process.argv.slice(2);

/** Websites for the largest counties, where the office runs its own voter site. Everything else gets the SOS directory. */
const KNOWN_SITES = {
  Harris: "https://www.harrisvotes.com", Dallas: "https://www.dallascountyvotes.org", Tarrant: "https://www.tarrantcountytx.gov/en/elections.html",
  Bexar: "https://www.bexar.org/1568/Elections-Department", Travis: "https://votetravis.gov", Collin: "https://www.collincountytx.gov/elections",
  Denton: "https://www.votedenton.gov", "El Paso": "https://epcountyvotes.com", Williamson: "https://www.wilcotx.gov/elections",
  Galveston: "https://www.galvestonvotes.org", Lubbock: "https://www.votelubbock.org", McLennan: "https://www.mclennanvotes.com",
  Brazos: "https://www.brazosvotes.org", Hays: "https://hayscountytx.gov/elections", Montgomery: "https://www.mctx.org/departments/departments_d_-_f/elections_administration/index.php",
  "Fort Bend": "https://www.fortbendcountytx.gov/government/departments/elections", Hidalgo: "https://www.hidalgocounty.us/105/Elections-Department", Nueces: "https://www.nuecesco.com/county-services/county-clerk/elections",
  Cameron: "https://www.cameroncountytx.gov/elections/", Bell: "https://www.bellcountytx.com/departments/elections_department/index.php", Webb: "https://www.webbcountytx.gov/elections/", Smith: "https://www.smith-county.com/government/departments/elections",
};

const decode = (text) => text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const html = readFileSync(directoryPath, "latin1");
const counties = [];
for (const block of html.matchAll(/<dl>([\s\S]*?)<\/dl>/g)) {
  const dt = block[1].match(/<dt>[\s\S]*?<strong>(?:<a[^>]*><\/a>)?([^<]+)<\/strong>/);
  if (!dt) continue;
  const name = decode(dt[1]).replace(/\s+COUNTY$/i, "").split(" ").map((w) => (w === "DE" || w === "LA" ? w.charAt(0) + w.slice(1).toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase())).join(" ");
  const dds = [...block[1].matchAll(/<dd>([\s\S]*?)<\/dd>/g)].map((m) => ({ raw: m[1], text: decode(m[1]) }));
  const emails = dds.map((d) => (d.raw.match(/mailto:([^"' ]+)/) || [])[1]).filter(Boolean);
  const phone = dds.map((d) => d.text).find((t) => /^\(?\d{3}\)?[ -]?\d{3}-\d{4}/.test(t) && !/FAX/i.test(t)) || null;
  const title = dds[0]?.text || null;
  const official = dds[1]?.text || null;
  const address = dds.slice(2).map((d) => d.text).find((t) => /\d/.test(t) && !/^\(?\d{3}\)/.test(t) && !/FAX|Email|Submit/i.test(t)) || null;
  counties.push({ name, title, official, address, email: emails[0] || null, phone, website: KNOWN_SITES[name] || null });
}
console.log(`parsed ${counties.length} county offices`);

let countywide = new Set();
if (countywidePath) {
  const text = decode(readFileSync(countywidePath, "latin1").replace(/<script[\s\S]*?<\/script>/g, ""));
  for (const county of counties) if (new RegExp(`\\b${county.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) countywide.add(county.name);
  console.log(`countywide polling counties detected: ${countywide.size}`);
}
for (const county of counties) county.countywidePolling = countywide.has(county.name);

const topo = JSON.parse(readFileSync(countiesTopoPath, "utf8"));
const texas = topojsonClient.feature(topo, topo.objects.counties).features.filter((f) => String(f.id).startsWith("48"));
for (const f of texas) f.properties = { fips: String(f.id), name: f.properties.name };
const texasTopo = topojsonServer.topology({ counties: { type: "FeatureCollection", features: texas } }, 1e5);
writeFileSync("public/geo/tx-counties.json", JSON.stringify(texasTopo));
const byName = new Map(texas.map((f) => [f.properties.name.toLowerCase(), f.properties.fips]));
for (const county of counties) county.fips = byName.get(county.name.toLowerCase()) || null;
console.log(`counties without geometry match: ${counties.filter((c) => !c.fips).map((c) => c.name).join(", ") || "none"}`);
writeFileSync("public/data/tx-counties.json", JSON.stringify({ source: "Texas Secretary of State, Election Duties directory (sos.state.tx.us/elections/voter/county.shtml)", retrieved: new Date().toISOString().slice(0, 10), counties }));
console.log(`wrote public/data/tx-counties.json and public/geo/tx-counties.json (${(JSON.stringify(texasTopo).length / 1024).toFixed(0)} KB)`);
