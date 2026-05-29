/**
 * ROOT4 — The single canonical NFL calculation engine.
 *
 * All functions are pure: they take data as parameters and read nothing from
 * window.* globals. The main app (src/data.js) wraps these as window.* for
 * its JSX components. The graph app imports them directly via Vite alias.
 *
 * When you change a calculation here, BOTH the main page and the graph view
 * update automatically — there is no other copy of this logic.
 */

/* ─── Static team metadata ───────────────────────────────────────────────── */
export const DIVISIONS = {
  BUF:["AFC","East"],  MIA:["AFC","East"],  NE:["AFC","East"],   NYJ:["AFC","East"],
  BAL:["AFC","North"], CIN:["AFC","North"], CLE:["AFC","North"], PIT:["AFC","North"],
  HOU:["AFC","South"], IND:["AFC","South"], JAX:["AFC","South"], TEN:["AFC","South"],
  DEN:["AFC","West"],  KC: ["AFC","West"],  LV: ["AFC","West"],  LAC:["AFC","West"],
  DAL:["NFC","East"],  NYG:["NFC","East"],  PHI:["NFC","East"],  WAS:["NFC","East"],
  CHI:["NFC","North"], DET:["NFC","North"], GB: ["NFC","North"], MIN:["NFC","North"],
  ATL:["NFC","South"], CAR:["NFC","South"], NO: ["NFC","South"], TB: ["NFC","South"],
  ARI:["NFC","West"],  LAR:["NFC","West"],  SF: ["NFC","West"],  SEA:["NFC","West"],
};

export const ABBR_ALIAS = { WSH: "WAS", JAC: "JAX" };
export const normAbbr = (a) => ABBR_ALIAS[a] || a;

export const TEAM_COLOR_FALLBACK = {
  PIT:"#ffb612", BAL:"#241773", CIN:"#fb4f14", CLE:"#311d00",
  BUF:"#00338d", MIA:"#008e97", NYJ:"#125740", NE:"#002a5c",
  HOU:"#03202f", IND:"#002c5f", JAX:"#006778", TEN:"#19c6ff",
  KC:"#e31837",  LAC:"#0080c6", DEN:"#fb4f14", LV:"#000000",
  DET:"#0076b6", GB:"#203731",  MIN:"#4f2683", CHI:"#0b162a",
  PHI:"#004c54", DAL:"#003594", WAS:"#5a1414", NYG:"#0b2265",
  TB:"#d50a0a",  ATL:"#a71930", NO:"#d3bc8d",  CAR:"#0085ca",
  SF:"#aa0000",  LAR:"#003594", SEA:"#002244", ARI:"#97233f",
};

export const MODES = [
  { id: "overall",       label: "Overall",        desc: "Base playoff contention. Division + wild card combined." },
  { id: "division",      label: "Division Title", desc: "Only division-rival games matter. Wild card noise removed." },
  { id: "wildcard",      label: "Wild Card",      desc: "All conference losses equally valuable." },
  { id: "conf_one_seed", label: "#1 Seed",        desc: "Climb to the top seed for a bye + home through the playoffs." },
  { id: "tank",          label: "Tank",           desc: "Root for losses. Best draft pick wins." },
];

export const CATEGORY_META = {
  DivisionRivalTank:     { label: "Division rival tank",  tone: "fav",     help: "Their loss directly improves your division standing." },
  OpponentTanking:       { label: "Opponent tanking",     tone: "neutral", help: "An upcoming team for you — soften them up first." },
  PlayoffSoftening:      { label: "Playoff impact",       tone: "fav",     help: "A conference playoff contender — their loss directly tightens the race for you." },
  UpsetRooting:          { label: "Upset rooting",        tone: "warn",    help: "Heavy home favorite in your conference. Trap-game potential." },
  DraftPositioning:      { label: "Draft positioning",    tone: "neutral", help: "Stuck in no-man's-land; keep them losing." },
  Dislikes:              { label: "Personal rivalry",     tone: "warn",    help: "Boosted because you marked them as disliked." },
  TankPositioning:       { label: "Tank positioning",     tone: "fav",     help: "Protect your draft slot — bring teams below you up." },
  direct_playoff_impact: { label: "Playoff impact",       tone: "fav",     help: "Direct playoff math: their loss improves your odds." },
  no_impact:             { label: "No impact",            tone: "muted",   help: "Not in your conference; result doesn't move your odds." },
};

export const STRENGTH_WEIGHT = { high: 0.35, medium: 0.20, low: 0.10 };

export const STRENGTH_META = {
  high:   { label: "High",   weight: 0.35, color: "var(--accent)" },
  medium: { label: "Medium", weight: 0.20, color: "oklch(0.66 0.10 50)" },
  low:    { label: "Low",    weight: 0.10, color: "var(--text-faint)" },
};

/* ─── Core helpers ───────────────────────────────────────────────────────── */

export function winPct(t) {
  const w = t.record[0], l = t.record[1], ties = t.record[2] || 0;
  const games = w + l + ties;
  return games === 0 ? 0 : (w + 0.5 * ties) / games;
}

export function gamesBack(fav, teams) {
  const divLeader = Object.values(teams)
    .filter(t => t.conf === fav.conf && t.div === fav.div)
    .reduce((a, b) => (b.record[0] > a.record[0] ? b : a), fav);
  if (divLeader.abbr === fav.abbr) return 0;
  return ((divLeader.record[0] - fav.record[0]) + (fav.record[1] - divLeader.record[1])) / 2;
}

export function weeksRemainingFrom(weekMeta) {
  return weekMeta?.weeksRemaining ?? 0;
}

export function inDivisionContention(team, teams, weekMeta) {
  return gamesBack(team, teams) <= weeksRemainingFrom(weekMeta);
}

export function maxWins(team, weekMeta) {
  return team.record[0] + weeksRemainingFrom(weekMeta);
}

export function resolveUnderdog(g) {
  if (g.spread != null) {
    if (g.spread < 0) return g.away;
    if (g.spread > 0) return g.home;
  }
  if (g.homeMoneyLine != null && g.awayMoneyLine != null) {
    if (g.homeMoneyLine < g.awayMoneyLine) return g.away;
    if (g.awayMoneyLine < g.homeMoneyLine) return g.home;
  }
  if (g.homeFavorite != null) return g.homeFavorite ? g.away : g.home;
  return null;
}

/* ─── Team strength ──────────────────────────────────────────────────────── */

export function buildTeamStrengths(teams) {
  const out = {};
  const raw = {};
  for (const abbr of Object.keys(teams)) {
    const t = teams[abbr];
    const wp = winPct(t);
    const pd = t.pf - t.pa;
    const recent = t.results.slice(-4);
    const recentWp = recent.length ? recent.filter(r => r.win).length / recent.length : 0;
    const margins = t.results.filter(r => r.win).map(r => r.pf - r.pa);
    let consistency = 0.5;
    if (margins.length >= 2) {
      const mean = margins.reduce((a, b) => a + b, 0) / margins.length;
      const variance = margins.reduce((s, m) => s + (m - mean) * (m - mean), 0) / margins.length;
      consistency = Math.max(0, Math.min(1, 1 - Math.sqrt(variance) / 28));
    }
    const divGames = t.results.filter(r => {
      const opp = teams[r.oppAbbr];
      return opp && opp.div === t.div && opp.conf === t.conf;
    });
    const divBonus = divGames.length ? divGames.filter(r => r.win).length / divGames.length : 0.5;
    const oppWps = t.results.map(r => winPct(teams[r.oppAbbr] || { record: [0, 0, 0] }));
    const sos = oppWps.length ? oppWps.reduce((a, b) => a + b, 0) / oppWps.length : 0.5;
    raw[abbr] = { wp, pd, recentWp, consistency, divBonus, sos };
  }
  const pds = Object.values(raw).map(r => r.pd);
  const minPd = Math.min(...pds, 0), maxPd = Math.max(...pds, 0);
  const range = (maxPd - minPd) || 1;
  for (const abbr of Object.keys(raw)) {
    const r = raw[abbr];
    const pointDiff = (r.pd - minPd) / range;
    const strengthScore = Math.max(0, Math.min(1,
      0.35 * r.wp + 0.25 * pointDiff + 0.15 * r.recentWp + 0.10 * r.consistency + 0.10 * r.divBonus + 0.05 * r.sos
    ));
    out[abbr] = {
      strengthScore: +strengthScore.toFixed(2),
      pointDiff:     +pointDiff.toFixed(2),
      sos:           +r.sos.toFixed(2),
      divisionBonus: +r.divBonus.toFixed(2),
      recentForm:    +r.recentWp.toFixed(2),
      winMarginConsistency: +r.consistency.toFixed(2),
    };
  }
  return out;
}

/* ─── Tiebreakers ────────────────────────────────────────────────────────── */

export function computeTiebreakerReasons(rawTeams) {
  if (!rawTeams) return {};

  const pctOf = (res) => {
    if (!res || !res.length) return null;
    const w = res.filter(r => r.win).length, t = res.filter(r => r.tie).length;
    return (w + 0.5 * t) / res.length;
  };
  const netPts = (res) => (res || []).reduce((s, r) => s + (r.pf || 0) - (r.pa || 0), 0);

  const sovOf = (team) => {
    const wins = (team.results || []).filter(r => r.win);
    if (!wins.length) return null;
    let w = 0, l = 0, t = 0;
    for (const r of wins) { const o = rawTeams[r.oppAbbr]; if (!o) continue; w += o.record[0]; l += o.record[1]; t += o.record[2] || 0; }
    const g = w + l + t;
    return g ? (w + 0.5 * t) / g : null;
  };

  const sosOf = (team) => {
    const games = team.results || [];
    if (!games.length) return null;
    let w = 0, l = 0, t = 0;
    for (const r of games) { const o = rawTeams[r.oppAbbr]; if (!o) continue; w += o.record[0]; l += o.record[1]; t += o.record[2] || 0; }
    const g = w + l + t;
    return g ? (w + 0.5 * t) / g : null;
  };

  const commonOf = (a, b) => {
    const aOpps = new Set((a.results || []).map(r => r.oppAbbr).filter(x => x !== b.abbr));
    const bOpps = new Set((b.results || []).map(r => r.oppAbbr).filter(x => x !== a.abbr));
    const common = new Set([...aOpps].filter(x => bOpps.has(x)));
    if (!common.size) return null;
    const ag = (a.results || []).filter(r => common.has(r.oppAbbr));
    const bg = (b.results || []).filter(r => common.has(r.oppAbbr));
    return (ag.length >= 4 && bg.length >= 4) ? [ag, bg] : null;
  };

  const combinedRank = (abbr, pool) => {
    const byPF = [...pool].sort((a, b) => (b.pf || 0) - (a.pf || 0));
    const byPA = [...pool].sort((a, b) => (a.pa || 0) - (b.pa || 0));
    return (byPF.findIndex(t => t.abbr === abbr) + 1) + (byPA.findIndex(t => t.abbr === abbr) + 1);
  };

  const divBreak = (a, b, confPool, allPool) => {
    const h2h = (a.results || []).filter(r => r.oppAbbr === b.abbr);
    const hW = h2h.filter(r => r.win).length, hL = h2h.filter(r => !r.win && !r.tie).length;
    if (h2h.length && hW !== hL) return hW > hL ? `Head-to-head (${hW}-${hL})` : null;

    const aDR = (a.results || []).filter(r => { const o = rawTeams[r.oppAbbr]; return o && o.conf === a.conf && o.div === a.div; });
    const bDR = (b.results || []).filter(r => { const o = rawTeams[r.oppAbbr]; return o && o.conf === b.conf && o.div === b.div; });
    const aDp = pctOf(aDR), bDp = pctOf(bDR);
    if (aDp !== null && bDp !== null && Math.abs(aDp - bDp) > 1e-6) {
      if (aDp > bDp) { const w = aDR.filter(r => r.win).length, l = aDR.filter(r => !r.win && !r.tie).length; return `Division record (${w}-${l})`; }
      return null;
    }

    const cg = commonOf(a, b);
    if (cg) {
      const [aCG, bCG] = cg;
      const acp = pctOf(aCG), bcp = pctOf(bCG);
      if (acp !== null && bcp !== null && Math.abs(acp - bcp) > 1e-6) {
        if (acp > bcp) { const w = aCG.filter(r => r.win).length, l = aCG.filter(r => !r.win && !r.tie).length; return `Common games (${w}-${l})`; }
        return null;
      }
    }

    const aCR = (a.results || []).filter(r => rawTeams[r.oppAbbr]?.conf === a.conf);
    const bCR = (b.results || []).filter(r => rawTeams[r.oppAbbr]?.conf === b.conf);
    const aCp = pctOf(aCR), bCp = pctOf(bCR);
    if (aCp !== null && bCp !== null && Math.abs(aCp - bCp) > 1e-6) {
      if (aCp > bCp) { const w = aCR.filter(r => r.win).length, l = aCR.filter(r => !r.win && !r.tie).length; return `Conference record (${w}-${l})`; }
      return null;
    }

    const asv = sovOf(a), bsv = sovOf(b);
    if (asv !== null && bsv !== null && Math.abs(asv - bsv) > 1e-6) return asv > bsv ? `Strength of victory (${asv.toFixed(3)})` : null;

    const ass = sosOf(a), bss = sosOf(b);
    if (ass !== null && bss !== null && Math.abs(ass - bss) > 1e-6) return ass > bss ? `Strength of schedule (${ass.toFixed(3)})` : null;

    const arc = combinedRank(a.abbr, confPool), brc = combinedRank(b.abbr, confPool);
    if (arc !== brc) return arc < brc ? `Conference points rank (#${arc})` : null;

    const ara = combinedRank(a.abbr, allPool), bra = combinedRank(b.abbr, allPool);
    if (ara !== bra) return ara < bra ? `League points rank (#${ara})` : null;

    if (cg) {
      const an = netPts(cg[0]), bn = netPts(cg[1]);
      if (an !== bn) return an > bn ? `Net points, common games (${an > 0 ? '+' : ''}${an})` : null;
    }

    const an = (a.pf || 0) - (a.pa || 0), bn = (b.pf || 0) - (b.pa || 0);
    if (an !== bn) return an > bn ? `Net points in all games (${an > 0 ? '+' : ''}${an})` : null;

    return undefined;
  };

  const wcBreak = (a, b, confPool, allPool) => {
    const h2h = (a.results || []).filter(r => r.oppAbbr === b.abbr);
    const hW = h2h.filter(r => r.win).length, hL = h2h.filter(r => !r.win && !r.tie).length;
    if (h2h.length && hW !== hL) return hW > hL ? `Head-to-head (${hW}-${hL})` : null;

    const aCR = (a.results || []).filter(r => rawTeams[r.oppAbbr]?.conf === a.conf);
    const bCR = (b.results || []).filter(r => rawTeams[r.oppAbbr]?.conf === b.conf);
    const aCp = pctOf(aCR), bCp = pctOf(bCR);
    if (aCp !== null && bCp !== null && Math.abs(aCp - bCp) > 1e-6) {
      if (aCp > bCp) { const w = aCR.filter(r => r.win).length, l = aCR.filter(r => !r.win && !r.tie).length; return `Conference record (${w}-${l})`; }
      return null;
    }

    const cg = commonOf(a, b);
    if (cg) {
      const [aCG, bCG] = cg;
      const acp = pctOf(aCG), bcp = pctOf(bCG);
      if (acp !== null && bcp !== null && Math.abs(acp - bcp) > 1e-6) {
        if (acp > bcp) { const w = aCG.filter(r => r.win).length, l = aCG.filter(r => !r.win && !r.tie).length; return `Common games (${w}-${l})`; }
        return null;
      }
    }

    const asv = sovOf(a), bsv = sovOf(b);
    if (asv !== null && bsv !== null && Math.abs(asv - bsv) > 1e-6) return asv > bsv ? `Strength of victory (${asv.toFixed(3)})` : null;

    const ass = sosOf(a), bss = sosOf(b);
    if (ass !== null && bss !== null && Math.abs(ass - bss) > 1e-6) return ass > bss ? `Strength of schedule (${ass.toFixed(3)})` : null;

    const arc = combinedRank(a.abbr, confPool), brc = combinedRank(b.abbr, confPool);
    if (arc !== brc) return arc < brc ? `Conference points rank (#${arc})` : null;

    const ara = combinedRank(a.abbr, allPool), bra = combinedRank(b.abbr, allPool);
    if (ara !== bra) return ara < bra ? `League points rank (#${ara})` : null;

    const acn = netPts(aCR), bcn = netPts(bCR);
    if (acn !== bcn) return acn > bcn ? `Net points, conference games (${acn > 0 ? '+' : ''}${acn})` : null;

    const an = (a.pf || 0) - (a.pa || 0), bn = (b.pf || 0) - (b.pa || 0);
    if (an !== bn) return an > bn ? `Net points in all games (${an > 0 ? '+' : ''}${an})` : null;

    return undefined;
  };

  const result = {};
  const addResult = (winner, loser, reason) => {
    if (!result[winner.abbr]) result[winner.abbr] = { over: [], reason };
    if (!result[winner.abbr].over.includes(loser.abbr)) result[winner.abbr].over.push(loser.abbr);
  };

  const allPool = Object.values(rawTeams);
  for (const conf of ["AFC", "NFC"]) {
    const confPool = allPool.filter(t => t.conf === conf);
    const byRecord = {};
    for (const t of confPool) {
      const key = `${t.record[0]}-${t.record[1]}-${t.record[2] || 0}`;
      (byRecord[key] = byRecord[key] || []).push(t);
    }
    for (const group of Object.values(byRecord)) {
      if (group.length < 2) continue;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i], b = group[j];
          const fn = a.div === b.div ? divBreak : wcBreak;
          const reason = fn(a, b, confPool, allPool);
          if (reason != null && reason !== undefined) {
            addResult(a, b, reason);
          } else if (reason === null) {
            const rb = fn(b, a, confPool, allPool);
            if (rb != null && rb !== undefined) addResult(b, a, rb);
          }
        }
      }
    }
  }
  return result;
}

/* ─── Standings ──────────────────────────────────────────────────────────── */

export function computeStandings(teams, tiebreakerReasons) {
  const teamList = Object.values(teams || {});
  const tb = tiebreakerReasons || {};

  const sortByPct = (a, b) => {
    const pd = winPct(b) - winPct(a);
    if (Math.abs(pd) > 1e-6) return pd;
    if (b.record[0] !== a.record[0]) return b.record[0] - a.record[0];
    if (tb[a.abbr]?.over.includes(b.abbr)) return -1;
    if (tb[b.abbr]?.over.includes(a.abbr)) return 1;
    return 0;
  };

  const gb = (leader, team) =>
    ((leader.record[0] - team.record[0]) + (team.record[1] - leader.record[1])) / 2;

  const out = { AFC: [], NFC: [], byTeam: {}, divisions: {} };

  for (const conf of ["AFC", "NFC"]) {
    const divs = {};
    for (const t of teamList.filter(t => t.conf === conf)) (divs[t.div] = divs[t.div] || []).push(t);
    for (const d of Object.keys(divs)) divs[d].sort(sortByPct);
    out.divisions[conf] = divs;

    const order = ["East", "North", "South", "West"].filter(d => divs[d]);
    const winners = order.map(d => divs[d][0]).filter(Boolean).sort(sortByPct);
    winners.forEach((t, i) => {
      out[conf].push({ seed: i + 1, team: t.abbr, kind: "division" });
      out.byTeam[t.abbr] = { seed: i + 1, kind: "division", conf };
    });
    const winnersSet = new Set(winners.map(t => t.abbr));
    const rest = teamList.filter(t => t.conf === conf && !winnersSet.has(t.abbr)).sort(sortByPct);
    for (let i = 0; i < 3 && i < rest.length; i++) {
      out[conf].push({ seed: 5 + i, team: rest[i].abbr, kind: "wildcard" });
      out.byTeam[rest[i].abbr] = { seed: 5 + i, kind: "wildcard", conf };
    }
    const lastWC = rest[2];
    for (let i = 3; i < rest.length; i++) {
      const g = lastWC ? gb(lastWC, rest[i]) : null;
      out.byTeam[rest[i].abbr] = { seed: null, kind: "out", conf, gamesBehind: g > 0 ? g : null };
    }
  }

  for (const conf of ["AFC", "NFC"]) {
    for (const div of ["North", "South", "East", "West"]) {
      const divTeams = (out.divisions[conf] || {})[div];
      if (!divTeams || !divTeams.length) continue;
      const leader = divTeams[0];
      for (const t of divTeams) {
        const g = gb(leader, t);
        if (out.byTeam[t.abbr]) out.byTeam[t.abbr].gamesBehind = g > 0 ? g : null;
      }
    }
  }

  return out;
}

/* ─── Available modes ────────────────────────────────────────────────────── */

export function availableModes(favAbbr, teams, weekMeta) {
  const fav = teams[favAbbr];
  if (!fav) return ["overall", "tank"];
  const wr = weeksRemainingFrom(weekMeta);
  const mxW = (t) => t.record[0] + wr;
  const all = ["overall"];
  const divPeers = Object.values(teams).filter(t => t.conf === fav.conf && t.div === fav.div && t.abbr !== favAbbr);
  if (divPeers.every(p => p.record[0] <= mxW(fav))) all.push("division");
  const confNonDiv = Object.values(teams).filter(t => t.conf === fav.conf && t.div !== fav.div && t.abbr !== favAbbr);
  if (confNonDiv.filter(t => t.record[0] > mxW(fav)).length < 3) all.push("wildcard");
  const confPeers = Object.values(teams).filter(t => t.conf === fav.conf && t.abbr !== favAbbr);
  if (confPeers.every(p => p.record[0] <= mxW(fav))) all.push("conf_one_seed");
  all.push("tank");
  return all;
}

/* ─── Favorite team's own game ───────────────────────────────────────────── */

export function favTeamGame(favAbbr, mode = "overall", teams, schedule, weekMeta) {
  const ours = (schedule || []).filter(g => g.home === favAbbr || g.away === favAbbr);
  if (!ours.length) return null;
  const upcoming = ours.find(g => !g.completed);
  const g = upcoming || ours[ours.length - 1];
  const fav = teams[favAbbr];
  const oppAbbr = g.home === favAbbr ? g.away : g.home;
  const opp = teams[oppAbbr];
  const isHome = g.home === favAbbr;

  if (g.completed && !upcoming) {
    const favScore = isHome ? g.homeScore : g.awayScore;
    const oppScore = isHome ? g.awayScore : g.homeScore;
    const won = favScore != null && oppScore != null && favScore > oppScore;
    const tied = favScore != null && favScore === oppScore;
    const verb = tied ? "tied" : won ? "beat" : "lost to";
    const blurb = tied
      ? `${favAbbr} and ${oppAbbr} tied ${favScore}-${oppScore}.`
      : won
        ? `${favAbbr} ${verb} ${oppAbbr} ${favScore}-${oppScore}.`
        : `${favAbbr} ${verb} ${oppAbbr} ${oppScore}-${favScore}.`;
    return { ...g, fav: favAbbr, opp: oppAbbr, isHome, blurb, underdog: null, completed: true, favScore, oppScore, won, tied };
  }

  const fGB = gamesBack(fav, teams);
  const wr = weeksRemainingFrom(weekMeta);
  const isDivRival = opp.div === fav.div && opp.conf === fav.conf;

  let blurb = "";
  if (mode === "tank") {
    blurb = `TANK mode: root for ${oppAbbr} (${opp.record[0]}W) to WIN — a ${favAbbr} loss improves your draft slot.`;
  } else if (mode === "division" || inDivisionContention(fav, teams, weekMeta)) {
    if (fGB === 0) {
      blurb = isDivRival
        ? `Win to extend your division lead over ${oppAbbr} (${gamesBack(opp, teams).toFixed(1)} GB behind, ${wr} weeks left).`
        : `Win to stay atop the ${fav.div} (${wr} weeks left).`;
    } else {
      blurb = isDivRival
        ? `Win to cut the gap — ${favAbbr} is ${fGB.toFixed(1)} GB back with ${wr} weeks left.`
        : `Win to stay in the ${fav.div} race (${fGB.toFixed(1)} GB back, ${wr} weeks left).`;
    }
  } else if (mode === "conf_one_seed") {
    const leader = Object.values(teams).filter(t => t.conf === fav.conf)
      .reduce((a, b) => b.record[0] > a.record[0] ? b : a, fav);
    blurb = `Win to chase the ${fav.conf} #1 seed (${leader.record[0] - fav.record[0]}W behind ${leader.abbr}, ${wr} weeks left).`;
  } else {
    blurb = `Win to strengthen your ${fav.conf} wildcard position.`;
  }

  let underdog = null;
  if (g.spread != null) underdog = g.spread < 0 ? g.away : (g.spread > 0 ? g.home : null);
  else if (g.homeFavorite != null) underdog = g.homeFavorite ? g.away : g.home;

  return { ...g, fav: favAbbr, opp: oppAbbr, isHome, blurb, underdog, completed: false };
}

/* ─── Own-game impact score ──────────────────────────────────────────────── */

export function ownGameImpact(favAbbr, mode, teams, weekMeta) {
  const fav = teams?.[favAbbr];
  if (!fav) return 1.0;
  const gamesPlayed = fav.record[0] + fav.record[1] + (fav.record[2] || 0);
  const rem = Math.max(0, 17 - gamesPlayed);
  if (rem === 0) return 0;
  if (mode === "tank") return 1.0;
  const confTeams = Object.values(teams).filter(t => t.conf === fav.conf && t.abbr !== favAbbr);
  const maxFavWins = fav.record[0] + rem;
  const eliminated = confTeams.filter(t => t.record[0] > maxFavWins).length >= 7;
  if (eliminated) return 0;
  if (mode === "conf_one_seed") {
    const tiebreakerReasons = computeTiebreakerReasons(teams);
    const standings = computeStandings(teams, tiebreakerReasons);
    const seed = standings.byTeam[favAbbr] || {};
    if (seed.seed === 1) {
      const closest = confTeams.slice().sort((a, b) => b.record[0] - a.record[0])[0];
      if (!closest || closest.record[0] + (Math.max(0, 17 - (closest.record[0] + closest.record[1] + (closest.record[2] || 0)))) < fav.record[0]) return 0;
    }
  }
  return 1.0;
}

/* ─── Recommendation internals ───────────────────────────────────────────── */

export function modeScore(candidate, opponent, fav, mode, dislikes, teams, weekMeta) {
  const o = teams[opponent];
  if (!o) return 0;
  const isSameDiv = o.div === fav.div && o.conf === fav.conf;
  const isSameConf = o.conf === fav.conf;
  const wr = weeksRemainingFrom(weekMeta);
  const favGB = gamesBack(fav, teams);
  let score = 0;

  if (mode === "division") {
    if (isSameDiv) {
      if (inDivisionContention(fav, teams, weekMeta) && inDivisionContention(o, teams, weekMeta)) {
        const urgency = Math.max(0, 1 - favGB / Math.max(wr, 1));
        score += 0.25 + 0.25 * urgency;
      } else score += 0.25;
    }
  } else if (mode === "wildcard") {
    if (isSameConf) score += 0.20;
  } else if (mode === "conf_one_seed") {
    if (isSameConf) score += 0.20 + 0.10 * Math.min(o.record[0] / 17, 1);
  } else {
    if (isSameDiv && inDivisionContention(fav, teams, weekMeta) && inDivisionContention(o, teams, weekMeta)) {
      const urgency = Math.max(0, 1 - favGB / Math.max(wr, 1));
      score += 0.20 + 0.20 * urgency;
    } else if (isSameDiv) score += 0.20;
    else if (isSameConf) score += 0.20;
  }
  if (dislikes.includes(opponent)) score += 0.15;
  const favPct = winPct(fav), oppPct = winPct(o);
  score += Math.max(0, 0.10 - Math.abs(favPct - oppPct) * 0.2);
  return score;
}

export function scenarioRows(home, away, fav, dislikes, mode, futureFavOpponents, teams, weekMeta) {
  const out = [];
  const homeT = teams[home], awayT = teams[away];

  for (const team of [home, away]) {
    const t = teams[team];
    if (t.div === fav.div && t.conf === fav.conf && team !== fav.abbr) {
      const opp = team === home ? away : home;
      out.push({
        root_for: opp, against: team,
        category: "DivisionRivalTank", strength: "high", strength_weight: STRENGTH_WEIGHT.high,
        why: `${team} is a division rival — root for their opponent to hurt their standings`,
      });
    }
  }

  for (const team of [home, away]) {
    if (!futureFavOpponents.has(team)) continue;
    const opp = team === home ? away : home;
    const t = teams[team];
    const w = t.record[0], l = t.record[1];
    if (w > l) {
      out.push({ root_for: opp, against: team, category: "OpponentTanking", strength: "medium", strength_weight: STRENGTH_WEIGHT.medium, why: `${team} (${w}-${l}) is an upcoming opponent on a winning record — cool their momentum` });
    } else if (l > w) {
      out.push({ root_for: opp, against: team, category: "OpponentTanking", strength: "medium", strength_weight: STRENGTH_WEIGHT.medium, why: `${team} (${w}-${l}) is an upcoming opponent on a skid — keep their locker room fractured` });
    }
  }

  if (mode !== "division") {
    for (const team of [home, away]) {
      const t = teams[team];
      if (team === fav.abbr || t.conf !== fav.conf) continue;
      if (t.record[0] > t.record[1]) {
        const opp = team === home ? away : home;
        out.push({ root_for: opp, against: team, category: "PlayoffSoftening", strength: "high", strength_weight: STRENGTH_WEIGHT.high, why: `${team} (${t.record[0]}-${t.record[1]}) is a ${fav.conf} playoff contender — a loss directly tightens the race` });
      }
    }
  }

  if (mode !== "division") {
    if (homeT.conf === fav.conf && home !== fav.abbr) {
      const gap = homeT.record[0] - awayT.record[0];
      if (gap >= 4) {
        out.push({ root_for: away, against: home, category: "UpsetRooting", strength: "medium", strength_weight: STRENGTH_WEIGHT.medium, why: `${home} (${homeT.record[0]}W) is a heavy home favorite vs ${away} (${awayT.record[0]}W, ${gap}-win gap) — trap-game upset` });
      }
    }
  }

  if (mode === "overall" || mode === "wildcard") {
    for (const team of [home, away]) {
      if (team === fav.abbr) continue;
      const t = teams[team];
      const isDivRival = t.div === fav.div && t.conf === fav.conf;
      const isConfThreat = t.conf === fav.conf;
      if (!(isDivRival || isConfThreat)) continue;
      const w = t.record[0];
      if (w >= 6 && w <= 9) {
        const opp = team === home ? away : home;
        const label = isDivRival ? "division rival" : "conference threat";
        out.push({ root_for: opp, against: team, category: "DraftPositioning", strength: "low", strength_weight: STRENGTH_WEIGHT.low, why: `${team} (${w}W) is a ${label} stuck in no man's land — keep them losing` });
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

export function scoreGameTank(home, away, fav, teams, weekMeta) {
  if (home === fav.abbr || away === fav.abbr) return null;
  const favWins = fav.record[0];
  const hW = teams[home].record[0], aW = teams[away].record[0];
  const [rootAbbr, againstAbbr, rootWins] = hW <= aW ? [home, away, hW] : [away, home, aW];
  const minGap = Math.min(Math.abs(hW - favWins), Math.abs(aW - favWins));
  let base = minGap === 0 ? 0.5 : minGap === 1 ? 0.35 : minGap === 2 ? 0.20 : minGap === 3 ? 0.10 : 0.05;
  const isDivRival = teams[rootAbbr].div === fav.div && teams[rootAbbr].conf === fav.conf;
  if (isDivRival) base = Math.min(base + 0.15, 1.0);
  let why;
  if (rootWins < favWins) why = `${rootAbbr} (${rootWins}W) is below you — their win brings them up and protects your draft slot`;
  else if (rootWins === favWins) why = `${rootAbbr} (${rootWins}W) is tied with you — their win separates them from your draft range`;
  else why = `neither team threatens your draft slot; root for the worse-record team to clear the field`;
  const strength = base >= 0.35 ? "high" : (base >= 0.20 ? "medium" : "low");
  return { rootFor: rootAbbr, against: againstAbbr, score: base, strength, strength_weight: STRENGTH_WEIGHT[strength], category: "TankPositioning", reasonsAll: [why] };
}

export function buildReasoning(rootAbbr, againstAbbr, fav, mode, score, teams, weekMeta) {
  const parts = [];
  const opp = teams[againstAbbr];
  const targetByMode = { division: "division title odds", conf_one_seed: "#1 seed odds", wildcard: "wild card odds", overall: "wild card odds", tank: "draft slot" };
  const target = targetByMode[mode];
  if (opp.div === fav.div && opp.conf === fav.conf) {
    const fGB = gamesBack(fav, teams), oGB = gamesBack(opp, teams), wr = weeksRemainingFrom(weekMeta);
    if (inDivisionContention(fav, teams, weekMeta) && inDivisionContention(opp, teams, weekMeta)) {
      let gbStr;
      if (fGB === 0 && oGB > 0) gbStr = `${againstAbbr} is ${oGB.toFixed(1)} GB behind you`;
      else if (oGB === 0 && fGB > 0) gbStr = `you are ${fGB.toFixed(1)} GB behind ${againstAbbr}`;
      else if (fGB < oGB) gbStr = `${againstAbbr} is ${(oGB - fGB).toFixed(1)} GB behind you`;
      else if (oGB < fGB) gbStr = `you are ${(fGB - oGB).toFixed(1)} GB behind ${againstAbbr}`;
      else gbStr = "tied in the division";
      parts.push(`${againstAbbr} is a division rival in a title race (${gbStr}, ${wr} weeks left) — their loss directly helps`);
    } else {
      parts.push(`${againstAbbr} is a division rival — their loss improves ${target}`);
    }
  } else if (opp.conf === fav.conf) {
    if (mode === "conf_one_seed") {
      parts.push(`${againstAbbr} (${opp.record[0]}W) is a ${fav.conf} rival — their loss improves ${target}`);
    } else {
      parts.push(`${againstAbbr} is a conference competitor — their loss improves ${target}`);
    }
  }
  return parts.length ? parts : ["no direct playoff impact"];
}

/* ─── Main computations ──────────────────────────────────────────────────── */

export function computeRecommendations(favAbbr, dislikes, mode = "overall", teams, schedule, strengths, weekMeta) {
  const fav = teams?.[favAbbr];
  if (!fav) return [];
  dislikes = (dislikes || []).map(d => d.toUpperCase());
  const futureFavOpponents = new Set(
    (schedule || []).filter(g => g.home === favAbbr || g.away === favAbbr).map(g => g.home === favAbbr ? g.away : g.home)
  );

  const recs = [];
  for (const g of (schedule || [])) {
    if (g.home === favAbbr || g.away === favAbbr) continue;
    if (g.completed) continue;

    if (mode === "tank") {
      const r = scoreGameTank(g.home, g.away, fav, teams, weekMeta);
      if (r) recs.push({ gameId: g.id, ...r, kickoff: g.kickoff, network: g.network, slot: g.slot, spread: g.spread, underdog: resolveUnderdog(g), reasoning: r.reasonsAll[0] });
      continue;
    }

    let playoffRoot = null, playoffAgainst = null, playoffScore = 0;
    const homeT = teams[g.home], awayT = teams[g.away];
    if (homeT.conf === fav.conf || awayT.conf === fav.conf) {
      const h = modeScore(g.home, g.away, fav, mode, dislikes, teams, weekMeta);
      const a = modeScore(g.away, g.home, fav, mode, dislikes, teams, weekMeta);
      const underdog = resolveUnderdog(g);
      const _ud = 0.02;
      const adjH = h + (g.home === underdog ? _ud : 0);
      const adjA = a + (g.away === underdog ? _ud : 0);
      if (adjH >= adjA) { playoffRoot = g.home; playoffAgainst = g.away; playoffScore = h; }
      else              { playoffRoot = g.away; playoffAgainst = g.home; playoffScore = a; }
    } else {
      playoffRoot = g.home; playoffAgainst = g.away; playoffScore = 0;
    }

    const scenarios = scenarioRows(g.home, g.away, fav, dislikes, mode, futureFavOpponents, teams, weekMeta);
    const homeWeight = scenarios.filter(s => s.root_for === g.home).reduce((a, b) => a + b.strength_weight, 0);
    const awayWeight = scenarios.filter(s => s.root_for === g.away).reduce((a, b) => a + b.strength_weight, 0);

    let rootAbbr, againstAbbr, category, strength, strengthWeight, score, reasonsAll;
    if (homeWeight > 0 || awayWeight > 0) {
      const winnerSide = homeWeight >= awayWeight ? g.home : g.away;
      rootAbbr = winnerSide;
      againstAbbr = winnerSide === g.home ? g.away : g.home;
      const matching = scenarios.filter(s => s.root_for === rootAbbr).sort((a, b) => b.strength_weight - a.strength_weight);
      const primary = matching[0];
      category = primary.category;
      strength = primary.strength;
      strengthWeight = primary.strength_weight;
      score = rootAbbr === playoffRoot ? playoffScore : 0;
      reasonsAll = [primary.why];
      if (matching.length > 1 && matching[1].strength_weight >= 0.20 && matching[1].category !== primary.category) {
        reasonsAll.push(matching[1].why);
      }
      if (playoffScore > 0 && rootAbbr === playoffRoot && primary.strength_weight < 0.35) {
        reasonsAll.push(...buildReasoning(rootAbbr, againstAbbr, fav, mode, playoffScore, teams, weekMeta));
      }
    } else {
      rootAbbr = playoffRoot; againstAbbr = playoffAgainst;
      score = playoffScore;
      strengthWeight = 0;
      if (score > 0) { category = "direct_playoff_impact"; strength = "low"; }
      else            { category = "no_impact"; strength = ""; }
      reasonsAll = buildReasoning(rootAbbr, againstAbbr, fav, mode, score, teams, weekMeta);
    }

    if (score > 0) {
      const homeStr = (strengths[g.home]?.strengthScore || 0.5);
      const awayStr = (strengths[g.away]?.strengthScore || 0.5);
      score = Math.min(score + 0.05 * (homeStr + awayStr) / 2, 1.0);
    }

    recs.push({
      gameId: g.id, rootFor: rootAbbr, against: againstAbbr,
      score, category, strength, strength_weight: strengthWeight,
      reasoning: reasonsAll[0], reasonsAll,
      kickoff: g.kickoff, network: g.network, slot: g.slot,
      spread: g.spread, underdog: resolveUnderdog(g),
    });
  }

  recs.sort((a, b) => (b.score - a.score) || (b.strength_weight - a.strength_weight));
  return recs;
}

export function computeScenarios(favAbbr, teams, schedule, weekMeta) {
  const fav = teams?.[favAbbr];
  if (!fav) return [];

  const tiebreakerReasons = computeTiebreakerReasons(teams);
  const standings = computeStandings(teams, tiebreakerReasons);
  const seed = standings.byTeam[favAbbr] || {};
  const favWins = fav.record[0];
  const favLosses = fav.record[1];

  const gamesPlayed = (t) => t.record[0] + t.record[1] + (t.record[2] || 0);
  const teamRem = (t) => Math.max(0, 17 - gamesPlayed(t));
  const favRem = teamRem(fav);
  const maxFavWins = favWins + favRem;

  const divRivals = Object.values(teams).filter(t => t.conf === fav.conf && t.div === fav.div && t.abbr !== favAbbr);
  const confTeams = Object.values(teams).filter(t => t.conf === fav.conf).sort((a, b) => winPct(b) - winPct(a) || b.record[0] - a.record[0]);

  const scenarios = [];

  function magicSplit(myWins, myRem, theirWins, theirRem) {
    const theirMax = theirWins + theirRem;
    if (theirMax < myWins) return null;
    const magic = theirMax - myWins + 1;
    const total = myRem + theirRem;
    if (total === 0 || magic > total) return null;
    let tWins = Math.max(0, Math.min(Math.round(magic * myRem / total), myRem));
    let rLosses = magic - tWins;
    if (rLosses > theirRem) { rLosses = theirRem; tWins = Math.min(Math.max(0, magic - rLosses), myRem); }
    return { winsNeeded: tWins, rivalLosses: rLosses };
  }

  function h2hList(vsAbbrs) {
    const s = new Set(vsAbbrs);
    return (schedule || [])
      .filter(g => !g.completed && (g.home === favAbbr || g.away === favAbbr))
      .map(g => g.home === favAbbr ? g.away : g.home)
      .filter(a => s.has(a));
  }

  function makeWinReq(winsNeeded, vsAbbrs = []) {
    const h2h = h2hList(vsAbbrs);
    const rationale = winsNeeded <= h2h.length && h2h.length > 0
      ? `Win ${winsNeeded} game${winsNeeded !== 1 ? 's' : ''} (vs ${h2h.slice(0, winsNeeded).join(" or ")})`
      : `Win ${winsNeeded} of ${favRem} remaining games`;
    return { type: "win", team: favAbbr, rationale, week: "Any week" };
  }

  function makeLossReq(rival, losses, rem) {
    return { type: "loss", team: rival.abbr, rationale: `${losses} more loss${losses !== 1 ? "es" : ""} (${rem} remaining)`, week: "Any week" };
  }

  // Division scenarios
  if (divRivals.length) {
    const divClinched = divRivals.every(r => favWins > r.record[0] + teamRem(r));
    const divEliminated = divRivals.some(r => r.record[0] > maxFavWins);

    if (divClinched) {
      scenarios.push({ id: "div-clinched", kind: "clinched", title: `${fav.conf} ${fav.div} title — Clinched`, summary: `${favAbbr} has already secured the ${fav.div} division title.`, requires: [], likelihood: 1.0, urgency: "low", isClinched: true });
    } else if (divEliminated) {
      const leader = divRivals.find(r => r.record[0] > maxFavWins);
      scenarios.push({ id: "div-eliminated", kind: "eliminated", title: `Eliminated from the ${fav.conf} ${fav.div} title`, summary: `${leader?.abbr} already has more wins than ${favAbbr}'s maximum possible total.`, requires: [], likelihood: 0, urgency: "low", isClinched: true });
    } else if (favRem > 0) {
      const woRivalReqs = [];
      for (const rival of divRivals) {
        const rMax = rival.record[0] + teamRem(rival);
        if (rMax >= maxFavWins) {
          const needed = rMax - maxFavWins + 1;
          woRivalReqs.push({ rival, losses: needed, rem: teamRem(rival) });
        }
      }
      const req1 = [makeWinReq(favRem, divRivals.map(r => r.abbr))];
      for (const { rival, losses, rem } of woRivalReqs) req1.push(makeLossReq(rival, losses, rem));
      scenarios.push({ id: "div-clinch-1", kind: "clinch", title: woRivalReqs.length === 0 ? `Clinch the ${fav.conf} ${fav.div} — Win out (no help needed)` : `Clinch the ${fav.conf} ${fav.div} — Win every game`, summary: woRivalReqs.length === 0 ? `${favAbbr} wins all ${favRem} remaining games and secures the division title outright.` : `${favAbbr} wins all ${favRem} remaining — still needs ${woRivalReqs.map(r => `${r.rival.abbr} to drop ${r.losses}`).join(" and ")}.`, requires: req1, likelihood: Math.max(0.05, Math.min(0.90, 0.75 - woRivalReqs.length * 0.05)), urgency: favRem <= 2 ? "high" : "med" });

      let propMaxWins = 0;
      const propRivalReqs = [];
      for (const rival of divRivals) {
        const rRem = teamRem(rival);
        const mn = magicSplit(favWins, favRem, rival.record[0], rRem);
        if (!mn) continue;
        if (mn.winsNeeded > propMaxWins) propMaxWins = mn.winsNeeded;
        if (mn.rivalLosses > 0) propRivalReqs.push({ rival, losses: mn.rivalLosses, rem: rRem });
      }
      if ((propMaxWins > 0 || propRivalReqs.length) && propMaxWins < favRem) {
        const req2 = [];
        if (propMaxWins > 0) req2.push(makeWinReq(propMaxWins, divRivals.map(r => r.abbr)));
        for (const { rival, losses, rem } of propRivalReqs) req2.push(makeLossReq(rival, losses, rem));
        const gap = Math.max(0, ...divRivals.map(r => r.record[0] - favWins));
        const lhood2 = Math.max(0.05, Math.min(0.88, 0.65 - gap * 0.10 - propMaxWins * 0.03));
        const sp = [];
        if (propMaxWins > 0) sp.push(`${favAbbr} wins ${propMaxWins} more`);
        if (propRivalReqs.length) sp.push(propRivalReqs.map(({ rival, losses }) => `${rival.abbr} loses ${losses} more`).join("; "));
        scenarios.push({ id: "div-clinch-2", kind: "clinch", title: `Clinch the ${fav.conf} ${fav.div} — Get some help`, summary: sp.join(" — ") + ".", requires: req2, likelihood: lhood2, urgency: propMaxWins <= 2 ? "high" : propMaxWins <= 4 ? "med" : "low" });
      }
    }
  }

  // Wildcard scenarios
  {
    const isDivLeader = divRivals.length > 0 && divRivals.every(r => r.record[0] < favWins);
    if (!isDivLeader) {
      const teamsCanExceedCurrent = confTeams.filter(t => t.abbr !== favAbbr && t.record[0] + teamRem(t) > favWins).length;
      const wcClinched = teamsCanExceedCurrent < 7;
      const wcEliminated = confTeams.filter(t => t.abbr !== favAbbr && t.record[0] > maxFavWins).length >= 7;

      if (wcClinched) {
        scenarios.push({ id: "wc-clinched", kind: "clinched", title: `${fav.conf} playoff berth — Clinched`, summary: `${favAbbr} has mathematically secured a playoff spot.`, requires: [], likelihood: 1.0, urgency: "low", isClinched: true });
      } else if (wcEliminated) {
        scenarios.push({ id: "wc-eliminated", kind: "eliminated", title: `Eliminated from ${fav.conf} playoff contention`, summary: `${favAbbr} is mathematically eliminated from the playoffs.`, requires: [], likelihood: 0, urgency: "low", isClinched: true });
      } else {
        const teamsCanExceedMax = confTeams.filter(t => t.abbr !== favAbbr && t.record[0] + teamRem(t) > maxFavWins).length;
        if (teamsCanExceedMax < 7 && favRem > 0) {
          scenarios.push({ id: "wc-clinch-1", kind: "clinch", title: `Lock down a ${fav.conf} wildcard — Control your destiny`, summary: `${favAbbr} wins all ${favRem} remaining games and clinches without needing any help.`, requires: [makeWinReq(favRem)], likelihood: Math.max(0.10, 0.65 - favRem * 0.06), urgency: favRem <= 2 ? "high" : "med" });
        }
        const dangerTeams = confTeams.filter(t => t.abbr !== favAbbr && t.record[0] < favWins && t.record[0] + teamRem(t) >= favWins).slice(0, 3);
        if (dangerTeams.length > 0) {
          let wcMaxWins = 0;
          const wcRivalReqs = [];
          for (const danger of dangerTeams) {
            const dRem = teamRem(danger);
            const mn = magicSplit(favWins, favRem, danger.record[0], dRem);
            if (!mn) continue;
            if (mn.winsNeeded > wcMaxWins) wcMaxWins = mn.winsNeeded;
            if (mn.rivalLosses > 0) wcRivalReqs.push({ rival: danger, losses: mn.rivalLosses, rem: dRem });
          }
          if (wcMaxWins < favRem && (wcMaxWins > 0 || wcRivalReqs.length)) {
            const req2 = [];
            if (wcMaxWins > 0) req2.push(makeWinReq(wcMaxWins, dangerTeams.map(t => t.abbr)));
            for (const { rival, losses, rem } of wcRivalReqs) req2.push(makeLossReq(rival, losses, rem));
            const sp2 = [];
            if (wcMaxWins > 0) sp2.push(`${favAbbr} wins ${wcMaxWins} more`);
            if (wcRivalReqs.length) sp2.push(wcRivalReqs.map(({ rival, losses }) => `${rival.abbr} loses ${losses} more`).join("; "));
            scenarios.push({ id: "wc-clinch-2", kind: "clinch", title: `Lock down a ${fav.conf} wildcard — Hold off the pack`, summary: sp2.join(" — ") + ".", requires: req2, likelihood: Math.max(0.05, Math.min(0.80, 0.55 - wcMaxWins * 0.04)), urgency: seed.kind === "out" ? "high" : "med" });
          }
        }
      }
    }
  }

  // Elimination watch
  {
    const definitivelyOut = confTeams.filter(t => t.abbr !== favAbbr && t.record[0] > maxFavWins).length >= 7;
    if (!definitivelyOut && favLosses >= 6) {
      const threats = confTeams.filter(t => t.abbr !== favAbbr && t.record[0] < favWins && t.record[0] + teamRem(t) >= favWins).slice(0, 3);
      const definitivelyAhead = confTeams.filter(t => t.abbr !== favAbbr && t.record[0] >= favWins).length;
      if (threats.length >= 2 && definitivelyAhead >= 4) {
        const elimLossesNeeded = Math.max(1, favWins - threats[0].record[0] + 1);
        const threatWinsNeeded = (t) => Math.max(1, favWins - t.record[0] + 1);
        scenarios.push({ id: "elim-watch", kind: "elimination", title: `Elimination watch — ${fav.conf} wild card`, summary: `${favAbbr} loses ${elimLossesNeeded} more while ${threats.map(t => `${t.abbr} wins ${threatWinsNeeded(t)}`).join(" and ")} — playoff spot gone.`, requires: [{ type: "loss", team: favAbbr, rationale: `Lose ${elimLossesNeeded} more game${elimLossesNeeded !== 1 ? "s" : ""} (${favRem} remaining)`, week: "Any week" }, { type: "win", team: threats[0].abbr, rationale: `Win ${threatWinsNeeded(threats[0])} more to match ${favAbbr}'s wins (${teamRem(threats[0])} remaining)`, week: "Any week" }, ...(threats[1] ? [{ type: "win", team: threats[1].abbr, rationale: `Win ${threatWinsNeeded(threats[1])} more to match ${favAbbr}'s wins (${teamRem(threats[1])} remaining)`, week: "Any week" }] : [])], likelihood: 0.18, urgency: "low" });
      }
    }
  }

  // Division elimination watch
  if (divRivals.length > 0) {
    const divEliminated = divRivals.some(r => r.record[0] > maxFavWins);
    const divClinched = divRivals.every(r => favWins > r.record[0] + teamRem(r));
    if (!divEliminated && !divClinched && favRem > 0) {
      const elimThreat = divRivals.filter(r => r.record[0] + teamRem(r) >= maxFavWins).sort((a, b) => b.record[0] - a.record[0])[0];
      if (elimThreat) {
        const threatRem = teamRem(elimThreat);
        const winsToElim = maxFavWins + 1 - elimThreat.record[0];
        const favLossesToElim = Math.max(1, elimThreat.record[0] - favWins + 1);
        scenarios.push({ id: "div-elim-watch", kind: "elimination", title: `Elimination watch — ${fav.conf} ${fav.div} title`, summary: `${favAbbr} loses ${favLossesToElim} more while ${elimThreat.abbr} wins ${winsToElim} more — division title gone.`, requires: [{ type: "loss", team: favAbbr, rationale: `Lose ${favLossesToElim} more game${favLossesToElim !== 1 ? "s" : ""} (${favRem} remaining)`, week: "Any week" }, { type: "win", team: elimThreat.abbr, rationale: `Win ${winsToElim} more to exceed ${favAbbr}'s max wins (${threatRem} remaining)`, week: "Any week" }], likelihood: 0.20, urgency: "med" });
      }
    }
  }

  // #1 seed / bye chase
  if ([1, 2, 3].includes(seed.seed)) {
    const confLeader = confTeams[0];
    if (confLeader.abbr !== favAbbr) {
      const lRem = teamRem(confLeader);
      const mn = magicSplit(favWins, favRem, confLeader.record[0], lRem);
      if (mn) {
        const requires = [];
        if (mn.winsNeeded > 0) requires.push({ type: "win", team: favAbbr, rationale: `Win ${mn.winsNeeded} of ${favRem} remaining games`, week: "Any week" });
        if (mn.rivalLosses > 0) requires.push({ type: "loss", team: confLeader.abbr, rationale: `${mn.rivalLosses} more loss${mn.rivalLosses !== 1 ? "es" : ""} (${lRem} remaining)`, week: "Any week" });
        scenarios.push({ id: "bye-chase", kind: "clinch", title: `Climb to the #1 seed (bye week + home field)`, summary: `${favAbbr} needs ${mn.winsNeeded} more win${mn.winsNeeded !== 1 ? 's' : ''} and ${confLeader.abbr} to stumble.`, requires, likelihood: 0.22, urgency: "med" });
      }
    }
  }

  return scenarios;
}
