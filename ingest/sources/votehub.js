// VoteHub public polls feed: https://api.votehub.com/polls (one JSON array; filter client-side).
import { fetchJson } from "../http.js";

const URL = "https://api.votehub.com/polls";

export async function fetchAllPolls() {
  const polls = await fetchJson(URL, { timeoutMs: 60_000 });
  if (!Array.isArray(polls)) throw new Error("VoteHub returned a non-array payload");
  return polls;
}

/**
 * Select 2026 general-election polls for one race and normalize to the shared poll shape.
 * `stateName` matches the VoteHub `subject` ("2026 Texas"); candidate names map answers onto parties.
 */
export function pollsForRace(allPolls, { pollType, stateName, democrat, republican }) {
  const subject = `2026 ${stateName}`.toLowerCase();
  return allPolls
    .filter((poll) => poll.poll_type === pollType && (poll.subject || "").toLowerCase() === subject)
    .map((poll) => {
      const answers = poll.answers || [];
      const dem = answers.find((a) => sameCandidate(a.choice, democrat));
      const rep = answers.find((a) => sameCandidate(a.choice, republican));
      if (!dem || !rep) return null;
      return {
        source: "votehub",
        id: `votehub:${poll.id}`,
        pollster: poll.pollster,
        sponsors: poll.sponsors || [],
        startDate: poll.start_date,
        endDate: poll.end_date,
        sampleSize: poll.sample_size ?? null,
        population: (poll.population || "").toUpperCase() || null,
        partisan: poll.partisan || null,
        internal: Boolean(poll.internal),
        dem: dem.pct,
        rep: rep.pct,
        url: poll.url || null,
      };
    })
    .filter(Boolean);
}

function sameCandidate(choice, fullName) {
  if (!choice || !fullName) return false;
  const last = fullName.trim().split(/\s+/).pop().toLowerCase();
  return choice.toLowerCase().includes(last);
}
