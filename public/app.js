/* 2026 Race Tracker front end. Reads data/latest.json + data/series.json and three TopoJSON files. No build step. */
(async function main() {
  const [snapshot, series, usTopo, houseTopo, senateTopo, congressTopo] = await Promise.all([
    fetchJson("data/latest.json"), fetchJson("data/series.json").catch(() => []),
    fetchJson("geo/us-states.json"), fetchJson("geo/tx-house.json"), fetchJson("geo/tx-senate.json"), fetchJson("geo/tx-congress.json").catch(() => null),
  ]);
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
let SNAPSHOT = null, PREVIOUS_DAY = null, US_TOPO = null;
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
  const tiles = [
    { k: "Today", v: `${current.D} D, ${current.R} R`, s: `${chamber.majority} seats make a majority; ${chamber.upForElection} seats are up` },
    { k: "Our model, Democratic control", v: model ? pct(model.control.D) : "—", s: model ? `expected ${model.expected.D.toFixed(1)} D, ${model.expected.R.toFixed(1)} R` : "unavailable", primary: true },
    { k: "Statewide environment", v: env ? marginText(env.margin) : "—", s: env ? `generic ballot ${marginText(env.genericBallot)} over ${env.genericBallotPolls} polls; down-ballot races ${marginText(env.downBallotMean)}; swing ${env.swingFrom2024 > 0 ? "D" : "R"}+${Math.abs(env.swingFrom2024).toFixed(1)} from 2024` : "no polls" },
    { k: `Seats rated by ${chamber.ratingSource?.name || "State Navigate"}`, v: String(Object.values(counts).reduce((a, b) => a + b, 0)), s: rated || "none" },
  ];
  const preds = Object.values(chamber.chamberPredictions || {});
  if (preds.length) tiles.push({ k: "Chamber ratings", v: preds.map((p) => p.label).join(", "), s: preds.map((p) => `${p.name}${p.asOf ? ` (${p.asOf})` : ""}`).join("; ") });
  document.getElementById(`${prefix}-tiles`).innerHTML = tiles.map((t) => `<div class="figure"><div class="k">${esc(t.k)}</div><div class="v${/^[\d.,% ]+$|^\d+ D, \d+ R$/.test(t.v) ? "" : " text"}">${esc(t.v)}</div><div class="s">${esc(t.s)}</div></div>`).join("");

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
    if (mode === "model") return district.modelD == null ? cssVar("--notup") : pScale(district.modelD);
    if (mode === "margin") return district.presidentialMargin2024 == null ? cssVar("--notup") : marginScale(district.presidentialMargin2024);
    if (district.rating) return ratingColor(district.rating);
    return district.party === "D" ? cssVar("--d-held") : district.party === "R" ? cssVar("--r-held") : cssVar("--notup");
  };
  const paths = svg.append("g").selectAll("path").data(features).join("path").attr("d", path)
    .attr("class", (f) => (districts.get(f.properties.district)?.rating ? "rated" : ""))
    .on("mousemove", (event, f) => showTooltip(event, districtTooltip(kind, f.properties.district, districts.get(f.properties.district))))
    .on("mouseleave", hideTooltip);
  const labelled = features.filter((f) => { const d = districts.get(f.properties.district); return d && (d.rating || (d.modelD != null && Math.abs(d.modelD - 0.5) < 0.3)) && path.area(f) > 420; });
  svg.append("g").selectAll("text").data(labelled).join("text").attr("class", "state-label").attr("text-anchor", "middle").attr("transform", (f) => `translate(${path.centroid(f)})`).attr("dy", "0.35em").text((f) => f.properties.district);
  const apply = (mode) => {
    paths.attr("fill", (f) => fillFor(districts.get(f.properties.district), mode));
    if (mode === "model") {
      document.getElementById(`${prefix}-legend`).innerHTML = [0.02, 0.15, 0.3, 0.5, 0.7, 0.85, 0.98].map((p) => `<span><i class="sw" style="background:${pScale(p)}"></i>${p === 0.5 ? "50/50" : `${Math.round(p * 100)}% D`}</span>`).join("") + `<span><i class="sw" style="background:${cssVar("--notup")}"></i>Not up / no data</span>`;
      return;
    }
    document.getElementById(`${prefix}-legend`).innerHTML = mode === "margin"
      ? [-60, -30, -10, 0, 10, 30, 60].map((m) => `<span><i class="sw" style="background:${marginScale(m)}"></i>${m === 0 ? "Even" : `${m > 0 ? "Harris" : "Trump"} +${Math.abs(m)}`}</span>`).join("") + `<span><i class="sw" style="background:${cssVar("--notup")}"></i>Not up / no data</span>`
      : RATING_ORDER.filter((r) => counts[r]).map((r) => `<span><i class="sw" style="background:${ratingColor(r)}"></i>${r}</span>`).join("") + `<span><i class="sw" style="background:${cssVar("--d-held")}"></i>D-held, unrated</span><span><i class="sw" style="background:${cssVar("--r-held")}"></i>R-held, unrated</span>` + (kind === "senate" ? `<span><i class="sw" style="background:${cssVar("--notup")}"></i>Not up in 2026</span>` : "");
  };
  apply("model");
  attachZoom(svgRoot, `${prefix}-map`, { width, height });
  renderChamberChart(kind, chamber);
  document.querySelectorAll(`button.mode[data-chamber="${kind}"]`).forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(`button.mode[data-chamber="${kind}"]`).forEach((b) => b.classList.toggle("active", b === button));
    apply(button.dataset.mode);
  }));

  const byCompetitiveness = [...chamber.districts].sort((a, b) => Math.abs((a.modelD ?? 0.5) - 0.5) - Math.abs((b.modelD ?? 0.5) - 0.5) || a.district - b.district);
  const closest = kind === "house" ? byCompetitiveness.slice(0, 24) : byCompetitiveness;
  const headRow = `<tr><th>District</th><th>Incumbent</th><th>Held by</th><th class="num">2024 Pres.</th><th class="num">Model margin</th><th class="num">D wins<span class="sub">our model</span></th><th>Rating${chamber.ratingSource?.asOf ? `<span class="sub">${esc(chamber.ratingSource.name)}, ${esc(chamber.ratingSource.asOf)}</span>` : ""}</th></tr>`;
  const rowFor = (d) => `<tr><td><b>${kind === "house" ? "HD" : "SD"}-${d.district}</b></td><td class="wrap">${esc(d.incumbent || "Open")}${d.retiring ? ' <span class="muted">retiring</span>' : ""}${d.defeatedInPrimary ? ' <span class="muted">lost primary</span>' : ""}</td><td>${esc(d.party || "—")}</td><td class="num">${d.presidentialMargin2024 == null ? "—" : marginText(d.presidentialMargin2024).replace("D+", "Harris +").replace("R+", "Trump +")}</td><td class="num" title="${esc(baselineText(d))}">${d.modelBaseline ? marginText(d.modelBaseline.margin) : "—"}</td><td class="num"><b>${pct(d.modelD)}</b></td><td>${ratingPill(d.rating)}${d.flip ? ' <span class="thin">flip</span>' : ""}</td></tr>`;
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
function renderChamberChart(kind, chamber) { renderSeatHistogram(`tx-${kind}-chart`, `tx-${kind}-chart-title`, chamber.model, `Texas ${kind}`); }
function renderSeatHistogram(containerId, titleId, model, chamberLabel) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!model) { container.innerHTML = '<p class="note">Model unavailable (no environment polls).</p>'; return; }
  const rows = model.histogram.filter((h) => h.probability >= 0.002);
  const width = 760, height = 190, margin = { top: 14, right: 12, bottom: 32, left: 38 };
  const svg = d3.select(container).html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", `Probability of each Democratic seat count in the ${chamberLabel}`);
  const x = d3.scaleBand().domain(rows.map((r) => String(r.d))).range([margin.left, width - margin.right]).paddingInner(0.2);
  const yMax = Math.max(0.05, d3.max(rows, (r) => r.probability) * 1.15);
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
  const notUpCount = model.notUp.D + model.notUp.R;
  document.getElementById(titleId).textContent = `Seat distribution: Democratic seats after the election, our model (expected ${model.expected.D.toFixed(1)}${notUpCount ? `; ${notUpCount} seats ${chamberLabel === "U.S. House" ? "assumed to stay with the party holding them" : "not up"}` : ""})`;
}
function ratingScoreOf(label) { const i = RATING_ORDER.indexOf(label); return i === -1 ? 9 : i - 4; }
function districtTooltip(kind, number, d) {
  const head = `<b>${kind === "house" ? "House" : "Senate"} District ${number}</b>`;
  if (!d) return `${head}<br>${kind === "senate" ? "Not up for election in 2026" : "No data"}`;
  return `${head}<hr><div class="row"><span>Incumbent</span><span>${esc(d.incumbent || "Open")}${d.retiring ? " (retiring)" : ""}</span></div><div class="row"><span>Held by</span><span>${esc(d.party || "—")}</span></div><div class="row"><span>2024 presidential</span><span>${d.presidentialMargin2024 == null ? "—" : marginText(d.presidentialMargin2024).replace("D+", "Harris +").replace("R+", "Trump +")}</span></div>${d.modelD != null ? `<div class="row"><span><b>Our model, D wins</b></span><span><b>${pct(d.modelD)}</b></span></div><div class="row"><span>Model margin</span><span>${marginText(d.modelBaseline?.margin)}</span></div><div class="row"><span>${esc(baselineText(d))}</span></div>` : ""}<div class="row"><span>Rating</span><span>${esc(d.rating || "not rated competitive")}${d.flip ? " (flip)" : ""}</span></div>`;
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
let EARLY_VOTE_YEAR = "2024";
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
    const countyNames = Object.keys(earlyVote.countySources || {}).filter((name) => earlyVote.countySources[name].inPersonDates.length).sort();
    if (countyNames.length) story.push(`The state's feed runs behind for some big counties, so counts for ${esc(listNames(countyNames))} come from their own election offices.`);
    if (latest.notReported.length) story.push(`Not posted yet for day ${latest.dayNumber}: ${esc(listNames(latest.notReported))}. They haven't sent the state their in-person numbers yet, so they're left out of the comparison until they do.`);
  } else {
    story.push("In-person early voting began October 19. The first comparison with 2018 appears once day 1 is fully posted.");
  }
  document.getElementById("early-vote-story").innerHTML = story.map((line) => `<li>${line}</li>`).join("");

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

  // All-county map and table, inside the collapsed section.
  document.querySelectorAll("button.mode[data-ev-year]").forEach((b) => { b.onclick = () => { EARLY_VOTE_YEAR = b.dataset.evYear; renderEarlyVoteCounties(earlyVote); }; });
  document.getElementById("early-vote-show-all").onclick = () => { EARLY_VOTE_SHOW_ALL = !EARLY_VOTE_SHOW_ALL; renderEarlyVoteTable(earlyVote); };
  EARLY_VOTE_TOPO = await fetchJson("geo/tx-counties.json");
  renderEarlyVoteCounties(earlyVote);
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
  const showSameDay2018 = Boolean(earlyVote.pace2018);
  // In person against in person, the same measure as the big-county table: many counties post in-person votes
  // days before mail, so a total-ballots comparison would show false drops. Unposted counties stay gray.
  const bigCountyComparison = new Map((earlyVote.versus2018?.latestCounties || []).map((c) => [c.name, c]));
  const sameDayCell = (c) => {
    const comparison = bigCountyComparison.get(c.name);
    if (!comparison) return '<span class="muted">not in 2018 report</span>';
    if (!comparison.reported) return `${comparison.inPersonRunning.y2018.toLocaleString()} <span class="muted">not posted yet</span>`;
    return `${comparison.inPersonRunning.y2018.toLocaleString()} ${changeChip(comparison.inPersonRunning.change)}`;
  };
  document.getElementById("early-vote-table").innerHTML = `<tr><th>County</th><th class="num">Ballots</th><th class="num">In person</th><th class="num">Mail</th><th class="num">Share of registered</th><th class="num">Share of ${esc(year)} vote</th><th class="num">${esc(election.label)} result</th>${showSameDay2018 ? `<th class="num">In person, same day of 2018</th>` : ""}</tr>`
    + rows.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td class="num"><b>${c.ballots.toLocaleString()}</b></td><td class="num">${c.inPerson.toLocaleString()}</td><td class="num">${c.mail.toLocaleString()}</td><td class="num">${share(c.shareOfRegistered)}</td><td class="num">${share(c.past?.[year]?.share)}</td><td class="num">${partyColored(pastMarginText(c.past?.[year]?.margin, election), c.past?.[year]?.margin)}</td>${showSameDay2018 ? `<td class="num">${sameDayCell(c)}</td>` : ""}</tr>`).join("");
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
const PANELS = ["overview", "digest", "senate", "texas", "courts", "house", "tx-senate", "us-house", "governors", "early-vote", "scenarios", "trends", "pollsters", "sources"];
function showPanel(name, { push = true } = {}) {
  const panel = PANELS.includes(name) ? name : "overview";
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
showPanel(location.hash.slice(1) || "overview", { push: false });
