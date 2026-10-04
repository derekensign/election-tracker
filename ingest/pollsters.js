// Pollster quality lookup. Data: FiveThirtyEight pollster ratings (pollster-ratings-combined.csv, 2024 methodology),
// vendored in ingest/data/. numeric_grade runs 0–3 (3 = best); POLLSCORE is lower-is-better; NA grades are mostly inactive pollsters.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CSV_PATH = join(dirname(fileURLToPath(import.meta.url)), "data", "pollster-ratings-538.csv");

/** Names Wikipedia/VoteHub use that don't share a distinctive token with the 538 name. */
const ALIASES = {
  // Specific entries first: matching is by substring in insertion order.
  "new york times/siena": "The New York Times/Siena College",
  "nyt/siena": "The New York Times/Siena College",
  "siena": "Siena College",
  "fox news": "Beacon Research/Shaw & Co. Research",
  "beacon research/shaw": "Beacon Research/Shaw & Co. Research",
  "beacon/shaw": "Beacon Research/Shaw & Co. Research",
  "george mason": "The Washington Post/George Mason University Schar School of Policy and Government",
  "npr/marist": "Marist College",
  "marist": "Marist College",
  "texas politics project": "YouGov",
  "university of texas/texas politics project": "YouGov",
  "ut/texas tribune": "YouGov",
  "tsu/yougov": "YouGov",
  "texas southern": null,
  "texas public opinion research": null,
  "fabrizio": "Fabrizio, Lee & Associates",
  "cnn/ssrs": "SSRS",
  "quinnipiac": "Quinnipiac University",
  "emerson": "Emerson College",
  "trafalgar": "Trafalgar Group",
  "insideradvantage": "InsiderAdvantage",
  "public policy polling": "Public Policy Polling",
  "mason-dixon": "Mason-Dixon Polling & Strategy",
  "suffolk": "Suffolk University",
  "monmouth": "Monmouth University Polling Institute",
  "data for progress": "Data for Progress",
  "cygnal": "Cygnal",
  "echelon insights": "Echelon Insights",
  "big data poll": "Big Data Poll",
  "atlasintel": "AtlasIntel",
  "co/efficient": "co/efficient",
  "gbao": "GBAO",
};

const STOPWORDS = new Set(["the", "of", "and", "for", "a", "at", "in", "poll", "polls", "polling", "research", "strategies", "strategy", "group", "inc", "llc", "survey", "surveys", "center", "institute", "public", "opinion", "university", "college", "school", "law", "co", "company", "associates", "insights", "analytics", "data", "news", "political", "politics", "project", "report", "reports", "intelligence", "science", "decision", "international", "national", "consulting", "partners", "media", "digital", "american", "america", "texas", "new", "york", "times", "d", "r"]);

let cache = null;

/** Load and index the ratings file once. */
export function loadPollsterRatings() {
  if (cache) return cache;
  const text = readFileSync(CSV_PATH, "utf8").replace(/^﻿/, "");
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const columns = parseCsvLine(header);
  const rows = lines.map((line) => Object.fromEntries(parseCsvLine(line).map((value, i) => [columns[i], value])));
  const entries = rows.map((row) => ({
    pollster: row.pollster,
    numericGrade: toNumber(row.numeric_grade),
    pollscore: toNumber(row.POLLSCORE),
    transparency: toNumber(row.wtd_avg_transparency),
    polls: toNumber(row.number_polls_pollster_total),
    partisanShare: toNumber(row.percent_partisan_work),
    inactive: /true/i.test(row.inactive || ""),
    aaporRoper: /true/i.test(row.aapor_roper || ""),
    tokens: tokens(row.pollster),
  }));
  cache = { entries, byName: new Map(entries.map((e) => [e.pollster.toLowerCase(), e])) };
  return cache;
}

/**
 * Find the 538 rating for a pollster string as written by Wikipedia or VoteHub.
 * Returns { pollster, numericGrade, pollscore, ... , matched: "alias"|"token"|null }.
 */
export function ratePollster(name) {
  if (!name) return unrated(name);
  const { entries, byName } = loadPollsterRatings();
  const cleaned = name.replace(/\s*\((R|D|I)\)\s*/g, " ").replace(/\s+/g, " ").trim();
  const lower = cleaned.toLowerCase();
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (lower === alias || lower.startsWith(`${alias}/`) || lower.includes(alias)) {
      if (target === null) return unrated(cleaned); // explicitly "not in the ratings"
      const entry = byName.get(target.toLowerCase());
      if (entry) return { ...publicFields(entry), matched: "alias" };
    }
  }
  const exact = byName.get(lower);
  if (exact) return { ...publicFields(exact), matched: "exact" };
  // Token overlap: each slash-separated organisation is tried separately; the best-graded match wins.
  const parts = cleaned.split("/").map((p) => tokens(p)).filter((t) => t.length);
  let best = null;
  for (const entry of entries) {
    for (const part of parts) {
      const overlap = part.filter((t) => entry.tokens.includes(t));
      if (overlap.length === 0) continue;
      // The shorter name must be fully covered and the longer one mostly, so one shared generic word is not a match.
      const coverageShort = overlap.length / Math.min(part.length, entry.tokens.length);
      const coverageLong = overlap.length / Math.max(part.length, entry.tokens.length);
      if (coverageShort < 0.99 || coverageLong < 0.6) continue;
      const score = coverageShort + coverageLong / 10 + (entry.numericGrade ?? 0) / 100;
      if (!best || score > best.score) best = { entry, score };
    }
  }
  if (best && best.score >= 0.99) return { ...publicFields(best.entry), matched: "token" };
  return unrated(cleaned);
}

/**
 * Weight multiplier for a poll from this pollster, on top of recency and sample size.
 * 3.0 → 1.0, 1.5 → 0.675, 0 → 0.35; unrated 0.5. Partisan/internal polls are halved by the caller.
 */
export function qualityWeight(rating) {
  if (!rating || rating.numericGrade === null || rating.numericGrade === undefined) return 0.5;
  return 0.35 + 0.65 * (rating.numericGrade / 3);
}

export function gradeLabel(numericGrade) {
  if (numericGrade === null || numericGrade === undefined) return null;
  if (numericGrade >= 2.8) return "A+"; if (numericGrade >= 2.5) return "A"; if (numericGrade >= 2.2) return "A−";
  if (numericGrade >= 1.9) return "B+"; if (numericGrade >= 1.6) return "B"; if (numericGrade >= 1.3) return "B−";
  if (numericGrade >= 1.0) return "C+"; if (numericGrade >= 0.7) return "C"; if (numericGrade >= 0.4) return "C−";
  return "D";
}

function publicFields(entry) {
  return { pollster: entry.pollster, numericGrade: entry.numericGrade, grade: gradeLabel(entry.numericGrade), pollscore: entry.pollscore, transparency: entry.transparency, polls: entry.polls, inactive: entry.inactive };
}
function unrated(name) { return { pollster: name || null, numericGrade: null, grade: null, pollscore: null, transparency: null, polls: null, inactive: false, matched: null }; }
function tokens(name) {
  return (name || "").toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter((t) => t && !STOPWORDS.has(t));
}
function toNumber(value) { if (value === undefined || value === null || value === "" || value === "NA") return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function parseCsvLine(line) {
  const out = []; let current = ""; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') { if (quoted && line[i + 1] === '"') { current += '"'; i += 1; } else quoted = !quoted; }
    else if (ch === "," && !quoted) { out.push(current); current = ""; }
    else current += ch;
  }
  out.push(current);
  return out;
}
