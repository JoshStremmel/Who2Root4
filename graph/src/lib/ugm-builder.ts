/**
 * UGM builder — port of src/data.js compute functions.
 *
 * computeStandings / computeRecommendations are pure functions that take
 * LoadedData (no window.* reads), then buildGraphData assembles the UGM
 * class instance and GraphData shape consumed by PlayoffGraph.
 */

import { UGM } from "@g3t/core";
import type { GraphData, GraphNode, GraphEdge } from "../types";
import type { LoadedData, TeamData } from "./nfl-data";
import { winPct } from "./nfl-data";

// ── Constants ─────────────────────────────────────────────────────────────────

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

// ── Playoff edge builder ──────────────────────────────────────────────────────
// For every scheduled game (A vs B) and every other team C, computes the net
// effect of A winning on C's playoff odds, then emits:
//   • improvesOdds A→C when A winning is a net positive for C
//   • hurtsOdds   A→C when A winning is a net negative for C
// (and the symmetric edge for B).  One edge per (type, source, target) pair —
// the highest-scoring one wins when multiple games produce the same key.

function computeAllPlayoffEdges(loaded: LoadedData): GraphEdge[] {
  const mode = "overall";
  const dislikes: string[] = [];
  const edgeMap = new Map<string, GraphEdge>();

  const upsert = (edge: GraphEdge) => {
    const ex = edgeMap.get(edge.id);
    if (!ex || edge.impactScore > ex.impactScore) edgeMap.set(edge.id, edge);
  };

  for (const g of loaded.schedule) {
    if (!loaded.teams[g.home] || !loaded.teams[g.away]) continue;
    const sBonus = 0.05 * (
      (loaded.teamStrengths[g.home]?.strengthScore ?? 0.5) +
      (loaded.teamStrengths[g.away]?.strengthScore ?? 0.5)
    ) / 2;

    for (const [abbr, fav] of Object.entries(loaded.teams)) {
      if (abbr === g.home || abbr === g.away) continue;

      // Net effect of home winning on fav's odds.
      // Positive → home winning helps fav (away is fav's rival).
      // Negative → home winning hurts fav (home is fav's rival).
      const homeHelps = modeScore(g.home, g.away, fav, mode, dislikes, loaded.teams, loaded);
      const awayHelps = modeScore(g.away, g.home, fav, mode, dislikes, loaded.teams, loaded);
      const net = homeHelps - awayHelps;
      if (Math.abs(net) < 0.05) continue;

      const score = Math.min(Math.abs(net) + sBonus, 1.0);
      const helper = net > 0 ? g.home : g.away;  // team whose win helps abbr
      const hurter = net > 0 ? g.away : g.home;  // team whose win hurts abbr

      upsert({
        id: `imp_${helper}_${abbr}`,
        source: `urn:nfl:team:${helper}`,
        target: `urn:nfl:team:${abbr}`,
        type: "improvesOdds",
        impactScore: score,
        week: loaded.weekMeta.week,
        gameId: g.id,
        recommendationScore: Math.round(score * 100),
        reasoning: `${helper} beating ${hurter} helps ${abbr}`,
      });
      upsert({
        id: `hrt_${hurter}_${abbr}`,
        source: `urn:nfl:team:${hurter}`,
        target: `urn:nfl:team:${abbr}`,
        type: "hurtsOdds",
        impactScore: score,
        week: loaded.weekMeta.week,
        gameId: g.id,
        recommendationScore: Math.round(score * 100),
        reasoning: `${hurter} beating ${helper} hurts ${abbr}`,
      });
    }
  }

  return Array.from(edgeMap.values());
}

// ── winsOver edge builder ──────────────────────────────────────────────────────
// One directed edge per same-conference head-to-head result this season.
// Only includes teams that appear in the current graph (nodeIds).

function computeWinsOverEdges(
  loaded: LoadedData,
  nodeIds: Set<string>,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const abbr of nodeIds) {
    const team = loaded.teams[abbr];
    if (!team) continue;
    for (const result of team.results) {
      if (!result.win) continue;
      if (!nodeIds.has(result.oppAbbr)) continue;
      const oppTeam = loaded.teams[result.oppAbbr];
      if (!oppTeam) continue;
      const key = `${abbr}_${result.oppAbbr}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        id: `wo_${abbr}_${result.oppAbbr}_w${result.week}`,
        source: `urn:nfl:team:${abbr}`,
        target: `urn:nfl:team:${result.oppAbbr}`,
        type: "winsOver",
        impactScore: 0.3,
        week: result.week,
        gameId: `wo_${abbr}_${result.oppAbbr}_w${result.week}`,
        recommendationScore: 0,
        reasoning: `${abbr} beat ${result.oppAbbr} in Week ${result.week}`,
      });
    }
  }
  return edges;
}

// ── buildGraphData ─────────────────────────────────────────────────────────────

export function buildGraphData(
  loaded: LoadedData,
  favAbbr = "",
): { ugm: UGM; graphData: GraphData } {
  const standings = computeStandings(loaded.teams);
  const wr = loaded.weekMeta.weeksRemaining;

  // 1-seed win count per conference (for the "1-seed contender" flag)
  const oneSeedWins: Partial<Record<string, number>> = {};
  for (const [abbr, entry] of Object.entries(standings)) {
    if (entry.seed === 1) oneSeedWins[entry.conf] = loaded.teams[abbr]?.record[0] ?? 0;
  }

  // All known teams in the graph
  const teamsInWeek = new Set<string>(Object.keys(loaded.teams));
  if (favAbbr) teamsInWeek.add(favAbbr);

  // Build nodes
  const nodes: GraphNode[] = [];
  for (const abbr of teamsInWeek) {
    const t = loaded.teams[abbr];
    if (!t) continue;
    const standing = standings[abbr];
    const label = t.name ? `${t.city} ${t.name}`.trim() : abbr;

    const standingKind: GraphNode["standingKind"] =
      !standing            ? "in_hunt"
      : standing.kind === "division" ? "division_leader"
      : standing.kind === "wildcard" ? "wildcard"
      : (standing.gamesBehind ?? 99) <= wr ? "in_hunt"
      : "eliminated";

    const seed = standing?.seed ?? null;
    const nodeLabel = seed != null ? `#${seed} ${abbr}` : abbr;
    const isFavorite = abbr === favAbbr;
    const seed1W = oneSeedWins[t.conf] ?? 0;
    const is1SeedContender = t.record[0] + wr >= seed1W;

    nodes.push({
      id: `urn:nfl:team:${abbr}`,
      label,
      abbreviation: abbr,
      division: `${t.conf} ${t.div}`,
      conference: t.conf,
      wins: t.record[0],
      losses: t.record[1],
      playoffSeed: seed,
      playoffProbability: playoffProbability(abbr, standing, loaded.teams),
      color: t.color.replace(/^#/, ""),
      standingKind,
      nodeLabel,
      isFavorite,
      is1SeedContender,
    });
  }

  // Build edges: playoff impact edges + head-to-head winsOver edges
  const edges = [
    ...computeAllPlayoffEdges(loaded),
    ...computeWinsOverEdges(loaded, teamsInWeek),
  ];

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
        standingKind:       n.standingKind,
        nodeLabel:          n.nodeLabel,
        isFavorite:         n.isFavorite,
        is1SeedContender:   n.is1SeedContender,
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
