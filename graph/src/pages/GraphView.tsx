/**
 * GraphView: page component for the Who2Root4 playoff picture graph.
 *
 * Responsibilities:
 *   - Team and week selectors
 *   - Fetches /api/graph-data via RestAdapter → UGM
 *   - Loading / error / empty states
 *   - Preseason banner
 *   - Renders PlayoffGraph with the loaded data
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import type { UGM } from "@g3t/core";
import { RestAdapter } from "@g3t/core";
import { PlayoffGraph } from "../components/PlayoffGraph";
import type { GraphData, GraphNode } from "../types";

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
    const prefs = JSON.parse(
      localStorage.getItem("w2r4_team_prefs_v1") ?? "{}",
    );
    return prefs.favTeam ?? "CIN";
  } catch {
    return "CIN";
  }
}

function getCurrentYear(): number {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

// API base — empty string (relative URL) when running on the FastAPI server,
// override with an absolute URL for a different origin.
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// ── Component ─────────────────────────────────────────────────────────────────

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; ugm: UGM; graphData: GraphData };

export function GraphView() {
  const [team, setTeam] = useState(getInitialTeam);
  const [week, setWeek] = useState<number | null>(null);   // null = current week
  const [season] = useState(getCurrentYear);
  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });

  // Build adapter URL from current selection
  const apiUrl = useMemo(() => {
    const params = new URLSearchParams({ team, season: String(season) });
    if (week != null) params.set("week", String(week));
    return `${API_BASE}/api/graph-data?${params.toString()}`;
  }, [team, week, season]);

  const load = useCallback(async () => {
    setLoadState({ status: "loading" });
    try {
      // Capture the raw response inside mapResponse so we only make one HTTP
      // request but retain both the UGM (for g3-toolkit components) and the
      // typed GraphData (for the TeamPanel detail view).
      let capturedData: GraphData | null = null;

      const adapter = new RestAdapter({
        url: apiUrl,
        method: "GET",
        mapResponse: (raw: unknown) => {
          const json = raw as GraphData;
          capturedData = json;
          return {
            nodes: json.nodes.map((n: GraphNode) => ({
              id: n.id,
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
                // Prefix color with # so Cytoscape stylesheet data() works
                teamColor: n.color.startsWith("#") ? n.color : `#${n.color}`,
                logoUrl: n.logoUrl,
              },
            })),
            edges: json.edges.map((e) => ({
              source: e.source,
              target: e.target,
              // UGM edge type → data(type) in Cytoscape via ugmToCytoscapeElements
              type: e.type,
              properties: {
                impactScore:         e.impactScore,
                week:                e.week,
                gameId:              e.gameId,
                recommendationScore: e.recommendationScore,
                reasoning:           e.reasoning,
              },
            })),
          };
        },
      });

      const ugm = await adapter.query("");
      const graphData = capturedData!;
      setLoadState({ status: "ready", ugm, graphData });
    } catch (err) {
      setLoadState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [apiUrl]);

  // Auto-load on mount and whenever selector changes
  useEffect(() => {
    void load();
  }, [load]);

  const graphData =
    loadState.status === "ready" ? loadState.graphData : null;
  const isPreseason = graphData?.meta?.isPreseason ?? false;

  return (
    <div style={pageStyles.root}>
      {/* Top nav bar */}
      <header style={pageStyles.header}>
        <a
          href="../"
          style={pageStyles.backLink}
          title="Back to main app"
          aria-label="Back"
        >
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
            onChange={(e) =>
              setWeek(e.target.value === "" ? null : Number(e.target.value))
            }
            style={pageStyles.select}
          >
            <option value="">Current</option>
            {WEEKS.map((w) => (
              <option key={w} value={w}>
                Week {w}
              </option>
            ))}
          </select>
        </label>

        <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
          {season} season
        </span>
      </header>

      {/* Preseason banner */}
      {isPreseason && loadState.status === "ready" && (
        <div style={pageStyles.preseasonBanner} role="status">
          🏈 Preseason — impact scores are projections based on matchup context
          (no completed games yet).
        </div>
      )}

      {/* Main content area */}
      <div style={pageStyles.body}>
        {loadState.status === "loading" && <Spinner />}

        {loadState.status === "error" && (
          <ErrorPanel message={loadState.message} onRetry={() => void load()} />
        )}

        {loadState.status === "ready" &&
          loadState.graphData.nodes.length === 0 && (
            <EmptyState />
          )}

        {loadState.status === "ready" &&
          loadState.graphData.nodes.length > 0 && (
            <PlayoffGraph ugm={loadState.ugm} graphData={loadState.graphData} />
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

function ErrorPanel({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div style={loadStyles.center}>
      <div style={loadStyles.errorCard}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>⚠️</div>
        <h2 style={{ margin: "0 0 8px" }}>Couldn&apos;t load graph data</h2>
        <p style={{ color: "var(--text-muted)", marginBottom: 16, maxWidth: 360 }}>
          {message}
        </p>
        <p style={{ color: "var(--text-faint)", fontSize: 12, marginBottom: 16 }}>
          The graph view requires the Who2Root4 API server.
          <br />
          Run locally: <code>uvicorn api.server:app --reload --port 8000</code>
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
    display:        "flex",
    alignItems:     "center",
    gap:            12,
    height:         56,
    padding:        "0 16px",
    borderBottom:   "1px solid var(--border)",
    background:     "var(--surface)",
    flexShrink:     0,
    flexWrap:       "wrap" as const,
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
    fontFamily:   "var(--font-display)",
    fontWeight:   800,
    fontSize:     22,
    letterSpacing: "-0.5px",
    color:        "var(--text)",
  },
  subtitle: {
    fontFamily:  "var(--font-data)",
    fontWeight:  400,
    fontSize:    14,
    color:       "var(--text-faint)",
    letterSpacing: 0,
  },
  label: {
    display:     "flex",
    alignItems:  "center",
    gap:         6,
    fontSize:    13,
    fontWeight:  600,
    color:       "var(--text-muted)",
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
    background:  "oklch(0.96 0.045 60)",
    color:       "oklch(0.42 0.13 45)",
    padding:     "8px 16px",
    fontSize:    13,
    fontWeight:  500,
    borderBottom: "1px solid oklch(0.88 0.06 60)",
    flexShrink:  0,
  },
  body: {
    flex:        1,
    overflow:    "hidden",
    position:    "relative" as const,
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
    width:        48,
    height:       48,
    border:       "4px solid var(--border)",
    borderTopColor: "var(--accent)",
    borderRadius: "50%",
    animation:    "spin 0.8s linear infinite",
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
