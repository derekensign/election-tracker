// One-time build of 2022 and 2024 general-election daily early-vote totals for the big counties whose official
// daily reports are still published (the Secretary of State's own daily pages for those years are gone, and
// its old site is behind a bot wall). Each report is downloaded from the county, parsed, and checked: the 12
// daily in-person values must add up to the report's own total. Webb is left out (its 2024 report is a scan).
// Output: public/data/tx-early-vote-2022.json and tx-early-vote-2024.json, the same shape as the 2018 file.
// Run with Node 20+: node scripts/build-early-vote-archive.mjs
import { writeFileSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { fetchResource } from "../ingest/http.js";
import { pdfRows, rowNumbers } from "../ingest/pdf-lines.js";
import { countyKey } from "../ingest/early-vote.js";

/** The row whose text matches `pattern`; returns its numbers (12 daily values, then usually a total). */
async function rowValues(url, pattern, { rowTolerance } = {}) {
  const rows = await pdfRows(await fetchResource(url, { timeoutMs: 90_000 }), { rowTolerance });
  const row = rows.find((r) => pattern.test(r.text) && rowNumbers(r.text).length >= 12);
  if (!row) throw new Error(`no row matching ${pattern} in ${url}`);
  return rowNumbers(row.text);
}
/** Reports with one row per date ("10/24/22 29,194", or Montgomery's "10/24/2022 ... Sub_Total Mail Total"). */
async function dateRows(url, pickValue) {
  const rows = await pdfRows(await fetchResource(url, { timeoutMs: 90_000 }));
  const byDate = new Map();
  for (const row of rows) {
    const m = row.text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
    if (!m) continue;
    const value = pickValue(rowNumbers(row.text.slice(m[0].length)));
    if (value != null) byDate.set(`${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`, value);
  }
  return byDate;
}
/** Tarrant 2024's page is rotated 90°: dates and the county total run down two columns at matching heights. */
async function rotatedTotals(url) {
  const pdf = await getDocument({ data: await fetchResource(url), verbosity: 0 }).promise;
  const { items } = await (await pdf.getPage(1)).getTextContent();
  const cells = items.map((i) => ({ text: i.str.trim(), x: i.transform[4], y: i.transform[5] })).filter((c) => c.text);
  const totalLabel = cells.find((c) => c.text === "Total" && cells.some((d) => /^\d{2}\/\d{2}$/.test(d.text) && Math.abs(d.x - c.x) < 2));
  const dates = cells.filter((c) => /^\d{2}\/\d{2}$/.test(c.text) && Math.abs(c.x - totalLabel.x) < 2);
  const totalColumnX = Math.min(...cells.filter((c) => /^[\d,]+$/.test(c.text) && c.x > totalLabel.x).map((c) => c.x));
  const byDate = new Map();
  for (const date of dates) {
    const value = cells.find((c) => Math.abs(c.x - totalColumnX) < 2 && Math.abs(c.y - date.y) < 6 && /^[\d,]+$/.test(c.text));
    if (value) byDate.set(`2024-${date.text.replace("/", "-")}`, Number(value.text.replace(/,/g, "")));
  }
  await pdf.destroy();
  return byDate;
}
/** First 12 values are the days; if a 13th exists it is the report's total and must match their sum. */
function checkedDays(values, county) {
  const days = values.slice(0, 12);
  const sum = days.reduce((a, b) => a + b, 0);
  if (days.length !== 12) throw new Error(`${county}: expected 12 days, got ${days.length}`);
  if (values.length > 12 && values[12] !== sum) throw new Error(`${county}: days add to ${sum}, report total is ${values[12]}`);
  return days;
}
const inOrder = (byDate, firstDay) => Array.from({ length: 12 }, (_, i) => byDate.get(new Date(Date.parse(firstDay) + i * 86_400_000).toISOString().slice(0, 10)));

const ELECTIONS = {
  2022: {
    firstInPersonDay: "2022-10-24", label: "2022 general (governor, Abbott against O'Rourke)",
    counties: {
      Harris: { url: "https://files.harrisvotes.com/harrisvotes/prd/Reports/End-of-Day_Report_11042022.pdf", read: (u) => rowValues(u, /^Early In Person Voters:/) },
      Tarrant: { url: "https://www.tarrantcountytx.gov/content/dam/main/elections/2022/1122/ev_reports/dailytotals.pdf", read: async (u) => inOrder(await dateRows(u, (n) => (n.length === 1 ? n[0] : null)), "2022-10-24") },
      "El Paso": { url: "https://ep-county-elections-production.s3.amazonaws.com/documents/files/000/004/267/original/EV_stats_Last_Day.pdf", read: (u) => rowValues(u, /^Daily Totals/) },
      Montgomery: { url: "https://elections.mctx.org/pdf/GEN110822/rptEVDaily.pdf", read: async (u) => inOrder(await dateRows(u, (n) => (n.length >= 3 ? n[n.length - 3] : null)), "2022-10-24") },
      Hidalgo: { url: "https://www.hidalgocounty.us/DocumentCenter/View/61190/EV-SUBS", read: (u) => rowValues(u, /^Sub Total/, { rowTolerance: 6 }) },
      Cameron: { url: "https://www.cameroncountytx.gov/elections/wp-content/uploads/2022/11/November_8_2022_General_Elections-turnout-11-04-2022.pdf", read: (u) => rowValues(u, /^TOTAL\b/) },
    },
  },
  2024: {
    firstInPersonDay: "2024-10-21", label: "2024 general (president, Trump against Harris)",
    counties: {
      Tarrant: { url: "https://www.tarrantcountytx.gov/content/dam/main/elections/2024/1124/ev_reports/Early_Voting_Daily_Totals.pdf", read: async (u) => inOrder(await rotatedTotals(u), "2024-10-21") },
      "El Paso": { url: "https://ep-county-elections-production.s3.amazonaws.com/documents/files/000/005/702/original/11052024_Early_Voting_Statistics.pdf", read: (u) => rowValues(u, /^Daily Totals/) },
      Hidalgo: { url: "https://www.hidalgocounty.us/DocumentCenter/View/68875/EV-SUBS", read: (u) => rowValues(u, /^Sub Total/, { rowTolerance: 6 }) },
      Cameron: { url: "https://www.cameroncountytx.gov/elections/wp-content/uploads/2024/11/01_COUNTY_WIDE11-01-2024.pdf", read: (u) => rowValues(u, /^TOTAL\b/) },
      Ellis: { url: "https://www.elliscountytx.gov/DocumentCenter/View/19504", read: (u) => rowValues(u, /^Voting Ballots/, { rowTolerance: 6 }) },
    },
  },
};

for (const [year, election] of Object.entries(ELECTIONS)) {
  const countyDays = {};
  for (const [name, { url, read }] of Object.entries(election.counties)) {
    const values = await read(url);
    if (values.some((v) => v == null)) throw new Error(`${year} ${name}: missing days`);
    countyDays[name] = { url, days: checkedDays(values, `${year} ${name}`) };
    console.log(`${year} ${name.padEnd(10)} day 1 ${countyDays[name].days[0]}, total ${countyDays[name].days.reduce((a, b) => a + b, 0)}`);
  }
  // Same shape as tx-early-vote-2018.json: per day, cumulative in-person by county. No registration or mail.
  const days = Array.from({ length: 12 }, (_, i) => {
    const counties = Object.entries(countyDays).map(([name, { days: values }]) => {
      const cumulative = values.slice(0, i + 1).reduce((a, b) => a + b, 0);
      return { name, key: countyKey(name), registered: null, inPersonOnDate: values[i], inPerson: cumulative, mail: null, ballots: cumulative };
    });
    const sum = (field) => counties.reduce((total, c) => total + c[field], 0);
    return {
      date: new Date(Date.parse(election.firstInPersonDay) + i * 86_400_000).toISOString().slice(0, 10), dayNumber: i + 1,
      total: { name: "Total", registered: null, inPersonOnDate: sum("inPersonOnDate"), inPerson: sum("inPerson"), mail: null, ballots: sum("ballots") },
      counties,
    };
  });
  writeFileSync(`public/data/tx-early-vote-${year}.json`, JSON.stringify({
    source: `County election offices' official daily early-voting reports, ${election.label}`,
    sources: Object.fromEntries(Object.entries(countyDays).map(([name, { url }]) => [name, url])),
    retrieved: new Date().toISOString().slice(0, 10),
    firstInPersonDay: election.firstInPersonDay,
    countyKeys: Object.keys(countyDays).map(countyKey),
    days,
  }));
  console.log(`wrote public/data/tx-early-vote-${year}.json`);
}
