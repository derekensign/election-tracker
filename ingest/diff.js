// Day-over-day change detection. Produces a ranked list of "big moves" between two snapshots.

const THRESHOLDS = { marketPoints: 3 /* model-probability points */, pollMarginPoints: 1.0, controlPoints: 3, expectedSeats: 0.3 };

export function detectChanges(previous, current) {
  if (!previous) return [{ type: "baseline", severity: 0, text: "Baseline snapshot: changes will appear starting with the next update." }];
  const changes = [];
  compareSenateRaces(previous, current, changes);
  compareTexasRaces(previous, current, changes);
  compareLegislature(previous, current, "txHouse", "TX House", changes);
  compareLegislature(previous, current, "txSenate", "TX Senate", changes);
  compareControl(previous, current, changes);
  compareUsHouse(previous, current, changes);
  for (const race of current.governors?.races || []) {
    const before = previous.governors?.races?.find((r) => r.state === race.state);
    if (!before) continue;
    const label = `${race.stateName} Governor`;
    compareRatings(before.ratings, race.ratings, current.governors.forecasters, label, race.id, changes);
    compareModel(before.pollModel, race.pollModel, label, race.id, changes);
    if (race.state !== "TX") comparePolls(before, race, label, race.id, changes);
  }
  changes.sort((a, b) => b.severity - a.severity);
  return changes;
}

function compareSenateRaces(previous, current, changes) {
  for (const race of current.usSenate.races) {
    const before = previous.usSenate.races.find((r) => r.state === race.state);
    if (!before) continue;
    const label = `${race.stateName} Senate`;
    compareRatings(before.ratings, race.ratings, current.usSenate.forecasters, label, race.id, changes);
    compareModel(before.pollModel, race.pollModel, label, race.id, changes);
    comparePolls(before, race, label, race.id, changes);
  }
}

function compareTexasRaces(previous, current, changes) {
  for (const race of current.texas.races) {
    const before = previous.texas.races.find((r) => r.id === race.id);
    if (!before) continue;
    const label = `TX ${race.office}`;
    compareRatings(mapLabels(before.ratings), mapLabels(race.ratings), null, label, race.id, changes);
    compareModel(before.pollModel, race.pollModel, label, race.id, changes);
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

function compareModel(before, after, label, raceId, changes) {
  const bp = before?.pD;
  const ap = after?.pD;
  if (bp != null && ap != null && Math.abs(ap - bp) * 100 >= THRESHOLDS.marketPoints) {
    const delta = (ap - bp) * 100;
    changes.push({ type: "poll-model", severity: 55 + Math.min(30, Math.abs(delta)), raceId, text: `${label}: poll-model D win chance ${pct(bp)} → ${pct(ap)} (${signed(delta)} pts)` });
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
  const bm = previous[key]?.model?.expected?.D;
  const am = current[key]?.model?.expected?.D;
  if (bm != null && am != null && Math.abs(am - bm) >= 0.5) {
    changes.push({ type: "poll-model", severity: 55, text: `${label}: model expected Democratic seats ${bm.toFixed(1)} → ${am.toFixed(1)}` });
  }
  for (const district of current[key]?.districts || []) {
    const before = beforeDistricts.get(district.district);
    if (before?.modelD != null && district.modelD != null && Math.abs(district.modelD - before.modelD) * 100 >= 10) {
      changes.push({ type: "poll-model", severity: 35, raceId: `${key}-${district.district}`, text: `${label} District ${district.district}: model D win chance ${pct(before.modelD)} → ${pct(district.modelD)}` });
    }
  }
}

function compareControl(previous, current, changes) {
  const b = previous.senateControl?.pollModel?.control?.D;
  const a = current.senateControl?.pollModel?.control?.D;
  if (b != null && a != null && Math.abs(a - b) * 100 >= THRESHOLDS.controlPoints) {
    const delta = (a - b) * 100;
    changes.push({ type: "control", severity: 90, text: `U.S. Senate control (polls model): D ${pct(b)} → ${pct(a)} (${signed(delta)} pts)` });
  }
  const bE = previous.senateControl?.pollModel?.expected?.D;
  const aE = current.senateControl?.pollModel?.expected?.D;
  if (bE != null && aE != null && Math.abs(aE - bE) >= THRESHOLDS.expectedSeats) {
    changes.push({ type: "control", severity: 70, text: `Expected Democratic-caucus seats ${bE.toFixed(1)} → ${aE.toFixed(1)}` });
  }
}

function compareUsHouse(previous, current, changes) {
  const b = previous.usHouse, a = current.usHouse;
  if (!b || !a) return;
  const bc = b.model?.control?.D, ac = a.model?.control?.D;
  if (bc != null && ac != null && Math.abs(ac - bc) * 100 >= THRESHOLDS.controlPoints) changes.push({ type: "control", severity: 85, text: `U.S. House control (our model): D ${pct(bc)} → ${pct(ac)}` });
  const be = b.model?.expected?.D, ae = a.model?.expected?.D;
  if (be != null && ae != null && Math.abs(ae - be) >= 1) changes.push({ type: "poll-model", severity: 60, text: `U.S. House expected Democratic seats ${be.toFixed(1)} → ${ae.toFixed(1)}` });
  const bg = b.genericBallot?.average?.margin, ag = a.genericBallot?.average?.margin;
  if (bg != null && ag != null && Math.abs(ag - bg) >= THRESHOLDS.pollMarginPoints) changes.push({ type: "poll-average", severity: 55, text: `Generic congressional ballot ${marginText(bg)} → ${marginText(ag)}` });
  const before = new Map((b.districts || []).map((d) => [d.id, d]));
  for (const d of a.districts || []) {
    const prev = before.get(d.id);
    if (!prev) continue;
    for (const [key, label] of Object.entries(d.ratings || {})) {
      if (prev.ratings?.[key] && prev.ratings[key] !== label) {
        const name = (a.forecasters || []).find((f) => f.key === key)?.name || key;
        changes.push({ type: "rating", severity: d.state === "TX" ? 75 : 50, raceId: d.id, text: `${d.id} (U.S. House): ${name} moved ${prev.ratings[key]} → ${label}` });
      }
    }
    if (d.state === "TX") {
      const knownIds = new Set((prev.polls || []).flatMap((p) => [p.id, ...(p.alsoIds || [])]));
      for (const poll of (d.polls || []).filter((p) => !knownIds.has(p.id))) changes.push({ type: "poll", severity: 32, raceId: d.id, text: `${d.id} (U.S. House): new poll — ${poll.pollster}${poll.endDate ? ` (through ${poll.endDate})` : ""}: ${marginText(poll.dem - poll.rep)}` });
    }
  }
}

function pct(p) { return `${Math.round(p * 100)}%`; }
function signed(n) { return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}`; }
export function marginText(margin) {
  if (margin === null || margin === undefined) return "—";
  const rounded = Math.round(margin * 10) / 10;
  if (Math.abs(rounded) < 0.05) return "Even";
  return `${rounded > 0 ? "D" : "R"}+${Math.abs(rounded).toFixed(1)}`;
}
