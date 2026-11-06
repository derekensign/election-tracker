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

const PARTY_LETTERS = { DEM: "D", D: "D", REP: "R", R: "R", LIB: "L", L: "L", GRN: "G", G: "G", W: "W", IND: "I" };
const titleName = (name) => String(name).toLowerCase().replace(/(^|[\s\-'.(])([a-z])/g, (m, lead, letter) => lead + letter.toUpperCase()).replace(/\b(Ii|Iii|Iv)\b/g, (numeral) => numeral.toUpperCase());

/**
 * Every Texas House and Senate race from the election file's Districted section: candidates (name, party, votes,
 * incumbent), total votes, the leader, and the Democratic-minus-Republican margin, by chamber and district.
 * @returns {{ lastUpdated: string|null, house: Record<number, object>, senate: Record<number, object> }}
 */
export function parseLegislativeResults(districted, lastUpdated = null) {
  const out = { lastUpdated, house: {}, senate: {} };
  for (const race of districted?.Races ?? []) {
    const name = String(race.N || "").trim();
    const match = name.match(/^STATE REPRESENTATIVE DISTRICT (\d+)$/) ?? name.match(/^STATE SENATOR, DISTRICT (\d+)$/);
    if (!match) continue;
    const chamber = name.startsWith("STATE REPRESENTATIVE") ? "house" : "senate";
    const candidates = (race.Candidates ?? []).map((c) => ({
      name: titleName(String(c.N).replace(/\s*\(I\)\s*$/, "")), party: PARTY_LETTERS[String(c.P).toUpperCase()] ?? "other",
      votes: Number(c.V) || 0, incumbent: /\(I\)\s*$/.test(String(c.N)),
    })).sort((a, b) => b.votes - a.votes);
    const total = Number(race.T) || candidates.reduce((t, c) => t + c.votes, 0);
    const votesOf = (party) => candidates.find((c) => c.party === party)?.votes ?? 0;
    const points = (votes) => Math.round((1000 * votes) / total) / 10;
    const leader = candidates[0]?.party ?? null;
    // The leader's edge over the runner-up, in points; uncontested races have none.
    const lead = candidates.length > 1 && total ? points(candidates[0].votes - candidates[1].votes) : null;
    const bothParties = candidates.some((c) => c.party === "D") && candidates.some((c) => c.party === "R");
    out[chamber][Number(match[1])] = {
      candidates, total, leader, leaderName: candidates[0]?.name ?? null,
      // Democratic minus Republican; without one of them on the ballot, the leader's lead, positive for a Democrat.
      margin: !total ? null : bothParties ? points(votesOf("D") - votesOf("R")) : lead == null ? null : leader === "D" ? lead : leader === "R" ? -lead : null,
      lead, uncontested: candidates.length < 2,
    };
  }
  return out;
}

/** The Texas House and Senate results from the state's election file (see parseLegislativeResults). */
export async function fetchLegislativeResults(electionId = NEEDLE_ELECTION.enrId) {
  const election = await fetchJson(`${ENR_URL}/election/${electionId}`, { timeoutMs: 60_000, retries: 1 });
  if (!election?.Districted) throw new Error(`SOS election file ${electionId} has no district races`);
  const decode = (section) => JSON.parse(Buffer.from(section, "base64").toString("utf8"));
  return parseLegislativeResults(decode(election.Districted), election.Home ? decode(election.Home).LastUpdatedTime ?? null : null);
}
