import { USER_AGENT } from "./config.js";

/** fetch JSON with a timeout, a polite User-Agent, and one retry on transient failure. */
export async function fetchJson(url, { timeoutMs = 30_000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429 && attempt < retries) {
        // Rate limited: back off harder than for ordinary failures.
        await new Promise((resolve) => setTimeout(resolve, 4000 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Run async tasks one at a time with a pause between them (for rate-limited APIs). */
export async function sequential(items, worker, { gapMs = 200 } = {}) {
  const results = [];
  for (const item of items) {
    results.push(await worker(item));
    if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  return results;
}
