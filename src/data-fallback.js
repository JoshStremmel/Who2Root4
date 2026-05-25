/*
 * Who2Root4 — data layer (mirrors the holonic pipeline at github.com/JoshStremmel/Who2Root4)
 *
 * What lives here:
 *   - TEAMS:                made-up palette + records
 *   - SCHEDULE:             this week's matchups, with odds (spread + moneyline)
 *   - TIEBREAKER_REASONS:   pre-computed tiebreaker prose for ties in the standings
 *   - computeTeamStrengths: multi-signal strength score per builders/team_strength.py
 *   - computeStandings:     divisional tables + 7-seed playoff bracket per conference
 *   - computeRecommendations(team, dislikes, mode): mirrors RecommendationEngine.generate_recommendations()
 *
 * Everything is placeholder data for the prototype — wired so swapping in real JSON from the
 * pipeline.py output is a drop-in.
 */

window.TEAMS = {
  // AFC NORTH
  PIT: { city: "Pittsburgh", name: "Steelers",   abbr: "PIT", conf: "AFC", div: "North", record: [9, 4],  color: "oklch(0.62 0.13 80)" },
  BAL: { city: "Baltimore",  name: "Ravens",     abbr: "BAL", conf: "AFC", div: "North", record: [8, 5],  color: "oklch(0.45 0.14 295)" },
  CIN: { city: "Cincinnati", name: "Bengals",    abbr: "CIN", conf: "AFC", div: "North", record: [6, 7],  color: "oklch(0.62 0.18 50)" },
  CLE: { city: "Cleveland",  name: "Browns",     abbr: "CLE", conf: "AFC", div: "North", record: [4, 9],  color: "oklch(0.42 0.08 60)" },
  // AFC EAST
  BUF: { city: "Buffalo",    name: "Bills",      abbr: "BUF", conf: "AFC", div: "East",  record: [10, 3], color: "oklch(0.48 0.16 260)" },
  MIA: { city: "Miami",      name: "Dolphins",   abbr: "MIA", conf: "AFC", div: "East",  record: [7, 6],  color: "oklch(0.66 0.10 200)" },
  NYJ: { city: "New York",   name: "Jets",       abbr: "NYJ", conf: "AFC", div: "East",  record: [5, 8],  color: "oklch(0.45 0.10 165)" },
  NE:  { city: "New England",name: "Patriots",   abbr: "NE",  conf: "AFC", div: "East",  record: [4, 9],  color: "oklch(0.40 0.10 260)" },
  // AFC SOUTH
  HOU: { city: "Houston",    name: "Texans",     abbr: "HOU", conf: "AFC", div: "South", record: [8, 5],  color: "oklch(0.38 0.06 30)" },
  IND: { city: "Indianapolis",name:"Colts",      abbr: "IND", conf: "AFC", div: "South", record: [7, 6],  color: "oklch(0.55 0.13 245)" },
  JAX: { city: "Jacksonville",name:"Jaguars",    abbr: "JAX", conf: "AFC", div: "South", record: [5, 8],  color: "oklch(0.55 0.10 200)" },
  TEN: { city: "Tennessee",  name: "Titans",     abbr: "TEN", conf: "AFC", div: "South", record: [3, 10], color: "oklch(0.60 0.12 230)" },
  // AFC WEST
  KC:  { city: "Kansas City",name: "Chiefs",     abbr: "KC",  conf: "AFC", div: "West",  record: [11, 2], color: "oklch(0.55 0.18 25)" },
  LAC: { city: "Los Angeles",name: "Chargers",   abbr: "LAC", conf: "AFC", div: "West",  record: [9, 4],  color: "oklch(0.65 0.13 210)" },
  DEN: { city: "Denver",     name: "Broncos",    abbr: "DEN", conf: "AFC", div: "West",  record: [8, 5],  color: "oklch(0.55 0.13 50)" },
  LV:  { city: "Las Vegas",  name: "Raiders",    abbr: "LV",  conf: "AFC", div: "West",  record: [4, 9],  color: "oklch(0.40 0.02 250)" },
  // NFC NORTH
  DET: { city: "Detroit",    name: "Lions",      abbr: "DET", conf: "NFC", div: "North", record: [11, 2], color: "oklch(0.62 0.12 230)" },
  GB:  { city: "Green Bay",  name: "Packers",    abbr: "GB",  conf: "NFC", div: "North", record: [9, 4],  color: "oklch(0.48 0.13 145)" },
  MIN: { city: "Minnesota",  name: "Vikings",    abbr: "MIN", conf: "NFC", div: "North", record: [8, 5],  color: "oklch(0.45 0.14 305)" },
  CHI: { city: "Chicago",    name: "Bears",      abbr: "CHI", conf: "NFC", div: "North", record: [6, 7],  color: "oklch(0.45 0.12 40)" },
  // NFC EAST
  PHI: { city: "Philadelphia",name:"Eagles",     abbr: "PHI", conf: "NFC", div: "East",  record: [10, 3], color: "oklch(0.50 0.10 175)" },
  DAL: { city: "Dallas",     name: "Cowboys",    abbr: "DAL", conf: "NFC", div: "East",  record: [7, 6],  color: "oklch(0.50 0.13 250)" },
  WAS: { city: "Washington", name: "Commanders", abbr: "WAS", conf: "NFC", div: "East",  record: [6, 7],  color: "oklch(0.45 0.13 30)" },
  NYG: { city: "New York",   name: "Giants",     abbr: "NYG", conf: "NFC", div: "East",  record: [4, 9],  color: "oklch(0.50 0.14 255)" },
  // NFC SOUTH
  TB:  { city: "Tampa Bay",  name: "Buccaneers", abbr: "TB",  conf: "NFC", div: "South", record: [8, 5],  color: "oklch(0.55 0.17 30)" },
  ATL: { city: "Atlanta",    name: "Falcons",    abbr: "ATL", conf: "NFC", div: "South", record: [7, 6],  color: "oklch(0.55 0.18 25)" },
  NO:  { city: "New Orleans",name: "Saints",     abbr: "NO",  conf: "NFC", div: "South", record: [5, 8],  color: "oklch(0.65 0.08 90)" },
  CAR: { city: "Carolina",   name: "Panthers",   abbr: "CAR", conf: "NFC", div: "South", record: [3, 10], color: "oklch(0.62 0.12 215)" },
  // NFC WEST
  SF:  { city: "San Francisco",name:"49ers",     abbr: "SF",  conf: "NFC", div: "West",  record: [9, 4],  color: "oklch(0.50 0.13 25)" },
  LAR: { city: "Los Angeles",name: "Rams",       abbr: "LAR", conf: "NFC", div: "West",  record: [8, 5],  color: "oklch(0.52 0.13 255)" },
  SEA: { city: "Seattle",    name: "Seahawks",   abbr: "SEA", conf: "NFC", div: "West",  record: [7, 6],  color: "oklch(0.48 0.13 215)" },
  ARI: { city: "Arizona",    name: "Cardinals",  abbr: "ARI", conf: "NFC", div: "West",  record: [5, 8],  color: "oklch(0.50 0.14 20)" },
};

// Week 14, 2025 — placeholder matchups with odds.
// spread = home spread (negative = home favored).  homeFavorite mirrors that sign.
window.SCHEDULE = [
  { id: "g01", away: "DET", home: "GB",  kickoff: "Thu 7:15 PM CT", network: "Prime",  slot: "TNF",   spread: +1.5, homeMoneyLine: +110, awayMoneyLine: -130, homeFavorite: false },
  { id: "g02", away: "NYJ", home: "MIA", kickoff: "Sun 12:00 PM CT",network: "CBS",    slot: "Early", spread: -3.5, homeMoneyLine: -185, awayMoneyLine: +160, homeFavorite: true  },
  { id: "g03", away: "ATL", home: "MIN", kickoff: "Sun 12:00 PM CT",network: "FOX",    slot: "Early", spread: -2.5, homeMoneyLine: -140, awayMoneyLine: +120, homeFavorite: true  },
  { id: "g04", away: "BUF", home: "CIN", kickoff: "Sun 12:00 PM CT",network: "CBS",    slot: "Early", spread: +4.5, homeMoneyLine: +175, awayMoneyLine: -210, homeFavorite: false },
  { id: "g05", away: "BAL", home: "CLE", kickoff: "Sun 12:00 PM CT",network: "CBS",    slot: "Early", spread: +6.0, homeMoneyLine: +220, awayMoneyLine: -270, homeFavorite: false },
  { id: "g06", away: "JAX", home: "TEN", kickoff: "Sun 12:00 PM CT",network: "CBS",    slot: "Early", spread: +1.0, homeMoneyLine: +105, awayMoneyLine: -125, homeFavorite: false },
  { id: "g07", away: "CAR", home: "PHI", kickoff: "Sun 12:00 PM CT",network: "FOX",    slot: "Early", spread: -9.5, homeMoneyLine: -450, awayMoneyLine: +350, homeFavorite: true  },
  { id: "g08", away: "NO",  home: "NYG", kickoff: "Sun 12:00 PM CT",network: "FOX",    slot: "Early", spread: -1.5, homeMoneyLine: -125, awayMoneyLine: +105, homeFavorite: true  },
  { id: "g09", away: "TB",  home: "WAS", kickoff: "Sun 12:00 PM CT",network: "FOX",    slot: "Early", spread: -3.0, homeMoneyLine: -160, awayMoneyLine: +140, homeFavorite: true  },
  { id: "g10", away: "SEA", home: "ARI", kickoff: "Sun 3:05 PM CT", network: "FOX",    slot: "Late",  spread: +2.5, homeMoneyLine: +120, awayMoneyLine: -140, homeFavorite: false },
  { id: "g11", away: "LV",  home: "DEN", kickoff: "Sun 3:05 PM CT", network: "CBS",    slot: "Late",  spread: -6.5, homeMoneyLine: -280, awayMoneyLine: +230, homeFavorite: true  },
  { id: "g12", away: "IND", home: "LAR", kickoff: "Sun 3:25 PM CT", network: "FOX",    slot: "Late",  spread: -2.0, homeMoneyLine: -130, awayMoneyLine: +110, homeFavorite: true  },
  { id: "g13", away: "PIT", home: "KC",  kickoff: "Sun 3:25 PM CT", network: "CBS",    slot: "Late",  spread: -5.5, homeMoneyLine: -240, awayMoneyLine: +200, homeFavorite: true  },
  { id: "g14", away: "HOU", home: "SF",  kickoff: "Sun 7:20 PM CT", network: "NBC",    slot: "SNF",   spread: -3.5, homeMoneyLine: -190, awayMoneyLine: +160, homeFavorite: true  },
  { id: "g15", away: "DAL", home: "LAC", kickoff: "Mon 7:15 PM CT", network: "ABC",    slot: "MNF",   spread: -3.0, homeMoneyLine: -150, awayMoneyLine: +130, homeFavorite: true  },
  { id: "g16", away: "CHI", home: "NE",  kickoff: "Mon 7:15 PM CT", network: "ESPN",   slot: "MNF",   spread: +2.0, homeMoneyLine: +110, awayMoneyLine: -130, homeFavorite: false },
];

window.WEEK_META = { week: 14, season: 2025, label: "Week 14", weeksRemaining: 5 };

// ── Mode catalog (mirrors recommendation_engine.Mode enum) ─────────────────
window.MODES = [
  { id: "overall",       label: "Overall",        desc: "Base playoff contention. Division + wild card combined." },
  { id: "division",      label: "Division Title", desc: "Only division-rival games matter. Wild card noise removed." },
  { id: "wildcard",      label: "Wild Card",      desc: "All conference losses equally valuable." },
  { id: "conf_one_seed", label: "#1 Seed",        desc: "Climb to the top seed for a bye + home through the playoffs." },
  { id: "tank",          label: "Tank",           desc: "Root for losses. Best draft pick wins." },
];

// ── Tiebreaker prose (from tiebreaker.py output) ───────────────────────────
// Used to annotate standing rows where the W-L is tied with another team.
// Map: { abbr: { over: [abbrs], reason: "..." } }  — "this team beats these teams via {reason}".
window.TIEBREAKER_REASONS = {
  PIT: { over: ["BAL"], reason: "Head-to-head sweep (2-0)" },
  BAL: { over: ["IND"], reason: "Division record .800 vs .500" },
  HOU: { over: ["IND"], reason: "Strength of victory .528 vs .501" },
  LAC: { over: ["GB"],  reason: "Conference record 7-2 vs 6-3" },
  LAR: { over: ["MIN", "TB"], reason: "Common-games sweep" },
  DEN: { over: ["MIA"], reason: "Strength of schedule .520 vs .495" },
  TB:  { over: ["IND"], reason: "Conference record .700 vs .625" },
  ATL: { over: ["DAL"], reason: "Head-to-head win" },
};

// ── Team-strength scores (placeholder, mirrors team_strength.computeAllTeamStrengths) ─
// strengthScore is composite; signal columns are normalised [0,1] per builders/team_strength.py.
window.TEAM_STRENGTHS = {
  KC:  { strengthScore: 0.91, pointDiff: 0.94, sos: 0.62, divisionBonus: 1.00, recentForm: 0.92, winMarginConsistency: 0.80 },
  DET: { strengthScore: 0.89, pointDiff: 0.95, sos: 0.55, divisionBonus: 1.00, recentForm: 0.88, winMarginConsistency: 0.82 },
  PHI: { strengthScore: 0.85, pointDiff: 0.84, sos: 0.58, divisionBonus: 1.00, recentForm: 0.84, winMarginConsistency: 0.74 },
  BUF: { strengthScore: 0.83, pointDiff: 0.80, sos: 0.66, divisionBonus: 1.00, recentForm: 0.80, winMarginConsistency: 0.70 },
  PIT: { strengthScore: 0.74, pointDiff: 0.62, sos: 0.72, divisionBonus: 1.00, recentForm: 0.78, winMarginConsistency: 0.60 },
  LAC: { strengthScore: 0.71, pointDiff: 0.66, sos: 0.55, divisionBonus: 0.66, recentForm: 0.72, winMarginConsistency: 0.62 },
  GB:  { strengthScore: 0.69, pointDiff: 0.58, sos: 0.60, divisionBonus: 0.66, recentForm: 0.74, winMarginConsistency: 0.58 },
  BAL: { strengthScore: 0.67, pointDiff: 0.71, sos: 0.50, divisionBonus: 0.66, recentForm: 0.62, winMarginConsistency: 0.66 },
  SF:  { strengthScore: 0.66, pointDiff: 0.60, sos: 0.62, divisionBonus: 0.66, recentForm: 0.68, winMarginConsistency: 0.62 },
  HOU: { strengthScore: 0.62, pointDiff: 0.50, sos: 0.58, divisionBonus: 1.00, recentForm: 0.60, winMarginConsistency: 0.55 },
  DEN: { strengthScore: 0.61, pointDiff: 0.54, sos: 0.56, divisionBonus: 0.66, recentForm: 0.66, winMarginConsistency: 0.52 },
  MIN: { strengthScore: 0.59, pointDiff: 0.55, sos: 0.60, divisionBonus: 0.33, recentForm: 0.62, winMarginConsistency: 0.55 },
  LAR: { strengthScore: 0.57, pointDiff: 0.50, sos: 0.55, divisionBonus: 0.33, recentForm: 0.60, winMarginConsistency: 0.55 },
  TB:  { strengthScore: 0.55, pointDiff: 0.48, sos: 0.52, divisionBonus: 1.00, recentForm: 0.54, winMarginConsistency: 0.50 },
  IND: { strengthScore: 0.52, pointDiff: 0.42, sos: 0.55, divisionBonus: 0.66, recentForm: 0.50, winMarginConsistency: 0.48 },
  MIA: { strengthScore: 0.51, pointDiff: 0.44, sos: 0.50, divisionBonus: 0.33, recentForm: 0.52, winMarginConsistency: 0.48 },
  DAL: { strengthScore: 0.49, pointDiff: 0.45, sos: 0.50, divisionBonus: 0.33, recentForm: 0.46, winMarginConsistency: 0.48 },
  ATL: { strengthScore: 0.47, pointDiff: 0.40, sos: 0.50, divisionBonus: 0.33, recentForm: 0.48, winMarginConsistency: 0.44 },
  SEA: { strengthScore: 0.46, pointDiff: 0.40, sos: 0.50, divisionBonus: 0.33, recentForm: 0.50, winMarginConsistency: 0.42 },
  WAS: { strengthScore: 0.44, pointDiff: 0.38, sos: 0.48, divisionBonus: 0.33, recentForm: 0.46, winMarginConsistency: 0.40 },
  CIN: { strengthScore: 0.41, pointDiff: 0.42, sos: 0.42, divisionBonus: 0.33, recentForm: 0.38, winMarginConsistency: 0.42 },
  CHI: { strengthScore: 0.39, pointDiff: 0.35, sos: 0.46, divisionBonus: 0.33, recentForm: 0.42, winMarginConsistency: 0.36 },
  NO:  { strengthScore: 0.36, pointDiff: 0.32, sos: 0.44, divisionBonus: 0.33, recentForm: 0.38, winMarginConsistency: 0.34 },
  ARI: { strengthScore: 0.35, pointDiff: 0.34, sos: 0.42, divisionBonus: 0.33, recentForm: 0.36, winMarginConsistency: 0.34 },
  JAX: { strengthScore: 0.33, pointDiff: 0.30, sos: 0.40, divisionBonus: 0.33, recentForm: 0.34, winMarginConsistency: 0.32 },
  NYJ: { strengthScore: 0.31, pointDiff: 0.28, sos: 0.40, divisionBonus: 0.00, recentForm: 0.32, winMarginConsistency: 0.30 },
  NYG: { strengthScore: 0.26, pointDiff: 0.22, sos: 0.38, divisionBonus: 0.00, recentForm: 0.24, winMarginConsistency: 0.26 },
  CLE: { strengthScore: 0.25, pointDiff: 0.20, sos: 0.40, divisionBonus: 0.00, recentForm: 0.22, winMarginConsistency: 0.22 },
  NE:  { strengthScore: 0.22, pointDiff: 0.20, sos: 0.36, divisionBonus: 0.00, recentForm: 0.24, winMarginConsistency: 0.22 },
  LV:  { strengthScore: 0.20, pointDiff: 0.18, sos: 0.34, divisionBonus: 0.00, recentForm: 0.20, winMarginConsistency: 0.20 },
  CAR: { strengthScore: 0.18, pointDiff: 0.14, sos: 0.32, divisionBonus: 0.00, recentForm: 0.20, winMarginConsistency: 0.18 },
  TEN: { strengthScore: 0.14, pointDiff: 0.12, sos: 0.30, divisionBonus: 0.00, recentForm: 0.14, winMarginConsistency: 0.16 },
};

// ── Helpers ─────────────────────────────────────────────────────────────────
window.TEAMS_BY_DIVISION = (() => {
  const out = {};
  for (const t of Object.values(window.TEAMS)) {
    const key = `${t.conf} ${t.div}`;
    (out[key] = out[key] || []).push(t.abbr);
  }
  return out;
})();

const STRENGTH_WEIGHT = { high: 0.35, medium: 0.20, low: 0.10 };
const winPct = (t) => t.record[0] / Math.max(1, t.record[0] + t.record[1]);

/* ─── Standings ─────────────────────────────────────────────────────────── */
window.computeStandings = function () {
  const teams = Object.values(window.TEAMS);
  const sortByPct = (a, b) => winPct(b) - winPct(a) || b.record[0] - a.record[0];
  const out = { AFC: [], NFC: [], byTeam: {}, divisions: {} };

  for (const conf of ["AFC", "NFC"]) {
    const divs = {};
    for (const t of teams.filter(t => t.conf === conf)) (divs[t.div] = divs[t.div] || []).push(t);
    for (const d of Object.keys(divs)) divs[d].sort(sortByPct);
    out.divisions[conf] = divs;

    const winners = ["East", "North", "South", "West"].map(d => divs[d][0]).sort(sortByPct);
    winners.forEach((t, i) => {
      out[conf].push({ seed: i + 1, team: t.abbr, kind: "division" });
      out.byTeam[t.abbr] = { seed: i + 1, kind: "division", conf };
    });
    const winnersSet = new Set(winners.map(t => t.abbr));
    const rest = teams.filter(t => t.conf === conf && !winnersSet.has(t.abbr)).sort(sortByPct);
    for (let i = 0; i < 3 && i < rest.length; i++) {
      out[conf].push({ seed: 5 + i, team: rest[i].abbr, kind: "wildcard" });
      out.byTeam[rest[i].abbr] = { seed: 5 + i, kind: "wildcard", conf };
    }
    for (let i = 3; i < rest.length; i++) {
      out.byTeam[rest[i].abbr] = { seed: null, kind: "out", conf, gamesBehind: rest[i].record[1] - rest[2].record[1] };
    }
  }
  return out;
};

/* ─── Games back / weeks left / division contention ─────────────────────── */
function gamesBack(fav) {
  const divLeader = Object.values(window.TEAMS)
    .filter(t => t.conf === fav.conf && t.div === fav.div)
    .reduce((a, b) => (b.record[0] > a.record[0] ? b : a));
  if (divLeader.abbr === fav.abbr) return 0;
  return ((divLeader.record[0] - fav.record[0]) + (fav.record[1] - divLeader.record[1])) / 2;
}
const weeksRemaining = () => window.WEEK_META.weeksRemaining;
function inDivisionContention(team) { return gamesBack(team) <= weeksRemaining(); }
function maxWins(team) { return team.record[0] + weeksRemaining(); }

/* ─── Available modes ──────────────────────────────────────────────────── */
window.availableModes = function (favAbbr) {
  const fav = window.TEAMS[favAbbr];
  const all = ["overall"];
  // DIVISION: alive iff no division peer already has more wins than max possible
  const divPeers = Object.values(window.TEAMS).filter(t => t.conf === fav.conf && t.div === fav.div && t.abbr !== favAbbr);
  if (divPeers.every(p => p.record[0] <= maxWins(fav))) all.push("division");
  // WILDCARD: fewer than 3 conference non-div teams already ahead of fav's max wins
  const confNonDiv = Object.values(window.TEAMS).filter(
    t => t.conf === fav.conf && t.div !== fav.div && t.abbr !== favAbbr
  );
  if (confNonDiv.filter(t => t.record[0] > maxWins(fav)).length < 3) all.push("wildcard");
  // #1 seed: no conference peer with more wins than fav's max
  const confPeers = Object.values(window.TEAMS).filter(t => t.conf === fav.conf && t.abbr !== favAbbr);
  if (confPeers.every(p => p.record[0] <= maxWins(fav))) all.push("conf_one_seed");
  all.push("tank");
  return all;
};

/* ─── Your Team's Game (current week) ───────────────────────────────────── */
window.favTeamGame = function (favAbbr, mode = "overall") {
  const g = window.SCHEDULE.find(g => g.home === favAbbr || g.away === favAbbr);
  if (!g) return null;
  const fav = window.TEAMS[favAbbr];
  const oppAbbr = g.home === favAbbr ? g.away : g.home;
  const opp = window.TEAMS[oppAbbr];
  const isHome = g.home === favAbbr;
  const fGB = gamesBack(fav);
  const wr = weeksRemaining();
  const isDivRival = opp.div === fav.div && opp.conf === fav.conf;
  const isPlayoffElim = false; // simplified for placeholder

  let blurb = "";
  if (mode === "tank") {
    blurb = `TANK mode: root for ${oppAbbr} (${opp.record[0]}W) to WIN — a ${favAbbr} loss improves your draft slot.`;
  } else if (isPlayoffElim) {
    blurb = "Out of playoff contention — playing for pride and draft position.";
  } else if (mode === "division" || inDivisionContention(fav)) {
    if (fGB === 0) {
      blurb = isDivRival
        ? `Win to extend your division lead over ${oppAbbr} (${gamesBack(opp).toFixed(1)} GB behind, ${wr} weeks left).`
        : `Win to stay atop the ${fav.div} (${wr} weeks left).`;
    } else {
      blurb = isDivRival
        ? `Win to cut the gap — ${favAbbr} is ${fGB.toFixed(1)} GB back with ${wr} weeks left.`
        : `Win to stay in the ${fav.div} race (${fGB.toFixed(1)} GB back, ${wr} weeks left).`;
    }
  } else if (mode === "conf_one_seed") {
    const leader = Object.values(window.TEAMS).filter(t => t.conf === fav.conf)
      .reduce((a, b) => b.record[0] > a.record[0] ? b : a);
    blurb = `Win to chase the ${fav.conf} #1 seed (${leader.record[0] - fav.record[0]}W behind ${leader.abbr}, ${wr} weeks left).`;
  } else {
    blurb = `Win to strengthen your ${fav.conf} wildcard position.`;
  }

  // Underdog resolution (spread > 0 means home is underdog)
  let underdog = null;
  if (g.spread != null) underdog = g.spread < 0 ? g.away : (g.spread > 0 ? g.home : null);
  else if (g.homeFavorite != null) underdog = g.homeFavorite ? g.away : g.home;

  return { ...g, fav: favAbbr, opp: oppAbbr, isHome, blurb, underdog };
};

/* ─── Underdog resolver per RecommendationEngine._resolve_underdog ──────── */
function resolveUnderdog(g) {
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

/* ─── Scenario detectors (mirror recommendation_engine.py) ──────────────── */
function scenarioRows(home, away, fav, dislikes, mode, futureFavOpponents) {
  const out = [];
  const homeT = window.TEAMS[home], awayT = window.TEAMS[away];

  // DivisionRivalTank — high
  for (const team of [home, away]) {
    const t = window.TEAMS[team];
    if (t.div === fav.div && t.conf === fav.conf && team !== fav.abbr) {
      const opp = team === home ? away : home;
      out.push({
        root_for: opp, against: team,
        category: "DivisionRivalTank", strength: "high",
        strength_weight: STRENGTH_WEIGHT.high,
        why: `${team} is a division rival — root for their opponent to hurt their standings`,
      });
    }
  }

  // OpponentTanking — medium  (any upcoming fav opponent)
  for (const team of [home, away]) {
    if (!futureFavOpponents.has(team)) continue;
    const opp = team === home ? away : home;
    const t = window.TEAMS[team];
    const w = t.record[0], l = t.record[1];
    if (w > l) {
      out.push({
        root_for: opp, against: team,
        category: "OpponentTanking", strength: "medium", strength_weight: STRENGTH_WEIGHT.medium,
        why: `${team} (${w}-${l}) is an upcoming opponent on a winning record — cool their momentum`,
      });
    } else if (l > w) {
      out.push({
        root_for: opp, against: team,
        category: "OpponentTanking", strength: "medium", strength_weight: STRENGTH_WEIGHT.medium,
        why: `${team} (${w}-${l}) is an upcoming opponent on a skid — keep their locker room fractured`,
      });
    }
  }

  // PlayoffSoftening — medium (not DIVISION mode)
  if (mode !== "division") {
    for (const team of [home, away]) {
      const t = window.TEAMS[team];
      if (team === fav.abbr || t.conf !== fav.conf) continue;
      if (t.record[0] > t.record[1]) {
        const opp = team === home ? away : home;
        out.push({
          root_for: opp, against: team,
          category: "PlayoffSoftening", strength: "medium", strength_weight: STRENGTH_WEIGHT.medium,
          why: `${team} (${t.record[0]}-${t.record[1]}) is a ${fav.conf} team projecting into playoff seeding — dent their momentum`,
        });
      }
    }
  }

  // UpsetRooting — medium (heavy home favorite in conference; not DIVISION mode)
  if (mode !== "division") {
    if (homeT.conf === fav.conf && home !== fav.abbr) {
      const gap = homeT.record[0] - awayT.record[0];
      if (gap >= 4) {
        out.push({
          root_for: away, against: home,
          category: "UpsetRooting", strength: "medium", strength_weight: STRENGTH_WEIGHT.medium,
          why: `${home} (${homeT.record[0]}W) is a heavy home favorite vs ${away} (${awayT.record[0]}W, ${gap}-win gap) — trap-game upset`,
        });
      }
    }
  }

  // DraftPositioning — low (OVERALL + WILDCARD only)
  if (mode === "overall" || mode === "wildcard") {
    for (const team of [home, away]) {
      if (team === fav.abbr) continue;
      const t = window.TEAMS[team];
      const isDivRival = t.div === fav.div && t.conf === fav.conf;
      const isConfThreat = t.conf === fav.conf;
      if (!(isDivRival || isConfThreat)) continue;
      const w = t.record[0];
      if (w >= 6 && w <= 9) {
        const opp = team === home ? away : home;
        const label = isDivRival ? "division rival" : "conference threat";
        out.push({
          root_for: opp, against: team,
          category: "DraftPositioning", strength: "low", strength_weight: STRENGTH_WEIGHT.low,
          why: `${team} (${w}W) is a ${label} stuck in no man's land — keep them losing`,
        });
      }
    }
  }

  // Dislikes — medium
  for (const team of [home, away]) {
    if (dislikes.includes(team)) {
      const opp = team === home ? away : home;
      out.push({
        root_for: opp, against: team,
        category: "Dislikes", strength: "medium", strength_weight: STRENGTH_WEIGHT.medium,
        why: `you dislike ${team}`,
      });
    }
  }
  return out;
}

/* ─── Mode-aware playoff impact score ──────────────────────────────────── */
function modeScore(candidate, opponent, fav, mode, dislikes) {
  const c = window.TEAMS[candidate], o = window.TEAMS[opponent];
  const isSameDiv = o.div === fav.div && o.conf === fav.conf;
  const isSameConf = o.conf === fav.conf;
  const wr = weeksRemaining();
  const favGB = gamesBack(fav);
  let score = 0;

  if (mode === "division") {
    if (isSameDiv) {
      if (inDivisionContention(fav) && inDivisionContention(o)) {
        const urgency = Math.max(0, 1 - favGB / Math.max(wr, 1));
        score += 0.25 + 0.25 * urgency;
      } else score += 0.25;
    }
  } else if (mode === "wildcard") {
    if (isSameConf) score += 0.20;
  } else if (mode === "conf_one_seed") {
    if (isSameConf) score += 0.20 + 0.10 * Math.min(o.record[0] / 17, 1);
  } else {
    // overall
    if (isSameDiv && inDivisionContention(fav) && inDivisionContention(o)) {
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

function buildReasoning(rootAbbr, againstAbbr, fav, mode, score) {
  const parts = [];
  const opp = window.TEAMS[againstAbbr];
  const targetByMode = {
    division: "division title odds",
    conf_one_seed: "#1 seed odds",
    wildcard: "wild card odds",
    overall: "wild card odds",
    tank: "draft slot",
  };
  const target = targetByMode[mode];
  if (opp.div === fav.div && opp.conf === fav.conf) {
    const fGB = gamesBack(fav), oGB = gamesBack(opp), wr = weeksRemaining();
    if (inDivisionContention(fav) && inDivisionContention(opp)) {
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

/* ─── Tank mode scoring for a single game ──────────────────────────────── */
function scoreGameTank(home, away, fav) {
  if (home === fav.abbr || away === fav.abbr) return null;
  const favWins = fav.record[0];
  const hW = window.TEAMS[home].record[0], aW = window.TEAMS[away].record[0];
  const [rootAbbr, againstAbbr, rootWins] = hW <= aW
    ? [home, away, hW] : [away, home, aW];
  const minGap = Math.min(Math.abs(hW - favWins), Math.abs(aW - favWins));
  let base = minGap === 0 ? 0.5 : minGap === 1 ? 0.35 : minGap === 2 ? 0.20 : minGap === 3 ? 0.10 : 0.05;
  const isDivRival = window.TEAMS[rootAbbr].div === fav.div && window.TEAMS[rootAbbr].conf === fav.conf;
  if (isDivRival) base = Math.min(base + 0.15, 1.0);
  let why;
  if (rootWins < favWins) why = `${rootAbbr} (${rootWins}W) is below you — their win brings them up and protects your draft slot`;
  else if (rootWins === favWins) why = `${rootAbbr} (${rootWins}W) is tied with you — their win separates them from your draft range`;
  else why = `neither team threatens your draft slot; root for the worse-record team to clear the field`;
  const strength = base >= 0.35 ? "high" : (base >= 0.20 ? "medium" : "low");
  return {
    rootFor: rootAbbr, against: againstAbbr, score: base, strength,
    strength_weight: STRENGTH_WEIGHT[strength],
    category: "TankPositioning",
    reasonsAll: [why],
  };
}

/* ─── MAIN: compute recommendations ────────────────────────────────────── */
window.computeRecommendations = function (favAbbr, dislikes, mode = "overall") {
  const fav = window.TEAMS[favAbbr];
  if (!fav) return [];
  dislikes = (dislikes || []).map(d => d.toUpperCase());
  const futureFavOpponents = new Set(
    window.SCHEDULE.filter(g => g.home === favAbbr || g.away === favAbbr).map(g => g.home === favAbbr ? g.away : g.home)
  );

  const recs = [];
  for (const g of window.SCHEDULE) {
    if (g.home === favAbbr || g.away === favAbbr) continue;

    if (mode === "tank") {
      const r = scoreGameTank(g.home, g.away, fav);
      if (r) recs.push({
        gameId: g.id, ...r, kickoff: g.kickoff, network: g.network, slot: g.slot,
        spread: g.spread, underdog: resolveUnderdog(g),
        reasoning: r.reasonsAll[0],
      });
      continue;
    }

    // Playoff impact scoring (only conf opponents matter)
    let playoffRoot = null, playoffAgainst = null, playoffScore = 0;
    const homeT = window.TEAMS[g.home], awayT = window.TEAMS[g.away];
    if (homeT.conf === fav.conf || awayT.conf === fav.conf) {
      const h = modeScore(g.home, g.away, fav, mode, dislikes);
      const a = modeScore(g.away, g.home, fav, mode, dislikes);
      const underdog = resolveUnderdog(g);
      const _ud = 0.02;
      const adjH = h + (g.home === underdog ? _ud : 0);
      const adjA = a + (g.away === underdog ? _ud : 0);
      if (adjH >= adjA) { playoffRoot = g.home; playoffAgainst = g.away; playoffScore = h; }
      else              { playoffRoot = g.away; playoffAgainst = g.home; playoffScore = a; }
    } else {
      playoffRoot = g.home; playoffAgainst = g.away; playoffScore = 0;
    }

    // Scenarios
    const scenarios = scenarioRows(g.home, g.away, fav, dislikes, mode, futureFavOpponents);
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
        reasonsAll.push(...buildReasoning(rootAbbr, againstAbbr, fav, mode, playoffScore));
      }
    } else {
      rootAbbr = playoffRoot; againstAbbr = playoffAgainst;
      score = playoffScore;
      strengthWeight = 0;
      if (score > 0) { category = "direct_playoff_impact"; strength = "low"; }
      else            { category = "no_impact"; strength = ""; }
      reasonsAll = buildReasoning(rootAbbr, againstAbbr, fav, mode, score);
    }

    if (score > 0) {
      const homeStr = (window.TEAM_STRENGTHS[g.home]?.strengthScore || 0.5);
      const awayStr = (window.TEAM_STRENGTHS[g.away]?.strengthScore || 0.5);
      score = Math.min(score + 0.05 * (homeStr + awayStr) / 2, 1.0);
    }

    recs.push({
      gameId: g.id, rootFor: rootAbbr, against: againstAbbr,
      score, category, strength, strength_weight: strengthWeight,
      reasoning: reasonsAll[0],
      reasonsAll,
      kickoff: g.kickoff, network: g.network, slot: g.slot,
      spread: g.spread, underdog: resolveUnderdog(g),
    });
  }

  recs.sort((a, b) => (b.score - a.score) || (b.strength_weight - a.strength_weight));
  return recs;
};

/* ─── Pretty-print helpers for UI ─────────────────────────────────────── */
window.CATEGORY_META = {
  DivisionRivalTank:     { label: "Division rival tank",   tone: "fav",   help: "Their loss directly improves your division standing." },
  OpponentTanking:       { label: "Opponent tanking",      tone: "neutral", help: "An upcoming team for you — soften them up first." },
  PlayoffSoftening:      { label: "Playoff softening",     tone: "neutral", help: "A conference team projecting in — dent their momentum." },
  UpsetRooting:          { label: "Upset rooting",         tone: "warn",  help: "Heavy home favorite in your conference. Trap-game potential." },
  DraftPositioning:      { label: "Draft positioning",     tone: "neutral", help: "Stuck in no-man's-land; keep them losing." },
  Dislikes:              { label: "Personal rivalry",      tone: "warn",  help: "Boosted because you marked them as disliked." },
  TankPositioning:       { label: "Tank positioning",      tone: "fav",   help: "Protect your draft slot — bring teams below you up." },
  direct_playoff_impact: { label: "Playoff impact",        tone: "fav",   help: "Direct playoff math: their loss improves your odds." },
  no_impact:             { label: "No impact",             tone: "muted", help: "Not in your conference; result doesn't move your odds." },
};

window.STRENGTH_META = {
  high:   { label: "High",   weight: 0.35, color: "var(--accent)" },
  medium: { label: "Medium", weight: 0.20, color: "oklch(0.66 0.10 50)" },
  low:    { label: "Low",    weight: 0.10, color: "var(--text-faint)" },
};

/* ─── Scenarios for a team (mirrors scenario_builder.py output) ────────────
 * Generates clinch / elimination / watch paths for the favorite team.
 * Each scenario:
 *   id, kind: "clinch" | "elimination" | "watch",
 *   title, summary,
 *   requires: [{type: "win"|"loss", team, rationale}],
 *   likelihood: 0..1, urgency: "high"|"med"|"low"
 */
window.computeScenarios = function (favAbbr) {
  const fav = window.TEAMS[favAbbr];
  if (!fav) return [];
  const standings = window.computeStandings();
  const seed = standings.byTeam[favAbbr] || {};
  const divRivals = Object.values(window.TEAMS).filter(
    t => t.conf === fav.conf && t.div === fav.div && t.abbr !== favAbbr
  );
  const confRivals = Object.values(window.TEAMS).filter(
    t => t.conf === fav.conf && t.abbr !== favAbbr && t.div !== fav.div
  ).sort((a, b) => winPct(b) - winPct(a));

  const favWins = fav.record[0];
  const favLosses = fav.record[1];
  const scenarios = [];

  const topDivRival = [...divRivals].sort((a, b) => winPct(b) - winPct(a))[0];
  const leadsDivision = winPct(fav) > winPct(topDivRival);

  if (leadsDivision) {
    const gap = favWins - topDivRival.record[0];
    scenarios.push({
      id: "clinch-div-quick", kind: "clinch",
      title: `Clinch the ${fav.conf} ${fav.div} this week`,
      summary: `One ${fav.abbr} win plus a ${topDivRival.abbr} loss locks the division before December's last Sunday.`,
      requires: [
        { type: "win",  team: favAbbr,         rationale: "Hold serve at home" },
        { type: "loss", team: topDivRival.abbr, rationale: `Drop ${topDivRival.abbr} another game back` },
      ],
      likelihood: 0.45 + Math.min(0.35, gap * 0.12),
      urgency: gap >= 2 ? "high" : "med",
    });
    scenarios.push({
      id: "clinch-div-slow", kind: "clinch",
      title: `Clinch with two more wins`,
      summary: `Win out the next two and the division is yours regardless of what the rest of the ${fav.div} does.`,
      requires: [
        { type: "win", team: favAbbr, rationale: "Win the road trip" },
        { type: "win", team: favAbbr, rationale: "Win the home finale" },
      ],
      likelihood: 0.55, urgency: "med",
    });
  } else {
    const gap = topDivRival.record[0] - favWins;
    scenarios.push({
      id: "catch-up", kind: "watch",
      title: `Catch ${topDivRival.abbr} in the ${fav.div}`,
      summary: `${gap}-game gap. You need ${topDivRival.abbr} to drop two of their next three while you win out.`,
      requires: [
        { type: "win",  team: favAbbr,         rationale: "Stay alive in the race" },
        { type: "loss", team: topDivRival.abbr, rationale: "Open the door" },
        { type: "loss", team: topDivRival.abbr, rationale: "Walk through it" },
      ],
      likelihood: Math.max(0.12, 0.4 - gap * 0.1),
      urgency: gap >= 2 ? "high" : "med",
    });
  }

  const onBubble = seed.kind === "wildcard" || (seed.kind === "out" && (seed.gamesBehind || 99) <= 1);
  if (onBubble || !leadsDivision) {
    const bubbleTeams = confRivals.filter(t => Math.abs(winPct(t) - winPct(fav)) <= 0.15).slice(0, 3);
    if (bubbleTeams.length) {
      scenarios.push({
        id: "wc-clinch", kind: "clinch",
        title: `Lock down a wild-card spot`,
        summary: `${bubbleTeams.map(t => t.abbr).join(", ")} are all within a game. A ${fav.abbr} win plus any two of them losing puts you firmly in the bracket.`,
        requires: [
          { type: "win", team: favAbbr, rationale: "Hold your seed" },
          ...bubbleTeams.slice(0, 2).map(t => ({ type: "loss", team: t.abbr, rationale: "Stack the tiebreaker" })),
        ],
        likelihood: 0.32, urgency: "high",
      });
    }
  }

  if (favLosses >= 6) {
    scenarios.push({
      id: "elim-watch", kind: "elimination",
      title: `Mathematical elimination watch`,
      summary: `Two more losses plus any two of (${confRivals.slice(0, 3).map(t => t.abbr).join(", ")}) winning out drops ${fav.abbr} out of contention.`,
      requires: [
        { type: "loss", team: favAbbr, rationale: "Slip on the road" },
        { type: "loss", team: favAbbr, rationale: "Drop the next one" },
        { type: "win",  team: confRivals[0].abbr, rationale: `${confRivals[0].abbr} pulls away` },
      ],
      likelihood: 0.18, urgency: "low",
    });
  }

  if ([1, 2, 3].includes(seed.seed)) {
    scenarios.push({
      id: "bye-chase", kind: "clinch",
      title: `Climb to the #1 seed (bye + home through the playoffs)`,
      summary: `Three wins to close plus a single loss from the current conference leader gives ${fav.abbr} the top seed.`,
      requires: [
        { type: "win", team: favAbbr, rationale: "Run the table" },
        { type: "loss", team: confRivals.find(t => winPct(t) > winPct(fav))?.abbr || confRivals[0].abbr,
          rationale: "Top seed slips" },
      ],
      likelihood: 0.22, urgency: "med",
    });
  }

  return scenarios;
};
