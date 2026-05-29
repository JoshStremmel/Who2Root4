/**
 * data.js — ESPN data loader for the Who2Root4 main app.
 *
 * This module fetches ESPN scoreboard JSON from GitHub, parses it into the
 * shared TeamData / ScheduleGame shapes, and populates window.* globals that
 * the JSX components consume.
 *
 * ALL calculations (standings, recommendations, scenarios, tiebreakers,
 * strengths, modes) live exclusively in src/root4.js (ROOT4) and are imported
 * here. When you change root4.js, every part of the site updates automatically.
 */

import {
  DIVISIONS, ABBR_ALIAS, normAbbr, TEAM_COLOR_FALLBACK,
  MODES, CATEGORY_META, STRENGTH_WEIGHT, STRENGTH_META,
  winPct, buildTeamStrengths, computeTiebreakerReasons,
  computeStandings, availableModes, favTeamGame, ownGameImpact,
  computeRecommendations, computeScenarios,
} from "./root4.js";

/* ─── Repo config ───────────────────────────────────────────────────────── */
const GH_OWNER  = "JoshStremmel";
const GH_REPO   = "Who2Root4";
const GH_BRANCH = "main";
const RAW_BASE  = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}`;

/* ─── Expose engine constants for JSX components ────────────────────────── */
window.MODES         = MODES;
window.CATEGORY_META = CATEGORY_META;
window.STRENGTH_META = STRENGTH_META;
window.STRENGTH_WEIGHT = STRENGTH_WEIGHT;

/* ─── Date / week formatting ────────────────────────────────────────────── */
const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function formatKickoff(iso) {
  if (!iso) return "TBD";
  const d = new Date(iso);
  const day = DAYS[d.getUTCDay()];
  const opts = { weekday:"short", hour:"numeric", minute:"2-digit", hour12:true };
  try {
    return d.toLocaleString("en-US", opts) + " " +
      (new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
        .formatToParts(d).find(p => p.type === "timeZoneName")?.value || "");
  } catch {
    return `${day} ${d.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" })}`;
  }
}
function deriveSlot(iso) {
  if (!iso) return "TBD";
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23",
  }).formatToParts(d);
  const dow  = parts.find(p => p.type === "weekday")?.value ?? "";
  const hour = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
  if (dow === "Thu") return "TNF";
  if (dow === "Mon") return "MNF";
  if (dow === "Fri") return "Fri";
  if (dow === "Sat") return "Sat";
  if (dow === "Sun") {
    if (hour >= 19) return "SNF";
    if (hour >= 16) return "Late";
    return "Early";
  }
  return "Reg";
}

/* ─── GitHub fetch ──────────────────────────────────────────────────────── */
function weeksToTry(season) {
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

/* ─── Parse one ESPN scoreboard event ──────────────────────────────────── */
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
  const odds = comp.odds?.[0];
  const spread = (odds && typeof odds.spread === "number") ? odds.spread : null;
  const broadcast = comp.broadcasts?.[0]?.names?.[0] || comp.broadcast || "TBD";

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

/* ─── Aggregate season data ─────────────────────────────────────────────── */
function aggregate(scoreboards) {
  const teams = {};
  const eventsByWeek = {};
  const allEvents = [];
  let latestSeason = null;

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
    const seasonType = sb.season?.type === 3 ? "post" : sb.season?.type === 2 ? "reg" : "other";
    const weekNum = sb.week?.number ?? 0;

    const events = (sb.events || []).map(ev => parseEvent(ev, weekNum, seasonType)).filter(Boolean);
    const key = `${seasonType}-${String(weekNum).padStart(2, "0")}`;
    (eventsByWeek[key] = eventsByWeek[key] || []).push(...events);

    for (const ev of events) {
      allEvents.push(ev);
      for (const side of ["home", "away"]) {
        const abbr = ev[side];
        const t = ev[side === "home" ? "homeTeam" : "awayTeam"];
        if (teams[abbr] && t) {
          if (!teams[abbr].city) teams[abbr].city = t.location || teams[abbr].city;
          if (!teams[abbr].name) teams[abbr].name = t.name || teams[abbr].name;
          if (!teams[abbr].logo) teams[abbr].logo = t.logo || null;
        }
      }

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

/* ─── Pick current week ─────────────────────────────────────────────────── */
function pickCurrentWeek(eventsByWeek) {
  const regKeys  = Object.keys(eventsByWeek).filter(k => k.startsWith("reg-")).sort();
  const postKeys = Object.keys(eventsByWeek).filter(k => k.startsWith("post-")).sort();
  for (const k of regKeys) {
    if (eventsByWeek[k].some(e => !e.completed)) return { key: k, type: "reg", weekNum: parseInt(k.split("-")[1], 10), events: eventsByWeek[k] };
  }
  for (const k of postKeys) {
    if (eventsByWeek[k].some(e => !e.completed)) return { key: k, type: "post", weekNum: parseInt(k.split("-")[1], 10), events: eventsByWeek[k] };
  }
  const last = [...regKeys, ...postKeys].pop();
  if (!last) return null;
  return { key: last, type: last.split("-")[0], weekNum: parseInt(last.split("-")[1], 10), events: eventsByWeek[last] };
}

/* ─── Build schedule array ──────────────────────────────────────────────── */
function buildSchedule(weekInfo, teams) {
  if (!weekInfo) return [];
  return weekInfo.events.map(ev => {
    const hT = teams[ev.home], aT = teams[ev.away];
    let spread = ev.spread;
    if (spread == null) {
      const gap = (winPct(aT) - winPct(hT));
      spread = Math.round(gap * 14 * 2) / 2;
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

/* ─── Build week meta ───────────────────────────────────────────────────── */
function buildWeekMeta(weekInfo, season) {
  if (!weekInfo) return { week: 1, season, label: "Week 1", weeksRemaining: 18, seasonType: "reg" };
  const isReg = weekInfo.type === "reg";
  const label = isReg
    ? `Week ${weekInfo.weekNum}`
    : ({ 1:"Wild Card", 2:"Divisional Round", 3:"Conference Championship", 5:"Super Bowl" }[weekInfo.weekNum] || `Playoff Wk ${weekInfo.weekNum}`);
  return { week: weekInfo.weekNum, season, label, seasonType: weekInfo.type, weeksRemaining: isReg ? Math.max(0, 18 - weekInfo.weekNum + 1) : 0 };
}

/* ─── Sim-week support (dev mode) ───────────────────────────────────────── */
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
  const now = new Date();
  const guess = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
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

    const cleanTeams = {};
    for (const abbr of Object.keys(teams)) {
      const { homeTeam, awayTeam, ...rest } = teams[abbr];
      cleanTeams[abbr] = rest;
    }

    return {
      TEAMS: cleanTeams,
      SCHEDULE: schedule,
      WEEK_META: { ...meta, simWeek },
      TEAM_STRENGTHS: strengths,
      _rawTeamResults: teams,
      _allEvents: allEvents,
      _eventsByWeek: eventsByWeek,
      _sourceUrl: `https://github.com/${GH_OWNER}/${GH_REPO}`,
      _loadedAt: new Date().toISOString(),
      _simWeek: simWeek,
    };
  }
  throw new Error(`No scoreboard data found in github.com/${GH_OWNER}/${GH_REPO} (checked seasons ${seasonOrder.join(", ")}).`);
}

/* ─── Boot: load data, populate window.* globals ───────────────────────── */
window.W2R4_LOAD_STATUS = { state: "loading", error: null, payload: null };
window.W2R4_LOAD_PROMISE = (async () => {
  try {
    const payload = await loadAllData();
    window.TEAMS          = payload.TEAMS;
    window.SCHEDULE       = payload.SCHEDULE;
    window.WEEK_META      = payload.WEEK_META;
    window.TEAM_STRENGTHS = payload.TEAM_STRENGTHS;
    window.TIEBREAKER_REASONS = computeTiebreakerReasons(payload._rawTeamResults);
    window._rawTeamResults    = payload._rawTeamResults;
    window.TEAMS_BY_DIVISION  = (() => {
      const out = {};
      for (const t of Object.values(window.TEAMS)) {
        const key = `${t.conf} ${t.div}`;
        (out[key] = out[key] || []).push(t.abbr);
      }
      return out;
    })();
    window.W2R4_SOURCE    = { url: payload._sourceUrl, loadedAt: payload._loadedAt };
    window.W2R4_LOAD_STATUS = { state: "ready", error: null, payload };
    return payload;
  } catch (e) {
    console.error("[Who2Root4] data load failed:", e);
    window.W2R4_LOAD_STATUS = { state: "error", error: e, payload: null };
    throw e;
  }
})();

/* ─── Engine function wrappers for JSX components ───────────────────────── */
// These thin wrappers supply the window.* data to the pure engine functions.
// JSX components call e.g. window.computeStandings() — the engine does the math.

window.computeStandings = () =>
  computeStandings(window.TEAMS, window.TIEBREAKER_REASONS);

window.availableModes = (favAbbr) =>
  availableModes(favAbbr, window.TEAMS, window.WEEK_META);

window.favTeamGame = (favAbbr, mode) =>
  favTeamGame(favAbbr, mode, window.TEAMS, window.SCHEDULE, window.WEEK_META);

window.ownGameImpact = (favAbbr, mode) =>
  ownGameImpact(favAbbr, mode, window.TEAMS, window.WEEK_META);

window.computeRecommendations = (favAbbr, dislikes, mode) =>
  computeRecommendations(favAbbr, dislikes, mode, window.TEAMS, window.SCHEDULE, window.TEAM_STRENGTHS, window.WEEK_META);

window.computeScenarios = (favAbbr) =>
  computeScenarios(favAbbr, window.TEAMS, window.SCHEDULE, window.WEEK_META);
