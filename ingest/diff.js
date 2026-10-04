// Day-over-day change detection. Produces a ranked list of "big moves" between two snapshots.

const THRESHOLDS = { marketPoints: 3, pollMarginPoints: 1.0, controlPoints: 3, expectedSeats: 0.3 };

export function detectChanges(previous, current) {
  if (!previous) return [{ type: "baseline", severity: 0, text: "Baseline snapshot: changes will appear starting with the next update." }];
  const changes = [];
  compareSenateRaces(previous, current, changes);
  compareTexasRaces(previous, current, changes);
  compareLegislature(previous, current, "txHouse", "TX House", changes);
  compareLegislature(previous, current, "txSenate", "TX Senate", changes);
  compareControl(previous, current, changes);
  changes.sort((a, b) => b.severity - a.severity);
  return changes;
}

function compareSenateRaces(previous, current, changes) {
  for (const race of current.usSenate.races) {
    const before = previous.usSenate.races.find((r) => r.state === race.state);
    if (!before) continue;
    const label = `${race.stateName} Senate`;
    compareRatings(before.ratings, race.ratings, current.usSenate.forecasters, label, race.id, changes);
    compareOdds(before.odds, race.odds, label, race.id, changes);
    comparePolls(before, race, label, race.id, changes);
  }
}

function compareTexasRaces(previous, current, changes) {
  for (const race of current.texas.races) {
    const before = previous.texas.races.find((r) => r.id === race.id);
    if (!before) continue;
    const label = `TX ${race.office}`;
    compareRatings(mapLabels(before.ratings), mapLabels(race.ratings), null, label, race.id, changes);
    compareOdds(before.odds, race.odds, label, race.id, changes);
    comparePolls(before, race, label, race.id, changes);
  }
}

function mapLabels(ratings) {
  return Object.fromEntries(Object.entries(ratings || {}).map(([k, v]) => [k, typeof v === "string" ? v : v?.label]));
}

function compareRatings(before, after, forecasters, label, raceId, changes) {
  for (const [key, afterLabel] of Object.entries(after || {})) {
    const beforeLabel = before?.[key];
    if (!beforeLabel || beforeLabel === afterLabel) continue;
    const name = forecasters?.find((f) => f.key === key)?.name || key;
    changes.push({ type: "rating", severity: 80, raceId, text: `${label}: ${name} moved ${beforeLabel} → ${afterLabel}` });
  }
}

function compareOdds(before, after, label, raceId, changes) {
  for (const source of ["polymarket", "kalshi"]) {
    const b = before?.[source]?.D;
    const a = after?.[source]?.D;
    if (b === null || b === undefined || a === null || a === undefined) continue;
    const delta = (a - b) * 100;
    if (Math.abs(delta) >= THRESHOLDS.marketPoints) {
      changes.push({ type: "market", severity: 40 + Math.min(40, Math.abs(delta)), raceId, text: `${label}: ${sourceName(source)} D win odds ${pct(b)} → ${pct(a)} (${signed(delta)} pts)` });
    }
  }
}

function comparePolls(before, after, label, raceId, changes) {
  const knownIds = new Set((before.polls || []).flatMap((p) => [p.id, ...(p.alsoIds || [])]));
  const newPolls = (after.polls || []).filter((p) => !knownIds.has(p.id) && !(p.alsoIds || []).some((id) => knownIds.has(id)));
  for (const poll of newPolls.slice(0, 5)) {
    changes.push({ type: "poll", severity: 30, raceId, text: `${label}: new poll — ${poll.pollster}${poll.endDate ? ` (through ${poll.endDate})` : ""}: ${marginText(poll.dem - poll.rep)}` });
  }
  const b = before.pollingAverage?.margin;
  const a = after.pollingAverage?.margin;
  if (b !== null && b !== undefined && a !== null && a !== undefined && Math.abs(a - b) >= THRESHOLDS.pollMarginPoints) {
    changes.push({ type: "poll-average", severity: 50 + Math.min(30, Math.abs(a - b) * 5), raceId, text: `${label}: polling average ${marginText(b)} → ${marginText(a)}` });
  }
}

function compareLegislature(previous, current, key, label, changes) {
  const beforeDistricts = new Map((previous[key]?.districts || []).map((d) => [d.district, d]));
  for (const district of current[key]?.districts || []) {
    const before = beforeDistricts.get(district.district);
    if (!before) continue;
    if ((before.rating || null) !== (district.rating || null)) {
      changes.push({ type: "rating", severity: 60, raceId: `${key}-${district.district}`, text: `${label} District ${district.district}: ${before.rating || "unrated"} → ${district.rating || "unrated"}` });
    }
  }
  const b = previous[key]?.control?.kalshi?.D;
  const a = current[key]?.control?.kalshi?.D;
  if (b != null && a != null && Math.abs(a - b) * 100 >= THRESHOLDS.controlPoints) {
    changes.push({ type: "market", severity: 45, text: `${label} control: Kalshi D ${pct(b)} → ${pct(a)}` });
  }
}

function compareControl(previous, current, changes) {
  const pairs = [
    ["Polymarket Senate control", previous.senateControl?.polymarket?.D, current.senateControl?.polymarket?.D],
    ["Kalshi-implied Senate control", previous.senateControl?.kalshiSeats?.controlD, current.senateControl?.kalshiSeats?.controlD],
    ["Derived Senate control", previous.senateControl?.derived?.control?.D, current.senateControl?.derived?.control?.D],
  ];
  for (const [name, b, a] of pairs) {
    if (b == null || a == null) continue;
    const delta = (a - b) * 100;
    if (Math.abs(delta) >= THRESHOLDS.controlPoints) changes.push({ type: "control", severity: 90, text: `${name}: D ${pct(b)} → ${pct(a)} (${signed(delta)} pts)` });
  }
  const bE = previous.senateControl?.derived?.expected?.D;
  const aE = current.senateControl?.derived?.expected?.D;
  if (bE != null && aE != null && Math.abs(aE - bE) >= THRESHOLDS.expectedSeats) {
    changes.push({ type: "control", severity: 70, text: `Expected Democratic-caucus seats ${bE.toFixed(1)} → ${aE.toFixed(1)}` });
  }
}

function sourceName(source) { return source === "polymarket" ? "Polymarket" : "Kalshi"; }
function pct(p) { return `${Math.round(p * 100)}%`; }
function signed(n) { return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}`; }
export function marginText(margin) {
  if (margin === null || margin === undefined) return "—";
  const rounded = Math.round(margin * 10) / 10;
  if (Math.abs(rounded) < 0.05) return "Even";
  return `${rounded > 0 ? "D" : "R"}+${Math.abs(rounded).toFixed(1)}`;
}
