/* How Texas flipped: the 2026 results page (the "texas-2026" tab). Draws data/tx-2026-analysis.json, which
   ingest/texas-2026-analysis.js builds from the state's count, past results, the exit poll, and our final polls.
   Uses app.js's shared helpers: fetchJson, esc, pct, marginText, cssVar, showTooltip, hideTooltip, attachZoom. */
(async function renderTexas2026() {
  const root = document.getElementById("texas-2026-section");
  if (!root) return;
  let data, topo;
  try {
    [data, topo] = await Promise.all([fetchJson("data/tx-2026-analysis.json"), fetchJson("geo/tx-counties.json")]);
  } catch (error) {
    document.getElementById("tx26-asof").textContent = `The analysis didn't load (${error.message}).`;
    return;
  }

  // ---------- formatting ----------
  const byId = (id) => document.getElementById(id);
  const lastName = (name) => String(name || "").split(" ").at(-1);
  const votesText = (n) => Number(n).toLocaleString("en-US");
  const roughVotes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} million` : `${(Math.round(n / 1e3) * 1e3).toLocaleString("en-US")}`);
  const ratioText = (r) => `${Math.round(r * 100)}%`;
  const listText = (items) => (items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`);
  const plus = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
  const leanClass = (m) => (m > 0 ? "lean-d" : m < 0 ? "lean-r" : "");
  const leanSpan = (m) => `<span class="${leanClass(m)}">${esc(marginText(m))}</span>`;
  // Exit-poll margins are whole points.
  const wholeLean = (m) => `<span class="${leanClass(m)}">${m === 0 ? "Even" : `${m > 0 ? "D" : "R"}+${Math.abs(m)}`}</span>`;
  const countyKeyOf = (name) => String(name).toUpperCase().replace(/[^A-Z]/g, "");
  const shortRegion = { "Big cities": "Big cities", "Rio Grande Valley and border": "Valley and border", Suburbs: "Suburbs", "Midsize cities": "Midsize cities", "Rural and small-town": "Rural and small-town" };
  // Charts are drawn at their real width so text stays readable on a phone; 760 is the widest layout.
  const chartWidth = (id) => Math.round(Math.max(330, Math.min(760, byId(id).clientWidth || document.querySelector("main").clientWidth - 40)));
  const wrapWords = (text, maxChars) => text.split(" ").reduce((lines, word) => {
    if (lines.length && `${lines.at(-1)} ${word}`.length <= maxChars) lines[lines.length - 1] += ` ${word}`;
    else lines.push(word);
    return lines;
  }, []);
  const redraws = [];
  const marginScale = (domain) => d3.scaleDiverging().domain([-domain, 0, domain]).clamp(true).interpolator((t) => d3.interpolateRgbBasis([cssVar("--r4"), cssVar("--r2"), "#f2f2f0", cssVar("--d2"), cssVar("--d4")])(t));

  const races = Object.fromEntries(data.statewide.map((race) => [race.id, race]));
  const senate = races["tx-senate"], governor = races["tx-governor"];
  const prior = data.baselines["2024"], midterm = data.baselines["2022"];
  const exit = data.exitPoll.races;
  const turnout = Math.max(...data.statewide.map((race) => race.total));
  const regionOf = Object.fromEntries(data.regions.map((region) => [region.region, region]));
  const counties = new Map(data.counties.map((county) => [county.key, county]));
  const border = regionOf["Rio Grande Valley and border"], suburbs = regionOf.Suburbs, cities = regionOf["Big cities"];

  byId("tx26-asof").innerHTML = `Unofficial returns from the Texas Secretary of State, all 254 counties, last updated ${esc(data.lastUpdated || "—")}. Exit poll: <a href="${esc(exit["tx-senate"].url)}">ABC News, Senate</a> and <a href="${esc(exit["tx-governor"].url)}">governor</a>, read ${esc(data.exitPoll.retrieved)}. Final polls: our ${esc(data.pollsAsOf || "")} snapshot.`;
  const offices = data.offices?.length ? data.offices : data.statewide.map((r) => ({ office: r.office, democrat: r.democrat, republican: r.republican, winner: r.margin > 0 ? "D" : "R", margin: r.margin }));
  const officesWon = offices.filter((o) => o.winner === "D").length;
  byId("tx26-dek").textContent = `Two years after Donald Trump carried Texas by ${Math.abs(prior.margin).toFixed(1)} points, Democrats won ${officesWon === offices.length ? `every statewide race on the ballot, all ${offices.length} of them, courts included` : `${officesWon} of the ${offices.length} statewide races on the ballot`}. James Talarico became the first Democrat to win a Texas Senate race since Lloyd Bentsen in 1988, and Gina Hinojosa the first Democrat elected governor since Ann Richards in 1990. Here is where those votes came from.`;

  // ---------- headline figures ----------
  const lowest = [...offices].sort((a, b) => a.margin - b.margin)[0];
  const house = data.txHouse, houseWon = house.districts.reduce((t, d) => ({ ...t, [d.party]: (t[d.party] || 0) + 1 }), {});
  const houseFlips = house.districts.filter((d) => d.flipped);
  const usWon = data.usHouse.districts.reduce((t, d) => ({ ...t, [d.party]: (t[d.party] || 0) + 1 }), {});
  const tiles = [
    { k: `U.S. Senate: ${senate.democrat}`, v: marginText(senate.margin), s: `${votesText(senate.dem)} to ${votesText(senate.rep)} for ${senate.republican}; a ${(senate.margin - prior.margin).toFixed(1)}-point swing from 2024`, primary: true },
    { k: `Governor: ${governor.democrat}`, v: marginText(governor.margin), s: `${votesText(governor.dem)} to ${votesText(governor.rep)} for ${governor.republican}` },
    { k: "Statewide races won by Democrats", v: `${officesWon} of ${offices.length}`, s: `the closest by ${Math.abs(lowest.margin).toFixed(1)} points: ${lowest.office}` },
    { k: "Votes for governor", v: `${(turnout / 1e6).toFixed(2)}M`, s: `${data.registered ? `${Math.round((100 * turnout) / data.registered)}% of registered voters; ` : ""}${ratioText(turnout / prior.total)} of 2024's presidential vote, ${ratioText(turnout / midterm.total)} of 2022's` },
    { k: "Texas House", v: `${houseWon.D || 0} D, ${houseWon.R || 0} R`, s: `was ${house.before?.D} D, ${house.before?.R} R; ${houseFlips.length} seats flipped, all to Democrats` },
    { k: "U.S. House, Texas", v: `${usWon.D || 0} D, ${usWon.R || 0} R`, s: `under the 2025 map; our model expected ${data.usHouse.modelExpectedD.toFixed(1)} Democratic seats` },
  ];
  byId("tx26-tiles").innerHTML = tiles.map((t) => `<div class="figure${t.primary ? " primary" : ""}"><div class="k">${esc(t.k)}</div><div class="v">${esc(t.v)}</div><div class="s">${esc(t.s)}</div></div>`).join("");

  // ---------- where the votes came from ----------
  const vote2024 = (raceId) => exit[raceId].questions.vote2024.answers;
  const groupName = { "Kamala Harris (Dem)": "Harris voters", "Donald Trump (Rep)": "Trump voters", Other: "Third-party voters", "Did not vote": "Didn't vote in 2024" };
  const groupColor = { "Kamala Harris (Dem)": cssVar("--d3"), "Donald Trump (Rep)": cssVar("--r3"), Other: "#b9bec6", "Did not vote": cssVar("--ink-2") };
  const sAnswers = vote2024("tx-senate"), gAnswers = vote2024("tx-governor");
  const answer = (answers, label) => answers.find((a) => a.label === label);
  const sTrump = answer(sAnswers, "Donald Trump (Rep)"), sNone = answer(sAnswers, "Did not vote"), gTrump = answer(gAnswers, "Donald Trump (Rep)");
  const talaricoCoalition = data.swing["tx-senate"].coalitions.dem, hinojosaCoalition = data.swing["tx-governor"].coalitions.dem;
  const part = (list, label) => list.find((p) => p.label === label);
  byId("tx26-sources-note").innerHTML = `The exit poll asked voters how they voted in 2024. About one in nine Trump voters (${sTrump.dem}%) voted for ${lastName(senate.democrat)}, and one in ten (${gTrump.dem}%) for ${lastName(governor.democrat)}. People who didn't vote in 2024 were ${sNone.share}% of this year's voters and went ${sNone.dem}–${sNone.rep} for ${lastName(senate.democrat)}. Most of ${lastName(senate.democrat)}'s votes still came from Harris voters: about ${roughVotes(part(talaricoCoalition, "Kamala Harris (Dem)").votes)} of his ${roughVotes(senate.dem)}. Trump voters gave him about ${roughVotes(part(talaricoCoalition, "Donald Trump (Rep)").votes)}, and 2024 non-voters about ${roughVotes(part(talaricoCoalition, "Did not vote").votes)}.`;
  byId("tx26-vote2024").innerHTML = `<tr><th>How they voted in 2024</th><th class="num">Share of 2026 voters</th><th class="num">${esc(lastName(senate.democrat))}</th><th class="num">${esc(lastName(senate.republican))}</th><th class="num">${esc(lastName(governor.democrat))}</th><th class="num">${esc(lastName(governor.republican))}</th></tr>`
    + sAnswers.map((a) => { const g = answer(gAnswers, a.label); return `<tr><td><i class="sw" style="background:${groupColor[a.label]}"></i> ${esc(groupName[a.label] || a.label)}</td><td class="num">${a.share}%</td><td class="num"><b>${a.dem}%</b></td><td class="num">${a.rep}%</td><td class="num"><b>${g?.dem ?? "—"}%</b></td><td class="num">${g?.rep ?? "—"}%</td></tr>`; }).join("");

  // Each candidate's votes as one bar split by 2024 vote.
  const coalitionRows = [
    { name: senate.democrat, votes: senate.dem, parts: talaricoCoalition },
    { name: senate.republican, votes: senate.rep, parts: data.swing["tx-senate"].coalitions.rep },
    { name: governor.democrat, votes: governor.dem, parts: hinojosaCoalition },
    { name: governor.republican, votes: governor.rep, parts: data.swing["tx-governor"].coalitions.rep },
  ];
  const maxVotes = Math.max(...coalitionRows.map((row) => row.votes));
  byId("tx26-coalition-legend").innerHTML = sAnswers.map((a) => `<span><i class="sw" style="background:${groupColor[a.label]}"></i>${esc(groupName[a.label])}</span>`).join("");
  byId("tx26-coalitions").innerHTML = coalitionRows.map((row) => `<div class="seg-row"><div class="seg-name"><b>${esc(row.name)}</b><span>${roughVotes(row.votes)} votes</span></div><div class="seg-track"><div class="seg-bar" style="width:${(100 * row.votes) / maxVotes}%">${row.parts.filter((p) => p.votes > 0).map((p) => `<span class="seg${p.label === "Other" ? " light" : ""}" style="flex:${p.share} 1 0;background:${groupColor[p.label]}" data-tip="${esc(`<b>${esc(row.name)}</b><div class="row"><span>${esc(groupName[p.label])}</span><span>about ${votesText(Math.round(p.votes / 1000) * 1000)}</span></div><div class="row"><span>Share of ${esc(lastName(row.name))}'s votes</span><span>${p.share}%</span></div>`)}" data-label="${p.share >= 1 ? `${Math.round(p.share)}%` : ""}"></span>`).join("")}</div></div></div>`).join("");
  const fitSegmentLabels = () => {
    // A block gets its share printed only when the text fits inside it with room to spare.
    const narrowRows = window.matchMedia("(max-width: 640px)").matches;
    const width = (byId("tx26-coalitions").clientWidth || document.querySelector("main").clientWidth - 40) - (narrowRows ? 0 : 170);
    for (const bar of byId("tx26-coalitions").querySelectorAll(".seg-bar")) {
      const barWidth = (width * parseFloat(bar.style.width)) / 100, total = [...bar.children].reduce((t, s) => t + parseFloat(s.style.flexGrow), 0);
      for (const seg of bar.children) seg.textContent = (barWidth * parseFloat(seg.style.flexGrow)) / total > seg.dataset.label.length * 7.5 + 12 ? seg.dataset.label : "";
    }
  };
  fitSegmentLabels();
  window.addEventListener("resize", fitSegmentLabels);
  window.addEventListener("hashchange", fitSegmentLabels);
  root.addEventListener("mousemove", (event) => { const seg = event.target.closest("[data-tip]"); if (seg && root.contains(seg)) showTooltip(event, seg.dataset.tip); });
  root.addEventListener("mouseout", (event) => { if (event.target.closest("[data-tip]")) hideTooltip(); });

  // ---------- turnout or persuasion ----------
  const decompositionNote = (raceId) => {
    const race = races[raceId], split = data.swing[raceId].decomposition, rates = data.swing[raceId].returnRates;
    const step = (key) => split.steps.find((s) => s.key === key).value;
    return `Among this year's voters who voted in 2024, the exit poll's recalled 2024 vote was ${split.recalled < 0 ? "Trump" : "Harris"} ${Math.abs(split.recalled).toFixed(1)} points ahead. The actual 2024 result was Trump +${Math.abs(split.priorMargin).toFixed(1)}, so the people who showed up this year leaned less Republican than the 2024 electorate. That accounts for ${step("turnout").toFixed(1)} points of the ${split.swing.toFixed(1)}-point swing. By the poll's shares, about ${ratioText(rates.harris)} of Harris voters turned out again, against ${ratioText(rates.trump)} of Trump voters. The same returning voters then backed ${lastName(race.democrat)} by ${split.returningNow.toFixed(1)}, which is ${step("switched").toFixed(1)} points of switching. People who skipped 2024 added ${step("new").toFixed(1)} more. The last ${Math.abs(step("count")).toFixed(1)} is the gap between the poll's ${marginText(split.survey)} and the count's ${marginText(split.resultMargin)}.`;
  };
  const drawWaterfall = (raceId) => {
    const race = races[raceId], split = data.swing[raceId].decomposition;
    const width = chartWidth("tx26-waterfall"), narrow = width < 560, height = narrow ? 280 : 300, margin = { top: 24, right: 8, bottom: narrow ? 48 : 46, left: narrow ? 40 : 46 };
    // Short names under the bars on a phone; the tooltip keeps the full ones.
    const SHORT = { turnout: "Who voted", switched: "Switched", new: "New voters", count: "Count" };
    const bars = [{ label: "2024 president", short: "2024", from: 0, to: split.priorMargin, total: true }];
    let level = split.priorMargin;
    for (const step of split.steps) { bars.push({ label: step.label, short: SHORT[step.key], from: level, to: level + step.value, step }); level += step.value; }
    bars.push({ label: `2026: ${lastName(race.democrat)}`, short: "2026", from: 0, to: split.resultMargin, total: true });
    const svg = d3.select("#tx26-waterfall").html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img")
      .attr("aria-label", `From Trump +${Math.abs(split.priorMargin)} in 2024 to ${marginText(split.resultMargin)}: ${split.steps.map((s) => `${s.label} ${plus(s.value)}`).join(", ")}`);
    const x = d3.scaleBand().domain(bars.map((b) => b.label)).range([margin.left, width - margin.right]).paddingInner(0.35).paddingOuter(0.1);
    // Room past the longest bar for its label.
    const extent = Math.ceil((Math.max(12.5, ...bars.map((b) => Math.abs(b.to)), ...bars.map((b) => Math.abs(b.from))) + 3) / 5) * 5;
    const y = d3.scaleLinear().domain([-extent, extent]).range([height - margin.bottom, margin.top]);
    svg.append("g").attr("class", "grid").selectAll("line").data(y.ticks(6)).join("line").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", (v) => y(v)).attr("y2", (v) => y(v));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(6).tickFormat((v) => (v === 0 ? "Even" : `${v > 0 ? "D" : "R"}+${Math.abs(v)}`)).tickSize(0)).select(".domain").remove();
    svg.append("line").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", cssVar("--ink-3"));
    const barWidth = Math.min(64, x.bandwidth());
    const left = (b) => x(b.label) + (x.bandwidth() - barWidth) / 2;
    // Connectors from each bar's end to the next bar's start.
    svg.append("g").selectAll("line").data(bars.slice(0, -1)).join("line").attr("x1", (b) => left(b) + barWidth).attr("x2", (b, i) => left(bars[i + 1]))
      .attr("y1", (b) => y(b.to)).attr("y2", (b) => y(b.to)).attr("stroke", cssVar("--ink-3")).attr("stroke-width", 1);
    const colorOf = (b) => (b.total ? (b.to > 0 ? cssVar("--d3") : cssVar("--r3")) : b.to >= b.from ? cssVar("--d2") : cssVar("--r2"));
    svg.append("g").selectAll("rect").data(bars).join("rect").attr("x", left).attr("width", barWidth)
      .attr("y", (b) => y(Math.max(b.from, b.to))).attr("height", (b) => Math.max(1.5, Math.abs(y(b.from) - y(b.to)))).attr("rx", 3).attr("fill", colorOf)
      .on("mousemove", (event, b) => showTooltip(event, `<b>${esc(b.label)}</b><div class="row"><span>${b.total ? "Margin" : "Moves the margin"}</span><span>${b.total ? esc(marginText(b.to)) : `${plus(b.to - b.from)} points`}</span></div>${b.total ? "" : `<div class="row"><span>From → to</span><span>${esc(marginText(b.from))} → ${esc(marginText(b.to))}</span></div>`}`)).on("mouseleave", hideTooltip);
    svg.append("g").selectAll("text").data(bars).join("text").attr("class", "label").attr("text-anchor", "middle").attr("font-weight", 600)
      .attr("x", (b) => left(b) + barWidth / 2).attr("y", (b) => (b.to >= b.from ? y(Math.max(b.from, b.to)) - 6 : y(Math.min(b.from, b.to)) + 14))
      .text((b) => (b.total ? marginText(b.to) : plus(b.to - b.from)));
    const names = svg.append("g").selectAll("text").data(bars).join("text").attr("class", "label").attr("text-anchor", "middle").attr("x", (b) => left(b) + barWidth / 2).attr("y", height - margin.bottom + 16);
    names.each(function eachName(b) {
      const lines = wrapWords(narrow ? b.short : b.label, Math.max(7, Math.floor(x.step() / 6.6)));
      d3.select(this).selectAll("tspan").data(lines).join("tspan").attr("x", left(b) + barWidth / 2).attr("dy", (line, i) => (i ? 13 : 0)).text((line) => line);
    });
    byId("tx26-waterfall-note").textContent = decompositionNote(raceId);
  };
  const bindToggle = (attribute, draw, first) => {
    const buttons = [...root.querySelectorAll(`button.mode[${attribute}]`)];
    const key = attribute.replace(/^data-/, "").replace(/-([a-z0-9])/g, (m, c) => c.toUpperCase());
    buttons.forEach((button) => button.addEventListener("click", () => { buttons.forEach((b) => b.classList.toggle("active", b === button)); draw(button.dataset[key]); }));
    draw(first);
  };
  bindToggle("data-tx26-split", drawWaterfall, "tx-senate");

  // ---------- where the vote moved ----------
  const swingRange = d3.extent(data.counties, (c) => c.swing);
  const minSwing = data.counties.find((c) => c.swing === swingRange[0]), maxSwing = data.counties.find((c) => c.swing === swingRange[1]);
  byId("tx26-geo-note").textContent = `${swingRange[0] > 0 ? `All ${data.counties.length} counties moved toward the Democrats from 2024` : "Most counties moved toward the Democrats from 2024"}, from ${swingRange[0].toFixed(1)} points in ${minSwing.name} County to ${swingRange[1].toFixed(1)} in ${maxSwing.name}. The Rio Grande Valley and border counties moved most: ${border.swing.toFixed(0)} points, from ${marginText(border.pres2024)} to ${marginText(border.senate)}. There, ${lastName(senate.democrat)} drew ${ratioText(border.demVsHarris)} of Harris's 2024 vote while ${lastName(senate.republican)} drew ${ratioText(border.repVsTrump)} of Trump's. The big cities and the suburbs cast ${Math.round(cities.share + suburbs.share)}% of the vote and swung ${Math.round(Math.min(cities.swing, suburbs.swing))}–${Math.round(Math.max(cities.swing, suburbs.swing))} points; the suburbs as a group went from ${marginText(suburbs.pres2024)} to ${marginText(suburbs.senate)}. Everywhere, ${lastName(senate.republican)} ran far below Trump's vote while ${lastName(senate.democrat)} matched or beat Harris's, so both turnout and switching show up on the map.`;
  const mapModes = {
    swing: { scale: marginScale(40), value: (c) => c.swing, legend: (swingRange[0] < 0 ? [-10, 0, 10, 20, 30, 40] : [0, 10, 20, 30, 40]).map((v) => [v, v === 0 ? "No change" : `${v > 0 ? "D" : "R"} +${Math.abs(v)}${v === 40 ? " or more" : ""}`]) },
    margin: { scale: marginScale(60), value: (c) => c.senate, legend: [-60, -30, -10, 0, 10, 30, 60].map((v) => [v, v === 0 ? "Even" : `${v > 0 ? "D" : "R"} +${Math.abs(v)}`]) },
    dem: { scale: d3.scaleSequential([0.8, 1.6], d3.interpolateRgb("#e8effc", cssVar("--d4"))).clamp(true), value: (c) => c.dem / c.harris, legend: [0.8, 1, 1.2, 1.4, 1.6].map((v) => [v, `${Math.round(v * 100)}%${v === 1.6 ? " or more" : v === 0.8 ? " or less" : ""}`]) },
    rep: { scale: d3.scaleSequential([0.3, 0.9], d3.interpolateRgb("#fcebeb", cssVar("--r4"))).clamp(true), value: (c) => c.rep / c.trump, legend: [0.3, 0.45, 0.6, 0.75, 0.9].map((v) => [v, `${Math.round(v * 100)}%`]) },
  };
  const countyTip = (c) => (c ? `<b>${esc(c.name)} County</b> <span class="muted">${esc(shortRegion[c.group])}</span><hr>`
    + `<div class="row"><span>2026 Senate</span><span>${leanSpan(c.senate)}</span></div><div class="row"><span>2024 president</span><span>${leanSpan(c.pres2024)}</span></div>`
    + `<div class="row"><span><b>Swing</b></span><span><b>${leanSpan(c.swing)}</b></span></div><div class="row"><span>2026 governor</span><span>${leanSpan(c.governor)}</span></div>`
    + `<div class="row"><span>Votes, 2026</span><span>${votesText(c.votes)}</span></div><div class="row"><span>${esc(lastName(senate.democrat))} vs. Harris's votes</span><span>${ratioText(c.dem / c.harris)}</span></div><div class="row"><span>${esc(lastName(senate.republican))} vs. Trump's votes</span><span>${ratioText(c.rep / c.trump)}</span></div>` : "No data");
  {
    const width = 800, height = 760;
    const svgRoot = d3.select("#tx26-map").html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", "Texas counties, colored by the selected measure");
    const svg = svgRoot.append("g").attr("class", "zoom-root");
    const features = topojson.feature(topo, topo.objects.counties).features;
    const path = d3.geoPath(d3.geoMercator().fitSize([width, height], { type: "FeatureCollection", features }));
    const countyOf = (f) => counties.get(countyKeyOf(f.properties.name));
    const paths = svg.append("g").selectAll("path").data(features).join("path").attr("d", path)
      .on("mousemove", (event, f) => showTooltip(event, countyTip(countyOf(f)))).on("mouseleave", hideTooltip);
    const apply = (mode) => {
      const spec = mapModes[mode];
      paths.attr("fill", (f) => { const c = countyOf(f); return c ? spec.scale(spec.value(c)) : cssVar("--notup"); });
      byId("tx26-map-legend").innerHTML = spec.legend.map(([v, label]) => `<span><i class="sw" style="background:${spec.scale(v)}"></i>${esc(label)}</span>`).join("");
    };
    bindToggle("data-tx26-map", apply, "swing");
    attachZoom(svgRoot, "tx26-map", { width, height });
  }
  const regionHead = `<tr><th>Region</th><th class="num">Share of the vote</th><th class="num">2024 president</th><th class="num">2022 governor</th><th class="num">2026 Senate</th><th class="num">Swing<span class="sub">2024 to 2026</span></th><th class="num">2026 governor</th><th class="num">Votes vs. 2022</th><th class="num">${esc(lastName(senate.democrat))}<span class="sub">vs. Harris's votes</span></th><th class="num">${esc(lastName(senate.republican))}<span class="sub">vs. Trump's votes</span></th></tr>`;
  byId("tx26-regions").innerHTML = regionHead + data.regions.map((r) => `<tr><td><b>${esc(r.region)}</b> <span class="muted">${r.counties} ${r.counties === 1 ? "county" : "counties"}</span></td><td class="num">${r.share.toFixed(1)}%</td><td class="num">${leanSpan(r.pres2024)}</td><td class="num">${leanSpan(r.gov2022)}</td><td class="num"><b>${leanSpan(r.senate)}</b></td><td class="num"><b>${leanSpan(r.swing)}</b></td><td class="num">${leanSpan(r.governor)}</td><td class="num">${ratioText(r.turnoutVs2022)}</td><td class="num">${ratioText(r.demVsHarris)}</td><td class="num">${ratioText(r.repVsTrump)}</td></tr>`).join("");
  byId("tx26-regions-note").textContent = `The regions are this site's county groups (the same ones the early-vote page uses): the six biggest counties, the Rio Grande Valley and border, the suburban counties around them, midsize cities, and the ${regionOf["Rural and small-town"].counties} rural and small-town counties. "Votes vs. 2022" compares votes for Senate with votes for governor in 2022.`;

  // Scatter: every county's 2024 margin against its swing, sized by its vote; one region highlighted.
  const drawCountyScatter = (highlight) => {
    const width = chartWidth("tx26-scatter"), narrow = width < 560, height = narrow ? 360 : 420, margin = { top: 16, right: 12, bottom: 42, left: narrow ? 40 : 50 };
    const svg = d3.select("#tx26-scatter").html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", "Each county's 2024 presidential margin against its swing to the Democrats in 2026");
    // A little room below zero and left of Trump +100 keeps the corner's two axis labels apart.
    const x = d3.scaleLinear().domain([-108, 72]).range([margin.left, width - margin.right]);
    const y = d3.scaleLinear().domain([-5, Math.ceil(swingRange[1] / 10) * 10]).range([height - margin.bottom, margin.top]);
    const xTicks = d3.range(-100, 61, narrow ? 40 : 20), yTicks = d3.range(0, Math.ceil(swingRange[1] / 10) * 10 + 1, 10);
    const r = d3.scaleSqrt().domain([0, d3.max(data.counties, (c) => c.votes)]).range([1.4, narrow ? 15 : 24]);
    svg.append("g").attr("class", "grid").selectAll("line").data(yTicks).join("line").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", (v) => y(v)).attr("y2", (v) => y(v));
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${height - margin.bottom})`).call(d3.axisBottom(x).tickValues(xTicks).tickFormat((v) => (v === 0 ? "Even" : narrow ? `${v > 0 ? "D" : "R"}+${Math.abs(v)}` : `${v > 0 ? "Harris" : "Trump"} +${Math.abs(v)}`)).tickSize(0)).select(".domain").remove();
    svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).tickValues(yTicks).tickFormat((v) => (v === 0 ? "None" : `D +${v}`)).tickSize(0)).select(".domain").remove();
    svg.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", margin.top).attr("y2", height - margin.bottom).attr("stroke", cssVar("--rule"));
    svg.append("text").attr("class", "label").attr("x", width - margin.right).attr("y", height - 6).attr("text-anchor", "end").text("2024 presidential margin →");
    svg.append("text").attr("class", "label").attr("x", margin.left + 4).attr("y", margin.top + 2).attr("dy", "0.7em").text("Swing toward Democrats, 2024 to 2026 ↑");
    const on = (c) => highlight === "all" || c.group === highlight;
    const ordered = [...data.counties].sort((a, b) => Number(on(a)) - Number(on(b)) || b.votes - a.votes);
    svg.append("g").selectAll("circle").data(ordered).join("circle").attr("cx", (c) => x(c.pres2024)).attr("cy", (c) => y(c.swing)).attr("r", (c) => r(c.votes))
      .attr("fill", (c) => (on(c) ? cssVar("--ink") : cssVar("--rule"))).attr("fill-opacity", (c) => (on(c) ? 0.72 : 0.8)).attr("stroke", "#fff").attr("stroke-width", 1);
    // Labels for the biggest and the furthest-moving highlighted counties, skipped where they would collide.
    const placed = [];
    const bubbles = data.counties.filter(on).map((c) => [x(c.pres2024), y(c.swing), r(c.votes), c]);
    // A label's box against another county's circle: the nearest point of the box within the radius.
    const hitsBubble = (sx, sy, w, h, self) => bubbles.some(([bx, by, br, c]) => c !== self && Math.hypot(Math.max(sx, Math.min(bx, sx + w)) - bx, Math.max(sy, Math.min(by, sy + h)) - by) < br);
    const candidates = [...data.counties].filter(on).sort((a, b) => b.votes - a.votes).slice(0, 8).concat([...data.counties].filter(on).sort((a, b) => b.swing - a.swing).slice(0, 4));
    for (const c of [...new Set(candidates)]) {
      const w = c.name.length * 6.4, h = 12, cx = x(c.pres2024), cy = y(c.swing), rr = r(c.votes);
      const spots = [[cx + rr + 3, cy - h / 2], [cx - rr - 3 - w, cy - h / 2], [cx - w / 2, cy - rr - h - 2]];
      const spot = spots.find(([sx, sy]) => sx > margin.left && sx + w < width - margin.right && sy > margin.top && !hitsBubble(sx, sy, w, h, c) && !placed.some((p) => sx < p[0] + p[2] && sx + w > p[0] && sy < p[1] + p[3] && sy + h > p[1]));
      if (!spot) continue;
      placed.push([spot[0], spot[1], w, h]);
      svg.append("text").attr("class", "label").attr("x", spot[0]).attr("y", spot[1] + h - 2).attr("fill", cssVar("--ink")).text(c.name);
    }
    // Hover: the county nearest the pointer.
    const delaunay = d3.Delaunay.from(data.counties, (c) => x(c.pres2024), (c) => y(c.swing));
    svg.append("rect").attr("x", margin.left).attr("y", margin.top).attr("width", width - margin.left - margin.right).attr("height", height - margin.top - margin.bottom).attr("fill", "transparent")
      .on("mousemove", (event) => {
        const [px, py] = d3.pointer(event, svg.node());
        const c = data.counties[delaunay.find(px, py)];
        if (Math.hypot(x(c.pres2024) - px, y(c.swing) - py) > Math.max(24, r(c.votes) + 8)) return hideTooltip();
        showTooltip(event, countyTip(c));
      }).on("mouseleave", hideTooltip);
  };
  bindToggle("data-tx26-region", drawCountyScatter, "Rio Grande Valley and border");
  redraws.push(() => drawCountyScatter(root.querySelector("button.mode.active[data-tx26-region]")?.dataset.tx26Region ?? "Rio Grande Valley and border"));
  redraws.push(() => drawWaterfall(root.querySelector("button.mode.active[data-tx26-split]")?.dataset.tx26Split ?? "tx-senate"));
  const countyHead = `<tr><th>County</th><th>Region</th><th class="num">Votes, 2026</th><th class="num">2024 president</th><th class="num">2026 Senate</th><th class="num">Swing</th><th class="num">2026 governor</th><th class="num">${esc(lastName(senate.democrat))}<span class="sub">vs. Harris's votes</span></th><th class="num">${esc(lastName(senate.republican))}<span class="sub">vs. Trump's votes</span></th></tr>`;
  byId("tx26-counties").innerHTML = countyHead + data.counties.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td class="muted">${esc(shortRegion[c.group])}</td><td class="num">${votesText(c.votes)}</td><td class="num">${leanSpan(c.pres2024)}</td><td class="num">${leanSpan(c.senate)}</td><td class="num"><b>${leanSpan(c.swing)}</b></td><td class="num">${leanSpan(c.governor)}</td><td class="num">${ratioText(c.dem / c.harris)}</td><td class="num">${ratioText(c.rep / c.trump)}</td></tr>`).join("");

  // ---------- who moved ----------
  const GROUPS = [
    ["Race and ethnicity", "race", ["White", "Black", "Hispanic/Latino", "Asian"]],
    ["By race and gender", "raceGender", ["White men", "White women", "Black men", "Black women", "Latino men", "Latino women"]],
    ["Age", "age", null],
    ["Education", "college", null],
    ["White voters by education", "educationRace", ["White college graduates", "White non-college graduates"]],
    ["Party", "party", null],
    ["Ideology", "ideology", null],
    ["Where they live", "area", null],
    ["How they voted", "method", null],
    ["First time voting in a midterm?", "firstMidterm", null],
    ["Considers themself MAGA?", "maga", null],
  ];
  const drawGroups = (raceId) => {
    const race = races[raceId], questions = exit[raceId].questions;
    const rows = [];
    for (const [title, key, only] of GROUPS) {
      const question = questions[key];
      if (!question) continue;
      const answers = question.answers.filter((a) => (a.dem || a.rep) && (!only || only.some((label) => label.toLowerCase() === a.label.toLowerCase())));
      if (!answers.length) continue;
      rows.push(`<div class="gm-head">${esc(title)}</div>`);
      for (const a of answers) {
        const m = a.dem - a.rep, half = Math.min(50, Math.abs(m) / 2);
        const tip = `<b>${esc(a.label)}</b> <span class="muted">${a.share}% of voters</span><div class="row"><span>${esc(race.democrat)}</span><span>${a.dem}%</span></div><div class="row"><span>${esc(race.republican)}</span><span>${a.rep}%</span></div>`;
        rows.push(`<div class="gm-row" data-tip="${esc(tip)}"><span class="gm-label">${esc(a.label.replace(/^(.)/, (c) => c.toUpperCase()).replace(/ (Men|Women)$/, (w) => w.toLowerCase()))}</span><span class="gm-share">${a.share}%</span><span class="gm-track"><i class="${m >= 0 ? "d" : "r"}" style="${m >= 0 ? "left" : "right"}:50%;width:${half}%"></i></span><span class="gm-value">${wholeLean(m)}</span></div>`);
      }
    }
    byId("tx26-groups").innerHTML = `<div class="gm-row gm-cols"><span class="gm-label"></span><span class="gm-share">Share of voters</span><span class="gm-track-head"><span>${esc(lastName(race.republican))} ahead</span><span>${esc(lastName(race.democrat))} ahead</span></span><span class="gm-value">Margin</span></div>` + rows.join("");
    const q = questions;
    const latino = q.race?.answers.find((a) => /hispanic/i.test(a.label)), young = q.age?.answers[0], moderate = q.ideology?.answers.find((a) => a.label === "Moderate"), indep = q.party?.answers.find((a) => /independent/i.test(a.label));
    const early = data.voteMethod[raceId].early, day = data.voteMethod[raceId].electionDay;
    byId("tx26-groups-note").textContent = `${lastName(race.democrat)} won Latino voters (${latino.share}% of the electorate) by ${latino.dem - latino.rep}, voters under 30 by ${young.dem - young.rep}, moderates (${moderate.share}%) by ${moderate.dem - moderate.rep}, and independents (${indep.share}%) by ${indep.dem - indep.rep}. The count shows the same split by voting method as the poll: early and mail ballots, ${early.share}% of the vote, went ${marginText(early.margin)}, while Election Day went ${marginText(day.margin)}.`;
  };
  bindToggle("data-tx26-groups", drawGroups, "tx-senate");

  // ---------- what voters said ----------
  const SAID = [
    ["Trump's job as president", "trumpApproval", null],
    ["Most important issue", "issue", ["The economy", "The state of democracy", "Immigration", "Healthcare"]],
    ["The nation's economy is", "economy", ["Good", "Not so good", "Poor"]],
    ["Family's finances, vs. two years ago", "finances", null],
    ["Trump's tariffs have … the national economy", "tariffs", ["Helped", "Hurt"]],
    ["Military action against Iran was the", "iran", null],
    ["Trump's immigration enforcement has", "immigration", null],
    ["Paxton has the character to be a senator", "paxtonCharacter", null],
    ["Talarico's views are too extreme", "talaricoExtreme", null],
  ];
  const sq = exit["tx-senate"].questions;
  byId("tx26-said").innerHTML = `<tr><th>Question</th><th>Answer</th><th class="num">Share of voters</th><th class="num">${esc(lastName(senate.democrat))}</th><th class="num">${esc(lastName(senate.republican))}</th></tr>`
    + SAID.filter(([, key]) => sq[key]).map(([title, key, only]) => {
      const answers = sq[key].answers.filter((a) => !only || only.includes(a.label));
      return answers.map((a, i) => `<tr${i ? "" : ' class="group-start"'}><td class="wrap">${i ? "" : `<b>${esc(title)}</b>`}</td><td>${esc(a.label)}</td><td class="num">${a.share}%</td><td class="num">${a.dem || a.rep ? `${a.dem}%` : "—"}</td><td class="num">${a.dem || a.rep ? `${a.rep}%` : "—"}</td></tr>`).join("");
    }).join("");
  const approve = sq.trumpApproval.answers.filter((a) => /approve/i.test(a.label) && !/disapprove/i.test(a.label)).reduce((t, a) => t + a.share, 0);
  const worse = sq.finances.answers.find((a) => a.label === "Worse"), hurt = sq.tariffs.answers.find((a) => a.label === "Hurt"), character = sq.paxtonCharacter?.answers.find((a) => a.label === "No");
  byId("tx26-said-note").textContent = `Only ${approve}% of these voters approved of Trump's job as president. ${worse.share}% said their family was worse off than two years ago, and ${hurt.share}% said his tariffs had hurt the national economy.${character ? ` ${character.share}% said Paxton lacked the character to serve as a senator, and ${character.dem}% of them voted for ${lastName(senate.democrat)}.` : ""}`;

  // ---------- what the polls missed ----------
  const misses = data.statewide.map((r) => r.pollMiss).filter((m) => m != null);
  const meanMiss = misses.reduce((t, m) => t + m, 0) / misses.length;
  byId("tx26-polls-note").textContent = `Our final polling averages had ${lastName(senate.democrat)} up ${senate.poll.toFixed(1)} and ${lastName(governor.republican)} up ${Math.abs(governor.poll).toFixed(1)}. Every statewide race broke ${Math.min(...misses).toFixed(1)} to ${Math.max(...misses).toFixed(1)} points more Democratic than its final average, ${meanMiss.toFixed(1)} on average. That makes it one shared miss, not eight separate ones, and the published averages missed the same way (${senate.aggregates.map((a) => `${a.source} ${marginText(a.margin)}`).join(", ")} for the Senate race). Our model put ${lastName(senate.democrat)}'s chance at ${pct(senate.modelD)} and ${lastName(governor.democrat)}'s at ${pct(governor.modelD)}. The six down-ballot Democrats had ${pct(Math.min(...data.statewide.slice(2).map((r) => r.modelD)))} to ${pct(Math.max(...data.statewide.slice(2).map((r) => r.modelD)))}, and all of them won.`;
  const drawPolls = () => {
    const rows = data.statewide;
    const width = chartWidth("tx26-polls"), narrow = width < 560, rowHeight = 34, margin = { top: 28, right: narrow ? 52 : 70, bottom: 30, left: narrow ? 128 : 200 }, height = margin.top + margin.bottom + rows.length * rowHeight;
    const svg = d3.select("#tx26-polls").html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", "Each statewide race's final polling average and result");
    const lo = Math.floor(Math.min(-10, ...rows.map((r) => r.poll ?? 0)) / 5) * 5, hi = Math.ceil(Math.max(15, ...rows.map((r) => r.margin)) / 5) * 5;
    const x = d3.scaleLinear().domain([lo, hi]).range([margin.left, width - margin.right]);
    const yOf = (i) => margin.top + i * rowHeight + rowHeight / 2;
    svg.append("g").attr("class", "grid").selectAll("line").data(x.ticks(6)).join("line").attr("x1", (v) => x(v)).attr("x2", (v) => x(v)).attr("y1", margin.top).attr("y2", height - margin.bottom);
    svg.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", margin.top - 6).attr("y2", height - margin.bottom).attr("stroke", cssVar("--ink-3"));
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${height - margin.bottom})`).call((narrow ? d3.axisBottom(x).tickValues(x.ticks(6).filter((v) => v % 10 === 0)) : d3.axisBottom(x).ticks(6)).tickFormat((v) => (v === 0 ? "Even" : `${v > 0 ? "D" : "R"}+${Math.abs(v)}`)).tickSize(0)).select(".domain").remove();
    svg.append("text").attr("class", "label").attr("x", x(0) - 6).attr("y", margin.top - 12).attr("text-anchor", "end").text(narrow ? "← R ahead" : "← Republican ahead");
    svg.append("text").attr("class", "label").attr("x", x(0) + 6).attr("y", margin.top - 12).text(narrow ? "D ahead →" : "Democrat ahead →");
    const row = svg.append("g").selectAll("g").data(rows).join("g").attr("transform", (r, i) => `translate(0,${yOf(i)})`);
    row.append("text").attr("class", "label").attr("x", margin.left - 12).attr("text-anchor", "end").attr("dy", "0.35em").attr("fill", cssVar("--ink")).text((r) => (narrow ? r.office.replace("Commissioner", "Comm.") : `${r.office}: ${lastName(r.democrat)}`));
    row.append("line").attr("x1", (r) => x(r.poll ?? r.margin)).attr("x2", (r) => x(r.margin)).attr("stroke", cssVar("--ink-3")).attr("stroke-width", 2);
    row.append("circle").attr("cx", (r) => x(r.poll ?? r.margin)).attr("r", 5).attr("fill", "#fff").attr("stroke", cssVar("--ink-2")).attr("stroke-width", 2);
    row.append("circle").attr("cx", (r) => x(r.margin)).attr("r", 6).attr("fill", (r) => (r.margin > 0 ? cssVar("--d3") : cssVar("--r3"))).attr("stroke", "#fff").attr("stroke-width", 2);
    row.append("text").attr("class", "label").attr("x", (r) => x(r.margin) + 10).attr("dy", "0.35em").text((r) => marginText(r.margin));
    row.append("rect").attr("x", margin.left).attr("y", -rowHeight / 2).attr("width", width - margin.left - margin.right).attr("height", rowHeight).attr("fill", "transparent")
      .on("mousemove", (event, r) => showTooltip(event, `<b>${esc(r.office)}</b><div class="row"><span>${esc(r.democrat)} vs. ${esc(r.republican)}</span><span></span></div><div class="row"><span>Final polling average</span><span>${esc(marginText(r.poll))} (${r.pollCount} polls)</span></div><div class="row"><span>Result</span><span><b>${esc(marginText(r.margin))}</b></span></div><div class="row"><span>Miss</span><span>${plus(r.pollMiss)} toward the Democrat</span></div><div class="row"><span>Our model's chance for ${esc(lastName(r.democrat))}</span><span>${pct(r.modelD)}</span></div>`)).on("mouseleave", hideTooltip);
    byId("tx26-polls-legend").innerHTML = `<span><i class="sw dot hollow"></i>Final polling average</span><span><i class="sw dot" style="background:${cssVar("--d3")}"></i>Result</span>`;
    byId("tx26-polls-table").innerHTML = `<tr><th>Race</th><th class="num">Final polling average</th><th class="num">Result</th><th class="num">Miss<span class="sub">toward the Democrat</span></th><th class="num">D wins<span class="sub">our model</span></th></tr>`
      + rows.map((r) => `<tr><td><b>${esc(r.office)}</b> <span class="muted">${esc(r.democrat)} vs. ${esc(r.republican)}</span></td><td class="num">${r.poll == null ? "—" : `${leanSpan(r.poll)} <span class="thin">n=${r.pollCount}</span>`}</td><td class="num"><b>${leanSpan(r.margin)}</b></td><td class="num">${r.pollMiss == null ? "—" : plus(r.pollMiss)}</td><td class="num">${pct(r.modelD)}</td></tr>`).join("");
  };
  drawPolls();
  redraws.push(drawPolls);

  // ---------- down the ballot ----------
  byId("tx26-offices").innerHTML = `<tr><th>Office</th><th>Democrat</th><th>Republican</th><th class="num">Margin</th></tr>`
    + offices.map((o) => `<tr><td class="wrap"><b>${esc(o.office)}</b></td><td>${esc(o.democrat || "—")}${o.winner === "D" ? " ✓" : ""}</td><td>${esc(o.republican || "—")}${o.winner === "R" ? " ✓" : ""}</td><td class="num"><b>${leanSpan(o.margin)}</b></td></tr>`).join("");
  const contested = house.districts.filter((d) => d.contested && d.pres2024 != null);
  const shifts = contested.map((d) => d.margin - d.pres2024).sort((a, b) => a - b);
  const medianShift = shifts[Math.floor(shifts.length / 2)];
  const usTargets = data.usHouse.districts.filter((d) => d.party === "D" && d.consensus && !/\bD$/.test(d.consensus));
  const closeSafe = data.usHouse.districts.filter((d) => d.party === "R" && d.consensus === "Safe R" && d.margin != null && Math.abs(d.margin) < 5);
  byId("tx26-house-note").textContent = `Democrats flipped ${houseFlips.length} Texas House seats and lost none, for a majority of ${houseWon.D} to ${houseWon.R}. Our chamber model's average was ${house.modelExpectedD.toFixed(0)} Democratic seats, and it put the chance of a Democratic majority at ${pct(house.modelControlD)}. In the ${contested.length} districts where a Democrat faced a Republican, the median moved ${medianShift.toFixed(0)} points toward the Democrats from its 2024 presidential margin. That is less than the ${(senate.margin - prior.margin).toFixed(0)}-point statewide swing in the Senate race, and the flips came in the districts closest to the line. In the U.S. House, Democrats won ${usWon.D} of Texas's ${data.usHouse.districts.length} seats under the map drawn in 2025, against our model's ${data.usHouse.modelExpectedD.toFixed(1)}${usTargets.length ? `, including ${listText(usTargets.map((d) => `TX-${d.district} (rated ${d.consensus})`))}` : ""}.${closeSafe.length ? ` Republicans held ${closeSafe.length} seats rated Safe R by less than 5 points.` : ""}`;
  const drawHouse = () => {
    const width = chartWidth("tx26-house"), narrow = width < 560, height = narrow ? 360 : 420, margin = { top: 16, right: 12, bottom: 42, left: narrow ? 44 : 54 };
    const svg = d3.select("#tx26-house").html("").append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", "Texas House districts: 2024 presidential margin against the 2026 result");
    const x = d3.scaleLinear().domain([-85, 65]).range([margin.left, width - margin.right]), y = d3.scaleLinear().domain([-75, 85]).range([height - margin.bottom, margin.top]);
    const xTicks = d3.range(-80, 61, narrow ? 40 : 20), yTicks = d3.range(-60, 81, 20);
    svg.append("g").attr("class", "grid").selectAll("line").data(yTicks).join("line").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", (v) => y(v)).attr("y2", (v) => y(v));
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${height - margin.bottom})`).call(d3.axisBottom(x).tickValues(xTicks).tickFormat((v) => (v === 0 ? "Even" : narrow ? `${v > 0 ? "D" : "R"}+${Math.abs(v)}` : `${v > 0 ? "Harris" : "Trump"} +${Math.abs(v)}`)).tickSize(0)).select(".domain").remove();
    svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).tickValues(yTicks).tickFormat((v) => (v === 0 ? "Even" : `${v > 0 ? "D" : "R"} +${Math.abs(v)}`)).tickSize(0)).select(".domain").remove();
    svg.append("line").attr("x1", x(-75)).attr("y1", y(-75)).attr("x2", x(65)).attr("y2", y(65)).attr("stroke", cssVar("--ink-3"));
    svg.append("text").attr("class", "label").attr("x", x(52)).attr("y", y(52) + 18).attr("text-anchor", "middle").text("Same as 2024");
    svg.append("line").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", cssVar("--ink-2"));
    svg.append("text").attr("class", "label").attr("x", width - margin.right).attr("y", y(0) - 6).attr("text-anchor", "end").text(narrow ? "Democrat won above" : "Above the line, the Democrat won");
    svg.append("text").attr("class", "label").attr("x", width - margin.right).attr("y", height - 6).attr("text-anchor", "end").text(narrow ? "2024 presidential margin →" : "2024 presidential margin in the district →");
    svg.append("text").attr("class", "label").attr("x", margin.left + 4).attr("y", margin.top + 2).attr("dy", "0.7em").text("2026 Texas House result ↑");
    svg.append("g").selectAll("circle").data(contested).join("circle").attr("cx", (d) => x(d.pres2024)).attr("cy", (d) => y(d.margin)).attr("r", (d) => (d.flipped ? 5.5 : 4))
      .attr("fill", (d) => (d.party === "D" ? cssVar("--d3") : cssVar("--r3"))).attr("fill-opacity", 0.85).attr("stroke", (d) => (d.flipped ? cssVar("--ink") : "#fff")).attr("stroke-width", (d) => (d.flipped ? 2 : 1));
    const delaunay = d3.Delaunay.from(contested, (d) => x(d.pres2024), (d) => y(d.margin));
    svg.append("rect").attr("x", margin.left).attr("y", margin.top).attr("width", width - margin.left - margin.right).attr("height", height - margin.top - margin.bottom).attr("fill", "transparent")
      .on("mousemove", (event) => {
        const [px, py] = d3.pointer(event, svg.node());
        const d = contested[delaunay.find(px, py)];
        if (Math.hypot(x(d.pres2024) - px, y(d.margin) - py) > 24) return hideTooltip();
        showTooltip(event, `<b>House District ${d.district}</b>${d.flipped ? ' <span class="flip-tag">flip</span>' : ""}<hr><div class="row"><span>Winner</span><span>${esc(d.winner || "—")} (${esc(d.party || "—")})</span></div><div class="row"><span>2026 margin</span><span>${leanSpan(d.margin)}</span></div><div class="row"><span>2024 president</span><span>${leanSpan(d.pres2024)}</span></div><div class="row"><span>Held before by</span><span>${esc(d.heldBy || "—")}</span></div>`);
      }).on("mouseleave", hideTooltip);
    byId("tx26-house-legend").innerHTML = `<span><i class="sw dot" style="background:${cssVar("--d3")}"></i>Democrat won</span><span><i class="sw dot" style="background:${cssVar("--r3")}"></i>Republican won</span><span><i class="sw dot ring"></i>Flipped</span>`;
  };
  drawHouse();
  redraws.push(drawHouse);
  const usRows = data.usHouse.districts.filter((d) => d.party === "D" || (d.margin != null && Math.abs(d.margin) < 5));
  let lastWidth = chartWidth("tx26-polls"), resizeTimer = null;
  const redrawIfResized = () => {
    const width = chartWidth("tx26-polls");
    if (Math.abs(width - lastWidth) < 40) return;
    lastWidth = width;
    redraws.forEach((draw) => draw());
  };
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(redrawIfResized, 200); });
  window.addEventListener("hashchange", () => setTimeout(redrawIfResized, 0));
  byId("tx26-us-house").innerHTML = `<tr><th>District</th><th>Winner</th><th class="num">Margin</th><th>Rating before<span class="sub">forecasters' consensus</span></th><th class="num">D wins<span class="sub">our model</span></th></tr>`
    + usRows.map((d) => `<tr><td><b>TX-${d.district}</b></td><td class="wrap">${esc(d.winner)} (${esc(d.party)})${d.heldBy && d.heldBy !== d.party ? ' <span class="flip-tag">flip</span>' : ""}</td><td class="num">${d.uncontested ? "unopposed" : leanSpan(d.margin)}</td><td>${typeof ratingPill === "function" ? ratingPill(d.consensus) : esc(d.consensus || "—")}</td><td class="num">${pct(d.modelD)}</td></tr>`).join("");
})();
