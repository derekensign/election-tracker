// Election-night U.S. Senate recorder on AWS. EventBridge invokes this every two minutes from the first Senate poll
// closings (5 p.m. Central). Each pass reads race calls from the 2026 Senate elections page on Wikipedia, applies
// the site's manual overrides (public/data/senate-calls.json), reads the live Texas needle from the same bucket and
// the states' own results files (ingest/senate-returns.js), runs the control model (ingest/senate-night.js), and
// writes senate.json beside needle.json. Separate from the Texas recorder, so a problem here never touches it.
import { gunzipSync, gzipSync } from "node:zlib";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { advanceSenateNight, createSenateNightDocument, mergeCalls, parseSenateCalls } from "./ingest/senate-night.js";
import { runNeedle } from "./ingest/needle.js";
import { SENATE_RETURN_SOURCES, summarizeReturns } from "./ingest/senate-returns.js";

const s3 = new S3Client({});
const { BUCKET, OBJECT_KEY = "senate.json", TEXAS_KEY = "needle.json", SNAPSHOT_URL, OVERRIDES_URL, WIKIPEDIA_PAGE, FRESH_AFTER, TEXAS_FRESH_AFTER } = process.env;
const USER_AGENT = "election-tracker/0.1 (https://github.com/derekensign/election-tracker; derekensign@gmail.com)";

/** An object from the bucket, gunzipped and parsed, with its version; null when it doesn't exist yet. */
async function readObject(key) {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const bytes = Buffer.from(await object.Body.transformToByteArray());
    return { doc: JSON.parse((object.ContentEncoding === "gzip" ? gunzipSync(bytes) : bytes).toString("utf8")), etag: object.ETag };
  } catch (error) {
    if (error.name === "NoSuchKey") return null;
    throw error;
  }
}

/** The page's current wikitext from the API (not the cached page view), so new calls show up promptly. */
async function wikipediaCalls(codeByStateName) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&titles=${encodeURIComponent(WIKIPEDIA_PAGE)}`;
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Wikipedia: HTTP ${response.status}`);
  const content = (await response.json()).query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content;
  if (!content) throw new Error("Wikipedia: no page content");
  return parseSenateCalls(content, codeByStateName);
}

/** The Texas Senate race from tonight's needle: its chance and its read of how far Texas runs from its polls. */
async function texasRace() {
  const texas = await readObject(TEXAS_KEY);
  const doc = texas?.doc;
  if (!doc?.latest?.returns || Date.parse(doc.createdAt) < Date.parse(TEXAS_FRESH_AFTER) || Date.now() - Date.parse(doc.checkedAt) > 10 * 60_000) return null;
  const [run] = runNeedle({ counties: doc.inputs.counties, returns: doc.latest.returns, races: doc.inputs.races.filter((race) => race.id === "tx-senate") });
  return { pD: run.pD, margin: run.margin, statewide: run.shared.statewide, counted: run.countedShare, countedVotes: run.countedVotes, countedMargin: run.countedMargin, expectedVotes: run.expectedVotes, returnsAt: doc.latest.fetchedAt ?? doc.checkedAt };
}

/** A URL's text, or an error naming the status; each read gets 25 seconds. */
async function getText(url) {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  return response.text();
}

/** Every state's results file, read at once; a state whose file fails keeps its last good count, marked stale. */
async function stateReturns(races, previous = {}) {
  const raceByState = new Map(races.map((race) => [race.state, race]));
  const entries = await Promise.all(Object.entries(SENATE_RETURN_SOURCES).map(async ([state, source]) => {
    try {
      const summary = summarizeReturns(raceByState.get(state), await source.read(getText));
      return [state, { ...summary, source: source.label, url: source.url, fetchedAt: new Date().toISOString() }];
    } catch (error) {
      console.log(`returns ${state}: ${error.message}`);
      return previous[state] ? [state, { ...previous[state], stale: true, error: error.message }] : null;
    }
  }));
  return Object.fromEntries(entries.filter(Boolean));
}

export async function handler() {
  const started = Date.now();
  const loaded = await readObject(OBJECT_KEY);
  let doc = loaded?.doc;
  // A document from a test run before the night carries the morning's inputs from another time; replace it.
  if (!doc || doc.kind !== "senate-night" || Date.parse(doc.createdAt) < Date.parse(FRESH_AFTER)) {
    const response = await fetch(SNAPSHOT_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`snapshot ${SNAPSHOT_URL}: HTTP ${response.status}`);
    const snapshot = await response.json();
    console.log(`new Senate document from the ${snapshot.asOf} snapshot`);
    doc = createSenateNightDocument(snapshot);
  }
  const codeByStateName = Object.fromEntries(doc.inputs.races.map((race) => [race.stateName, race.state]));
  // All sources at once. Each one failing leaves its last good value in place, so one outage never wipes calls.
  const [wikipedia, overridesRead, texasRead, returns] = await Promise.all([
    wikipediaCalls(codeByStateName).catch((error) => { console.log(`calls: ${error.message}; keeping the last ones`); return null; }),
    fetch(`${OVERRIDES_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(15_000) }).then((response) => (response.ok ? response.json() : null)).catch((error) => { console.log(`overrides: ${error.message}`); return null; }),
    texasRace().catch((error) => { console.log(`texas: ${error.message}`); return null; }),
    stateReturns(doc.inputs.races, doc.returns ?? {}),
  ]);
  const fromWikipedia = wikipedia ?? doc.latest?.wikipediaCalls ?? {};
  const overrides = overridesRead ?? doc.latest?.overrides ?? {};
  const texas = texasRead;

  const fetchedAt = new Date().toISOString();
  const { changed, events } = advanceSenateNight(doc, { calls: mergeCalls(fromWikipedia, overrides), texas, returns, fetchedAt });
  doc.latest.wikipediaCalls = fromWikipedia;
  doc.latest.overrides = overrides;
  try {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: OBJECT_KEY, Body: gzipSync(JSON.stringify(doc)),
      ContentType: "application/json", ContentEncoding: "gzip", CacheControl: "public, max-age=20",
      ...(loaded?.etag ? { IfMatch: loaded.etag } : { IfNoneMatch: "*" }),
    }));
  } catch (error) {
    if (error.name === "PreconditionFailed" || error.$metadata?.httpStatusCode === 412) { console.log("another pass wrote first; skipping this write"); return { changed, skipped: true }; }
    throw error;
  }
  const last = doc.timeline.at(-1);
  console.log(JSON.stringify({ changed, events: events.map((e) => e.headline), control: last.p, called: last.called, texas: texas?.pD ?? null, returns: Object.fromEntries(Object.entries(returns).map(([state, r]) => [state, r.total])), ms: Date.now() - started }));
  return { changed, control: last.p, called: last.called };
}
