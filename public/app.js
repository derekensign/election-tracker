/* 2026 Race Tracker front end. Reads data/latest.json + data/series.json and three TopoJSON files. No build step. */
(async function main() {
  const [snapshot, series, usTopo, houseTopo, senateTopo] = await Promise.all([
    fetchJson("data/latest.json"), fetchJson("data/series.json").catch(() => []),
    fetchJson("geo/us-states.json"), fetchJson("geo/tx-house.json"), fetchJson("geo/tx-senate.json"),
  ]);
  const previousDay = series.length >= 2 ? series[series.length - 2] : null;

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
  renderSources(snapshot);
})().catch((error) => {
  document.getElementById("asof").textContent = `Failed to load data: ${error.message}`;
  console.error(error);
});

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
const fmtDate = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
async function fetchJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); }

function ratingPill(label) {
  if (!label) return '<span class="muted">—</span>';
  const dark = DARK_RATINGS.has(label);
  return `<span class="pill ${dark ? "lightink" : ""}" style="background:${ratingColor(label)}">${esc(label)}</span>`;
}
function delta(current, previous, { unit = "pts", scale = 100, digits = 1, higherIsD = true } = {}) {
  if (current == null || previous == null) return "";
  const diff = (current - previous) * scale;
  if (Math.abs(diff) < 0.05) return '<span class="delta flat">·</span>';
  const cls = (diff > 0) === higherIsD ? "up" : "down";
  return `<span class="delta ${cls}" title="change since previous update">${diff > 0 ? "▲" : "▼"} ${Math.abs(diff).toFixed(digits)} ${unit}</span>`;
}

// ---------- header & moves ----------
function renderHeader(s) {
  const generated = new Date(s.generatedAt);
  const stamp = generated.toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "full", timeStyle: "short" });
  const failed = Object.entries(s.sources).filter(([, v]) => !v.ok).map(([k]) => k);
  document.getElementById("asof").textContent = `Snapshot ${s.asOf} · generated ${stamp} CT${s.previousAsOf ? ` · compared with ${s.previousAsOf}` : ""}${failed.length ? ` · stale sources: ${failed.join(", ")}` : ""}`;
}
function renderMoves(s) {
  const list = document.getElementById("moves-list");
  if (!s.changes?.length) { list.innerHTML = '<li><span class="tag">quiet</span>No changes crossed the alert thresholds.</li>'; return; }
  list.innerHTML = s.changes.slice(0, 30).map((c) => `<li><span class="tag ${esc(c.type)}">${esc(labelForType(c.type))}</span><span>${esc(c.text)}</span></li>`).join("");
}
function labelForType(type) { return { rating: "rating", market: "market", poll: "new poll", "poll-average": "poll avg", control: "control", baseline: "baseline" }[type] || type; }

// ---------- senate control ----------
function renderControl(s, prev) {
  const c = s.senateControl;
  const tiles = [
    { k: "Now", v: `${c.current.democraticCaucus} D · ${c.current.republican} R`, s: "Democratic caucus incl. Sanders & King" },
    { k: "Polymarket: D control", v: pct(c.polymarket?.D) + delta(c.polymarket?.D, prev?.control?.polymarket), s: c.polymarket ? `$${compact(c.polymarket.volumeUsd)} traded` : "unavailable" },
    { k: "Kalshi seats market: D ≥ 51", v: pct(c.kalshiSeats?.controlD) + delta(c.kalshiSeats?.controlD, prev?.control?.kalshi), s: c.kalshiSeats ? `${compact(c.kalshiSeats.volumeContracts)} contracts` : "unavailable" },
    { k: "Derived from race odds: D control", v: pct(c.derived?.control?.D) + delta(c.derived?.control?.D, prev?.control?.derived), s: `expected ${c.derived.expected.D.toFixed(1)} D · ${c.derived.expected.R.toFixed(1)} R${c.derived.expected.other >= 0.05 ? ` · ${c.derived.expected.other.toFixed(1)} other` : ""}` },
    { k: "U.S. House: D control (Polymarket)", v: pct(c.usHousePolymarket?.D), s: "for context" },
  ];
  document.getElementById("control-tiles").innerHTML = tiles.map((t) => `<div class="tile"><div class="k">${esc(t.k)}</div><div class="v">${t.v}</div><div class="s">${esc(t.s)}</div></div>`).join("");
}

function renderSeatChart(s) {
  const c = s.senateControl;
  const derived = new Map(c.derived.histogram.map((h) => [h.d, h.probability]));
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
  const seriesDefs = [{ id: "market", name: "Kalshi seats market", color: "#5b5b5b" }, { id: "derived", name: "Derived from race odds", color: cssVar("--d3") }];
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
    svg.append("text").attr("class", "label").attr("x", xLine + 4).attr("y", margin.top + 10).text("D majority at 51 →");
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
  document.getElementById("seat-note").textContent = `${c.kalshiSeats?.note || ""} Derived distribution assumes independent races (${s.usSenate.races.length} seats; ${c.notUp.democraticCaucus} D-caucus and ${c.notUp.republican} R seats are not up).`;
}
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

// ---------- senate map ----------
function renderRatingLegend() {
  document.getElementById("rating-legend").innerHTML = RATING_ORDER.map((r) => `<span><i class="sw" style="background:${ratingColor(r)}"></i>${r}</span>`).join("") + `<span><i class="sw" style="background:${cssVar("--notup")}"></i>Not up in 2026</span>`;
}
function renderSenateMap(s, topo, prev) {
  const byState = new Map(s.usSenate.races.map((r) => [r.state, r]));
  const width = 960, height = 560;
  const svg = d3.select("#senate-map").html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", "U.S. Senate race ratings by state");
  const features = topojson.feature(topo, topo.objects.states).features.filter((f) => FIPS_TO_STATE[f.id] && FIPS_TO_STATE[f.id] !== "DC");
  const projection = d3.geoAlbersUsa().fitSize([width, height], { type: "FeatureCollection", features });
  const path = d3.geoPath(projection);
  svg.append("g").selectAll("path").data(features).join("path")
    .attr("d", path)
    .attr("fill", (f) => { const race = byState.get(FIPS_TO_STATE[f.id]); return race ? ratingColor(race.consensus?.label) : cssVar("--notup"); })
    .attr("class", (f) => (byState.has(FIPS_TO_STATE[f.id]) ? "rated" : ""))
    .on("mousemove", (event, f) => { const race = byState.get(FIPS_TO_STATE[f.id]); showTooltip(event, race ? senateTooltip(race, s, prev) : `<b>${esc(f.properties.name)}</b><br>No Senate seat up in 2026`); })
    .on("mouseleave", hideTooltip);
  svg.append("g").selectAll("text").data(features.filter((f) => byState.has(FIPS_TO_STATE[f.id]))).join("text")
    .attr("class", "state-label").attr("text-anchor", "middle").attr("transform", (f) => `translate(${path.centroid(f)})`).attr("dy", "0.35em")
    .attr("fill", (f) => (DARK_RATINGS.has(byState.get(FIPS_TO_STATE[f.id]).consensus?.label) ? "#fff" : "#111"))
    .text((f) => FIPS_TO_STATE[f.id]);
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
  if (race.pollingAverage) rows.push(`<div class="row"><span>Polling avg (${race.pollingAverage.pollCount} polls)</span><span>${marginText(race.pollingAverage.margin)}${prevRace?.poll != null ? ` (prev ${marginText(prevRace.poll)})` : ""}</span></div>`);
  if (race.odds?.polymarket) rows.push(`<div class="row"><span>Polymarket D win${race.odds.polymarket.thin ? " (thin)" : ""}</span><span>${pct(race.odds.polymarket.D)}${prevRace?.pm != null ? ` (prev ${pct(prevRace.pm)})` : ""}</span></div>`);
  if (race.odds?.kalshi) rows.push(`<div class="row"><span>Kalshi D win${race.odds.kalshi.thin ? " (thin)" : ""}</span><span>${pct(race.odds.kalshi.D)}</span></div>`);
  return rows.join("");
}

function renderSenateTables(s, prev) {
  const races = [...s.usSenate.races];
  const competitiveness = (r) => Math.abs(r.consensus?.score ?? 4) + (r.odds?.polymarket ? Math.abs((r.odds.polymarket.D ?? 0.5) - 0.5) : 0.4);
  races.sort((a, b) => competitiveness(a) - competitiveness(b));
  const battlegrounds = races.filter((r) => Math.abs(r.consensus?.score ?? 4) <= 3 || (r.odds?.polymarket && Math.abs(r.odds.polymarket.D - 0.5) < 0.35));
  const render = (list, table) => {
    const head = `<tr><th>State</th><th>Matchup</th><th>Consensus</th><th title="${esc(s.usSenate.forecasters.map((f) => f.name).join(", "))}">Ratings<br><span class="muted" style="font-weight:400;text-transform:none;letter-spacing:0">${s.usSenate.forecasters.map((f) => esc(shortName(f.name))).join(" · ")}</span></th><th class="num">Poll avg</th><th class="num">Polymarket D</th><th class="num">Kalshi D</th><th>Trend</th></tr>`;
    const body = list.map((r) => {
      const p = prev?.races?.[r.id];
      return `<tr>
        <td><b>${esc(r.state)}</b>${r.special ? ' <span class="muted">sp.</span>' : ""} <span class="muted">${esc(r.incumbentParty || "")}</span></td>
        <td class="wrap">${r.candidates?.D ? `${esc(r.candidates.D)} <span class="muted">(D)</span>` : '<span class="muted">no major Democrat</span>'} / ${esc(r.candidates?.R || "—")} <span class="muted">(R)</span>${r.candidates?.I ? ` / ${esc(r.candidates.I)} <span class="muted">(I)</span>` : ""}</td>
        <td>${ratingPill(r.consensus?.label)}</td>
        <td class="ratings-cell">${s.usSenate.forecasters.map((f) => miniRating(r.ratings[f.key])).join("")}</td>
        <td class="num">${marginText(r.pollingAverage?.margin)}${r.pollingAverage ? `<span class="thin">n=${r.pollingAverage.pollCount}</span>` : ""}${delta(r.pollingAverage?.margin, p?.poll, { scale: 1, unit: "" })}</td>
        <td class="num">${pct(r.odds?.polymarket?.D)}${r.odds?.polymarket?.thin ? '<span class="thin">thin</span>' : ""}${delta(r.odds?.polymarket?.D, p?.pm)}</td>
        <td class="num">${pct(r.odds?.kalshi?.D)}${r.odds?.kalshi?.thin ? '<span class="thin">thin</span>' : ""}${delta(r.odds?.kalshi?.D, p?.ks)}</td>
        <td>${sparkline(r.id, "pm")}</td>
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
  const head = `<tr><th>Race</th><th>Democrat</th><th>Republican</th><th class="num">Poll avg</th><th>Latest poll</th><th>Ratings</th><th class="num">Kalshi D</th><th class="num">Polymarket D</th></tr>`;
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
      <td class="num">${pct(r.odds?.kalshi?.D)}${r.odds?.kalshi?.thin ? '<span class="thin">thin</span>' : ""}${delta(r.odds?.kalshi?.D, p?.ks)}</td>
      <td class="num">${pct(r.odds?.polymarket?.D)}${r.odds?.polymarket?.thin ? '<span class="thin">thin</span>' : ""}${delta(r.odds?.polymarket?.D, p?.pm)}</td>
    </tr>`;
  }).join("");
  document.getElementById("texas-table").innerHTML = head + body;

  const detail = document.getElementById("texas-detail");
  detail.innerHTML = races.map((r) => {
    const polls = (r.polls || []).slice(0, 8).map((poll) => `<tr><td>${esc(poll.pollster)}${poll.partisan ? ` <span class="muted">(${esc(poll.partisan)})</span>` : ""}${poll.internal ? ' <span class="muted">internal</span>' : ""}</td><td>${esc(poll.startDate ? `${fmtDate(poll.startDate)}–${fmtDate(poll.endDate)}` : fmtDate(poll.endDate))}</td><td class="num">${poll.sampleSize ? poll.sampleSize.toLocaleString() : "—"}${poll.population ? ` ${esc(poll.population)}` : ""}</td><td class="num">${poll.dem}%</td><td class="num">${poll.rep}%</td><td class="num"><b>${marginText(poll.dem - poll.rep)}</b></td><td>${poll.url ? `<a href="${esc(poll.url)}" rel="noopener">source</a>` : ""}</td></tr>`).join("");
    const aggregates = (r.aggregates || []).map((a) => `<span class="pill" style="background:#f3f2ee">${esc(a.source)}: ${marginText(a.margin)}</span>`).join(" ");
    const ratingRows = Object.values(r.ratings || {}).map((v) => `<span title="${esc(v.asOf || "")}">${esc(v.name)}: ${ratingPill(v.label)}</span>`).join(" · ");
    const statewide = r.id === "tx-senate" && s.texas.statewideDemWins ? `<p class="meta">Kalshi, number of Texas statewide races Democrats win: ${s.texas.statewideDemWins.map((b) => `${esc(b.label)} ${pct(b.probability)}`).join(" · ")}</p>` : "";
    return `<details class="race-card"><summary>${esc(r.office)}: ${esc(r.democrat)} (D) vs ${esc(r.republican)} (R) — ${r.polls?.length || 0} polls · <a href="${esc(r.wikipediaUrl)}" rel="noopener">Wikipedia</a></summary>
      ${ratingRows ? `<p class="meta">Forecaster ratings: ${ratingRows}</p>` : ""}
      ${aggregates ? `<p class="meta">Published averages: ${aggregates}</p>` : ""}
      ${statewide}
      ${polls ? `<div class="table-scroll"><table class="data"><tr><th>Pollster</th><th>Dates</th><th class="num">Sample</th><th class="num">D</th><th class="num">R</th><th class="num">Margin</th><th></th></tr>${polls}</table></div>` : '<p class="meta">No general-election polls found in VoteHub or Wikipedia yet.</p>'}
    </details>`;
  }).join("");
}

// ---------- texas legislature ----------
function renderChamber(kind, chamber, topo, s) {
  const prefix = `tx-${kind}`;
  const districts = new Map(chamber.districts.map((d) => [d.district, d]));
  const current = chamber.current;
  const counts = chamber.summary.ratingCounts || {};
  const rated = Object.entries(counts).sort((a, b) => RATING_ORDER.indexOf(a[0]) - RATING_ORDER.indexOf(b[0])).map(([k, v]) => `${v} ${k}`).join(" · ");
  const tiles = [
    { k: "Now", v: `${current.D} D · ${current.R} R`, s: `${chamber.majority} needed for a majority · ${chamber.upForElection} seats up` },
    { k: `Rated seats (${chamber.ratingSource?.name || "State Navigate"})`, v: String(Object.values(counts).reduce((a, b) => a + b, 0)), s: rated || "none" },
    { k: "Rating-implied D seats", v: chamber.summary.expectedD?.toFixed(1) ?? "—", s: "Safe 98.5% · Likely 90% · Lean 75% · Tilt 60%; unrated seats hold" },
  ];
  if (chamber.control?.kalshi) tiles.push({ k: "Kalshi: D control", v: pct(chamber.control.kalshi.D), s: `${chamber.control.kalshi.volumeContracts.toLocaleString()} contracts${chamber.control.kalshi.thin ? " · thin" : ""}` });
  const preds = Object.values(chamber.chamberPredictions || {});
  if (preds.length) tiles.push({ k: "Chamber ratings", v: preds.map((p) => p.label).join(" / "), s: preds.map((p) => `${p.name}${p.asOf ? ` (${p.asOf})` : ""}`).join(" · ") });
  document.getElementById(`${prefix}-tiles`).innerHTML = tiles.map((t) => `<div class="tile"><div class="k">${esc(t.k)}</div><div class="v">${esc(t.v)}</div><div class="s">${esc(t.s)}</div></div>`).join("");

  const width = 800, height = 760;
  const svg = d3.select(`#${prefix}-map`).html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", `Texas ${kind} districts`);
  const features = topojson.feature(topo, topo.objects.districts).features;
  const projection = d3.geoMercator().fitSize([width, height], { type: "FeatureCollection", features });
  const path = d3.geoPath(projection);
  const marginScale = d3.scaleDiverging().domain([-60, 0, 60]).interpolator((t) => d3.interpolateRgbBasis([cssVar("--r4"), cssVar("--r2"), "#f2f2f0", cssVar("--d2"), cssVar("--d4")])(t));
  const fillFor = (district, mode) => {
    if (!district) return cssVar("--notup");
    if (mode === "margin") return district.presidentialMargin2024 == null ? cssVar("--notup") : marginScale(district.presidentialMargin2024);
    if (district.rating) return ratingColor(district.rating);
    return district.party === "D" ? cssVar("--d-held") : district.party === "R" ? cssVar("--r-held") : cssVar("--notup");
  };
  const paths = svg.append("g").selectAll("path").data(features).join("path").attr("d", path)
    .attr("class", (f) => (districts.get(f.properties.district)?.rating ? "rated" : ""))
    .on("mousemove", (event, f) => showTooltip(event, districtTooltip(kind, f.properties.district, districts.get(f.properties.district))))
    .on("mouseleave", hideTooltip);
  const labelled = features.filter((f) => districts.get(f.properties.district)?.rating && path.area(f) > 420);
  svg.append("g").selectAll("text").data(labelled).join("text").attr("class", "state-label").attr("text-anchor", "middle").attr("transform", (f) => `translate(${path.centroid(f)})`).attr("dy", "0.35em").text((f) => f.properties.district);
  const apply = (mode) => {
    paths.attr("fill", (f) => fillFor(districts.get(f.properties.district), mode));
    document.getElementById(`${prefix}-legend`).innerHTML = mode === "margin"
      ? [-60, -30, -10, 0, 10, 30, 60].map((m) => `<span><i class="sw" style="background:${marginScale(m)}"></i>${m === 0 ? "Even" : `${m > 0 ? "Harris" : "Trump"} +${Math.abs(m)}`}</span>`).join("") + `<span><i class="sw" style="background:${cssVar("--notup")}"></i>Not up / no data</span>`
      : RATING_ORDER.filter((r) => counts[r]).map((r) => `<span><i class="sw" style="background:${ratingColor(r)}"></i>${r}</span>`).join("") + `<span><i class="sw" style="background:${cssVar("--d-held")}"></i>D-held, unrated</span><span><i class="sw" style="background:${cssVar("--r-held")}"></i>R-held, unrated</span>` + (kind === "senate" ? `<span><i class="sw" style="background:${cssVar("--notup")}"></i>Not up in 2026</span>` : "");
  };
  apply("rating");
  document.querySelectorAll(`button.mode[data-chamber="${kind}"]`).forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(`button.mode[data-chamber="${kind}"]`).forEach((b) => b.classList.toggle("active", b === button));
    apply(button.dataset.mode);
  }));

  const list = chamber.districts.filter((d) => d.rating || kind === "senate").sort((a, b) => (Math.abs(ratingScoreOf(a.rating)) - Math.abs(ratingScoreOf(b.rating))) || a.district - b.district);
  document.getElementById(`${prefix}-table`).innerHTML = `<tr><th>District</th><th>Incumbent</th><th>Held by</th><th class="num">2024 Pres.</th><th>Rating${chamber.ratingSource?.asOf ? ` <span class="muted">(${esc(chamber.ratingSource.name)}, ${esc(chamber.ratingSource.asOf)})</span>` : ""}</th></tr>` +
    list.map((d) => `<tr><td><b>${kind === "house" ? "HD" : "SD"}-${d.district}</b></td><td>${esc(d.incumbent || "Open")}${d.retiring ? ' <span class="muted">retiring</span>' : ""}${d.defeatedInPrimary ? ' <span class="muted">lost primary</span>' : ""}</td><td>${esc(d.party || "—")}</td><td class="num">${d.presidentialMargin2024 == null ? "—" : marginText(d.presidentialMargin2024).replace("D+", "Harris +").replace("R+", "Trump +")}</td><td>${ratingPill(d.rating)}${d.flip ? ' <span class="thin">flip</span>' : ""}</td></tr>`).join("");
}
function ratingScoreOf(label) { const i = RATING_ORDER.indexOf(label); return i === -1 ? 9 : i - 4; }
function districtTooltip(kind, number, d) {
  const head = `<b>${kind === "house" ? "House" : "Senate"} District ${number}</b>`;
  if (!d) return `${head}<br>${kind === "senate" ? "Not up for election in 2026" : "No data"}`;
  return `${head}<hr><div class="row"><span>Incumbent</span><span>${esc(d.incumbent || "Open")}${d.retiring ? " (retiring)" : ""}</span></div><div class="row"><span>Held by</span><span>${esc(d.party || "—")}</span></div><div class="row"><span>2024 presidential</span><span>${d.presidentialMargin2024 == null ? "—" : marginText(d.presidentialMargin2024).replace("D+", "Harris +").replace("R+", "Trump +")}</span></div><div class="row"><span>Rating</span><span>${esc(d.rating || "not rated competitive")}${d.flip ? " (flip)" : ""}</span></div>`;
}

// ---------- sources ----------
function renderSources(s) {
  const items = [
    ["Polymarket Gamma API", "https://polymarket.com", s.sources.polymarket],
    ["Kalshi public market data", "https://kalshi.com", s.sources.kalshi],
    ["VoteHub polls feed", "https://votehub.com", s.sources.votehub],
    ["Wikipedia (ratings, polls, districts)", "https://en.wikipedia.org/wiki/2026_United_States_Senate_elections", s.sources.wikipedia],
    ["Texas Legislative Council district plans", "https://data.capitol.texas.gov/", { ok: true }],
    ["U.S. state boundaries: us-atlas (U.S. Census)", "https://github.com/topojson/us-atlas", { ok: true }],
  ];
  document.getElementById("sources-list").innerHTML = items.map(([name, url, status]) => `<li><a href="${url}" rel="noopener">${esc(name)}</a>${status?.ok === false ? ` <span class="muted">— fetch failed this run (${esc(status.error || "")}); showing previous values</span>` : ""}</li>`).join("");
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
