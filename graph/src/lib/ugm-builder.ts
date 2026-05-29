/**
 * ugm-builder.ts — Builds the UGM graph model for the playoff picture view.
 *
 * All standings, mode scoring, and strength calculations are imported from
 * ROOT4 (@root4 → src/root4.js) — the same engine that powers the main site.
 * Only UGM-specific graph construction (nodes, edges, playoff probability
 * heuristic) lives here.
 */

import { UGM } from "@g3t/core";
import type { GraphData, GraphNode, GraphEdge } from "../types";
import type { LoadedData } from "./nfl-data";
import {
  computeStandings,
  computeTiebreakerReasons,
  modeScore,
  winPct,
  type StandingEntry,
  type TeamData,
} from "@root4";

// ── Playoff probability heuristic (graph-view only) ───────────────────────
// Not part of the shared engine because it's a visual indicator, not a
// calculation used for recommendations or scenario math.

function playoffProbability(
  abbr: string,
  standing: StandingEntry | undefined,
  teams: Record<string, TeamData>,
  inDivContention = false,
  divGB = 0,
): number {
  const t = teams[abbr];
  if (!t) return 0.5;
  const gamesPlayed = t.record[0] + t.record[1] + t.record[2];
  if (gamesPlayed < 2) return 0.5;
  const progress = Math.min(1, gamesPlayed / 17);
  if (!standing) return 0.5;
  if (standing.kind === "division") return +(0.60 + 0.30 * progress).toFixed(2);
  if (standing.kind === "wildcard") return +(0.45 + 0.20 * progress).toFixed(2);
  if (inDivContention) {
    if (divGB <= 0) return +(0.42 * progress).toFixed(2);
    if (divGB === 1) return +(0.28 * progress).toFixed(2);
    return +(0.14 * progress).toFixed(2);
  }
  const gb = standing.gamesBehind ?? 0;
  if (gb <= 0) return +(0.42 * progress).toFixed(2);
  if (gb === 1) return +(0.28 * progress).toFixed(2);
  if (gb === 2) return +(0.14 * progress).toFixed(2);
  if (gb === 3) return +(0.06 * progress).toFixed(2);
  return 0.01;
}

// ── Playoff impact edges ───────────────────────────────────────────────────
// For every scheduled game (A vs B) and every third team C, computes whether
// A winning helps or hurts C's playoff odds, then emits improvesOdds/hurtsOdds
// edges. Uses modeScore from the shared engine so impact math matches the main
// site's recommendation engine exactly.

function computeAllPlayoffEdges(loaded: LoadedData, mode: string): GraphEdge[] {
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

      const homeHelps = modeScore(g.home, g.away, fav, mode, dislikes, loaded.teams, loaded.weekMeta);
      const awayHelps = modeScore(g.away, g.home, fav, mode, dislikes, loaded.teams, loaded.weekMeta);
      const net = homeHelps - awayHelps;

      if (Math.abs(net) < 0.05) continue;

      const score = Math.min(Math.abs(net) + sBonus, 1.0);
      const helper = net > 0 ? g.home : g.away;
      const hurter  = net > 0 ? g.away : g.home;

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

// ── Head-to-head winsOver edges ───────────────────────────────────────────

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

// ── buildGraphData ─────────────────────────────────────────────────────────

export function buildGraphData(
  loaded: LoadedData,
  favAbbr = "",
  mode = "overall",
): { ugm: UGM; graphData: GraphData } {
  // Use the shared engine for standings — same algorithm as the main site.
  const tiebreakerReasons = computeTiebreakerReasons(loaded.teams);
  const standings = computeStandings(loaded.teams, tiebreakerReasons);
  const wr = loaded.weekMeta.weeksRemaining;

  const oneSeedWins: Partial<Record<string, number>> = {};
  for (const [abbr, entry] of Object.entries(standings.byTeam)) {
    if (entry.seed === 1) oneSeedWins[entry.conf] = loaded.teams[abbr]?.record[0] ?? 0;
  }

  const teamsInWeek = new Set<string>(Object.keys(loaded.teams));
  if (favAbbr) teamsInWeek.add(favAbbr);

  const nodes: GraphNode[] = [];
  for (const abbr of teamsInWeek) {
    const t = loaded.teams[abbr];
    if (!t) continue;
    const standing = standings.byTeam[abbr];
    const label = t.name ? `${t.city} ${t.name}`.trim() : abbr;

    const divRivals = Object.values(loaded.teams).filter(
      o => o.conf === t.conf && o.div === t.div && o.abbr !== abbr
    );
    const maxWinsVal = t.record[0] + wr;
    const inDivContention = standing?.kind === "out"
      && divRivals.every(rival => rival.record[0] <= maxWinsVal);
    const divLeaderWins = divRivals.length > 0
      ? Math.max(...divRivals.map(r => r.record[0]))
      : 0;
    const divGB = Math.max(0, divLeaderWins - t.record[0]);

    const standingKind: GraphNode["standingKind"] =
      !standing              ? "in_hunt"
      : standing.kind === "division" ? "division_leader"
      : standing.kind === "wildcard" ? "wildcard"
      : (standing.gamesBehind ?? 99) <= wr ? "in_hunt"
      : inDivContention ? "in_hunt"
      : "eliminated";

    const prob = standingKind === "eliminated"
      ? 0
      : playoffProbability(abbr, standing, loaded.teams, inDivContention, divGB);

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
      playoffProbability: prob,
      color: t.color.replace(/^#/, ""),
      standingKind,
      nodeLabel,
      isFavorite,
      is1SeedContender,
    });
  }

  const edges = [
    ...computeAllPlayoffEdges(loaded, mode),
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
    games: loaded.schedule.map(g => ({ id: g.id, home: g.home, away: g.away })),
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
