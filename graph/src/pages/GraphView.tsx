/**
 * GraphView: page component for the Who2Root4 playoff picture graph.
 *
 * Responsibilities:
 *   - Team and week selectors
 *   - Fetches ESPN cache files from raw.githubusercontent.com → aggregates
 *     → computes standings + recommendations → builds UGM client-side
 *   - Loading / error / empty states
 *   - Preseason banner
 *   - Renders PlayoffGraph with the loaded data
 *
 * No backend required — all computation happens in the browser using the
 * same ESPN cache files that power the main site's data.js.
 */

import { useState, useEffect, useMemo } from "react";
import { PlayoffGraph } from "../components/PlayoffGraph";
import type { GraphData } from "../types";
import type { UGM } from "@g3t/core";
import type { AggregatedData } from "../lib/nfl-data";
import { loadSeasonData, buildLoadedData } from "../lib/nfl-data";
import { buildGraphData } from "../lib/ugm-builder";

// ── Team list (alphabetical, with display name) ───────────────────────────────

const ALL_TEAMS: { abbr: string; name: string }[] = [
  { abbr: "ARI", name: "Arizona Cardinals" },
  { abbr: "ATL", name: "Atlanta Falcons" },
  { abbr: "BAL", name: "Baltimore Ravens" },
  { abbr: "BUF", name: "Buffalo Bills" },
  { abbr: "CAR", name: "Carolina Panthers" },
  { abbr: "CHI", name: "Chicago Bears" },
  { abbr: "CIN", name: "Cincinnati Bengals" },
  { abbr: "CLE", name: "Cleveland Browns" },
  { abbr: "DAL", name: "Dallas Cowboys" },
  { abbr: "DEN", name: "Denver Broncos" },
  { abbr: "DET", name: "Detroit Lions" },
  { abbr: "GB",  name: "Green Bay Packers" },
  { abbr: "HOU", name: "Houston Texans" },
  { abbr: "IND", name: "Indianapolis Colts" },
  { abbr: "JAX", name: "Jacksonville Jaguars" },
  { abbr: "KC",  name: "Kansas City Chiefs" },
  { abbr: "LAC", name: "LA Chargers" },
  { abbr: "LAR", name: "LA Rams" },
  { abbr: "LV",  name: "Las Vegas Raiders" },
  { abbr: "MIA", name: "Miami Dolphins" },
  { abbr: "MIN", name: "Minnesota Vikings" },
  { abbr: "NE",  name: "New England Patriots" },
  { abbr: "NO",  name: "New Orleans Saints" },
  { abbr: "NYG", name: "NY Giants" },
  { abbr: "NYJ", name: "NY Jets" },
  { abbr: "PHI", name: "Philadelphia Eagles" },
  { abbr: "PIT", name: "Pittsburgh Steelers" },
  { abbr: "SEA", name: "Seattle Seahawks" },
  { abbr: "SF",  name: "San Francisco 49ers" },
  { abbr: "TB",  name: "Tampa Bay Buccaneers" },
  { abbr: "TEN", name: "Tennessee Titans" },
  { abbr: "WAS", name: "Washington Commanders" },
];

const WEEKS = Array.from({ length: 18 }, (_, i) => i + 1);

// ── Helpers ───────────────────────────────────────────────────────────────────

function getInitialTeam(): string {
  try {
    const prefs = JSON.parse(localStorage.getItem("w2r4_team_prefs_v1") ?? "{}");
    return prefs.favTeam ?? "CIN";
  } catch {
    return "CIN";
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

type SeasonLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready" };

export function GraphView() {
  const [team, setTeam] = useState(getInitialTeam);
  const [week, setWeek] = useState<number | null>(null); // null = current week

  const [seasonLoad, setSeasonLoad] = useState<SeasonLoad>({ status: "idle" });
  const [aggData, setAggData] = useState<AggregatedData | null>(null);

  // Fetch season data once on mount
  useEffect(() => {
    setSeasonLoad({ status: "loading" });
    loadSeasonData()
      .then(data => {
        setAggData(data);
        setSeasonLoad({ status: "ready" });
      })
      .catch(err => {
        setSeasonLoad({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, []);

  // Build UGM + GraphData synchronously whenever team / week / data changes
  const computed = useMemo((): { ugm: UGM; graphData: GraphData } | null => {
    if (!aggData) return null;
    const loaded = buildLoadedData(aggData, week ?? undefined);
    return buildGraphData(loaded, team);
  }, [aggData, team, week]);

  const season = computed?.graphData.meta.season ?? aggData?.latestSeason ?? new Date().getFullYear();
  const isPreseason = computed?.graphData.meta.isPreseason ?? false;

  return (
    <div style={pageStyles.root}>
      {/* Top nav bar */}
      <header style={pageStyles.header}>
        <a href="../" style={pageStyles.backLink} title="Back to main app" aria-label="Back">
          ← Back
        </a>
        <span style={pageStyles.title}>
          Who2Root4<sup style={{ fontSize: "0.5em" }}>TM</sup>
          <span style={pageStyles.subtitle}> · Graph View</span>
        </span>

        {/* Team selector */}
        <label style={pageStyles.label}>
          Team
          <select
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            style={pageStyles.select}
          >
            {ALL_TEAMS.map((t) => (
              <option key={t.abbr} value={t.abbr}>
                {t.abbr} — {t.name}
              </option>
            ))}
          </select>
        </label>

        {/* Week selector */}
        <label style={pageStyles.label}>
          Week
          <select
            value={week ?? ""}
            onChange={(e) => setWeek(e.target.value === "" ? null : Number(e.target.value))}
            style={pageStyles.select}
          >
            <option value="">Current</option>
            {WEEKS.map((w) => (
              <option key={w} value={w}>Week {w}</option>
            ))}
          </select>
        </label>

        <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
          {season} season
        </span>
      </header>

      {/* Preseason banner */}
      {isPreseason && seasonLoad.status === "ready" && (
        <div style={pageStyles.preseasonBanner} role="status">
          🏈 Preseason — impact scores are projections based on matchup context
          (no completed games yet).
        </div>
      )}

      {/* Main content area */}
      <div style={pageStyles.body}>
        {seasonLoad.status === "loading" && <Spinner />}

        {seasonLoad.status === "error" && (
          <ErrorPanel
            message={seasonLoad.message}
            onRetry={() => {
              setSeasonLoad({ status: "loading" });
              loadSeasonData()
                .then(data => { setAggData(data); setSeasonLoad({ status: "ready" }); })
                .catch(err => setSeasonLoad({ status: "error", message: err instanceof Error ? err.message : String(err) }));
            }}
          />
        )}

        {seasonLoad.status === "ready" && computed && computed.graphData.nodes.length === 0 && (
          <EmptyState />
        )}

        {seasonLoad.status === "ready" && computed && computed.graphData.nodes.length > 0 && (
          <PlayoffGraph ugm={computed.ugm} graphData={computed.graphData} />
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div style={loadStyles.center}>
      <div style={loadStyles.spinner} aria-label="Loading…" />
      <p style={{ color: "var(--text-muted)", marginTop: 16 }}>
        Building playoff graph…
      </p>
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={loadStyles.center}>
      <div style={loadStyles.errorCard}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>⚠️</div>
        <h2 style={{ margin: "0 0 8px" }}>Couldn&apos;t load graph data</h2>
        <p style={{ color: "var(--text-muted)", marginBottom: 16, maxWidth: 360 }}>
          {message}
        </p>
        <p style={{ color: "var(--text-faint)", fontSize: 12, marginBottom: 16 }}>
          The graph view fetches ESPN cache files from GitHub. Make sure the repo
          is public and has scoreboard JSON committed under <code>.cache/espn/</code>.
        </p>
        <button style={loadStyles.retryBtn} onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={loadStyles.center}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>📅</div>
      <h2 style={{ margin: "0 0 8px" }}>No games scheduled for this week</h2>
      <p style={{ color: "var(--text-muted)" }}>
        Try selecting a different week or season.
      </p>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const pageStyles = {
  root: {
    display:       "flex",
    flexDirection: "column" as const,
    height:        "100vh",
    overflow:      "hidden",
    fontFamily:    "var(--font-data)",
  },
  header: {
    display:      "flex",
    alignItems:   "center",
    gap:          12,
    height:       56,
    padding:      "0 16px",
    borderBottom: "1px solid var(--border)",
    background:   "var(--surface)",
    flexShrink:   0,
    flexWrap:     "wrap" as const,
  },
  backLink: {
    color:          "var(--text-muted)",
    textDecoration: "none",
    fontSize:       13,
    fontWeight:     600,
    padding:        "4px 8px",
    borderRadius:   6,
    border:         "1px solid var(--border)",
  },
  title: {
    fontFamily:    "var(--font-display)",
    fontWeight:    800,
    fontSize:      22,
    letterSpacing: "-0.5px",
    color:         "var(--text)",
  },
  subtitle: {
    fontFamily:    "var(--font-data)",
    fontWeight:    400,
    fontSize:      14,
    color:         "var(--text-faint)",
    letterSpacing: 0,
  },
  label: {
    display:    "flex",
    alignItems: "center",
    gap:        6,
    fontSize:   13,
    fontWeight: 600,
    color:      "var(--text-muted)",
  },
  select: {
    padding:      "4px 8px",
    borderRadius: 6,
    border:       "1px solid var(--border)",
    background:   "var(--surface)",
    color:        "var(--text)",
    fontSize:     13,
    fontFamily:   "var(--font-data)",
  },
  preseasonBanner: {
    background:   "oklch(0.96 0.045 60)",
    color:        "oklch(0.42 0.13 45)",
    padding:      "8px 16px",
    fontSize:     13,
    fontWeight:   500,
    borderBottom: "1px solid oklch(0.88 0.06 60)",
    flexShrink:   0,
  },
  body: {
    flex:     1,
    overflow: "hidden",
    position: "relative" as const,
  },
} as const;

const loadStyles = {
  center: {
    display:        "flex",
    flexDirection:  "column" as const,
    alignItems:     "center",
    justifyContent: "center",
    height:         "100%",
    padding:        32,
  },
  spinner: {
    width:          48,
    height:         48,
    border:         "4px solid var(--border)",
    borderTopColor: "var(--accent)",
    borderRadius:   "50%",
    animation:      "spin 0.8s linear infinite",
  },
  errorCard: {
    background:   "var(--surface)",
    border:       "1px solid var(--border)",
    borderRadius: 12,
    padding:      "32px 40px",
    textAlign:    "center" as const,
    maxWidth:     480,
  },
  retryBtn: {
    padding:      "8px 24px",
    borderRadius: 8,
    border:       "none",
    background:   "var(--accent)",
    color:        "#fff",
    fontSize:     14,
    fontWeight:   600,
    cursor:       "pointer",
    fontFamily:   "var(--font-data)",
  },
} as const;
