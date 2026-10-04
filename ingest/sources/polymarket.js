// Polymarket Gamma API (public, no auth): https://gamma-api.polymarket.com
import { fetchJson } from "../http.js";

const BASE = "https://gamma-api.polymarket.com";

/** Fetch an event by slug and return its open candidate/party markets with Yes prices. */
export async function fetchEvent(slug) {
  const events = await fetchJson(`${BASE}/events?slug=${encodeURIComponent(slug)}`);
  const event = events?.[0];
  if (!event) throw new Error(`Polymarket event not found: ${slug}`);
  const markets = (event.markets || [])
    .filter((market) => !market.closed && market.outcomePrices)
    .map((market) => {
      const outcomes = safeJson(market.outcomes) || [];
      const prices = (safeJson(market.outcomePrices) || []).map(Number);
      const yesIndex = outcomes.findIndex((o) => /^yes$/i.test(o));
      const yesPrice = yesIndex >= 0 ? prices[yesIndex] : prices[0];
      return {
        title: (market.groupItemTitle || market.question || "").trim(),
        question: market.question,
        yesPrice: Number.isFinite(yesPrice) ? yesPrice : null,
        volumeUsd: Number(market.volume || 0),
        liquidityUsd: Number(market.liquidity || 0),
      };
    })
    .filter((market) => market.yesPrice !== null && market.volumeUsd > 0);
  return {
    source: "polymarket",
    slug,
    title: event.title,
    url: `https://polymarket.com/event/${slug}`,
    endDate: event.endDate,
    volumeUsd: Number(event.volume || 0),
    markets,
  };
}

/**
 * Reduce a candidate-winner event to party probabilities.
 * Titles look like "James Talarico (D)" / "Dan Osborn (I)"; party letters in parentheses are authoritative.
 */
export function partyProbabilities(event, roster = {}) {
  const result = { D: null, R: null, I: null, volumeUsd: event.volumeUsd, candidates: {} };
  for (const market of event.markets) {
    const party = partyForTitle(market.title, roster);
    if (!party) continue;
    const name = market.title.replace(/\s*\([DRI]\)\s*$/i, "").replace(/^(Sen\.|Rep\.|Gov\.)\s+/i, "").trim();
    if (!/^(democrat|republican|independent)$/i.test(name)) result.candidates[party] = roster[party] || name;
    else if (roster[party]) result.candidates[party] = roster[party];
    result[party] = (result[party] ?? 0) + market.yesPrice;
  }
  return result;
}

function partyForTitle(title, roster) {
  const letter = title.match(/\(([DRI])\)\s*$/i);
  if (letter) return letter[1].toUpperCase();
  if (/^democrat(ic)?$/i.test(title.trim())) return "D";
  if (/^republican$/i.test(title.trim())) return "R";
  if (/^independent$/i.test(title.trim())) return "I";
  const haystack = title.toLowerCase();
  for (const party of ["D", "R", "I"]) {
    const name = roster[party];
    if (name && haystack.includes(name.trim().split(/\s+/).pop().toLowerCase())) return party;
  }
  return null;
}

/** Reduce a "Which party will control X" event to { D, R }. */
export function controlProbabilities(event) {
  const result = { D: null, R: null, volumeUsd: event.volumeUsd };
  for (const market of event.markets) {
    if (/democratic/i.test(market.question)) result.D = market.yesPrice;
    else if (/republican/i.test(market.question)) result.R = market.yesPrice;
  }
  return result;
}

function safeJson(text) {
  try { return typeof text === "string" ? JSON.parse(text) : text; } catch { return null; }
}
