// Election-night recorder on AWS. EventBridge invokes this every two minutes on election night; each invocation is
// one pass of the GitHub recorder (ingest/needle-record.js): read the night's needle.json from S3, fold in the
// Secretary of State's latest county returns with the same model and annotation logic, and write it back.
//
// The object is stored gzipped with a 20-second cache, so the page sees each update within seconds (GitHub's raw
// CDN holds files for five minutes). Writes are conditional on the version read, so an invocation that overlaps a
// slow one never overwrites newer history. The package bundles the ingest modules unchanged (aws/deploy-needle.sh).
import { gunzipSync, gzipSync } from "node:zlib";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { advanceNeedle, createNeedleDocument, NEEDLE_ELECTION } from "./ingest/needle.js";
import { fetchCountyReturns, fetchElectionStatus } from "./ingest/sources/sos-results.js";

const s3 = new S3Client({});
const { BUCKET, OBJECT_KEY = "needle.json", SNAPSHOT_URL, FRESH_AFTER = "2026-11-03T18:00:00Z" } = process.env;

/** The night's document and its S3 version (ETag), or a fresh one from the published morning snapshot. */
async function loadDocument() {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: OBJECT_KEY }));
    const bytes = Buffer.from(await object.Body.transformToByteArray());
    const doc = JSON.parse((object.ContentEncoding === "gzip" ? gunzipSync(bytes) : bytes).toString("utf8"));
    // A document from a test run before Election Day would carry that day's polls into the night; replace it.
    const current = doc.version === 1 && doc.election?.enrId === NEEDLE_ELECTION.enrId && Date.parse(doc.createdAt) >= Date.parse(FRESH_AFTER);
    if (current) return { doc, etag: object.ETag };
    console.log(`${OBJECT_KEY} is from a test run, another election, or another version; starting fresh`);
    return { doc: await freshDocument(), etag: object.ETag };
  } catch (error) {
    if (error.name !== "NoSuchKey") throw error;
    return { doc: await freshDocument(), etag: null };
  }
}

async function freshDocument() {
  const response = await fetch(SNAPSHOT_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`snapshot ${SNAPSHOT_URL}: HTTP ${response.status}`);
  const snapshot = await response.json();
  console.log(`new document from the ${snapshot.asOf} snapshot`);
  return createNeedleDocument(snapshot);
}

export async function handler() {
  const started = Date.now();
  const { doc, etag } = await loadDocument();
  const fetchedAt = new Date().toISOString();
  const returns = await fetchCountyReturns();
  // The results site's status line comes from a 1.6 MB file; every third pass (six minutes) is plenty.
  const status = new Date().getUTCMinutes() % 6 === 0 || !doc.status
    ? await fetchElectionStatus().catch((error) => { console.log(`status fetch failed: ${error.message}`); return null; })
    : null;
  const { changed, events } = advanceNeedle(doc, { returns, fetchedAt, status });
  try {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: OBJECT_KEY, Body: gzipSync(JSON.stringify(doc)),
      ContentType: "application/json", ContentEncoding: "gzip", CacheControl: "public, max-age=20",
      ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }),
    }));
  } catch (error) {
    // Another invocation wrote first; its history is at least as new as ours, so keep it.
    if (error.name === "PreconditionFailed" || error.$metadata?.httpStatusCode === 412) { console.log("another pass wrote first; skipping this write"); return { changed, skipped: true }; }
    throw error;
  }
  const senate = doc.timeline["tx-senate"]?.at(-1), governor = doc.timeline["tx-governor"]?.at(-1);
  console.log(JSON.stringify({ changed, events: events.map((e) => `${e.race}: ${e.headline}`), senate: senate?.p, governor: governor?.p, counted: senate?.c, ms: Date.now() - started }));
  return { changed, events: events.length, senate: senate?.p, governor: governor?.p };
}
