// Texas Secretary of State early-voting turnout, from the public file service behind the SOS "Early Voting
// Turnout (current)" app (goelect.txelections.civixapps.com/ivis-evr-ui/evr, linked from
// sos.texas.gov/elections/historical). Each file is JSON whose `upload` field is base64-encoded JSON.
// Only county totals are read. The same service also offers a voter-by-voter roster (type EVR_STATEWIDE)
// with names and voter IDs; this tracker never requests it.
import { fetchJson, sequential } from "../http.js";

const FILE_SERVICE_URL = "https://goelect.txelections.civixapps.com/api-ivis-system/api/v1/getFile";

/**
 * Fetch one file from the SOS file service and decode its base64 `upload` payload.
 * @param {Record<string, string|number>} parameters query string, e.g. { type: "EVR_ELECTION" }
 * @returns {Promise<object|null>} decoded JSON, or null when the service has no file for those parameters
 */
async function fetchDecodedFile(parameters) {
  const url = `${FILE_SERVICE_URL}?${new URLSearchParams(Object.entries(parameters).map(([k, v]) => [k, String(v)]))}`;
  const wrapper = await fetchJson(url, { timeoutMs: 45_000 }).catch((error) => {
    // The service answers an empty 200 body for dates with no file yet, which fetchJson reports as a parse error.
    if (error instanceof SyntaxError) return null;
    throw error;
  });
  if (!wrapper?.upload) return null;
  return JSON.parse(Buffer.from(wrapper.upload, "base64").toString("utf8").trim());
}

/** "10/19/2026" to "2026-10-19". */
function isoFromSlashDate(slashDate) {
  const [month, day, year] = slashDate.split("/");
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * Find the election and pull county turnout for every early-voting date up to `asOf`.
 * Each date's file holds cumulative totals as of that date, so the last file is the current picture and the
 * earlier ones give the daily series.
 * @param {{ electionDate: string, asOf: string }} options electionDate as "MM/DD/YYYY", asOf as "YYYY-MM-DD"
 */
export async function fetchEarlyVoteTurnout({ electionDate, asOf }) {
  const electionList = await fetchDecodedFile({ type: "EVR_ELECTION" });
  const election = electionList?.elections?.find((e) => e.election_date === electionDate && /GENERAL/i.test(e.election_name));
  if (!election) throw new Error(`no SOS early-voting election found for ${electionDate}`);
  const reportDates = (election.early_voting_dates || []).map((d) => d.date).filter((d) => isoFromSlashDate(d) <= asOf);
  const reports = await sequential(reportDates, async (slashDate) => {
    const report = await fetchDecodedFile({ type: "EVR_EARLYVOTING", electionId: election.id, electionDate: slashDate });
    if (!report?.turnout_by_county) return null;
    return {
      date: isoFromSlashDate(slashDate),
      updated: report.date_updated ?? null,
      counties: report.turnout_by_county.map((county) => ({
        name: county.name,
        registered: county.registered_voters ?? null,
        inPersonOnDate: county.in_person_votes_on_date ?? 0,
        inPerson: county.total_in_person_votes_for_election ?? 0,
        mail: county.total_mail_votes_for_election ?? 0,
      })),
    };
  }, { gapMs: 300 });
  return {
    electionId: election.id,
    electionName: election.election_name,
    earlyVotingDates: (election.early_voting_dates || []).map((d) => isoFromSlashDate(d.date)),
    reports: reports.filter(Boolean),
  };
}
