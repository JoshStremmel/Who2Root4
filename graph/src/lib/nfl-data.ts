/**
 * NFL data loading — TypeScript port of src/data.js.
 *
 * Fetches ESPN scoreboard cache files from raw.githubusercontent.com
 * and aggregates them into team records / weekly schedules. All functions
 * are pure (no window.* globals) so they compose cleanly with the graph
 * build pipeline.
 */

// ── Repo config ───────────────────────────────────────────────────────────────

const GH_OWNER  = "JoshStremmel";
const GH_REPO   = "Who2Root4";
const GH_BRANCH = "main";
const RAW_BASE  = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}`;

// ── Static metadata ───────────────────────────────────────────────────────────

export const DIVISIONS: Record<string, [string, string]> = {
  BUF:["AFC","East"],  MIA:["AFC","East"],  NE:["AFC","East"],   NYJ:["AFC","East"],
  BAL:["AFC","North"], CIN:["AFC","North"], CLE:["AFC","North"], PIT:["AFC","North"],
  HOU:["AFC","South"], IND:["AFC","South"], JAX:["AFC","South"], TEN:["AFC","South"],
  DEN:["AFC","West"],  KC: ["AFC","West"],  LV: ["AFC","West"],  LAC:["AFC","West"],
  DAL:["NFC","East"],  NYG:["NFC","East"],  PHI:["NFC","East"],  WAS:["NFC","East"],
  CHI:["NFC","North"], DET:["NFC","North"], GB: ["NFC","North"], MIN:["NFC","North"],
  ATL:["NFC","South"], CAR:["NFC","South"], NO: ["NFC","South"], TB: ["NFC","South"],
  ARI:["NFC","West"],  LAR:["NFC","West"],  SF: ["NFC","West"],  SEA:["NFC","West"],
};

const ABBR_ALIAS: Record<string, string> = { WSH: "WAS", JAC: "JAX" };
export const normAbbr = (a: string): string => ABBR_ALIAS[a] ?? a;

export const TEAM_COLOR_FALLBACK: Record<string, string> = {
  PIT:"#ffb612", BAL:"#241773", CIN:"#fb4f14", CLE:"#311d00",
  BUF:"#00338d", MIA:"#008e97", NYJ:"#125740", NE:"#002a5c",
  HOU:"#03202f", IND:"#002c5f", JAX:"#006778", TEN:"#19c6ff",
  KC:"#e31837",  LAC:"#0080c6", DEN:"#fb4f14", LV:"#000000",
  DET:"#0076b6", GB:"#203731",  MIN:"#4f2683", CHI:"#0b162a",
  PHI:"#004c54", DAL:"#003594", WAS:"#5a1414", NYG:"#0b2265",
  TB:"#d50a0a",  ATL:"#a71930", NO:"#d3bc8d",  CAR:"#0085ca",
  SF:"#aa0000",  LAR:"#003594", SEA:"#002244", ARI:"#97233f",
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GameResult {
  week: number;
  win: boolean;
  tie: boolean;
  pf: number;
  pa: number;
  oppAbbr: string;
  home: boolean;
}

export interface TeamData {
  abbr: string;
  conf: string;
  div: string;
  city: string;
  name: string;
  color: string;
  logo: string | null;
  record: [number, number, number]; // [W, L, T]
  pf: number;
  pa: number;
  results: GameResult[];
}

export interface ParsedEvent {
  id: string;
  eventId: string;
  home: string;
  away: string;
  homeTeamBlob: { location?: string; name?: string; logo?: string } | null;
  awayTeamBlob: { location?: string; name?: string; logo?: string } | null;
  date: string | undefined;
  weekNum: number;
  seasonType: string;
  completed: boolean;
  homeScore: number | null;
  awayScore: number | null;
  homeWinner: boolean;
  spread: number | null;
  venue: string | undefined;
  headline: string | undefined;
  network: string;
}

export interface ScheduleGame {
  id: string;
  eventId: string;
  away: string;
  home: string;
  kickoff: string;
  network: string;
  slot: string;
  spread: number | null;
  homeMoneyLine: null;
  awayMoneyLine: null;
  homeFavorite: boolean;
  completed: boolean;
  homeScore: number | null;
  awayScore: number | null;
  winner: "home" | "away" | "tie" | null;
  date: string | undefined;
  venue: string | undefined;
  headline: string | undefined;
}

export interface WeekInfo {
  key: string;
  type: string;
  weekNum: number;
  events: ParsedEvent[];
}

export interface WeekMeta {
  week: number;
  season: number;
  label: string;
  seasonType: string;
  weeksRemaining: number;
}

export interface TeamStrength {
  strengthScore: number;
  pointDiff: number;
  sos: number;
  divisionBonus: number;
  recentForm: number;
  winMarginConsistency: number;
}

export interface AggregatedData {
  teams: Record<string, TeamData>;
  eventsByWeek: Record<string, ParsedEvent[]>;
  allEvents: ParsedEvent[];
  latestSeason: number | null;
}

export interface LoadedData {
  teams: Record<string, TeamData>;
  schedule: ScheduleGame[];
  weekMeta: WeekMeta;
  teamStrengths: Record<string, TeamStrength>;
  eventsByWeek: Record<string, ParsedEvent[]>;
  season: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function winPct(t: Pick<TeamData, "record">): number {
  const [w, l, ties = 0] = t.record;
  const games = w + l + ties;
  return games === 0 ? 0 : (w + 0.5 * ties) / games;
}

const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function formatKickoff(iso: string | undefined): string {
  if (!iso) return "TBD";
  const d = new Date(iso);
  const day = DAYS[d.getUTCDay()];
  try {
    return d.toLocaleString("en-US", { weekday:"short", hour:"numeric", minute:"2-digit", hour12:true });
  } catch {
    return `${day} ${d.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" })}`;
  }
}

function deriveSlot(iso: string | undefined): string {
  if (!iso) return "TBD";
  const d = new Date(iso);
  const dow = d.getUTCDay();
  const hourEt = (d.getUTCHours() + 24 - 4) % 24;
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

// ── Fetch helpers ─────────────────────────────────────────────────────────────

function weeksToTry(season: number): { season: number; type: string; week: number }[] {
  const out = [];
  for (let w = 1; w <= 18; w++) out.push({ season, type: "reg",  week: w });
  for (let w = 1; w <= 5;  w++) out.push({ season, type: "post", week: w });
  return out;
}

async function fetchScoreboard(entry: { season: number; type: string; week: number }): Promise<unknown> {
  const ww = String(entry.week).padStart(2, "0");
  const url = `${RAW_BASE}/.cache/espn/scoreboard_${entry.season}_${entry.type}_w${ww}.json`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ── Parse one event ───────────────────────────────────────────────────────────

function parseEvent(ev: Record<string, unknown>, weekNum: number, seasonType: string): ParsedEvent | null {
  const comp = (ev.competitions as Record<string, unknown>[])?.[0];
  if (!comp) return null;
  const competitors = (comp.competitors as Record<string, unknown>[]) || [];
  const home = competitors.find(c => c.homeAway === "home");
  const away = competitors.find(c => c.homeAway === "away");
  if (!home || !away) return null;

  const hAbbr = normAbbr(((home.team as Record<string, unknown>)?.abbreviation as string) ?? "");
  const aAbbr = normAbbr(((away.team as Record<string, unknown>)?.abbreviation as string) ?? "");
  if (!hAbbr || !aAbbr) return null;

  const status = (comp.status as Record<string, unknown>)?.type as Record<string, unknown> ??
    (ev.status as Record<string, unknown>)?.type as Record<string, unknown> ?? {};
  const completed = !!(status.completed);
  const hScore = home.score != null ? Number(home.score) : null;
  const aScore = away.score != null ? Number(away.score) : null;

  const odds = (comp.odds as Record<string, unknown>[])?.[0];
  const spread = (odds && typeof odds.spread === "number") ? odds.spread : null;

  const broadcast =
    ((comp.broadcasts as Record<string, unknown>[])?.[0]?.names as string[])?.[0] ||
    comp.broadcast as string ||
    "TBD";

  return {
    id: `g_${ev.id as string}`,
    eventId: ev.id as string,
    home: hAbbr,
    away: aAbbr,
    homeTeamBlob: (home.team as { location?: string; name?: string; logo?: string }) ?? null,
    awayTeamBlob: (away.team as { location?: string; name?: string; logo?: string }) ?? null,
    date: (comp.date ?? ev.date) as string | undefined,
    weekNum,
    seasonType,
    completed,
    homeScore: hScore,
    awayScore: aScore,
    homeWinner: !!(home.winner),
    spread,
    venue: ((comp.venue as Record<string, unknown>)?.fullName as string | undefined),
    headline: ((comp.headlines as Record<string, unknown>[])?.[0]?.shortLinkText as string | undefined) ??
              ((comp.headlines as Record<string, unknown>[])?.[0]?.description as string | undefined),
    network: broadcast,
  };
}

// ── Aggregate season data ─────────────────────────────────────────────────────

export function aggregate(scoreboards: unknown[]): AggregatedData {
  const teams: Record<string, TeamData> = {};
  const eventsByWeek: Record<string, ParsedEvent[]> = {};
  const allEvents: ParsedEvent[] = [];
  let latestSeason: number | null = null;

  for (const abbr of Object.keys(DIVISIONS)) {
    const [conf, div] = DIVISIONS[abbr];
    teams[abbr] = {
      abbr, conf, div, city: "", name: "",
      color: TEAM_COLOR_FALLBACK[abbr] ?? "#999999",
      logo: null, record: [0,0,0], pf: 0, pa: 0, results: [],
    };
  }

  for (const sb of scoreboards) {
    if (!sb) continue;
    const raw = sb as Record<string, unknown>;
    latestSeason = (raw.season as Record<string, unknown>)?.year as number ?? latestSeason;
    const seasonType =
      (raw.season as Record<string, unknown>)?.type === 3 ? "post" :
      (raw.season as Record<string, unknown>)?.type === 2 ? "reg"  : "other";
    const weekNum = ((raw.week as Record<string, unknown>)?.number as number) ?? 0;

    const events = ((raw.events as unknown[]) || [])
      .map(ev => parseEvent(ev as Record<string, unknown>, weekNum, seasonType))
      .filter((e): e is ParsedEvent => e !== null);

    const key = `${seasonType}-${String(weekNum).padStart(2,"0")}`;
    (eventsByWeek[key] = eventsByWeek[key] ?? []).push(...events);

    for (const ev of events) {
      allEvents.push(ev);
      for (const side of ["home","away"] as const) {
        const abbr = ev[side];
        const t = side === "home" ? ev.homeTeamBlob : ev.awayTeamBlob;
        if (teams[abbr] && t) {
          if (!teams[abbr].city)  teams[abbr].city  = t.location ?? "";
          if (!teams[abbr].name)  teams[abbr].name  = t.name ?? "";
          if (!teams[abbr].logo)  teams[abbr].logo  = t.logo ?? null;
        }
      }

      if (ev.completed && seasonType === "reg") {
        const hT = teams[ev.home], aT = teams[ev.away];
        if (!hT || !aT) continue;
        const tie = ev.homeScore === ev.awayScore;
        if (tie) {
          hT.record[2]++; aT.record[2]++;
        } else if ((ev.homeScore ?? 0) > (ev.awayScore ?? 0)) {
          hT.record[0]++; aT.record[1]++;
        } else {
          hT.record[1]++; aT.record[0]++;
        }
        hT.pf += ev.homeScore ?? 0; hT.pa += ev.awayScore ?? 0;
        aT.pf += ev.awayScore ?? 0; aT.pa += ev.homeScore ?? 0;
        hT.results.push({ week: weekNum, win: (ev.homeScore??0)>(ev.awayScore??0), tie, pf: ev.homeScore??0, pa: ev.awayScore??0, oppAbbr: ev.away, home: true });
        aT.results.push({ week: weekNum, win: (ev.awayScore??0)>(ev.homeScore??0), tie, pf: ev.awayScore??0, pa: ev.homeScore??0, oppAbbr: ev.home, home: false });
      }
    }
  }
  return { teams, eventsByWeek, allEvents, latestSeason };
}

// ── Pick current week ─────────────────────────────────────────────────────────

export function pickCurrentWeek(eventsByWeek: Record<string, ParsedEvent[]>): WeekInfo | null {
  const regKeys  = Object.keys(eventsByWeek).filter(k => k.startsWith("reg-")).sort();
  const postKeys = Object.keys(eventsByWeek).filter(k => k.startsWith("post-")).sort();

  for (const k of regKeys) {
    const evs = eventsByWeek[k];
    if (evs.some(e => !e.completed)) {
      return { key: k, type: "reg", weekNum: parseInt(k.split("-")[1], 10), events: evs };
    }
  }
  for (const k of postKeys) {
    const evs = eventsByWeek[k];
    if (evs.some(e => !e.completed)) {
      return { key: k, type: "post", weekNum: parseInt(k.split("-")[1], 10), events: evs };
    }
  }
  const last = [...regKeys, ...postKeys].pop();
  if (!last) return null;
  return {
    key: last,
    type: last.split("-")[0],
    weekNum: parseInt(last.split("-")[1], 10),
    events: eventsByWeek[last],
  };
}

// ── Build schedule ────────────────────────────────────────────────────────────

export function buildSchedule(weekInfo: WeekInfo | null, teams: Record<string, TeamData>): ScheduleGame[] {
  if (!weekInfo) return [];
  return weekInfo.events.map(ev => {
    const hT = teams[ev.home], aT = teams[ev.away];
    let spread = ev.spread;
    if (spread == null) {
      const gap = (winPct(aT ?? { record: [0,0,0] }) - winPct(hT ?? { record: [0,0,0] }));
      spread = Math.round(gap * 14 * 2) / 2;
      if (spread === 0 && (hT?.record[0] ?? 0) > (aT?.record[0] ?? 0)) spread = -1.5;
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
      winner: ev.completed
        ? ((ev.homeScore??0) > (ev.awayScore??0) ? "home" : (ev.awayScore??0) > (ev.homeScore??0) ? "away" : "tie")
        : null,
      date: ev.date,
      venue: ev.venue,
      headline: ev.headline,
    };
  });
}

// ── Build team strengths ──────────────────────────────────────────────────────

export function buildTeamStrengths(teams: Record<string, TeamData>): Record<string, TeamStrength> {
  const out: Record<string, TeamStrength> = {};
  const raw: Record<string, { games: number; wp: number; pd: number; recentWp: number; consistency: number; divBonus: number; sos: number }> = {};

  for (const abbr of Object.keys(teams)) {
    const t = teams[abbr];
    const wp = winPct(t);
    const pd = t.pf - t.pa;
    const recent = t.results.slice(-4);
    const recentWp = recent.length ? recent.filter(r => r.win).length / recent.length : 0;
    const margins = t.results.filter(r => r.win).map(r => r.pf - r.pa);
    let consistency = 0.5;
    if (margins.length >= 2) {
      const mean = margins.reduce((a,b)=>a+b,0)/margins.length;
      const variance = margins.reduce((s,m)=>s+(m-mean)*(m-mean),0)/margins.length;
      consistency = Math.max(0, Math.min(1, 1 - Math.sqrt(variance) / 28));
    }
    const divGames = t.results.filter(r => teams[r.oppAbbr]?.div === t.div && teams[r.oppAbbr]?.conf === t.conf);
    const divBonus = divGames.length ? divGames.filter(r => r.win).length / divGames.length : 0.5;
    const oppWps = t.results.map(r => winPct(teams[r.oppAbbr] ?? { record: [0,0,0] }));
    const sos = oppWps.length ? oppWps.reduce((a,b)=>a+b,0)/oppWps.length : 0.5;
    raw[abbr] = { games: t.record[0]+t.record[1]+t.record[2], wp, pd, recentWp, consistency, divBonus, sos };
  }

  const pds = Object.values(raw).map(r => r.pd);
  const minPd = Math.min(...pds, 0), maxPd = Math.max(...pds, 0);
  const range = (maxPd - minPd) || 1;

  for (const abbr of Object.keys(raw)) {
    const r = raw[abbr];
    const pointDiff = (r.pd - minPd) / range;
    const strengthScore = Math.max(0, Math.min(1,
      0.35*r.wp + 0.25*pointDiff + 0.15*r.recentWp + 0.10*r.consistency + 0.10*r.divBonus + 0.05*r.sos
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

// ── Build week meta ───────────────────────────────────────────────────────────

export function buildWeekMeta(weekInfo: WeekInfo | null, season: number): WeekMeta {
  if (!weekInfo) return { week: 1, season, label: "Week 1", weeksRemaining: 18, seasonType: "reg" };
  const isReg = weekInfo.type === "reg";
  const label = isReg
    ? `Week ${weekInfo.weekNum}`
    : ({ 1:"Wild Card", 2:"Divisional Round", 3:"Conference Championship", 5:"Super Bowl" }[weekInfo.weekNum] ?? `Playoff Wk ${weekInfo.weekNum}`);
  return {
    week: weekInfo.weekNum,
    season,
    label,
    seasonType: weekInfo.type,
    weeksRemaining: isReg ? Math.max(0, 18 - weekInfo.weekNum + 1) : 0,
  };
}

// ── Build LoadedData for a specific week from cached AggregatedData ───────────

export function buildLoadedData(aggData: AggregatedData, weekNum?: number): LoadedData {
  const season = aggData.latestSeason ?? new Date().getFullYear();
  let weekInfo: WeekInfo | null;

  if (weekNum != null) {
    const key = `reg-${String(weekNum).padStart(2, "0")}`;
    const events = aggData.eventsByWeek[key];
    weekInfo = events ? { key, type: "reg", weekNum, events } : pickCurrentWeek(aggData.eventsByWeek);
  } else {
    weekInfo = pickCurrentWeek(aggData.eventsByWeek);
  }

  return {
    teams: aggData.teams,
    schedule: buildSchedule(weekInfo, aggData.teams),
    weekMeta: buildWeekMeta(weekInfo, season),
    teamStrengths: buildTeamStrengths(aggData.teams),
    eventsByWeek: aggData.eventsByWeek,
    season,
  };
}

// ── Main loader ───────────────────────────────────────────────────────────────

export async function loadSeasonData(): Promise<AggregatedData> {
  const now = new Date();
  const guess = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const seasonOrder = [guess, guess - 1];

  for (const season of seasonOrder) {
    const tries = weeksToTry(season);
    const scoreboards = await Promise.all(tries.map(fetchScoreboard));
    if (!scoreboards.some(Boolean)) continue;
    return aggregate(scoreboards);
  }

  throw new Error(
    `No scoreboard data found in github.com/${GH_OWNER}/${GH_REPO} ` +
    `(checked seasons ${seasonOrder.join(", ")}).`
  );
}
