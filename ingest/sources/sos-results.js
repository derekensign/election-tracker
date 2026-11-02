// Texas Secretary of State election-night returns, from the public file service behind the SOS results site
// (goelect.txelections.civixapps.com/ivis-enr-ui, the site results.texas-election.com points to). The county file
// holds every county's votes in every race with early votes broken out; like the early-vote files, each response
// is JSON whose `upload` field is base64-encoded JSON. Nested sections of the election file are base64 again.
import { fetchJson } from "../http.js";
import { NEEDLE_ELECTION, parseCountyReturns } from "../needle.js";

const ENR_URL = "https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr";

/** Fetch one ENR file and decode its base64 `upload` payload; null when the service has nothing there. */
async function fetchDecoded(path) {
  const wrapper = await fetchJson(`${ENR_URL}/${path}`, { timeoutMs: 60_000, retries: 1 });
  if (!wrapper?.upload) return null;
  return JSON.parse(Buffer.from(wrapper.upload, "base64").toString("utf8"));
}

/** Every county's returns in the tracked statewide races (see parseCountyReturns for the shape). */
export async function fetchCountyReturns(electionId = NEEDLE_ELECTION.enrId) {
  const countyInfo = await fetchDecoded(`election/countyInfo/${electionId}`);
  if (!countyInfo || !Object.keys(countyInfo).length) throw new Error(`SOS county file for election ${electionId} is empty`);
  return parseCountyReturns(countyInfo);
}

/** The results site's own status line: last update time and counties / polling places reporting. */
export async function fetchElectionStatus(electionId = NEEDLE_ELECTION.enrId) {
  // Unlike the county file, the election file is not wrapped in `upload`; only its sections are base64.
  const election = await fetchJson(`${ENR_URL}/election/${electionId}`, { timeoutMs: 60_000, retries: 1 });
  if (!election?.Home) return null;
  const home = JSON.parse(Buffer.from(election.Home, "base64").toString("utf8"));
  return {
    lastUpdated: home.LastUpdatedTime ?? null,
    countiesReporting: home.CountiesReporting?.CR ?? null, countiesTotal: home.CountiesReporting?.CT ?? null,
    pollingPlacesReporting: home.PollingReporting?.PLR ?? null, pollingPlacesTotal: home.PollingReporting?.PLT ?? null,
  };
}
