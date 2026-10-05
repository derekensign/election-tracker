// Morning digest: a written briefing generated from the snapshot and its change list. Plain templates, no LLM.
import { marginText } from "./diff.js";

const KEY_DATES = [
  { date: "2026-10-05", label: "Texas voter registration deadline" },
  { date: "2026-10-19", label: "Texas early voting begins" },
  { date: "2026-10-23", label: "Deadline to apply for a Texas mail ballot" },
  { date: "2026-10-30", label: "Texas early voting ends" },
  { date: "2026-11-03", label: "Election Day" },
];

const pct = (p) => (p === null || p === undefined ? "—" : `${Math.round(p * 100)}%`);
const lastName = (name) => (name || "").trim().split(/\s+/).pop();
const dayName = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const shortDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function buildDigest(snapshot) {
  const s = snapshot;
  const sections = [];
  const tx = Object.fromEntries(s.texas.races.map((r) => [r.id, r]));
  const senate = tx["tx-senate"], governor = tx["tx-governor"];

  // ---- headline ----
  const headline = [
    senate ? `${lastName(senate.democrat)} ${pct(senate.pollModel?.pD)} to win the Senate seat on a polling average of ${marginText(senate.pollingAverage?.margin)}.` : null,
    governor ? `${lastName(governor.democrat)} ${pct(governor.pollModel?.pD)} for governor.` : null,
    `Democrats ${pct(s.senateControl.pollModel?.control?.D)} to control the U.S. Senate, ${pct(s.usHouse?.model?.control?.D)} for the House, ${pct(s.txHouse.model?.control?.D)} for the Texas House.`,
  ].filter(Boolean).join(" ");

  // ---- what moved ----
  const changes = (s.changes || []).filter((c) => c.type !== "baseline");
  sections.push({
    title: "What moved",
    bullets: changes.length ? changes.slice(0, 12).map((c) => c.text) : [s.previousAsOf ? "Nothing crossed the alert thresholds since the last snapshot." : "First snapshot; movement tracking starts tomorrow."],
  });

  // ---- Texas statewide ----
  sections.push({
    title: "Texas statewide",
    bullets: s.texas.races.map((r) => {
      const latest = r.polls?.[0];
      const avg = r.pollingAverage;
      return `${r.office}: ${lastName(r.democrat)} ${pct(r.pollModel?.pD)}. Average ${marginText(avg?.margin)} over ${avg?.pollCount ?? 0} polls${latest ? `; latest ${latest.pollster}${latest.partisan ? ` (${latest.partisan})` : ""} ${shortDate(latest.endDate)} ${marginText(latest.dem - latest.rep)}` : ""}.`;
    }),
  });

  // ---- Texas Legislature ----
  const env = s.txLegislature?.environment;
  const closest = (chamber, prefix, n) => [...chamber.districts].filter((d) => d.modelD != null).sort((a, b) => Math.abs(a.modelD - 0.5) - Math.abs(b.modelD - 0.5)).slice(0, n).map((d) => `${prefix}-${d.district} ${pct(d.modelD)} D${d.rating ? ` (${d.rating})` : ""}`).join(", ");
  sections.push({
    title: "Texas Legislature",
    bullets: [
      env ? `Statewide environment ${marginText(env.margin)}: legislative generic ballot ${marginText(env.genericBallot)} over ${env.genericBallotPolls} polls, down-ballot statewide races ${marginText(env.downBallotMean)}; a ${env.swingFrom2024 >= 0 ? "D" : "R"}+${Math.abs(env.swingFrom2024).toFixed(1)} swing from Trump's 2024 margin.` : "No environment polls yet.",
      s.txHouse.model ? `Texas House: ${s.txHouse.current.D} D today; model expects ${s.txHouse.model.expected.D.toFixed(1)} D seats, ${pct(s.txHouse.model.control.D)} for a Democratic majority (76). Closest: ${closest(s.txHouse, "HD", 5)}.` : null,
      s.txSenate.model ? `Texas Senate: ${s.txSenate.current.D} D today; model expects ${s.txSenate.model.expected.D.toFixed(1)} D seats, ${pct(s.txSenate.model.control.D)} for a majority (16). Closest: ${closest(s.txSenate, "SD", 3)}.` : null,
    ].filter(Boolean),
  });

  // ---- U.S. Senate ----
  const c = s.senateControl;
  const battlegrounds = s.usSenate.races.filter((r) => r.pollModel?.pD != null && Math.abs(r.pollModel.pD - 0.5) <= 0.3).sort((a, b) => Math.abs(a.pollModel.pD - 0.5) - Math.abs(b.pollModel.pD - 0.5));
  sections.push({
    title: "U.S. Senate",
    bullets: [
      `Control: ${pct(c.pollModel?.control?.D)} for Democrats. Expected ${c.pollModel?.expected?.D?.toFixed(1)} Democratic-caucus seats; 51 needed.`,
      battlegrounds.length ? `Closest races: ${battlegrounds.map((r) => `${r.state} ${pct(r.pollModel.pD)} D (average ${marginText(r.pollingAverage?.margin)}, ${r.pollingAverage?.pollCount ?? 0} polls)`).join("; ")}.` : null,
    ].filter(Boolean),
  });

  // ---- U.S. House ----
  const h = s.usHouse;
  if (h) {
    const txPlay = h.districts.filter((d) => d.state === "TX" && d.modelD != null && Math.abs(d.modelD - 0.5) <= 0.35).sort((a, b) => a.district - b.district);
    sections.push({
      title: "U.S. House",
      bullets: [
        `Control: ${pct(h.model.control.D)} for Democrats (expected ${h.model.expected.D.toFixed(1)} seats, 218 needed). Generic ballot ${marginText(h.genericBallot?.average?.margin)} over ${h.genericBallot?.average?.pollCount ?? 0} polls.`,
        txPlay.length ? `Texas seats in play: ${txPlay.map((d) => `${d.id} ${pct(d.modelD)} D (${d.consensus?.label}${d.pollingAverage ? `, polls ${marginText(d.pollingAverage.margin)}` : ""})`).join("; ")}.` : "No Texas congressional seat is inside the competitive band.",
      ],
    });
  }

  // ---- coming up ----
  const asOfMs = Date.parse(s.asOf);
  const upcoming = KEY_DATES.filter((k) => Date.parse(k.date) >= asOfMs).slice(0, 4).map((k) => {
    const days = Math.round((Date.parse(k.date) - asOfMs) / 86_400_000);
    return `${k.label}: ${dayName(k.date)}${days === 0 ? " (today)" : days === 1 ? " (tomorrow)" : ` (in ${days} days)`}.`;
  });
  sections.push({ title: "Coming up", bullets: upcoming });

  const failed = Object.entries(s.sources).filter(([, v]) => !v.ok).map(([k]) => k);
  const notes = failed.length ? [`Could not reach ${failed.join(" and ")} this morning; those figures are carried over from the previous snapshot.`] : [];

  const digest = { date: s.asOf, dayName: dayName(s.asOf), headline, sections, notes };
  return { ...digest, text: toPlainText(digest) };
}

/** Plain-text rendering, ready for a chat message or email later. */
export function toPlainText(digest) {
  const lines = [`Texas Polls Tracker, ${digest.dayName}`, "", digest.headline, ""];
  for (const section of digest.sections) {
    lines.push(section.title.toUpperCase());
    for (const bullet of section.bullets) lines.push(`- ${bullet}`);
    lines.push("");
  }
  for (const note of digest.notes || []) lines.push(note);
  lines.push("https://texas-race-tracker.vercel.app");
  return lines.join("\n").trim();
}
