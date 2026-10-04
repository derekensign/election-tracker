/* 2026 Race Tracker front end. Reads data/latest.json + data/series.json and three TopoJSON files. No build step. */
(async function main() {
  const [snapshot, series, usTopo, houseTopo, senateTopo, congressTopo] = await Promise.all([
    fetchJson("data/latest.json"), fetchJson("data/series.json").catch(() => []),
    fetchJson("geo/us-states.json"), fetchJson("geo/tx-house.json"), fetchJson("geo/tx-senate.json"), fetchJson("geo/tx-congress.json").catch(() => null),
  ]);
  const previousDay = series.length >= 2 ? series[series.length - 2] : null;
  SNAPSHOT = snapshot; PREVIOUS_DAY = previousDay; US_TOPO = usTopo;
  setModel(MODEL);

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
  renderEarlyVote().catch(() => {});
  renderDigest(snapshot);
  renderPollsters(snapshot);
  setupScenarios(snapshot).catch((error) => { document.getElementById("tx-scenario-figures").innerHTML = `<p class="note">Scenario models could not load: ${esc(error.message)}</p>`; });
  renderTrends(snapshot, series);
  renderSources(snapshot);
})().catch((error) => {
  document.getElementById("asof").textContent = `Failed to load data: ${error.message}`;
  console.error(error);
});

// ---------- model toggle (polls vs markets) ----------
const modelParam = new URLSearchParams(location.search).get("model");
let MODEL = (modelParam || localStorage.getItem("model")) === "markets" ? "markets" : "polls";
let SNAPSHOT = null, PREVIOUS_DAY = null, US_TOPO = null;
let SENATE_MAP_MODE = "rating";
/** Selected-model Democratic win probability for a race, with its label. */
function raceProbability(race) {
  if (MODEL === "polls") {
    if (race.pollModel?.pD != null) return { p: race.pollModel.pD, source: race.pollModel.source === "polls" ? "polls" : "rating prior", detail: race.pollModel.source === "polls" ? `σ ${race.pollModel.sigma} · ${race.pollModel.effectiveN} eff. polls` : "no polls" };
    return { p: null, source: null, detail: "no polls" };
  }
  if (race.pD != null) return { p: race.pD, source: race.probabilitySource, detail: race.probabilitySource };
  return { p: null, source: null, detail: "no market" };
}
function previousRaceProbability(prev, raceId) {
  const p = prev?.races?.[raceId];
  if (!p) return null;
  return MODEL === "polls" ? p.pollModel : (p.pm ?? p.ks);
}
function modelName() { return MODEL === "polls" ? "polls model" : "markets"; }
function setModel(model) {
  MODEL = model; localStorage.setItem("model", model);
  document.querySelectorAll("[data-model]").forEach((b) => b.classList.toggle("active", b.dataset.model === model));
  if (!SNAPSHOT) return;
  renderBoard(SNAPSHOT, PREVIOUS_DAY); renderControl(SNAPSHOT, PREVIOUS_DAY); renderSeatChart(SNAPSHOT); renderSenateMap(SNAPSHOT, US_TOPO, PREVIOUS_DAY); renderSenateTables(SNAPSHOT, PREVIOUS_DAY); renderTexas(SNAPSHOT, PREVIOUS_DAY); renderControlStrip(SNAPSHOT, PREVIOUS_DAY); renderGovernors(SNAPSHOT, US_TOPO, PREVIOUS_DAY);
}
document.querySelectorAll("[data-model]").forEach((b) => b.addEventListener("click", () => setModel(b.dataset.model)));
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
    const other = MODEL === "polls" ? { label: "markets", p: race.pD } : { label: "polls model", p: race.pollModel?.pD };
    const prevP = previousRaceProbability(prev, race.id);
    leads.push(`<div class="lead">
      <p class="race"><b>Texas ${esc(race.office === "U.S. Senate" ? "U.S. Senate" : race.office)}</b>, ${esc(lastName(race.democrat))} (D) against ${esc(lastName(race.republican))} (R)</p>
      <div class="big">${pct(sel.p)}<small>chance ${esc(lastName(race.democrat))} wins</small>${delta(sel.p, prevP)}</div>
      ${splitBar(sel.p)}
      <p class="sub">Polling average <b>${marginText(race.pollingAverage?.margin)}</b> across ${race.pollingAverage?.pollCount ?? 0} polls. ${other.p != null ? `The ${other.label} say <b>${pct(other.p)}</b>.` : ""}</p>
    </div>`);
  }
  document.getElementById("board").innerHTML = leads.join("");
  renderControlStrip(s, prev);
}

/** Chamber-control strip under the board: U.S. Senate, U.S. House, Texas House, Texas Senate. */
function renderControlStrip(s, prev) {
  const c = s.senateControl;
  const senateControl = MODEL === "polls" ? c.pollModel?.control?.D : c.derived?.control?.D;
  const senateExpected = MODEL === "polls" ? c.pollModel?.expected : c.derived?.expected;
  const prevSenate = MODEL === "polls" ? prev?.control?.pollModel : prev?.control?.derived;
  const h = s.usHouse;
  const houseControl = MODEL === "polls" ? h?.model?.control?.D : h?.markets?.polymarket?.D;
  const items = [
    { k: "U.S. Senate, Democratic control", v: pct(senateControl) + delta(senateControl, prevSenate), s: `${c.current.democraticCaucus} D to ${c.current.republican} R today; expected ${senateExpected ? senateExpected.D.toFixed(1) : "—"} D seats, 51 needed. ${MODEL === "polls" ? `Markets ${pct(c.polymarket?.D)}.` : `Polls model ${pct(c.pollModel?.control?.D)}.`}` },
    { k: "U.S. House, Democratic control", v: pct(houseControl) + delta(houseControl, MODEL === "polls" ? prev?.usHouse?.control : prev?.usHouse?.polymarket), s: h ? `${h.composition.R} R to ${h.composition.D} D today; ${MODEL === "polls" ? `our model expects ${h.model.expected.D.toFixed(1)} D seats, 218 needed. Polymarket ${pct(h.markets?.polymarket?.D)}.` : `Polymarket; our model ${pct(h.model.control.D)}.`}` : "unavailable" },
    { k: "Texas House, Democratic control", v: pct(s.txHouse.model?.control?.D) + delta(s.txHouse.model?.control?.D, prev?.txHouseModel?.control), s: `${s.txHouse.current.D} D to ${s.txHouse.current.R} R today; our model expects ${s.txHouse.model ? s.txHouse.model.expected.D.toFixed(1) : "—"} D seats, 76 needed.` },
    { k: "Texas Senate, Democratic control", v: pct(s.txSenate.model?.control?.D) + delta(s.txSenate.model?.control?.D, prev?.txSenateModel?.control), s: `${s.txSenate.current.D} D to ${s.txSenate.current.R} R today; our model expects ${s.txSenate.model ? s.txSenate.model.expected.D.toFixed(1) : "—"} D seats, 16 needed.` },
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
  const expectedText = (d) => `expected ${d.expected.D.toFixed(1)} D, ${d.expected.R.toFixed(1)} R${d.expected.other >= 0.05 ? `, ${d.expected.other.toFixed(1)} other` : ""}`;
  const pollsTile = { k: "Polls model, Democratic control", v: pct(pm?.control?.D) + delta(pm?.control?.D, prev?.control?.pollModel), s: pm ? expectedText(pm) : "unavailable", primary: MODEL === "polls" };
  const marketTile = { k: "Market race odds, Democratic control", v: pct(c.derived?.control?.D) + delta(c.derived?.control?.D, prev?.control?.derived), s: expectedText(c.derived), primary: MODEL === "markets" };
  const tiles = [
    { k: "Today", v: `${c.current.democraticCaucus} D, ${c.current.republican} R`, s: "Democratic caucus includes independents Sanders and King" },
    ...(MODEL === "polls" ? [pollsTile, marketTile] : [marketTile, pollsTile]),
    { k: "Polymarket, Democratic control", v: pct(c.polymarket?.D) + delta(c.polymarket?.D, prev?.control?.polymarket), s: c.polymarket ? `$${compact(c.polymarket.volumeUsd)} traded` : "unavailable" },
    { k: "Kalshi seats market, 51 or more D seats", v: pct(c.kalshiSeats?.controlD) + delta(c.kalshiSeats?.controlD, prev?.control?.kalshi), s: c.kalshiSeats ? `${compact(c.kalshiSeats.volumeContracts)} contracts traded` : "unavailable" },
    { k: "U.S. House, Democratic control (Polymarket)", v: pct(c.usHousePolymarket?.D), s: "for context" },
  ];
  document.getElementById("control-tiles").innerHTML = tiles.map((t) => `<div class="figure${t.primary ? " primary" : ""}"><div class="k">${esc(t.k)}</div><div class="v">${t.v}</div><div class="s">${esc(t.s)}</div></div>`).join("");
}

function renderSeatChart(s) {
  const c = s.senateControl;
  const selected = MODEL === "polls" && c.pollModel ? c.pollModel : c.derived;
  const derived = new Map(selected.histogram.map((h) => [h.d, h.probability]));
  const market = new Map();
  for (const bucket of c.kalshiSeats?.buckets || []) {
    const key = bucket.key.startsWith("<") ? `<${bucket.key.slice(1)}` : bucket.key.startsWith(">") ? `>${bucket.key.slice(1)}` : Number(bucket.key);
    market.set(key, bucket.normalized);
  }
  const marketKeys = [...market.keys()];
  const lowBound = marketKeys.find((k) => typeof k === "string" && k.startsWith("<"));
  const highBound = marketKeys.find((k) => typeof k === "string" && k.startsWith(">"));
  const lo = lowBound ? Number(lowBound.slice(1)) : 44;
  const hi = highBound ? Number(highBound.slice(1)) : 58;
  const categories = [];
  if (lowBound) categories.push({ key: lowBound, label: `<${lo}` });
  for (let d = lo; d <= hi; d += 1) categories.push({ key: d, label: String(d) });
  if (highBound) categories.push({ key: highBound, label: `>${hi}` });
  const derivedFor = (cat) => {
    if (typeof cat.key === "string" && cat.key.startsWith("<")) return sum([...derived].filter(([d]) => d < lo).map(([, p]) => p));
    if (typeof cat.key === "string" && cat.key.startsWith(">")) return sum([...derived].filter(([d]) => d > hi).map(([, p]) => p));
    return derived.get(cat.key) || 0;
  };
  const rows = categories.map((cat) => ({ ...cat, market: market.get(cat.key) ?? null, derived: derivedFor(cat) }));
  const seriesDefs = [{ id: "market", name: "Kalshi seats market", color: "#5b5b5b" }, { id: "derived", name: MODEL === "polls" ? "Polls model" : "Derived from market race odds", color: cssVar("--d3") }];
  document.getElementById("seat-chart-title").textContent = `Seat distribution: Democratic caucus seats after the election, ${MODEL === "polls" ? "polls model" : "market-derived"} against the Kalshi market`;
  document.getElementById("seat-legend").innerHTML = seriesDefs.map((d) => `<span><i class="sw" style="background:${d.color}"></i>${d.name}</span>`).join("");

  const width = 900, height = 260, margin = { top: 16, right: 12, bottom: 36, left: 40 };
  const svg = d3.select("#seat-chart").html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", "Probability of each Democratic-caucus seat count");
  const x0 = d3.scaleBand().domain(rows.map((r) => r.label)).range([margin.left, width - margin.right]).paddingInner(0.25);
  const x1 = d3.scaleBand().domain(seriesDefs.map((d) => d.id)).range([0, x0.bandwidth()]).paddingInner(0.08);
  const yMax = Math.max(0.05, d3.max(rows, (r) => Math.max(r.market || 0, r.derived || 0)) * 1.15);
  const y = d3.scaleLinear().domain([0, yMax]).range([height - margin.bottom, margin.top]);
  svg.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", (d) => y(d)).attr("y2", (d) => y(d));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${height - margin.bottom})`).call(d3.axisBottom(x0).tickSize(0)).select(".domain").remove();
  svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(4).tickFormat((d) => `${Math.round(d * 100)}%`).tickSize(0)).select(".domain").remove();
  // Majority marker between 50 and 51
  const idx51 = rows.findIndex((r) => r.key === 51);
  if (idx51 > 0) {
    const xLine = x0(rows[idx51].label) - (x0.step() - x0.bandwidth()) / 2;
    svg.append("line").attr("x1", xLine).attr("x2", xLine).attr("y1", margin.top).attr("y2", height - margin.bottom).attr("stroke", "#111").attr("stroke-dasharray", "3 3");
    svg.append("text").attr("class", "label").attr("x", xLine + 4).attr("y", margin.top + 10).text("51 seats: Democratic majority");
  }
  const groups = svg.append("g").selectAll("g").data(rows).join("g").attr("transform", (r) => `translate(${x0(r.label)},0)`);
  groups.selectAll("rect").data((r) => seriesDefs.map((d) => ({ series: d, value: r[d.id], row: r }))).join("rect")
    .attr("class", "bar").attr("x", (d) => x1(d.series.id)).attr("width", x1.bandwidth())
    .attr("y", (d) => (d.value == null ? y(0) : y(d.value))).attr("height", (d) => (d.value == null ? 0 : y(0) - y(d.value)))
    .attr("rx", 2).attr("fill", (d) => d.series.color)
    .on("mousemove", (event, d) => showTooltip(event, `<b>${d.row.label} Democratic-caucus seats</b><div class="row"><span>${d.series.name}</span><span>${pct(d.value, 1)}</span></div>`))
    .on("mouseleave", hideTooltip);
  // Direct labels on the derived series peaks
  const top = [...rows].sort((a, b) => (b.derived || 0) - (a.derived || 0)).slice(0, 3);
  svg.append("g").selectAll("text").data(top).join("text").attr("class", "label").attr("text-anchor", "middle")
    .attr("x", (r) => x0(r.label) + x1("derived") + x1.bandwidth() / 2).attr("y", (r) => y(r.derived) - 4).text((r) => `${Math.round(r.derived * 100)}%`);
  document.getElementById("seat-note").textContent = `${c.kalshiSeats?.note || ""} The ${MODEL === "polls" ? "polls-model" : "market-derived"} distribution assumes independent races (${s.usSenate.races.length} seats; ${c.notUp.democraticCaucus} D-caucus and ${c.notUp.republican} R seats are not up), so it understates the odds of a uniform swing.`;
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
  rows.push(`<div class="row"><span><b>D win, ${modelName()}</b></span><span><b>${pct(sel.p)}</b>${sel.detail ? ` · ${esc(sel.detail)}` : ""}</span></div>`);
  if (race.pollModel?.pD != null && MODEL !== "polls") rows.push(`<div class="row"><span>D win, polls model</span><span>${pct(race.pollModel.pD)}</span></div>`);
  if (race.pD != null && MODEL !== "markets") rows.push(`<div class="row"><span>D win, markets</span><span>${pct(race.pD)}</span></div>`);
  if (race.pollingAverage) rows.push(`<div class="row"><span>Polling avg (${race.pollingAverage.pollCount} polls)</span><span>${marginText(race.pollingAverage.margin)}${prevRace?.poll != null ? ` (prev ${marginText(prevRace.poll)})` : ""}</span></div>`);
  if (race.odds?.polymarket) rows.push(`<div class="row"><span>Polymarket D win${race.odds.polymarket.thin ? " (thin)" : ""}</span><span>${pct(race.odds.polymarket.D)}${prevRace?.pm != null ? ` (prev ${pct(prevRace.pm)})` : ""}</span></div>`);
  if (race.odds?.kalshi) rows.push(`<div class="row"><span>Kalshi D win${race.odds.kalshi.thin ? " (thin)" : ""}</span><span>${pct(race.odds.kalshi.D)}</span></div>`);
  return rows.join("");
}

function renderSenateTables(s, prev) {
  const races = [...s.usSenate.races];
  const competitiveness = (r) => Math.abs(r.consensus?.score ?? 4) + (raceProbability(r).p != null ? Math.abs(raceProbability(r).p - 0.5) : 0.4);
  races.sort((a, b) => competitiveness(a) - competitiveness(b));
  const battlegrounds = races.filter((r) => Math.abs(r.consensus?.score ?? 4) <= 3 || (r.odds?.polymarket && Math.abs(r.odds.polymarket.D - 0.5) < 0.35));
  const render = (list, table) => {
    const head = `<tr><th>State</th><th>Matchup</th><th>Consensus</th><th title="${esc(s.usSenate.forecasters.map((f) => f.name).join(", "))}">Ratings<span class="sub">${s.usSenate.forecasters.map((f) => esc(shortName(f.name))).join(", ")}</span></th><th class="num">Poll average</th><th class="num">D wins<span class="sub">${esc(modelName())}</span></th><th class="num">Polymarket D</th><th class="num">Kalshi D</th><th>Trend</th></tr>`;
    const body = list.map((r) => {
      const p = prev?.races?.[r.id];
      return `<tr>
        <td><b>${esc(r.state)}</b>${r.special ? ' <span class="muted">sp.</span>' : ""} <span class="muted">${esc(r.incumbentParty || "")}</span></td>
        <td class="wrap">${r.candidates?.D ? `${esc(r.candidates.D)} <span class="muted">(D)</span>` : '<span class="muted">no major Democrat</span>'} / ${esc(r.candidates?.R || "—")} <span class="muted">(R)</span>${r.candidates?.I ? ` / ${esc(r.candidates.I)} <span class="muted">(I)</span>` : ""}</td>
        <td>${ratingPill(r.consensus?.label)}</td>
        <td class="ratings-cell">${s.usSenate.forecasters.map((f) => miniRating(r.ratings[f.key])).join("")}</td>
        <td class="num">${marginText(r.pollingAverage?.margin)}${r.pollingAverage ? `<span class="thin">n=${r.pollingAverage.pollCount}</span>` : ""}${delta(r.pollingAverage?.margin, p?.poll, { scale: 1, unit: "" })}</td>
        <td class="num"><b>${pct(raceProbability(r).p)}</b>${raceProbability(r).source && raceProbability(r).source !== "polls" && raceProbability(r).source !== "polymarket" ? `<span class="thin">${esc(raceProbability(r).source)}</span>` : ""}${delta(raceProbability(r).p, previousRaceProbability(prev, r.id))}</td>
        <td class="num">${pct(r.odds?.polymarket?.D)}${r.odds?.polymarket?.thin ? '<span class="thin">thin</span>' : ""}${delta(r.odds?.polymarket?.D, p?.pm)}</td>
        <td class="num">${pct(r.odds?.kalshi?.D)}${r.odds?.kalshi?.thin ? '<span class="thin">thin</span>' : ""}${delta(r.odds?.kalshi?.D, p?.ks)}</td>
        <td>${sparkline(r.id, MODEL === "polls" ? "pollModel" : "pm")}</td>
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
  const head = `<tr><th>Race</th><th>Democrat</th><th>Republican</th><th class="num">Poll average</th><th>Latest poll</th><th>Ratings</th><th class="num">D wins<span class="sub">${esc(modelName())}</span></th><th class="num">Kalshi D</th><th class="num">Polymarket D</th></tr>`;
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
      <td class="num">${pct(r.odds?.kalshi?.D)}${r.odds?.kalshi?.thin ? '<span class="thin">thin</span>' : ""}${delta(r.odds?.kalshi?.D, p?.ks)}</td>
      <td class="num">${pct(r.odds?.polymarket?.D)}${r.odds?.polymarket?.thin ? '<span class="thin">thin</span>' : ""}${delta(r.odds?.polymarket?.D, p?.pm)}</td>
    </tr>`;
  }).join("");
  document.getElementById("texas-table").innerHTML = head + body;

  const detail = document.getElementById("texas-detail");
  detail.innerHTML = races.map((r) => {
    const weightFor = (poll) => (r.pollingAverage?.weights || []).find((w) => w.id === poll.id || (poll.alsoIds || []).includes(w.id));
    const polls = (r.polls || []).slice(0, 10).map((poll) => { const w = weightFor(poll); return `<tr><td>${esc(poll.pollster)}${poll.partisan ? ` <span class="muted">(${esc(poll.partisan)})</span>` : ""}${poll.internal ? ' <span class="muted">internal</span>' : ""}</td><td>${esc(poll.startDate ? `${fmtDate(poll.startDate)}–${fmtDate(poll.endDate)}` : fmtDate(poll.endDate))}</td><td class="num">${poll.sampleSize ? poll.sampleSize.toLocaleString() : "—"}${poll.population ? ` ${esc(poll.population)}` : ""}</td><td class="num">${poll.dem}%</td><td class="num">${poll.rep}%</td><td class="num"><b>${marginText(poll.dem - poll.rep)}</b></td><td title="${esc(w?.ratedAs ? `538 rating as ${w.ratedAs}` : "not in FiveThirtyEight's ratings")}">${w?.grade ? esc(w.grade) : '<span class="muted">unrated</span>'}</td><td class="num muted">${w ? w.weight.toFixed(2) : "—"}</td><td>${poll.url ? `<a href="${esc(poll.url)}" rel="noopener">source</a>` : ""}</td></tr>`; }).join("");
    const aggregates = (r.aggregates || []).map((a) => `<span class="pill" style="background:#f3f2ee">${esc(a.source)}: ${marginText(a.margin)}</span>`).join(" ");
    const ratingRows = Object.values(r.ratings || {}).map((v) => `<span title="${esc(v.asOf || "")}">${esc(v.name)}: ${ratingPill(v.label)}</span>`).join(", ");
    const statewide = r.id === "tx-senate" && s.texas.statewideDemWins ? `<p class="meta">Kalshi on how many Texas statewide races Democrats win: ${s.texas.statewideDemWins.map((b) => `${esc(b.label.toLowerCase())} ${pct(b.probability)}`).join(", ")}.</p>` : "";
    return `<details class="race-card"><summary>${esc(r.office)}: ${esc(r.democrat)} (D) against ${esc(r.republican)} (R), ${r.polls?.length || 0} polls (<a href="${esc(r.wikipediaUrl)}" rel="noopener">Wikipedia</a>)</summary>
      ${ratingRows ? `<p class="meta">Forecaster ratings: ${ratingRows}</p>` : ""}
      ${aggregates ? `<p class="meta">Published averages: ${aggregates}</p>` : ""}
      ${statewide}
      ${r.pollModel?.pD != null ? `<p class="meta">Polls model: <b>${pct(r.pollModel.pD)} ${esc(lastName(r.democrat))}</b>. Weighted margin ${marginText(r.pollModel.margin)}, error scale ${r.pollModel.sigma} points, ${r.pollModel.effectiveN} effective polls, ${r.pollModel.daysToElection} days to the election.</p>` : ""}
      ${polls ? `<div class="table-scroll"><table class="data"><tr><th>Pollster</th><th>Dates</th><th class="num">Sample</th><th class="num">D</th><th class="num">R</th><th class="num">Margin</th><th>538 grade</th><th class="num">Weight</th><th></th></tr>${polls}</table></div>` : '<p class="meta">No general-election polls found in VoteHub or Wikipedia yet.</p>'}
    </details>`;
  }).join("");
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
    { k: "Our model, Democratic control", v: model ? pct(model.control.D) : "—", s: model ? `expected ${model.expected.D.toFixed(1)} D, ${model.expected.R.toFixed(1)} R${chamber.control?.kalshi ? `; Kalshi market ${pct(chamber.control.kalshi.D)}${chamber.control.kalshi.thin ? " (thin)" : ""}` : ""}` : "unavailable", primary: true },
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
    { k: "Polymarket, Democratic control", v: pct(h.markets?.polymarket?.D) + delta(h.markets?.polymarket?.D, prev?.usHouse?.polymarket), s: h.markets?.polymarket ? `$${compact(h.markets.polymarket.volumeUsd)} traded` : "unavailable" },
    { k: "Kalshi seats market, 218 or more D", v: pct(h.markets?.kalshi?.controlD), s: h.markets?.kalshi ? `${compact(h.markets.kalshi.volumeContracts)} contracts traded` : "unavailable" },
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
  document.getElementById("courts-table").innerHTML = `<tr><th>Court</th><th>Seat</th><th>Matchup</th><th>Incumbent</th><th class="num">D wins<span class="sub">statewide baseline</span></th><th class="num">Kalshi D</th></tr>` +
    judicial.map((r) => `<tr><td>${esc(r.body)}</td><td><b>${esc(r.race)}</b></td><td class="wrap">${nomineeCell(r)}</td><td class="wrap">${esc(r.incumbent || "Open")}${r.incumbentParty ? ` <span class="muted">(${esc(r.incumbentParty)})</span>` : ""}</td><td class="num"><b>${pct(r.pollModel?.pD)}</b></td><td class="num">${r.odds?.kalshi ? `${pct(r.odds.kalshi.D)}${r.odds.kalshi.thin ? '<span class="thin">thin</span>' : ""}` : '<span class="muted">—</span>'}</td></tr>`).join("");
  document.getElementById("sboe-table").innerHTML = `<tr><th>District</th><th>Matchup</th><th>Incumbent</th></tr>` + sboe.map((r) => `<tr><td><b>${esc(r.race)}</b></td><td class="wrap">${nomineeCell(r)}</td><td class="wrap">${esc(r.incumbent || "Open")}${r.incumbentParty ? ` <span class="muted">(${esc(r.incumbentParty)})</span>` : ""}</td></tr>`).join("");
}

// ---------- early vote (hand-entered data file) ----------
async function renderEarlyVote() {
  const data = await fetchJson("data/early-vote.json");
  const days = data.days || [];
  const figures = document.getElementById("early-vote-figures");
  if (!days.length) {
    figures.innerHTML = `<div class="figure"><div class="k">Status</div><div class="v text">Waiting for October 19</div><div class="s">Early voting has not started. The first daily report will appear here once entered.</div></div>`;
    document.getElementById("early-vote-table").innerHTML = "";
    return;
  }
  const last = days[days.length - 1];
  const cumulative = (series) => series.reduce((sum, d) => sum + (d.inPerson || 0) + (d.mail || 0), 0);
  const total = cumulative(days);
  const bench = (year) => { const b = data.benchmarks?.[year]?.days || []; return b.length >= days.length ? cumulative(b.slice(0, days.length)) : null; };
  figures.innerHTML = [
    { k: `Through ${fmtDate(last.date)}, day ${days.length}`, v: total.toLocaleString(), s: data.registeredVoters ? `${(100 * total / data.registeredVoters).toFixed(1)}% of ${data.registeredVoters.toLocaleString()} registered voters` : "ballots cast statewide" },
    { k: "Same day in 2024", v: bench("2024") == null ? "—" : bench("2024").toLocaleString(), s: bench("2024") == null ? "benchmark not entered" : `${total >= bench("2024") ? "ahead" : "behind"} by ${Math.abs(total - bench("2024")).toLocaleString()}` },
    { k: "Same day in 2022", v: bench("2022") == null ? "—" : bench("2022").toLocaleString(), s: bench("2022") == null ? "benchmark not entered" : `${total >= bench("2022") ? "ahead" : "behind"} by ${Math.abs(total - bench("2022")).toLocaleString()}` },
  ].map((t) => `<div class="figure"><div class="k">${esc(t.k)}</div><div class="v">${t.v}</div><div class="s">${esc(t.s)}</div></div>`).join("");
  let running = 0;
  document.getElementById("early-vote-table").innerHTML = `<tr><th>Day</th><th>Date</th><th class="num">In person</th><th class="num">Mail</th><th class="num">Cumulative</th></tr>` + days.map((d, i) => { running += (d.inPerson || 0) + (d.mail || 0); return `<tr><td>${i + 1}</td><td>${fmtDate(d.date)}</td><td class="num">${(d.inPerson || 0).toLocaleString()}</td><td class="num">${(d.mail || 0).toLocaleString()}</td><td class="num"><b>${running.toLocaleString()}</b></td></tr>`; }).join("");
  const grid = document.getElementById("early-vote-charts");
  grid.innerHTML = "";
  const box = document.createElement("div"); box.className = "trend"; box.innerHTML = `<h4>Cumulative ballots by early-voting day</h4><div class="legend"><span><i class="sw" style="background:${cssVar("--d3")}"></i>2026</span><span><i class="sw" style="background:#5b5b5b"></i>2024</span><span><i class="sw" style="background:#b58a00"></i>2022</span></div>`;
  grid.appendChild(box);
  const series = [];
  const cum = (list) => { let r = 0; return list.map((d, i) => ({ date: String(i + 1), value: (r += (d.inPerson || 0) + (d.mail || 0)) })); };
  const lines = [{ name: "2026", color: cssVar("--d3"), data: cum(days) }, { name: "2024", color: "#5b5b5b", data: cum(data.benchmarks?.["2024"]?.days || []) }, { name: "2022", color: "#b58a00", data: cum(data.benchmarks?.["2022"]?.days || []) }].filter((l) => l.data.length);
  const maxLen = Math.max(...lines.map((l) => l.data.length));
  for (let i = 0; i < maxLen; i += 1) series.push({ date: String(i + 1), ...Object.fromEntries(lines.map((l) => [l.name, l.data[i]?.value ?? null])) });
  drawTrend(box, series, { title: "Cumulative ballots", lines: lines.map((l) => ({ name: l.name, color: l.color, get: (d) => d[l.name] })), format: (v) => compact(v), domain: null });
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
  const head = `<tr><th>State</th><th>Matchup</th><th>Consensus</th><th title="${esc(g.forecasters.map((f) => f.name).join(", "))}">Ratings<span class="sub">${g.forecasters.map((f) => esc(shortName(f.name))).join(", ")}</span></th><th class="num">Poll average</th><th class="num">D wins<span class="sub">${esc(modelName())}</span></th><th class="num">Kalshi D</th></tr>`;
  const row = (r) => { const p = prev?.races?.[r.id]; return `<tr><td><b>${esc(r.state)}</b> <span class="muted">${esc(r.incumbentParty || "")}</span></td><td class="wrap">${r.candidates?.D ? `${esc(r.candidates.D)} <span class="muted">(D)</span>` : '<span class="muted">Democrat</span>'} / ${r.candidates?.R ? `${esc(r.candidates.R)} <span class="muted">(R)</span>` : '<span class="muted">Republican</span>'}</td><td>${ratingPill(r.consensus?.label)}</td><td class="ratings-cell">${g.forecasters.map((f) => miniRating(r.ratings[f.key])).join("")}</td><td class="num">${marginText(r.pollingAverage?.margin)}${r.pollingAverage ? `<span class="thin">n=${r.pollingAverage.pollCount}</span>` : ""}${delta(r.pollingAverage?.margin, p?.poll, { scale: 1, unit: "" })}</td><td class="num"><b>${pct(raceProbability(r).p)}</b>${raceProbability(r).source && !["polls", "polymarket", "kalshi"].includes(raceProbability(r).source) ? `<span class="thin">${esc(raceProbability(r).source)}</span>` : ""}${delta(raceProbability(r).p, previousRaceProbability(prev, r.id))}</td><td class="num">${pct(r.odds?.kalshi?.D)}${r.odds?.kalshi?.thin ? '<span class="thin">thin</span>' : ""}${delta(r.odds?.kalshi?.D, p?.ks)}</td></tr>`; };
  document.getElementById("governor-table").innerHTML = head + battlegrounds.map(row).join("");
  document.getElementById("governor-table-all").innerHTML = head + [...g.races].sort((a, b) => a.stateName.localeCompare(b.stateName)).map(row).join("");
}
function governorTooltip(race, g) {
  const rows = [`<b>${esc(race.stateName)} Governor</b>${race.incumbentParty ? ` · ${race.incumbentParty}-held` : ""}${race.incumbent ? ` · ${esc(race.incumbent)}` : ""}`];
  if (race.candidates?.D || race.candidates?.R) rows.push(`${esc(race.candidates.D || "Democrat")} (D) vs ${esc(race.candidates.R || "Republican")} (R)`);
  rows.push("<hr>");
  const sel = raceProbability(race);
  rows.push(`<div class="row"><span><b>D wins, ${modelName()}</b></span><span><b>${pct(sel.p)}</b></span></div>`);
  rows.push(`<div class="row"><span>Consensus rating</span><span>${esc(race.consensus?.label || "—")}</span></div>`);
  for (const f of g.forecasters) if (race.ratings[f.key]) rows.push(`<div class="row"><span>${esc(f.name)}</span><span>${esc(race.ratings[f.key])}</span></div>`);
  if (race.pollingAverage) rows.push(`<div class="row"><span>Polling avg (${race.pollingAverage.pollCount})</span><span>${marginText(race.pollingAverage.margin)}</span></div>`);
  if (race.odds?.kalshi) rows.push(`<div class="row"><span>Kalshi D win</span><span>${pct(race.odds.kalshi.D)}</span></div>`);
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
      window.scrollTo({ top: document.querySelector(".tabs").offsetTop });
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
    { title: "Texas U.S. Senate: Talarico win chance", lines: [{ name: "Polls model", color: cssVar("--d3"), get: (d) => d.races?.["tx-senate"]?.pollModel }, { name: "Polymarket", color: "#5b5b5b", get: (d) => d.races?.["tx-senate"]?.pm }], format: (v) => `${Math.round(v * 100)}%`, domain: [0, 1] },
    { title: "Texas Governor: Hinojosa win chance", lines: [{ name: "Polls model", color: cssVar("--d3"), get: (d) => d.races?.["tx-governor"]?.pollModel }, { name: "Polymarket", color: "#5b5b5b", get: (d) => d.races?.["tx-governor"]?.pm }], format: (v) => `${Math.round(v * 100)}%`, domain: [0, 1] },
    { title: "Texas polling averages, D margin", lines: [{ name: "U.S. Senate", color: cssVar("--d3"), get: (d) => d.races?.["tx-senate"]?.poll }, { name: "Governor", color: "#5b5b5b", get: (d) => d.races?.["tx-governor"]?.poll }], format: (v) => marginText(v), domain: null },
    { title: "U.S. Senate: Democratic control", lines: [{ name: "Polls model", color: cssVar("--d3"), get: (d) => d.control?.pollModel }, { name: "Polymarket", color: "#5b5b5b", get: (d) => d.control?.polymarket }, { name: "Kalshi seats", color: "#b58a00", get: (d) => d.control?.kalshi }], format: (v) => `${Math.round(v * 100)}%`, domain: [0, 1] },
    { title: "Texas House: expected Democratic seats, our model", lines: [{ name: "Expected seats", color: cssVar("--d3"), get: (d) => d.txHouseModel?.expectedD }], format: (v) => v.toFixed(1), domain: null },
    { title: "U.S. House: Democratic control", lines: [{ name: "Our model", color: cssVar("--d3"), get: (d) => d.usHouse?.control }, { name: "Polymarket", color: "#5b5b5b", get: (d) => d.usHouse?.polymarket }], format: (v) => `${Math.round(v * 100)}%`, domain: [0, 1] },
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
  // First visit: show once per phase (before early voting, during, Election Day).
  const phase = toElection === 0 ? "eday" : toEarly > 0 ? "pre" : "early";
  if (localStorage.getItem("voteSeen") !== phase) { localStorage.setItem("voteSeen", phase); open(); }
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
  return `<div class="county">Outside Texas</div><div>Registration, deadlines, and polling places for every state:</div><ul class="vote-links"><li><a href="https://vote.gov/" rel="noopener">vote.gov</a>: register, check registration, state deadlines</li><li><a href="https://www.vote.org/polling-place-locator/" rel="noopener">Vote.org polling place locator</a>: by address</li><li><a href="https://www.usa.gov/election-office" rel="noopener">Find your state or local election office</a></li></ul>`;
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
    ["Polymarket Gamma API", "https://polymarket.com", s.sources.polymarket],
    ["Kalshi public market data", "https://kalshi.com", s.sources.kalshi],
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
document.querySelectorAll(".tabs a").forEach((a) => a.addEventListener("click", (event) => { event.preventDefault(); showPanel(a.dataset.tab); window.scrollTo({ top: Math.min(window.scrollY, document.querySelector(".tabs").offsetTop), behavior: "auto" }); }));
window.addEventListener("hashchange", () => showPanel(location.hash.slice(1), { push: false }));
showPanel(location.hash.slice(1) || "overview", { push: false });
