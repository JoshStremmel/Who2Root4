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
// Builds one directed edge per game in the schedule for all games that
// involve at least one team in fav's conference. Includes completed games so
// the graph always has edges regardless of how far into the season we are.

function computePlayoffEdges(
  loaded: LoadedData,
  favAbbr: string,
  dislikes: string[],
  mode: string,
): GraphEdge[] {
  const fav = loaded.teams[favAbbr];
  if (!fav) return [];

  const edges: GraphEdge[] = [];

  for (const g of loaded.schedule) {
    if (g.home === favAbbr || g.away === favAbbr) continue;

    const homeT = loaded.teams[g.home];
    const awayT = loaded.teams[g.away];
    // Only draw edges for games touching fav's conference
    if (homeT?.conf !== fav.conf && awayT?.conf !== fav.conf) continue;

    const h = modeScore(g.home, g.away, fav, mode, dislikes, loaded.teams, loaded);
    const a = modeScore(g.away, g.home, fav, mode, dislikes, loaded.teams, loaded);

    let rootFor: string, against: string, score: number;
    if (h >= a) { rootFor = g.home; against = g.away; score = h; }
    else        { rootFor = g.away; against = g.home; score = a; }

    // Apply team-strength bonus (mirrors computeRecommendations)
    if (score > 0) {
      const hStr = loaded.teamStrengths[g.home]?.strengthScore ?? 0.5;
      const aStr = loaded.teamStrengths[g.away]?.strengthScore ?? 0.5;
      score = Math.min(score + 0.05 * (hStr + aStr) / 2, 1.0);
    }

    const edgeType: "improvesOdds" | "hurtsOdds" | "neutral" =
      score >= 0.10 ? "improvesOdds" : "neutral";

    const reasoning =
      buildReasoning(rootFor, against, fav, mode, score, loaded.teams, loaded)[0] ?? "";

    edges.push({
      id: `edge_${g.id}`,
      source: `urn:nfl:team:${rootFor}`,
      target: `urn:nfl:team:${against}`,
      type: edgeType,
      impactScore: Math.max(score, 0.05), // floor so neutral edges still render
      week: loaded.weekMeta.week,
      gameId: g.id,
      recommendationScore: Math.round(score * 10),
      reasoning,
    });
  }

  return edges;
}

// ── buildGraphData ─────────────────────────────────────────────────────────────

export function buildGraphData(
  loaded: LoadedData,
  favAbbr: string,
  dislikes: string[] = [],
  mode = "overall",
): { ugm: UGM; graphData: GraphData } {
  const standings = computeStandings(loaded.teams);
  const wr = loaded.weekMeta.weeksRemaining;

  // 1-seed win count per conference (for the "1-seed contender" flag)
  const oneSeedWins: Partial<Record<string, number>> = {};
  for (const [abbr, entry] of Object.entries(standings)) {
    if (entry.seed === 1) oneSeedWins[entry.conf] = loaded.teams[abbr]?.record[0] ?? 0;
  }

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

    const standingKind: GraphNode["standingKind"] =
      !standing            ? "in_hunt"
      : standing.kind === "division" ? "division_leader"
      : standing.kind === "wildcard" ? "wildcard"
      : (standing.gamesBehind ?? 99) <= wr ? "in_hunt"
      : "eliminated";

    const seed = standing?.seed ?? null;
    const nodeLabel = abbr; // seed rendered inside circle via SVG background image
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

  // Build edges for all same-conference games (completed or upcoming)
  const edges = computePlayoffEdges(loaded, favAbbr, dislikes, mode);

  // Build UGM instance — no team colors or logos (copyright); use conference for styling
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
