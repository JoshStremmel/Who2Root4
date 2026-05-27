/**
 * UGM builder — port of src/data.js compute functions.
 *
 * computeStandings / computeRecommendations are pure functions that take
 * LoadedData (no window.* reads), then buildGraphData assembles the UGM
 * class instance and GraphData shape consumed by PlayoffGraph.
 */

import { UGM } from "@g3t/core";
import type { GraphData, GraphNode, GraphEdge } from "../types";
import type { LoadedData, TeamData, ScheduleGame } from "./nfl-data";
import { winPct } from "./nfl-data";

// ── Constants ─────────────────────────────────────────────────────────────────

const STRENGTH_WEIGHT = { high: 0.35, medium: 0.20, low: 0.10 };
const ESPN_LOGO = (abbr: string) =>
  `https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${abbr.toLowerCase()}.png`;

// ── Standings helpers ─────────────────────────────────────────────────────────

function gamesBack(fav: TeamData, teams: Record<string, TeamData>): number {
  const divLeader = Object.values(teams)
    .filter(t => t.conf === fav.conf && t.div === fav.div)
    .reduce((a, b) => b.record[0] > a.record[0] ? b : a, fav);
  if (divLeader.abbr === fav.abbr) return 0;
  return ((divLeader.record[0] - fav.record[0]) + (fav.record[1] - divLeader.record[1])) / 2;
}

function weeksRemaining(loaded: LoadedData): number {
  return loaded.weekMeta.weeksRemaining;
}

function inDivisionContention(team: TeamData, teams: Record<string, TeamData>, loaded: LoadedData): boolean {
  return gamesBack(team, teams) <= weeksRemaining(loaded);
}

function maxWins(team: TeamData, loaded: LoadedData): number {
  return team.record[0] + weeksRemaining(loaded);
}

// ── Standings ─────────────────────────────────────────────────────────────────

interface StandingEntry {
  seed: number | null;
  kind: "division" | "wildcard" | "out";
  conf: string;
  gamesBehind?: number;
}

function computeStandings(teams: Record<string, TeamData>): Record<string, StandingEntry> {
  const sortByPct = (a: TeamData, b: TeamData) => winPct(b) - winPct(a) || b.record[0] - a.record[0];
  const byTeam: Record<string, StandingEntry> = {};

  for (const conf of ["AFC", "NFC"]) {
    const divs: Record<string, TeamData[]> = {};
    for (const t of Object.values(teams).filter(t => t.conf === conf)) {
      (divs[t.div] = divs[t.div] ?? []).push(t);
    }
    for (const d of Object.keys(divs)) divs[d].sort(sortByPct);

    const order = ["East","North","South","West"].filter(d => divs[d]);
    const winners = order.map(d => divs[d][0]).filter(Boolean).sort(sortByPct);

    winners.forEach((t, i) => {
      byTeam[t.abbr] = { seed: i + 1, kind: "division", conf };
    });

    const winnersSet = new Set(winners.map(t => t.abbr));
    const rest = Object.values(teams)
      .filter(t => t.conf === conf && !winnersSet.has(t.abbr))
      .sort(sortByPct);

    for (let i = 0; i < 3 && i < rest.length; i++) {
      byTeam[rest[i].abbr] = { seed: 5 + i, kind: "wildcard", conf };
    }
    for (let i = 3; i < rest.length; i++) {
      byTeam[rest[i].abbr] = {
        seed: null, kind: "out", conf,
        gamesBehind: rest[i].record[1] - (rest[2]?.record[1] ?? rest[i].record[1]),
      };
    }
  }
  return byTeam;
}

// ── Scenario detectors ────────────────────────────────────────────────────────

interface ScenarioRow {
  root_for: string;
  against: string;
  category: string;
  strength: "high" | "medium" | "low";
  strength_weight: number;
  why: string;
}

function scenarioRows(
  home: string, away: string,
  fav: TeamData, dislikes: string[], mode: string,
  futureFavOpponents: Set<string>,
  teams: Record<string, TeamData>,
): ScenarioRow[] {
  const out: ScenarioRow[] = [];
  const homeT = teams[home], awayT = teams[away];
  if (!homeT || !awayT) return out;

  for (const team of [home, away]) {
    const t = teams[team];
    if (!t) continue;
    if (t.div === fav.div && t.conf === fav.conf && team !== fav.abbr) {
      const opp = team === home ? away : home;
      out.push({ root_for: opp, against: team, category: "DivisionRivalTank", strength: "high", strength_weight: STRENGTH_WEIGHT.high, why: `${team} is a division rival` });
    }
  }

  for (const team of [home, away]) {
    if (!futureFavOpponents.has(team)) continue;
    const opp = team === home ? away : home;
    const t = teams[team];
    if (!t) continue;
    const [w, l] = t.record;
    if (w !== l) {
      out.push({ root_for: opp, against: team, category: "OpponentTanking", strength: "medium", strength_weight: STRENGTH_WEIGHT.medium, why: `${team} (${w}-${l}) is an upcoming opponent` });
    }
  }

  if (mode !== "division") {
    for (const team of [home, away]) {
      const t = teams[team];
      if (!t || team === fav.abbr || t.conf !== fav.conf) continue;
      if (t.record[0] > t.record[1]) {
        const opp = team === home ? away : home;
        out.push({ root_for: opp, against: team, category: "PlayoffSoftening", strength: "high", strength_weight: STRENGTH_WEIGHT.high, why: `${team} is a ${fav.conf} playoff contender` });
      }
    }
  }

  if (mode !== "division" && homeT.conf === fav.conf && home !== fav.abbr) {
    const gap = homeT.record[0] - awayT.record[0];
    if (gap >= 4) {
      out.push({ root_for: away, against: home, category: "UpsetRooting", strength: "medium", strength_weight: STRENGTH_WEIGHT.medium, why: `${home} is a heavy home favorite (${gap}-win gap)` });
    }
  }

  if (mode === "overall" || mode === "wildcard") {
    for (const team of [home, away]) {
      if (team === fav.abbr) continue;
      const t = teams[team];
      if (!t) continue;
      const isDivRival  = t.div === fav.div && t.conf === fav.conf;
      const isConfThreat = t.conf === fav.conf;
      if (!(isDivRival || isConfThreat)) continue;
      const w = t.record[0];
      if (w >= 6 && w <= 9) {
        const opp = team === home ? away : home;
        out.push({ root_for: opp, against: team, category: "DraftPositioning", strength: "low", strength_weight: STRENGTH_WEIGHT.low, why: `${team} (${w}W) stuck in no-man's-land` });
      }
    }
  }

  for (const team of [home, away]) {
    if (dislikes.includes(team)) {
      const opp = team === home ? away : home;
      out.push({ root_for: opp, against: team, category: "Dislikes", strength: "medium", strength_weight: STRENGTH_WEIGHT.medium, why: `you dislike ${team}` });
    }
  }
  return out;
}

// ── Mode score ────────────────────────────────────────────────────────────────

function modeScore(
  _candidate: string, opponent: string,
  fav: TeamData, mode: string, dislikes: string[],
  teams: Record<string, TeamData>, loaded: LoadedData,
): number {
  const o = teams[opponent];
  if (!o) return 0;
  const isSameDiv  = o.div === fav.div && o.conf === fav.conf;
  const isSameConf = o.conf === fav.conf;
  const wr = weeksRemaining(loaded);
  const favGB = gamesBack(fav, teams);
  let score = 0;

  if (mode === "division") {
    if (isSameDiv) {
      if (inDivisionContention(fav, teams, loaded) && inDivisionContention(o, teams, loaded)) {
        score += 0.25 + 0.25 * Math.max(0, 1 - favGB / Math.max(wr, 1));
      } else score += 0.25;
    }
  } else if (mode === "wildcard") {
    if (isSameConf) score += 0.20;
  } else if (mode === "conf_one_seed") {
    if (isSameConf) score += 0.20 + 0.10 * Math.min(o.record[0] / 17, 1);
  } else {
    if (isSameDiv && inDivisionContention(fav, teams, loaded) && inDivisionContention(o, teams, loaded)) {
      score += 0.20 + 0.20 * Math.max(0, 1 - favGB / Math.max(wr, 1));
    } else if (isSameDiv)  score += 0.20;
    else if (isSameConf)   score += 0.20;
  }
  if (dislikes.includes(opponent)) score += 0.15;
  const favPct = winPct(fav), oppPct = winPct(o);
  score += Math.max(0, 0.10 - Math.abs(favPct - oppPct) * 0.2);
  return score;
}

// ── Reasoning builder ─────────────────────────────────────────────────────────

function buildReasoning(
  _rootAbbr: string, againstAbbr: string,
  fav: TeamData, mode: string, _score: number,
  teams: Record<string, TeamData>, loaded: LoadedData,
): string[] {
  const opp = teams[againstAbbr];
  if (!opp) return ["no direct playoff impact"];
  const targetByMode: Record<string, string> = {
    division: "division title odds", conf_one_seed: "#1 seed odds",
    wildcard: "wild card odds", overall: "wild card odds", tank: "draft slot",
  };
  const target = targetByMode[mode] ?? "playoff odds";

  if (opp.div === fav.div && opp.conf === fav.conf) {
    const fGB = gamesBack(fav, teams), oGB = gamesBack(opp, teams), wr = weeksRemaining(loaded);
    if (inDivisionContention(fav, teams, loaded) && inDivisionContention(opp, teams, loaded)) {
      let gbStr: string;
      if (fGB === 0 && oGB > 0)       gbStr = `${againstAbbr} is ${oGB.toFixed(1)} GB behind you`;
      else if (oGB === 0 && fGB > 0)  gbStr = `you are ${fGB.toFixed(1)} GB behind ${againstAbbr}`;
      else if (fGB < oGB)              gbStr = `${againstAbbr} is ${(oGB - fGB).toFixed(1)} GB behind you`;
      else if (oGB < fGB)              gbStr = `you are ${(fGB - oGB).toFixed(1)} GB behind ${againstAbbr}`;
      else                             gbStr = "tied in the division";
      return [`${againstAbbr} is a division rival (${gbStr}, ${wr} weeks left) — their loss directly helps`];
    }
    return [`${againstAbbr} is a division rival — their loss improves ${target}`];
  }
  if (opp.conf === fav.conf) {
    if (mode === "conf_one_seed") return [`${againstAbbr} (${opp.record[0]}W) is a ${fav.conf} rival — their loss improves ${target}`];
    return [`${againstAbbr} is a conference competitor — their loss improves ${target}`];
  }
  return ["no direct playoff impact"];
}

// ── Tank scorer ───────────────────────────────────────────────────────────────

function scoreGameTank(home: string, away: string, fav: TeamData, teams: Record<string, TeamData>) {
  if (home === fav.abbr || away === fav.abbr) return null;
  const favWins = fav.record[0];
  const hW = teams[home]?.record[0] ?? 0, aW = teams[away]?.record[0] ?? 0;
  const [rootAbbr, againstAbbr, rootWins] = hW <= aW ? [home, away, hW] : [away, home, aW];
  const minGap = Math.min(Math.abs(hW - favWins), Math.abs(aW - favWins));
  let base = minGap === 0 ? 0.5 : minGap === 1 ? 0.35 : minGap === 2 ? 0.20 : minGap === 3 ? 0.10 : 0.05;
  const rT = teams[rootAbbr];
  if (rT?.div === fav.div && rT?.conf === fav.conf) base = Math.min(base + 0.15, 1.0);
  const strength: "high"|"medium"|"low" = base >= 0.35 ? "high" : base >= 0.20 ? "medium" : "low";
  const why = rootWins < favWins
    ? `${rootAbbr} (${rootWins}W) is below you — their win protects your draft slot`
    : `${rootAbbr} (${rootWins}W) is tied/ahead — their win separates them from your draft range`;
  return { rootFor: rootAbbr, against: againstAbbr, score: base, strength, strength_weight: STRENGTH_WEIGHT[strength], category: "TankPositioning", reasonsAll: [why] };
}

// ── Underdog resolver ─────────────────────────────────────────────────────────

function resolveUnderdog(g: ScheduleGame): string | null {
  if (g.spread != null) {
    if (g.spread < 0) return g.away;
    if (g.spread > 0) return g.home;
  }
  if (g.homeFavorite != null) return g.homeFavorite ? g.away : g.home;
  return null;
}

// ── computeRecommendations ────────────────────────────────────────────────────

interface Recommendation {
  gameId: string;
  rootFor: string;
  against: string;
  score: number;
  category: string;
  strength: string;
  reasoning: string;
}

function computeRecommendations(
  favAbbr: string, dislikes: string[], mode: string, loaded: LoadedData,
): Recommendation[] {
  const fav = loaded.teams[favAbbr];
  if (!fav) return [];
  const teams = loaded.teams;
  const dl = dislikes.map(d => d.toUpperCase());
  const futureFavOpponents = new Set(
    loaded.schedule
      .filter(g => g.home === favAbbr || g.away === favAbbr)
      .map(g => g.home === favAbbr ? g.away : g.home),
  );

  const recs: Recommendation[] = [];

  for (const g of loaded.schedule) {
    if (g.home === favAbbr || g.away === favAbbr) continue;
    if (g.completed) continue;

    if (mode === "tank") {
      const r = scoreGameTank(g.home, g.away, fav, teams);
      if (r) recs.push({ gameId: g.id, rootFor: r.rootFor, against: r.against, score: r.score, category: r.category, strength: r.strength, reasoning: r.reasonsAll[0] });
      continue;
    }

    let playoffRoot = g.home, playoffAgainst = g.away, playoffScore = 0;
    const homeT = teams[g.home], awayT = teams[g.away];
    if (homeT?.conf === fav.conf || awayT?.conf === fav.conf) {
      const h = modeScore(g.home, g.away, fav, mode, dl, teams, loaded);
      const a = modeScore(g.away, g.home, fav, mode, dl, teams, loaded);
      const ud = resolveUnderdog(g);
      const udBonus = 0.02;
      const adjH = h + (g.home === ud ? udBonus : 0);
      const adjA = a + (g.away === ud ? udBonus : 0);
      if (adjH >= adjA) { playoffRoot = g.home; playoffAgainst = g.away; playoffScore = h; }
      else              { playoffRoot = g.away; playoffAgainst = g.home; playoffScore = a; }
    }

    const scenarios = scenarioRows(g.home, g.away, fav, dl, mode, futureFavOpponents, teams);
    const homeWeight = scenarios.filter(s => s.root_for === g.home).reduce((a,b) => a+b.strength_weight, 0);
    const awayWeight = scenarios.filter(s => s.root_for === g.away).reduce((a,b) => a+b.strength_weight, 0);

    let rootAbbr: string, againstAbbr: string, category: string, score: number, reasonsAll: string[];

    if (homeWeight > 0 || awayWeight > 0) {
      rootAbbr = homeWeight >= awayWeight ? g.home : g.away;
      againstAbbr = rootAbbr === g.home ? g.away : g.home;
      const matching = scenarios.filter(s => s.root_for === rootAbbr).sort((a,b) => b.strength_weight - a.strength_weight);
      const primary = matching[0];
      category = primary.category;
      score = rootAbbr === playoffRoot ? playoffScore : 0;
      reasonsAll = [primary.why];
      if (matching.length > 1 && matching[1].strength_weight >= 0.20 && matching[1].category !== primary.category) {
        reasonsAll.push(matching[1].why);
      }
      if (playoffScore > 0 && rootAbbr === playoffRoot && primary.strength_weight < 0.35) {
        reasonsAll.push(...buildReasoning(rootAbbr, againstAbbr, fav, mode, playoffScore, teams, loaded));
      }
    } else {
      rootAbbr = playoffRoot; againstAbbr = playoffAgainst;
      score = playoffScore;
      category = score > 0 ? "direct_playoff_impact" : "no_impact";
      reasonsAll = buildReasoning(rootAbbr, againstAbbr, fav, mode, score, teams, loaded);
    }

    if (score > 0) {
      const hStr = loaded.teamStrengths[g.home]?.strengthScore ?? 0.5;
      const aStr = loaded.teamStrengths[g.away]?.strengthScore ?? 0.5;
      score = Math.min(score + 0.05 * (hStr + aStr) / 2, 1.0);
    }

    recs.push({ gameId: g.id, rootFor: rootAbbr, against: againstAbbr, score, category, strength: score > 0.25 ? "high" : score > 0.10 ? "medium" : "low", reasoning: reasonsAll[0] ?? "" });
  }

  recs.sort((a, b) => b.score - a.score);
  return recs;
}

// ── Playoff probability heuristic ─────────────────────────────────────────────

function playoffProbability(abbr: string, standing: StandingEntry | undefined, teams: Record<string, TeamData>): number {
  const t = teams[abbr];
  if (!t) return 0.5;
  const gamesPlayed = t.record[0] + t.record[1] + t.record[2];
  if (gamesPlayed < 2) return 0.5;

  const progress = Math.min(1, gamesPlayed / 17);

  if (!standing) return 0.5;
  if (standing.kind === "division") {
    return +(0.60 + 0.30 * progress).toFixed(2);
  }
  if (standing.kind === "wildcard") {
    return +(0.45 + 0.20 * progress).toFixed(2);
  }
  // "out"
  const gb = standing.gamesBehind ?? 0;
  if (gb <= 0) return +(0.42 * progress).toFixed(2);
  if (gb === 1) return +(0.28 * progress).toFixed(2);
  if (gb === 2) return +(0.14 * progress).toFixed(2);
  if (gb === 3) return +(0.06 * progress).toFixed(2);
  return 0.01;
}

// ── buildGraphData ─────────────────────────────────────────────────────────────

export function buildGraphData(
  loaded: LoadedData,
  favAbbr: string,
  dislikes: string[] = [],
  mode = "overall",
): { ugm: UGM; graphData: GraphData } {
  const standings = computeStandings(loaded.teams);
  const recs = computeRecommendations(favAbbr, dislikes, mode, loaded);

  // Collect all teams in current week + fav
  const teamsInWeek = new Set<string>([favAbbr]);
  for (const g of loaded.schedule) { teamsInWeek.add(g.home); teamsInWeek.add(g.away); }

  // Build nodes
  const nodes: GraphNode[] = [];
  for (const abbr of teamsInWeek) {
    const t = loaded.teams[abbr];
    if (!t) continue;
    const standing = standings[abbr];
    const label = t.name ? `${t.city} ${t.name}`.trim() : abbr;
    nodes.push({
      id: `urn:nfl:team:${abbr}`,
      label,
      abbreviation: abbr,
      division: `${t.conf} ${t.div}`,
      conference: t.conf,
      wins: t.record[0],
      losses: t.record[1],
      playoffSeed: standing?.seed ?? null,
      playoffProbability: playoffProbability(abbr, standing, loaded.teams),
      color: t.color.replace(/^#/, ""),
      logoUrl: t.logo ?? ESPN_LOGO(abbr),
    });
  }

  // Build edges from recommendations with positive score
  const edges: GraphEdge[] = [];
  for (const rec of recs) {
    if (rec.score <= 0) continue;
    const edgeType: "improvesOdds" | "hurtsOdds" | "neutral" =
      rec.score >= 0.05 ? "improvesOdds" : "neutral";
    edges.push({
      id: `edge_${rec.gameId}_${rec.rootFor}_${rec.against}`,
      source: `urn:nfl:team:${rec.rootFor}`,
      target: `urn:nfl:team:${rec.against}`,
      type: edgeType,
      impactScore: Math.min(1, rec.score),
      week: loaded.weekMeta.week,
      gameId: rec.gameId,
      recommendationScore: Math.round(rec.score * 10),
      reasoning: rec.reasoning,
    });
  }

  // Build UGM instance
  const ugm = new UGM();
  for (const n of nodes) {
    ugm.addNode(n.id, {
      types: ["Team"],
      properties: {
        name:               n.label,
        abbreviation:       n.abbreviation,
        division:           n.division,
        conference:         n.conference,
        wins:               n.wins,
        losses:             n.losses,
        playoffSeed:        n.playoffSeed,
        playoffProbability: n.playoffProbability,
        teamColor:          `#${n.color}`,
        logoUrl:            n.logoUrl,
      },
    });
  }
  for (const e of edges) {
    if (ugm.hasNode(e.source) && ugm.hasNode(e.target)) {
      ugm.addEdge(e.source, e.target, {
        type: e.type,
        properties: {
          impactScore:         e.impactScore,
          week:                e.week,
          gameId:              e.gameId,
          recommendationScore: e.recommendationScore,
          reasoning:           e.reasoning,
        },
      });
    }
  }

  const graphData: GraphData = {
    nodes,
    edges,
    meta: {
      favoriteTeam: favAbbr,
      week: loaded.weekMeta.week,
      season: loaded.season,
      isPreseason: loaded.schedule.length === 0,
      gameCount: loaded.schedule.length,
    },
  };

  return { ugm, graphData };
}
