/*
 * Who2Root4 — data layer.
 *
 * Pulls live data directly from the user's GitHub repo:
 *   github.com/JoshStremmel/Who2Root4 → .cache/espn/scoreboard_<season>_<type>_w<NN>.json
 *
 * These JSON files are produced by `pipeline.py` (builders/espn_fetcher.py).
 * Every time you push fresh pipeline output, the site auto-updates — we fetch
 * straight from raw.githubusercontent.com, which always serves the latest commit
 * on main with open CORS.
 *
 * Compute functions (computeRecommendations, computeStandings, computeScenarios)
 * mirror the Python recommendation_engine / scenario_builder, so swapping in a
 * server-computed JSON output would also be a drop-in replacement.
 */

/* ─── Repo config ───────────────────────────────────────────────────────── */
const GH_OWNER  = "JoshStremmel";
const GH_REPO   = "Who2Root4";
const GH_BRANCH = "main";
const RAW_BASE  = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}`;

/* ─── Static team metadata: division & conference (stable) ──────────────── */
const DIVISIONS = {
  BUF:["AFC","East"],  MIA:["AFC","East"],  NE:["AFC","East"],   NYJ:["AFC","East"],
  BAL:["AFC","North"], CIN:["AFC","North"], CLE:["AFC","North"], PIT:["AFC","North"],
  HOU:["AFC","South"], IND:["AFC","South"], JAX:["AFC","South"], TEN:["AFC","South"],
  DEN:["AFC","West"],  KC: ["AFC","West"],  LV: ["AFC","West"],  LAC:["AFC","West"],
  DAL:["NFC","East"],  NYG:["NFC","East"],  PHI:["NFC","East"],  WAS:["NFC","East"],
  CHI:["NFC","North"], DET:["NFC","North"], GB: ["NFC","North"], MIN:["NFC","North"],
  ATL:["NFC","South"], CAR:["NFC","South"], NO: ["NFC","South"], TB: ["NFC","South"],
  ARI:["NFC","West"],  LAR:["NFC","West"],  SF: ["NFC","West"],  SEA:["NFC","West"],
};
// ESPN sometimes uses alternate abbreviations
const ABBR_ALIAS = { WSH: "WAS", JAC: "JAX" };
const normAbbr   = (a) => ABBR_ALIAS[a] || a;

/* ─── Constant catalogs (sync-available) ────────────────────────────────── */
window.MODES = [
  { id: "overall",       label: "Overall",        desc: "Base playoff contention. Division + wild card combined." },
  { id: "division",      label: "Division Title", desc: "Only division-rival games matter. Wild card noise removed." },
  { id: "wildcard",      label: "Wild Card",      desc: "All conference losses equally valuable." },
  { id: "conf_one_seed", label: "#1 Seed",        desc: "Climb to the top seed for a bye + home through the playoffs." },
  { id: "tank",          label: "Tank",           desc: "Root for losses. Best draft pick wins." },
];

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

/* ─── Helpers used by both loader and engine ────────────────────────────── */
const STRENGTH_WEIGHT = { high: 0.35, medium: 0.20, low: 0.10 };
const winPct = (t) => {
  const w = t.record[0], l = t.record[1], tt = t.record[2] || 0;
  const games = w + l + tt;
  return games === 0 ? 0 : (w + 0.5 * tt) / games;
};

/* ─── Team palette fallback (ESPN provides color, this is just a backup) ── */
const TEAM_COLOR_FALLBACK = {
  PIT:"#ffb612", BAL:"#241773", CIN:"#fb4f14", CLE:"#311d00",
  BUF:"#00338d", MIA:"#008e97", NYJ:"#125740", NE:"#002a5c",
  HOU:"#03202f", IND:"#002c5f", JAX:"#006778", TEN:"#19c6ff",
  KC:"#e31837", LAC:"#0080c6", DEN:"#fb4f14", LV:"#000000",
  DET:"#0076b6", GB:"#203731", MIN:"#4f2683", CHI:"#0b162a",
  PHI:"#004c54", DAL:"#003594", WAS:"#5a1414", NYG:"#0b2265",
  TB:"#d50a0a",  ATL:"#a71930", NO:"#d3bc8d", CAR:"#0085ca",
  SF:"#aa0000",  LAR:"#003594", SEA:"#002244", ARI:"#97233f",
};

/* ─── Date / week formatting ────────────────────────────────────────────── */
const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function formatKickoff(iso) {
  if (!iso) return "TBD";
  const d = new Date(iso);
  const day = DAYS[d.getUTCDay()];
  // Convert to ET (UTC-5/-4). We'll render in ET — most NFL games are scheduled in ET.
  // Use the user's local zone instead so it reads naturally:
  const opts = { weekday:"short", hour:"numeric", minute:"2-digit", hour12:true };
  try {
    return d.toLocaleString("en-US", opts) + " " +
      new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
        .formatToParts(d).find(p => p.type === "timeZoneName")?.value || "";
  } catch {
    return `${day} ${d.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" })}`;
  }
}
function deriveSlot(iso) {
  if (!iso) return "TBD";
  const d = new Date(iso);
  const dow = d.getUTCDay();              // 0=Sun
  const hourEt = (d.getUTCHours() + 24 - 4) % 24; // approx ET
  if (dow === 4) return "TNF";
  if (dow === 1) return "MNF";
  if (dow === 5) return "Fri";
  if (dow === 6) return "Sat";
  if (dow === 0) {
    if (hourEt >= 19) return "SNF";
    if (hourEt >= 16) return "Late";
    return "Early";
  }
  return "Reg";
}

/* ─── GitHub fetch ──────────────────────────────────────────────────────── */
function weeksToTry(season) {
  // We try every reg + post week. Missing files 404 silently.
  const out = [];
  for (let w = 1; w <= 18; w++) out.push({ season, type: "reg",  week: w });
  for (let w = 1; w <= 5;  w++) out.push({ season, type: "post", week: w });
  return out;
}
async function fetchScoreboard({ season, type, week }) {
  const ww = String(week).padStart(2, "0");
  const url = `${RAW_BASE}/.cache/espn/scoreboard_${season}_${type}_w${ww}.json`;
  try {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/* ─── Parse one event from ESPN scoreboard JSON ─────────────────────────── */
function parseEvent(ev, weekNum, seasonType) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const competitors = comp.competitors || [];
  const home = competitors.find(c => c.homeAway === "home");
  const away = competitors.find(c => c.homeAway === "away");
  if (!home || !away) return null;

  const hAbbr = normAbbr(home.team?.abbreviation);
  const aAbbr = normAbbr(away.team?.abbreviation);
  if (!hAbbr || !aAbbr) return null;

  const status = comp.status?.type || ev.status?.type || {};
  const completed = !!status.completed;
  const hScore = home.score != null ? Number(home.score) : null;
  const aScore = away.score != null ? Number(away.score) : null;

  // Odds (rare in cached files; if present, use it)
  const odds = comp.odds?.[0];
  let spread = null;
  if (odds && typeof odds.spread === "number") spread = odds.spread;

  const broadcast =
    comp.broadcasts?.[0]?.names?.[0] ||
    comp.broadcast ||
    "TBD";

  return {
    id: `g_${ev.id}`,
    eventId: ev.id,
    home: hAbbr,
    away: aAbbr,
    homeTeam: home.team,
    awayTeam: away.team,
    date: comp.date || ev.date,
    weekNum,
    seasonType,
    completed,
    homeScore: hScore,
    awayScore: aScore,
    homeWinner: !!home.winner,
    awayWinner: !!away.winner,
    network: broadcast,
    spread,
    venue: comp.venue?.fullName,
    headline: comp.headlines?.[0]?.shortLinkText || comp.headlines?.[0]?.description,
  };
}

/* ─── Aggregate season data from all fetched scoreboards ────────────────── */
function aggregate(scoreboards) {
  // Maps keyed by abbr
  const teams = {}; // abbr → { city, name, abbr, conf, div, color, logo, record:[w,l,t], pf, pa, results: [{week, win, pf, pa, oppAbbr}] }
  const eventsByWeek = {}; // `${type}-${weekNum}` → [events]
  const allEvents = [];
  let latestSeason = null;

  // Initialize all 32 teams (so even bye-week teams show up)
  for (const abbr of Object.keys(DIVISIONS)) {
    const [conf, div] = DIVISIONS[abbr];
    teams[abbr] = {
      abbr, conf, div,
      city: "", name: "",
      color: TEAM_COLOR_FALLBACK[abbr] || "#999999",
      logo: null,
      record: [0, 0, 0],
      pf: 0, pa: 0,
      results: [],
    };
  }

  for (const sb of scoreboards) {
    if (!sb) continue;
    latestSeason = sb.season?.year || latestSeason;
    const seasonType =
      sb.season?.type === 3 ? "post" :
      sb.season?.type === 2 ? "reg"  : "other";
    const weekNum = sb.week?.number ?? 0;

    const events = (sb.events || []).map(ev => parseEvent(ev, weekNum, seasonType)).filter(Boolean);
    const key = `${seasonType}-${String(weekNum).padStart(2,"0")}`;
    (eventsByWeek[key] = eventsByWeek[key] || []).push(...events);

    for (const ev of events) {
      allEvents.push(ev);
      // Fill team identity from ESPN team blob the first time we see them
      for (const side of ["home","away"]) {
        const abbr = ev[side];
        const t = ev[side === "home" ? "homeTeam" : "awayTeam"];
        if (teams[abbr] && t) {
          if (!teams[abbr].city)  teams[abbr].city  = t.location || teams[abbr].city;
          if (!teams[abbr].name)  teams[abbr].name  = t.name || teams[abbr].name;
          if (!teams[abbr].logo)  teams[abbr].logo  = t.logo || null;
          // Intentionally ignore ESPN's t.color — use TEAM_COLOR_FALLBACK only.
        }
      }

      // Aggregate records only from completed regular-season games
      if (ev.completed && seasonType === "reg") {
        const hT = teams[ev.home], aT = teams[ev.away];
        if (!hT || !aT) continue;
        const tie = ev.homeScore === ev.awayScore;
        if (tie) {
          hT.record[2]++; aT.record[2]++;
        } else if (ev.homeScore > ev.awayScore) {
          hT.record[0]++; aT.record[1]++;
        } else {
          hT.record[1]++; aT.record[0]++;
        }
        hT.pf += ev.homeScore || 0; hT.pa += ev.awayScore || 0;
        aT.pf += ev.awayScore || 0; aT.pa += ev.homeScore || 0;
        hT.results.push({ week: weekNum, win: ev.homeScore > ev.awayScore, tie, pf: ev.homeScore, pa: ev.awayScore, oppAbbr: ev.away, home: true });
        aT.results.push({ week: weekNum, win: ev.awayScore > ev.homeScore, tie, pf: ev.awayScore, pa: ev.homeScore, oppAbbr: ev.home, home: false });
      }
    }
  }
  return { teams, eventsByWeek, allEvents, latestSeason };
}

/* ─── Pick "current week" = first reg week with any unplayed game, else latest ── */
function pickCurrentWeek(eventsByWeek) {
  const regKeys = Object.keys(eventsByWeek).filter(k => k.startsWith("reg-")).sort();
  const postKeys = Object.keys(eventsByWeek).filter(k => k.startsWith("post-")).sort();

  // Find first reg week that has any non-completed game
  for (const k of regKeys) {
    const evs = eventsByWeek[k];
    if (evs.some(e => !e.completed)) {
      return { key: k, type: "reg", weekNum: parseInt(k.split("-")[1], 10), events: evs };
    }
  }
  // All reg weeks completed → check postseason
  for (const k of postKeys) {
    const evs = eventsByWeek[k];
    if (evs.some(e => !e.completed)) {
      return { key: k, type: "post", weekNum: parseInt(k.split("-")[1], 10), events: evs };
    }
  }
  // Everything done → use the very latest week that has events.
  // Postseason comes AFTER regular season, so put it last in the pop().
  const last = [...regKeys, ...postKeys].pop();
  if (!last) return null;
  return {
    key: last,
    type: last.split("-")[0],
    weekNum: parseInt(last.split("-")[1], 10),
    events: eventsByWeek[last],
  };
}

/* ─── Build the SCHEDULE array (what the UI consumes) ───────────────────── */
function buildSchedule(weekInfo, teams) {
  if (!weekInfo) return [];
  return weekInfo.events.map((ev, i) => {
    const hT = teams[ev.home], aT = teams[ev.away];
    // Simple home-favorite heuristic when no real odds:
    let homeFavorite = (hT.record[0] - aT.record[0]) >= 0;
    let spread = ev.spread;
    if (spread == null) {
      // pseudo-spread from win-pct gap (negative = home favored)
      const gap = (winPct(aT) - winPct(hT));
      spread = Math.round(gap * 14 * 2) / 2; // half-point increments, roughly
      if (spread === 0 && hT.record[0] > aT.record[0]) spread = -1.5;
    }
    return {
      id: ev.id,
      eventId: ev.eventId,
      away: ev.away,
      home: ev.home,
      kickoff: formatKickoff(ev.date),
      network: ev.network,
      slot: deriveSlot(ev.date),
      spread,
      homeMoneyLine: null,
      awayMoneyLine: null,
      homeFavorite: spread < 0,
      // Result fields for completed games (rendered in Schedule view)
      completed: ev.completed,
      homeScore: ev.homeScore,
      awayScore: ev.awayScore,
      winner: ev.completed ? (ev.homeScore > ev.awayScore ? "home" : ev.awayScore > ev.homeScore ? "away" : "tie") : null,
      date: ev.date,
      venue: ev.venue,
      headline: ev.headline,
    };
  });
}

/* ─── Compute team-strength signals from real game results ──────────────── */
function buildTeamStrengths(teams) {
  const out = {};
  // First pass — collect raw signals
  const raw = {};
  for (const abbr of Object.keys(teams)) {
    const t = teams[abbr];
    const games = t.record[0] + t.record[1] + (t.record[2] || 0);
    const wp = winPct(t);
    const pd = (t.pf - t.pa);
    // recent form: last 4 games win pct
    const recent = t.results.slice(-4);
    const recentWp = recent.length ? recent.filter(r => r.win).length / recent.length : 0;
    // win-margin consistency: 1 - normalized stddev of margins for wins
    const margins = t.results.filter(r => r.win).map(r => r.pf - r.pa);
    let consistency = 0.5;
    if (margins.length >= 2) {
      const mean = margins.reduce((a,b)=>a+b,0)/margins.length;
      const variance = margins.reduce((s,m)=>s+(m-mean)*(m-mean),0)/margins.length;
      const sd = Math.sqrt(variance);
      consistency = Math.max(0, Math.min(1, 1 - sd / 28));
    }
    // division record
    const divGames = t.results.filter(r => {
      const opp = teams[r.oppAbbr];
      return opp && opp.div === t.div && opp.conf === t.conf;
    });
    const divWins = divGames.filter(r => r.win).length;
    const divBonus = divGames.length ? divWins / divGames.length : 0.5;
    // strength of schedule: avg opp win pct
    const oppWps = t.results.map(r => winPct(teams[r.oppAbbr] || { record: [0,0,0] }));
    const sos = oppWps.length ? oppWps.reduce((a,b)=>a+b,0) / oppWps.length : 0.5;

    raw[abbr] = { games, wp, pd, recentWp, consistency, divBonus, sos };
  }
  // Second pass — normalize point-diff to [0,1]
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
      pointDiff: +pointDiff.toFixed(2),
      sos: +r.sos.toFixed(2),
      divisionBonus: +r.divBonus.toFixed(2),
      recentForm: +r.recentWp.toFixed(2),
      winMarginConsistency: +r.consistency.toFixed(2),
    };
  }
  return out;
}

/* ─── Compute current week meta ─────────────────────────────────────────── */
function buildWeekMeta(weekInfo, season) {
  if (!weekInfo) return { week: 1, season, label: "Week 1", weeksRemaining: 18, seasonType: "reg" };
  const isReg = weekInfo.type === "reg";
  const label = isReg
    ? `Week ${weekInfo.weekNum}`
    : ({ 1:"Wild Card", 2:"Divisional Round", 3:"Conference Championship", 5:"Super Bowl" }[weekInfo.weekNum] || `Playoff Wk ${weekInfo.weekNum}`);
  return {
    week: weekInfo.weekNum,
    season,
    label,
    seasonType: weekInfo.type,
    weeksRemaining: isReg ? Math.max(0, 18 - weekInfo.weekNum + 1) : 0,
  };
}

/* ─── Dev mode: sim-week (mirrors `pipeline.py --sim-week N`) ──────────── */
function getSimWeek() {
  try {
    const v = localStorage.getItem("w2r4_sim_week");
    const n = v == null ? null : Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 18 ? n : null;
  } catch { return null; }
}
function clearEventResults(ev) {
  const comp = ev.competitions?.[0];
  if (!comp) return ev;
  return {
    ...ev,
    status: { ...(ev.status || {}), type: { ...(ev.status?.type || {}), completed: false, state: "pre", description: "Scheduled" } },
    competitions: [{
      ...comp,
      competitors: (comp.competitors || []).map(c => ({ ...c, winner: false, score: null })),
      status: { ...(comp.status || {}), type: { ...(comp.status?.type || {}), completed: false, state: "pre", description: "Scheduled" } },
    }],
  };
}
function applySimWeek(scoreboards, simWeek) {
  if (!simWeek) return scoreboards;
  return scoreboards.map(sb => {
    if (!sb) return null;
    const seasonType = sb.season?.type === 3 ? "post" : sb.season?.type === 2 ? "reg" : "other";
    const weekNum = sb.week?.number ?? 0;
    if (seasonType !== "reg") return null;
    if (weekNum > simWeek) return null;
    if (weekNum === simWeek) return { ...sb, events: (sb.events || []).map(clearEventResults) };
    return sb;
  });
}

/* ─── Main load orchestrator ────────────────────────────────────────────── */
async function loadAllData() {
  const simWeek = getSimWeek();
  // NFL season: starts Sept, postseason finishes Feb. Use July as boundary.
  const now = new Date();
  const guess = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  // If sim-week is set, prefer 2025 (matches the cached data in the repo).
  const seasonOrder = simWeek ? [2025, guess, guess - 1] : [guess, guess - 1];

  for (const season of seasonOrder) {
    const tries = weeksToTry(season);
    let scoreboards = await Promise.all(tries.map(fetchScoreboard));
    scoreboards = applySimWeek(scoreboards, simWeek);
    const found = scoreboards.filter(Boolean);
    if (found.length === 0) continue;

    const { teams, eventsByWeek, allEvents, latestSeason } = aggregate(scoreboards);
    const weekInfo = pickCurrentWeek(eventsByWeek);
    const schedule = buildSchedule(weekInfo, teams);
    const strengths = buildTeamStrengths(teams);
    const meta = buildWeekMeta(weekInfo, latestSeason || season);

    // Strip private fields from teams
    const cleanTeams = {};
    for (const abbr of Object.keys(teams)) {
      const { _colorFromEspn, results, pf, pa, ...rest } = teams[abbr];
      cleanTeams[abbr] = rest;
    }

    return {
      TEAMS: cleanTeams,
      SCHEDULE: schedule,
      WEEK_META: { ...meta, simWeek },
      TEAM_STRENGTHS: strengths,
      _rawTeamResults: teams,         // kept for richer Schedule view
      _allEvents: allEvents,
      _eventsByWeek: eventsByWeek,
      _sourceUrl: `https://github.com/${GH_OWNER}/${GH_REPO}`,
      _loadedAt: new Date().toISOString(),
      _simWeek: simWeek,
    };
  }
  throw new Error(`No scoreboard data found in github.com/${GH_OWNER}/${GH_REPO} (checked seasons ${seasonOrder.join(", ")}).`);
}

/* ─── Boot: kick off load, expose promise ───────────────────────────────── */
window.W2R4_LOAD_STATUS = { state: "loading", error: null, payload: null };
window.W2R4_LOAD_PROMISE = (async () => {
  try {
    const payload = await loadAllData();
    window.TEAMS         = payload.TEAMS;
    window.SCHEDULE      = payload.SCHEDULE;
    window.WEEK_META     = payload.WEEK_META;
    window.TEAM_STRENGTHS= payload.TEAM_STRENGTHS;
    window.TIEBREAKER_REASONS = {};  // optional; the prototype handles absence
    // Build division index
    window.TEAMS_BY_DIVISION = (() => {
      const out = {};
      for (const t of Object.values(window.TEAMS)) {
        const key = `${t.conf} ${t.div}`;
        (out[key] = out[key] || []).push(t.abbr);
      }
      return out;
    })();
    window.W2R4_SOURCE = { url: payload._sourceUrl, loadedAt: payload._loadedAt };
    window.W2R4_LOAD_STATUS = { state: "ready", error: null, payload };
    return payload;
  } catch (e) {
    console.error("[Who2Root4] data load failed:", e);
    window.W2R4_LOAD_STATUS = { state: "error", error: e, payload: null };
    throw e;
  }
})();

/* ─────────────────────────────────────────────────────────────────────────
 * COMPUTE FUNCTIONS — unchanged from the original pipeline mirror.
 * These all read window.TEAMS / window.SCHEDULE / window.WEEK_META at call time,
 * so they automatically pick up real data once W2R4_LOAD_PROMISE resolves.
 * ─────────────────────────────────────────────────────────────────────── */

/* ─── Standings ─────────────────────────────────────────────────────────── */
window.computeStandings = function () {
  const teams = Object.values(window.TEAMS || {});
  const sortByPct = (a, b) => winPct(b) - winPct(a) || b.record[0] - a.record[0];
  const out = { AFC: [], NFC: [], byTeam: {}, divisions: {} };

  for (const conf of ["AFC", "NFC"]) {
    const divs = {};
    for (const t of teams.filter(t => t.conf === conf)) (divs[t.div] = divs[t.div] || []).push(t);
    for (const d of Object.keys(divs)) divs[d].sort(sortByPct);
    out.divisions[conf] = divs;

    const order = ["East", "North", "South", "West"].filter(d => divs[d]);
    const winners = order.map(d => divs[d][0]).filter(Boolean).sort(sortByPct);
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
      out.byTeam[rest[i].abbr] = { seed: null, kind: "out", conf, gamesBehind: rest[i].record[1] - (rest[2]?.record[1] ?? rest[i].record[1]) };
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
const weeksRemaining = () => window.WEEK_META?.weeksRemaining ?? 0;
function inDivisionContention(team) { return gamesBack(team) <= weeksRemaining(); }
function maxWins(team) { return team.record[0] + weeksRemaining(); }

/* ─── Available modes ──────────────────────────────────────────────────── */
window.availableModes = function (favAbbr) {
  const fav = window.TEAMS[favAbbr];
  if (!fav) return ["overall", "tank"];
  const all = ["overall"];
  const divPeers = Object.values(window.TEAMS).filter(t => t.conf === fav.conf && t.div === fav.div && t.abbr !== favAbbr);
  if (divPeers.every(p => p.record[0] <= maxWins(fav))) all.push("division");
  const confNonDiv = Object.values(window.TEAMS).filter(
    t => t.conf === fav.conf && t.div !== fav.div && t.abbr !== favAbbr
  );
  if (confNonDiv.filter(t => t.record[0] > maxWins(fav)).length < 3) all.push("wildcard");
  const confPeers = Object.values(window.TEAMS).filter(t => t.conf === fav.conf && t.abbr !== favAbbr);
  if (confPeers.every(p => p.record[0] <= maxWins(fav))) all.push("conf_one_seed");
  all.push("tank");
  return all;
};

/* ─── Your Team's Game (current week) ───────────────────────────────────── */
window.favTeamGame = function (favAbbr, mode = "overall") {
  // Prefer the next UPCOMING game involving the favorite team.
  // If none is upcoming, fall back to the most-recently completed one so the
  // UI can show a Final card instead of pretending the past is the future.
  const ours = (window.SCHEDULE || []).filter(g => g.home === favAbbr || g.away === favAbbr);
  if (!ours.length) return null;
  const upcoming = ours.find(g => !g.completed);
  const g = upcoming || ours[ours.length - 1];
  const fav = window.TEAMS[favAbbr];
  const oppAbbr = g.home === favAbbr ? g.away : g.home;
  const opp = window.TEAMS[oppAbbr];
  const isHome = g.home === favAbbr;

  // Completed game → return result-shape; UI renders a Final variant.
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
    return {
      ...g, fav: favAbbr, opp: oppAbbr, isHome, blurb,
      underdog: null,
      completed: true,
      favScore, oppScore, won, tied,
    };
  }

  const fGB = gamesBack(fav);
  const wr = weeksRemaining();
  const isDivRival = opp.div === fav.div && opp.conf === fav.conf;
  const isPlayoffElim = false;

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

  let underdog = null;
  if (g.spread != null) underdog = g.spread < 0 ? g.away : (g.spread > 0 ? g.home : null);
  else if (g.homeFavorite != null) underdog = g.homeFavorite ? g.away : g.home;

  return { ...g, fav: favAbbr, opp: oppAbbr, isHome, blurb, underdog, completed: false };
};

/* ─── Underdog resolver ─────────────────────────────────────────────────── */
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
  const fav = window.TEAMS?.[favAbbr];
  if (!fav) return [];
  dislikes = (dislikes || []).map(d => d.toUpperCase());
  const futureFavOpponents = new Set(
    (window.SCHEDULE || []).filter(g => g.home === favAbbr || g.away === favAbbr).map(g => g.home === favAbbr ? g.away : g.home)
  );

  const recs = [];
  for (const g of (window.SCHEDULE || [])) {
    if (g.home === favAbbr || g.away === favAbbr) continue;
    if (g.completed) continue; // skip already-played games

    if (mode === "tank") {
      const r = scoreGameTank(g.home, g.away, fav);
      if (r) recs.push({
        gameId: g.id, ...r, kickoff: g.kickoff, network: g.network, slot: g.slot,
        spread: g.spread, underdog: resolveUnderdog(g),
        reasoning: r.reasonsAll[0],
      });
      continue;
    }

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

/* ─── Scenarios ─────────────────────────────────────────────────────────── */
window.computeScenarios = function (favAbbr) {
  const fav = window.TEAMS?.[favAbbr];
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
  if (!topDivRival) return [];
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

  if (favLosses >= 6 && confRivals.length) {
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

  if ([1, 2, 3].includes(seed.seed) && confRivals.length) {
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
