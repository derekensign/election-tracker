// Early-vote turnout straight from county election offices, for big counties whose uploads to the Secretary of
// State lag (on the morning after day 1 the state showed Harris with 4 in-person votes; the county clerk's own
// report showed 104,659). Every reader uses an official, public, aggregate report: counts by day or by site.
// None reads voter-by-voter rosters, and any county behind a bot wall (Dallas, Denton, Williamson, and others)
// is simply not included.
//
// Each reader returns { county, sourceUrl, inPersonByDate?, inPersonThrough?, mail? }:
//   inPersonByDate:  { "2026-10-19": 104659, ... } in-person votes cast ON each date
//   inPersonThrough: { date, inPerson } a cumulative in-person total through `date` (reports without day columns)
//   mail:            cumulative mail ballots received, as of the report
import { fetchResource } from "../http.js";
import { pdfRows, rowNumbers } from "../pdf-lines.js";

const YEAR = 2026;
const FIRST_IN_PERSON_DAY = "2026-10-19";
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (month, day, year = YEAR) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/**
 * Dates in a table header, in column order. Handles "19-Oct", "Oct 19", "10/19", "10/19/26", "10/19/2026".
 * @param {string} text
 * @returns {string[]} ISO dates
 */
export function headerDates(text) {
  const dates = [];
  // Month names are spelled out in the pattern so a site code like "SRD 19" is never read as a date.
  const month = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  const pattern = new RegExp(`(\\d{1,2})-${month}\\b|\\b${month} (\\d{1,2})\\b|\\b(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?\\b`, "gi");
  for (const m of text.matchAll(pattern)) {
    if (m[1]) { const month = MONTHS[m[2].toLowerCase()]; if (month) dates.push(iso(month, Number(m[1]))); }
    else if (m[3]) { const month = MONTHS[m[3].toLowerCase()]; if (month) dates.push(iso(month, Number(m[4]))); }
    else { const year = m[7] ? (m[7].length === 2 ? 2000 + Number(m[7]) : Number(m[7])) : YEAR; dates.push(iso(Number(m[5]), Number(m[6]), year)); }
  }
  return dates;
}

/** Pair a row of day values with header dates: { date: value }, dropping zero days (not voted yet). */
function byDate(dates, values) {
  const result = {};
  dates.forEach((date, index) => { if (values[index] > 0) result[date] = values[index]; });
  return result;
}
const findRow = (rows, pattern) => rows.find((row) => pattern.test(row.text));
const lastNumber = (text) => { const numbers = rowNumbers(text); return numbers.length ? numbers[numbers.length - 1] : null; };
const rowsFromPdf = async (url) => pdfRows(await fetchResource(url));
/** ISO dates from `fromIso` back to the first in-person day, newest first (for per-day file names). */
function datesBackFrom(fromIso) {
  const dates = [];
  for (let ms = Date.parse(fromIso); ms >= Date.parse(FIRST_IN_PERSON_DAY); ms -= 86_400_000) dates.push(new Date(ms).toISOString().slice(0, 10));
  return dates;
}
/** "Check-in Date Range: 10/19/2026 - 10/20/2026" plus "Total N" (Collin and Fort Bend use the same vendor report). */
function checkInSummary(rows) {
  const range = findRow(rows, /Check-in Date Range:/)?.text.match(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/);
  const totalRow = [...rows].reverse().find((row) => /^Total\b/.test(row.text) && rowNumbers(row.text).length);
  if (!range || !totalRow) throw new Error("check-in summary layout not recognized");
  const start = iso(range[1], range[2], range[3]), end = iso(range[4], range[5], range[6]);
  const total = lastNumber(totalRow.text);
  // A report covering the whole period so far is cumulative; a one-day report is that day's count.
  if (start === FIRST_IN_PERSON_DAY) return { inPersonThrough: { date: end, inPerson: total } };
  if (start === end) return { inPersonByDate: { [start]: total } };
  throw new Error(`check-in range ${start} to ${end} is neither cumulative nor one day`);
}
/** The newest link on a page matching `pattern`, chosen by `rank` (higher is newer). */
async function newestLink(pageUrl, pattern, rank) {
  const html = await fetchResource(pageUrl, { as: "text" });
  const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&")).filter((href) => pattern.test(href));
  if (!links.length) throw new Error(`no report link on ${pageUrl}`);
  const best = links.sort((a, b) => rank(b) - rank(a))[0];
  return new URL(best, pageUrl).toString();
}

export const COUNTY_READERS = {
  async Harris() {
    const sourceUrl = "https://appfiles.harrisvotes.com/harrisvotes/prd/docs/Uploads/EVPA_unofficial.pdf";
    const rows = await rowsFromPdf(sourceUrl);
    const dates = headerDates(findRow(rows, /LOCATIONS.*19-Oct/)?.text ?? "");
    const inPerson = findRow(rows, /^Early In-Person Voters:/);
    const mail = findRow(rows, /^Mail Ballots Received:/);
    if (dates.length < 12 || !inPerson) throw new Error("Harris layout not recognized");
    return { sourceUrl, inPersonByDate: byDate(dates, rowNumbers(inPerson.text)), mail: mail ? lastNumber(mail.text) : null };
  },
  async Tarrant() {
    const base = "https://www.tarrantcountytx.gov/content/dam/main/elections/2026/1126/ev_reports/";
    const rows = await rowsFromPdf(`${base}Early_Voting_Daily_Totals.pdf`);
    const headerIndex = rows.findIndex((row) => /^Total( \d{1,2}\/\d{1,2})+$/.test(row.text));
    if (headerIndex === -1) throw new Error("Tarrant layout not recognized");
    const dates = headerDates(rows[headerIndex].text);
    const values = rowNumbers(rows[headerIndex + 1].text).slice(1); // first number is the row total
    let mail = null, mailError = null;
    try {
      const mailRows = await rowsFromPdf(`${base}ABS_Daily_Totals.pdf`);
      const receivedIndex = mailRows.findIndex((row) => /^Absentee Ballots Received/.test(row.text));
      const totalRow = mailRows.slice(receivedIndex + 1).find((row) => /^Total\b/.test(row.text) && rowNumbers(row.text).length);
      mail = receivedIndex === -1 || !totalRow ? null : rowNumbers(totalRow.text)[0];
    } catch (error) { mailError = error.message; }
    return { sourceUrl: `${base}Early_Voting_Daily_Totals.pdf`, inPersonByDate: byDate(dates, values), mail, mailError };
  },
  async Travis() {
    const sourceUrl = "https://votetravis.gov/wp-content/uploads/G26-Daily-Totals.pdf";
    const rows = await rowsFromPdf(sourceUrl);
    const dates = headerDates(findRow(rows, /^19-Oct/)?.text ?? "");
    const inPerson = findRow(rows, /^Early Voting Location Voters/);
    const mail = findRow(rows, /Mail Ballots Received/);
    if (dates.length < 12 || !inPerson) throw new Error("Travis layout not recognized");
    return { sourceUrl, inPersonByDate: byDate(dates, rowNumbers(inPerson.text)), mail: mail ? lastNumber(mail.text) : null };
  },
  async Hidalgo() {
    const sourceUrl = "https://www.hidalgocounty.us/DocumentCenter/View/73361/EV-SUBS";
    const rows = await rowsFromPdf(sourceUrl);
    const dates = headerDates(findRow(rows, /^19-Oct/)?.text ?? "");
    const inPerson = findRow(rows, /^Sub Total\b/);
    const mail = findRow(rows, /^Mail\b/);
    if (dates.length < 12 || !inPerson) throw new Error("Hidalgo layout not recognized");
    return { sourceUrl, inPersonByDate: byDate(dates, rowNumbers(inPerson.text)), mail: mail ? lastNumber(mail.text) : null };
  },
  async Cameron({ asOf }) {
    // One file per update day; take the newest that exists.
    for (const date of datesBackFrom(asOf)) {
      const [y, m, d] = date.split("-");
      const sourceUrl = `https://www.cameroncountytx.gov/elections/wp-content/uploads/${y}/${m}/01_Cameron_County${m}-${d}-${y}.pdf`;
      let rows;
      try { rows = await rowsFromPdf(sourceUrl); } catch { continue; }
      const dates = headerDates(findRow(rows, /^Oct 19 Oct 20/)?.text ?? "");
      const total = findRow(rows, /^TOTAL\b/);
      if (dates.length < 12 || !total) throw new Error("Cameron layout not recognized");
      return { sourceUrl, inPersonByDate: byDate(dates, rowNumbers(total.text)), mail: null };
    }
    throw new Error("no Cameron report found");
  },
  async "El Paso"() {
    const page = "https://epcountyvotestx.gov/voter-information/current-election";
    const dayNumber = (href) => Number(href.match(/Day_(\d+)_/)?.[1] ?? 0);
    const evUrl = await newestLink(page, /Day_\d+_Early_Voting_Statistics\.pdf/, dayNumber);
    const rows = await rowsFromPdf(evUrl);
    const dates = headerDates(findRow(rows, /^10\/19\/26 10\/20\/26/)?.text ?? "");
    const totals = findRow(rows, /^Daily Totals/);
    if (dates.length < 12 || !totals) throw new Error("El Paso layout not recognized");
    let mail = null, mailError = null;
    try {
      const mailRows = await rowsFromPdf(await newestLink(page, /Day_\d+_Ballot_by_Mail_Statistics\.pdf/, dayNumber));
      const returned = findRow(mailRows, /Regresadas\D*\d/); // the title row also says "Regresadas"
      mail = returned ? lastNumber(returned.text) : null;
    } catch (error) { mailError = error.message; }
    return { sourceUrl: evUrl, inPersonByDate: byDate(dates, rowNumbers(totals.text)), mail, mailError };
  },
  async "Fort Bend"() {
    const page = "https://www.fortbendcountytx.gov/government/departments/elections-voter-registration/early-voting-statistics";
    const sourceUrl = await newestLink(page, /Early-Voting-by-Personal-Appearance-Statistics(_\d+)?\.pdf/, (href) => Number(href.match(/_(\d+)\.pdf/)?.[1] ?? 0));
    return { sourceUrl, ...checkInSummary(await rowsFromPdf(sourceUrl)), mail: null };
  },
  async Collin() {
    const page = "https://www.collincountytx.gov/elections/rosters";
    const linkDate = (href) => { const m = href.match(/totals-by-site-through-([a-z]+)-(\d+)-(\d{4})/); return m ? Date.parse(iso(MONTHS[m[1].slice(0, 3)], Number(m[2]), Number(m[3]))) : 0; };
    const sourceUrl = await newestLink(page, /totals-by-site-through-[a-z]+-\d+-\d{4}\.pdf/, linkDate);
    return { sourceUrl, ...checkInSummary(await rowsFromPdf(sourceUrl)), mail: null };
  },
  async Montgomery() {
    const sourceUrl = "https://elections.mctx.org/pdf/GEN110326/rptEVDaily.pdf";
    const rows = await rowsFromPdf(sourceUrl);
    const inPersonByDate = {};
    let mail = 0;
    for (const row of rows) {
      const date = row.text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      const numbers = rowNumbers(row.text);
      if (!date || numbers.length < 3) continue;
      const [subTotal, ballotByMail] = numbers.slice(-3); // ..., Sub_Total, Ballot_by_Mail, TOTAL
      if (subTotal > 0) inPersonByDate[iso(date[1], date[2], date[3])] = subTotal;
      mail += ballotByMail;
    }
    if (!Object.keys(inPersonByDate).length) throw new Error("Montgomery layout not recognized");
    return { sourceUrl, inPersonByDate, mail };
  },
  async Webb() {
    const sourceUrl = "https://www.webbcountytx.gov/DocumentCenter/View/12106";
    const rows = await rowsFromPdf(sourceUrl);
    const inPersonByDate = {};
    let mail = 0;
    for (const row of rows) {
      const date = row.text.match(/^(?:Mon|Tue|Wed|Thur?|Fri|Sat|Sun)\s+(\d{2})\/(\d{2})\/(\d{2})/);
      const numbers = rowNumbers(row.text);
      if (!date || numbers.length < 3) continue;
      const [inPerson, mailIn] = numbers.slice(-3); // ..., Total in Person, Mail-In Ballots, TOTAL VOTED
      if (inPerson > 0) inPersonByDate[iso(date[1], date[2], 2000 + Number(date[3]))] = inPerson;
      mail += mailIn;
    }
    if (!Object.keys(inPersonByDate).length) throw new Error("Webb layout not recognized");
    return { sourceUrl, inPersonByDate, mail };
  },
  async Ellis() {
    const sourceUrl = "https://www.elliscountytx.gov/DocumentCenter/View/24310";
    const rows = await rowsFromPdf(sourceUrl);
    const inPersonByDate = {};
    let mail = 0;
    for (const row of rows) {
      const date = row.text.match(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), ([A-Za-z]+) (\d{1,2}), (\d{4})/);
      const numbers = rowNumbers(row.text.replace(/^[^,]+, [A-Za-z]+ \d{1,2}, \d{4}/, ""));
      if (!date || numbers.length < 6) continue;
      // ..., sites, Total Early Voting In-Person, Total Returned Mail, Provisional, Limited, Grand Total
      const inPerson = numbers[numbers.length - 5], returnedMail = numbers[numbers.length - 4];
      if (inPerson > 0) inPersonByDate[iso(MONTHS[date[1].slice(0, 3).toLowerCase()], Number(date[2]), Number(date[3]))] = inPerson;
      mail += returnedMail;
    }
    if (!Object.keys(inPersonByDate).length) throw new Error("Ellis layout not recognized");
    return { sourceUrl, inPersonByDate, mail };
  },
  async Bell({ asOf }) {
    // One cumulative file per day, named by date; take the newest that exists.
    for (const date of datesBackFrom(asOf)) {
      const sourceUrl = `https://www.bellcountytx.com/elections/Daily%20Postings/${date.replaceAll("-", "")}.PDF`;
      let rows;
      try { rows = await rowsFromPdf(sourceUrl); } catch { continue; }
      const grandTotal = findRow(rows, /^Grand Total:/);
      if (!grandTotal) throw new Error("Bell layout not recognized");
      return { sourceUrl, inPersonThrough: { date, inPerson: lastNumber(grandTotal.text) }, mail: null };
    }
    throw new Error("no Bell report found");
  },
  async Bexar() {
    // Live HTML: "Previous Total Votes" is everything through the day before the page's date.
    const sourceUrl = "https://earlyvotecounts.bexar.org/";
    const html = await fetchResource(sourceUrl, { as: "text" });
    const pageDate = html.match(/BALLOTS CAST THIS DATE\s*(\d{2})\/(\d{2})\/(\d{4})/);
    const cellText = (cell) => cell.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => cellText(c[1])));
    const header = rows.findIndex((cells) => /Previous\s+Total/i.test(cells[2] ?? ""));
    if (!pageDate || header === -1) throw new Error("Bexar layout not recognized");
    const siteRows = rows.slice(header + 1).filter((cells) => cells.length >= 4 && !/^Total/i.test(cells[0]));
    const previousTotal = siteRows.reduce((sum, cells) => sum + (Number(cells[2].replace(/,/g, "")) || 0), 0);
    const dayBefore = new Date(Date.parse(iso(pageDate[1], pageDate[2], pageDate[3])) - 86_400_000).toISOString().slice(0, 10);
    return { sourceUrl, inPersonThrough: { date: dayBefore, inPerson: previousTotal }, mail: null };
  },
};

/**
 * Run every county reader, in parallel, tolerating failures one county at a time.
 * @param {{ asOf: string, log?: (message: string) => void }} options
 * @returns {Promise<{ reports: Array<object>, status: Record<string, { ok: boolean, error?: string }> }>}
 */
export async function fetchCountyReports({ asOf, log = () => {} }) {
  const status = {};
  const results = await Promise.all(Object.entries(COUNTY_READERS).map(async ([county, read]) => {
    try {
      const report = await read({ asOf });
      status[county] = { ok: true, sourceUrl: report.sourceUrl };
      return { county, ...report };
    } catch (error) {
      status[county] = { ok: false, error: error.message };
      log(`county report ${county}: ${error.message}`);
      return null;
    }
  }));
  return { reports: results.filter(Boolean), status };
}
