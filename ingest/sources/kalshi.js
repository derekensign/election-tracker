// Kalshi public market data (no auth needed for reads): https://api.elections.kalshi.com/trade-api/v2
import { fetchJson } from "../http.js";

const BASE = "https://api.elections.kalshi.com/trade-api/v2";

/** Fetch active markets for a series ticker or an event ticker. */
export async function fetchMarkets({ seriesTicker, eventTicker }) {
  const query = seriesTicker ? `series_ticker=${encodeURIComponent(seriesTicker)}` : `event_ticker=${encodeURIComponent(eventTicker)}`;
  const data = await fetchJson(`${BASE}/markets?${query}&limit=100`);
  return (data.markets || [])
    .filter((market) => market.status === "active")
    .map((market) => {
      const bid = toNumber(market.yes_bid_dollars);
      const ask = toNumber(market.yes_ask_dollars);
      const last = toNumber(market.last_price_dollars);
      // Mid-price is the fair value when both sides are quoted; otherwise fall back to the last trade.
      const mid = bid !== null && ask !== null && ask > 0 ? (bid + ask) / 2 : last;
      return {
        ticker: market.ticker,
        eventTicker: market.event_ticker,
        title: market.title,
        outcome: (market.yes_sub_title || "").trim(),
        subtitle: market.subtitle,
        yesBid: bid,
        yesAsk: ask,
        lastPrice: last,
        probability: mid,
        volumeContracts: toNumber(market.volume_fp) ?? 0,
        openInterest: toNumber(market.open_interest_fp) ?? 0,
        closeTime: market.close_time,
      };
    });
}

/** Map a two-candidate (or party) Kalshi series onto { D, R } using the race's known candidate names. */
export function partyProbabilities(markets, { democrat, republican }) {
  const result = { D: null, R: null, volumeContracts: 0, spread: null, candidates: {} };
  // Several markets can carry the same party tag (minor candidates, name variants); keep the most-traded
  // one per party, preferring an explicit roster match.
  const best = {};
  for (const market of markets) {
    const match = matchParty(market, { democrat, republican });
    if (!match) continue;
    const current = best[match.party];
    const better = !current || (match.byName && !current.byName) || (match.byName === current.byName && market.volumeContracts > current.market.volumeContracts);
    if (better) best[match.party] = { market, byName: match.byName };
  }
  for (const [party, { market }] of Object.entries(best)) {
    result[party] = market.probability;
    result.candidates[party] = market.outcome;
    result.volumeContracts += market.volumeContracts;
    const spread = market.yesBid !== null && market.yesAsk !== null ? market.yesAsk - market.yesBid : null;
    if (spread !== null) result.spread = Math.max(result.spread ?? 0, spread);
  }
  return result;
}

function matchParty(market, { democrat, republican }) {
  const outcome = (market.outcome || "").toLowerCase();
  if (democrat && outcome.includes(lastName(democrat))) return { party: "D", byName: true };
  if (republican && outcome.includes(lastName(republican))) return { party: "R", byName: true };
  const haystack = `${outcome} ${market.subtitle || ""} ${market.ticker}`.toLowerCase();
  if (/democrat|\bdem\b|-d$|-dem$/.test(haystack)) return { party: "D", byName: false };
  if (/republican|\bgop\b|-r$|-gop$/.test(haystack)) return { party: "R", byName: false };
  return null;
}

function lastName(fullName) {
  return fullName.trim().split(/\s+/).pop().toLowerCase();
}

/** Parse "exactly N" / "fewer than N" / "more than N" seat markets into a normalized distribution. */
export function seatDistribution(markets) {
  const buckets = [];
  for (const market of markets) {
    if (market.probability === null) continue;
    const title = market.title || "";
    let key;
    const exactly = title.match(/hold (?:exactly )?(\d+) (?:Senate )?seats/i) || title.match(/\bexactly (\d+)\b/i);
    const below = title.match(/(?:fewer|less) than (\d+)/i);
    const above = title.match(/more than (\d+)/i);
    if (below) key = `<${below[1]}`;
    else if (above) key = `>${above[1]}`;
    else if (exactly) key = exactly[1];
    else continue;
    buckets.push({ key, probability: market.probability, volumeContracts: market.volumeContracts });
  }
  const total = buckets.reduce((sum, b) => sum + b.probability, 0);
  return buckets
    .map((b) => ({ ...b, normalized: total > 0 ? b.probability / total : null }))
    .sort((a, b) => sortKey(a.key) - sortKey(b.key));
}

function sortKey(key) {
  if (key.startsWith("<")) return Number(key.slice(1)) - 0.5;
  if (key.startsWith(">")) return Number(key.slice(1)) + 0.5;
  return Number(key);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
