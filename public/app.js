/* 2026 Race Tracker front end. Reads data/latest.json + data/series.json and three TopoJSON files. No build step. */
(async function main() {
  const [snapshot, series, usTopo, houseTopo, senateTopo, congressTopo, legislatureResults] = await Promise.all([
    fetchJson("data/latest.json"), fetchJson("data/series.json").catch(() => []),
    fetchJson("geo/us-states.json"), fetchJson("geo/tx-house.json"), fetchJson("geo/tx-senate.json"), fetchJson("geo/tx-congress.json").catch(() => null),
    fetchJson("data/tx-legislature-results.json").catch(() => null),
  ]);
  LEGISLATURE_RESULTS = legislatureResults;
  const previousDay = series.length >= 2 ? series[series.length - 2] : null;
  SNAPSHOT = snapshot; PREVIOUS_DAY = previousDay; US_TOPO = usTopo;

  renderHeader(snapshot);
  renderMoves(snapshot);
  renderControl(snapshot, previousDay);
  renderSeatChart(snapshot);
  renderRatingLegend();
  renderSenateMap(snapshot, usTopo, previousDay);
  renderSenateTables(snapshot, previousDay);
  renderTexas(snapshot, previousDay);
  renderChamber("house", snapshot.txHouse, houseTopo, snapshot);
  renderChamber("senate", snapshot.txSenate, senateTopo, snapshot);
  renderUsHouse(snapshot, congressTopo, previousDay);
  renderGovernors(snapshot, usTopo, previousDay);
  renderCourts(snapshot);
  renderEarlyVote(snapshot).catch((error) => console.error("early vote", error));
  setupNeedle(snapshot).catch((error) => { document.getElementById("needle-status").textContent = `The election-night model could not load: ${error.message}`; console.error("needle", error); });
  setupAsk(snapshot).catch((error) => console.error("ask", error));
  setupSenateNight(snapshot).catch((error) => { document.getElementById("senate-night-status").textContent = `The Senate Election Night model could not load: ${error.message}`; console.error("senate night", error); });
  renderDigest(snapshot);
  renderPollsters(snapshot);
  setupScenarios(snapshot).catch((error) => { document.getElementById("tx-scenario-figures").innerHTML = `<p class="note">Scenario models could not load: ${esc(error.message)}</p>`; });
  renderTrends(snapshot, series);
  renderSources(snapshot);
})().catch((error) => {
  document.getElementById("asof").textContent = `Failed to load data: ${error.message}`;
  console.error(error);
});

// ---------- probabilities (polls model only) ----------
let SNAPSHOT = null, PREVIOUS_DAY = null, US_TOPO = null, LEGISLATURE_RESULTS = null;
let SENATE_MAP_MODE = "rating";
/** Democratic win probability for a race from the polls model (or the rating prior when a race has no polls). */
function raceProbability(race) {
  if (race.pollModel?.pD != null) return { p: race.pollModel.pD, source: race.pollModel.source === "polls" ? "polls" : "rating prior", detail: race.pollModel.source === "polls" ? `σ ${race.pollModel.sigma} · ${race.pollModel.effectiveN} eff. polls` : "no polls" };
  return { p: null, source: null, detail: "no polls" };
}
function previousRaceProbability(prev, raceId) { return prev?.races?.[raceId]?.pollModel ?? null; }
function modelName() { return "polls model"; }
document.querySelectorAll("button.mode[data-senate-map]").forEach((b) => b.addEventListener("click", () => {
  SENATE_MAP_MODE = b.dataset.senateMap;
  document.querySelectorAll("button.mode[data-senate-map]").forEach((x) => x.classList.toggle("active", x === b));
  if (SNAPSHOT) { renderRatingLegend(); renderSenateMap(SNAPSHOT, US_TOPO, PREVIOUS_DAY); }
}));

// ---------- constants ----------
const RATING_COLORS = {
  "Safe D": "--d4", "Solid D": "--d4", "Likely D": "--d3", "Lean D": "--d2", "Tilt D": "--d1",
  "Tossup": "--toss", "Tilt R": "--r1", "Lean R": "--r2", "Likely R": "--r3", "Safe R": "--r4", "Solid R": "--r4",
};
const RATING_ORDER = ["Safe D", "Likely D", "Lean D", "Tilt D", "Tossup", "Tilt R", "Lean R", "Likely R", "Safe R"];
const DARK_RATINGS = new Set(["Safe D", "Solid D", "Likely D", "Tossup", "Likely R", "Safe R", "Solid R"]);
const FIPS_TO_STATE = { "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY" };

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const ratingColor = (label) => (label && RATING_COLORS[label] ? cssVar(RATING_COLORS[label]) : cssVar("--notup"));
const pct = (p, digits = 0) => (p === null || p === undefined ? "—" : `${(p * 100).toFixed(digits)}%`);
const marginText = (m) => (m === null || m === undefined ? "—" : Math.abs(m) < 0.05 ? "Even" : `${m > 0 ? "D" : "R"}+${Math.abs(m).toFixed(1)}`);
const compact = (n) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtDate = (iso) => (!iso ? "" : /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : String(iso));
async function fetchJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); }

function ratingPill(label) {
  if (!label) return '<span class="muted">—</span>';
  const dark = DARK_RATINGS.has(label);
  return `<span class="pill ${dark ? "lightink" : ""}" style="background:${ratingColor(label)}">${esc(label)}</span>`;
}
function delta(current, previous, { unit = "pts", scale = 100, digits = 1, higherIsD = true } = {}) {
  if (current == null || previous == null) return "";
  const diff = (current - previous) * scale;
  if (Math.abs(diff) < 0.05) return '<span class="delta flat" title="unchanged since the previous update">no change</span>';
  const towardD = (diff > 0) === higherIsD;
  return `<span class="delta ${towardD ? "to-d" : "to-r"}" title="change since the previous update, toward ${towardD ? "Democrats" : "Republicans"}">${diff > 0 ? "+" : "−"}${Math.abs(diff).toFixed(digits)}${unit ? ` ${unit}` : ""}</span>`;
}

// ---------- header & moves ----------
function renderHeader(s) {
  const generated = new Date(s.generatedAt);
  const day = generated.toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const time = generated.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
  const failed = Object.entries(s.sources).filter(([, v]) => !v.ok).map(([k]) => k);
  const compared = s.previousAsOf ? ` Changes are measured against the ${fmtDate(s.previousAsOf)} snapshot.` : " This is the first snapshot, so there is nothing to compare against yet.";
  document.getElementById("asof").textContent = `Snapshot taken ${day} at ${time} Central.${compared}${failed.length ? ` Could not reach ${failed.join(" and ")} this run, so those numbers are carried over.` : ""}`;
  renderBoard(s, PREVIOUS_DAY);
}

/** Hero board: the marquee Texas races as split probability bars, plus Senate control. */
function renderBoard(s, prev) {
  const leads = [];
  for (const id of ["tx-senate", "tx-governor", "tx-ltgov", "tx-ag"]) {
    const race = s.texas.races.find((r) => r.id === id);
    if (!race) continue;
    const sel = raceProbability(race);
    const prevP = previousRaceProbability(prev, race.id);
    leads.push(`<div class="lead">
      <p class="race"><b>Texas ${esc(race.office === "U.S. Senate" ? "U.S. Senate" : race.office)}</b>, ${esc(lastName(race.democrat))} (D) against ${esc(lastName(race.republican))} (R)</p>
      <div class="big">${pct(sel.p)}<small>chance ${esc(lastName(race.democrat))} wins</small>${delta(sel.p, prevP)}</div>
      ${splitBar(sel.p)}
      <p class="sub">Polling average <b>${marginText(race.pollingAverage?.margin)}</b> across ${race.pollingAverage?.pollCount ?? 0} polls${race.polls?.[0] ? `; latest ${esc(race.polls[0].pollster)} ${marginText(race.polls[0].dem - race.polls[0].rep)}` : ""}.</p>
    </div>`);
  }
  document.getElementById("board").innerHTML = leads.join("");
  renderControlStrip(s, prev);
}

/** Chamber-control strip under the board: U.S. Senate, U.S. House, Texas House, Texas Senate. */
function renderControlStrip(s, prev) {
  const c = s.senateControl;
  const h = s.usHouse;
  const items = [
    { k: "U.S. Senate, Democratic control", v: pct(c.pollModel?.control?.D) + delta(c.pollModel?.control?.D, prev?.control?.pollModel), s: `${c.current.democraticCaucus} D to ${c.current.republican} R today; expected ${c.pollModel ? c.pollModel.expected.D.toFixed(1) : "—"} D seats, 51 needed.` },
    { k: "U.S. House, Democratic control", v: pct(h?.model?.control?.D) + delta(h?.model?.control?.D, prev?.usHouse?.control), s: h ? `${h.composition.R} R to ${h.composition.D} D today; expected ${h.model.expected.D.toFixed(1)} D seats, 218 needed. Generic ballot ${marginText(h.genericBallot?.average?.margin)}.` : "unavailable" },
    { k: "Texas House, Democratic control", v: pct(s.txHouse.model?.control?.D) + delta(s.txHouse.model?.control?.D, prev?.txHouseModel?.control), s: `${s.txHouse.current.D} D to ${s.txHouse.current.R} R today; expected ${s.txHouse.model ? s.txHouse.model.expected.D.toFixed(1) : "—"} D seats, 76 needed.` },
    { k: "Texas Senate, Democratic control", v: pct(s.txSenate.model?.control?.D) + delta(s.txSenate.model?.control?.D, prev?.txSenateModel?.control), s: `${s.txSenate.current.D} D to ${s.txSenate.current.R} R today; expected ${s.txSenate.model ? s.txSenate.model.expected.D.toFixed(1) : "—"} D seats, 16 needed.` },
  ];
  document.getElementById("control-strip").innerHTML = items.map((t) => `<div class="figure"><div class="k">${esc(t.k)}</div><div class="v">${t.v}</div><div class="s">${esc(t.s)}</div></div>`).join("");
}
function splitBar(p) {
  if (p == null) return '<div class="split" aria-hidden="true"></div>';
  const d = Math.round(p * 1000) / 10;
  return `<div class="split" role="img" aria-label="${d}% Democratic, ${(100 - d).toFixed(1)}% Republican"><span class="d" style="width:${d}%"></span><span class="r" style="width:${100 - d}%"></span></div>`;
}
function lastName(name) { return (name || "").trim().split(/\s+/).pop(); }
function renderMoves(s) {
  const list = document.getElementById("moves-list");
  if (!s.changes?.length) { list.innerHTML = '<li><span class="tag">Quiet</span>Nothing crossed the alert thresholds since the last snapshot.</li>'; return; }
  list.innerHTML = s.changes.slice(0, 30).map((c) => `<li><span class="tag ${esc(c.type)}">${esc(labelForType(c.type))}</span><span>${esc(c.text)}</span></li>`).join("");
}
function labelForType(type) { return { rating: "Rating", market: "Market", poll: "New poll", "poll-average": "Poll average", "poll-model": "Polls model", control: "Control", baseline: "Baseline" }[type] || type; }

// ---------- senate control ----------
function renderControl(s, prev) {
  const c = s.senateControl;
  const pm = c.pollModel;
  const tiles = [
    { k: "Today", v: `${c.current.democraticCaucus} D, ${c.current.republican} R`, s: "Democratic caucus includes independents Sanders and King" },
    { k: "Democratic control", v: pct(pm?.control?.D) + delta(pm?.control?.D, prev?.control?.pollModel), s: pm ? `expected ${pm.expected.D.toFixed(1)} D, ${pm.expected.R.toFixed(1)} R${pm.expected.other >= 0.05 ? `, ${pm.expected.other.toFixed(1)} other` : ""}; 51 needed` : "unavailable", primary: true },
    { k: "Republican control", v: pct(pm?.control?.R), s: "50 seats with the Vice President's tiebreak, or more" },
    { k: "No majority for either side", v: pct(pm?.control?.none), s: "an independent holds the balance" },
  ];
  document.getElementById("control-tiles").innerHTML = tiles.map((t) => `<div class="figure${t.primary ? " primary" : ""}"><div class="k">${esc(t.k)}</div><div class="v">${t.v}</div><div class="s">${esc(t.s)}</div></div>`).join("");
}

function renderSeatChart(s) {
  const c = s.senateControl;
  renderSeatHistogram("seat-chart", "seat-chart-title", { histogram: c.pollModel.histogram, control: c.pollModel.control, expected: c.pollModel.expected, majority: 51, notUp: { D: c.notUp.democraticCaucus, R: c.notUp.republican } }, "U.S. Senate");
  document.getElementById("seat-note").textContent = `Polls model over the ${s.usSenate.races.length} seats on the ballot; ${c.notUp.democraticCaucus} Democratic-caucus and ${c.notUp.republican} Republican seats are not up. Races are treated as independent, so the chance of a uniform swing is understated.`;
}
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

// ---------- senate map ----------
const probabilityScale = () => d3.scaleDiverging().domain([0, 0.5, 1]).interpolator((t) => d3.interpolateRgbBasis([cssVar("--r3"), cssVar("--r2"), "#e9e9e6", cssVar("--d2"), cssVar("--d3")])(t));
function renderRatingLegend() {
  const el = document.getElementById("rating-legend");
  if (SENATE_MAP_MODE === "probability") {
    const scale = probabilityScale();
    el.innerHTML = [0.02, 0.15, 0.3, 0.5, 0.7, 0.85, 0.98].map((p) => `<span><i class="sw" style="background:${scale(p)}"></i>${p === 0.5 ? "50/50" : `${Math.round(p * 100)}% D`}</span>`).join("") + `<span><i class="sw" style="background:${cssVar("--notup")}"></i>Not up / no data</span>`;
    return;
  }
  el.innerHTML = RATING_ORDER.map((r) => `<span><i class="sw" style="background:${ratingColor(r)}"></i>${r}</span>`).join("") + `<span><i class="sw" style="background:${cssVar("--notup")}"></i>Not up in 2026</span>`;
}
function renderSenateMap(s, topo, prev) {
  const byState = new Map(s.usSenate.races.map((r) => [r.state, r]));
  const width = 960, height = 560;
  const svgRoot = d3.select("#senate-map").html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", "U.S. Senate race ratings by state");
  const svg = svgRoot.append("g").attr("class", "zoom-root");
  const features = topojson.feature(topo, topo.objects.states).features.filter((f) => FIPS_TO_STATE[f.id] && FIPS_TO_STATE[f.id] !== "DC");
  const projection = d3.geoAlbersUsa().fitSize([width, height], { type: "FeatureCollection", features });
  const path = d3.geoPath(projection);
  const scale = probabilityScale();
  const fillFor = (race) => {
    if (!race) return cssVar("--notup");
    if (SENATE_MAP_MODE === "probability") { const { p } = raceProbability(race); return p == null ? cssVar("--notup") : scale(p); }
    return ratingColor(race.consensus?.label);
  };
  const darkFill = (race) => (SENATE_MAP_MODE === "probability" ? Math.abs((raceProbability(race).p ?? 0.5) - 0.5) > 0.2 : DARK_RATINGS.has(race.consensus?.label));
  svg.append("g").selectAll("path").data(features).join("path")
    .attr("d", path)
    .attr("fill", (f) => fillFor(byState.get(FIPS_TO_STATE[f.id])))
    .attr("class", (f) => (byState.has(FIPS_TO_STATE[f.id]) ? "rated" : ""))
    .on("mousemove", (event, f) => { const race = byState.get(FIPS_TO_STATE[f.id]); showTooltip(event, race ? senateTooltip(race, s, prev) : `<b>${esc(f.properties.name)}</b><br>No Senate seat up in 2026`); })
    .on("mouseleave", hideTooltip);
  svg.append("g").selectAll("text").data(features.filter((f) => byState.has(FIPS_TO_STATE[f.id]))).join("text")
    .attr("class", "state-label").attr("text-anchor", "middle").attr("transform", (f) => `translate(${path.centroid(f)})`).attr("dy", "0.35em")
    .attr("fill", (f) => (darkFill(byState.get(FIPS_TO_STATE[f.id])) ? "#fff" : "#111"))
    .text((f) => FIPS_TO_STATE[f.id]);
  attachZoom(svgRoot, "senate-map", { width, height });
}
function senateTooltip(race, s, prev) {
  const prevRace = prev?.races?.[race.id];
  const rows = [];
  const cand = race.candidates || {};
  rows.push(`<b>${esc(race.stateName)}${race.special ? " (special)" : ""}</b> · ${race.incumbentParty ? `${race.incumbentParty}-held` : ""}${race.pvi ? ` · PVI ${esc(race.pvi)}` : ""}`);
  if (cand.D || cand.R) rows.push(`${esc(cand.D || "Democrat")} (D) vs ${esc(cand.R || "Republican")} (R)${cand.I ? ` vs ${esc(cand.I)} (I)` : ""}`);
  rows.push("<hr>");
  rows.push(`<div class="row"><span>Consensus rating</span><span>${esc(race.consensus?.label || "—")}</span></div>`);
  for (const f of s.usSenate.forecasters) if (race.ratings[f.key]) rows.push(`<div class="row"><span>${esc(f.name)}</span><span>${esc(race.ratings[f.key])}</span></div>`);
  rows.push("<hr>");
  const sel = raceProbability(race);
  rows.push(`<div class="row"><span><b>${esc(race.independentRace ? `${race.candidates?.I || "Independent"} wins` : "D wins")}, polls model</b></span><span><b>${pct(race.independentRace ? race.pI : sel.p)}</b>${sel.detail ? ` · ${esc(sel.detail)}` : ""}</span></div>`);
  if (race.pollingAverage) rows.push(`<div class="row"><span>Polling avg (${race.pollingAverage.pollCount} polls)</span><span>${marginText(race.pollingAverage.margin)}${prevRace?.poll != null ? ` (prev ${marginText(prevRace.poll)})` : ""}</span></div>`);
  return rows.join("");
}

function renderSenateTables(s, prev) {
  const races = [...s.usSenate.races];
  const competitiveness = (r) => Math.abs(r.consensus?.score ?? 4) + (raceProbability(r).p != null ? Math.abs(raceProbability(r).p - 0.5) : 0.4);
  races.sort((a, b) => competitiveness(a) - competitiveness(b));
  const battlegrounds = races.filter((r) => Math.abs(r.consensus?.score ?? 4) <= 3 || (raceProbability(r).p != null && Math.abs(raceProbability(r).p - 0.5) < 0.35));
  const render = (list, table) => {
    const head = `<tr><th>State</th><th>Matchup</th><th>Consensus</th><th title="${esc(s.usSenate.forecasters.map((f) => f.name).join(", "))}">Ratings<span class="sub">${s.usSenate.forecasters.map((f) => esc(shortName(f.name))).join(", ")}</span></th><th class="num">Poll average</th><th class="num">D wins<span class="sub">polls model</span></th><th>Trend</th></tr>`;
    const body = list.map((r) => {
      const p = prev?.races?.[r.id];
      return `<tr>
        <td><b>${esc(r.state)}</b>${r.special ? ' <span class="muted">sp.</span>' : ""} <span class="muted">${esc(r.incumbentParty || "")}</span></td>
        <td class="wrap">${r.candidates?.D ? `${esc(r.candidates.D)} <span class="muted">(D)</span>` : '<span class="muted">no major Democrat</span>'} / ${esc(r.candidates?.R || "—")} <span class="muted">(R)</span>${r.candidates?.I ? ` / ${esc(r.candidates.I)} <span class="muted">(I)</span>` : ""}</td>
        <td>${ratingPill(r.consensus?.label)}</td>
        <td class="ratings-cell">${s.usSenate.forecasters.map((f) => miniRating(r.ratings[f.key])).join("")}</td>
        <td class="num">${marginText(r.pollingAverage?.margin)}${r.pollingAverage ? `<span class="thin">n=${r.pollingAverage.pollCount}</span>` : ""}${delta(r.pollingAverage?.margin, p?.poll, { scale: 1, unit: "" })}</td>
        <td class="num"><b>${r.independentRace ? `${pct(r.pI)}<span class="thin">${esc(r.candidates?.I || "independent")}</span>` : pct(raceProbability(r).p)}</b>${!r.independentRace && raceProbability(r).source && raceProbability(r).source !== "polls" ? `<span class="thin">${esc(raceProbability(r).source)}</span>` : ""}${r.independentRace ? "" : delta(raceProbability(r).p, previousRaceProbability(prev, r.id))}</td>
        <td>${sparkline(r.id, "pollModel")}</td>
      </tr>`;
    }).join("");
    document.getElementById(table).innerHTML = head + body;
  };
  render(battlegrounds, "senate-table");
  render(races.sort((a, b) => a.stateName.localeCompare(b.stateName)), "senate-table-all");
}
function shortName(name) { return { "Cook Political Report": "Cook", "Decision Desk HQ": "DDHQ", "The Economist": "Econ", "FiftyPlusOne": "FPO", "Fox News": "Fox", "Inside Elections": "IE", "RealClearPolitics": "RCP", "Sabato's Crystal Ball": "Sabato", "Silver Bulletin": "Silver", "Split Ticket": "ST" }[name] || name; }
function miniRating(label) { return `<i class="sw" title="${esc(label || "—")}" style="background:${ratingColor(label)};margin-right:2px"></i>`; }

// ---------- sparklines from series.json ----------
let SERIES = [];
fetch("data/series.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : [])).then((d) => { SERIES = d; }).catch(() => {});
function sparkline(raceId, field) {
  const values = SERIES.map((day) => day.races?.[raceId]?.[field]).filter((v) => v != null);
  if (values.length < 2) return '<span class="muted">—</span>';
  const w = 70, h = 18;
  const x = d3.scaleLinear().domain([0, values.length - 1]).range([1, w - 1]);
  const y = d3.scaleLinear().domain(d3.extent(values)).range([h - 2, 2]);
  const d = d3.line().x((v, i) => x(i)).y((v) => y(v))(values);
  return `<svg class="spark" width="${w}" height="${h}" aria-label="trend"><path d="${d}" fill="none" stroke="#555" stroke-width="1.5"/></svg>`;
}

// ---------- texas statewide ----------
function renderTexas(s, prev) {
  const races = s.texas.races;
  const head = `<tr><th>Race</th><th>Democrat</th><th>Republican</th><th class="num">Poll average</th><th>Latest poll</th><th>Ratings</th><th class="num">D wins<span class="sub">polls model</span></th></tr>`;
  const body = races.map((r) => {
    const p = prev?.races?.[r.id];
    const latest = r.polls?.[0];
    const ratingList = Object.values(r.ratings || {});
    const ratings = ratingList.length ? `<span title="${esc(ratingList.map((v) => `${v.name}: ${v.label}`).join("\n"))}">${ratingPill(r.consensus?.label)} <span class="thin">${ratingList.length} source${ratingList.length === 1 ? "" : "s"}</span></span>` : "";
    return `<tr>
      <td><b>${esc(r.office)}</b></td>
      <td>${esc(r.democrat)}</td><td>${esc(r.republican)}</td>
      <td class="num">${marginText(r.pollingAverage?.margin)}${r.pollingAverage ? `<span class="thin">n=${r.pollingAverage.pollCount}</span>` : ""}${delta(r.pollingAverage?.margin, p?.poll, { scale: 1, unit: "" })}</td>
      <td class="wrap">${latest ? `${esc(latest.pollster)}${latest.partisan ? ` (${esc(latest.partisan)})` : ""} <span class="muted">${fmtDate(latest.endDate)}</span>: <b>${marginText(latest.dem - latest.rep)}</b>` : '<span class="muted">no public polls found</span>'}</td>
      <td>${ratings || '<span class="muted">—</span>'}</td>
      <td class="num" title="${esc(raceProbability(r).detail || "")}"><b>${pct(raceProbability(r).p)}</b>${delta(raceProbability(r).p, previousRaceProbability(prev, r.id))}</td>
    </tr>`;
  }).join("");
  document.getElementById("texas-table").innerHTML = head + body;
  renderTexasTrails(races);

  const detail = document.getElementById("texas-detail");
  detail.innerHTML = races.map((r) => {
    const weightFor = (poll) => (r.pollingAverage?.weights || []).find((w) => w.id === poll.id || (poll.alsoIds || []).includes(w.id));
    const polls = (r.polls || []).slice(0, 10).map((poll) => { const w = weightFor(poll); return `<tr><td>${esc(poll.pollster)}${poll.partisan ? ` <span class="muted">(${esc(poll.partisan)})</span>` : ""}${poll.internal ? ' <span class="muted">internal</span>' : ""}</td><td>${esc(poll.startDate ? `${fmtDate(poll.startDate)}–${fmtDate(poll.endDate)}` : fmtDate(poll.endDate))}</td><td class="num">${poll.sampleSize ? poll.sampleSize.toLocaleString() : "—"}${poll.population ? ` ${esc(poll.population)}` : ""}</td><td class="num">${poll.dem}%</td><td class="num">${poll.rep}%</td><td class="num"><b>${marginText(poll.dem - poll.rep)}</b></td><td title="${esc(w?.ratedAs ? `538 rating as ${w.ratedAs}` : "not in FiveThirtyEight's ratings")}">${w?.grade ? esc(w.grade) : '<span class="muted">unrated</span>'}</td><td class="num muted">${w ? w.weight.toFixed(2) : "—"}</td><td>${poll.url ? `<a href="${esc(poll.url)}" rel="noopener">source</a>` : ""}</td></tr>`; }).join("");
    const aggregates = (r.aggregates || []).map((a) => `<span class="pill" style="background:#f3f2ee">${esc(a.source)}: ${marginText(a.margin)}</span>`).join(" ");
    const ratingRows = Object.values(r.ratings || {}).map((v) => `<span title="${esc(v.asOf || "")}">${esc(v.name)}: ${ratingPill(v.label)}</span>`).join(", ");
    const statewide = "";
    return `<details class="race-card"><summary>${esc(r.office)}: ${esc(r.democrat)} (D) against ${esc(r.republican)} (R), ${r.polls?.length || 0} polls (<a href="${esc(r.wikipediaUrl)}" rel="noopener">Wikipedia</a>)</summary>
      ${ratingRows ? `<p class="meta">Forecaster ratings: ${ratingRows}</p>` : ""}
      ${aggregates ? `<p class="meta">Published averages: ${aggregates}</p>` : ""}
      ${statewide}
      ${r.pollModel?.pD != null ? `<p class="meta">Polls model: <b>${pct(r.pollModel.pD)} ${esc(lastName(r.democrat))}</b>. Weighted margin ${marginText(r.pollModel.margin)}, error scale ${r.pollModel.sigma} points, ${r.pollModel.effectiveN} effective polls, ${r.pollModel.daysToElection} days to the election.</p>` : ""}
      ${polls ? `<div class="table-scroll"><table class="data"><tr><th>Pollster</th><th>Dates</th><th class="num">Sample</th><th class="num">D</th><th class="num">R</th><th class="num">Margin</th><th>538 grade</th><th class="num">Weight</th><th></th></tr>${polls}</table></div>` : '<p class="meta">No general-election polls found in VoteHub or Wikipedia yet.</p>'}
    </details>`;
  }).join("");
}

// ---------- texas statewide: polling average and polls-model trails ----------
// One figure per race, two stacked panels sharing a time axis: the D margin (polling average line over
// individual poll dots) and the polls-model D win chance. Data is race.trail, rebuilt daily by ingest/build.js.
function renderTexasTrails(races) {
  const grid = document.getElementById("texas-charts");
  if (!grid) return;
  grid.innerHTML = "";
  const chartableRaces = races.filter((race) => (race.trail || []).length >= 2);
  for (const race of races) {
    const box = document.createElement("div");
    box.className = "race-trail";
    const trail = race.trail || [];
    box.innerHTML = raceTrailHeader(race);
    grid.appendChild(box);
    if (trail.length < 2) continue;
    drawRaceTrail(box, race, trail);
    // Clicking (or Enter/Space on) a chart opens the enlarged carousel at that race.
    const openViewer = () => openChartViewer(chartableRaces, chartableRaces.indexOf(race));
    box.tabIndex = 0;
    box.setAttribute("role", "button");
    box.setAttribute("aria-label", `Enlarge the ${race.office} chart`);
    box.addEventListener("click", openViewer);
    box.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openViewer(); } });
  }
}

function raceTrailHeader(race) {
  const trail = race.trail || [];
  const latestPoint = trail[trail.length - 1];
  return `<h4>${esc(race.office)}</h4><p class="sub-head">${esc(race.democrat)} (D) against ${esc(race.republican)} (R)</p>
    <p class="now">${latestPoint ? `Average <b>${marginText(latestPoint.margin)}</b>, ${esc(lastName(race.democrat))} wins <b>${pct(latestPoint.pD)}</b>` : "No polls yet"}</p>`;
}

// ---------- enlarged chart carousel (a native <dialog>: Escape, focus trap, and backdrop come free) ----------
const chartViewer = { races: [], index: 0, wired: false };
function openChartViewer(races, startIndex) {
  const dialog = document.getElementById("chart-viewer");
  if (!dialog || startIndex < 0) return;
  chartViewer.races = races;
  chartViewer.index = startIndex;
  if (!chartViewer.wired) wireChartViewer(dialog);
  // The dialog sits in the browser's top layer, above everything in <body>, so the tooltip must live inside it.
  dialog.appendChild(tooltip);
  hideTooltip();
  showChartViewerRace();
  document.documentElement.style.overflow = "hidden"; // keep the page behind the viewer from scrolling
  dialog.showModal();
}

function showChartViewerRace() {
  const { races, index } = chartViewer;
  const race = races[index];
  const body = document.getElementById("viewer-body");
  body.innerHTML = raceTrailHeader(race);
  // Wider viewBox and taller panels than the grid, so text stays the same size while the plot area grows.
  const isNarrowScreen = window.innerWidth < 600;
  drawRaceTrail(body, race, race.trail, isNarrowScreen
    ? { width: 520, marginPanelHeight: 220, probabilityPanelHeight: 130 }
    : { width: 1000, marginPanelHeight: Math.max(220, Math.min(380, window.innerHeight * 0.38)), probabilityPanelHeight: Math.max(130, Math.min(200, window.innerHeight * 0.2)) });
  document.getElementById("viewer-count").textContent = `${index + 1} of ${races.length}`;
  hideTooltip();
}

function stepChartViewer(step) {
  const count = chartViewer.races.length;
  chartViewer.index = (chartViewer.index + step + count) % count; // wraps around at both ends
  showChartViewerRace();
}

function wireChartViewer(dialog) {
  chartViewer.wired = true;
  dialog.querySelector('[data-viewer="prev"]').addEventListener("click", () => stepChartViewer(-1));
  dialog.querySelector('[data-viewer="next"]').addEventListener("click", () => stepChartViewer(1));
  dialog.querySelector('[data-viewer="close"]').addEventListener("click", () => dialog.close());
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); stepChartViewer(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); stepChartViewer(1); }
  });
  // A click on the backdrop lands on the dialog element itself, outside its content box.
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    if (outside) dialog.close();
  });
  // Horizontal swipe of at least 50px that is mostly sideways moves one race.
  let touchStart = null;
  dialog.addEventListener("touchstart", (event) => { const t = event.touches[0]; touchStart = { x: t.clientX, y: t.clientY }; }, { passive: true });
  dialog.addEventListener("touchend", (event) => {
    if (!touchStart) return;
    const t = event.changedTouches[0];
    const dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5) stepChartViewer(dx < 0 ? 1 : -1);
  });
  dialog.addEventListener("close", () => { hideTooltip(); document.body.appendChild(tooltip); document.documentElement.style.overflow = ""; });
  // Redraw at the new size if the window is resized while open.
  window.addEventListener("resize", () => { if (dialog.open) showChartViewerRace(); });
}

function drawRaceTrail(box, race, trail, { width = 520, marginPanelHeight = 150, probabilityPanelHeight = 96, gapBetweenPanels = 42 } = {}) {
  const margin = { top: 16, right: 14, bottom: 24, left: 44 };
  const height = margin.top + marginPanelHeight + gapBetweenPanels + probabilityPanelHeight + margin.bottom;
  const parseDay = (iso) => new Date(`${iso}T12:00:00`);
  const firstDay = parseDay(trail[0].date), lastDay = parseDay(trail[trail.length - 1].date);
  const dColor = cssVar("--d3"), rColor = cssVar("--r3"), ink = cssVar("--ink");

  // Individual polls inside the charted window, plotted at their fieldwork end date.
  const pollDots = (race.polls || [])
    .filter((poll) => poll.endDate && parseDay(poll.endDate) >= firstDay && parseDay(poll.endDate) <= lastDay)
    .map((poll) => ({ poll, day: parseDay(poll.endDate), margin: poll.dem - poll.rep }));

  const x = d3.scaleTime().domain([firstDay, lastDay]).range([margin.left, width - margin.right]);

  // Margin panel: symmetric-ish domain that always includes Even and every poll dot.
  const marginValues = [0, ...trail.map((p) => p.margin), ...pollDots.map((d) => d.margin)];
  const [marginLow, marginHigh] = d3.extent(marginValues);
  const marginPad = Math.max(1, (marginHigh - marginLow) * 0.1);
  const marginTop = margin.top, marginBottom = margin.top + marginPanelHeight;
  const yMargin = d3.scaleLinear().domain([marginLow - marginPad, marginHigh + marginPad]).nice().range([marginBottom, marginTop]);

  // Win-chance panel: fixed 0 to 100 percent.
  const probabilityTop = marginBottom + gapBetweenPanels, probabilityBottom = probabilityTop + probabilityPanelHeight;
  const yProbability = d3.scaleLinear().domain([0, 1]).range([probabilityBottom, probabilityTop]);

  const svg = d3.select(box).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img")
    .attr("aria-label", `${race.office}: polling average and polls-model win chance over time`);

  // Gridlines and axes for both panels.
  const signedMargin = (v) => (v === 0 ? "Even" : `${v > 0 ? "D" : "R"}+${Math.abs(v)}`);
  svg.append("g").attr("class", "grid").selectAll("line").data(yMargin.ticks(4)).join("line")
    .attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", (v) => yMargin(v)).attr("y2", (v) => yMargin(v));
  svg.append("g").attr("class", "grid").selectAll("line").data([0, 0.25, 0.75, 1]).join("line")
    .attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", (v) => yProbability(v)).attr("y2", (v) => yProbability(v));
  svg.append("line").attr("class", "even-line").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", yMargin(0)).attr("y2", yMargin(0));
  svg.append("line").attr("class", "even-line").attr("stroke-dasharray", "3 3").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", yProbability(0.5)).attr("y2", yProbability(0.5));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(yMargin).ticks(4).tickFormat(signedMargin).tickSize(0)).select(".domain").remove();
  svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(yProbability).tickValues([0, 0.5, 1]).tickFormat((v) => `${Math.round(v * 100)}%`).tickSize(0)).select(".domain").remove();
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${probabilityBottom})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(d3.timeFormat("%b %-d")).tickSize(0)).select(".domain").remove();
  svg.append("text").attr("class", "panel-label").attr("x", margin.left + 4).attr("y", marginTop - 4).text("Polling average, D margin");
  svg.append("text").attr("class", "panel-label").attr("x", margin.left + 4).attr("y", probabilityTop - 10).text(`${lastName(race.democrat)} win chance, polls model`);

  // Poll dots, colored by which side the poll favored, behind the average line.
  svg.append("g").selectAll("circle").data(pollDots).join("circle")
    .attr("cx", (d) => x(d.day)).attr("cy", (d) => yMargin(d.margin)).attr("r", 3)
    .attr("fill", (d) => (d.margin > 0 ? dColor : d.margin < 0 ? rColor : cssVar("--toss"))).attr("fill-opacity", 0.35);

  // Average line, and win-chance line.
  svg.append("path").datum(trail).attr("fill", "none").attr("stroke", ink).attr("stroke-width", 2)
    .attr("d", d3.line().x((p) => x(parseDay(p.date))).y((p) => yMargin(p.margin)));
  const withProbability = trail.filter((p) => p.pD != null);
  svg.append("path").datum(withProbability).attr("fill", "none").attr("stroke", dColor).attr("stroke-width", 2)
    .attr("d", d3.line().x((p) => x(parseDay(p.date))).y((p) => yProbability(p.pD)));

  // Hover: a vertical rule plus markers on both lines, with that day's numbers in the tooltip.
  const hover = svg.append("g").style("display", "none");
  hover.append("line").attr("class", "hover-line").attr("y1", marginTop).attr("y2", probabilityBottom);
  const marginMarker = hover.append("circle").attr("r", 4).attr("fill", ink).attr("stroke", "#fff").attr("stroke-width", 1.5);
  const probabilityMarker = hover.append("circle").attr("r", 4).attr("fill", dColor).attr("stroke", "#fff").attr("stroke-width", 1.5);
  const bisectDay = d3.bisector((p) => parseDay(p.date)).center;
  svg.append("rect").attr("x", margin.left).attr("y", marginTop).attr("width", width - margin.left - margin.right)
    .attr("height", probabilityBottom - marginTop).attr("fill", "transparent")
    .on("mousemove", (event) => {
      const [pointerX] = d3.pointer(event);
      const point = trail[bisectDay(trail, x.invert(pointerX))];
      const pointX = x(parseDay(point.date));
      hover.style("display", null);
      hover.select("line").attr("x1", pointX).attr("x2", pointX);
      marginMarker.attr("cx", pointX).attr("cy", yMargin(point.margin));
      probabilityMarker.attr("cx", pointX).attr("cy", point.pD == null ? -99 : yProbability(point.pD));
      const pollsThatDay = pollDots.filter((d) => d.poll.endDate === point.date);
      showTooltip(event, `<b>${esc(race.office)}</b>, ${fmtDate(point.date)}
        <div class="row"><span>Polling average</span><span>${marginText(point.margin)}</span></div>
        <div class="row"><span>${esc(lastName(race.democrat))} win chance</span><span>${pct(point.pD)}</span></div>
        <div class="row"><span>Polls in average</span><span>${point.pollCount}</span></div>
        ${pollsThatDay.map((d) => `<div class="row"><span>${esc(d.poll.pollster)}</span><span>${marginText(d.margin)}</span></div>`).join("")}`);
    })
    .on("mouseleave", () => { hover.style("display", "none"); hideTooltip(); });
}

// ---------- texas legislature ----------
function renderChamber(kind, chamber, topo, s) {
  const prefix = `tx-${kind}`;
  const districts = new Map(chamber.districts.map((d) => [d.district, d]));
  const current = chamber.current;
  const counts = chamber.summary.ratingCounts || {};
  const rated = Object.entries(counts).sort((a, b) => RATING_ORDER.indexOf(a[0]) - RATING_ORDER.indexOf(b[0])).map(([k, v]) => `${v} ${k}`).join(", ");
  const model = chamber.model;
  const env = model?.environment;
  // Unofficial results from the state's file: each district's leader, the new chamber, and the flips.
  const results = LEGISLATURE_RESULTS?.[kind] ?? null;
  const resultOf = (d) => results?.[d.district] ?? null;
  const flipped = (d) => Boolean(resultOf(d) && d.party && resultOf(d).leader !== d.party);
  const tiles = [];
  let resultSeatsD = null;
  if (results) {
    const count = (list, key) => list.reduce((t, d) => ({ ...t, [key(d)]: (t[key(d)] || 0) + 1 }), {});
    const held = count(chamber.districts, (d) => d.party), won = count(chamber.districts.filter(resultOf), (d) => resultOf(d).leader);
    const seatsD = current.D - (held.D || 0) + (won.D || 0), seatsR = current.R - (held.R || 0) + (won.R || 0);
    const toD = chamber.districts.filter((d) => flipped(d) && resultOf(d).leader === "D").length, toR = chamber.districts.filter((d) => flipped(d) && resultOf(d).leader === "R").length;
    const majority = seatsD >= chamber.majority ? "Democratic majority" : seatsR >= chamber.majority ? "Republican majority" : "no majority";
    tiles.push({ k: "Results, unofficial", v: `${seatsD} D, ${seatsR} R`, s: `${majority}; was ${current.D} D, ${current.R} R. ${toD || toR ? `${toD ? `${toD} flipped to Democrats` : ""}${toD && toR ? ", " : ""}${toR ? `${toR} to Republicans` : ""}` : "No seats changed party"}. From the Secretary of State's file${LEGISLATURE_RESULTS.lastUpdated ? `, last updated ${LEGISLATURE_RESULTS.lastUpdated}` : ""}.`, primary: true });
    resultSeatsD = seatsD;
  }
  tiles.push(
    { k: results ? "Before the election" : "Today", v: `${current.D} D, ${current.R} R`, s: `${chamber.majority} seats make a majority; ${chamber.upForElection} seats ${results ? "were" : "are"} up` },
    { k: "Our model, Democratic control", v: model ? pct(model.control.D) : "—", s: model ? `expected ${model.expected.D.toFixed(1)} D, ${model.expected.R.toFixed(1)} R` : "unavailable", primary: !results },
  );
  tiles.push(
    { k: "Statewide environment", v: env ? marginText(env.margin) : "—", s: env ? `generic ballot ${marginText(env.genericBallot)} over ${env.genericBallotPolls} polls; down-ballot races ${marginText(env.downBallotMean)}; swing ${env.swingFrom2024 > 0 ? "D" : "R"}+${Math.abs(env.swingFrom2024).toFixed(1)} from 2024` : "no polls" },
    { k: `Seats rated by ${chamber.ratingSource?.name || "State Navigate"}`, v: String(Object.values(counts).reduce((a, b) => a + b, 0)), s: rated || "none" },
  );
  const preds = Object.values(chamber.chamberPredictions || {});
  if (preds.length) tiles.push({ k: "Chamber ratings", v: preds.map((p) => p.label).join(", "), s: preds.map((p) => `${p.name}${p.asOf ? ` (${p.asOf})` : ""}`).join("; ") });
  document.getElementById(`${prefix}-tiles`).innerHTML = tiles.map((t) => `<div class="figure${t.primary ? " primary" : ""}"><div class="k">${esc(t.k)}</div><div class="v${/^[\d.,% ]+$|^\d+ D, \d+ R$/.test(t.v) ? "" : " text"}">${esc(t.v)}</div><div class="s">${esc(t.s)}</div></div>`).join("");

  const width = 800, height = 760;
  const svgRoot = d3.select(`#${prefix}-map`).html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", `Texas ${kind} districts`);
  const svg = svgRoot.append("g").attr("class", "zoom-root");
  const features = topojson.feature(topo, topo.objects.districts).features;
  const projection = d3.geoMercator().fitSize([width, height], { type: "FeatureCollection", features });
  const path = d3.geoPath(projection);
  const marginScale = d3.scaleDiverging().domain([-60, 0, 60]).interpolator((t) => d3.interpolateRgbBasis([cssVar("--r4"), cssVar("--r2"), "#f2f2f0", cssVar("--d2"), cssVar("--d4")])(t));
  const pScale = probabilityScale();
  const fillFor = (district, mode) => {
    if (!district) return cssVar("--notup");
    if (mode === "results") {
      const result = resultOf(district);
      if (!result) return cssVar("--notup");
      if (result.uncontested) return cssVar(result.leader === "D" ? "--d4" : result.leader === "R" ? "--r4" : "--toss");
      return result.margin == null ? cssVar("--toss") : marginScale(Math.max(-60, Math.min(60, result.margin * 2)));
    }
    if (mode === "model") return district.modelD == null ? cssVar("--notup") : pScale(district.modelD);
    if (mode === "margin") return district.presidentialMargin2024 == null ? cssVar("--notup") : marginScale(district.presidentialMargin2024);
    if (district.rating) return ratingColor(district.rating);
    return district.party === "D" ? cssVar("--d-held") : district.party === "R" ? cssVar("--r-held") : cssVar("--notup");
  };
  const paths = svg.append("g").selectAll("path").data(features).join("path").attr("d", path)
    .attr("class", (f) => (districts.get(f.properties.district)?.rating ? "rated" : ""))
    .on("mousemove", (event, f) => showTooltip(event, districtTooltip(kind, f.properties.district, districts.get(f.properties.district))))
    .on("mouseleave", hideTooltip);
  // Flipped districts are hatched in the results view.
  svgRoot.append("defs").append("pattern").attr("id", `${prefix}-flip-hatch`).attr("patternUnits", "userSpaceOnUse").attr("width", 7).attr("height", 7).attr("patternTransform", "rotate(45)")
    .append("rect").attr("width", 2.6).attr("height", 7).attr("fill", "#fff").attr("fill-opacity", 0.55);
  const flipMarks = svg.append("g").attr("class", "flip-marks").selectAll("path").data(features.filter((f) => { const d = districts.get(f.properties.district); return d && flipped(d); })).join("path")
    .attr("d", path).attr("fill", `url(#${prefix}-flip-hatch)`);
  const labelled = features.filter((f) => { const d = districts.get(f.properties.district); return d && (d.rating || flipped(d) || (d.modelD != null && Math.abs(d.modelD - 0.5) < 0.3)) && path.area(f) > 420; });
  svg.append("g").selectAll("text").data(labelled).join("text").attr("class", "state-label").attr("text-anchor", "middle").attr("transform", (f) => `translate(${path.centroid(f)})`).attr("dy", "0.35em").text((f) => f.properties.district);
  const unopposedParties = ["D", "R"].filter((p) => chamber.districts.some((d) => resultOf(d)?.uncontested && resultOf(d).leader === p));
  const apply = (mode) => {
    paths.attr("fill", (f) => fillFor(districts.get(f.properties.district), mode));
    flipMarks.attr("display", mode === "results" ? null : "none");
    if (mode === "results") {
      document.getElementById(`${prefix}-legend`).innerHTML = [-30, -15, -5, 0, 5, 15, 30].map((m) => `<span><i class="sw" style="background:${marginScale(m * 2)}"></i>${m === 0 ? "Even" : `${m > 0 ? "D" : "R"} +${Math.abs(m)}`}</span>`).join("")
        + (unopposedParties.length ? `<span>${unopposedParties.map((p) => `<i class="sw" style="background:${cssVar(p === "D" ? "--d4" : "--r4")}"></i>`).join("")}Unopposed</span>` : "")
        + (chamber.districts.some(flipped) ? '<span><i class="sw flip-sw"></i>Flipped</span>' : "") + (kind === "senate" ? `<span><i class="sw" style="background:${cssVar("--notup")}"></i>Not up in 2026</span>` : "");
      return;
    }
    if (mode === "model") {
      document.getElementById(`${prefix}-legend`).innerHTML = [0.02, 0.15, 0.3, 0.5, 0.7, 0.85, 0.98].map((p) => `<span><i class="sw" style="background:${pScale(p)}"></i>${p === 0.5 ? "50/50" : `${Math.round(p * 100)}% D`}</span>`).join("") + `<span><i class="sw" style="background:${cssVar("--notup")}"></i>Not up / no data</span>`;
      return;
    }
    document.getElementById(`${prefix}-legend`).innerHTML = mode === "margin"
      ? [-60, -30, -10, 0, 10, 30, 60].map((m) => `<span><i class="sw" style="background:${marginScale(m)}"></i>${m === 0 ? "Even" : `${m > 0 ? "Harris" : "Trump"} +${Math.abs(m)}`}</span>`).join("") + `<span><i class="sw" style="background:${cssVar("--notup")}"></i>Not up / no data</span>`
      : RATING_ORDER.filter((r) => counts[r]).map((r) => `<span><i class="sw" style="background:${ratingColor(r)}"></i>${r}</span>`).join("") + `<span><i class="sw" style="background:${cssVar("--d-held")}"></i>D-held, unrated</span><span><i class="sw" style="background:${cssVar("--r-held")}"></i>R-held, unrated</span>` + (kind === "senate" ? `<span><i class="sw" style="background:${cssVar("--notup")}"></i>Not up in 2026</span>` : "");
  };
  const firstMode = results ? "results" : "model";
  apply(firstMode);
  document.querySelectorAll(`button.mode[data-chamber="${kind}"]`).forEach((b) => b.classList.toggle("active", b.dataset.mode === firstMode));
  document.querySelector(`button.mode[data-chamber="${kind}"][data-mode="results"]`)?.toggleAttribute("hidden", !results);
  attachZoom(svgRoot, `${prefix}-map`, { width, height });
  renderChamberChart(kind, chamber, resultSeatsD);
  document.querySelectorAll(`button.mode[data-chamber="${kind}"]`).forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(`button.mode[data-chamber="${kind}"]`).forEach((b) => b.classList.toggle("active", b === button));
    apply(button.dataset.mode);
  }));

  const closeness = (d) => (resultOf(d) ? (resultOf(d).uncontested ? 999 : resultOf(d).lead ?? 999) : Math.abs((d.modelD ?? 0.5) - 0.5) * 100);
  const byCompetitiveness = [...chamber.districts].sort((a, b) => closeness(a) - closeness(b) || a.district - b.district);
  const closest = kind === "house" ? byCompetitiveness.slice(0, 24) : byCompetitiveness;
  const resultCell = (d) => {
    const result = resultOf(d);
    if (!result) return '<td class="muted">—</td><td class="num muted">—</td>';
    const party = result.leader;
    const verb = result.uncontested ? "unopposed" : result.lead != null && result.lead < 1 ? "leads" : "won";
    return `<td class="wrap"><b class="${party === "D" ? "lean-d" : party === "R" ? "lean-r" : "lean-i"}">${esc(result.leaderName || "—")} (${party})</b> <span class="muted">${verb}</span>${flipped(d) ? '<span class="flip-tag">flip</span>' : ""}</td><td class="num">${result.uncontested ? "—" : marginText(result.margin)}</td>`;
  };
  const headRow = `<tr><th>District</th>${results ? '<th>Result<span class="sub">unofficial</span></th><th class="num">Margin</th>' : ""}<th>Incumbent</th><th>Held by</th><th class="num">2024 Pres.</th><th class="num">Model margin</th><th class="num">D wins<span class="sub">our model</span></th><th>Rating${chamber.ratingSource?.asOf ? `<span class="sub">${esc(chamber.ratingSource.name)}, ${esc(chamber.ratingSource.asOf)}</span>` : ""}</th></tr>`;
  const rowFor = (d) => `<tr><td><b>${kind === "house" ? "HD" : "SD"}-${d.district}</b></td>${results ? resultCell(d) : ""}<td class="wrap">${esc(d.incumbent || "Open")}${d.retiring ? ' <span class="muted">retiring</span>' : ""}${d.defeatedInPrimary ? ' <span class="muted">lost primary</span>' : ""}</td><td>${esc(d.party || "—")}</td><td class="num">${d.presidentialMargin2024 == null ? "—" : marginText(d.presidentialMargin2024).replace("D+", "Harris +").replace("R+", "Trump +")}</td><td class="num" title="${esc(baselineText(d))}">${d.modelBaseline ? marginText(d.modelBaseline.margin) : "—"}</td><td class="num"><b>${pct(d.modelD)}</b></td><td>${ratingPill(d.rating)}${d.flip ? ' <span class="thin">flip</span>' : ""}</td></tr>`;
  document.getElementById(`${prefix}-table`).innerHTML = headRow + closest.map(rowFor).join("");
  const allTable = document.getElementById(`${prefix}-table-all`);
  if (allTable) allTable.innerHTML = headRow + [...chamber.districts].sort((a, b) => a.district - b.district).map(rowFor).join("");
  if (kind === "house") renderGenericBallot(s.txLegislature);
}
function baselineText(d) {
  const b = d.modelBaseline;
  if (!b) return "";
  return `2024 presidential ${marginText(b.presidential)}, swing ${b.swing >= 0 ? "+" : ""}${b.swing}, incumbency ${b.incumbency >= 0 ? "+" : ""}${b.incumbency}${b.incumbentRunning ? "" : " (open seat)"}`;
}
function renderGenericBallot(legislature) {
  const table = document.getElementById("tx-generic-table");
  if (!table) return;
  const polls = legislature?.genericBallot?.polls || [];
  const average = legislature?.genericBallot?.average;
  if (!polls.length) { table.innerHTML = '<tr><td class="muted">No legislative generic-ballot polls found.</td></tr>'; return; }
  const weightFor = (poll) => (average?.weights || []).find((w) => w.id === poll.id || (poll.alsoIds || []).includes(w.id));
  table.innerHTML = `<tr><th>Pollster</th><th>Dates</th><th class="num">Sample</th><th class="num">D</th><th class="num">R</th><th class="num">Margin</th><th>538 grade</th><th class="num">Weight</th></tr>` +
    polls.slice(0, 8).map((poll) => { const w = weightFor(poll); return `<tr><td>${esc(poll.pollster)}${poll.partisan ? ` <span class="muted">(${esc(poll.partisan)})</span>` : ""}</td><td>${esc(poll.startDate ? `${fmtDate(poll.startDate)}–${fmtDate(poll.endDate)}` : fmtDate(poll.endDate))}</td><td class="num">${poll.sampleSize ? poll.sampleSize.toLocaleString() : "—"}${poll.population ? ` ${esc(poll.population)}` : ""}</td><td class="num">${poll.dem}%</td><td class="num">${poll.rep}%</td><td class="num"><b>${marginText(poll.dem - poll.rep)}</b></td><td>${w?.grade ? esc(w.grade) : '<span class="muted">unrated</span>'}</td><td class="num muted">${w ? w.weight.toFixed(2) : "—"}</td></tr>`; }).join("") +
    (average ? `<tr><td colspan="5"><b>Weighted average</b> (${average.pollCount} polls)</td><td class="num"><b>${marginText(average.margin)}</b></td><td colspan="2"></td></tr>` : "");
}
function renderChamberChart(kind, chamber, resultSeatsD = null) { renderSeatHistogram(`tx-${kind}-chart`, `tx-${kind}-chart-title`, chamber.model, `Texas ${kind}`, resultSeatsD); }
/** The model's seat distribution; `resultSeatsD`, when the election is in, is marked with a solid line. */
function renderSeatHistogram(containerId, titleId, model, chamberLabel, resultSeatsD = null) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!model) { container.innerHTML = '<p class="note">Model unavailable (no environment polls).</p>'; return; }
  let rows = model.histogram.filter((h) => h.probability >= 0.002);
  if (resultSeatsD != null && rows.length) {
    // Widen the chart to take in the result when it landed where the model gave it next to no chance.
    const byD = new Map(model.histogram.map((h) => [h.d, h.probability]));
    rows = d3.range(Math.min(d3.min(rows, (r) => r.d), resultSeatsD), Math.max(d3.max(rows, (r) => r.d), resultSeatsD) + 1).map((d) => ({ d, probability: byD.get(d) ?? 0 }));
  }
  const width = 760, height = 190, margin = { top: 14, right: 12, bottom: 32, left: 38 };
  const svg = d3.select(container).html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", `Probability of each Democratic seat count in the ${chamberLabel}`);
  const x = d3.scaleBand().domain(rows.map((r) => String(r.d))).range([margin.left, width - margin.right]).paddingInner(0.2);
  const yMax = Math.max(0.05, d3.max(rows, (r) => r.probability) * (resultSeatsD != null ? 1.4 : 1.15));
  const y = d3.scaleLinear().domain([0, yMax]).range([height - margin.bottom, margin.top]);
  svg.append("g").attr("class", "grid").selectAll("line").data(y.ticks(3)).join("line").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", (d) => y(d)).attr("y2", (d) => y(d));
  const tickEvery = Math.max(1, Math.ceil(rows.length / 14));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${height - margin.bottom})`).call(d3.axisBottom(x).tickSize(0).tickValues(x.domain().filter((_, i) => i % tickEvery === 0))).select(".domain").remove();
  svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(3).tickFormat((d) => `${Math.round(d * 100)}%`).tickSize(0)).select(".domain").remove();
  svg.append("g").selectAll("rect").data(rows).join("rect").attr("class", "bar").attr("x", (r) => x(String(r.d))).attr("width", x.bandwidth()).attr("y", (r) => y(r.probability)).attr("height", (r) => y(0) - y(r.probability)).attr("rx", 2)
    .attr("fill", (r) => (r.d >= model.majority ? cssVar("--d3") : cssVar("--r2")))
    .on("mousemove", (event, r) => showTooltip(event, `<b>${r.d} Democratic seats</b><div class="row"><span>Probability</span><span>${pct(r.probability, 1)}</span></div>`)).on("mouseleave", hideTooltip);
  const majorityIndex = rows.findIndex((r) => r.d === model.majority);
  if (majorityIndex > 0) {
    const xLine = x(String(rows[majorityIndex].d)) - (x.step() - x.bandwidth()) / 2;
    const labelOnLeft = xLine > width * 0.6;
    svg.append("line").attr("x1", xLine).attr("x2", xLine).attr("y1", margin.top).attr("y2", height - margin.bottom).attr("stroke", "#111").attr("stroke-dasharray", "3 3");
    svg.append("text").attr("class", "label").attr("x", xLine + (labelOnLeft ? -4 : 4)).attr("y", margin.top + 10).attr("text-anchor", labelOnLeft ? "end" : "start").text(`${model.majority} seats: Democratic majority (${pct(model.control.D)})`);
  } else if (majorityIndex === -1 && rows.length && rows[rows.length - 1].d < model.majority) {
    svg.append("text").attr("class", "label").attr("x", width - margin.right).attr("y", margin.top + 10).attr("text-anchor", "end").text(`Majority line (${model.majority}) is off the chart; chance ${pct(model.control.D, 1)}`);
  }
  if (resultSeatsD != null && x(String(resultSeatsD)) != null) {
    const xResult = x(String(resultSeatsD)) + x.bandwidth() / 2;
    const above = resultSeatsD >= model.expected.D;
    const chance = d3.sum(model.histogram.filter((h) => (above ? h.d >= resultSeatsD : h.d <= resultSeatsD)), (h) => h.probability);
    svg.append("line").attr("x1", xResult).attr("x2", xResult).attr("y1", margin.top + 16).attr("y2", height - margin.bottom).attr("stroke", cssVar("--ink")).attr("stroke-width", 2.5);
    const label = svg.append("text").attr("class", "label").attr("y", margin.top + 27).attr("font-weight", 700)
      .text(`Result: ${resultSeatsD} D seats, unofficial · our model's chance of ${resultSeatsD}${above ? "+" : " or fewer"}: ${chance < 0.01 ? "under 1%" : pct(chance)}`);
    // The label goes on whichever side of the line has room for it. A chart drawn in a hidden tab can't measure its
    // text, so the width is estimated there.
    const labelWidth = label.node().getComputedTextLength?.() || label.text().length * 5;
    const onLeft = labelWidth > width - margin.right - xResult - 6 && xResult - margin.left > width - margin.right - xResult;
    label.attr("x", xResult + (onLeft ? -6 : 6)).attr("text-anchor", onLeft ? "end" : "start");
  }
  const notUpCount = model.notUp.D + model.notUp.R;
  document.getElementById(titleId).textContent = `Seat distribution: Democratic seats after the election, our model (expected ${model.expected.D.toFixed(1)}${notUpCount ? `; ${notUpCount} seats ${chamberLabel === "U.S. House" ? "assumed to stay with the party holding them" : "not up"}` : ""})`;
}
function ratingScoreOf(label) { const i = RATING_ORDER.indexOf(label); return i === -1 ? 9 : i - 4; }
function districtTooltip(kind, number, d) {
  const head = `<b>${kind === "house" ? "House" : "Senate"} District ${number}</b>`;
  if (!d) return `${head}<br>${kind === "senate" ? "Not up for election in 2026" : "No data"}`;
  const result = LEGISLATURE_RESULTS?.[kind]?.[number];
  const resultRows = result
    ? `<hr><div class="row"><span><b>Result, unofficial</b></span><span><b>${result.uncontested ? "unopposed" : esc(marginText(result.margin))}</b>${d.party && result.leader !== d.party ? ` · flip ${esc(d.party)} → ${esc(result.leader)}` : ""}</span></div>`
      + result.candidates.map((c) => `<div class="row"><span>${esc(c.name)} (${esc(c.party)})${c.incumbent ? " · incumbent" : ""}</span><span>${c.votes.toLocaleString()}${result.total && !result.uncontested ? ` · ${((100 * c.votes) / result.total).toFixed(1)}%` : ""}</span></div>`).join("")
      + "<hr>"
    : "<hr>";
  return `${head}${resultRows}<div class="row"><span>Incumbent</span><span>${esc(d.incumbent || "Open")}${d.retiring ? " (retiring)" : ""}</span></div><div class="row"><span>Held by</span><span>${esc(d.party || "—")}</span></div><div class="row"><span>2024 presidential</span><span>${d.presidentialMargin2024 == null ? "—" : marginText(d.presidentialMargin2024).replace("D+", "Harris +").replace("R+", "Trump +")}</span></div>${d.modelD != null ? `<div class="row"><span><b>Our model, D wins</b></span><span><b>${pct(d.modelD)}</b></span></div><div class="row"><span>Model margin</span><span>${marginText(d.modelBaseline?.margin)}</span></div><div class="row"><span>${esc(baselineText(d))}</span></div>` : ""}<div class="row"><span>Rating</span><span>${esc(d.rating || "not rated competitive")}${d.flip ? " (flip)" : ""}</span></div>`;
}

// ---------- U.S. House ----------
function renderUsHouse(s, topo, prev) {
  const h = s.usHouse;
  if (!h) return;
  const ga = h.genericBallot?.average;
  const tiles = [
    { k: "Today", v: `${h.composition.R} R, ${h.composition.D} D`, s: `${h.seats - h.composition.R - h.composition.D} vacant; ${h.majority} seats make a majority` },
    { k: "Our model, Democratic control", v: pct(h.model.control.D) + delta(h.model.control.D, prev?.usHouse?.control), s: `expected ${h.model.expected.D.toFixed(1)} D, ${h.model.expected.R.toFixed(1)} R over ${h.model.ratedCount} rated seats`, primary: true },
    { k: "Generic congressional ballot", v: ga ? marginText(ga.margin) : "—", s: ga ? `${ga.pollCount} polls in the window, quality-weighted${h.genericBallot.aggregates?.length ? `; published averages ${h.genericBallot.aggregates.map((a) => `${a.source} ${marginText(a.margin)}`).join(", ")}` : ""}` : "no polls" },
  ];
  document.getElementById("us-house-tiles").innerHTML = tiles.map((t) => `<div class="figure${t.primary ? " primary" : ""}"><div class="k">${esc(t.k)}</div><div class="v">${t.v}</div><div class="s">${esc(t.s)}</div></div>`).join("");
  renderSeatHistogram("us-house-chart", "us-house-chart-title", h.model, "U.S. House");

  // Texas congressional map
  const texas = h.districts.filter((d) => d.state === "TX");
  const byDistrict = new Map(texas.map((d) => [d.district, d]));
  if (topo) {
    const width = 800, height = 760;
    const svgRoot = d3.select("#tx-congress-map").html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", "Texas congressional districts");
    const svg = svgRoot.append("g").attr("class", "zoom-root");
    const features = topojson.feature(topo, topo.objects.districts).features;
    const projection = d3.geoMercator().fitSize([width, height], { type: "FeatureCollection", features });
    const path = d3.geoPath(projection);
    const pScale = probabilityScale();
    const fillFor = (d, mode) => (!d ? cssVar("--notup") : mode === "rating" ? ratingColor(d.consensus?.label) : d.modelD == null ? cssVar("--notup") : pScale(d.modelD));
    const paths = svg.append("g").selectAll("path").data(features).join("path").attr("d", path).attr("class", (f) => (byDistrict.get(f.properties.district)?.nationallyRated ? "rated" : ""))
      .on("mousemove", (event, f) => { const d = byDistrict.get(f.properties.district); showTooltip(event, d ? congressTooltip(d, h) : `<b>TX-${f.properties.district}</b><br>No data`); }).on("mouseleave", hideTooltip);
    svg.append("g").selectAll("text").data(features.filter((f) => path.area(f) > 420)).join("text").attr("class", "state-label").attr("text-anchor", "middle").attr("transform", (f) => `translate(${path.centroid(f)})`).attr("dy", "0.35em").text((f) => f.properties.district);
    const apply = (mode) => {
      paths.attr("fill", (f) => fillFor(byDistrict.get(f.properties.district), mode));
      document.getElementById("tx-congress-legend").innerHTML = mode === "rating"
        ? RATING_ORDER.map((r) => `<span><i class="sw" style="background:${ratingColor(r)}"></i>${r}</span>`).join("")
        : [0.02, 0.15, 0.3, 0.5, 0.7, 0.85, 0.98].map((p) => `<span><i class="sw" style="background:${pScale(p)}"></i>${p === 0.5 ? "50/50" : `${Math.round(p * 100)}% D`}</span>`).join("");
    };
    apply("model");
    attachZoom(svgRoot, "tx-congress-map", { width, height });
    document.querySelectorAll("button.mode[data-congress-mode]").forEach((button) => button.addEventListener("click", () => {
      document.querySelectorAll("button.mode[data-congress-mode]").forEach((b) => b.classList.toggle("active", b === button));
      apply(button.dataset.congressMode);
    }));
  }
  const txRows = [...texas].sort((a, b) => a.district - b.district).map((d) => `<tr><td><b>TX-${d.district}</b></td><td>${esc(d.incumbent || (d.open ? "Open / new seat" : "—"))}</td><td>${esc(d.incumbentParty || "—")}</td><td>${ratingPill(d.consensus?.label)}${d.flip ? ' <span class="thin">flip</span>' : ""}</td><td class="ratings-cell">${Object.values(d.texasRatings || {}).map((r) => miniRating(r.label)).join("")}</td><td class="num">${d.pollingAverage ? `${marginText(d.pollingAverage.margin)}<span class="thin">n=${d.pollingAverage.pollCount}</span>` : '<span class="muted">—</span>'}</td><td class="num"><b>${pct(d.modelD)}</b></td></tr>`).join("");
  document.getElementById("tx-congress-table").innerHTML = `<tr><th>District</th><th>Incumbent</th><th>Held by</th><th>Consensus</th><th>Ratings<span class="sub">Texas race pages</span></th><th class="num">District polls</th><th class="num">D wins<span class="sub">our model</span></th></tr>${txRows}`;

  // Generic ballot table
  const polls = h.genericBallot?.polls || [];
  const weightFor = (poll) => (ga?.weights || []).find((w) => w.id === poll.id || (poll.alsoIds || []).includes(w.id));
  document.getElementById("us-generic-table").innerHTML = polls.length
    ? `<tr><th>Pollster</th><th>Dates</th><th class="num">Sample</th><th class="num">D</th><th class="num">R</th><th class="num">Margin</th><th>538 grade</th><th class="num">Weight</th></tr>` + polls.slice(0, 12).map((poll) => { const w = weightFor(poll); return `<tr><td>${esc(poll.pollster)}${poll.partisan ? ` <span class="muted">(${esc(poll.partisan)})</span>` : ""}</td><td>${esc(poll.startDate ? `${fmtDate(poll.startDate)}–${fmtDate(poll.endDate)}` : fmtDate(poll.endDate))}</td><td class="num">${poll.sampleSize ? poll.sampleSize.toLocaleString() : "—"}${poll.population ? ` ${esc(poll.population)}` : ""}</td><td class="num">${poll.dem}%</td><td class="num">${poll.rep}%</td><td class="num"><b>${marginText(poll.dem - poll.rep)}</b></td><td>${w?.grade ? esc(w.grade) : '<span class="muted">unrated</span>'}</td><td class="num muted">${w ? w.weight.toFixed(2) : "—"}</td></tr>`; }).join("") + (ga ? `<tr><td colspan="5"><b>Weighted average</b> (${ga.pollCount} polls)</td><td class="num"><b>${marginText(ga.margin)}</b></td><td colspan="2"></td></tr>` : "")
    : '<tr><td class="muted">No generic-ballot polls found.</td></tr>';

  // National battlegrounds
  const head = `<tr><th>District</th><th>Incumbent</th><th>Held by</th><th>Consensus</th><th title="${esc(h.forecasters.map((f) => f.name).join(", "))}">Ratings<span class="sub">${h.forecasters.map((f) => esc(shortName(f.name))).join(", ")}</span></th><th class="num">D wins<span class="sub">our model</span></th></tr>`;
  const row = (d) => `<tr><td><b>${esc(d.id)}</b>${d.state === "TX" ? '<span class="tx-mark">TX</span>' : ""}${d.pvi ? ` <span class="muted">${esc(d.pvi)}</span>` : ""}</td><td class="wrap">${esc(d.incumbent || (d.open ? "Open / new seat" : "—"))}</td><td>${esc(d.incumbentParty || "—")}</td><td>${ratingPill(d.consensus?.label)}${d.flip ? ' <span class="thin">flip</span>' : ""}</td><td class="ratings-cell">${h.forecasters.map((f) => miniRating(d.ratings[f.key])).join("")}</td><td class="num"><b>${pct(d.modelD)}</b></td></tr>`;
  const rated = h.districts.filter((d) => d.nationallyRated);
  document.getElementById("us-house-table").innerHTML = head + rated.slice(0, 40).map(row).join("");
  document.getElementById("us-house-table-all").innerHTML = head + [...rated].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).map(row).join("");
}
function congressTooltip(d, h) {
  const rows = [`<b>${esc(d.id)}</b>${d.incumbent ? ` · ${esc(d.incumbent)}` : d.open ? " · open or new seat" : ""}${d.incumbentParty ? ` (${esc(d.incumbentParty)}-held)` : ""}${d.pvi ? ` · PVI ${esc(d.pvi)}` : ""}`, "<hr>"];
  rows.push(`<div class="row"><span><b>Our model, D wins</b></span><span><b>${pct(d.modelD)}</b></span></div>`);
  rows.push(`<div class="row"><span>Consensus rating</span><span>${esc(d.consensus?.label || "—")}</span></div>`);
  if (d.pollingAverage) rows.push(`<div class="row"><span>District polls (${d.pollingAverage.pollCount})</span><span>${marginText(d.pollingAverage.margin)}</span></div>`);
  for (const [key, label] of Object.entries(d.ratings || {})) rows.push(`<div class="row"><span>${esc((h.forecasters.find((f) => f.key === key) || d.texasRatings?.[key] || { name: key }).name)}</span><span>${esc(label)}</span></div>`);
  return rows.join("");
}

// ---------- Texas courts and SBOE ----------
function renderCourts(s) {
  const c = s.txCourts;
  if (!c) return;
  const judicial = c.races.filter((r) => r.body !== "State Board of Education");
  const sboe = c.races.filter((r) => r.body === "State Board of Education");
  const baseline = judicial.find((r) => r.pollModel)?.pollModel?.pD;
  document.getElementById("courts-figures").innerHTML = [
    { k: "Statewide judicial baseline, Democrat wins", v: pct(baseline), s: `from a statewide environment of ${marginText(c.environment)} with a 6-point error scale` },
    { k: "Seats on the ballot", v: String(judicial.length), s: `${judicial.filter((r) => r.body === "Texas Supreme Court").length} Supreme Court, ${judicial.filter((r) => r.body === "Court of Criminal Appeals").length} Court of Criminal Appeals` },
    { k: "SBOE districts up", v: String(sboe.length), s: "nominees only; no district model" },
  ].map((t) => `<div class="figure"><div class="k">${esc(t.k)}</div><div class="v">${t.v}</div><div class="s">${esc(t.s)}</div></div>`).join("");
  const nomineeCell = (r) => r.nominees.length ? r.nominees.map((n) => `${esc(n.name)} <span class="muted">(${esc(n.party || "?")})</span>`).join(" vs ") : '<span class="muted">nominees not listed</span>';
  document.getElementById("courts-table").innerHTML = `<tr><th>Court</th><th>Seat</th><th>Matchup</th><th>Incumbent</th><th class="num">D wins<span class="sub">statewide baseline</span></th></tr>` +
    judicial.map((r) => `<tr><td>${esc(r.body)}</td><td><b>${esc(r.race)}</b></td><td class="wrap">${nomineeCell(r)}</td><td class="wrap">${esc(r.incumbent || "Open")}${r.incumbentParty ? ` <span class="muted">(${esc(r.incumbentParty)})</span>` : ""}</td><td class="num"><b>${pct(r.pollModel?.pD)}</b></td></tr>`).join("");
  document.getElementById("sboe-table").innerHTML = `<tr><th>District</th><th>Matchup</th><th>Incumbent</th></tr>` + sboe.map((r) => `<tr><td><b>${esc(r.race)}</b></td><td class="wrap">${nomineeCell(r)}</td><td class="wrap">${esc(r.incumbent || "Open")}${r.incumbentParty ? ` <span class="muted">(${esc(r.incumbentParty)})</span>` : ""}</td></tr>`).join("");
}

// ---------- early vote (hand-entered data file) ----------
// Early vote by county, from snapshot.earlyVote (built by ingest/early-vote.js from the SOS turnout report),
// compared with the 2024 president, 2022 governor, and 2018 U.S. Senate results and the 2018 daily totals.
let EARLY_VOTE_MAP_MODE = "pace";
let EARLY_VOTE_YEAR = "2018"; // the only year with day-by-day county counts, so every column has data
let EARLY_VOTE_SHOW_ALL = false;
let EARLY_VOTE_TOPO = null;
const EARLY_VOTE_LINE_COLORS = { 2024: "#22252a", 2022: "#8a8f98", 2018: "#b58a00" };

/** A past margin in that race's candidate names: "Trump +13.7", "O'Rourke +2.1". */
function pastMarginText(margin, election) {
  if (margin == null) return "—";
  if (Math.abs(margin) < 0.05) return "Even";
  return `${margin > 0 ? election.democrat : election.republican} +${Math.abs(margin).toFixed(1)}`;
}

/** A percent change as a green/red chip with its sign: +29.6% / −66.7%. `fraction` is 0.296 for up 29.6%. */
function changeChip(fraction, { digits = 0 } = {}) {
  if (fraction == null) return '<span class="muted">—</span>';
  const percent = fraction * 100;
  const rounded = Number(percent.toFixed(digits));
  const direction = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  const text = `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded).toFixed(digits)}%`;
  return `<span class="chg ${direction}" title="${direction === "flat" ? "about even" : direction} against 2018">${text}</span>`;
}
/** "up 30%" / "down 67%" in words, colored the same way, for sentences. */
function changeWords(fraction) {
  if (fraction == null) return "unknown";
  const rounded = Math.round(fraction * 100);
  if (rounded === 0) return '<span class="chg flat">about even</span>';
  return `<span class="chg ${rounded > 0 ? "up" : "down"}">${rounded > 0 ? "up" : "down"} ${Math.abs(rounded)}%</span>`;
}
/** Change per registered voter: turnout change net of growth in registered voters. */
function perVoterChange(turnoutChange, registeredChange) {
  return turnoutChange == null || registeredChange == null ? null : (1 + turnoutChange) / (1 + registeredChange) - 1;
}
const listNames = (names) => names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;

/** Wrap margin text in the party color it favors (blue toward D, red toward R), the site's usual convention. */
function partyColored(text, margin) {
  if (margin == null || Math.abs(margin) < 0.05) return text;
  return `<span class="${margin > 0 ? "lean-d" : "lean-r"}">${text}</span>`;
}

async function renderEarlyVote(s) {
  const earlyVote = s.earlyVote;
  const figures = document.getElementById("early-vote-figures");
  if (!earlyVote) {
    figures.innerHTML = `<div class="figure"><div class="k">Status</div><div class="v text">No report yet</div><div class="s">The Secretary of State's first early-voting report will appear here after the next morning refresh.</div></div>`;
    return;
  }
  const { totals, geography, elections } = earlyVote;
  const count = (n) => (n ?? 0).toLocaleString();
  const share = (p, digits = 1) => (p == null ? "—" : `${(p * 100).toFixed(digits)}%`);
  const comparedDays = (earlyVote.versus2018?.days || []).filter((d) => d.date2026);
  const latest = comparedDays[comparedDays.length - 1] || null;

  // Headline strip: the three numbers worth remembering.
  figures.innerHTML = [
    { k: `Ballots through ${fmtDate(earlyVote.reportDate)}`, v: count(totals.ballots), s: `${count(totals.inPerson)} in person, ${count(totals.mail)} by mail, statewide` },
    latest
      ? { k: `In person against 2018, through day ${latest.dayNumber}`, vHtml: changeChip(latest.inPersonRunning.change), s: `in the ${latest.countiesReported} of 30 big counties that have posted` }
      : { k: "In person against 2018", v: "After day 1", vClass: " text", s: "Day 1 is compared once it is fully posted, usually the next morning." },
    { k: "Share of the 2022 midterm vote", v: share(totals.shareOfPastTotal["2022"]), s: `already cast, of ${count(elections["2022"].total)} votes for governor in 2022` },
  ].map((t) => `<div class="figure"><div class="k">${esc(t.k)}</div><div class="v${t.vClass || ""}">${t.vHtml ?? esc(t.v)}</div><div class="s">${esc(t.s)}</div></div>`).join("");

  // The story so far, in sentences.
  const story = [];
  if (latest) {
    const dayName = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    story.push(`In-person voting on day ${latest.dayNumber} (${dayName(latest.date2026)}) was ${changeWords(latest.inPersonDay.change)} from day ${latest.dayNumber} of 2018, in the ${latest.countiesReported} of 30 big counties that have posted it.`);
    if (latest.dayNumber > 1) story.push(`Over the first ${latest.dayNumber} days, in-person votes are ${changeWords(latest.inPersonRunning.change)} from the same point in 2018.`);
    const perVoter = perVoterChange(latest.inPersonRunning.change, latest.registered.change);
    story.push(`Those counties have ${Math.round(latest.registered.change * 100)}% more registered voters than in 2018, so per registered voter, in-person turnout is ${changeWords(perVoter)}.`);
    if (latest.mailRunning.change != null) story.push(`Mail ballots are ${changeWords(latest.mailRunning.change)} from the same point in 2018, in the ${latest.mailCountiesReported} big counties that have posted mail ballots. Texas tightened mail-ballot ID rules in 2021.`);
    for (const [year, label] of [["2022", "the 2022 midterm"], ["2024", "the 2024 presidential election"]]) {
      const comparison = (earlyVote.versusYears?.[year]?.days || []).filter((d) => d.date2026).pop();
      if (!comparison || comparison.countiesReported === 0) continue;
      const counties = (earlyVote.versusYears[year].counties || []);
      story.push(`Against ${label}, in-person votes through day ${comparison.dayNumber} are ${changeWords(comparison.inPersonRunning.change)}, in the ${comparison.countiesReported} big ${comparison.countiesReported === 1 ? "county" : "counties"} whose ${year} daily reports still exist (${esc(listNames(counties))}).`);
    }
    const countyNames = Object.keys(earlyVote.countySources || {}).filter((name) => earlyVote.countySources[name].inPersonDates.length).sort();
    if (countyNames.length) story.push(`The state's feed runs behind for some big counties, so counts for ${esc(listNames(countyNames))} come from their own election offices.`);
    if (latest.notReported.length) story.push(`Not posted yet for day ${latest.dayNumber}: ${esc(listNames(latest.notReported))}. They haven't sent the state their in-person numbers yet, so they're left out of the comparison until they do.`);
  } else {
    story.push("In-person early voting began October 19. The first comparison with 2018 appears once day 1 is fully posted.");
  }
  document.getElementById("early-vote-story").innerHTML = story.map((line) => `<li>${line}</li>`).join("");

  renderEarlyVoteRead(earlyVote);
  renderEarlyVoteDaysChart(earlyVote.versus2018?.days || []);
  renderEarlyVoteDaysTable(earlyVote.versus2018?.days || []);
  renderEarlyVoteBigCounties(earlyVote.versus2018?.latestCounties || [], latest);

  // Bluer or redder places, in plain words.
  const yearsNewestFirst = Object.keys(elections).sort().reverse();
  const g2024 = geography.byElection["2024"];
  document.getElementById("early-vote-geography-status").innerHTML = geography.readable
    ? `Ballots so far come from counties that voted ${partyColored(pastMarginText(g2024.lean, elections["2024"]), g2024.lean)} in 2024, against ${partyColored(pastMarginText(g2024.reportingBaseline, elections["2024"]), g2024.reportingBaseline)} for those counties' full 2024 vote. By geography alone, the early vote is ${Math.abs(g2024.shift) < 0.5 ? "about the same as 2024" : partyColored(`${Math.abs(g2024.shift).toFixed(1)} points ${g2024.shift > 0 ? "bluer" : "redder"}`, g2024.shift) + " than 2024"}. This is about places, not individual voters.`
    : `Too early to say. Counties holding ${share(geography.registeredCoverage, 0)} of registered voters have posted in-person votes, and this check waits for ${share(geography.readableRule.minRegisteredCoverage, 0)}${geography.bigCountiesNotPosted?.length ? `. Still missing: ${esc(listNames(geography.bigCountiesNotPosted))}` : ""}.`;
  document.getElementById("early-vote-geography").innerHTML = `<tr><th>Race</th><th>Statewide result</th><th>Ballots so far come from counties that voted</th><th>Those counties' full vote that year</th><th class="num">Tilt of 2026 ballots</th></tr>`
    + yearsNewestFirst.map((year) => {
      const election = elections[year], g = geography.byElection[year];
      // Colored only once readable; while it's too early the row stays gray so it doesn't look like a finding.
      const tint = (text, margin) => (geography.readable ? partyColored(text, margin) : text);
      return `<tr${geography.readable ? "" : ' class="muted"'}><td><b>${esc(election.label)}</b> <span class="thin">${esc(election.republican)} against ${esc(election.democrat)}</span></td><td>${tint(pastMarginText(election.margin, election), election.margin)}</td><td>${tint(pastMarginText(g.lean, election), g.lean)}</td><td>${tint(pastMarginText(g.reportingBaseline, election), g.reportingBaseline)}</td><td class="num"><b>${tint(marginText(g.shift), g.shift)}</b></td></tr>`;
    }).join("");
  const grid = document.getElementById("early-vote-charts");
  grid.innerHTML = "";
  if (geography.readable) {
    const box = document.createElement("div"); box.className = "trend";
    const chart = { title: "Tilt of ballots against each past race", lines: yearsNewestFirst.map((year) => ({ name: elections[year].label, color: EARLY_VOTE_LINE_COLORS[year], get: (d) => (d.readable ? d.geography?.[year]?.shift : null) })), format: (v) => marginText(v), domain: null };
    box.innerHTML = `<h4>${esc(chart.title)}</h4><div class="legend">${chart.lines.map((l) => `<span><i class="sw" style="background:${l.color}"></i>${esc(l.name)}</span>`).join("")}</div>`;
    grid.appendChild(box);
    drawTrend(box, earlyVote.daily, chart);
  }

  renderEarlyVotePrimaries(earlyVote).catch((error) => console.error("primaries", error));

  // All-county map and table, inside the collapsed section.
  document.querySelectorAll("button.mode[data-ev-year]").forEach((b) => { b.onclick = () => { EARLY_VOTE_YEAR = b.dataset.evYear; renderEarlyVoteCounties(earlyVote); }; });
  document.getElementById("early-vote-show-all").onclick = () => { EARLY_VOTE_SHOW_ALL = !EARLY_VOTE_SHOW_ALL; renderEarlyVoteTable(earlyVote); };
  EARLY_VOTE_TOPO = await fetchJson("geo/tx-counties.json");
  renderEarlyVoteCounties(earlyVote);
}

/** The March 2026 primaries by county (scripts/build-primaries-2026.mjs), shared by the early-vote and election-night tabs. */
let PRIMARIES_2026 = null;
function loadPrimaries() { return (PRIMARIES_2026 ||= fetchJson("data/tx-primaries-2026.json").catch(() => null)); }

/** Early ballots against the March primaries: the tilt toward counties with more Democratic primary voters, by county type. */
async function renderEarlyVotePrimaries(earlyVote) {
  const [primaries, { primaryLean }] = await Promise.all([loadPrimaries(), import("./model/early-vote.js")]);
  const status = document.getElementById("early-vote-primaries-status"), table = document.getElementById("early-vote-primaries");
  if (!primaries) { status.textContent = "The March primaries baseline could not be loaded."; return; }
  const read = primaryLean(earlyVote.counties, primaries);
  const { statewide } = read;
  const tilt = Math.abs(statewide.tilt) < 0.5 ? "about evenly between them" : partyColored(`${Math.abs(statewide.tilt).toFixed(1)} points toward counties with more ${statewide.tilt > 0 ? "Democratic" : "Republican"} primary voters`, statewide.tilt);
  status.innerHTML = `In the March 3 primaries, ${pct(statewide.primaryDemShare, 1)} of primary voters took a Democratic ballot (${compact(statewide.primaryDem)} to ${compact(statewide.primaryRep)}). Weighted by where early ballots have been cast, those counties' primary voters were ${pct(statewide.earlyWeightedDemShare, 1)} Democratic, so the early vote leans ${tilt}.`;
  table.innerHTML = `<tr><th>County type</th><th class="num">Democratic share<span class="sub">of primary ballots</span></th><th class="num">Democratic<span class="sub">primary</span></th><th class="num">Republican<span class="sub">primary</span></th><th class="num">Early ballots</th><th class="num">Early ballots<span class="sub">per primary voter</span></th></tr>`
    + [...read.groups, { group: "Texas", ...statewide }].map((g) => `<tr${g.group === "Texas" ? ' class="total"' : ""}><td><b>${esc(g.group)}</b> <span class="thin">${g.counties} ${g.counties === 1 ? "county" : "counties"}</span></td>
      <td class="num">${partyColored(pct(g.primaryDemShare, 1), g.primaryDemShare - 0.5)}</td><td class="num">${compact(g.primaryDem)}</td><td class="num">${compact(g.primaryRep)}</td>
      <td class="num">${compact(g.ballots)}</td><td class="num"><b>${g.ballotsPerPrimaryVoter?.toFixed(2) ?? "—"}</b></td></tr>`).join("");
}

/**
 * "The read so far": a short, rules-based verdict from the tracker's own numbers, plus turnout by county type.
 * Waits for at least two compared days and 20 posted big counties so day-1 noise can't drive the headline.
 */
function renderEarlyVoteRead(earlyVote) {
  const box = document.getElementById("early-vote-read");
  const groupsTable = document.getElementById("early-vote-groups");
  const latestOf = (days) => (days || []).filter((d) => d.date2026).pop() || null;
  const v18 = latestOf(earlyVote.versus2018?.days), v22 = latestOf(earlyVote.versusYears?.["2022"]?.days), v24 = latestOf(earlyVote.versusYears?.["2024"]?.days);
  if (!v18 || v18.dayNumber < 2 || v18.countiesReported < 20) {
    box.innerHTML = `<p class="verdict">Too early for a read. It starts once two early-voting days are fully posted in most big counties.</p>`;
    groupsTable.innerHTML = "";
    return;
  }
  // Direction words for a turnout change: ahead of / behind / about even with.
  const versus = (change) => (change > 0.05 ? "ahead of" : change < -0.05 ? "behind" : "about even with");
  const geo2018 = v18.geographyVs2018EarlyVote?.["2018"]?.shift ?? null;
  const geo2024 = earlyVote.geography?.readable ? earlyVote.geography.byElection?.["2024"]?.shift : null;
  const points = (value) => `${Math.abs(value).toFixed(1)} point${Math.abs(value) >= 0.95 && Math.abs(value) < 1.05 ? "" : "s"}`;
  const tilt = (value) => partyColored(value > 0 ? "bluer" : "redder", value);

  // The one-sentence verdict: turnout against 2018, then where ballots come from against 2018's early vote.
  const turnoutPart = v18.inPersonRunning.change > 0.05 ? "higher turnout than 2018" : v18.inPersonRunning.change < -0.05 ? "lower turnout than 2018" : "turnout about like 2018";
  const placePart = geo2018 == null ? "" : Math.abs(geo2018) <= 2
    ? `, with ballots coming from much the same places as 2018's early vote`
    : `, with ballots coming from ${tilt(geo2018)} places than 2018's early vote`;
  const verdict = Math.abs(geo2018 ?? 0) <= 2 && v18.inPersonRunning.change > 0.05
    ? `So far this looks like a 2018-style electorate with higher turnout.`
    : `So far: ${turnoutPart}${placePart}.`;

  const lines = [];
  lines.push(`Through day ${v18.dayNumber}, in-person turnout is ${versus(v18.inPersonRunning.change)} 2018 (${changeChip(v18.inPersonRunning.change)}, ${v18.countiesReported} big counties)${v22 ? `, ${versus(v22.inPersonRunning.change)} 2022 (${changeChip(v22.inPersonRunning.change)}, ${v22.countiesReported} counties)` : ""}${v24 ? `, and ${versus(v24.inPersonRunning.change)} the 2024 presidential pace (${changeChip(v24.inPersonRunning.change)}, ${v24.countiesReported} counties)` : ""}.`);
  if (geo2018 != null) lines.push(`Matched day for day with 2018's early vote, ballots are coming from places ${Math.abs(geo2018) < 0.5 ? "almost exactly like 2018's" : `${points(geo2018)} ${tilt(geo2018)} than 2018's`}${geo2024 != null ? `, and ${points(geo2024)} ${tilt(geo2024)} than the 2024 electorate` : ""}.`);
  const groups = earlyVote.groups || [];
  // How each area reads inside a sentence ("biggest in the suburbs").
  const inSentence = { "Big cities": "big cities", "Rio Grande Valley and border": "Rio Grande Valley and border counties", "Suburbs": "suburbs", "Midsize cities": "midsize cities", "Rural and small-town": "rural and small-town counties" };
  const phrase = (group) => esc(inSentence[group] ?? group.toLowerCase());
  const ranked = groups.filter((g) => g.versus2018 && g.versus2018.counties >= 2).sort((a, b) => b.versus2018.change - a.versus2018.change);
  if (ranked.length >= 2) lines.push(`Gains over 2018 are biggest in the ${phrase(ranked[0].group)} (${changeChip(ranked[0].versus2018.change)}) and smallest in the ${phrase(ranked[ranked.length - 1].group)} (${changeChip(ranked[ranked.length - 1].versus2018.change)}).`);
  const byShare = groups.filter((g) => g.shareOf2022Vote != null).sort((a, b) => b.shareOf2022Vote - a.shareOf2022Vote);
  if (byShare.length >= 2) lines.push(`Against each area's 2022 vote, the ${phrase(byShare[0].group)} have cast the most so far (${(byShare[0].shareOf2022Vote * 100).toFixed(1)}%) and the ${phrase(byShare[byShare.length - 1].group)} the least (${(byShare[byShare.length - 1].shareOf2022Vote * 100).toFixed(1)}%).`);
  box.innerHTML = `<p class="verdict">${verdict}</p><ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`;

  const election2024 = earlyVote.elections["2024"];
  groupsTable.innerHTML = `<tr><th>Area</th><th class="num">Counties</th><th class="num">2024 result</th><th class="num">Ballots so far</th><th class="num">Share of 2022 vote</th><th class="num">In person against same day of 2018</th></tr>`
    + groups.map((g) => `<tr><td><b>${esc(g.group)}</b></td><td class="num">${g.counties}</td><td class="num">${partyColored(pastMarginText(g.margin2024, election2024), g.margin2024)}</td><td class="num">${g.ballots.toLocaleString()}</td><td class="num">${g.shareOf2022Vote == null ? "—" : `${(g.shareOf2022Vote * 100).toFixed(1)}%`}</td><td class="num">${g.versus2018 ? `${changeChip(g.versus2018.change)} <span class="thin">${g.versus2018.counties} ${g.versus2018.counties === 1 ? "county" : "counties"}</span>` : '<span class="muted">no 2018 daily data</span>'}</td></tr>`).join("");
}

/** Bars: each day's in-person change against the same day of 2018. Line: the running total's change. */
function renderEarlyVoteDaysChart(days) {
  const box = document.getElementById("early-vote-days-chart");
  box.innerHTML = "";
  const compared = days.filter((d) => d.date2026 && d.inPersonDay.change != null);
  if (!compared.length) return;
  // Draw at the container's own width (up to 760) so labels stay legible on phones.
  const width = Math.max(320, Math.min(760, box.clientWidth || 760)), height = width < 500 ? 200 : 230;
  const margin = { top: 22, right: 10, bottom: 34, left: 44 };
  const narrow = width < 500;
  const x = d3.scaleBand().domain(days.map((d) => d.dayNumber)).range([margin.left, width - margin.right]).padding(0.28);
  const extreme = Math.max(0.1, ...compared.flatMap((d) => [Math.abs(d.inPersonDay.change), Math.abs(d.inPersonRunning.change ?? 0)]));
  const y = d3.scaleLinear().domain([-extreme * 1.25, extreme * 1.25]).nice().range([height - margin.bottom, margin.top]);
  const svg = d3.select(box).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", "In-person turnout change against 2018, by early-voting day");
  const signed = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v * 100))}%`;
  svg.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", (v) => y(v)).attr("y2", (v) => y(v));
  svg.append("line").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", cssVar("--ink-3"));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(signed).tickSize(0)).select(".domain").remove();
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${height - margin.bottom})`).call(d3.axisBottom(x).tickFormat((n) => (narrow ? String(n) : `Day ${n}`)).tickSize(0)).select(".domain").remove();
  const colorFor = (v) => (v > 0.005 ? "#15803d" : v < -0.005 ? "#b91c1c" : cssVar("--ink-3"));
  svg.append("g").selectAll("rect").data(compared).join("rect")
    .attr("x", (d) => x(d.dayNumber)).attr("width", x.bandwidth())
    .attr("y", (d) => Math.min(y(0), y(d.inPersonDay.change))).attr("height", (d) => Math.abs(y(d.inPersonDay.change) - y(0)))
    .attr("fill", (d) => colorFor(d.inPersonDay.change)).attr("rx", 2)
    .on("mousemove", (event, d) => showTooltip(event, `<b>Day ${d.dayNumber}</b>, ${fmtDate(d.date2026)} (2018: ${fmtDate(d.date2018)})<div class="row"><span>In person that day</span><span>${d.inPersonDay.y2026.toLocaleString()} against ${d.inPersonDay.y2018.toLocaleString()}</span></div><div class="row"><span>Change</span><span>${signed(d.inPersonDay.change)}</span></div><div class="row"><span>Counties posted</span><span>${d.countiesReported} of 30</span></div>`))
    .on("mouseleave", hideTooltip);
  svg.append("g").selectAll("text").data(compared).join("text").attr("class", "bar-label").attr("text-anchor", "middle")
    .attr("x", (d) => x(d.dayNumber) + x.bandwidth() / 2).attr("y", (d) => (d.inPersonDay.change >= 0 ? y(d.inPersonDay.change) - 5 : y(d.inPersonDay.change) + 13))
    .attr("fill", (d) => colorFor(d.inPersonDay.change)).text((d) => signed(d.inPersonDay.change));
  if (compared.length >= 2) {
    const line = d3.line().x((d) => x(d.dayNumber) + x.bandwidth() / 2).y((d) => y(d.inPersonRunning.change));
    svg.append("path").datum(compared).attr("fill", "none").attr("stroke", cssVar("--ink")).attr("stroke-width", 2).attr("d", line);
    svg.append("g").selectAll("circle").data(compared).join("circle").attr("cx", (d) => x(d.dayNumber) + x.bandwidth() / 2).attr("cy", (d) => y(d.inPersonRunning.change)).attr("r", 3.5).attr("fill", cssVar("--ink")).attr("stroke", "#fff").attr("stroke-width", 1.5);
  }
  box.insertAdjacentHTML("beforeend", `<div class="legend"><span><i class="sw" style="background:#15803d"></i>Day up from 2018</span><span><i class="sw" style="background:#b91c1c"></i>Day down from 2018</span>${compared.length >= 2 ? `<span><i class="sw" style="background:${cssVar("--ink")}"></i>Running total</span>` : ""}</div>`);
}

function renderEarlyVoteDaysTable(days) {
  const count = (n) => (n == null ? "—" : n.toLocaleString());
  document.getElementById("early-vote-days").innerHTML = `<tr><th rowspan="2">Day</th><th rowspan="2">Date</th><th colspan="3" class="group">In person that day</th><th colspan="3" class="group">In person so far</th><th rowspan="2" class="num">Mail so far</th><th rowspan="2" class="num">Counties posted</th></tr>
    <tr><th class="num">2026</th><th class="num">2018</th><th class="num">Change</th><th class="num">2026</th><th class="num">2018</th><th class="num">Change</th></tr>`
    + days.map((d) => d.date2026
      ? `<tr><td><b>Day ${d.dayNumber}</b></td><td>${fmtDate(d.date2026)} <span class="thin">2018: ${fmtDate(d.date2018)}</span></td><td class="num">${count(d.inPersonDay.y2026)}</td><td class="num">${count(d.inPersonDay.y2018)}</td><td class="num">${changeChip(d.inPersonDay.change, { digits: 1 })}</td><td class="num">${count(d.inPersonRunning.y2026)}</td><td class="num">${count(d.inPersonRunning.y2018)}</td><td class="num">${changeChip(d.inPersonRunning.change, { digits: 1 })}</td><td class="num">${changeChip(d.mailRunning.change, { digits: 1 })}</td><td class="num">${d.countiesReported} of 30</td></tr>`
      : `<tr class="muted"><td>Day ${d.dayNumber}</td><td>2018: ${fmtDate(d.date2018)}</td><td class="num">—</td><td class="num">${count(d.inPersonDay2018)}</td><td></td><td class="num">—</td><td class="num">${count(d.inPersonRunning2018)}</td><td></td><td></td><td></td></tr>`).join("");
}

function renderEarlyVoteBigCounties(counties, latest) {
  const table = document.getElementById("early-vote-big-counties");
  if (!latest || !counties.length) { table.innerHTML = ""; return; }
  const count = (n) => (n == null ? "—" : n.toLocaleString());
  const sorted = [...counties].sort((a, b) => (b.reported - a.reported) || ((b.inPersonRunning.change ?? -9) - (a.inPersonRunning.change ?? -9)));
  table.innerHTML = `<tr><th>County</th><th>Source</th><th class="num">In person 2026</th><th class="num">Same day 2018</th><th class="num">Change</th><th class="num">Per registered voter</th><th class="num">Mail 2026</th><th class="num">Mail 2018</th><th class="num">Mail change</th></tr>`
    + sorted.map((c) => c.reported
      ? `<tr><td><b>${esc(c.name)}</b></td><td class="thin">${c.source === "county" ? "county office" : "state"}</td><td class="num">${count(c.inPersonRunning.y2026)}</td><td class="num">${count(c.inPersonRunning.y2018)}</td><td class="num">${changeChip(c.inPersonRunning.change)}</td><td class="num">${changeChip(perVoterChange(c.inPersonRunning.change, c.registered.change))}</td><td class="num">${count(c.mailRunning.y2026)}</td><td class="num">${count(c.mailRunning.y2018)}</td><td class="num">${c.mailReported ? changeChip(c.mailRunning.change) : '<span class="muted">not posted yet</span>'}</td></tr>`
      : `<tr class="muted"><td><b>${esc(c.name)}</b></td><td class="thin">${c.source === "county" ? "county office" : "state"}</td><td class="num">${count(c.inPersonRunning.y2026)}</td><td class="num">${count(c.inPersonRunning.y2018)}</td><td class="num" colspan="2">not posted yet</td><td class="num">${count(c.mailRunning.y2026)}</td><td class="num">${count(c.mailRunning.y2018)}</td><td class="num">${c.mailReported ? changeChip(c.mailRunning.change) : '<span class="muted">not posted yet</span>'}</td></tr>`).join("");
}

function renderEarlyVoteCounties(earlyVote) {
  document.querySelectorAll("button.mode[data-ev-year]").forEach((b) => b.classList.toggle("active", b.dataset.evYear === EARLY_VOTE_YEAR));
  renderEarlyVoteTable(earlyVote);
  if (EARLY_VOTE_TOPO) renderEarlyVoteMap(earlyVote, EARLY_VOTE_TOPO);
}

function renderEarlyVoteTable(earlyVote) {
  const year = EARLY_VOTE_YEAR, election = earlyVote.elections[year];
  const rows = EARLY_VOTE_SHOW_ALL ? earlyVote.counties : earlyVote.counties.slice(0, 25);
  const share = (p) => (p == null ? "—" : `${(p * 100).toFixed(1)}%`);
  // The last three columns all describe the picked year. Same-day counts come from the SOS's 2018 daily
  // reports (30 biggest counties) or, for 2022 and 2024, the counties whose own daily reports survive.
  const comparisonRows = year === "2018" ? earlyVote.versus2018?.latestCounties : earlyVote.versusYears?.[year]?.latestCounties;
  const hasSameDay = Boolean(comparisonRows?.length);
  const bigCountyComparison = new Map((comparisonRows || []).map((c) => [c.name, c]));
  const sameDayCell = (c) => {
    if (!hasSameDay) return '<span class="muted">—</span>';
    const comparison = bigCountyComparison.get(c.name);
    if (!comparison) return `<span class="muted">no ${esc(year)} daily report</span>`;
    // In person against in person: many counties post mail days later, so totals would show false drops.
    if (!comparison.reported) return `${comparison.inPersonRunning.y2018.toLocaleString()} <span class="muted">not posted yet</span>`;
    return `${comparison.inPersonRunning.y2018.toLocaleString()} ${changeChip(comparison.inPersonRunning.change)}`;
  };
  document.getElementById("early-vote-table").innerHTML = `<tr><th>County</th><th class="num">Ballots</th><th class="num">In person</th><th class="num">Mail</th><th class="num">Share of registered</th><th class="num">Share of ${esc(year)} vote</th><th class="num">${esc(year)} result</th><th class="num">In person, same day of ${esc(year)}</th></tr>`
    + rows.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td class="num"><b>${c.ballots.toLocaleString()}</b></td><td class="num">${c.inPerson.toLocaleString()}</td><td class="num">${c.mail.toLocaleString()}</td><td class="num">${share(c.shareOfRegistered)}</td><td class="num">${share(c.past?.[year]?.share)}</td><td class="num">${partyColored(pastMarginText(c.past?.[year]?.margin, election), c.past?.[year]?.margin)}</td><td class="num">${sameDayCell(c)}</td></tr>`).join("");
  const coveredCounties = earlyVote.versusYears?.[year]?.counties || [];
  document.getElementById("early-vote-table-note").textContent = year === "2018"
    ? "Same-day 2018 numbers cover the 30 biggest counties, the only ones in the Secretary of State's 2018 daily reports."
    : hasSameDay
      ? `Same-day ${year} numbers come from the counties whose own ${year} daily early-voting reports are still published: ${listNames(coveredCounties)}. The state's daily reports for ${year} are no longer online.`
      : `No same-day ${year} numbers yet; they appear once the first early-voting day is fully posted.`;
  document.getElementById("early-vote-show-all").textContent = EARLY_VOTE_SHOW_ALL ? "Show the 25 largest" : "Show all 254 counties";
}

function renderEarlyVoteMap(earlyVote, topo) {
  const year = EARLY_VOTE_YEAR, election = earlyVote.elections[year];
  const width = 800, height = 760;
  const byKey = new Map(earlyVote.counties.map((c) => [c.name.toUpperCase().replace(/[^A-Z]/g, ""), c]));
  const svgRoot = d3.select("#early-vote-map").html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", `Texas early-vote turnout by county, compared with the ${election.label}`);
  const svg = svgRoot.append("g").attr("class", "zoom-root");
  const features = topojson.feature(topo, topo.objects.counties).features;
  const path = d3.geoPath(d3.geoMercator().fitSize([width, height], { type: "FeatureCollection", features }));
  const countyFor = (feature) => byKey.get(String(feature.properties.name).toUpperCase().replace(/[^A-Z]/g, ""));

  // Turnout pace is not partisan, so it uses a neutral paper-to-ink ramp. The top of the scale is the
  // 95th-percentile county so one outlier doesn't wash out the rest.
  const paces = earlyVote.counties.map((c) => c.past?.[year]?.share).filter((v) => v > 0).sort(d3.ascending);
  const paceTop = Math.max(0.001, d3.quantile(paces, 0.95) || 0.01);
  const paceScale = d3.scaleSequential().domain([0, paceTop]).clamp(true).interpolator(d3.interpolateRgb("#f1f1ee", cssVar("--ink")));
  const marginScale = d3.scaleDiverging().domain([-60, 0, 60]).interpolator((t) => d3.interpolateRgbBasis([cssVar("--r4"), cssVar("--r2"), "#f2f2f0", cssVar("--d2"), cssVar("--d4")])(t));
  const fillFor = (county) => {
    const past = county?.past?.[year];
    if (!county || !past) return cssVar("--notup");
    if (EARLY_VOTE_MAP_MODE === "margin") return marginScale(past.margin);
    return county.ballots > 0 ? paceScale(past.share ?? 0) : cssVar("--notup");
  };
  const share = (p) => (p == null ? "—" : `${(p * 100).toFixed(1)}%`);
  const paths = svg.append("g").selectAll("path").data(features).join("path").attr("d", path)
    .on("mousemove", (event, feature) => {
      const county = countyFor(feature);
      showTooltip(event, county
        ? `<b>${esc(county.name)} County</b><div class="row"><span>Ballots</span><span>${county.ballots.toLocaleString()}</span></div><div class="row"><span>In person / mail</span><span>${county.inPerson.toLocaleString()} / ${county.mail.toLocaleString()}</span></div><div class="row"><span>Share of registered</span><span>${share(county.shareOfRegistered)}</span></div><div class="row"><span>Share of ${esc(year)} vote</span><span>${share(county.past?.[year]?.share)}</span></div><div class="row"><span>${esc(election.label)}</span><span>${pastMarginText(county.past?.[year]?.margin, election)}</span></div>${county.sameDay2018 != null ? `<div class="row"><span>Same day in 2018</span><span>${county.sameDay2018.toLocaleString()}</span></div>` : ""}`
        : `<b>${esc(feature.properties.name)} County</b><div class="row"><span>No report</span><span></span></div>`);
    })
    .on("mouseleave", hideTooltip);
  const apply = () => {
    paths.attr("fill", (feature) => fillFor(countyFor(feature)));
    document.getElementById("early-vote-legend").innerHTML = EARLY_VOTE_MAP_MODE === "margin"
      ? [-60, -30, -10, 0, 10, 30, 60].map((m) => `<span><i class="sw" style="background:${marginScale(m)}"></i>${pastMarginText(m, election)}</span>`).join("")
      : [0, 0.25, 0.5, 0.75, 1].map((f) => `<span><i class="sw" style="background:${paceScale(paceTop * f)}"></i>${f === 1 ? "at least " : ""}${share(paceTop * f)}</span>`).join("") + `<span><i class="sw" style="background:${cssVar("--notup")}"></i>No ballots reported</span>`;
    document.querySelectorAll("button.mode[data-ev-mode]").forEach((b) => b.classList.toggle("active", b.dataset.evMode === EARLY_VOTE_MAP_MODE));
  };
  document.querySelectorAll("button.mode[data-ev-mode]").forEach((b) => { b.onclick = () => { EARLY_VOTE_MAP_MODE = b.dataset.evMode; apply(); }; });
  apply();
  attachZoom(svgRoot, "early-vote-map", { width, height });
}

// ---------- election night: needles, the night's chart, counties to watch ----------
// The needle document (built by ingest/needle.js) comes from the election-night recorder via the needle-data
// branch. If the recorder falls behind, the browser reads the Secretary of State's feed itself, runs the same
// model on top of the recorder's history, and keeps that copy in localStorage so a reload keeps the night.
// ?demo loads data/needle-demo.json, a simulated night from scripts/simulate-needle.mjs (local preview only).
// Two recorders write the same document: AWS (aws/needle-template.yaml; a Lambda every two minutes, served from S3
// with a 20-second cache) and GitHub Actions (needle.yml; the raw CDN holds files five minutes). In priority order;
// a recorder counts as alive while its last check is younger than staleMs.
const NEEDLE_RECORDERS = [
  { name: "AWS", url: "https://election-tracker-needle-needlebucket-92bzmtfdaxc0.s3.us-east-1.amazonaws.com/needle.json", staleMs: 6 * 60_000 },
  { name: "GitHub", url: "https://raw.githubusercontent.com/derekensign/election-tracker/needle-data/needle.json", staleMs: 12 * 60_000 },
];
const NEEDLE_SOS_URL = "https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr/election/countyInfo/53815";
const NEEDLE_TIMING = {
  windowOpens: Date.parse("2026-11-04T00:00:00Z"), // 6 p.m. Central on Election Day
  windowCloses: Date.parse("2026-11-05T18:00:00Z"), // noon Central two days later
  pollsClose: Date.parse("2026-11-04T01:00:00Z"), // 7 p.m. Central
  lastPollsClose: Date.parse("2026-11-04T02:00:00Z"), // 7 p.m. Mountain, in El Paso and Hudspeth
  chartStart: Date.parse("2026-11-04T00:30:00Z"), // 6:30 p.m. Central
  chartMinimumEnd: Date.parse("2026-11-04T07:00:00Z"), // 1 a.m. Central
  recorderFreshAfter: Date.parse("2026-11-03T18:00:00Z"), // noon Central on Election Day; earlier files are test runs
  recorderPollMs: 60_000, recorderStaleMs: 12 * 60_000, sosPollMs: 3 * 60_000,
};
// The handoff's watch list: the Valley and border, the big metros, the suburbs, and the big red exurbs.
const NEEDLE_WATCH_COUNTIES = ["Hidalgo", "Cameron", "Webb", "Starr", "El Paso", "Bexar", "Harris", "Fort Bend", "Dallas", "Tarrant", "Collin", "Denton", "Travis", "Williamson", "Hays", "Montgomery", "Comal", "Nueces"];
const NEEDLE_RACE_LABELS = { "tx-senate": "Senate", "tx-governor": "Governor", "tx-ltgov": "Lt. governor", "tx-ag": "Attorney general", "tx-comptroller": "Comptroller", "tx-railroad": "Railroad", "tx-land": "Land", "tx-agriculture": "Agriculture" };
const NEEDLE_STORAGE_KEY = "needle-doc-53815";
// Gauge bands, Very likely D on the left through a neutral tossup middle to Very likely R on the right.
const NEEDLE_BANDS = [
  { from: 0.95, to: 1, color: "--d4" }, { from: 0.8, to: 0.95, color: "--d3" }, { from: 0.6, to: 0.8, color: "--d2" },
  { from: 0.4, to: 0.6, color: null }, { from: 0.2, to: 0.4, color: "--r2" }, { from: 0.05, to: 0.2, color: "--r3" }, { from: 0, to: 0.05, color: "--r4" },
];
const needleState = { model: null, snapshot: null, doc: null, memory: {}, runs: null, raceId: "tx-senate", source: null, demo: false, lastSosFetch: 0, sosError: null, refreshing: false };

function needleWindowOpen(now = Date.now()) { return now >= NEEDLE_TIMING.windowOpens && now <= NEEDLE_TIMING.windowCloses; }
function needleChance(p) { return p >= 0.995 ? ">99%" : p <= 0.005 ? "<1%" : `${Math.round(p * 100)}%`; }
function needleMarginWords(margin, dem, rep) { return margin == null ? "—" : Math.abs(margin) < 0.05 ? "even" : `${margin > 0 ? dem : rep} +${Math.abs(margin).toFixed(1)}`; }
const needleClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
const needleHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric" });
// Browsers differ on the space before AM/PM (newer ICU uses a narrow no-break space), so normalize it first.
function needleTime(iso) { return needleClock.format(new Date(iso)).replace(/\s+/g, " ").replace(" AM", " a.m.").replace(" PM", " p.m."); }

async function setupNeedle(snapshot) {
  const [model, earlyVoteModel, primaries] = await Promise.all([import("./model/needle.js"), import("./model/early-vote.js"), loadPrimaries()]);
  needleState.model = model;
  needleState.countyGroupLabel = earlyVoteModel.countyGroupLabel;
  needleState.snapshot = snapshot;
  if (primaries && snapshot.earlyVote?.counties) needleState.primaryRead = earlyVoteModel.primaryLean(snapshot.earlyVote.counties, primaries).statewide;
  needleState.demo = new URLSearchParams(location.search).has("demo");
  if (!needleState.demo) {
    // Draw right away from this browser's saved copy or the morning snapshot; the recorder's history replaces it
    // when it arrives.
    const saved = loadSavedNeedle((doc) => doc?.version === 1 && doc.election?.enrId === needleState.model.NEEDLE_ELECTION.enrId);
    needleState.doc = saved?.doc ?? needleState.model.createNeedleDocument(snapshot);
    needleState.source = "browser";
    needleState.runs = needleState.model.runNeedle({ counties: needleState.doc.inputs.counties, returns: needleState.doc.latest?.returns ?? null, races: needleState.doc.inputs.races });
    renderNeedle();
  }
  await refreshNeedle({ initial: true });
  window.addEventListener("resize", debounce(() => { if (needleState.doc) renderNeedleChart(needleState.doc, needleState.raceId); }, 150));
  if (needleState.demo) return;
  // Keep checking only on election night; a tab left open from the afternoon starts polling when the window opens.
  const refreshIfLive = () => { if (needleWindowOpen()) refreshNeedle().catch((error) => console.error("needle", error)); };
  setInterval(refreshIfLive, NEEDLE_TIMING.recorderPollMs);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshIfLive(); });
}
function debounce(fn, ms) { let timer = null; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); }; }

/**
 * Pick the freshest needle document (recorder, this browser's saved copy, or a new one from the morning snapshot),
 * read the Secretary of State directly when the recorder has gone quiet, and redraw.
 */
async function refreshNeedle({ initial = false, forceSos = false } = {}) {
  if (needleState.refreshing) return;
  needleState.refreshing = true;
  try {
    const { model } = needleState;
    if (needleState.demo) {
      if (initial) { needleState.doc = await fetchJson("data/needle-demo.json"); needleState.source = "demo"; }
    } else {
      const valid = (doc) => doc?.version === 1 && doc.election?.enrId === model.NEEDLE_ELECTION.enrId;
      // A recorder file from a test run before Election Day carries that day's polls; the snapshot is newer.
      const fromElectionDay = (doc) => Date.parse(doc?.createdAt) >= NEEDLE_TIMING.recorderFreshAfter;
      const now = Date.now();
      const isAlive = (entry) => now - Date.parse(entry.doc.checkedAt) < entry.recorder.staleMs;
      const freshness = (doc) => Date.parse(doc.latest?.fetchedAt ?? "") || 0;
      const fetched = await Promise.all(NEEDLE_RECORDERS.map(async (recorder) => ({
        recorder, doc: await fetch(recorder.url, { cache: "no-cache", signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      })));
      const recorded = fetched.filter((entry) => valid(entry.doc) && fromElectionDay(entry.doc));
      // The first live recorder wins outright (AWS, then GitHub), so the chart never flips between two histories.
      // With none alive, the freshest returns win, a recorder's history over this browser's on a tie.
      const live = recorded.find(isAlive);
      let pick = live ? { doc: live.doc, source: "recorder", recorder: live.recorder } : null;
      if (!pick) {
        const latestRecorded = recorded.sort((a, b) => freshness(b.doc) - freshness(a.doc))[0];
        const candidates = [latestRecorded ? { doc: latestRecorded.doc, source: "recorder", recorder: latestRecorded.recorder } : null, needleState.doc ? { doc: needleState.doc, source: needleState.source, recorder: needleState.recorder } : null].filter(Boolean);
        candidates.sort((a, b) => freshness(b.doc) - freshness(a.doc) || (a.source === "recorder" ? -1 : b.source === "recorder" ? 1 : 0));
        pick = candidates[0] ?? null;
      }
      if (pick && pick.doc !== needleState.doc) { needleState.doc = pick.doc; needleState.source = pick.source; needleState.recorder = pick.recorder ?? null; needleState.memory = {}; }
      if (!needleState.doc) { needleState.doc = model.createNeedleDocument(needleState.snapshot); needleState.source = "browser"; }

      const recorderAlive = needleState.source === "recorder" && now - Date.parse(needleState.doc.checkedAt) < (needleState.recorder?.staleMs ?? NEEDLE_TIMING.recorderStaleMs);
      const due = now - needleState.lastSosFetch >= NEEDLE_TIMING.sosPollMs && document.visibilityState === "visible";
      if (forceSos || (needleWindowOpen(now) && !recorderAlive && due)) {
        needleState.lastSosFetch = now;
        try {
          const returns = await fetchSosReturns(model);
          const { changed } = model.advanceNeedle(needleState.doc, { returns, fetchedAt: new Date().toISOString() }, needleState.memory);
          needleState.sosError = null;
          if (changed) { needleState.source = "browser"; saveNeedle(needleState.doc); }
        } catch (error) {
          needleState.sosError = error.message;
        }
      }
    }
    const { doc } = needleState;
    needleState.runs = needleState.model.runNeedle({ counties: doc.inputs.counties, returns: doc.latest?.returns ?? null, races: doc.inputs.races });
    renderNeedle();
  } finally {
    needleState.refreshing = false;
  }
}

/** The SOS county file, base64 inside JSON; decoded as UTF-8 so accented names survive. */
async function fetchSosReturns(model) {
  const response = await fetch(NEEDLE_SOS_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`Secretary of State feed: HTTP ${response.status}`);
  const wrapper = await response.json();
  if (!wrapper?.upload) throw new Error("Secretary of State feed was empty");
  const bytes = Uint8Array.from(atob(wrapper.upload), (character) => character.charCodeAt(0));
  return model.parseCountyReturns(JSON.parse(new TextDecoder().decode(bytes)));
}
function loadSavedNeedle(valid) {
  try { const doc = JSON.parse(localStorage.getItem(NEEDLE_STORAGE_KEY) || "null"); return valid(doc) ? { doc, source: "browser" } : null; } catch { return null; }
}
function saveNeedle(doc) { try { localStorage.setItem(NEEDLE_STORAGE_KEY, JSON.stringify(doc)); } catch { /* storage full or blocked: the in-memory copy still works */ } }

function renderNeedle() {
  const { doc, runs } = needleState;
  const runById = Object.fromEntries(runs.map((run) => [run.id, run]));
  renderNeedleStatus(doc, runs[0]);
  document.getElementById("needle-board").innerHTML = ["tx-senate", "tx-governor"].map((id) => needleRaceBlock(runById[id], doc, { large: true })).join("");
  document.getElementById("needle-small").innerHTML = runs.filter((run) => run.id !== "tx-senate" && run.id !== "tx-governor").map((run) => needleRaceBlock(run, doc, { large: false })).join("");
  const picker = document.getElementById("needle-race-picker");
  picker.innerHTML = runs.map((run) => `<button class="mode${run.id === needleState.raceId ? " active" : ""}" data-needle-race="${run.id}" aria-pressed="${run.id === needleState.raceId}">${esc(NEEDLE_RACE_LABELS[run.id] || run.office)}</button>`).join("");
  picker.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => { needleState.raceId = button.dataset.needleRace; renderNeedle(); }));
  renderNeedleChart(doc, needleState.raceId);
  renderNeedleEvents(doc, needleState.raceId);
  renderNeedleRead(runById[needleState.raceId], doc);
  renderNeedleMap(runById[needleState.raceId], doc);
  renderNeedleCounties(runById, doc);
}

// The county map follows the race picker. It is drawn once and recolored on each refresh, so a reader's zoom
// survives the minute-by-minute updates. With nothing counted yet it opens on the projection.
let NEEDLE_MAP_MODE = null; // "counted" | "projected"; null until the reader picks one
const needleMap = { topo: null, loading: false, svgRoot: null, paths: null };
function renderNeedleMap(run, doc) {
  if (!needleMap.topo) {
    if (!needleMap.loading) {
      needleMap.loading = true;
      fetchJson("geo/tx-counties.json")
        .then((topo) => { needleMap.topo = topo; if (needleState.runs) renderNeedle(); })
        .catch((error) => console.error("needle map", error));
    }
    return;
  }
  const width = 800, height = 760;
  if (!needleMap.svgRoot) {
    needleMap.svgRoot = d3.select("#needle-map").html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img");
    const features = topojson.feature(needleMap.topo, needleMap.topo.objects.counties).features;
    const path = d3.geoPath(d3.geoMercator().fitSize([width, height], { type: "FeatureCollection", features }));
    needleMap.paths = needleMap.svgRoot.append("g").attr("class", "zoom-root").selectAll("path").data(features).join("path").attr("d", path)
      .on("mouseleave", hideTooltip);
    attachZoom(needleMap.svgRoot, "needle-map", { width, height });
  }
  const mode = NEEDLE_MAP_MODE ?? (run.countedVotes ? "counted" : "projected");
  const byKey = new Map(run.counties.map((c) => [c.key, c]));
  const inputsByKey = new Map(doc.inputs.counties.map((c) => [c.key, c]));
  const keyFor = (feature) => String(feature.properties.name).toUpperCase().replace(/[^A-Z]/g, "");
  const dem = lastName(run.democrat), rep = lastName(run.republican);
  // Same diverging ramp as the early-vote map's results view.
  const marginScale = d3.scaleDiverging().domain([-60, 0, 60]).interpolator((t) => d3.interpolateRgbBasis([cssVar("--r4"), cssVar("--r2"), "#f2f2f0", cssVar("--d2"), cssVar("--d4")])(t));
  const marginFor = (county) => (mode === "counted" ? (county?.countedVotes ? county.countedMargin : null) : county?.projectedMargin);
  // The same three past results as the county table.
  const pastRaces = [["2018", "2018 Senate"], ["2022", "2022 governor"], ["2024", "2024 president"]];

  needleMap.svgRoot.attr("aria-label", `Texas counties, ${run.office}: ${mode === "counted" ? "margin in the votes counted so far" : "projected final margin"}`);
  needleMap.paths
    .attr("fill", (feature) => { const margin = marginFor(byKey.get(keyFor(feature))); return margin == null ? cssVar("--notup") : marginScale(margin); })
    .on("mousemove", (event, feature) => {
      const county = byKey.get(keyFor(feature)), input = inputsByKey.get(keyFor(feature));
      if (!county) { showTooltip(event, `<b>${esc(feature.properties.name)} County</b>`); return; }
      const counted = county.expectedVotes ? county.countedVotes / county.expectedVotes : 0;
      const pastRows = pastRaces.map(([year, label]) => `<div class="row"><span>${label}</span><span>${partyColored(marginText(input?.past?.[year]), input?.past?.[year])}</span></div>`).join("");
      showTooltip(event, `<b>${esc(county.name)} County</b><div class="muted">${esc(needleState.countyGroupLabel(county.name))}</div>
        <div class="row"><span>Counted</span><span>${county.countedVotes ? `${pct(counted)} of about ${compact(county.expectedVotes)}` : "not yet"}</span></div>
        <div class="row"><span>So far</span><span>${county.countedVotes ? partyColored(needleMarginWords(county.countedMargin, dem, rep), county.countedMargin) : "—"}</span></div>
        <div class="row"><span>Projected</span><span>${partyColored(needleMarginWords(county.projectedMargin, dem, rep), county.projectedMargin)}</span></div>${pastRows}`);
    });

  document.getElementById("needle-map-title").textContent = `County map, ${NEEDLE_RACE_LABELS[run.id] || run.office}`;
  document.getElementById("needle-map-legend").innerHTML = [-60, -30, -10, 0, 10, 30, 60].map((m) => `<span><i class="sw" style="background:${marginScale(m)}"></i>${m === 0 ? "Even" : `${esc(m > 0 ? dem : rep)} +${Math.abs(m)}`}</span>`).join("")
    + (mode === "counted" ? `<span><i class="sw" style="background:${cssVar("--notup")}"></i>No votes counted yet</span>` : "");
  document.querySelectorAll("button.mode[data-needle-map-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.needleMapMode === mode);
    button.onclick = () => { NEEDLE_MAP_MODE = button.dataset.needleMapMode; renderNeedleMap(needleState.runs.find((r) => r.id === needleState.raceId), needleState.doc); };
  });
}

function renderNeedleStatus(doc, topRun) {
  const box = document.getElementById("needle-status");
  box.className = "needle-status";
  const now = Date.now();
  if (needleState.demo) {
    box.classList.add("demo");
    box.innerHTML = `<b>Simulated election night.</b><span>Made-up returns from a test run of the model (seed ${esc(doc.simulated?.seed ?? "?")}), not real results.</span>`;
    return;
  }
  const refresh = needleWindowOpen(now) ? ' <button type="button" id="needle-refresh">Check the Secretary of State now</button>' : "";
  const problem = needleState.sosError ? ` <span>Last direct check failed (${esc(needleState.sosError)}); showing the latest returns we have.</span>` : "";
  if (!topRun.countedVotes) {
    box.innerHTML = now < NEEDLE_TIMING.pollsClose
      ? `<b>Polls close at 7 p.m. Central</b><span>(8 p.m. in El Paso and Hudspeth counties). Until returns arrive, each needle is the polls model adjusted for where early ballots came from.</span>${refresh}`
      : `<b>Waiting for the first returns.</b><span>Counties post early votes first, usually within an hour of polls closing.</span>${refresh}${problem}`;
  } else {
    box.classList.add("live");
    // The state's status file lags its county file, so count the counties with votes in the returns themselves.
    const status = doc.status;
    const withVotes = Object.values(doc.latest?.returns ?? {}).filter((county) => Object.values(county.races ?? {}).some((race) => race[3] > 0)).length;
    const counted = Math.max(withVotes, status?.countiesReporting ?? 0);
    const reporting = counted ? ` ${counted} of ${status?.countiesTotal ?? 254} counties reporting; the biggest counties often post on their own websites before the state's feed has them.` : "";
    const how = needleState.source === "browser" ? "read directly by your browser" : "checked every two minutes";
    const calledCount = Object.keys(doc.calls ?? {}).length;
    const callNote = calledCount ? ` ${calledCount} of ${doc.inputs.races.length} statewide races called by the networks show results; the rest show the needle, a projection, not a call.` : " The needle is a projection, not a race call.";
    box.innerHTML = `<b><span class="live-dot" aria-hidden="true"></span>Returns as of ${needleTime(doc.checkedAt)} Central.</b><span>${reporting} Unofficial results from the Texas Secretary of State and the biggest counties' own sites, ${how}.${callNote}</span>${refresh}${problem}`;
  }
  document.getElementById("needle-refresh")?.addEventListener("click", () => refreshNeedle({ forceSos: true }).catch((error) => console.error("needle", error)));
}

/**
 * A called race as results: the candidates' votes and shares so far, the winner checked, and how much is in. Votes
 * are the sum of the counties' counts the needle reads (the state's feed, or a county's own site when it's ahead).
 */
function resultsRaceBlock(run, doc, call, { large }) {
  let total = 0, dem = 0, rep = 0;
  for (const county of Object.values(doc.latest?.returns ?? {})) {
    const counted = county.races?.[run.id];
    if (counted) { total += counted[3]; dem += counted[4]; rep += counted[5]; }
  }
  const rows = [
    { name: run.democrat, party: "D", word: "Democrat", votes: dem },
    { name: run.republican, party: "R", word: "Republican", votes: rep },
    { name: "Others", party: "other", word: "", votes: Math.max(0, total - dem - rep) },
  ].filter((row) => row.party !== "other" || row.votes > 0);
  const winner = call.winner === "D" ? run.democrat : call.winner === "R" ? run.republican : call.name;
  const color = (party) => cssVar(party === "D" ? "--d3" : party === "R" ? "--r3" : "--toss");
  return `<div class="needle-race results-race">
    <h4>${esc(run.office)}</h4>
    <p class="call-line">${checkBadgeIcon(color(call.winner), { inverse: true })}<b>${esc(winner)} wins</b><span class="thin">${call.via === "manual" ? "called by the networks, set by hand" : "called by the networks, as posted to Wikipedia"}</span></p>
    <table class="results-table"><tbody>
      ${rows.map((row) => `<tr class="${row.party === call.winner ? "winner" : ""}"><td class="name"><i class="party-bar" style="background:${color(row.party)}"></i>${row.party === call.winner ? `${checkBadgeIcon(color(row.party))} ` : ""}${esc(row.name)}</td>${large ? `<td class="muted">${row.word}</td>` : ""}<td class="num">${senateVotes(row.votes)}</td><td class="num"><b>${total ? pct(row.votes / total, 1) : "—"}</b></td>${large ? `<td class="bar-cell"><span class="share-bar" style="width:${total ? Math.round((100 * row.votes) / total) : 0}%;background:${color(row.party)}"></span></td>` : ""}</tr>`).join("")}
      ${large ? `<tr class="total"><td class="name">Total reported</td><td></td><td class="num">${senateVotes(total)}</td><td></td><td></td></tr>` : ""}
    </tbody></table>
    <p class="thin">${pct(run.countedShare)} of about ${compact(run.expectedVotes)} expected votes in. Unofficial results.</p>
  </div>`;
}

/** One race: gauge, both candidates' chances, and the projection in words; results once the race is called. */
function needleRaceBlock(run, doc, { large }) {
  const call = doc.calls?.[run.id];
  if (call && !needleState.demo) return resultsRaceBlock(run, doc, call, { large });
  // The gauge's tick marks the polls model; the needle starts a little off it, moved by the early-vote turnout mix.
  const prior = run.prior.pD;
  const start = doc.timeline[run.id]?.[0]?.p ?? prior;
  const dem = lastName(run.democrat), rep = lastName(run.republican);
  const range = `${needleMarginWords(run.interval80[0], dem, rep)} to ${needleMarginWords(run.interval80[1], dem, rep)}`;
  const facts = [`Projected margin <b>${needleMarginWords(run.margin, dem, rep)}</b>${large ? `; 80% range ${esc(range)}` : ""}`];
  if (run.countedVotes) facts.push(`<b>${pct(run.countedShare)}</b> of about ${compact(run.expectedVotes)} expected votes counted${large ? `; ${esc(needleMarginWords(run.countedMargin, dem, rep))} in the count so far` : ""}`);
  else if (large) facts.push(`No votes counted yet; about ${compact(run.expectedVotes)} expected`);
  if (large) facts.push(`Before returns: polls model ${esc(dem)} ${needleChance(prior)}; with the early-vote turnout mix, ${needleChance(start)}`);
  const leaderIsDem = run.pD >= 0.5;
  return `<div class="needle-race">
    <h4>${esc(run.office)}</h4>
    <p class="sub-head">${esc(run.democrat)} (D) against ${esc(run.republican)} (R)</p>
    <div class="needle-gauge">${needleGaugeSvg(run.pD, prior, { large, dem, rep })}</div>
    <div class="needle-odds"><div class="side${leaderIsDem ? "" : " trails"}"><b>${needleChance(run.pD)}</b>${esc(dem)}</div><div class="side right${leaderIsDem ? " trails" : ""}"><b>${needleChance(1 - run.pD)}</b>${esc(rep)}</div></div>
    <ul class="facts">${facts.map((fact) => `<li>${fact}</li>`).join("")}</ul>
  </div>`;
}

/**
 * Semicircle gauge: the Democrat's side on the left, as on every split bar on the site. The hand points at the
 * Democratic win chance; a small tick outside the arc marks where the pre-election polls model stood.
 */
function needleGaugeSvg(p, prior, { large = true, dem, rep } = {}) {
  const cx = 150, cy = 146, outer = 138, thickness = large ? 30 : 34, inner = outer - thickness;
  const angle = (probability) => Math.PI / 2 - Math.PI * probability; // d3.arc: 0 points up, clockwise positive
  const point = (probability, radius) => [cx + radius * Math.sin(angle(probability)), cy - radius * Math.cos(angle(probability))];
  const arc = d3.arc().innerRadius(inner).outerRadius(outer).padAngle(0.014).cornerRadius(2);
  const bands = NEEDLE_BANDS.map((band) => `<path d="${arc({ startAngle: angle(band.to), endAngle: angle(band.from) })}" transform="translate(${cx},${cy})" fill="${band.color ? cssVar(band.color) : "#e9e9e6"}"></path>`).join("");
  const [handX, handY] = point(p, outer - 4);
  const [tickInnerX, tickInnerY] = point(prior, outer + 3), [tickOuterX, tickOuterY] = point(prior, outer + 12);
  const [halfInnerX, halfInnerY] = point(0.5, inner - 2), [halfOuterX, halfOuterY] = point(0.5, inner - 9);
  const height = large ? 172 : 156;
  // The odds row under the gauge names both sides; on the big gauges a small label marks the polls tick.
  const ends = large ? `<text class="prior-label" x="${tickOuterX}" y="${tickOuterY - 4}" text-anchor="${prior > 0.55 ? "end" : prior < 0.45 ? "start" : "middle"}">polls</text>` : "";
  return `<svg viewBox="0 ${large ? -16 : 0} 300 ${height}" role="img" aria-label="${esc(dem)} ${needleChance(p)} chance, ${esc(rep)} ${needleChance(1 - p)}">
    ${bands}
    <line x1="${halfInnerX}" y1="${halfInnerY}" x2="${halfOuterX}" y2="${halfOuterY}" stroke="${cssVar("--ink-3")}" stroke-width="1.5"></line>
    <line x1="${tickInnerX}" y1="${tickInnerY}" x2="${tickOuterX}" y2="${tickOuterY}" stroke="${cssVar("--ink-3")}" stroke-width="2"></line>
    <line class="needle-hand" x1="${cx}" y1="${cy}" x2="${handX}" y2="${handY}" stroke="${cssVar("--ink")}" stroke-width="${large ? 4 : 5}" stroke-linecap="round"></line>
    <circle cx="${cx}" cy="${cy}" r="${large ? 8 : 10}" fill="${cssVar("--ink")}"></circle>
    ${ends}
  </svg>`;
}

/**
 * The night in two stacked panels sharing a Central-time axis: the Democrat's win chance (step line, since the
 * needle holds its value between updates) with numbered annotations, and the projected margin with its 80% range.
 */
function renderNeedleChart(doc, raceId) {
  const box = document.getElementById("needle-chart");
  box.innerHTML = "";
  const race = doc.inputs.races.find((r) => r.id === raceId);
  const dem = lastName(race.democrat), rep = lastName(race.republican);
  document.getElementById("needle-chart-title").textContent = `${dem}'s chance through the night, ${NEEDLE_RACE_LABELS[raceId] || race.office}`;
  const series = (doc.timeline[raceId] || []).map((point) => ({ ...point, time: Math.max(Date.parse(point.t), NEEDLE_TIMING.chartStart) }));
  const events = needleEventsFor(doc, raceId).filter((event) => event.n);
  const narrow = window.innerWidth < 600;
  const width = narrow ? 520 : 1000;
  const margin = { top: 30, right: narrow ? 44 : 96, bottom: 26, left: 44 };
  const chanceHeight = narrow ? 210 : 250, gap = 44, marginHeight = narrow ? 110 : 130;
  const chanceTop = margin.top, chanceBottom = chanceTop + chanceHeight, marginTop = chanceBottom + gap, marginBottom = marginTop + marginHeight;
  const height = marginBottom + margin.bottom;
  const lastTime = series.length ? series[series.length - 1].time : NEEDLE_TIMING.chartStart;
  const now = Date.now();
  // Live, the last reading holds until now; a finished or simulated night ends at its last reading.
  const holdUntil = needleState.demo || !needleWindowOpen(now) ? lastTime : Math.max(lastTime, now);
  const end = Math.max(NEEDLE_TIMING.chartMinimumEnd, holdUntil + 20 * 60_000);
  const drawn = series.length ? [...series, { ...series[series.length - 1], time: holdUntil }] : [];
  const x = d3.scaleLinear().domain([NEEDLE_TIMING.chartStart, end]).range([margin.left, width - margin.right]);
  const yChance = d3.scaleLinear().domain([0, 1]).range([chanceBottom, chanceTop]);
  const marginValues = [0, ...series.flatMap((p) => [p.lo ?? p.m, p.hi ?? p.m])];
  const [low, high] = d3.extent(marginValues);
  const pad = Math.max(1, (high - low) * 0.08);
  const yMargin = d3.scaleLinear().domain([low - pad, high + pad]).nice().range([marginBottom, marginTop]);
  const svg = d3.select(box).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img")
    .attr("aria-label", `${race.office}: ${dem}'s win chance and the projected margin through election night`);
  const signedMargin = (v) => (v === 0 ? "Even" : `${v > 0 ? "D" : "R"}+${Math.abs(v)}`);

  // Hourly ticks in Central time (Central Standard Time is a whole-hour offset, so UTC hours line up).
  const hourTicks = d3.range(Math.ceil(NEEDLE_TIMING.chartStart / 3_600_000) * 3_600_000, end + 1, 3_600_000).filter((t, i) => !narrow || i % 2 === 0);
  svg.append("g").attr("class", "grid").selectAll("line").data([0.25, 0.75, 1]).join("line")
    .attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", (v) => yChance(v)).attr("y2", (v) => yChance(v));
  svg.append("g").attr("class", "grid").selectAll("line").data(yMargin.ticks(4)).join("line")
    .attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", (v) => yMargin(v)).attr("y2", (v) => yMargin(v));
  svg.append("line").attr("class", "even-line").attr("stroke-dasharray", "3 3").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", yChance(0.5)).attr("y2", yChance(0.5));
  svg.append("line").attr("class", "even-line").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", yMargin(0)).attr("y2", yMargin(0));
  // Poll-closing rules; on phones the hour between them is too narrow for both labels.
  for (const [time, label] of [[NEEDLE_TIMING.pollsClose, "Polls close"], [NEEDLE_TIMING.lastPollsClose, narrow ? "" : "El Paso closes"]]) {
    svg.append("line").attr("class", "close-rule").attr("x1", x(time)).attr("x2", x(time)).attr("y1", chanceTop - 6).attr("y2", marginBottom);
    if (label) svg.append("text").attr("class", "close-label").attr("x", x(time) + 4).attr("y", chanceTop - 10).text(label);
  }
  svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(yChance).tickValues([0, 0.5, 1]).tickFormat((v) => `${Math.round(v * 100)}%`).tickSize(0).tickPadding(9)).select(".domain").remove();
  svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(yMargin).ticks(4).tickFormat(signedMargin).tickSize(0).tickPadding(9)).select(".domain").remove();
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${marginBottom})`)
    .call(d3.axisBottom(x).tickValues(hourTicks).tickFormat((t) => needleHour.format(new Date(t)).replace(/\s+/g, " ").toLowerCase()).tickSize(0)).select(".domain").remove();
  svg.append("text").attr("class", "panel-label").attr("x", margin.left + 4).attr("y", marginTop - 10).text("Projected final margin, with its 80% range");

  if (series.length && series[series.length - 1].c > 0) {
    svg.append("path").datum(drawn).attr("fill", cssVar("--rule-soft"))
      .attr("d", d3.area().curve(d3.curveStepAfter).x((p) => x(p.time)).y0((p) => yMargin(p.lo ?? p.m)).y1((p) => yMargin(p.hi ?? p.m)));
    svg.append("path").datum(drawn).attr("fill", "none").attr("stroke", cssVar("--ink")).attr("stroke-width", 2)
      .attr("d", d3.line().curve(d3.curveStepAfter).x((p) => x(p.time)).y((p) => yMargin(p.m)));
    svg.append("path").datum(drawn).attr("fill", "none").attr("stroke", cssVar("--d3")).attr("stroke-width", 2)
      .attr("d", d3.line().curve(d3.curveStepAfter).x((p) => x(p.time)).y((p) => yChance(p.p)));
    // Direct label at the line's end: beside it on wide screens, above it (inside the plot) on phones.
    const last = drawn[drawn.length - 1];
    const endLabel = svg.append("text").attr("class", "event-label").text(`${dem} ${needleChance(last.p)}`);
    if (narrow) endLabel.attr("x", x(last.time)).attr("y", yChance(last.p) + (last.p > 0.85 ? 18 : -8)).attr("text-anchor", "end");
    else endLabel.attr("x", x(last.time) + 6).attr("y", yChance(last.p) + 4);
  } else {
    // Nothing counted yet: the starting point, and what will happen here.
    const start = series[0];
    if (start) {
      svg.append("circle").attr("cx", x(NEEDLE_TIMING.chartStart)).attr("cy", yChance(start.p)).attr("r", 4.5).attr("fill", cssVar("--d3"));
      if (start.lo != null) svg.append("line").attr("x1", x(NEEDLE_TIMING.chartStart)).attr("x2", x(NEEDLE_TIMING.chartStart)).attr("y1", yMargin(start.lo)).attr("y2", yMargin(start.hi)).attr("stroke", cssVar("--rule")).attr("stroke-width", 6);
      svg.append("circle").attr("cx", x(NEEDLE_TIMING.chartStart)).attr("cy", yMargin(start.m)).attr("r", 4.5).attr("fill", cssVar("--ink"));
    }
    svg.append("text").attr("class", "empty-note").attr("x", x(NEEDLE_TIMING.pollsClose) + 8).attr("y", yChance(0.5) - 12)
      .text(start ? `The line starts at ${dem} ${needleChance(start.p)} (the polls plus the early-vote turnout mix) and moves as counties report.` : "Waiting for returns.");
  }

  // Numbered annotations; the biggest few also carry their headline on the chart.
  const markers = events.map((event) => ({ event, x: x(Math.max(Date.parse(event.t), NEEDLE_TIMING.chartStart)), y: yChance(event.p1) }));
  for (const { event, x: ex, y: ey } of markers) {
    const marker = svg.append("g").attr("class", "event-marker").attr("transform", `translate(${ex},${ey})`).attr("tabindex", 0)
      .attr("role", "img").attr("aria-label", `${event.n}: ${event.headline}`);
    marker.append("circle").attr("r", 9);
    marker.append("text").attr("text-anchor", "middle").attr("dy", "0.35em").text(event.n);
    const tip = (e) => showTooltip(e, `<b>${event.n}. ${needleTime(event.t)}</b><div>${esc(event.headline)}</div><hr><div>${esc(event.detail)}</div>`);
    marker.on("mousemove", tip).on("mouseleave", hideTooltip).on("focus", (e) => { const r = e.target.getBoundingClientRect(); tip({ clientX: r.right, clientY: r.bottom }); }).on("blur", hideTooltip);
  }
  // The step line as points every few pixels (runs and risers), for the label placer to steer around.
  const linePoints = [];
  for (let i = 0; i + 1 < drawn.length; i += 1) {
    const x0 = x(drawn[i].time), x1 = x(drawn[i + 1].time), y0 = yChance(drawn[i].p), y1 = yChance(drawn[i + 1].p);
    for (let px = x0; px < x1; px += 5) linePoints.push({ x: px, y: y0 });
    for (let py = Math.min(y0, y1); py <= Math.max(y0, y1); py += 5) linePoints.push({ x: x1, y: py });
  }
  placeNeedleLabels(svg, markers, linePoints, { count: narrow ? 2 : 3, left: margin.left, right: width - margin.right, top: chanceTop, bottom: chanceBottom });

  // Hover: a rule across both panels and that moment's numbers.
  if (drawn.length < 2) return;
  const hover = svg.append("g").style("display", "none");
  hover.append("line").attr("class", "hover-line").attr("y1", chanceTop).attr("y2", marginBottom);
  const chanceMarker = hover.append("circle").attr("r", 4).attr("fill", cssVar("--d3")).attr("stroke", "#fff").attr("stroke-width", 1.5);
  const marginMarker = hover.append("circle").attr("r", 4).attr("fill", cssVar("--ink")).attr("stroke", "#fff").attr("stroke-width", 1.5);
  const bisect = d3.bisector((p) => p.time).right;
  svg.insert("rect", ".event-marker").attr("x", margin.left).attr("y", chanceTop).attr("width", x(holdUntil) - margin.left).attr("height", marginBottom - chanceTop).attr("fill", "transparent")
    .on("mousemove", (event) => {
      const [pointerX] = d3.pointer(event);
      const time = x.invert(pointerX);
      const point = drawn[Math.max(0, bisect(drawn, time) - 1)];
      hover.style("display", null);
      hover.select("line").attr("x1", pointerX).attr("x2", pointerX);
      chanceMarker.attr("cx", pointerX).attr("cy", yChance(point.p));
      marginMarker.attr("cx", pointerX).attr("cy", yMargin(point.m));
      showTooltip(event, `<b>${needleTime(new Date(time).toISOString())}</b>
        <div class="row"><span>${esc(dem)} win chance</span><span>${needleChance(point.p)}</span></div>
        <div class="row"><span>Projected margin</span><span>${esc(needleMarginWords(point.m, dem, rep))}</span></div>
        ${point.lo != null ? `<div class="row"><span>80% range</span><span>${esc(needleMarginWords(point.lo, dem, rep))} to ${esc(needleMarginWords(point.hi, dem, rep))}</span></div>` : ""}
        <div class="row"><span>Expected vote counted</span><span>${pct(point.c)}</span></div>`);
    })
    .on("mouseleave", () => { hover.style("display", "none"); hideTooltip(); });
}

/**
 * Put headline labels beside the biggest moves. Each label tries eight spots around its marker and takes the one
 * that collides least with other markers, the line (sampled as points), and labels already placed.
 */
function placeNeedleLabels(svg, markers, linePoints, { count, left, right, top, bottom }) {
  const chosen = [...markers].sort((a, b) => Math.abs(b.event.p1 - b.event.p0) - Math.abs(a.event.p1 - a.event.p0)).slice(0, count);
  const placed = [];
  const overlaps = (box, other) => box.x0 < other.x1 && other.x0 < box.x1 && box.y0 < other.y1 && other.y0 < box.y1;
  for (const { event, x: mx, y: my } of chosen) {
    const text = event.headline.length > 42 ? `${event.headline.slice(0, 41)}…` : event.headline;
    const labelWidth = text.length * 6.5, labelHeight = 14;
    const spots = [[14, -10], [14, 22], [-14 - labelWidth, -10], [-14 - labelWidth, 22], [14, -26], [14, 38], [-14 - labelWidth, -26], [-14 - labelWidth, 38]];
    let best = null;
    for (const [dx, dy] of spots) {
      const box = { x0: mx + dx, x1: mx + dx + labelWidth, y0: my + dy - labelHeight + 3, y1: my + dy + 3 };
      if (box.x0 < left || box.x1 > right + 90 || box.y0 < top - 4 || box.y1 > bottom) continue;
      const markerHits = markers.filter((m) => overlaps(box, { x0: m.x - 11, x1: m.x + 11, y0: m.y - 11, y1: m.y + 11 })).length;
      const lineHits = linePoints.filter((p) => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 - 2 && p.y <= box.y1 + 2).length;
      const labelHits = placed.filter((other) => overlaps(box, other)).length;
      const score = markerHits * 4 + labelHits * 10 + Math.min(lineHits, 5);
      if (!best || score < best.score) best = { score, box, dx, dy };
    }
    if (!best) continue;
    placed.push(best.box);
    svg.append("text").attr("class", "event-label").attr("x", mx + best.dx).attr("y", my + best.dy).text(text);
  }
}

/**
 * The race's annotations in time order. The first returns and the biggest moves (up to eight) are charted and
 * numbered, the same numbers on the chart and in the list; the rest are listed without a number.
 */
function needleEventsFor(doc, raceId, { charted = 8 } = {}) {
  const events = doc.events.filter((e) => e.race === raceId).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const biggest = new Set([...events].sort((a, b) => (b.kind === "first") - (a.kind === "first") || Math.abs(b.p1 - b.p0) - Math.abs(a.p1 - a.p0)).slice(0, charted));
  let n = 0;
  return events.map((event) => ({ ...event, n: biggest.has(event) ? (n += 1) : null }));
}

function renderNeedleEvents(doc, raceId) {
  const events = needleEventsFor(doc, raceId);
  const race = doc.inputs.races.find((r) => r.id === raceId);
  const list = document.getElementById("needle-events");
  document.getElementById("needle-events-title").textContent = `What moved the needle: ${NEEDLE_RACE_LABELS[raceId] || race.office}`;
  if (!events.length) { list.innerHTML = '<li class="empty">Nothing yet. Annotations mark the first returns and every big move: a jump of 8 points in one update, or a drift of 20.</li>'; return; }
  list.innerHTML = events.slice().reverse().map((event) => {
    const towardD = event.p1 >= event.p0;
    return `<li>${event.n ? `<span class="n">${event.n}</span>` : "<span></span>"}<span class="when">${needleTime(event.t)}</span><span class="move ${towardD ? "lean-d" : "lean-r"}">${needleChance(event.p0)} → ${needleChance(event.p1)}</span><span class="text">${esc(event.detail)}</span></li>`;
  }).join("");
}

/** Plain-language read of the shared effects the model has learned for the selected race. */
function renderNeedleRead(run, doc) {
  const race = doc.inputs.races.find((r) => r.id === run.id);
  const dem = lastName(race.democrat), rep = lastName(race.republican);
  document.getElementById("needle-read-title").textContent = `What the returns say so far: ${NEEDLE_RACE_LABELS[run.id] || race.office}`;
  const list = document.getElementById("needle-read");
  if (!run.countedVotes) {
    const startPoint = run.startingPoint;
    const mixWords = startPoint && Math.abs(startPoint.added) >= 0.1
      ? ` plus ${Math.abs(startPoint.added).toFixed(1)} points toward ${esc(startPoint.added > 0 ? dem : rep)}: early ballots came from counties about ${Math.abs(startPoint.turnoutMix).toFixed(1)} points ${startPoint.turnoutMix > 0 ? "bluer" : "redder"} than the 2022 electorate (see the Early vote tab), and the needle counts half of that, since likely-voter polls already catch some of it`
      : "";
    const primaries = needleState.primaryRead;
    const primaryWords = primaries && Math.abs(primaries.tilt) >= 0.5
      ? `<li>The March primaries point the same way: early ballots came from counties whose primary voters were ${primaries.tilt > 0 ? "more Democratic" : "more Republican"} than the state's primary electorate by ${Math.abs(primaries.tilt).toFixed(1)} points (${pct(primaries.earlyWeightedDemShare, 1)} against ${pct(primaries.primaryDemShare, 1)}). That is context, not part of the projection.</li>`
      : "";
    list.innerHTML = `<li>Nothing counted yet. The starting projection is <b>${esc(needleMarginWords(startPoint?.margin ?? race.prior.margin, dem, rep))}</b>: the final polling average (${esc(needleMarginWords(race.prior.margin, dem, rep))})${mixWords}.</li>${primaryWords}
      <li>About ${compact(run.expectedVotes)} votes expected: ${compact(doc.inputs.counties.reduce((t, c) => t + c.early, 0))} early ballots already cast plus Election Day.</li>`;
    return;
  }
  const items = [];
  const versusPolls = run.margin - race.prior.margin;
  items.push(`The projection is <b>${esc(needleMarginWords(run.margin, dem, rep))}</b>, ${Math.abs(versusPolls) < 0.5 ? "close to" : `${Math.abs(versusPolls).toFixed(1)} points better for ${esc(versusPolls > 0 ? dem : rep)} than`} the final polling average (${esc(needleMarginWords(race.prior.margin, dem, rep))}). ${pct(run.countedShare)} of about ${compact(run.expectedVotes)} expected votes are counted.`);
  const dayVotes = run.counties.reduce((t, c) => t + c.dayVotes, 0);
  const day = run.shared.electionDay;
  if (!dayVotes) items.push("Only early votes are in. Election Day votes often break differently, so the model allows a gap of several points either way until counties report them.");
  else if (Math.abs(day.mean) >= 1 && Math.abs(day.mean) > day.sd) items.push(`Election Day votes are running about ${Math.abs(day.mean).toFixed(1)} points more ${day.mean > 0 ? "Democratic" : "Republican"} than early votes in the same counties.`);
  else items.push("Election Day votes are breaking about like early votes in the same counties.");
  // Realignment: what the learned factor means for Hidalgo, the biggest county that swung hard to Trump in 2024.
  const realign = run.shared.realignment;
  const hidalgo = doc.inputs.counties.find((c) => c.key === "HIDALGO");
  if (hidalgo && Math.abs(realign.mean) > 1.5 * realign.sd) {
    const totalEarly = doc.inputs.counties.reduce((t, c) => t + c.early, 0);
    const meanShift = doc.inputs.counties.reduce((t, c) => t + c.early * (c.relativeShift || 0), 0) / totalEarly;
    const points = realign.mean * -(hidalgo.relativeShift - meanShift);
    if (Math.abs(points) >= 1) items.push(`Counties that moved hardest toward Trump between 2022 and 2024 are running ${points > 0 ? "more Democratic" : "more Republican"} than the model's starting point expected, by about ${Math.abs(points).toFixed(0)} points in a county like Hidalgo.`);
  }
  for (const [region, effect] of Object.entries(run.shared.regions)) {
    if (Math.abs(effect.mean) >= 1.5 && Math.abs(effect.mean) > 1.5 * effect.sd) items.push(`${esc(region)}: about ${Math.abs(effect.mean).toFixed(1)} points more ${effect.mean > 0 ? "Democratic" : "Republican"} than the rest of the state, against expectations.`);
  }
  list.innerHTML = items.map((item) => `<li>${item}</li>`).join("");
}

function renderNeedleCounties(runById, doc) {
  const senate = runById["tx-senate"], governor = runById["tx-governor"];
  const senateRace = doc.inputs.races.find((r) => r.id === "tx-senate"), governorRace = doc.inputs.races.find((r) => r.id === "tx-governor");
  const senateByKey = new Map(senate.counties.map((c) => [c.key, c])), governorByKey = new Map(governor.counties.map((c) => [c.key, c]));
  const inputsByKey = new Map(doc.inputs.counties.map((c) => [c.key, c]));
  const margin = (value) => (value == null ? '<span class="muted">—</span>' : partyColored(marginText(value), value));
  const swing = (value) => (value == null ? '<span class="muted">—</span>' : `<span class="${value > 0 ? "lean-d" : value < 0 ? "lean-r" : ""}">${value > 0 ? "D" : "R"}+${Math.abs(value).toFixed(1)}</span>`);
  // Each race is compared with the same office's last race: 2018 Senate and 2022 governor, both Beto O'Rourke,
  // the closest Democrats have come statewide (R+2.6) and the last midterm.
  const header = `<thead><tr><th>County</th><th>Counted</th>
    <th class="num">${esc(lastName(senateRace.democrat))}<span class="sub">Senate so far</span></th><th class="num">${esc(lastName(governorRace.democrat))}<span class="sub">governor so far</span></th>
    <th class="num">2018<span class="sub">Senate</span></th><th class="num">2022<span class="sub">governor</span></th><th class="num">2024<span class="sub">president</span></th>
    <th class="num">Senate swing<span class="sub">vs 2018</span></th><th class="num">Governor swing<span class="sub">vs 2022</span></th>
    <th class="num">Split<span class="sub">Senate − governor</span></th><th class="num">Projected<span class="sub">Senate final</span></th></tr></thead>`;
  const row = (key) => {
    const s = senateByKey.get(key), g = governorByKey.get(key), input = inputsByKey.get(key);
    if (!s || !input) return "";
    const share = s.expectedVotes ? s.countedVotes / s.expectedVotes : 0;
    const progress = s.countedVotes
      ? `${s.earlyShare >= 0.95 ? "early in" : `early ${pct(s.earlyShare)}`}, Election Day ${pct(s.dayReporting)}`
      : "not yet";
    const past2018 = input.past?.["2018"], past2022 = input.past?.["2022"], past2024 = input.past?.["2024"];
    return `<tr>
      <td class="county"><b>${esc(s.name)}</b><span class="thin">${esc(needleState.countyGroupLabel(s.name))}</span></td>
      <td><span class="progress" aria-hidden="true"><span style="width:${Math.round(Math.min(1, share) * 100)}%"></span></span>${pct(share)}<span class="thin">${esc(progress)}</span></td>
      <td class="num">${margin(s.countedMargin)}</td><td class="num">${margin(g?.countedMargin)}</td>
      <td class="num">${margin(past2018)}</td><td class="num">${margin(past2022)}</td><td class="num">${margin(past2024)}</td>
      <td class="num">${swing(s.countedMargin != null && past2018 != null ? s.countedMargin - past2018 : null)}</td>
      <td class="num">${swing(g?.countedMargin != null && past2022 != null ? g.countedMargin - past2022 : null)}</td>
      <td class="num">${swing(s.countedMargin != null && g?.countedMargin != null ? s.countedMargin - g.countedMargin : null)}</td>
      <td class="num">${margin(s.projectedMargin)}</td></tr>`;
  };
  const watchKeys = NEEDLE_WATCH_COUNTIES.map((name) => name.toUpperCase().replace(/[^A-Z]/g, ""));
  document.getElementById("needle-counties").innerHTML = `${header}<tbody>${watchKeys.map(row).join("")}</tbody>`;
  const allKeys = senate.counties.slice().sort((a, b) => b.expectedVotes - a.expectedVotes).map((c) => c.key);
  document.getElementById("needle-counties-all").innerHTML = `${header}<tbody>${allKeys.map(row).join("")}</tbody>`;
}

// ---------- ask the data (OpenAI, with the site's key or the visitor's own) ----------
// A chat with OpenAI about this page's data, two ways:
// - The site's key: a password unlocks the key kept in the site's Vercel settings; api/ask.js calls OpenAI with it,
//   so the key never reaches the browser. Offered when that function reports it is set up.
// - The visitor's own key: typed into this tab, kept in sessionStorage (localStorage only if they choose to
//   remember it), and sent only to api.openai.com, which allows browser calls.
// Every question carries a fresh digest of what the page has loaded (morning snapshot, early vote, March primaries,
// election-night needles and returns), so answers use the newest numbers.
const ASK_STORAGE = { key: "ask-openai-key", password: "ask-site-password", model: "ask-openai-model", mode: "ask-mode" };
const ASK_ENDPOINT = "https://api.openai.com/v1";
const ASK_FALLBACK_MODELS = ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o"]; // until the real model list loads
const ASK_SUGGESTIONS = [
  "Where do the Senate and governor races stand right now, and how sure is the model?",
  "Which big counties are running furthest ahead of or behind Beto's 2018 Senate margin?",
  "What has moved the needle most tonight, and why?",
  "How does early-vote turnout compare with 2018 and 2022 by county type?",
];
const askState = { history: [], busy: false, primaries: null, mode: "own", siteConfigured: false, system: null };

function askStored(name) { return sessionStorage.getItem(ASK_STORAGE[name]) || localStorage.getItem(ASK_STORAGE[name]) || ""; }
/** The credential for the current mode: the site password or the visitor's own key. */
function askSecretName() { return askState.mode === "site" ? "password" : "key"; }
function askSecret() { return askStored(askSecretName()); }

async function setupAsk(snapshot) {
  const status = document.getElementById("ask-key-status"), remember = document.getElementById("ask-remember");
  const keyInput = document.getElementById("ask-key"), passwordInput = document.getElementById("ask-password");
  const save = document.getElementById("ask-save"), forget = document.getElementById("ask-forget");
  const showStatus = () => {
    const secret = askSecret(), remembered = !!localStorage.getItem(ASK_STORAGE[askSecretName()]);
    const where = remembered ? "remembered on this device" : "for this tab only";
    status.textContent = !secret ? (askState.mode === "site" ? "Enter the password to use the site's key." : "No key yet.")
      : askState.mode === "site" ? `Unlocked, ${where}.` : `Using the key ending ${secret.slice(-4)}, ${where}.`;
    status.classList.toggle("ok", !!secret);
  };
  const showMode = () => {
    document.getElementById("ask-password-field").hidden = askState.mode !== "site";
    document.getElementById("ask-key-field").hidden = askState.mode === "site";
    save.textContent = askState.mode === "site" ? "Unlock" : "Use this key";
    forget.textContent = askState.mode === "site" ? "Forget password" : "Forget key";
    document.querySelectorAll("[data-ask-mode]").forEach((button) => button.classList.toggle("active", button.dataset.askMode === askState.mode));
    remember.checked = !!localStorage.getItem(ASK_STORAGE[askSecretName()]);
    showStatus();
  };
  save.onclick = async () => {
    const input = askState.mode === "site" ? passwordInput : keyInput;
    const secret = input.value.trim();
    if (!secret) { status.textContent = askState.mode === "site" ? "Type the password first." : "Paste a key first."; return; }
    sessionStorage.setItem(ASK_STORAGE[askSecretName()], secret);
    if (remember.checked) localStorage.setItem(ASK_STORAGE[askSecretName()], secret); else localStorage.removeItem(ASK_STORAGE[askSecretName()]);
    input.value = "";
    showStatus();
    await loadAskModels();
  };
  forget.onclick = () => { sessionStorage.removeItem(ASK_STORAGE[askSecretName()]); localStorage.removeItem(ASK_STORAGE[askSecretName()]); showStatus(); };
  remember.onchange = () => {
    const secret = askSecret();
    if (secret && remember.checked) localStorage.setItem(ASK_STORAGE[askSecretName()], secret); else localStorage.removeItem(ASK_STORAGE[askSecretName()]);
    showStatus();
  };
  document.querySelectorAll("[data-ask-mode]").forEach((button) => {
    button.onclick = () => { askState.mode = button.dataset.askMode; localStorage.setItem(ASK_STORAGE.mode, askState.mode); showMode(); if (askSecret()) loadAskModels(); };
  });
  [keyInput, passwordInput].forEach((input) => input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); save.click(); } }));
  document.getElementById("ask-model").onchange = (event) => localStorage.setItem(ASK_STORAGE.model, event.target.value);
  fillAskModels(ASK_FALLBACK_MODELS);
  document.getElementById("ask-suggestions").innerHTML = ASK_SUGGESTIONS.map((question) => `<button type="button" class="mode" data-ask="${esc(question)}">${esc(question)}</button>`).join("");
  document.querySelectorAll("[data-ask]").forEach((button) => { button.onclick = () => askQuestion(button.dataset.ask); });
  const input = document.getElementById("ask-input");
  document.getElementById("ask-form").onsubmit = (event) => { event.preventDefault(); const question = input.value.trim(); if (question) { input.value = ""; askQuestion(question); } };
  input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); document.getElementById("ask-form").requestSubmit(); } });
  document.querySelector('.tabs a[data-tab="ask"]').addEventListener("click", renderAskContextPreview);
  window.addEventListener("hashchange", () => { if (location.hash === "#ask") renderAskContextPreview(); });

  // Is the site's key set up? A GET answers only that.
  const [site, prompt] = await Promise.all([
    fetch("/api/ask", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    import("./model/ask-prompt.js"),
  ]);
  askState.system = prompt.ASK_SYSTEM;
  askState.siteConfigured = Boolean(site?.configured);
  document.getElementById("ask-mode-row").hidden = !askState.siteConfigured;
  askState.mode = askState.siteConfigured && localStorage.getItem(ASK_STORAGE.mode) !== "own" ? "site" : "own";
  showMode();
  if (askSecret()) loadAskModels();
  const [primaries, earlyVoteModel] = await Promise.all([loadPrimaries(), import("./model/early-vote.js")]);
  if (primaries && snapshot.earlyVote?.counties) askState.primaries = earlyVoteModel.primaryLean(snapshot.earlyVote.counties, primaries);
  renderAskContextPreview();
}

/** The chat models available (the site key's, through the proxy, or the visitor's key's); also checks the credential. */
async function loadAskModels() {
  const status = document.getElementById("ask-key-status"), secret = askSecret();
  try {
    let models = [], preferred = null;
    if (askState.mode === "site") {
      const response = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: secret, action: "models" }) });
      if (!response.ok) {
        if (response.status === 401) { sessionStorage.removeItem(ASK_STORAGE.password); localStorage.removeItem(ASK_STORAGE.password); }
        throw new Error((await response.json().catch(() => null))?.error || `HTTP ${response.status}`);
      }
      ({ models, preferred } = await response.json());
    } else {
      const response = await fetch(`${ASK_ENDPOINT}/models`, { headers: { Authorization: `Bearer ${secret}` } });
      if (!response.ok) throw new Error(await askErrorText(response));
      const { data } = await response.json();
      models = (data || [])
        .filter((model) => /^(gpt-|o\d)/.test(model.id) && !/(audio|realtime|tts|transcribe|search|image|embedding|instruct|moderation|codex|computer-use|oss)/.test(model.id))
        .sort((a, b) => b.created - a.created).map((model) => model.id);
    }
    if (models.length) fillAskModels(models, preferred);
  } catch (error) {
    status.textContent = askState.mode === "site" ? `Could not unlock the site's key: ${error.message}` : `OpenAI did not accept the key: ${error.message}`;
    status.classList.remove("ok");
  }
}
function fillAskModels(ids, preferred = null) {
  const saved = localStorage.getItem(ASK_STORAGE.model);
  // Saved choice, then the server's suggestion, then the newest plain "gpt-N" / "gpt-N.N" model, then the first.
  const pick = ids.includes(saved) ? saved : ids.includes(preferred) ? preferred : ids.find((id) => /^gpt-\d+(\.\d+)?$/.test(id)) || ids[0];
  document.getElementById("ask-model").innerHTML = ids.map((id) => `<option value="${esc(id)}"${id === pick ? " selected" : ""}>${esc(id)}</option>`).join("");
}
async function askErrorText(response) {
  const body = await response.json().catch(() => null);
  const message = body?.error?.message || `HTTP ${response.status}`;
  if (response.status === 401) return `the key was rejected (${message})`;
  if (response.status === 429) return `rate limited or out of API credit (${message})`;
  return message;
}

/**
 * What the assistant sees: a compact digest of the page's current data. Rebuilt for every question.
 * Margins are D − R points; win chances are the Democrat's probability.
 */
function buildAskContext() {
  const s = SNAPSHOT;
  if (!s) return null;
  const central = (iso) => (iso ? `${new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} Central` : null);
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10), r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
  const ev = s.earlyVote, doc = needleState.doc, runs = needleState.runs;
  const context = {
    about: "Texas Polls Tracker (texas-race-tracker.vercel.app), a nonpartisan tracker of the 2026 Texas races. Margins are Democratic minus Republican in points of the total vote; win chances are the Democrat's probability.",
    now: central(new Date().toISOString()),
    morningSnapshotTaken: central(s.generatedAt),
    texasStatewide: s.texas.races.map((race) => ({
      office: race.office, democrat: race.democrat, republican: race.republican,
      pollingAverage: race.pollingAverage ? { margin: race.pollingAverage.margin, dem: race.pollingAverage.dem, rep: race.pollingAverage.rep, polls: race.pollingAverage.pollCount, newestPoll: race.pollingAverage.newest } : null,
      pollsModelDemWinChance: race.pollModel?.pD ?? null,
      forecasterConsensus: race.consensus?.label ?? null,
      recentPolls: (race.polls || []).slice(0, 6).map((p) => ({ pollster: p.pollster, ended: p.endDate, dem: p.dem, rep: p.rep, sample: p.sampleSize, population: p.population, partisan: p.partisan || undefined })),
    })),
    chamberControlDemChance: { usSenate: s.senateControl?.pollModel?.control?.D ?? null, usHouse: s.usHouse?.model?.control?.D ?? null, texasHouse: s.txHouse?.model?.control?.D ?? null, texasSenate: s.txSenate?.model?.control?.D ?? null },
    earlyVote: ev ? {
      reportedThrough: ev.reportDate, totals: ev.totals, paceAgainst2018SameDay: ev.pace2018,
      geographyTilt: Object.fromEntries(Object.entries(ev.geography?.byElection || {}).map(([year, g]) => [year, { ballotsComeFromCountiesThatVoted: g.lean, thoseCountiesFullVoteThatYear: g.reportingBaseline, tiltOf2026Ballots: g.shift }])),
      byCountyType: (ev.groups || []).map((g) => ({ type: g.group, counties: g.counties, ballots: g.ballots, shareOf2022Vote: g.shareOf2022Vote, inPersonVersusSameDay2018: g.versus2018?.change ?? null, margin2024: g.margin2024 })),
    } : null,
    march2026Primaries: askState.primaries ? {
      note: "County totals, not voters: Democratic share of each county's primary ballots, weighted by where early ballots were cast.",
      statewide: askState.primaries.statewide,
      byCountyType: askState.primaries.groups.map((g) => ({ type: g.group, primaryDemShare: g.primaryDemShare, earlyBallotsPerPrimaryVoter: g.ballotsPerPrimaryVoter })),
    } : null,
    electionNight: doc && runs ? {
      returnsAsOf: doc.latest ? central(doc.latest.fetchedAt) : "no returns read yet",
      secretaryOfStateStatus: doc.status ?? null,
      howItWorks: "Projection from county returns. Starts at the polls model plus half the early-vote turnout mix, then learns how far the state, each region, and Election Day votes run from expectations. Probabilities include a cushion for patterns it cannot see. Not a race call.",
      races: runs.map((run) => ({
        office: run.office, democrat: run.democrat, republican: run.republican,
        demWinChance: run.pD, projectedMargin: run.margin, range80: run.interval80,
        countedShareOfExpectedVote: run.countedShare, expectedVotes: run.expectedVotes, countedVotes: run.countedVotes, countedMargin: run.countedMargin,
        startingPoint: run.startingPoint,
        learned: { statewideVersusPolls: run.shared.statewide, electionDayMinusEarly: run.shared.electionDay, regionsVersusState: run.shared.regions, shareOf2022To2024ShiftReversing: run.shared.realignment },
      })),
      // About two dozen points per race through the night: [time, Democrat's chance, projected margin].
      needleHistory: Object.fromEntries(runs.map((run) => {
        const points = doc.timeline[run.id] || [], step = Math.max(1, Math.ceil(points.length / 24));
        return [run.office, points.filter((_, i) => i % step === 0 || i === points.length - 1).map((p) => [central(p.t), r3(p.p), r1(p.m)])];
      })),
      biggestMoves: doc.events.slice(-30).map((e) => ({ time: central(e.t), race: (runs.find((run) => run.id === e.race) || {}).office, demChanceFrom: e.p0, demChanceTo: e.p1, what: e.detail })),
      counties: askCountyTable(runs, doc),
    } : null,
    senateNight: senateState.doc ? askSenateDigest(senateState.doc, central) : null,
  };
  return context;
}
/** The Senate-night picture for the Ask tab: control, calls, and how each race stands now. */
function askSenateDigest(doc, central) {
  const run = senateRun(doc);
  const byState = new Map(run.races.map((race) => [race.state, race]));
  return {
    howItWorks: "Control of the U.S. Senate from race calls (network calls posted to Wikipedia, plus manual corrections), the live Texas needle, and each race's pre-election polls-model chance, with one polling miss shared by every state. Democrats need 51 seats; a 50-50 Senate goes to Republicans (the vice president breaks ties). Each race's chance is the Democrat's (or the independent's, where an independent is the Republican's main opponent) probability of winning the seat; margins are that candidate minus the Republican. Counts come from states' official results files where the site reads them; they're shown as counted and don't move the projection (count order differs by state), except Texas through its needle.",
    asOf: central(doc.checkedAt),
    democraticControlChance: run.pD, republicanControlChance: run.pR, noMajorityChance: run.pNone,
    expectedDemocraticCaucusSeats: run.expectedD, seatsNotUp: doc.inputs.notUp, called: run.called, uncalled: run.uncalled,
    nationalPollingMissRead: run.nationalSwing,
    races: doc.inputs.races.map((race) => {
      const count = senateCount(doc, race), bench = senateState.benchmarks?.[race.state];
      return {
        state: race.stateName, special: race.special || undefined, incumbentParty: race.incumbentParty, democratOrIndependent: `${race.challenger} (${race.challengerParty})`, republican: race.republican,
        chanceThisMorning: race.prior, chanceNow: byState.get(race.state)?.chance ?? null, calledFor: byState.get(race.state)?.call?.winner ?? null,
        pollingAverageMargin: race.pollMargin, projectedFinalMargin: byState.get(race.state)?.expectedMargin ?? null,
        count: count ? { estimatedShareCounted: Math.round(count.share * 1000) / 1000, votesCounted: count.votes, marginSoFar: count.margin, progress: count.detail } : `no live count: ${senateState.gaps?.[race.state]?.[1] ?? "no official results file read for this state"}`,
        lastRaceForSeat: bench?.seat ? { year: bench.seat.year, margin: bench.seat.margin } : undefined, president2024Margin: bench?.president2024?.margin,
        bigCountiesOnly: doc.countyReturns?.[race.state] ? { counties: doc.countyReturns[race.state].counties, votesCounted: doc.countyReturns[race.state].total, marginSoFar: doc.countyReturns[race.state].margin, sameCounties2024PresidentMargin: doc.countyReturns[race.state].president2024Margin, shareOfState2024Vote: doc.countyReturns[race.state].share2024 } : undefined,
      };
    }),
    calls: doc.events.slice(-35).map((e) => ({ time: central(e.t), what: e.detail })),
  };
}

function askCountyTable(runs, doc) {
  const senate = runs.find((run) => run.id === "tx-senate"), governor = runs.find((run) => run.id === "tx-governor");
  if (!senate || !governor) return null;
  const governorByKey = new Map(governor.counties.map((c) => [c.key, c])), inputsByKey = new Map(doc.inputs.counties.map((c) => [c.key, c]));
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    columns: ["county", "type", "earlyBallots", "expectedVotes", "countedVotes", "senateMarginSoFar", "governorMarginSoFar", "senateProjected", "governorProjected", "senate2018", "governor2022", "president2024"],
    rows: senate.counties.slice().sort((a, b) => b.expectedVotes - a.expectedVotes).map((c) => {
      const g = governorByKey.get(c.key), input = inputsByKey.get(c.key);
      return [c.name, needleState.countyGroupLabel ? needleState.countyGroupLabel(c.name) : c.region, input?.early ?? null, c.expectedVotes, c.countedVotes, r1(c.countedMargin), r1(g?.countedMargin), r1(c.projectedMargin), r1(g?.projectedMargin), input?.past?.["2018"] ?? null, input?.past?.["2022"] ?? null, input?.past?.["2024"] ?? null];
    }),
  };
}

function renderAskContextPreview() {
  const context = buildAskContext();
  if (!context) return;
  const text = JSON.stringify(context);
  document.getElementById("ask-context").textContent = JSON.stringify(context, null, 1);
  document.getElementById("ask-context-note").textContent = `About ${Math.round(text.length / 4000)} thousand tokens, sent with every question along with the last few exchanges.`;
  const night = context.electionNight;
  document.getElementById("ask-freshness").textContent = `Each question includes the morning snapshot (${context.morningSnapshotTaken}), the early vote, the March primaries, and ${night?.returnsAsOf && night.returnsAsOf !== "no returns read yet" ? `election-night returns as of ${night.returnsAsOf}` : "the election-night starting projections (no returns yet)"}.`;
}

/** Ask one question, streaming the answer into the log. */
async function askQuestion(question) {
  const log = document.getElementById("ask-log"), send = document.getElementById("ask-send");
  if (askState.busy) return;
  const item = document.createElement("li");
  item.innerHTML = `<p class="question">${esc(question)}</p><div class="answer pending">Thinking…</div><div class="meta"></div>`;
  log.appendChild(item);
  const answer = item.querySelector(".answer"), meta = item.querySelector(".meta");
  const secret = askSecret();
  if (!secret) { answer.className = "answer error"; answer.textContent = askState.mode === "site" ? "Enter the password above first." : "Add your OpenAI API key above first."; return; }
  askState.busy = true; send.disabled = true;
  try {
    // On election night, pull the newest returns first so the answer uses them.
    if (needleWindowOpen() && !needleState.demo) await refreshNeedle().catch(() => {});
    const context = buildAskContext();
    renderAskContextPreview();
    const model = document.getElementById("ask-model").value;
    let text = "";
    const onDelta = (delta) => { text += delta; answer.className = "answer"; answer.innerHTML = askMarkdown(text); };
    if (askState.mode === "site") {
      // The proxy adds the instructions and the key; it streams back plain text.
      const response = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: secret, model, question, context, history: askState.history.slice(-6) }) });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `HTTP ${response.status}`);
      await readPlainStream(response, onDelta);
    } else {
      const messages = [{ role: "system", content: askState.system }, { role: "system", content: `DATA ${JSON.stringify(context)}` }, ...askState.history.slice(-6), { role: "user", content: question }];
      const response = await fetch(`${ASK_ENDPOINT}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages, stream: true }) });
      if (!response.ok) throw new Error(await askErrorText(response));
      await readAskStream(response, onDelta);
    }
    if (!text.trim()) throw new Error("the model returned an empty answer");
    askState.history.push({ role: "user", content: question }, { role: "assistant", content: text });
    const returnsAsOf = context.electionNight?.returnsAsOf;
    meta.textContent = `${model}; data: morning snapshot ${context.morningSnapshotTaken}${returnsAsOf && returnsAsOf !== "no returns read yet" ? `, returns as of ${returnsAsOf}` : ", no returns yet"}`;
  } catch (error) {
    answer.className = "answer error";
    answer.textContent = `No answer: ${error.message}`;
  } finally {
    askState.busy = false; send.disabled = false;
    item.scrollIntoView({ block: "nearest" });
  }
}

/** The proxy's plain-text stream. */
async function readPlainStream(response, onDelta) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    const text = decoder.decode(value, { stream: true });
    if (text) onDelta(text);
  }
}

/** Server-sent events from the chat completions stream: "data: {json}" lines, ending with "data: [DONE]". */
async function readAskStream(response, onDelta) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep a partial line for the next chunk
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try { const delta = JSON.parse(data).choices?.[0]?.delta?.content; if (delta) onDelta(delta); } catch { /* not JSON; skip */ }
    }
  }
}

/** Minimal, safe Markdown: everything is escaped first, then paragraphs, bullet and numbered lists, bold, code. */
function askMarkdown(text) {
  const inline = (line) => line.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/^#{1,4}\s+(.*)$/, "<b>$1</b>");
  const html = [];
  let list = null, paragraph = [];
  const flushParagraph = () => { if (paragraph.length) { html.push(`<p>${paragraph.map(inline).join("<br>")}</p>`); paragraph = []; } };
  const flushList = () => { if (list) { html.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`); list = null; } };
  for (const line of esc(text).split("\n")) {
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/), numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      (list ||= { tag, items: [] }).items.push((bullet || numbered)[1]);
    } else if (!line.trim()) { flushParagraph(); flushList(); }
    else { flushList(); paragraph.push(line); }
  }
  flushParagraph(); flushList();
  return html.join("");
}

// ---------- senate night: control as races are called ----------
// The document comes from the AWS Senate recorder (aws/senate/index.mjs, senate.json beside needle.json). Until it
// exists, and whenever it goes quiet on election night, the browser builds the same document itself: Wikipedia's
// calls through its API, the manual overrides in data/senate-calls.json, and the live Texas needle already on the page.
const SENATE_NIGHT_URL = "https://election-tracker-needle-needlebucket-92bzmtfdaxc0.s3.us-east-1.amazonaws.com/senate.json";
const SENATE_NIGHT_TIMING = {
  windowOpens: Date.parse("2026-11-03T22:00:00Z"), // first Senate polls close, 6 p.m. Eastern
  windowCloses: Date.parse("2026-11-05T18:00:00Z"),
  freshAfter: Date.parse("2026-11-03T21:00:00Z"), // recorder files from earlier are test runs
  // Just before 6 p.m. Central, when most of the East's polls close; the afternoon before it is empty.
  chartStart: Date.parse("2026-11-03T23:45:00Z"), // 5:45 p.m. Central
  chartMinimumEnd: Date.parse("2026-11-04T07:00:00Z"), // 1 a.m. Central
  staleMs: 6 * 60_000, pollMs: 60_000, ownCheckMs: 3 * 60_000,
};
const SENATE_WIKIPEDIA_API = `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&origin=*&titles=${encodeURIComponent("2026 United States Senate elections")}`;
const senateState = { model: null, snapshot: null, doc: null, source: null, lastOwnCheck: 0, error: null, refreshing: false, benchmarks: null, open: new Set() };
function senateWindowOpen(now = Date.now()) { return now >= SENATE_NIGHT_TIMING.windowOpens && now <= SENATE_NIGHT_TIMING.windowCloses; }

async function setupSenateNight(snapshot) {
  senateState.model = await import("./model/senate-night.js");
  senateState.returnsModel = await import("./model/senate-returns.js");
  ({ SENATE_RETURN_SOURCES: senateState.feeds, SENATE_RETURN_GAPS: senateState.gaps } = senateState.returnsModel);
  senateState.snapshot = snapshot;
  senateState.benchmarks = (await fetchJson("data/senate-benchmarks.json").catch(() => null))?.states ?? null;
  // A race row opens its detail (votes so far, and why its chance moved); the map's states open theirs too.
  document.getElementById("senate-night-table").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-state]");
    if (row && !event.target.closest("a")) toggleSenateRace(row.dataset.state);
  });
  document.getElementById("senate-night-table").addEventListener("keydown", (event) => {
    const row = event.target.closest("tr[data-state]");
    if (row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); toggleSenateRace(row.dataset.state); }
  });
  senateState.doc = senateState.model.createSenateNightDocument(snapshot);
  senateState.source = "browser";
  renderSenateNight();
  await refreshSenateNight();
  setInterval(() => { if (senateWindowOpen()) refreshSenateNight().catch((error) => console.error("senate night", error)); }, SENATE_NIGHT_TIMING.pollMs);
  window.addEventListener("resize", debounce(() => { if (senateState.doc) renderSenateNightChart(senateState.doc); }, 150));
}

/** Take the recorder's file when it is from tonight and fresher; read the calls directly if it has gone quiet. */
async function refreshSenateNight() {
  if (senateState.refreshing) return;
  senateState.refreshing = true;
  try {
    const recorded = await fetch(SENATE_NIGHT_URL, { cache: "no-cache", signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const now = Date.now();
    const fromTonight = recorded?.kind === "senate-night" && Date.parse(recorded.createdAt) >= SENATE_NIGHT_TIMING.freshAfter;
    const alive = fromTonight && now - Date.parse(recorded.checkedAt) < SENATE_NIGHT_TIMING.staleMs;
    if (fromTonight && (alive || Date.parse(recorded.updatedAt) >= Date.parse(senateState.doc.updatedAt))) { senateState.doc = recorded; senateState.source = "recorder"; }
    if (senateWindowOpen(now) && !alive && now - senateState.lastOwnCheck >= SENATE_NIGHT_TIMING.ownCheckMs && document.visibilityState === "visible") {
      senateState.lastOwnCheck = now;
      try { await senateOwnCheck(); senateState.error = null; } catch (error) { senateState.error = error.message; }
    }
    renderSenateNight();
  } finally {
    senateState.refreshing = false;
  }
}

async function senateOwnCheck() {
  const { model, doc } = senateState;
  const codeByStateName = Object.fromEntries(doc.inputs.races.map((race) => [race.stateName, race.state]));
  const content = (await (await fetch(SENATE_WIKIPEDIA_API, { cache: "no-store" })).json()).query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content;
  if (!content) throw new Error("Wikipedia returned no page");
  const overrides = await fetchJson("data/senate-calls.json").catch(() => ({}));
  const { wikipediaReturns, wikipediaReturnsUrl, wikipediaPageCalls, mergeReturns } = senateState.returnsModel;
  const pages = await fetch(wikipediaReturnsUrl(doc.inputs.races, { browser: true }), { cache: "no-store" }).then((r) => r.json()).catch(() => null);
  const unofficial = pages ? wikipediaReturns(doc.inputs.races, pages, new Date().toISOString()) : {};
  const pageCalls = pages ? wikipediaPageCalls(doc.inputs.races, pages) : {};
  const texasRun = needleState.runs?.find((run) => run.id === "tx-senate");
  const texas = texasRun?.countedVotes ? { pD: texasRun.pD, margin: texasRun.margin, statewide: texasRun.shared.statewide, counted: texasRun.countedShare, countedVotes: texasRun.countedVotes, countedMargin: texasRun.countedMargin, expectedVotes: texasRun.expectedVotes, returnsAt: needleState.doc?.checkedAt ?? null } : null;
  model.advanceSenateNight(doc, { calls: model.mergeCalls(model.fixCallParties({ ...pageCalls, ...model.parseSenateCalls(content, codeByStateName) }, doc.inputs.races), overrides), texas, returns: mergeReturns(doc.returns ?? {}, unofficial), fetchedAt: new Date().toISOString() });
  senateState.source = "browser";
}

function senateRun(doc) {
  return doc.latest?.run ?? senateState.model.runSenateNight({ races: doc.inputs.races, calls: doc.latest?.calls ?? {}, texas: doc.latest?.texas ?? null, notUp: doc.inputs.notUp });
}

function renderSenateNight() {
  const { doc } = senateState;
  const run = senateRun(doc);
  const start = doc.timeline[0]?.p ?? run.pD;
  const calledCount = run.called.D + run.called.R + run.called.I;
  const status = document.getElementById("senate-night-status");
  status.className = `needle-status${calledCount ? " live" : ""}`;
  status.innerHTML = !calledCount && Date.now() < SENATE_NIGHT_TIMING.windowOpens
    ? "<b>The first Senate polls close at 6 p.m. Eastern (5 p.m. Central).</b><span>Until races are called, this is the polls model, with one polling miss shared by every state.</span>"
    : `<b>${calledCount ? '<span class="live-dot" aria-hidden="true"></span>' : ""}${calledCount} of 35 races called as of ${needleTime(doc.checkedAt)} Central.</b><span>Calls are the networks' calls as posted to Wikipedia, ${senateState.source === "browser" ? "read directly by your browser" : "checked every two minutes"}. Texas uses the live Texas needle. Nothing here is a call of its own.</span>${senateState.error ? ` <span>Last direct check failed (${esc(senateState.error)}).</span>` : ""}`;

  const swing = run.nationalSwing;
  const swingWords = calledCount && Math.abs(swing.mean) >= 1 && Math.abs(swing.mean) > swing.sd / 2
    ? `Calls so far suggest ${swing.mean > 0 ? "Democrats" : "Republicans"} are beating their polls by about ${Math.abs(swing.mean).toFixed(0)} points nationally.`
    : calledCount ? "Calls so far are about what the polls expected." : "No calls yet, so no read on a national polling miss.";
  const site = senateState.snapshot.senateControl?.pollModel?.control?.D;
  // Control decided by calls alone: 51 seats for the Democratic caucus, or 50 for Republicans with the vice president.
  const seatsD = doc.inputs.notUp.democraticCaucus + run.called.D, seatsR = doc.inputs.notUp.republican + run.called.R;
  const decided = seatsD >= 51 ? "D" : seatsR >= 50 ? "R" : null;
  const headline = decided
    ? `<div class="needle-race results-race control-result">
        <p class="call-line big">${checkBadgeIcon(senateCalledFill(decided), { inverse: true })}<b>${decided === "D" ? "Democrats win control of the Senate" : "Republicans keep control of the Senate"}</b></p>
        <p class="seat-line"><b class="lean-d">${seatsD}</b> Democratic caucus <span class="muted">·</span> <b class="lean-r">${seatsR}</b> Republican <span class="muted">·</span> ${run.uncalled} not called</p>
        <p class="thin">${decided === "D" ? `${doc.inputs.notUp.democraticCaucus} not up plus ${run.called.D} won tonight` : `${doc.inputs.notUp.republican} not up plus ${run.called.R} won tonight, with the vice president's tie-breaking vote`}, from the networks' calls.</p>
      </div>`
    : `<div class="needle-race">
      <div class="needle-gauge">${needleGaugeSvg(run.pD, start, { large: true, dem: "Democrats", rep: "Republicans" })}</div>
      <div class="needle-odds"><div class="side${run.pD >= 0.5 ? "" : " trails"}"><b>${needleChance(run.pD)}</b>Democrats</div><div class="side right${run.pD >= 0.5 ? " trails" : ""}"><b>${needleChance(run.pR)}</b>Republicans</div></div>
    </div>`;
  document.getElementById("senate-night-board").innerHTML = `${headline}
    <ul class="facts">
      <li>Expected Democratic-caucus seats <b>${run.expectedD.toFixed(1)}</b>; Democrats need 51, and a 50–50 Senate goes to Republicans (Vice President Vance breaks ties).</li>
      <li>${esc(swingWords)}</li>
      ${run.pNone >= 0.005 ? `<li>Chance no party reaches a majority, with independents holding the balance: <b>${needleChance(run.pNone)}</b>.</li>` : ""}
      <li>This morning: Democrats <b>${needleChance(start)}</b>, with the polling miss shared across states. The U.S. Senate tab, which treats races as independent, says ${needleChance(site ?? 0)}.</li>
    </ul>`;

  renderSenateFloor(doc, run);
  renderSenateNightMap(doc, run);
  renderSenateSeatDistribution(doc, run);
  renderSenateNightChart(doc);
  renderSenateNightEvents(doc);
  renderSenateNightTable(doc, run);
}

/** Democrats' control chance through the night, a step line with the calls marked. */
function renderSenateNightChart(doc) {
  const box = document.getElementById("senate-night-chart");
  box.innerHTML = "";
  const narrow = window.innerWidth < 600, width = narrow ? 520 : 1000;
  const margin = { top: 30, right: narrow ? 44 : 96, bottom: 26, left: 44 }, plotHeight = narrow ? 210 : 250;
  const top = margin.top, bottom = top + plotHeight, height = bottom + margin.bottom;
  const series = doc.timeline.map((point) => ({ ...point, time: Math.max(Date.parse(point.t), SENATE_NIGHT_TIMING.chartStart) }));
  const lastTime = series.length ? series[series.length - 1].time : SENATE_NIGHT_TIMING.chartStart;
  const holdUntil = senateWindowOpen() ? Math.max(lastTime, Date.now()) : lastTime;
  const end = Math.max(SENATE_NIGHT_TIMING.chartMinimumEnd, holdUntil + 20 * 60_000);
  const drawn = series.length ? [...series, { ...series[series.length - 1], time: holdUntil }] : [];
  const x = d3.scaleLinear().domain([SENATE_NIGHT_TIMING.chartStart, end]).range([margin.left, width - margin.right]);
  const y = d3.scaleLinear().domain([0, 1]).range([bottom, top]);
  const svg = d3.select(box).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", "Democrats' chance of Senate control through election night");
  const hourTicks = d3.range(Math.ceil(SENATE_NIGHT_TIMING.chartStart / 3_600_000) * 3_600_000, end + 1, 3_600_000).filter((t, i) => !narrow || i % 2 === 0);
  svg.append("g").attr("class", "grid").selectAll("line").data([0.25, 0.75, 1]).join("line").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", (v) => y(v)).attr("y2", (v) => y(v));
  svg.append("line").attr("class", "even-line").attr("stroke-dasharray", "3 3").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", y(0.5)).attr("y2", y(0.5));
  for (const [time, label] of [[Date.parse("2026-11-04T00:00:00Z"), "Most of the East closes"], [NEEDLE_TIMING.pollsClose, narrow ? "" : "Texas closes"]]) {
    svg.append("line").attr("class", "close-rule").attr("x1", x(time)).attr("x2", x(time)).attr("y1", top - 6).attr("y2", bottom);
    if (label) svg.append("text").attr("class", "close-label").attr("x", x(time) + 4).attr("y", top - 10).text(label);
  }
  svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).tickValues([0, 0.5, 1]).tickFormat((v) => `${Math.round(v * 100)}%`).tickSize(0).tickPadding(9)).select(".domain").remove();
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${bottom})`).call(d3.axisBottom(x).tickValues(hourTicks).tickFormat((t) => needleHour.format(new Date(t)).replace(/\s+/g, " ").toLowerCase()).tickSize(0)).select(".domain").remove();
  svg.append("path").datum(drawn).attr("fill", "none").attr("stroke", cssVar("--d3")).attr("stroke-width", 2).attr("d", d3.line().curve(d3.curveStepAfter).x((p) => x(p.time)).y((p) => y(p.p)));
  if (drawn.length) {
    const last = drawn[drawn.length - 1];
    const endLabel = svg.append("text").attr("class", "event-label").text(`Democrats ${needleChance(last.p)}`);
    if (narrow) endLabel.attr("x", x(last.time)).attr("y", y(last.p) + (last.p > 0.85 ? 18 : -8)).attr("text-anchor", "end");
    else endLabel.attr("x", x(last.time) + 6).attr("y", y(last.p) + 4);
  }
  const events = senateNightEventsFor(doc).filter((event) => event.n);
  // Calls made in the same check share a point on the line; stack their markers upward from it.
  const sameCheck = new Map();
  const markers = events.map((event) => {
    const stack = sameCheck.get(event.t) ?? 0;
    sameCheck.set(event.t, stack + 1);
    return { event, x: x(Math.max(Date.parse(event.t), SENATE_NIGHT_TIMING.chartStart)), y: y(event.p1) - stack * 21 };
  });
  for (const { event, x: ex, y: ey } of markers) {
    const marker = svg.append("g").attr("class", "event-marker").attr("transform", `translate(${ex},${ey})`).attr("tabindex", 0).attr("role", "img").attr("aria-label", `${event.n}: ${event.headline}`);
    marker.append("circle").attr("r", 9);
    marker.append("text").attr("text-anchor", "middle").attr("dy", "0.35em").text(event.n);
    const tip = (e) => showTooltip(e, `<b>${event.n}. ${needleTime(event.t)}</b><div>${esc(event.headline)}</div><hr><div>${esc(event.detail)}</div>`);
    marker.on("mousemove", tip).on("mouseleave", hideTooltip);
  }
  const linePoints = [];
  for (let i = 0; i + 1 < drawn.length; i += 1) {
    const x0 = x(drawn[i].time), x1 = x(drawn[i + 1].time), y0 = y(drawn[i].p), y1 = y(drawn[i + 1].p);
    for (let px = x0; px < x1; px += 5) linePoints.push({ x: px, y: y0 });
    for (let py = Math.min(y0, y1); py <= Math.max(y0, y1); py += 5) linePoints.push({ x: x1, y: py });
  }
  placeNeedleLabels(svg, markers, linePoints, { count: narrow ? 2 : 3, left: margin.left, right: width - margin.right, top, bottom });
}

/**
 * Calls and big moves in time order. Every upset and the calls that moved control most (2 points or more, up to
 * twelve) are charted and numbered; safe seats called as expected are listed only.
 */
function senateNightEventsFor(doc, { charted = 12 } = {}) {
  const events = doc.events.slice().sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const worthCharting = events.filter((e) => e.kind === "upset" || Math.abs(e.p1 - e.p0) >= 0.02);
  const shown = new Set(worthCharting.sort((a, b) => (b.kind === "upset") - (a.kind === "upset") || Math.abs(b.p1 - b.p0) - Math.abs(a.p1 - a.p0)).slice(0, charted));
  let n = 0;
  return events.map((event) => ({ ...event, n: shown.has(event) ? (n += 1) : null }));
}

function renderSenateNightEvents(doc) {
  const list = document.getElementById("senate-night-events");
  const events = senateNightEventsFor(doc);
  if (!events.length) { list.innerHTML = '<li class="empty">No calls yet. Each call shows here with how it moved the control chance.</li>'; return; }
  list.innerHTML = events.slice().reverse().map((event) => `<li>${event.n ? `<span class="n">${event.n}</span>` : "<span></span>"}<span class="when">${needleTime(event.t)}</span><span class="move ${event.p1 >= event.p0 ? "lean-d" : "lean-r"}">${needleChance(event.p0)} → ${needleChance(event.p1)}</span><span class="text">${esc(event.detail)}${flipTag(doc.inputs.races.find((race) => race.state === event.state), event.kind === "uncall" ? null : { winner: event.winner })}</span></li>`).join("");
}

const senateVotes = d3.format(",");

/** A challenger margin as text in its side's color: "D+3.1" (or "I+2.0") when ahead, "R+1.4" when behind. */
function challengerMargin(margin, party) {
  if (margin == null) return '<span class="muted">—</span>';
  if (Math.abs(margin) < 0.05) return "Even";
  return `<span class="${margin > 0 ? (party === "I" ? "lean-i" : "lean-d") : "lean-r"}">${margin > 0 ? party : "R"}+${Math.abs(margin).toFixed(1)}</span>`;
}

function senateWinnerName(race, call) {
  return call.name || (call.winner === "R" ? race.republican : call.winner === "D" ? race.democrat : call.winner === "I" ? race.independent : null);
}

/**
 * How far along a state's count is. Texas: the Texas needle's own estimate. Elsewhere: votes against a turnout
 * baseline (2022's statewide vote plus a tenth), finished only when every precinct is in. Null with no state file.
 */
function senateCount(doc, race) {
  if (race.state === "TX") {
    const texas = doc.latest?.texas;
    return texas?.countedVotes
      ? { share: texas.counted, votes: texas.countedVotes, margin: texas.countedMargin, detail: "of the expected vote" }
      : { share: 0, votes: 0, margin: null, detail: "not yet" };
  }
  const returns = doc.returns?.[race.state];
  if (!returns) return senateState.feeds?.[race.state] ? { share: 0, votes: 0, margin: null, detail: "not yet" } : null;
  const baseline = senateState.benchmarks?.[race.state]?.midterm2022?.totalVotes;
  // A county can report before it has votes, so only a full precinct count marks a state finished.
  const units = returns.units?.total ? returns.units : null;
  const share = !returns.total ? 0 : units?.kind === "percent" ? Math.min(1, units.reporting / 100)
    : units?.kind === "precincts" && units.reporting >= units.total ? 1
    : baseline ? Math.min(0.99, returns.total / (baseline * 1.1)) : units ? units.reporting / units.total : 0;
  const detail = !returns.total ? "not yet"
    : returns.unofficial ? `unofficial, Wikipedia${returns.lastUpdate ? ` ${returns.lastUpdate}` : ""}`
    : units ? `${senateVotes(units.reporting)} of ${senateVotes(units.total)} ${units.kind}` : `${senateVotes(returns.total)} votes`;
  return { share, votes: returns.total, margin: returns.margin, detail: `${detail}${returns.stale ? " (last good read)" : ""}` };
}

function senateNightTooltip(doc, race, now) {
  const count = senateCount(doc, race);
  const rows = [`<b>${esc(race.stateName)}${race.special ? " (special)" : ""}</b>`, `<div>${esc(race.challenger || "—")} (${race.challengerParty}) v. ${esc(race.republican || "—")} (R)</div>`, "<hr>"];
  rows.push(now.call
    ? `<div class="row"><span>Called</span><span><b>${esc(senateWinnerName(race, now.call) || now.call.winner)} (${now.call.winner})</b></span></div>${senateFlip(race, now.call) ? `<div class="row"><span>Flip</span><span>${SENATE_PARTY_WORD[now.call.winner]} gain from the ${SENATE_PARTY_WORD[race.incumbentParty]}s</span></div>` : ""}`
    : `<div class="row"><span>${esc(lastName(race.challenger) || "Challenger")}'s chance</span><span><b>${needleChance(now.chance)}</b> (${needleChance(race.prior)} this morning)</span></div>`);
  if (count?.votes) rows.push(`<div class="row"><span>Counted</span><span>${pct(count.share)}, ${challengerMargin(count.margin, race.challengerParty)} so far</span></div>`);
  else if (!count) rows.push(`<div class="row"><span>Count</span><span>no live count (${esc(senateState.gaps?.[race.state]?.[0] ?? "no file")}); moves on calls</span></div>`);
  rows.push(`<div class="row"><span>Projected</span><span>${challengerMargin(now.expectedMargin, race.challengerParty)}</span></div>`);
  return rows.join("");
}

function openSenateRace(state, { scroll = false } = {}) {
  senateState.open.add(state);
  renderSenateNightTable(senateState.doc, senateRun(senateState.doc));
  if (scroll) document.querySelector(`#senate-night-table tr[data-state="${state}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
}
function toggleSenateRace(state) {
  if (senateState.open.has(state)) senateState.open.delete(state); else senateState.open.add(state);
  renderSenateNightTable(senateState.doc, senateRun(senateState.doc));
  document.querySelector(`#senate-night-table tr[data-state="${state}"]`)?.focus({ preventScroll: true });
}

/** Shading for a race still out: blue to red on the Democrat's chance, gray to red on an independent's. */
function senateOutFill(now) {
  if (now.challengerParty === "I") return d3.scaleLinear().domain([0, 0.5, 1]).range([cssVar("--r3"), "#e9e9e6", cssVar("--toss")])(now.chance);
  return probabilityScale()(now.chance);
}
const senateCalledFill = (winner) => cssVar(winner === "D" ? "--d3" : winner === "R" ? "--r3" : "--toss");

/** The party a called race hands the seat to when that isn't the party holding it now; null for a hold. */
function senateFlip(race, call) {
  return call?.winner && race?.incumbentParty && call.winner !== race.incumbentParty ? call.winner : null;
}
const SENATE_PARTY_WORD = { D: "Democratic", R: "Republican", I: "independent", other: "third-party" };
const flipTag = (race, call) => (senateFlip(race, call) ? `<span class="flip-tag" title="${esc(`${SENATE_PARTY_WORD[call.winner]} gain from the ${SENATE_PARTY_WORD[race.incumbentParty]}s`)}">flip</span>` : "");

/**
 * A called race carries a check mark, so "called" never depends on telling two blues apart: a white disc with the
 * winner's check on the map, and a solid seat with a white check on the floor (`inverse`).
 */
const checkPath = (r) => `M${-0.45 * r} ${0.03 * r} L${-0.12 * r} ${0.36 * r} L${0.47 * r} ${-0.33 * r}`;
function checkBadgeIcon(color, { inverse = false } = {}) {
  return `<svg class="badge-icon" width="14" height="14" viewBox="-10 -10 20 20" aria-hidden="true"><circle r="${inverse ? 9.6 : 8.6}" fill="${inverse ? color : "#fff"}"${inverse ? "" : ` stroke="${color}" stroke-width="2.4"`}/><path d="${checkPath(10)}" fill="none" stroke="${inverse ? "#fff" : color}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function seatIcon(color, { out = false, flip = false } = {}) {
  const stroke = out ? ` fill-opacity="0.75" stroke="${d3.color(color).darker(0.6)}" stroke-width="2"` : flip ? ` stroke="${cssVar("--ink")}" stroke-width="3"` : "";
  return `<svg class="badge-icon" width="14" height="14" viewBox="-10 -10 20 20" aria-hidden="true"><circle r="${out || flip ? 8.4 : 9.6}" fill="${color}"${stroke}/></svg>`;
}

/**
 * The Senate floor: 100 seats in five rows, the Democratic caucus filling from the left and Republicans from the
 * right. Seats not up are the darkest, seats won tonight solid, and races still out shaded by the chance now,
 * most Democratic first, so the 51st seat from the left shows which way control leans.
 */
function renderSenateFloor(doc, run) {
  const box = document.getElementById("senate-night-seats");
  const inputs = new Map(doc.inputs.races.map((race) => [race.state, race]));
  const { democraticCaucus, republican } = doc.inputs.notUp;
  const seats = [];
  for (let i = 0; i < democraticCaucus; i += 1) seats.push({ fill: cssVar("--d4"), tip: `<b>Democratic caucus</b><div>${democraticCaucus} seats not up this year</div>` });
  const won = (party) => run.races.filter((race) => race.call && (party === "I" ? !["D", "R"].includes(race.call.winner) : race.call.winner === party));
  const seatFor = (now, fill) => ({ fill, state: now.state, won: Boolean(now.call), flip: Boolean(senateFlip(inputs.get(now.state), now.call)), tip: senateNightTooltip(doc, inputs.get(now.state), now) });
  for (const now of won("D")) seats.push(seatFor(now, senateCalledFill("D")));
  const out = run.races.filter((race) => !race.call).sort((a, b) => (b.challengerParty === "I" ? b.chance - 1 : 2 * b.chance - 1) - (a.challengerParty === "I" ? a.chance - 1 : 2 * a.chance - 1));
  for (const now of out) seats.push({ ...seatFor(now, senateOutFill(now)), out: true });
  for (const now of won("I")) seats.push(seatFor(now, senateCalledFill("I")));
  for (const now of won("R")) seats.push(seatFor(now, senateCalledFill("R")));
  for (let i = 0; i < republican; i += 1) seats.push({ fill: cssVar("--r4"), tip: `<b>Republicans</b><div>${republican} seats not up this year</div>` });

  const width = 560, height = 316, cx = width / 2, cy = 290, outer = 252, inner = 102, rows = 5, seatRadius = 11;
  const radii = d3.range(rows).map((k) => inner + (k * (outer - inner)) / (rows - 1));
  const counts = radii.map((r) => Math.round((seats.length * r) / d3.sum(radii)));
  counts[rows - 1] += seats.length - d3.sum(counts);
  const spots = radii.flatMap((r, k) => d3.range(counts[k]).map((j) => ({ r, angle: Math.PI * (1 - j / (counts[k] - 1)) })))
    .sort((a, b) => b.angle - a.angle || b.r - a.r);
  const at = (r, angle) => [cx + r * Math.cos(angle), cy - r * Math.sin(angle)];
  box.innerHTML = "";
  const svg = d3.select(box).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img")
    .attr("aria-label", `Senate floor: ${democraticCaucus + won("D").length} Democratic-caucus seats decided, ${won("R").length + republican} Republican, ${out.length} races out`);
  svg.append("g").selectAll("circle").data(seats.map((seat, i) => ({ ...seat, spot: spots[i] }))).join("circle")
    .attr("cx", (d) => at(d.spot.r, d.spot.angle)[0]).attr("cy", (d) => at(d.spot.r, d.spot.angle)[1]).attr("r", seatRadius)
    .attr("fill", (d) => d.fill).attr("stroke", (d) => (d.out ? d3.color(d.fill).darker(0.6) : null)).attr("class", (d) => `seat${d.out ? " out" : ""}${d.flip ? " flip" : ""}${d.state ? " race" : ""}`)
    .on("mousemove", (event, d) => showTooltip(event, d.tip)).on("mouseleave", hideTooltip)
    .on("click", (event, d) => { if (d.state) openSenateRace(d.state, { scroll: true }); });
  svg.append("g").attr("class", "seat-checks").selectAll("path").data(seats.map((seat, i) => ({ ...seat, spot: spots[i] })).filter((d) => d.won)).join("path")
    .attr("transform", (d) => `translate(${at(d.spot.r, d.spot.angle)})`).attr("d", checkPath(seatRadius));
  // The majority line runs between the 50th and 51st seats from the left.
  const line = (spots[49].angle + spots[50].angle) / 2;
  const [x1, y1] = at(inner - 20, line), [x2, y2] = at(outer + 16, line);
  svg.append("line").attr("class", "majority-line").attr("x1", x1).attr("y1", y1).attr("x2", x2).attr("y2", y2);
  const [lx, ly] = at(outer + 24, line);
  svg.append("text").attr("class", "majority-label").attr("x", lx).attr("y", ly).attr("text-anchor", "middle").text("51");
  const decidedD = democraticCaucus + won("D").length, decidedR = republican + won("R").length;
  svg.append("text").attr("class", "floor-count").attr("x", cx).attr("y", cy - 26).attr("text-anchor", "middle")
    .html(`<tspan class="d">${decidedD}</tspan><tspan dx="6">–</tspan><tspan dx="6" class="r">${decidedR}</tspan>`);
  // Net change in seats from tonight's flips, for the Democratic caucus.
  const flips = run.races.filter((now) => senateFlip(inputs.get(now.state), now.call));
  const netD = flips.filter((now) => now.call.winner === "D").length - flips.filter((now) => inputs.get(now.state).incumbentParty === "D").length;
  const net = !flips.length ? "" : ` · ${netD > 0 ? `Democrats +${netD}` : netD < 0 ? `Republicans +${-netD}` : "flips even"}`;
  svg.append("text").attr("class", "floor-sub").attr("x", cx).attr("y", cy - 4).attr("text-anchor", "middle").text(`decided · ${out.length} out${won("I").length ? ` · ${won("I").length} independent` : ""}${net}`);
  document.getElementById("senate-night-seats-legend").innerHTML = `<span>${seatIcon(cssVar("--d4"))}${checkBadgeIcon(cssVar("--d3"), { inverse: true })}Democratic caucus: not up, won tonight</span><span>${seatIcon(cssVar("--d2"), { out: true })}${seatIcon("#e9e9e6", { out: true })}${seatIcon(cssVar("--r2"), { out: true })}Still out, shaded by the chance now</span><span>${checkBadgeIcon(cssVar("--r3"), { inverse: true })}${seatIcon(cssVar("--r4"))}Republicans: won tonight, not up</span><span>${seatIcon(cssVar("--d3"), { flip: true })}${seatIcon(cssVar("--r3"), { flip: true })}Flipped seat</span>`;
}

/**
 * The chance of each Democratic-caucus seat total now, over this morning's as an outline; 51 or more is control.
 * Recorder files from before the model carried the distribution are recomputed here with the same model.
 */
function renderSenateSeatDistribution(doc, run) {
  const box = document.getElementById("senate-night-dist");
  if (!box) return;
  const { model } = senateState;
  const histogram = run.seatHistogram ?? model.runSenateNight({ races: doc.inputs.races, calls: doc.latest?.calls ?? {}, texas: doc.latest?.texas ?? null, notUp: doc.inputs.notUp }).seatHistogram;
  if (senateState.morningSeats?.createdAt !== doc.createdAt) {
    const morning = model.runSenateNight({ races: doc.inputs.races, calls: {}, texas: null, notUp: doc.inputs.notUp });
    senateState.morningSeats = { createdAt: doc.createdAt, histogram: morning.seatHistogram, expected: morning.expectedD };
  }
  const now = new Map(histogram.map((h) => [h.d, h.probability])), before = new Map(senateState.morningSeats.histogram.map((h) => [h.d, h.probability]));
  const shown = [...now.keys(), ...before.keys()].filter((d) => (now.get(d) ?? 0) >= 0.002 || (before.get(d) ?? 0) >= 0.002);
  if (!shown.length) return;
  const seats = d3.range(Math.min(...shown), Math.max(...shown) + 1);
  const width = 760, height = 200, margin = { top: 16, right: 12, bottom: 30, left: 40 };
  const x = d3.scaleBand().domain(seats.map(String)).range([margin.left, width - margin.right]).paddingInner(0.18);
  const y = d3.scaleLinear().domain([0, Math.max(0.05, d3.max(seats, (d) => Math.max(now.get(d) ?? 0, before.get(d) ?? 0)) * 1.15)]).range([height - margin.bottom, margin.top]);
  const svg = d3.select(box).html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img")
    .attr("aria-label", `Chance of each Democratic-caucus seat total: ${run.expectedD} expected now, ${senateState.morningSeats.expected} this morning`);
  svg.append("g").attr("class", "grid").selectAll("line").data(y.ticks(3)).join("line").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", (v) => y(v)).attr("y2", (v) => y(v));
  const every = Math.max(1, Math.ceil(seats.length / 16));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${height - margin.bottom})`).call(d3.axisBottom(x).tickSize(0).tickValues(x.domain().filter((_, i) => i % every === 0))).select(".domain").remove();
  svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(3).tickFormat((v) => `${Math.round(v * 100)}%`).tickSize(0)).select(".domain").remove();
  svg.append("g").selectAll("rect").data(seats).join("rect").attr("class", "bar")
    .attr("x", (d) => x(String(d))).attr("width", x.bandwidth()).attr("y", (d) => y(now.get(d) ?? 0)).attr("height", (d) => y(0) - y(now.get(d) ?? 0)).attr("rx", 2)
    .attr("fill", (d) => (d >= 51 ? cssVar("--d3") : cssVar("--r2")))
    .on("mousemove", (event, d) => showTooltip(event, `<b>${d} Democratic-caucus seats</b><div class="row"><span>Chance now</span><span>${pct(now.get(d) ?? 0, 1)}</span></div><div class="row"><span>This morning</span><span>${pct(before.get(d) ?? 0, 1)}</span></div>`))
    .on("mouseleave", hideTooltip);
  svg.append("g").selectAll("rect").data(seats.filter((d) => (before.get(d) ?? 0) > 0)).join("rect").attr("class", "morning-outline")
    .attr("x", (d) => x(String(d))).attr("width", x.bandwidth()).attr("y", (d) => y(before.get(d))).attr("height", (d) => y(0) - y(before.get(d))).attr("rx", 2);
  const majority = seats.indexOf(51);
  if (majority > 0) {
    const xLine = x("51") - (x.step() - x.bandwidth()) / 2, onLeft = xLine > width * 0.6;
    svg.append("line").attr("x1", xLine).attr("x2", xLine).attr("y1", margin.top).attr("y2", height - margin.bottom).attr("stroke", cssVar("--ink")).attr("stroke-dasharray", "3 3");
    svg.append("text").attr("class", "label").attr("x", xLine + (onLeft ? -5 : 5)).attr("y", margin.top + 10).attr("text-anchor", onLeft ? "end" : "start").text(`51 or more: Democratic control (${needleChance(run.pD)})`);
  }
  const likeliest = seats.reduce((best, d) => ((now.get(d) ?? 0) > (now.get(best) ?? 0) ? d : best), seats[0]);
  document.getElementById("senate-night-dist-title").textContent = `Democratic-caucus seats, projected now: ${run.expectedD.toFixed(1)} expected, ${likeliest} most likely (${senateState.morningSeats.expected.toFixed(1)} this morning)`;
}

/** The map: called states solid, races still out shaded by the chance now, counting states outlined. */
function renderSenateNightMap(doc, run) {
  if (!US_TOPO) return;
  const now = new Map(run.races.map((race) => [race.state, race]));
  const inputs = new Map(doc.inputs.races.map((race) => [race.state, race]));
  const width = 960, height = 560;
  const box = document.getElementById("senate-night-map");
  box.innerHTML = "";
  const svg = d3.select(box).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", "Senate races by state: calls and chances now");
  const features = topojson.feature(US_TOPO, US_TOPO.objects.states).features.filter((f) => FIPS_TO_STATE[f.id] && FIPS_TO_STATE[f.id] !== "DC");
  const path = d3.geoPath(d3.geoAlbersUsa().fitSize([width, height], { type: "FeatureCollection", features }));
  const stateOf = (f) => FIPS_TO_STATE[f.id];
  const fill = (f) => { const race = now.get(stateOf(f)); return !race ? cssVar("--notup") : race.call ? senateCalledFill(race.call.winner) : senateOutFill(race); };
  const counting = (f) => { const race = inputs.get(stateOf(f)); return Boolean(race && !now.get(race.state).call && senateCount(doc, race)?.votes); };
  svg.append("g").selectAll("path").data(features).join("path").attr("d", path).attr("fill", fill)
    .attr("class", (f) => `state${now.has(stateOf(f)) ? " rated race" : ""}${counting(f) ? " counting" : ""}`)
    .on("mousemove", (event, f) => { const race = inputs.get(stateOf(f)); showTooltip(event, race ? senateNightTooltip(doc, race, now.get(race.state)) : `<b>${esc(f.properties.name)}</b><br>No Senate race this year`); })
    .on("mouseleave", hideTooltip)
    .on("click", (event, f) => { if (now.has(stateOf(f))) openSenateRace(stateOf(f), { scroll: true }); });
  const flipped = features.filter((f) => senateFlip(inputs.get(stateOf(f)), now.get(stateOf(f))?.call));
  svg.append("defs").append("pattern").attr("id", "senate-flip-hatch").attr("patternUnits", "userSpaceOnUse").attr("width", 8).attr("height", 8).attr("patternTransform", "rotate(45)")
    .append("rect").attr("width", 3).attr("height", 8).attr("fill", "#fff").attr("fill-opacity", 0.5);
  svg.append("g").attr("class", "flip-marks").selectAll("path").data(flipped).join("path").attr("d", path).attr("fill", "url(#senate-flip-hatch)");
  const called = features.filter((f) => now.get(stateOf(f))?.call);
  const badges = svg.append("g").attr("class", "call-badges").selectAll("g").data(called).join("g").attr("transform", (f) => `translate(${path.centroid(f)})`);
  badges.append("circle").attr("r", 13).style("stroke", (f) => senateCalledFill(now.get(stateOf(f)).call.winner));
  badges.append("path").attr("d", checkPath(13)).style("stroke", (f) => senateCalledFill(now.get(stateOf(f)).call.winner));
  svg.append("g").selectAll("text").data(features.filter((f) => now.has(stateOf(f)))).join("text")
    .attr("class", "state-label").attr("text-anchor", "middle").attr("transform", (f) => `translate(${path.centroid(f)})`).attr("dy", (f) => (now.get(stateOf(f)).call ? "1.9em" : "0.35em"))
    .attr("fill", (f) => { const race = now.get(stateOf(f)); return race.call || Math.abs(race.chance - 0.5) > 0.2 ? "#fff" : "#111"; })
    .text(stateOf);
  const scale = probabilityScale();
  document.getElementById("senate-night-map-legend").innerHTML = [0.1, 0.3, 0.5, 0.7, 0.9].map((p) => `<span><i class="sw" style="background:${scale(p)}"></i>${p === 0.5 ? "50/50" : `${Math.round(p * 100)}% D`}</span>`).join("")
    + `<span>${checkBadgeIcon(cssVar("--d3"))}${checkBadgeIcon(cssVar("--r3"))}Called</span><span><i class="sw flip-sw"></i>Flipped</span><span><i class="sw outline"></i>Counting</span><span><i class="sw" style="background:${cssVar("--notup")}"></i>No race</span>`;
}

/** The national read, in words: how far the night so far (calls, and the Texas count) says each party is running from its polls. */
function nationalReadText(n) {
  if (n == null) return "";
  return Math.abs(n) < 0.5 ? "the night so far looks about like the polls nationally" : `the night so far suggests ${n > 0 ? "Democrats" : "Republicans"} are running about ${Math.abs(n).toFixed(1)} points ahead of their polls nationally`;
}

/**
 * Why one race's chance moved: each check with calls in it that moved this race half a point or more (its own call,
 * or calls elsewhere shifting the national read), and the Texas count's drift between calls once it adds up.
 */
function senateRaceMoves(doc, index, race) {
  const timeline = doc.timeline.filter((point) => Array.isArray(point.r));
  const eventsAt = d3.group(doc.events, (event) => event.t);
  const moves = [];
  const texasText = (n) => (race.state === "TX" ? "The Texas count, read by the Texas needle." : `The Texas count moved the national read: ${nationalReadText(n)}.`);
  let driftFrom = 0;
  const flushDrift = (to) => {
    const from = timeline[driftFrom];
    if (to > driftFrom && Math.abs(timeline[to].r[index] - from.r[index]) >= 0.01) moves.push({ t: timeline[to].t, from: from.r[index], to: timeline[to].r[index], text: texasText(timeline[to].n) });
  };
  for (let i = 1; i < timeline.length; i += 1) {
    const before = timeline[i - 1], after = timeline[i];
    const calls = (eventsAt.get(after.t) ?? []).filter((event) => event.kind !== "texas");
    if (!calls.length) {
      if (Math.abs(after.r[index] - timeline[driftFrom].r[index]) >= 0.02) { flushDrift(i); driftFrom = i; }
      continue;
    }
    flushDrift(i - 1);
    driftFrom = i;
    const own = calls.find((event) => event.state === race.state);
    if (!own && Math.abs(after.r[index] - before.r[index]) < 0.005) continue;
    const others = calls.filter((event) => event.state !== race.state).map((event) => event.headline);
    const elsewhere = others.length ? `${listNames(others.slice(0, 3))}${others.length > 3 ? ` and ${others.length - 3} more` : ""}` : "";
    const text = own
      ? (own.kind === "uncall" ? "Its call was withdrawn." : `Called: ${own.headline}${own.kind === "upset" ? ", an upset" : ""}.`)
      : `${elsewhere}: ${nationalReadText(after.n)}.`;
    moves.push({ t: after.t, from: before.r[index], to: after.r[index], text });
  }
  flushDrift(timeline.length - 1);
  return moves;
}

function senateRaceDetail(doc, race, index, now) {
  const parts = [];
  if (race.state === "TX") {
    const count = senateCount(doc, race);
    parts.push(`<div><h4>Count</h4><p>${count.votes ? `${senateVotes(count.votes)} votes counted, ${pct(count.share)} of the expected vote. ${esc(lastName(race.challenger))} ${challengerMargin(count.margin, "D")} so far; the Texas needle projects ${challengerMargin(now.expectedMargin, "D")}.` : "No votes counted yet."} <a href="#election-night">County by county on the Texas Election Night tab</a>.</p></div>`);
  } else {
    const returns = doc.returns?.[race.state];
    parts.push(returns
      ? `<div><h4>Count${returns.stale ? " (last good read)" : ""}</h4>${returns.total
        ? `<table class="mini"><tbody>${returns.candidates.filter((c) => c.votes > 0).map((c) => `<tr><td>${esc(c.name)}${c.party === "other" ? "" : ` (${c.party})`}</td><td class="num">${senateVotes(c.votes)}</td><td class="num">${pct(c.votes / returns.total, 1)}</td></tr>`).join("")}</tbody></table>`
        : "<p>No votes counted yet.</p>"}<p class="thin">${returns.unofficial
          ? `Unofficial: ${esc(senateState.gaps?.[race.state]?.[1] ?? "there's no official file")}, so these are the numbers Wikipedia's editors post on <a href="${esc(returns.url)}" target="_blank" rel="noopener">the race's page</a> from news reports${returns.units ? ` (${returns.units.reporting}% reporting)` : ""}${returns.lastUpdate ? `, updated ${esc(returns.lastUpdate)}` : ""}. Read ${needleTime(returns.fetchedAt)} Central.`
          : `${returns.units?.total ? `Reporting: ${senateVotes(returns.units.reporting)} of ${senateVotes(returns.units.total)} ${returns.units.kind}. ` : ""}From the <a href="${esc(returns.url)}" target="_blank" rel="noopener">${esc(returns.source)}</a>, read ${needleTime(returns.fetchedAt)} Central.`}${returns.stale ? ` The latest read failed (${esc(returns.error || "error")}).` : ""}</p></div>`
      : senateState.feeds?.[race.state]
        ? `<div><h4>Count</h4><p>No votes yet. The site reads the <a href="${esc(senateState.feeds[race.state].url)}" target="_blank" rel="noopener">${esc(senateState.feeds[race.state].label)}</a> results file every two minutes from 5 p.m. Central.</p></div>`
        : `<div><h4>Count</h4><p>No live count: ${esc(senateState.gaps?.[race.state]?.[1] ?? `there's no official results file the site can read for ${race.stateName}`)}. This race moves on its call and on calls elsewhere.</p></div>`);
  }
  const big = doc.countyReturns?.[race.state];
  if (big) {
    const swing = big.total >= 1000 && big.margin != null && big.president2024Margin != null ? big.margin - big.president2024Margin : null;
    parts.push(`<div><h4>Big counties only${big.stale ? " (last good read)" : ""}</h4>${big.total
      ? `<table class="mini"><tbody>${big.candidates.filter((c) => c.votes > 0).map((c) => `<tr><td>${esc(c.name)}${c.party === "other" ? "" : ` (${c.party})`}</td><td class="num">${senateVotes(c.votes)}</td><td class="num">${pct(c.votes / big.total, 1)}</td></tr>`).join("")}</tbody></table>`
      : "<p>No votes yet.</p>"}<p class="thin">The official counts of ${esc(listNames(big.counties))} (${big.counties.length === big.countiesListed ? `all ${big.countiesListed} counties the site reads` : `${big.counties.length} of the ${big.countiesListed} counties the site reads`}${big.share2024 ? `, ${pct(big.share2024)} of the state's 2024 vote` : ""}), read ${needleTime(big.fetchedAt)} Central${big.units ? `, ${senateVotes(big.units.reporting)} of ${senateVotes(big.units.total)} precincts in` : ""}. These counties went ${challengerMargin(big.president2024Margin, "D")} for president in 2024${swing != null ? `, so the count so far is a swing of ${challengerMargin(swing, race.challengerParty)} in the same counties` : ""}. A partial count, not the state's.</p></div>`);
  }
  const moves = senateRaceMoves(doc, index, race);
  parts.unshift(`<div class="race-chance-wide"><h4>${esc(lastName(race.challenger) || "Challenger")}'s chance through the night</h4><div class="race-chance-chart" data-state="${race.state}" data-index="${index}"></div></div>`);
  parts.push(`<div><h4>Why the chance moved</h4>${moves.length
    ? `<ol class="moves">${moves.slice().reverse().map((move) => `<li><span class="when">${needleTime(move.t)}</span> <span class="move ${move.to >= move.from ? (race.challengerParty === "I" ? "lean-i" : "lean-d") : "lean-r"}">${needleChance(move.from)} → ${needleChance(move.to)}</span> ${esc(move.text)}</li>`).join("")}</ol>`
    : `<p>${now.call ? "Called." : `No real change since this morning (${needleChance(race.prior)}).`}</p>`}</div>`);
  const seat = senateState.benchmarks?.[race.state]?.seat, independent = senateState.benchmarks?.[race.state]?.independent2024;
  const read = doc.timeline.at(-1)?.n;
  parts.push(`<div><h4>Going in</h4><p>${esc(race.rating || "Unrated")} by the forecasters' consensus. Polls ${challengerMargin(race.pollMargin, race.challengerParty)}; the polls model gave ${esc(lastName(race.challenger) || "the challenger")} ${needleChance(race.prior)} this morning.${seat ? ` Last race for this seat (${seat.year}): ${esc(seat.democrat || "")} ${challengerMargin(seat.margin, race.challengerParty === "I" ? "D" : race.challengerParty)} against ${esc(seat.republican || "")}.${seat.note ? ` ${esc(seat.note)}` : ""}` : ""}${independent ? ` Osborn's 2024 race against Deb Fischer: ${challengerMargin(independent.margin, "I")}.` : ""}${read != null && !now.call ? ` Now: ${esc(nationalReadText(read))}, so the projection is ${challengerMargin(now.expectedMargin, race.challengerParty)}.` : ""}</p></div>`);
  return `<div class="race-detail-grid">${parts.join("")}</div>`;
}

/**
 * One race's chance through the night, as a step line from this morning's polls-model chance: the 50% line, the
 * hours, and a mark where the race was called. Drawn inside the race's open row.
 */
function renderRaceChanceChart(box, doc, race, index, now) {
  const points = doc.timeline.filter((point) => Array.isArray(point.r)).map((point) => ({ time: Math.max(Date.parse(point.t), SENATE_NIGHT_TIMING.chartStart), p: point.r[index] }));
  if (!points.length) return;
  const width = 760, height = 140, margin = { top: 12, right: 60, bottom: 22, left: 36 };
  const last = points[points.length - 1];
  const holdUntil = senateWindowOpen() ? Math.max(last.time, Date.now()) : last.time;
  const end = Math.max(holdUntil + 15 * 60_000, SENATE_NIGHT_TIMING.chartStart + 3 * 3_600_000);
  const drawn = [...points, { ...last, time: holdUntil }];
  const x = d3.scaleLinear().domain([SENATE_NIGHT_TIMING.chartStart, end]).range([margin.left, width - margin.right]);
  const y = d3.scaleLinear().domain([0, 1]).range([height - margin.bottom, margin.top]);
  const color = race.challengerParty === "I" ? cssVar("--toss") : cssVar("--d3");
  const svg = d3.select(box).html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img")
    .attr("aria-label", `${race.challenger || "The challenger"}'s chance through the night: ${needleChance(race.prior)} this morning, ${needleChance(last.p)} now`);
  svg.append("line").attr("class", "even-line").attr("stroke-dasharray", "3 3").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", y(0.5)).attr("y2", y(0.5));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).tickValues([0, 0.5, 1]).tickFormat((v) => `${Math.round(v * 100)}%`).tickSize(0).tickPadding(6)).select(".domain").remove();
  const hours = d3.range(Math.ceil(SENATE_NIGHT_TIMING.chartStart / 3_600_000) * 3_600_000, end, 3_600_000);
  const step = Math.max(1, Math.ceil(hours.length / 6));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${height - margin.bottom})`).call(d3.axisBottom(x).tickValues(hours.filter((_, i) => i % step === 0)).tickFormat((t) => needleHour.format(new Date(t)).replace(/\s+/g, " ").toLowerCase()).tickSize(0).tickPadding(6)).select(".domain").remove();
  svg.append("path").datum(drawn).attr("fill", "none").attr("stroke", color).attr("stroke-width", 2).attr("d", d3.line().curve(d3.curveStepAfter).x((d) => x(d.time)).y((d) => y(d.p)));
  // The race's own call, as the same check badge the map uses.
  const call = doc.events.filter((event) => event.state === race.state && event.kind !== "uncall").at(-1);
  if (call && now?.call) {
    const badge = svg.append("g").attr("class", "chart-call-badge").attr("transform", `translate(${x(Math.max(Date.parse(call.t), SENATE_NIGHT_TIMING.chartStart))},${y(now.chance)})`);
    badge.append("circle").attr("r", 7).style("stroke", senateCalledFill(now.call.winner));
    badge.append("path").attr("d", checkPath(7)).style("stroke", senateCalledFill(now.call.winner));
  }
  svg.append("text").attr("class", "event-label").attr("x", x(holdUntil) + 5).attr("y", y(last.p) + 4).text(now?.call ? "called" : needleChance(last.p));
}

/**
 * Every race, closest first, laid out like the Texas county table: the count so far against this seat's last race,
 * the 2024 presidential margin, and the polls; then the projection and chance now. A row opens to its votes and to
 * why its chance moved.
 */
function renderSenateNightTable(doc, run) {
  const byState = new Map(run.races.map((race) => [race.state, race]));
  const benchmarks = senateState.benchmarks ?? {};
  const rows = doc.inputs.races.map((race, index) => ({ race, index, now: byState.get(race.state) }))
    .sort((a, b) => Math.abs(a.race.prior - 0.5) - Math.abs(b.race.prior - 0.5) || a.race.stateName.localeCompare(b.race.stateName));
  const header = `<thead><tr><th>Race</th><th>Counted</th><th class="num">So far<span class="sub">challenger − R</span></th>
    <th class="num">Last race<span class="sub">this seat</span></th><th class="num">2024<span class="sub">president</span></th><th class="num">Polls<span class="sub">average</span></th>
    <th class="num">Swing<span class="sub">vs last race</span></th><th class="num">Swing<span class="sub">vs 2024</span></th>
    <th class="num">Projected<span class="sub">final margin</span></th><th class="num">Chance<span class="sub">challenger, now</span></th><th>Call</th></tr></thead>`;
  const body = rows.map(({ race, index, now }) => {
    const count = senateCount(doc, race);
    const bench = benchmarks[race.state] ?? {};
    const party = race.challengerParty;
    // A handful of votes (New Hampshire's midnight towns) says nothing about a margin; wait for a thousand.
    const soFar = count?.votes >= 1000 ? count.margin : null;
    const open = senateState.open.has(race.state);
    const call = now.call;
    const callCell = call
      ? `<b class="${call.winner === "D" ? "lean-d" : call.winner === "R" ? "lean-r" : "lean-i"}">${esc(lastName(senateWinnerName(race, call)) || call.winner)} (${call.winner})</b>${flipTag(race, call)}${call.via === "manual" ? '<span class="thin below">set by hand</span>' : ""}`
      : '<span class="muted">not called</span>';
    const big = doc.countyReturns?.[race.state];
    const bigLine = big?.total >= 1000 ? `<span class="thin below">big counties: ${challengerMargin(big.margin, party)} so far, 2024 ${challengerMargin(big.president2024Margin, "D")}</span>` : "";
    const countCell = !count ? `<span class="muted">${big ? "big counties only" : "no live count"}</span>${bigLine || `<span class="thin below">${esc(big ? "not yet" : senateState.gaps?.[race.state]?.[0] ?? "moves on calls")}</span>`}`
      : `<span class="progress" aria-hidden="true"><span style="width:${Math.round(Math.min(1, count.share) * 100)}%"></span></span>${pct(count.share)}<span class="thin">${esc(count.detail)}</span>${bigLine}`;
    return `<tr data-state="${race.state}" class="race-row${open ? " open" : ""}" tabindex="0" aria-expanded="${open}">
      <td class="county"><b><span class="caret" aria-hidden="true">${open ? "▾" : "▸"}</span>${esc(race.stateName)}</b>${race.special ? ' <span class="thin special">special</span>' : ""}<span class="thin below">${esc(lastName(race.challenger) || "—")} (${party}) v. ${esc(lastName(race.republican) || "—")} (R)</span></td>
      <td>${countCell}</td>
      <td class="num">${challengerMargin(soFar, party)}</td>
      <td class="num">${challengerMargin(bench.seat?.margin, party === "I" ? "D" : party)}${bench.seat?.year ? `<span class="thin below">${bench.seat.year}</span>` : ""}</td>
      <td class="num">${challengerMargin(bench.president2024?.margin, "D")}</td>
      <td class="num">${challengerMargin(race.pollMargin, party)}</td>
      <td class="num">${challengerMargin(soFar != null && bench.seat?.margin != null ? soFar - bench.seat.margin : null, party)}</td>
      <td class="num">${challengerMargin(soFar != null && bench.president2024?.margin != null ? soFar - bench.president2024.margin : null, party)}</td>
      <td class="num">${challengerMargin(now.expectedMargin, party)}</td>
      <td class="num">${call ? '<span class="muted">called</span>' : `<b>${needleChance(now.chance)}</b>`}<span class="thin below">${needleChance(race.prior)} this morning</span></td>
      <td>${callCell}</td></tr>${open ? `<tr class="race-detail"><td colspan="11">${senateRaceDetail(doc, race, index, now)}</td></tr>` : ""}`;
  }).join("");
  document.getElementById("senate-night-table").innerHTML = `${header}<tbody>${body}</tbody>`;
  for (const box of document.querySelectorAll("#senate-night-table .race-chance-chart")) {
    const index = Number(box.dataset.index);
    renderRaceChanceChart(box, doc, doc.inputs.races[index], index, byState.get(box.dataset.state));
  }
}

// ---------- governors ----------
let GOVERNOR_MAP_MODE = "rating";
function renderGovernors(s, topo, prev) {
  const g = s.governors;
  if (!g || !topo) return;
  const byState = new Map(g.races.map((r) => [r.state, r]));
  const width = 960, height = 560;
  const svgRoot = d3.select("#governor-map").html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", "Governor race ratings by state");
  const svg = svgRoot.append("g").attr("class", "zoom-root");
  const features = topojson.feature(topo, topo.objects.states).features.filter((f) => FIPS_TO_STATE[f.id] && FIPS_TO_STATE[f.id] !== "DC");
  const projection = d3.geoAlbersUsa().fitSize([width, height], { type: "FeatureCollection", features });
  const path = d3.geoPath(projection);
  const scale = probabilityScale();
  const fillFor = (race) => { if (!race) return cssVar("--notup"); if (GOVERNOR_MAP_MODE === "probability") { const { p } = raceProbability(race); return p == null ? cssVar("--notup") : scale(p); } return ratingColor(race.consensus?.label); };
  const paths = svg.append("g").selectAll("path").data(features).join("path").attr("d", path).attr("class", (f) => (byState.has(FIPS_TO_STATE[f.id]) ? "rated" : ""))
    .on("mousemove", (event, f) => { const race = byState.get(FIPS_TO_STATE[f.id]); showTooltip(event, race ? governorTooltip(race, g) : `<b>${esc(f.properties.name)}</b><br>No governor's race in 2026`); }).on("mouseleave", hideTooltip);
  svg.append("g").selectAll("text").data(features.filter((f) => byState.has(FIPS_TO_STATE[f.id]))).join("text").attr("class", "state-label").attr("text-anchor", "middle").attr("transform", (f) => `translate(${path.centroid(f)})`).attr("dy", "0.35em")
    .attr("fill", (f) => { const race = byState.get(FIPS_TO_STATE[f.id]); return (GOVERNOR_MAP_MODE === "probability" ? Math.abs((raceProbability(race).p ?? 0.5) - 0.5) > 0.2 : DARK_RATINGS.has(race.consensus?.label)) ? "#fff" : "#111"; }).text((f) => FIPS_TO_STATE[f.id]);
  const applyLegend = () => { document.getElementById("governor-legend").innerHTML = GOVERNOR_MAP_MODE === "probability" ? [0.02, 0.15, 0.3, 0.5, 0.7, 0.85, 0.98].map((p) => `<span><i class="sw" style="background:${scale(p)}"></i>${p === 0.5 ? "50/50" : `${Math.round(p * 100)}% D`}</span>`).join("") + `<span><i class="sw" style="background:${cssVar("--notup")}"></i>No race / no data</span>` : RATING_ORDER.map((r) => `<span><i class="sw" style="background:${ratingColor(r)}"></i>${r}</span>`).join("") + `<span><i class="sw" style="background:${cssVar("--notup")}"></i>No race in 2026</span>`; };
  paths.attr("fill", (f) => fillFor(byState.get(FIPS_TO_STATE[f.id])));
  applyLegend();
  attachZoom(svgRoot, "governor-map", { width, height });
  document.querySelectorAll("button.mode[data-governor-map]").forEach((b) => { b.classList.toggle("active", b.dataset.governorMap === GOVERNOR_MAP_MODE); b.onclick = () => { GOVERNOR_MAP_MODE = b.dataset.governorMap; renderGovernors(s, topo, prev); }; });

  const races = [...g.races];
  const competitiveness = (r) => Math.abs(r.consensus?.score ?? 4) + (raceProbability(r).p != null ? Math.abs(raceProbability(r).p - 0.5) : 0.4);
  races.sort((a, b) => competitiveness(a) - competitiveness(b));
  const battlegrounds = races.filter((r) => Math.abs(r.consensus?.score ?? 4) <= 3 || (raceProbability(r).p != null && Math.abs(raceProbability(r).p - 0.5) < 0.35));
  const head = `<tr><th>State</th><th>Matchup</th><th>Consensus</th><th title="${esc(g.forecasters.map((f) => f.name).join(", "))}">Ratings<span class="sub">${g.forecasters.map((f) => esc(shortName(f.name))).join(", ")}</span></th><th class="num">Poll average</th><th class="num">D wins<span class="sub">polls model</span></th></tr>`;
  const row = (r) => { const p = prev?.races?.[r.id]; return `<tr><td><b>${esc(r.state)}</b> <span class="muted">${esc(r.incumbentParty || "")}</span></td><td class="wrap">${r.candidates?.D ? `${esc(r.candidates.D)} <span class="muted">(D)</span>` : '<span class="muted">Democrat</span>'} / ${r.candidates?.R ? `${esc(r.candidates.R)} <span class="muted">(R)</span>` : '<span class="muted">Republican</span>'}</td><td>${ratingPill(r.consensus?.label)}</td><td class="ratings-cell">${g.forecasters.map((f) => miniRating(r.ratings[f.key])).join("")}</td><td class="num">${marginText(r.pollingAverage?.margin)}${r.pollingAverage ? `<span class="thin">n=${r.pollingAverage.pollCount}</span>` : ""}${delta(r.pollingAverage?.margin, p?.poll, { scale: 1, unit: "" })}</td><td class="num"><b>${pct(raceProbability(r).p)}</b>${raceProbability(r).source && raceProbability(r).source !== "polls" ? `<span class="thin">${esc(raceProbability(r).source)}</span>` : ""}${delta(raceProbability(r).p, previousRaceProbability(prev, r.id))}</td></tr>`; };
  document.getElementById("governor-table").innerHTML = head + battlegrounds.map(row).join("");
  document.getElementById("governor-table-all").innerHTML = head + [...g.races].sort((a, b) => a.stateName.localeCompare(b.stateName)).map(row).join("");
}
function governorTooltip(race, g) {
  const rows = [`<b>${esc(race.stateName)} Governor</b>${race.incumbentParty ? ` · ${race.incumbentParty}-held` : ""}${race.incumbent ? ` · ${esc(race.incumbent)}` : ""}`];
  if (race.candidates?.D || race.candidates?.R) rows.push(`${esc(race.candidates.D || "Democrat")} (D) vs ${esc(race.candidates.R || "Republican")} (R)`);
  rows.push("<hr>");
  const sel = raceProbability(race);
  rows.push(`<div class="row"><span><b>D wins, polls model</b></span><span><b>${pct(sel.p)}</b></span></div>`);
  rows.push(`<div class="row"><span>Consensus rating</span><span>${esc(race.consensus?.label || "—")}</span></div>`);
  for (const f of g.forecasters) if (race.ratings[f.key]) rows.push(`<div class="row"><span>${esc(f.name)}</span><span>${esc(race.ratings[f.key])}</span></div>`);
  if (race.pollingAverage) rows.push(`<div class="row"><span>Polling avg (${race.pollingAverage.pollCount})</span><span>${marginText(race.pollingAverage.margin)}</span></div>`);
  return rows.join("");
}

// ---------- morning digest ----------
function renderDigest(s, digest = s.digest, { archive = true } = {}) {
  if (!digest) return;
  document.getElementById("digest-title").textContent = `Morning digest, ${digest.dayName}`;
  document.getElementById("digest-body").innerHTML = `<p class="headline">${esc(digest.headline)}</p>` +
    digest.sections.map((section) => `<h4>${esc(section.title)}</h4><ul>${section.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`).join("") +
    (digest.notes?.length ? `<p class="muted">${digest.notes.map(esc).join(" ")}</p>` : "");
  const copy = document.getElementById("digest-copy");
  copy.onclick = async () => { try { await navigator.clipboard.writeText(digest.text); document.getElementById("digest-copied").textContent = "Copied."; setTimeout(() => { document.getElementById("digest-copied").textContent = ""; }, 2000); } catch { document.getElementById("digest-copied").textContent = "Copy failed; select the text instead."; } };
  if (!archive) return;
  fetchJson("data/changelog.json").then((log) => {
    const list = document.getElementById("digest-archive");
    const days = [...log].reverse();
    list.innerHTML = days.length ? days.map((d) => `<li><a href="#digest" data-digest-date="${esc(d.date)}">${fmtDate(d.date)}</a><span>${esc(d.headline || "")}</span></li>`).join("") : '<li><span class="muted">No archive yet.</span></li>';
    list.querySelectorAll("[data-digest-date]").forEach((a) => a.addEventListener("click", async (event) => {
      event.preventDefault();
      const date = a.dataset.digestDate;
      if (date === s.asOf) { renderDigest(s, s.digest, { archive: false }); return; }
      try { const old = await fetchJson(`data/history/${date}.json`); renderDigest(s, old.digest || { date, dayName: fmtDate(date), headline: "No digest was generated for this day.", sections: [], text: "" }, { archive: false }); } catch { /* keep current */ }
      scrollToPanelTop();
    }));
  }).catch(() => {});
}

// ---------- pollsters ----------
let POLLSTER_FILTER = "texas";
function renderPollsters(s) {
  const rows = (s.pollsters || []).filter((p) => POLLSTER_FILTER === "all" || p.texasPolls > 0);
  const lean = (v) => (v == null ? '<span class="muted">—</span>' : Math.abs(v) < 0.05 ? "Even" : `<span class="${v > 0 ? "lean-d" : "lean-r"}">${v > 0 ? "D" : "R"}+${Math.abs(v).toFixed(1)}</span>`);
  document.getElementById("pollsters-table").innerHTML = `<tr><th>Pollster</th><th>538 grade</th><th class="num">Polls<span class="sub">Texas / all</span></th><th class="num">Lean<span class="sub">vs. race average</span></th><th>Latest poll</th><th>Races polled</th></tr>` +
    rows.map((p) => `<tr><td class="wrap"><b>${esc(p.pollster)}</b>${p.partisanPolls ? ` <span class="thin">${p.partisanPolls} partisan</span>` : ""}</td><td title="${esc(p.ratedAs ? `rated as ${p.ratedAs}` : "not in FiveThirtyEight's ratings")}">${p.grade ? `<b>${esc(p.grade)}</b> <span class="muted">${p.numericGrade}</span>` : '<span class="muted">unrated (0.5× weight)</span>'}</td><td class="num">${p.texasPolls} / ${p.polls}</td><td class="num">${lean(p.lean)}</td><td class="wrap">${p.latest ? `${esc(p.latest.race)}, ${fmtDate(p.latest.endDate)}: <b>${marginText(p.latest.margin)}</b>` : "—"}</td><td class="wrap muted">${esc(p.races.slice(0, 6).join(", "))}${p.races.length > 6 ? `, +${p.races.length - 6} more` : ""}</td></tr>`).join("");
  document.querySelectorAll("button.mode[data-pollster-filter]").forEach((b) => { b.classList.toggle("active", b.dataset.pollsterFilter === POLLSTER_FILTER); b.onclick = () => { POLLSTER_FILTER = b.dataset.pollsterFilter; renderPollsters(s); }; });
}

// ---------- trends ----------
function renderTrends(s, series) {
  const grid = document.getElementById("trend-charts");
  const charts = [
    { title: "Texas win chances, polls model", lines: [{ name: "Talarico, U.S. Senate", color: cssVar("--d3"), get: (d) => d.races?.["tx-senate"]?.pollModel }, { name: "Hinojosa, Governor", color: "#5b5b5b", get: (d) => d.races?.["tx-governor"]?.pollModel }, { name: "Goodwin, Lt. Governor", color: "#b58a00", get: (d) => d.races?.["tx-ltgov"]?.pollModel }], format: (v) => `${Math.round(v * 100)}%`, domain: [0, 1] },
    { title: "Texas Attorney General and down-ballot, polls model", lines: [{ name: "Johnson, AG", color: cssVar("--d3"), get: (d) => d.races?.["tx-ag"]?.pollModel }, { name: "Rosenthal, Railroad", color: "#5b5b5b", get: (d) => d.races?.["tx-railroad"]?.pollModel }, { name: "Eckhardt, Comptroller", color: "#b58a00", get: (d) => d.races?.["tx-comptroller"]?.pollModel }], format: (v) => `${Math.round(v * 100)}%`, domain: [0, 1] },
    { title: "Texas polling averages, D margin", lines: [{ name: "U.S. Senate", color: cssVar("--d3"), get: (d) => d.races?.["tx-senate"]?.poll }, { name: "Governor", color: "#5b5b5b", get: (d) => d.races?.["tx-governor"]?.poll }], format: (v) => marginText(v), domain: null },
    { title: "U.S. Senate: Democratic control, polls model", lines: [{ name: "Control", color: cssVar("--d3"), get: (d) => d.control?.pollModel }], format: (v) => `${Math.round(v * 100)}%`, domain: [0, 1] },
    { title: "Texas House: expected Democratic seats, our model", lines: [{ name: "Expected seats", color: cssVar("--d3"), get: (d) => d.txHouseModel?.expectedD }], format: (v) => v.toFixed(1), domain: null },
    { title: "U.S. House: Democratic control, our model", lines: [{ name: "Control", color: cssVar("--d3"), get: (d) => d.usHouse?.control }], format: (v) => `${Math.round(v * 100)}%`, domain: [0, 1] },
  ];
  grid.innerHTML = "";
  for (const chart of charts) {
    const box = document.createElement("div"); box.className = "trend";
    box.innerHTML = `<h4>${esc(chart.title)}</h4><div class="legend">${chart.lines.map((l) => `<span><i class="sw" style="background:${l.color}"></i>${esc(l.name)}</span>`).join("")}</div>`;
    grid.appendChild(box);
    drawTrend(box, series, chart);
  }
  fetchJson("data/changelog.json").then((log) => {
    const days = [...log].reverse().filter((d) => d.changes.length);
    document.getElementById("changelog").innerHTML = days.length ? days.map((d) => `<div class="changelog-day"><div class="d">${fmtDate(d.date)}</div><ul>${d.changes.slice(0, 20).map((c) => `<li>${esc(c.text)}</li>`).join("")}</ul></div>`).join("") : '<p class="note">No changes recorded yet; the first comparison happens with the second snapshot.</p>';
  }).catch(() => {});
}
function drawTrend(box, series, chart) {
  const width = 520, height = 200, margin = { top: 12, right: 14, bottom: 26, left: 44 };
  const points = series.map((d) => ({ date: d.date, values: chart.lines.map((l) => l.get(d)) }));
  const allValues = points.flatMap((p) => p.values).filter((v) => v != null);
  if (!allValues.length) { box.insertAdjacentHTML("beforeend", '<p class="note">No data yet.</p>'); return; }
  const svg = d3.select(box).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("class", "chart").attr("role", "img").attr("aria-label", chart.title);
  const x = d3.scalePoint().domain(points.map((p) => p.date)).range([margin.left, width - margin.right]).padding(0.5);
  const domain = chart.domain || d3.extent(allValues);
  const pad = chart.domain ? 0 : Math.max(1, (domain[1] - domain[0]) * 0.2);
  const y = d3.scaleLinear().domain([domain[0] - pad, domain[1] + pad]).nice().range([height - margin.bottom, margin.top]);
  svg.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", (d) => y(d)).attr("y2", (d) => y(d));
  const every = Math.max(1, Math.ceil(points.length / 8));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${height - margin.bottom})`).call(d3.axisBottom(x).tickSize(0).tickValues(x.domain().filter((_, i) => i % every === 0 || i === points.length - 1)).tickFormat((d) => fmtDate(d))).select(".domain").remove();
  svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(chart.format).tickSize(0)).select(".domain").remove();
  chart.lines.forEach((line, index) => {
    const data = points.map((p) => ({ date: p.date, value: p.values[index] })).filter((p) => p.value != null);
    svg.append("path").datum(data).attr("fill", "none").attr("stroke", line.color).attr("stroke-width", 2).attr("d", d3.line().x((p) => x(p.date)).y((p) => y(p.value)));
    svg.append("g").selectAll("circle").data(data).join("circle").attr("cx", (p) => x(p.date)).attr("cy", (p) => y(p.value)).attr("r", 3.5).attr("fill", line.color).attr("stroke", "#fff").attr("stroke-width", 1.5)
      .on("mousemove", (event, p) => showTooltip(event, `<b>${esc(line.name)}</b>, ${fmtDate(p.date)}<div class="row"><span>Value</span><span>${chart.format(p.value)}</span></div>`)).on("mouseleave", hideTooltip);
  });
}

// ---------- scenarios (client-side re-runs of the models) ----------
async function setupScenarios(s) {
  const [legislature, metrics] = await Promise.all([import("./model/legislature.js"), import("./model/metrics.js")]);
  const { LEGISLATURE_MODEL, runChamberModel, runRatedChamberModel } = legislature;
  const { pollWinProbability, seatDistribution, priorFromRating } = metrics;
  const todayEnv = s.txLegislature?.environment;
  const txDefaults = { env: todayEnv?.margin ?? -5, elasticity: LEGISLATURE_MODEL.swingElasticity, incumbency: LEGISLATURE_MODEL.incumbencyBonus, ratingWeight: LEGISLATURE_MODEL.ratingWeight };
  const senateDefaults = { shift: 0, finalError: 5.5 };
  const houseDefaults = { shift: 0 };
  const bind = (containerId, defaults, onChange) => {
    const container = document.getElementById(containerId);
    const state = { ...defaults };
    const inputs = [...container.querySelectorAll("input[data-param]")];
    const render = () => { inputs.forEach((input) => { input.value = state[input.dataset.param]; container.querySelector(`output[data-out="${input.dataset.param}"]`).textContent = formatParam(input.dataset.param, state[input.dataset.param]); }); onChange(state); };
    inputs.forEach((input) => input.addEventListener("input", () => { state[input.dataset.param] = Number(input.value); render(); }));
    container.querySelector("[data-reset]").addEventListener("click", () => { Object.assign(state, defaults); render(); });
    render();
  };
  const figure = (k, v, sub, primary = false) => `<div class="figure${primary ? " primary" : ""}"><div class="k">${esc(k)}</div><div class="v">${v}</div><div class="s">${esc(sub)}</div></div>`;

  bind("tx-scenario-controls", txDefaults, (state) => {
    const environment = { ...(todayEnv || {}), margin: state.env };
    const params = { ...LEGISLATURE_MODEL, swingElasticity: state.elasticity, incumbencyBonus: state.incumbency, ratingWeight: state.ratingWeight };
    const house = runChamberModel({ districts: s.txHouse.districts, notUp: s.txHouse.model?.notUp || { D: 0, R: 0 }, majority: 76, environment, params });
    const senate = runChamberModel({ districts: s.txSenate.districts, notUp: s.txSenate.model?.notUp || { D: 7, R: 8 }, majority: 16, environment, params });
    document.getElementById("tx-scenario-figures").innerHTML =
      figure("Texas House, Democratic control", pct(house.control.D), `expected ${house.expected.D.toFixed(1)} D seats; today's model says ${pct(s.txHouse.model?.control?.D)} and ${s.txHouse.model?.expected?.D?.toFixed(1)}`, true) +
      figure("Texas Senate, Democratic control", pct(senate.control.D), `expected ${senate.expected.D.toFixed(1)} D seats; today ${pct(s.txSenate.model?.control?.D)} and ${s.txSenate.model?.expected?.D?.toFixed(1)}`) +
      figure("Swing from 2024", `${state.env - LEGISLATURE_MODEL.statewidePresidentialMargin2024 >= 0 ? "D" : "R"}+${Math.abs(state.env - LEGISLATURE_MODEL.statewidePresidentialMargin2024).toFixed(1)}`, "statewide environment minus Trump's 13.7-point 2024 margin") +
      figure("House seats flipping", String(house.seats.filter((x) => { const d = s.txHouse.districts.find((q) => q.district === x.district); return d && ((d.party === "R" && x.pD > 0.5) || (d.party === "D" && x.pD < 0.5)); }).length), "seats where the model now favors the other party");
    renderSeatHistogram("tx-house-scenario-chart", "tx-house-scenario-title", { ...house, notUp: house.notUp }, "Texas house");
    renderSeatHistogram("tx-senate-scenario-chart", "tx-senate-scenario-title", { ...senate, notUp: senate.notUp }, "Texas senate");
  });

  bind("senate-scenario-controls", senateDefaults, (state) => {
    const daysToElection = s.usSenate.races.find((r) => r.pollModel?.daysToElection != null)?.pollModel.daysToElection ?? 30;
    const races = s.usSenate.races.map((r) => {
      if (r.pI > 0 || !r.pollingAverage) return { pD: r.pD ?? priorFromRating(r.consensus?.label), pR: r.pR ?? 1 - (r.pD ?? 0.5), pI: r.pI ?? 0 };
      const shifted = pollWinProbability({ margin: r.pollingAverage.margin + state.shift, effectiveN: r.pollingAverage.effectiveN }, { daysToElection, finalError: state.finalError });
      return { pD: shifted.pD, pR: 1 - shifted.pD, pI: 0 };
    });
    const dist = seatDistribution(races, { democraticCaucusNotUp: s.senateControl.notUp.democraticCaucus, republicanNotUp: s.senateControl.notUp.republican });
    const flips = s.usSenate.races.filter((r, i) => (r.incumbentParty === "R" && races[i].pD > 0.5) || (r.incumbentParty === "D" && races[i].pD < 0.5)).map((r) => r.state);
    document.getElementById("senate-scenario-figures").innerHTML =
      figure("Democratic control", pct(dist.control.D), `today's polls model says ${pct(s.senateControl.pollModel?.control?.D)}`, true) +
      figure("Expected Democratic-caucus seats", dist.expected.D.toFixed(1), `today ${s.senateControl.pollModel?.expected?.D?.toFixed(1)}; 51 needed`) +
      figure("Seats favored to flip", String(flips.length), flips.join(", ") || "none") +
      figure("No majority for either side", pct(dist.control.none), "independents hold the balance");
    renderSeatHistogram("senate-scenario-chart", "senate-scenario-title", { histogram: dist.histogram, control: dist.control, expected: dist.expected, majority: 51, notUp: { D: s.senateControl.notUp.democraticCaucus, R: s.senateControl.notUp.republican } }, "U.S. Senate");
  });

  bind("house-scenario-controls", houseDefaults, (state) => {
    const h = s.usHouse;
    if (!h) return;
    const seats = h.districts.map((d) => ({ id: d.id, margin: d.margin === null || d.margin === undefined ? null : d.margin + state.shift, party: d.incumbentParty }));
    const model = runRatedChamberModel({ seats, notUp: h.model.notUp, majority: 218 });
    document.getElementById("house-scenario-figures").innerHTML =
      figure("Democratic control", pct(model.control.D), `today's model says ${pct(h.model.control.D)}`, true) +
      figure("Expected Democratic seats", model.expected.D.toFixed(1), `today ${h.model.expected.D.toFixed(1)}; 218 needed`) +
      figure("Texas seats favored for Democrats", String(model.seats.filter((x) => x.id.startsWith("TX-") && x.pD > 0.5).length), `of 38; today ${h.districts.filter((d) => d.state === "TX" && d.modelD > 0.5).length}`);
    renderSeatHistogram("house-scenario-chart", "house-scenario-title", { ...model, seats: undefined }, "U.S. House");
  });
}
function formatParam(name, value) {
  if (name === "env" || name === "shift") return value === 0 ? "Even" : `${value > 0 ? "D" : "R"}+${Math.abs(value).toFixed(1)}`;
  if (name === "elasticity" || name === "ratingWeight") return `${Math.round(value * 100)}%`;
  if (name === "finalError") return `${value.toFixed(1)} pts`;
  return `${value}`;
}

// ---------- vote panel: dates, county finder, strip ----------
const VOTE_DATES = [
  { date: "2026-10-05", label: "Last day to register to vote" },
  { date: "2026-10-19", label: "Early voting begins" },
  { date: "2026-10-23", label: "Last day to apply for a ballot by mail (received, not postmarked)" },
  { date: "2026-10-30", label: "Early voting ends" },
  { date: "2026-11-03", label: "Election Day, polls open 7 a.m. to 7 p.m." },
];
let COUNTIES = null, COUNTY_FEATURES = null;
function todayChicago() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function daysUntil(iso) { return Math.round((Date.parse(iso) - Date.parse(todayChicago())) / 86_400_000); }
function voteCountdown(days) { return days === 0 ? "today" : days === 1 ? "tomorrow" : days > 1 ? `in ${days} days` : `${-days} day${days === -1 ? "" : "s"} ago`; }
function setupVotePanel() {
  const dialog = document.getElementById("vote-dialog");
  if (!dialog || typeof dialog.showModal !== "function") return;
  document.getElementById("vote-dates").innerHTML = VOTE_DATES.map((d) => { const days = daysUntil(d.date); return `<li class="${days < 0 ? "past" : days === 0 ? "today" : ""}"><span>${esc(d.label)}</span><span class="when">${new Date(`${d.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}, ${voteCountdown(days)}</span></li>`; }).join("");
  const open = () => { dialog.showModal(); loadCounties(); };
  document.getElementById("open-vote").addEventListener("click", open);
  document.getElementById("vote-share").addEventListener("click", async () => { try { await navigator.clipboard.writeText("https://texas-race-tracker.vercel.app/"); document.getElementById("vote-shared").textContent = "Link copied."; } catch { document.getElementById("vote-shared").textContent = "texas-race-tracker.vercel.app"; } });
  document.getElementById("vote-locate").addEventListener("click", locateCounty);
  document.getElementById("vote-outside").addEventListener("click", () => { document.getElementById("vote-county-card").innerHTML = outsideTexasCard(); document.getElementById("vote-county").value = ""; localStorage.removeItem("voteCounty"); });
  document.getElementById("vote-county").addEventListener("change", (event) => { if (event.target.value) showCounty(event.target.value, true); });
  // Strip under the masthead: the next key date, or the open early-voting window.
  const strip = document.getElementById("vote-strip");
  const toEarly = daysUntil("2026-10-19"), toEnd = daysUntil("2026-10-30"), toElection = daysUntil("2026-11-03");
  let message = null;
  if (toElection === 0) message = "<b>Election Day.</b> Polls are open until 7 p.m.; if you are in line by then, you can vote.";
  else if (toEarly > 0) message = `<b>Early voting starts ${voteCountdown(toEarly)}</b>, October 19 through October 30. Registration closes ${daysUntil("2026-10-05") >= 0 ? voteCountdown(daysUntil("2026-10-05")) : "October 5"}.`;
  else if (toEnd >= 0) message = `<b>Early voting is open</b> through Friday, October 30 (${voteCountdown(toEnd)} left). Vote at any polling place your county lists.`;
  else if (toElection > 0) message = `<b>Election Day is ${voteCountdown(toElection)}</b>, Tuesday, November 3. Early voting has ended; vote in person on Election Day.`;
  if (message) { strip.innerHTML = `<span>${message} The polls above are not votes.</span><button id="strip-open">Where to vote</button>`; strip.hidden = false; document.getElementById("strip-open").addEventListener("click", open); }
  // Auto-open after 12 seconds, once the visitor has had a look at the numbers; at most once a week, plus once more when the
  // phase changes (early voting opens, Election Day).
  const phase = toElection === 0 ? "eday" : toEarly > 0 ? "pre" : "early";
  let seen = null;
  try { seen = JSON.parse(localStorage.getItem("voteSeen") || "null"); } catch { seen = null; }
  const weekMs = 7 * 86_400_000;
  const due = !seen || seen.phase !== phase || Date.now() - (seen.at || 0) > weekMs;
  if (due) setTimeout(() => { if (!dialog.open) { localStorage.setItem("voteSeen", JSON.stringify({ phase, at: Date.now() })); open(); } }, 12000);
  const saved = localStorage.getItem("voteCounty");
  if (saved) loadCounties().then(() => showCounty(saved, false));
}
async function loadCounties() {
  if (COUNTIES) return;
  const [data, topo] = await Promise.all([fetchJson("data/tx-counties.json"), fetchJson("geo/tx-counties.json")]);
  COUNTIES = data.counties;
  COUNTY_FEATURES = topojson.feature(topo, topo.objects.counties).features;
  const select = document.getElementById("vote-county");
  select.innerHTML = '<option value="">a county</option>' + [...COUNTIES].sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<option value="${esc(c.fips)}">${esc(c.name)}</option>`).join("");
  const saved = localStorage.getItem("voteCounty");
  if (saved) select.value = saved;
}
async function locateCounty() {
  const card = document.getElementById("vote-county-card");
  if (!navigator.geolocation) { card.textContent = "Your browser does not share location; choose your county from the list."; return; }
  card.textContent = "Finding your county…";
  await loadCounties();
  navigator.geolocation.getCurrentPosition((position) => {
    const point = [position.coords.longitude, position.coords.latitude];
    const feature = COUNTY_FEATURES.find((f) => d3.geoContains(f, point));
    if (!feature) { card.innerHTML = outsideTexasCard(); return; }
    showCounty(feature.properties.fips, true);
    document.getElementById("vote-county").value = feature.properties.fips;
  }, () => { card.textContent = "Location was not shared. Choose your county from the list instead."; }, { timeout: 10000, maximumAge: 600000 });
}
function outsideTexasCard() {
  return `<div class="county">Outside Texas</div><div>Every state votes November 3, 2026, but registration deadlines, early voting, and mail rules differ. Start here:</div><ul class="vote-links"><li><a href="https://vote.gov/" rel="noopener">vote.gov</a>: register, check your registration, see your state's deadlines</li><li><a href="https://www.vote.org/polling-place-locator/" rel="noopener">Vote.org polling place locator</a>: polling places by address, any state</li><li><a href="https://www.usa.gov/election-office" rel="noopener">usa.gov</a>: your state or local election office</li></ul>`;
}
function showCounty(fips, remember) {
  const county = (COUNTIES || []).find((c) => c.fips === fips);
  const card = document.getElementById("vote-county-card");
  if (!county) { card.textContent = ""; return; }
  if (remember) localStorage.setItem("voteCounty", fips);
  const phone = county.phone ? `<a href="tel:${esc(county.phone.replace(/[^\d+]/g, ""))}">${esc(county.phone)}</a>` : "";
  card.innerHTML = `<div class="county">${esc(county.name)} County</div><div>${esc(county.title || "Election office")}${county.official ? `, ${esc(county.official)}` : ""}</div>${county.address ? `<div class="muted">${esc(county.address)}</div>` : ""}<div>${phone}${county.email ? `${phone ? " · " : ""}<a href="mailto:${esc(county.email)}">${esc(county.email)}</a>` : ""}</div>${county.website ? `<div><a href="${esc(county.website)}" rel="noopener">County voting site: polling places and hours</a></div>` : `<div><a href="https://www.sos.state.tx.us/elections/voter/county.shtml#${esc(county.name[0])}" rel="noopener">County office listing at the Secretary of State</a></div>`}`;
}
setupVotePanel();

// ---------- sources ----------
function renderSources(s) {
  const items = [
    ["VoteHub polls feed", "https://votehub.com", s.sources.votehub],
    ["Wikipedia (ratings, polls, districts)", "https://en.wikipedia.org/wiki/2026_United_States_Senate_elections", s.sources.wikipedia],
    ["Wikipedia U.S. House ratings and Texas congressional races", "https://en.wikipedia.org/wiki/2026_United_States_House_of_Representatives_election_ratings", s.sources.wikipedia],
    ["Texas Legislative Council district plans", "https://data.capitol.texas.gov/", { ok: true }],
    ["U.S. state boundaries: us-atlas (U.S. Census)", "https://github.com/topojson/us-atlas", { ok: true }],
  ];
  document.getElementById("sources-list").innerHTML = items.map(([name, url, status]) => `<li><a href="${url}" rel="noopener">${esc(name)}</a>${status?.ok === false ? ` <span class="muted">— fetch failed this run (${esc(status.error || "")}); showing previous values</span>` : ""}</li>`).join("");
}

// ---------- zoom (maps) ----------
function attachZoom(svg, containerId, { width, height }) {
  const content = svg.select("g.zoom-root");
  const zoom = d3.zoom().scaleExtent([1, 14]).translateExtent([[0, 0], [width, height]]).extent([[0, 0], [width, height]])
    .filter((event) => {
      return !event.button; // wheel, pinch, drag, and double-click all zoom or pan
    })
    .on("zoom", (event) => { content.attr("transform", event.transform); content.selectAll("path").attr("stroke-width", 0.8 / event.transform.k); content.selectAll("text").attr("font-size", 9 / Math.sqrt(event.transform.k)); });
  svg.call(zoom);
  const controls = document.querySelector(`.zoom-controls[data-zoom-for="${containerId}"]`);
  if (controls) {
    controls.querySelectorAll("[data-zoom]").forEach((button) => {
      button.onclick = () => {
        if (button.dataset.zoom === "in") svg.transition().duration(200).call(zoom.scaleBy, 1.8);
        else if (button.dataset.zoom === "out") svg.transition().duration(200).call(zoom.scaleBy, 1 / 1.8);
        else svg.transition().duration(250).call(zoom.transform, d3.zoomIdentity);
      };
    });
  }
}

// ---------- tooltip ----------
const tooltip = document.getElementById("tooltip");
function showTooltip(event, html) {
  tooltip.innerHTML = html; tooltip.hidden = false;
  const pad = 14; const { innerWidth, innerHeight } = window;
  const rect = tooltip.getBoundingClientRect();
  let x = event.clientX + pad, y = event.clientY + pad;
  if (x + rect.width > innerWidth - 8) x = event.clientX - rect.width - pad;
  if (y + rect.height > innerHeight - 8) y = event.clientY - rect.height - pad;
  tooltip.style.left = `${Math.max(4, x)}px`; tooltip.style.top = `${Math.max(4, y)}px`;
}
function hideTooltip() { tooltip.hidden = true; }

// ---------- tabs (hash-routed panels) ----------
const PANELS = ["overview", "election-night", "senate-night", "ask", "digest", "senate", "texas", "courts", "house", "tx-senate", "us-house", "governors", "early-vote", "scenarios", "trends", "pollsters", "sources"];
function showPanel(name, { push = true } = {}) {
  const panel = PANELS.includes(name) ? name : name === "needle" ? "election-night" : "overview"; // #needle was the first name
  if (name === "needle") history.replaceState(null, "", "#election-night");
  document.querySelectorAll(".panel").forEach((el) => el.classList.toggle("active", el.dataset.panel === panel));
  document.querySelectorAll(".tabs a").forEach((a) => { const on = a.dataset.tab === panel; a.classList.toggle("active", on); a.setAttribute("aria-current", on ? "page" : "false"); });
  if (push && location.hash !== `#${panel}`) history.replaceState(null, "", `#${panel}${location.search ? "" : ""}`);
  hideTooltip();
}
// Put the top of the active panel right under the sticky tab bar. The tab bar's own offsetTop can't be used:
// while it is stuck it reports its stuck position, which follows the scroll. If the reader is still above
// that point (masthead in view), leave them where they are.
function scrollToPanelTop() {
  const panel = document.querySelector(".panel.active");
  if (!panel) return;
  const tabBarHeight = document.querySelector(".tabs").offsetHeight;
  const panelTop = panel.getBoundingClientRect().top + window.scrollY - tabBarHeight;
  window.scrollTo({ top: Math.min(window.scrollY, Math.max(0, panelTop)), behavior: "auto" });
}
document.querySelectorAll(".tabs a").forEach((a) => a.addEventListener("click", (event) => { event.preventDefault(); showPanel(a.dataset.tab); scrollToPanelTop(); }));
window.addEventListener("hashchange", () => { showPanel(location.hash.slice(1), { push: false }); scrollToPanelTop(); });
// On election night the needle is the front page.
showPanel(location.hash.slice(1) || (needleWindowOpen() ? "election-night" : "overview"), { push: false });
