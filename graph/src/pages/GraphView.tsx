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

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { PlayoffGraph } from "../components/PlayoffGraph";
import type { GraphData } from "../types";
import type { UGM } from "@g3t/core";
import { useThemeStore } from "@g3t/react/theme";
import type { AggregatedData } from "../lib/nfl-data";
import { loadSeasonData, buildLoadedData } from "../lib/nfl-data";
import { buildGraphData } from "../lib/ugm-builder";

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

function getTweakPref<T>(key: string, fallback: T): T {
  try {
    const prefs = JSON.parse(localStorage.getItem("w2r4_tweaks") ?? "{}");
    return (prefs[key] as T) ?? fallback;
  } catch { return fallback; }
}

function saveTweakPref(key: string, value: unknown): void {
  try {
    const prefs = JSON.parse(localStorage.getItem("w2r4_tweaks") ?? "{}");
    localStorage.setItem("w2r4_tweaks", JSON.stringify({ ...prefs, [key]: value }));
  } catch { /* ignore */ }
}

// ── WeekSelect (custom dropdown — avoids OS-native popup styling issues) ─────

function WeekSelect({ value, onChange }: { value: number | null; onChange: (w: number | null) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const label = value == null ? "Current" : `Week ${value}`;
  const options: { label: string; value: number | null }[] = [
    { label: "Current", value: null },
    ...WEEKS.map(w => ({ label: `Week ${w}`, value: w })),
  ];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: "transparent", border: "none",
          color: "var(--text)", fontSize: 13, fontFamily: "var(--font-data)",
          fontWeight: 500, cursor: "pointer", padding: "0 2px",
          display: "flex", alignItems: "center", gap: 4,
        }}
      >
        {label}
        <span style={{ fontSize: 10, opacity: 0.55 }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", left: "50%",
          transform: "translateX(-50%)",
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 8, boxShadow: "var(--shadow)", zIndex: 200,
          maxHeight: 280, overflowY: "auto", minWidth: 110,
        }}>
          {options.map(opt => (
            <button
              key={String(opt.value)}
              onClick={() => { onChange(opt.value); setOpen(false); }}
              style={{
                display: "block", width: "100%",
                padding: "6px 14px",
                background: value === opt.value ? "var(--accent)" : "transparent",
                color: value === opt.value ? "#fff" : "var(--text)",
                border: "none", cursor: "pointer",
                fontSize: 13, fontFamily: "var(--font-data)", textAlign: "left" as const,
                transition: "background 0.1s",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

type SeasonLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready" };

export function GraphView() {
  const [team] = useState(getInitialTeam);
  const [week, setWeek] = useState<number | null>(() => getTweakPref<number | null>("week", null));
  const [mode, setMode] = useState<string>(() => getTweakPref("mode", "overall"));

  const [seasonLoad, setSeasonLoad] = useState<SeasonLoad>({ status: "idle" });
  const [aggData, setAggData] = useState<AggregatedData | null>(null);

  // ── Dark mode ─────────────────────────────────────────────────────────────
  const { setTheme } = useThemeStore();
  const [isDark, setIsDark] = useState(false);

  // Apply stored theme on mount
  useEffect(() => {
    const dark = getTweakPref("theme", "light") === "dark";
    setIsDark(dark);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    setTheme(dark ? "dark" : "light");
  }, [setTheme]);

  const toggleTheme = useCallback(() => {
    const next = !isDark;
    setIsDark(next);
    const theme = next ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = theme;
    setTheme(theme);
    saveTweakPref("theme", theme);
  }, [isDark, setTheme]);

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

  const handleWeekChange = useCallback((w: number | null) => {
    setWeek(w);
    saveTweakPref("week", w);
  }, []);

  const handleModeChange = useCallback((m: string) => {
    setMode(m);
    saveTweakPref("mode", m);
  }, []);

  // Build UGM + GraphData synchronously whenever team / week / mode / data changes
  const computed = useMemo((): { ugm: UGM; graphData: GraphData } | null => {
    if (!aggData) return null;
    const loaded = buildLoadedData(aggData, week ?? undefined);
    return buildGraphData(loaded, team, mode);
  }, [aggData, team, week, mode]);

  const season = computed?.graphData.meta.season ?? aggData?.latestSeason ?? new Date().getFullYear();
  const isPreseason = computed?.graphData.meta.isPreseason ?? false;

  return (
    <div style={pageStyles.root}>
      {/* Top nav bar */}
      <header style={pageStyles.header}>
        {/* Left: brand — matches main page .topnav .brand */}
        <div style={pageStyles.brand}>
          <span style={pageStyles.brandWord}>
            Who2Root4<sup style={pageStyles.brandTm}>TM</sup>
          </span>
          <span style={pageStyles.brandSub}>· Graph View</span>
        </div>

        {/* Center: week selector in a pill container (like the tab bar) */}
        <div style={pageStyles.selectorGroup}>
          <WeekSelect value={week} onChange={handleWeekChange} />
        </div>

        {/* Right: season + back link + theme toggle */}
        <div style={pageStyles.navRight}>
          <span style={pageStyles.seasonText}>{season} season</span>
          <a href="../" style={pageStyles.backLink} title="Back to main app" aria-label="Back">
            ← Main
          </a>
          <button
            onClick={toggleTheme}
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
            style={pageStyles.themeBtn}
            aria-label="Toggle theme"
          >
            {isDark ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
        </div>
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
          <PlayoffGraph ugm={computed.ugm} graphData={computed.graphData} mode={mode} onModeChange={handleModeChange} />
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
  // 3-column grid matching main page .topnav exactly
  header: {
    position:             "sticky" as const,
    top:                  0,
    zIndex:               30,
    display:              "grid",
    gridTemplateColumns:  "1fr auto 1fr",
    alignItems:           "center",
    padding:              "14px 28px",
    borderBottom:         "1px solid var(--border)",
    background:           "color-mix(in oklch, var(--bg) 78%, transparent)",
    backdropFilter:       "saturate(180%) blur(18px)",
    WebkitBackdropFilter: "saturate(180%) blur(18px)",
    flexShrink:           0,
  },
  // matches .topnav .brand
  brand: {
    display:       "flex",
    alignItems:    "center",
    gap:           6,
    fontFamily:    "var(--font-heading)",
    fontWeight:    700,
    letterSpacing: "-0.01em",
    fontSize:      20,
    color:         "var(--text)",
  },
  brandWord: {
    fontFamily:    "inherit",
    fontWeight:    "inherit" as const,
    fontSize:      "inherit",
    letterSpacing: "inherit",
    color:         "inherit",
  },
  brandTm: {
    fontSize:      "0.42em" as unknown as number,
    verticalAlign: "super" as const,
    letterSpacing: 0,
    fontWeight:    600,
    marginLeft:    "0.12em",
    opacity:       0.6,
    fontFamily:    "var(--font-data)",
    lineHeight:    1,
  },
  brandSub: {
    fontFamily:    "var(--font-data)",
    fontWeight:    400,
    fontSize:      13,
    color:         "var(--text-faint)",
    letterSpacing: 0,
    opacity:       0.85,
    marginLeft:    6,
  },
  // pill container matching .topnav .tabs
  selectorGroup: {
    display:      "flex",
    alignItems:   "center",
    gap:          0,
    background:   "var(--surface)",
    border:       "1px solid var(--border)",
    borderRadius: 999,
    padding:      "4px",
  },
  selectorLabel: {
    display:      "flex",
    alignItems:   "center",
    gap:          5,
    padding:      "5px 12px",
    borderRadius: 999,
    cursor:       "default" as const,
  },
  selectorLabelText: {
    fontSize:   13,
    fontWeight: 500,
    color:      "var(--text-muted)",
  },
  select: {
    background:  "transparent",
    border:      "none",
    color:       "var(--text)",
    fontSize:    13,
    fontFamily:  "var(--font-data)",
    fontWeight:  500,
    cursor:      "pointer",
    outline:     "none",
    padding:     "0 2px",
  },
  // right column — matches .topnav .right
  navRight: {
    justifySelf: "end" as const,
    display:     "flex",
    alignItems:  "center",
    gap:         10,
  },
  seasonText: {
    color:      "var(--text-faint)",
    fontSize:   13,
    fontFamily: "var(--font-data)",
    opacity:    0.85,
  },
  // mirrors .topnav a.tab-graph
  backLink: {
    display:        "inline-flex",
    alignItems:     "center",
    gap:            4,
    color:          "var(--accent-ink)",
    textDecoration: "none",
    fontSize:       13,
    fontWeight:     600,
    padding:        "5px 12px",
    borderRadius:   999,
    border:         "1px solid color-mix(in oklch, var(--accent) 40%, transparent)",
    fontFamily:     "var(--font-data)",
    whiteSpace:     "nowrap" as const,
  },
  // matches .icon-btn
  themeBtn: {
    width:        34,
    height:       34,
    border:       "1px solid var(--border)",
    background:   "var(--surface)",
    borderRadius: 10,
    display:      "grid",
    placeItems:   "center",
    color:        "var(--text-muted)",
    cursor:       "pointer",
    padding:      0,
    flexShrink:   0,
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
