// One-time build of the 2018 general election's daily early-vote totals, the day-by-day benchmark for 2026.
// Source: the Texas Secretary of State's 2018 daily pages (sos.state.tx.us/elections/earlyvoting/2018/), which
// cover the 30 counties with the most registered voters (about four in five registered Texans).
// Output: public/data/tx-early-vote-2018.json. Run: node scripts/build-early-vote-2018.mjs
import { writeFileSync } from "node:fs";
import { USER_AGENT } from "../ingest/config.js";
import { countyKey } from "../ingest/early-vote.js";

const BASE_URL = "https://www.sos.state.tx.us/elections/earlyvoting/2018/";
// In-person early voting ran Monday October 22 through Friday November 2, 2018: twelve days.
const PAGES = ["oct22", "oct23", "oct24", "oct25", "oct26", "oct27", "oct28", "oct29", "oct30", "oct31", "nov1", "nov2"];
const MONTH_NUMBER = { oct: "10", nov: "11" };

/** Strip tags and entities from one table cell. */
function cellText(cellHtml) {
  return cellHtml.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

/**
 * Parse one daily page: County, Reg Voters, # In Person On date, Cumulative In-Person, Cumulative % In-Person,
 * Cumulative By Mail, Cumulative % by Mail, Cumulative In-Person And Mail, Cumulative Percent Early Voting.
 * @param {string} pageHtml
 */
export function parseDailyPage(pageHtml) {
  const rows = [...pageHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => [...match[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => cellText(cell[1])));
  const header = rows.find((cells) => cells[0] === "County");
  if (!header || !/Cumulative In-Person Voters/i.test(header[3]) || !/Cumulative By Mail/i.test(header[5])) throw new Error("unexpected table header");
  const toNumber = (text) => Number(String(text).replace(/[^0-9]/g, ""));
  const counties = [];
  let total = null;
  for (const cells of rows) {
    if (cells.length < 8 || cells[0] === "County") continue;
    const row = { name: cells[0], registered: toNumber(cells[1]), inPersonOnDate: toNumber(cells[2]), inPerson: toNumber(cells[3]), mail: toNumber(cells[5]), ballots: toNumber(cells[7]) };
    if (/^total$/i.test(cells[0])) total = row; else counties.push({ ...row, key: countyKey(cells[0]) });
  }
  return { counties, total };
}

const days = [];
for (const [index, page] of PAGES.entries()) {
  const response = await fetch(`${BASE_URL}${page}.shtml`, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${page}: HTTP ${response.status}`);
  const { counties, total } = parseDailyPage(await response.text());
  if (counties.length !== 30) throw new Error(`${page}: expected 30 counties, got ${counties.length}`);
  // The page's own total row should equal the sum of its counties. The SOS pages themselves are off by a
  // handful of ballots on some days (10 of 1.98 million on October 25), so allow 0.01% and use the county sum.
  const ballotSum = counties.reduce((sum, c) => sum + c.ballots, 0);
  if (!total || Math.abs(total.ballots - ballotSum) / ballotSum > 0.0001) throw new Error(`${page}: county ballots ${ballotSum} do not match the total row ${total?.ballots}`);
  const sumOf = (field) => counties.reduce((sum, c) => sum + c[field], 0);
  total.totalRowBallots = total.ballots;
  Object.assign(total, { registered: sumOf("registered"), inPersonOnDate: sumOf("inPersonOnDate"), inPerson: sumOf("inPerson"), mail: sumOf("mail"), ballots: ballotSum });
  const [, monthName, dayOfMonth] = page.match(/^([a-z]+)(\d+)$/);
  days.push({ date: `2018-${MONTH_NUMBER[monthName]}-${dayOfMonth.padStart(2, "0")}`, dayNumber: index + 1, total, counties });
  console.log(`${page}: day ${index + 1}, ${total.ballots.toLocaleString()} cumulative ballots in the 30 counties`);
  await new Promise((resolve) => setTimeout(resolve, 400)); // be gentle with the SOS server
}

writeFileSync("public/data/tx-early-vote-2018.json", JSON.stringify({
  source: "Texas Secretary of State, 2018 Early Voting daily cumulative totals (30 largest counties)",
  sourceUrl: `${BASE_URL}index.shtml`,
  retrieved: new Date().toISOString().slice(0, 10),
  firstInPersonDay: "2018-10-22",
  countyKeys: days[0].counties.map((c) => c.key),
  days,
}));
console.log("wrote public/data/tx-early-vote-2018.json");
