// The numbers behind the "How Texas flipped" page (public/texas-2026.js): the state's unofficial count by county
// against the 2018, 2022, and 2024 results, the exit poll's 2024-vote question turned into a split of the swing and
// each candidate's coalition, the Texas House and U.S. House results, and what the final polls said. Everything the
// page shows is computed here, so the page only draws it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COUNTY_GROUPS, RURAL_GROUP, countyGroup } from "./early-vote.js";
import { fetchJson } from "./http.js";
import { NEEDLE_ELECTION, NEEDLE_RACES, parseCountyReturns } from "./needle.js";

const ENR_URL = "https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr";
const REGIONS = [...Object.keys(COUNTY_GROUPS), RURAL_GROUP];

/** Points, to one decimal. */
const round1 = (value) => (value == null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10);
/** Democratic minus Republican, in points of all votes. */
const marginOf = (dem, rep, total) => (total ? (100 * (dem - rep)) / total : null);

/**
 * Split the swing from the 2024 presidential result to a 2026 result using the exit poll's question on 2024 vote.
 * Margins are Democratic minus Republican, in points; shares and votes in the answers are percentages.
 *  - Who turned out: the 2026 voters who voted in 2024 recall a closer 2024 race than the actual result.
 *  - Voters who switched: those same voters' 2026 margin against their recalled 2024 margin.
 *  - 2024 non-voters: what adding the people who didn't vote in 2024 does to the margin.
 *  - Count vs. exit poll: the rest, between the poll's margin and the state's count.
 * The steps add up to the swing exactly.
 * @param {{ label: string, share: number, dem: number, rep: number }[]} answers the 2024-vote answers
 * @param {number} priorMargin the 2024 presidential margin
 * @param {number} resultMargin the 2026 margin in the count
 */
export function decomposeSwing(answers, priorMargin, resultMargin) {
  const find = (pattern) => answers.find((answer) => pattern.test(answer.label));
  const harris = find(/harris/i), trump = find(/trump/i), other = find(/^other/i), none = find(/did not vote/i);
  if (!harris || !trump) throw new Error("the 2024-vote question needs Harris and Trump answers");
  const returning = [harris, trump, other].filter(Boolean);
  const returningShare = returning.reduce((total, answer) => total + answer.share, 0);
  const net = (answer) => answer.share * (answer.dem - answer.rep);
  const recalled = (100 * (harris.share - trump.share)) / returningShare;
  const returningNow = returning.reduce((total, answer) => total + net(answer), 0) / returningShare;
  const survey = (returning.reduce((total, answer) => total + net(answer), 0) + (none ? net(none) : 0)) / (returningShare + (none?.share ?? 0));
  const steps = [
    { key: "turnout", label: "Who turned out", value: recalled - priorMargin },
    { key: "switched", label: "Voters who switched", value: returningNow - recalled },
    { key: "new", label: "2024 non-voters", value: survey - returningNow },
    { key: "count", label: "Count vs. exit poll", value: resultMargin - survey },
  ];
  return {
    priorMargin: round1(priorMargin), recalled: round1(recalled), returningNow: round1(returningNow), survey: round1(survey), resultMargin: round1(resultMargin),
    swing: round1(resultMargin - priorMargin), steps: steps.map((step) => ({ ...step, value: Math.round(step.value * 100) / 100 })),
  };
}

/**
 * The same split in net votes (the Democrat's minus the Republican's), which is easier to read than points: points
 * of a margin compare a 2024 electorate of one size with a 2026 electorate of another. Each 2024-vote group is sized
 * from its share of the poll and the count's total.
 *  - Who turned out: how this year's voters say they voted in 2024, against the 2024 result.
 *  - Voters who switched: the same people's 2026 votes against their 2024 votes. A switch counts twice, since it
 *    takes a vote off one side and puts one on the other.
 *  - 2024 non-voters: their net votes.
 *  - Count vs. exit poll: the rest, so the steps add up exactly to the change.
 * @param {{ label: string, share: number, dem: number, rep: number }[]} answers the 2024-vote answers
 * @param {{ democrat: number, republican: number }} prior the 2024 presidential result
 * @param {{ total: number, dem: number, rep: number }} count the 2026 race in the count
 */
export function decomposeVotes(answers, prior, count) {
  const find = (pattern) => answers.find((answer) => pattern.test(answer.label));
  const harris = find(/harris/i), trump = find(/trump/i), other = find(/^other/i), none = find(/did not vote/i);
  if (!harris || !trump) throw new Error("the 2024-vote question needs Harris and Trump answers");
  const answered = answers.reduce((total, answer) => total + answer.share, 0);
  const size = (answer) => (answer ? (count.total * answer.share) / answered : 0);
  const net = (answer) => (answer ? (size(answer) * (answer.dem - answer.rep)) / 100 : 0);
  const priorNet = prior.democrat - prior.republican, resultNet = count.dem - count.rep;
  const recalled = size(harris) - size(trump);
  const returningNow = net(harris) + net(trump) + net(other);
  const steps = [
    { key: "turnout", label: "Who turned out", value: Math.round(recalled - priorNet) },
    { key: "switched", label: "Voters who switched", value: Math.round(returningNow - recalled) },
    { key: "new", label: "2024 non-voters", value: Math.round(net(none)) },
  ];
  steps.push({ key: "count", label: "Count vs. exit poll", value: resultNet - priorNet - steps.reduce((total, step) => total + step.value, 0) });
  const whole = (value) => Math.round(value);
  return {
    priorNet, resultNet, change: resultNet - priorNet, steps,
    details: {
      harrisVoters: prior.democrat, harrisReturned: whole(size(harris)), trumpVoters: prior.republican, trumpReturned: whole(size(trump)),
      trumpToDem: whole((size(trump) * trump.dem) / 100), harrisToRep: whole((size(harris) * harris.rep) / 100),
      newVoters: whole(size(none)), newNet: whole(net(none)), newDem: none?.dem ?? null, newRep: none?.rep ?? null, trumpDem: trump.dem, harrisRep: harris.rep,
    },
  };
}

/**
 * Split a whole number of votes in proportion to weights, in whole votes that still add up: round down, then
 * hand the leftover votes to the largest remainders.
 */
export function apportion(votes, weights) {
  const sum = weights.reduce((total, weight) => total + weight, 0);
  if (!sum) return weights.map(() => 0);
  const exact = weights.map((weight) => (votes * weight) / sum);
  const whole = exact.map(Math.floor);
  let leftover = votes - whole.reduce((total, value) => total + value, 0);
  for (const index of exact.map((value, i) => i).sort((a, b) => (exact[b] - whole[b]) - (exact[a] - whole[a]))) {
    if (leftover <= 0) break;
    whole[index] += 1; leftover -= 1;
  }
  return whole;
}

/**
 * Where a candidate's votes came from by 2024 vote: each group's share of the electorate times its support, scaled
 * so the groups add up to the candidate's actual votes (the poll's own total is a little off the count).
 * @param {{ label: string, share: number, dem: number, rep: number }[]} answers the 2024-vote answers
 * @param {"dem"|"rep"} side
 * @param {number} votes the candidate's votes in the count
 */
export function coalition(answers, side, votes) {
  const weights = answers.map((answer) => answer.share * answer[side]);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const whole = apportion(votes, weights);
  return answers.map((answer, i) => ({ label: answer.label, share: round1((100 * weights[i]) / total), votes: whole[i] }));
}

/**
 * Raw-vote estimates for one exit-poll question: how many of the race's voters were in each group (its share of
 * the count's total), and each candidate's votes from each group, scaled so a candidate's groups add up to their
 * actual votes. A group the poll suppressed (too few respondents, published as 0 and 0) is assumed to split like
 * everyone else. `ofTotal` is a share of every vote in the race, third parties included, so 50 is a majority.
 * @param {{ label: string, share: number, dem: number, rep: number }[]} answers
 * @param {{ total: number, dem: number, rep: number }} count the race's votes in the count
 */
export function coalitionStack(answers, count) {
  const known = answers.filter((answer) => answer.dem || answer.rep);
  const knownShare = known.reduce((total, answer) => total + answer.share, 0);
  const overall = (side) => known.reduce((total, answer) => total + answer.share * answer[side], 0) / knownShare;
  const groups = answers.map((answer) => {
    const suppressed = !(answer.dem || answer.rep);
    return { label: answer.label, share: answer.share, suppressed, dem: suppressed ? overall("dem") : answer.dem, rep: suppressed ? overall("rep") : answer.rep };
  });
  const voters = apportion(count.total, groups.map((group) => group.share));
  const ofTotal = (votes) => Math.round((1000 * votes) / count.total) / 10;
  const side = (key, votes) => {
    const parts = apportion(votes, groups.map((group) => group.share * group[key]));
    return {
      votes, ofTotal: ofTotal(votes),
      parts: groups.map((group, i) => ({ label: group.label, rate: round1(group[key]), votes: parts[i], ofTotal: ofTotal(parts[i]), ofCandidate: votes ? round1((100 * parts[i]) / votes) : 0 })),
    };
  };
  return {
    total: count.total, majority: Math.floor(count.total / 2) + 1,
    groups: groups.map((group, i) => ({ label: group.label, share: group.share, voters: voters[i], suppressed: group.suppressed })),
    dem: side("dem", count.dem), rep: side("rep", count.rep),
  };
}

/** The exit-poll questions that split the whole electorate, so their groups' votes can be stacked. */
export const STACK_QUESTIONS = ["vote2024", "race", "raceGender", "gender", "age", "college", "educationRace", "party", "ideology", "area", "region", "method", "firstMidterm", "maga"];

/**
 * What share of each 2024 candidate's voters voted in 2026, from the exit poll's 2024-vote shares and the 2026
 * turnout. Self-reported, so read it as a rough rate.
 */
export function returnRates(answers, turnout2026, harrisVotes, trumpVotes) {
  const answered = answers.reduce((total, answer) => total + answer.share, 0);
  const share = (pattern) => (answers.find((answer) => pattern.test(answer.label))?.share ?? 0) / answered;
  return { harris: Math.round((1000 * share(/harris/i) * turnout2026) / harrisVotes) / 1000, trump: Math.round((1000 * share(/trump/i) * turnout2026) / trumpVotes) / 1000 };
}

/**
 * County rows and region totals: the 2026 Senate and governor margins next to the 2024 presidential, 2022
 * governor, and 2018 Senate results, and turnout against 2022 and 2024.
 * @param {ReturnType<typeof parseCountyReturns>} returns
 * @param {{ elections: Record<string, { counties: { key: string, democrat: number, republican: number, total: number }[] }> }} baselines
 */
export function countyAnalysis(returns, baselines) {
  const byKey = (year) => new Map(baselines.elections[year].counties.map((county) => [county.key, county]));
  const b2024 = byKey("2024"), b2022 = byKey("2022"), b2018 = byKey("2018");
  const counties = [], sums = new Map(REGIONS.map((region) => [region, { votes: 0, sen: [0, 0], gov: [0, 0, 0], p24: [0, 0, 0], g22: [0, 0, 0], s18: [0, 0, 0] }]));
  for (const [key, county] of Object.entries(returns)) {
    const senate = county.races["tx-senate"], governor = county.races["tx-governor"];
    const p24 = b2024.get(key), g22 = b2022.get(key), s18 = b2018.get(key);
    if (!senate?.[3] || !p24) continue;
    const group = countyGroup(county.name);
    counties.push({
      key, name: county.name, group, votes: senate[3], dem: senate[4], rep: senate[5],
      senate: round1(marginOf(senate[4], senate[5], senate[3])), governor: governor?.[3] ? round1(marginOf(governor[4], governor[5], governor[3])) : null,
      pres2024: round1(marginOf(p24.democrat, p24.republican, p24.total)), gov2022: g22 ? round1(marginOf(g22.democrat, g22.republican, g22.total)) : null,
      sen2018: s18 ? round1(marginOf(s18.democrat, s18.republican, s18.total)) : null,
      swing: round1(marginOf(senate[4], senate[5], senate[3]) - marginOf(p24.democrat, p24.republican, p24.total)),
      votes2024: p24.total, votes2022: g22?.total ?? null, harris: p24.democrat, trump: p24.republican,
    });
    const sum = sums.get(group);
    sum.votes += senate[3]; sum.sen[0] += senate[4]; sum.sen[1] += senate[5];
    if (governor?.[3]) { sum.gov[0] += governor[4]; sum.gov[1] += governor[5]; sum.gov[2] += governor[3]; }
    sum.p24[0] += p24.democrat; sum.p24[1] += p24.republican; sum.p24[2] += p24.total;
    if (g22) { sum.g22[0] += g22.democrat; sum.g22[1] += g22.republican; sum.g22[2] += g22.total; }
    if (s18) { sum.s18[0] += s18.democrat; sum.s18[1] += s18.republican; sum.s18[2] += s18.total; }
  }
  const allVotes = counties.reduce((total, county) => total + county.votes, 0);
  const regions = REGIONS.map((region) => {
    const sum = sums.get(region);
    const senate = marginOf(sum.sen[0], sum.sen[1], sum.votes), pres2024 = marginOf(sum.p24[0], sum.p24[1], sum.p24[2]);
    return {
      region, counties: counties.filter((county) => county.group === region).length, votes: sum.votes, share: round1((100 * sum.votes) / allVotes),
      pres2024: round1(pres2024), gov2022: round1(marginOf(...sum.g22)), sen2018: round1(marginOf(...sum.s18)),
      senate: round1(senate), governor: round1(marginOf(...sum.gov)), swing: round1(senate - pres2024),
      turnoutVs2024: Math.round((1000 * sum.votes) / sum.p24[2]) / 1000, turnoutVs2022: Math.round((1000 * sum.votes) / sum.g22[2]) / 1000,
      demVsHarris: Math.round((1000 * sum.sen[0]) / sum.p24[0]) / 1000, repVsTrump: Math.round((1000 * sum.sen[1]) / sum.p24[1]) / 1000,
    };
  });
  return { counties: counties.sort((a, b) => b.votes - a.votes), regions };
}

/** Early (in person and mail) against Election Day votes in a race, statewide, from the county returns. */
export function voteMethodSplit(returns, raceId) {
  let early = [0, 0, 0], all = [0, 0, 0];
  for (const county of Object.values(returns)) {
    const race = county.races[raceId];
    if (!race) continue;
    early = [early[0] + race[0], early[1] + race[1], early[2] + race[2]];
    all = [all[0] + race[3], all[1] + race[4], all[2] + race[5]];
  }
  const day = [all[0] - early[0], all[1] - early[1], all[2] - early[2]];
  return {
    early: { votes: early[0], share: round1((100 * early[0]) / all[0]), margin: round1(marginOf(early[1], early[2], early[0])) },
    electionDay: { votes: day[0], share: round1((100 * day[0]) / all[0]), margin: round1(marginOf(day[1], day[2], day[0])) },
  };
}

/** The statewide races' totals from the county returns, with what the final polls and our model said. */
export function statewideResults(returns, preElectionRaces) {
  return NEEDLE_RACES.map((spec) => {
    let dem = 0, rep = 0, total = 0;
    for (const county of Object.values(returns)) {
      const race = county.races[spec.id];
      if (!race) continue;
      total += race[3]; dem += race[4]; rep += race[5];
    }
    const race = preElectionRaces.find((r) => r.id === spec.id) ?? {};
    const margin = round1(marginOf(dem, rep, total));
    const poll = race.pollingAverage?.margin ?? null;
    return {
      id: spec.id, office: race.office ?? spec.officeName, democrat: race.democrat ?? null, republican: race.republican ?? null,
      dem, rep, total, margin, poll, pollCount: race.pollingAverage?.pollCount ?? null, pollMiss: poll == null ? null : round1(margin - poll),
      aggregates: (race.aggregates ?? []).map((a) => ({ source: a.source, margin: a.margin })), modelD: race.pD ?? null,
    };
  });
}

/**
 * Texas's U.S. House races from the election file's Federal section, with each seat's holder, the forecasters'
 * consensus, and our model's chance from before the election.
 * @param {{ Races?: { N: string, Candidates?: { N: string, P: string, V: number }[] }[] }} federal
 * @param {{ district: number, incumbentParty: string|null, incumbent: string|null, consensus?: { label: string }, modelD?: number }[]} districts
 */
export function usHouseResults(federal, districts) {
  const before = new Map(districts.map((district) => [district.district, district]));
  const rows = [];
  for (const race of federal?.Races ?? []) {
    const match = String(race.N).match(/^U\. ?S\. REPRESENTATIVE DISTRICT (\d+)$/);
    if (!match) continue;
    const candidates = (race.Candidates ?? []).map((c) => ({ name: c.N, party: /^D/.test(String(c.P)) ? "D" : /^R/.test(String(c.P)) ? "R" : String(c.P), votes: Number(c.V) || 0 })).sort((a, b) => b.votes - a.votes);
    const total = candidates.reduce((sum, c) => sum + c.votes, 0);
    const votesOf = (party) => candidates.find((c) => c.party === party)?.votes ?? 0;
    const district = Number(match[1]), held = before.get(district) ?? {};
    rows.push({
      district, winner: titleName(candidates[0]?.name ?? ""), party: candidates[0]?.party ?? null, margin: round1(marginOf(votesOf("D"), votesOf("R"), total)),
      uncontested: candidates.length < 2, heldBy: held.incumbentParty ?? null, incumbent: held.incumbent ?? null, consensus: held.consensus?.label ?? null, modelD: held.modelD ?? null,
    });
  }
  return rows.sort((a, b) => a.district - b.district);
}

/**
 * Every statewide race on the ballot, the courts included: the election file's StateWide section plus the U.S.
 * Senate race from its Federal section, with the two parties' candidates and the margin.
 */
export function statewideOffices(stateWide, federal) {
  const races = [...(federal?.Races ?? []).filter((race) => /^U\. ?S\. SENATOR/.test(String(race.N))), ...(stateWide?.Races ?? [])];
  return races.map((race) => {
    const candidates = (race.Candidates ?? []).map((c) => ({ name: titleName(c.N), party: /^D/.test(String(c.P)) ? "D" : /^R/.test(String(c.P)) ? "R" : String(c.P), votes: Number(c.V) || 0 })).sort((a, b) => b.votes - a.votes);
    const total = candidates.reduce((sum, c) => sum + c.votes, 0);
    const dem = candidates.find((c) => c.party === "D"), rep = candidates.find((c) => c.party === "R");
    return {
      office: officeName(race.N), court: /SUPREME COURT|CRIMINAL APPEALS/.test(String(race.N)), democrat: dem?.name ?? null, republican: rep?.name ?? null,
      winner: candidates[0]?.party ?? null, margin: round1(marginOf(dem?.votes ?? 0, rep?.votes ?? 0, total)), total,
    };
  });
}

/** An office's name from the state's capitals: "JUSTICE, SUPREME COURT, PLACE 2 - UNEXPIRED TERM" → "Justice, Supreme Court, Place 2 (unexpired term)". */
function officeName(name) {
  const [office, note] = String(name).trim().split(/\s+-\s+/);
  const words = office.toLowerCase().replace(/\s+/g, " ").replace(/\b([a-z])/g, (letter) => letter.toUpperCase()).replace(/\b(Of|The)\b/g, (word) => word.toLowerCase()).replace(/^U\. S\./, "U.S.");
  return note ? `${words} (${note.toLowerCase()})` : words;
}

/** A name in the state's capitals, in title case, without the incumbent mark. */
function titleName(name) {
  return String(name).replace(/\s*\(I\)\s*$/, "").toLowerCase().replace(/(^|[\s\-'.(])([a-z])/g, (match, lead, letter) => lead + letter.toUpperCase())
    .replace(/\b(Ii|Iii|Iv)\b/g, (numeral) => numeral.toUpperCase());
}

/** The Texas House by district: 2024 presidential margin against the 2026 result, and whether the seat changed party. */
export function texasHouseRows(districts, results) {
  return districts.map((district) => {
    const result = results?.[district.district];
    const contested = Boolean(result && !result.uncontested && result.candidates.some((c) => c.party === "D") && result.candidates.some((c) => c.party === "R"));
    return {
      district: district.district, heldBy: district.party ?? null, pres2024: district.presidentialMargin2024 ?? null, modelD: district.modelD ?? null,
      winner: result?.leaderName ?? null, party: result?.leader ?? null, margin: result?.margin ?? null, contested,
      flipped: Boolean(result && district.party && result.leader !== district.party),
    };
  });
}

/**
 * Build the page's data from the state's files, the repo's baselines and exit-poll selection, and the morning-of
 * snapshot (the last one before results, so the polls are the final ones).
 * @param {string} dataDir public/data
 */
export async function buildTexas2026Analysis(dataDir) {
  const read = (name) => JSON.parse(readFileSync(join(dataDir, name), "utf8"));
  const baselines = read("tx-county-baselines.json"), exitPoll = read("tx-2026-exit-poll.json"), legislature = read("tx-legislature-results.json");
  let preElection;
  try { preElection = read("history/2026-11-03.json"); } catch { preElection = read("latest.json"); }
  const countyFile = await fetchJson(`${ENR_URL}/election/countyInfo/${NEEDLE_ELECTION.enrId}`, { timeoutMs: 90_000, retries: 1 });
  const returns = parseCountyReturns(JSON.parse(Buffer.from(countyFile.upload, "base64").toString("utf8")));
  const election = await fetchJson(`${ENR_URL}/election/${NEEDLE_ELECTION.enrId}`, { timeoutMs: 60_000, retries: 1 });
  const decode = (section) => (section ? JSON.parse(Buffer.from(section, "base64").toString("utf8")) : null);
  const home = decode(election.Home);

  const statewide = statewideResults(returns, preElection.texas?.races ?? []);
  const senate = statewide.find((race) => race.id === "tx-senate"), governor = statewide.find((race) => race.id === "tx-governor");
  const p2024 = baselines.elections["2024"].statewide;
  const prior = marginOf(p2024.democrat, p2024.republican, p2024.total);
  const exitRaces = exitPoll.races;
  const analysis = (race, exitRace) => {
    const answers = exitRace.questions.vote2024.answers;
    return {
      decomposition: decomposeSwing(answers, prior, marginOf(race.dem, race.rep, race.total)),
      votes: decomposeVotes(answers, p2024, race),
      coalitions: { dem: coalition(answers, "dem", race.dem), rep: coalition(answers, "rep", race.rep) },
      returnRates: returnRates(answers, race.total, p2024.democrat, p2024.republican),
      stacks: Object.fromEntries(STACK_QUESTIONS.filter((key) => exitRace.questions[key]).map((key) => [key, coalitionStack(exitRace.questions[key].answers, race)])),
    };
  };
  const { counties, regions } = countyAnalysis(returns, baselines);
  const houseRows = texasHouseRows(preElection.txHouse?.districts ?? [], legislature.house);
  const usHouse = usHouseResults(decode(election.Federal), (preElection.usHouse?.districts ?? []).filter((d) => d.state === "TX"));
  const sumModel = (rows) => Math.round(rows.reduce((total, row) => total + (row.modelD ?? 0), 0) * 10) / 10;
  return {
    election: "2026-11-03", fetchedAt: new Date().toISOString(), lastUpdated: home?.LastUpdatedTime ?? null, pollsAsOf: preElection.asOf ?? null,
    baselines: Object.fromEntries(Object.entries(baselines.elections).map(([year, e]) => [year, { label: e.label, margin: round1(marginOf(e.statewide.democrat, e.statewide.republican, e.statewide.total)), total: e.statewide.total, democrat: e.statewide.democrat, republican: e.statewide.republican }])),
    registered: preElection.earlyVote?.registered ?? null,
    statewide, offices: statewideOffices(decode(election.StateWide), decode(election.Federal)),
    voteMethod: { "tx-senate": voteMethodSplit(returns, "tx-senate"), "tx-governor": voteMethodSplit(returns, "tx-governor") },
    swing: { "tx-senate": analysis(senate, exitRaces["tx-senate"]), "tx-governor": analysis(governor, exitRaces["tx-governor"]) },
    regions, counties,
    txHouse: {
      before: preElection.txHouse?.current ?? null, majority: preElection.txHouse?.majority ?? null, modelExpectedD: preElection.txHouse?.model?.expected?.D ?? null,
      modelControlD: preElection.txHouse?.model?.control?.D ?? null, districts: houseRows,
    },
    usHouse: { modelExpectedD: sumModel(usHouse), districts: usHouse },
    exitPoll,
  };
}
