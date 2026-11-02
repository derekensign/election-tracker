// Election-night recorder. Polls the Secretary of State's county returns, runs the needle (ingest/needle.js), and
// writes the night's history to needle.json: a point per race whenever the returns change, and an annotation
// wherever the needle moved. The page reads that file for its chart and falls back to running the same model in
// the browser if the recorder goes quiet.
//
//   node ingest/needle-record.js --out needle-out [--push] [--interval 120] [--budget-minutes 340] [--until ISO]
//   node ingest/needle-record.js --out /tmp/needle --once      # one fetch, for testing
//
// --out is a directory (in CI, a worktree of the needle-data branch). --push commits and pushes needle.json there
// after each change, plus a heartbeat every three minutes so readers can tell a quiet stretch from a dead recorder.
// A needle.json already in --out is resumed, so a restarted job keeps the night's history; one created before noon
// Central on Election Day (a test run) is replaced.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { advanceNeedle, createNeedleDocument, NEEDLE_ELECTION } from "./needle.js";
import { fetchCountyReturns, fetchElectionStatus } from "./sources/sos-results.js";

const args = parseArgs(process.argv.slice(2));
const OUT_DIR = args.out || "needle-out";
const INTERVAL_MS = Number(args.interval || 120) * 1000;
const STARTED = Date.now();
const BUDGET_MS = Number(args["budget-minutes"] || 340) * 60_000;
// Stop at 7 a.m. Central on November 4 unless told otherwise; counting is all but done by then.
const UNTIL_MS = Date.parse(args.until || "2026-11-04T13:00:00Z");
// Published even when nothing changed, so readers can tell a quiet stretch from a dead recorder. With the raw CDN's
// five-minute cache, a live recorder's file is never more than about ten minutes old (the page allows twelve).
const HEARTBEAT_MS = 3 * 60_000;
const DOC_PATH = join(OUT_DIR, "needle.json");

function parseArgs(list) {
  const parsed = {};
  for (let i = 0; i < list.length; i += 1) {
    if (!list[i].startsWith("--")) continue;
    const next = list[i + 1];
    parsed[list[i].slice(2)] = next && !next.startsWith("--") ? (i += 1, next) : true;
  }
  return parsed;
}
const log = (message) => console.log(`[needle ${new Date().toISOString()}] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadDocument() {
  if (existsSync(DOC_PATH)) {
    const doc = JSON.parse(readFileSync(DOC_PATH, "utf8"));
    // A document from a test run before Election Day would carry that day's polls into the night; start fresh.
    const fromElectionDay = Date.parse(doc.createdAt) >= Date.parse(args["fresh-before"] || "2026-11-03T18:00:00Z");
    if (doc.version === 1 && doc.election?.enrId === NEEDLE_ELECTION.enrId && fromElectionDay) { log(`resuming ${DOC_PATH}: ${doc.events.length} events, last update ${doc.updatedAt}`); return doc; }
    log(`${DOC_PATH} is from a test run, another election, or another version; starting fresh`);
  }
  const snapshot = JSON.parse(readFileSync(new URL("../public/data/latest.json", import.meta.url), "utf8"));
  log(`new document from the ${snapshot.asOf} snapshot`);
  return createNeedleDocument(snapshot);
}

function publish(doc, message) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(DOC_PATH, JSON.stringify(doc));
  if (!args.push) return;
  // Keep Vercel from building this data-only branch.
  const vercelPath = join(OUT_DIR, "vercel.json");
  if (!existsSync(vercelPath)) writeFileSync(vercelPath, JSON.stringify({ git: { deploymentEnabled: false } }, null, 2));
  const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: OUT_DIR, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("add", "needle.json", "vercel.json");
  if (!git("status", "--porcelain").trim()) return;
  git("commit", "-q", "-m", message);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { git("push", "-q", "origin", "HEAD:needle-data"); return; } catch (error) {
      log(`push failed (attempt ${attempt}): ${String(error.stderr || error.message).trim()}`);
      if (attempt === 3) throw error;
      git("pull", "-q", "--rebase", "origin", "needle-data");
    }
  }
}

async function main() {
  const doc = loadDocument();
  const memory = {};
  let lastPublished = 0;
  let statusEvery = 0;
  if (Date.now() > UNTIL_MS) { log("past the stop time; nothing to record"); return; }
  for (;;) {
    const loopStarted = Date.now();
    const fetchedAt = new Date(loopStarted).toISOString();
    try {
      const returns = await fetchCountyReturns();
      // The results site's status line (1.6 MB file) every third pass is plenty.
      const status = statusEvery++ % 3 === 0 ? await fetchElectionStatus().catch((error) => { log(`status fetch failed: ${error.message}`); return null; }) : null;
      const { changed, events } = advanceNeedle(doc, { returns, fetchedAt, status }, memory);
      const senate = doc.timeline["tx-senate"]?.at(-1), governor = doc.timeline["tx-governor"]?.at(-1);
      log(`${changed ? "new returns" : "no change"}; senate ${(100 * senate.p).toFixed(1)}% D (${(100 * senate.c).toFixed(0)}% counted), governor ${(100 * governor.p).toFixed(1)}% D${events.length ? `; ${events.length} event(s): ${events.map((e) => `${e.race} ${e.headline}`).join(" | ")}` : ""}`);
      if (changed || Date.now() - lastPublished >= HEARTBEAT_MS) {
        publish(doc, `needle: ${fetchedAt}${changed ? "" : " (heartbeat)"}`);
        lastPublished = Date.now();
      }
    } catch (error) {
      log(`fetch failed: ${error.message}`);
    }
    if (args.once) break;
    const now = Date.now();
    if (now + INTERVAL_MS > UNTIL_MS || now + INTERVAL_MS - STARTED > BUDGET_MS) { log("time budget reached; stopping"); break; }
    await sleep(Math.max(5000, INTERVAL_MS - (now - loopStarted)));
  }
  publish(doc, `needle: ${new Date().toISOString()} (recorder stopped)`);
}

main().catch((error) => { console.error(error); process.exit(1); });
