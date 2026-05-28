/**
 * PlayoffGraph: three-panel graph visualization of the NFL playoff picture.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────┐
 *   │  [GraphFilter]              [Recenter] [CanvasLegend]│  ← controls bar
 *   ├──────────────────────────────┬──────────────────────┤
 *   │                              │                      │
 *   │   CytoscapeCanvas            │  TeamPanel /         │
 *   │   (conference layout)        │  EdgeDetail          │
 *   │                              │                      │
 *   ├──────────────────────────────┴──────────────────────┤
 *   │   ImpactChart (one bar per game this week)          │
 *   └─────────────────────────────────────────────────────┘
 */

import { useState, useCallback, useRef, useEffect } from "react";
import type { Core } from "cytoscape";
import type { UGM } from "@g3t/core";
import { CytoscapeCanvas } from "@g3t/react/views";
import { CanvasLegend, ContextMenuManager } from "@g3t/react/controls";
import { useSelectionStore } from "@g3t/react/state";
import type { GraphData, GraphNode, GraphEdge } from "../types";

// ── Team positions (AFC left, NFC right, divisions in 2×2 clusters) ──────────
//
// Coordinate space ~1000×900.  cy.fit() will zoom-to-fit after applying.
//
// AFC (left): East(x=120) + North(x=280) top; South(x=120) + West(x=280) bottom
// NFC (right): East(x=720) + North(x=880) top; South(x=720) + West(x=880) bottom

const TEAM_POSITIONS: Record<string, { x: number; y: number }> = {
  // AFC East
  BUF: { x: 120, y: 100 }, MIA: { x: 120, y: 210 }, NE:  { x: 120, y: 320 }, NYJ: { x: 120, y: 430 },
  // AFC North
  BAL: { x: 280, y: 100 }, CIN: { x: 280, y: 210 }, CLE: { x: 280, y: 320 }, PIT: { x: 280, y: 430 },
  // AFC South
  HOU: { x: 120, y: 570 }, IND: { x: 120, y: 680 }, JAX: { x: 120, y: 790 }, TEN: { x: 120, y: 900 },
  // AFC West
  DEN: { x: 280, y: 570 }, KC:  { x: 280, y: 680 }, LAC: { x: 280, y: 790 }, LV:  { x: 280, y: 900 },
  // NFC East
  DAL: { x: 720, y: 100 }, NYG: { x: 720, y: 210 }, PHI: { x: 720, y: 320 }, WAS: { x: 720, y: 430 },
  // NFC North
  CHI: { x: 880, y: 100 }, DET: { x: 880, y: 210 }, GB:  { x: 880, y: 320 }, MIN: { x: 880, y: 430 },
  // NFC South
  ATL: { x: 720, y: 570 }, CAR: { x: 720, y: 680 }, NO:  { x: 720, y: 790 }, TB:  { x: 720, y: 900 },
  // NFC West
  ARI: { x: 880, y: 570 }, LAR: { x: 880, y: 680 }, SEA: { x: 880, y: 790 }, SF:  { x: 880, y: 900 },
};

function applyTeamPositions(cy: Core) {
  cy.nodes().forEach(node => {
    const abbr = node.data("abbreviation") as string;
    const pos = TEAM_POSITIONS[abbr];
    if (pos) node.position(pos);
  });
  cy.fit(cy.elements(), 40);
}

// ── Stylesheet ────────────────────────────────────────────────────────────────
//
// nodeLabel (e.g. "#4 PIT") appears below the node via text-valign: bottom.
// Edge labels suppressed — colored arrows + legend explain them.

const PLAYOFF_GRAPH_STYLESHEET = [
  // Base node: nodeLabel ("#4 PIT") below the circle; white text with dark outline.
  {
    selector: "node",
    style: {
      color:                  "#ffffff",
      "font-size":            "10px",
      "font-weight":          "bold",
      "text-valign":          "bottom",
      "text-halign":          "center",
      "text-margin-y":        8,
      "text-outline-color":   "#1f2937",
      "text-outline-width":   1.5,
      "text-outline-opacity": 0.75,
    },
  },
  // Conference fallback colors + glow (outline ring + shadow blur)
  {
    selector: 'node[conference = "AFC"]',
    style: {
      "background-color": "#b91c1c",
      "outline-color":    "#ef4444",
      "outline-width":    10,
      "outline-opacity":  0.65,
      "outline-style":    "solid",
      "outline-offset":   2,
      "shadow-color":     "#ef4444",
      "shadow-blur":      14,
      "shadow-offset-x":  0,
      "shadow-offset-y":  0,
      "shadow-opacity":   0.5,
    },
  },
  {
    selector: 'node[conference = "NFC"]',
    style: {
      "background-color": "#1d4ed8",
      "outline-color":    "#3b82f6",
      "outline-width":    10,
      "outline-opacity":  0.65,
      "outline-style":    "solid",
      "outline-offset":   2,
      "shadow-color":     "#3b82f6",
      "shadow-blur":      14,
      "shadow-offset-x":  0,
      "shadow-offset-y":  0,
      "shadow-opacity":   0.5,
    },
  },
  // Team brand color (same palette as the main page) — overrides conf fallback
  {
    selector: "node[teamColor]",
    style: { "background-color": "data(teamColor)" },
  },
  // Favorite team: gold border
  {
    selector: "node[?isFavorite]",
    style: {
      "border-width": 3,
      "border-color": "#f59e0b",
      "border-style": "solid",
    },
  },
  // nodeLabel below the node (e.g. "#4 PIT" or "PIT")
  {
    selector: "node[nodeLabel]",
    style: { label: "data(nodeLabel)" },
  },
  // Size ← playoff probability (30–70 px)
  {
    selector: "node[playoffProbability]",
    style: {
      width:  "mapData(playoffProbability, 0, 1, 30, 70)" as unknown as number,
      height: "mapData(playoffProbability, 0, 1, 30, 70)" as unknown as number,
    },
  },
  // Suppress all edge labels — use colored arrows only
  {
    selector: "edge",
    style: { label: "" },
  },
  // Edge colors
  {
    selector: 'edge[type = "improvesOdds"]',
    style: { "line-color": "#38bdf8", "target-arrow-color": "#38bdf8" },
  },
  {
    selector: 'edge[type = "hurtsOdds"]',
    style: { "line-color": "#f97316", "target-arrow-color": "#f97316" },
  },
  {
    selector: 'edge[type = "winsOver"]',
    style: { "line-color": "#6b7280", "target-arrow-color": "#6b7280" },
  },
  // Width ← impact score
  {
    selector: "edge[impactScore]",
    style: { width: "mapData(impactScore, 0, 1, 1, 8)" as unknown as number },
  },
] as const;

// Encoding config for CanvasLegend
const LEGEND_ENCODING = {
  nodeSizeProperty:  "playoffProbability" as const,
  nodeSizeRange:     [30, 70] as [number, number],
  nodeColorProperty: "conference" as const,
  edgeWidthProperty: "impactScore" as const,
  edgeWidthRange:    [1, 8] as [number, number],
  nodeLabelProperty: "nodeLabel",
  edgeLabelProperty: "type",
};

// ── Props ────────────────────────────────────────────────────────────────────

export interface PlayoffGraphProps {
  ugm: UGM;
  graphData: GraphData;
}

// ── Component ────────────────────────────────────────────────────────────────

export function PlayoffGraph({ ugm, graphData }: PlayoffGraphProps) {
  const { selectedNodeIds, selectedEdgeIds, selectNodes, selectEdges } =
    useSelectionStore();

  // ── Filter state ─────────────────────────────────────────────────────────
  const [visibleConfs, setVisibleConfs] = useState(new Set(["AFC", "NFC"]));
  const [visibleKinds, setVisibleKinds] = useState(
    new Set(["division_leader", "wildcard", "in_hunt", "eliminated"]),
  );
  const [visibleEdgeTypes, setVisibleEdgeTypes] = useState(new Set(["winsOver"]));
  const [only1Seed, setOnly1Seed] = useState(false);

  function toggleConf(c: string) {
    setVisibleConfs(prev => {
      const next = new Set(prev);
      next.has(c) ? next.delete(c) : next.add(c);
      return next;
    });
  }
  function toggleKind(k: string) {
    setVisibleKinds(prev => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  }
  function toggleEdgeType(t: string) {
    setVisibleEdgeTypes(prev => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });
  }

  // ── Context menu (friendly labels) ───────────────────────────────────────
  const menuManagerRef = useRef<ContextMenuManager | null>(null);
  if (!menuManagerRef.current) {
    const mgr = new ContextMenuManager();
    mgr.register("who2root4", [
      {
        id: "view-team",
        label: "View playoff picture",
        icon: "🏈",
        filter: (t) => t.type === "node",
        action: (t) => { if (t.id) selectNodes([t.id]); },
      },
      {
        id: "view-game",
        label: "View game details",
        icon: "📊",
        filter: (t) => t.type === "edge",
        action: (t) => { if (t.id) selectEdges([t.id]); },
      },
    ]);
    menuManagerRef.current = mgr;
  }

  // ── Canvas ref + tap wiring ───────────────────────────────────────────────
  const cyRef = useRef<Core | null>(null);

  const handleCanvasReady = useCallback(
    (cy: Core) => {
      cyRef.current = cy;
      cy.one("layoutstop", () => { applyTeamPositions(cy); });
      setTimeout(() => { applyTeamPositions(cy); }, 0);

      cy.on("tap", (evt) => {
        if (evt.target === cy) { selectNodes([]); selectEdges([]); }
      });
      cy.on("tap", "node", (evt) => selectNodes([evt.target.id()]));
      cy.on("tap", "edge", (evt) => selectEdges([evt.target.id()]));
    },
    [selectNodes, selectEdges],
  );

  // Reapply positions + seed images when UGM updates (new nodes may lack positions)
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    setTimeout(() => { applyTeamPositions(cy); }, 50);
  }, [ugm]);

  // Selected element
  const firstNode = [...selectedNodeIds][0] ?? null;
  const firstEdge = [...selectedEdgeIds][0] ?? null;
  const selectedNodeData = firstNode
    ? graphData.nodes.find(n => n.id === firstNode) ?? null
    : null;
  const selectedEdgeData = firstEdge
    ? graphData.edges.find(e => e.id === firstEdge) ?? null
    : null;

  // Combined visibility + coloring effect.
  // improvesOdds/hurtsOdds are hidden by default; only the selected node's
  // connected ones are revealed.  winsOver is toggle-controlled and colored
  // green (wins) / red (losses) relative to the selected node.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.elements().removeStyle("display");

    // Hide filtered-out nodes
    const toHideNodes = cy.nodes().filter(node => {
      const conf = node.data("conference") as string;
      const kind = node.data("standingKind") as string;
      if (!visibleConfs.has(conf)) return true;
      if (!visibleKinds.has(kind)) return true;
      if (only1Seed && !node.data("is1SeedContender")) return true;
      return false;
    });
    toHideNodes.style("display", "none");

    // winsOver: toggle-controlled
    if (!visibleEdgeTypes.has("winsOver")) {
      cy.edges('[type = "winsOver"]').style("display", "none");
    }

    // improvesOdds/hurtsOdds: always hidden; reveal only for selected node
    cy.edges('[type = "improvesOdds"],[type = "hurtsOdds"]').style("display", "none");
    if (firstNode) {
      const sel = cy.getElementById(firstNode);
      if (sel.length) {
        sel.connectedEdges('[type = "improvesOdds"],[type = "hurtsOdds"]')
          .style("display", "element");
      }
    }

    // Re-hide any edge that touches a hidden node (overrides the reveal above)
    toHideNodes.connectedEdges().style("display", "none");

    // winsOver coloring: outgoing=green (win), incoming=red (loss)
    cy.edges('[type = "winsOver"]').removeStyle("line-color target-arrow-color");
    if (firstNode) {
      const sel = cy.getElementById(firstNode);
      if (sel.length) {
        sel.outgoers('edge[type = "winsOver"]').style({
          "line-color": "#22c55e", "target-arrow-color": "#22c55e",
        });
        sel.incomers('edge[type = "winsOver"]').style({
          "line-color": "#ef4444", "target-arrow-color": "#ef4444",
        });
      }
    }
  }, [visibleConfs, visibleKinds, only1Seed, visibleEdgeTypes, firstNode]);

  // Responsive layout
  const [showChart, setShowChart] = useState(true);
  const [narrow, setNarrow] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(300);
  const [bottomHeight, setBottomHeight] = useState(190);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    setNarrow(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  function startInspectorResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = inspectorWidth;
    const onMove = (ev: MouseEvent) =>
      setInspectorWidth(Math.max(160, Math.min(520, startWidth + (startX - ev.clientX))));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function startBottomResize(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = bottomHeight;
    const onMove = (ev: MouseEvent) =>
      setBottomHeight(Math.max(60, Math.min(420, startHeight + (startY - ev.clientY))));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div style={styles.root}>
      {/* Controls bar */}
      <div style={styles.controls}>
        <GraphFilter
          visibleConfs={visibleConfs}
          visibleKinds={visibleKinds}
          visibleEdgeTypes={visibleEdgeTypes}
          only1Seed={only1Seed}
          onToggleConf={toggleConf}
          onToggleKind={toggleKind}
          onToggleEdgeType={toggleEdgeType}
          onToggle1Seed={() => setOnly1Seed(v => !v)}
        />
        <button
          style={{ ...styles.recentreBtn, marginLeft: "auto", flexShrink: 0 }}
          onClick={() => cyRef.current && applyTeamPositions(cyRef.current)}
          title="Refit graph on screen"
        >
          ⊙ Recenter
        </button>
      </div>

      {/* Main two-column area */}
      <div style={{ ...styles.canvasArea, flexDirection: narrow ? "column" : "row" }}>
        {/* Canvas */}
        <div style={styles.canvasWrapper}>
          <CytoscapeCanvas
            ugm={ugm}
            layout="preset"
            stylesheet={
              PLAYOFF_GRAPH_STYLESHEET as unknown as Parameters<
                typeof CytoscapeCanvas
              >[0]["stylesheet"]
            }
            menuManager={menuManagerRef.current ?? undefined}
            onReady={handleCanvasReady}
            className="pg-canvas"
          />
        </div>

        {/* Inspector resize handle */}
        {!narrow && (
          <div style={styles.inspectorResizeHandle} onMouseDown={startInspectorResize} />
        )}

        {/* Inspector panel */}
        <div style={{ ...styles.inspector, width: narrow ? "100%" : inspectorWidth, maxHeight: narrow ? 320 : undefined }}>
          <div style={styles.inspectorHeader}>
            {selectedNodeData
              ? "Team Details"
              : selectedEdgeData
                ? "Game Details"
                : "Click any team to see their playoff picture"}
          </div>
          {selectedNodeData && (
            <TeamPanel node={selectedNodeData} graphData={graphData} />
          )}
          {selectedEdgeData && !selectedNodeData && (
            <EdgeDetail edge={selectedEdgeData} />
          )}
        </div>
      </div>

      {/* Bottom chart */}
      {narrow && (
        <button style={styles.chartToggle} onClick={() => setShowChart(v => !v)}>
          {showChart ? "▲ Hide" : "▼ Show"} Impact Chart
        </button>
      )}
      {(!narrow || showChart) && (
        <div style={{ ...styles.chartWrapper, height: narrow ? undefined : bottomHeight }}>
          {!narrow && (
            <div style={styles.bottomResizeHandle} onMouseDown={startBottomResize} />
          )}
          <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
            <div style={{ flex: 1, overflow: "hidden" }}>
              <ImpactChart graphData={graphData} />
            </div>
            <div style={styles.legendPanel}>
              <CanvasLegend ugm={ugm} encoding={LEGEND_ENCODING} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── GraphFilter ───────────────────────────────────────────────────────────────

interface GraphFilterProps {
  visibleConfs: Set<string>;
  visibleKinds: Set<string>;
  visibleEdgeTypes: Set<string>;
  only1Seed: boolean;
  onToggleConf: (c: string) => void;
  onToggleKind: (k: string) => void;
  onToggleEdgeType: (t: string) => void;
  onToggle1Seed: () => void;
}

const KIND_LABELS: { key: string; label: string }[] = [
  { key: "division_leader", label: "Div Leaders" },
  { key: "wildcard",        label: "Wild Card"   },
  { key: "in_hunt",         label: "In Hunt"     },
  { key: "eliminated",      label: "Out"         },
];

const EDGE_TYPE_LABELS: { key: string; label: string; color: string }[] = [
  { key: "winsOver", label: "Wins Over", color: "#6b7280" },
];

function GraphFilter({
  visibleConfs, visibleKinds, visibleEdgeTypes, only1Seed,
  onToggleConf, onToggleKind, onToggleEdgeType, onToggle1Seed,
}: GraphFilterProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={chipStyles.label}>CONF:</span>
        {(["AFC", "NFC"] as const).map(c => (
          <FilterChip
            key={c}
            active={visibleConfs.has(c)}
            onClick={() => onToggleConf(c)}
            color={c === "AFC" ? "#dc2626" : "#2563eb"}
          >
            {c}
          </FilterChip>
        ))}
        <span style={{ ...chipStyles.divider }} />
        <span style={chipStyles.label}>STATUS:</span>
        {KIND_LABELS.map(({ key, label }) => (
          <FilterChip key={key} active={visibleKinds.has(key)} onClick={() => onToggleKind(key)}>
            {label}
          </FilterChip>
        ))}
        <span style={{ ...chipStyles.divider }} />
        <FilterChip active={only1Seed} onClick={onToggle1Seed} color="#f59e0b">
          1-Seed Hunt
        </FilterChip>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={chipStyles.label}>EDGES:</span>
        {EDGE_TYPE_LABELS.map(({ key, label, color }) => (
          <FilterChip key={key} active={visibleEdgeTypes.has(key)} onClick={() => onToggleEdgeType(key)} color={color}>
            {label}
          </FilterChip>
        ))}
      </div>
    </div>
  );
}

function FilterChip({
  children, active, onClick, color = "#6b7280",
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding:      "2px 8px",
        borderRadius: 12,
        border:       `1.5px solid ${active ? color : "var(--border)"}`,
        background:   active ? color : "transparent",
        color:        active ? "#fff" : "var(--text-muted)",
        fontSize:     11,
        fontWeight:   600,
        cursor:       "pointer",
        fontFamily:   "var(--font-data)",
        transition:   "all 0.15s",
      }}
    >
      {children}
    </button>
  );
}

const chipStyles = {
  label: {
    fontSize:   11,
    fontWeight: 700,
    color:      "var(--text-faint)",
    letterSpacing: "0.05em",
  } as const,
  divider: {
    width:      1,
    height:     14,
    background: "var(--border)",
    display:    "inline-block",
    margin:     "0 2px",
  } as const,
};

// ── TeamPanel ─────────────────────────────────────────────────────────────────

interface TeamPanelProps {
  node: GraphNode;
  graphData: GraphData;
}

function TeamPanel({ node, graphData }: TeamPanelProps) {
  const relatedEdges = graphData.edges.filter(
    e => e.source === node.id || e.target === node.id,
  );
  const teamColor = node.color ? `#${node.color}` : (node.conference === "AFC" ? "#dc2626" : "#2563eb");
  const seedBadgeColor = node.isFavorite ? "#f59e0b" : teamColor;

  return (
    <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div
          style={{
            width: 36, height: 36, borderRadius: "50%",
            background: teamColor, color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontWeight: 800, fontSize: 12, flexShrink: 0,
          }}
        >
          {node.abbreviation}
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{node.label}</div>
          <div style={{ color: "var(--text-muted)" }}>
            {node.wins}–{node.losses} · {node.division}
          </div>
        </div>
        {node.playoffSeed != null && (
          <div style={{
            marginLeft: "auto", background: seedBadgeColor,
            color: "#fff", borderRadius: 4, padding: "2px 6px",
            fontWeight: 700, fontSize: 12, flexShrink: 0,
          }}>
            #{node.playoffSeed}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 4 }}>
        <span style={{ color: "var(--text-muted)" }}>Playoff probability: </span>
        <strong>{Math.round(node.playoffProbability * 100)}%</strong>
      </div>
      <div style={{ marginBottom: 8 }}>
        <span style={{ color: "var(--text-muted)" }}>Status: </span>
        <strong style={{ textTransform: "capitalize" }}>
          {node.standingKind.replace("_", " ")}
        </strong>
      </div>

      <div style={{ marginBottom: 6, fontSize: 11, color: "var(--text-muted)" }}>
        <span style={{ color: "#22c55e", fontWeight: 700 }}>↗ green arrows</span> = wins &nbsp;·&nbsp;
        <span style={{ color: "#ef4444", fontWeight: 700 }}>↘ red arrows</span> = losses
      </div>

      {relatedEdges.filter(e => e.type !== "winsOver").length > 0 && (
        <>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            This week ({relatedEdges.filter(e => e.type !== "winsOver").length} game impacts):
          </div>
          {relatedEdges.filter(e => e.type !== "winsOver").slice(0, 6).map(e => {
            const isSource = e.source === node.id;
            const otherAbbr = (isSource ? e.target : e.source).split(":").pop() ?? "";
            const dotColor = "#38bdf8";
            const edgeLabel = isSource ? `Root for ${otherAbbr}` : `Against ${otherAbbr}`;
            return (
              <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0", borderBottom: "1px solid var(--border)" }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{edgeLabel}</span>
                {e.recommendationScore > 0 && (
                  <span style={{ fontWeight: 700, color: dotColor, fontSize: 12 }}>{e.recommendationScore}%</span>
                )}
              </div>
            );
          })}
          {relatedEdges.filter(e => e.type !== "winsOver").length > 6 && (
            <div style={{ color: "var(--text-faint)", fontSize: 11, marginTop: 4 }}>
              +{relatedEdges.filter(e => e.type !== "winsOver").length - 6} more
            </div>
          )}
          {relatedEdges.find(e => e.type !== "winsOver")?.reasoning && (
            <div style={{ marginTop: 6, color: "var(--text-muted)", fontStyle: "italic", fontSize: 11 }}>
              {relatedEdges.find(e => e.type !== "winsOver")!.reasoning}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── EdgeDetail ────────────────────────────────────────────────────────────────

function EdgeDetail({ edge }: { edge: GraphEdge }) {
  const rootFor = edge.source.split(":").pop() ?? "";
  const against = edge.target.split(":").pop() ?? "";
  const dotColor =
    edge.type === "improvesOdds" ? "#38bdf8"
    : edge.type === "winsOver"   ? "#6b7280"
    : "#9ca3af";
  return (
    <div style={{ padding: "8px 12px", fontSize: 13 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>
        <span style={{ color: dotColor }}>{rootFor}</span>
        {edge.type === "winsOver" ? " beat " : " vs "}
        {against}
      </div>
      {edge.type !== "winsOver" && (
        <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>
          Impact score: <strong>{edge.recommendationScore}</strong>
        </div>
      )}
      <div style={{ color: "var(--text-muted)", fontStyle: "italic", fontSize: 11 }}>
        {edge.reasoning || (edge.type === "winsOver" ? "Head-to-head result" : "No reasoning available")}
      </div>
    </div>
  );
}

// ── ImpactChart ───────────────────────────────────────────────────────────────
// SVG bar chart: one bar per game, sorted by recommendationScore descending.

function ImpactChart({ graphData }: { graphData: GraphData }) {
  const CHART_H   = 110;
  const LABEL_H   = 52;
  const BAR_W     = 38;
  const GAP       = 6;
  const SCORE_PAD = 14;

  const edges = [...graphData.edges]
    .filter(e => e.recommendationScore > 0)
    .sort((a, b) => b.recommendationScore - a.recommendationScore)
    .slice(0, 14);

  if (edges.length === 0) {
    return (
      <div style={{ padding: "12px 16px", color: "var(--text-faint)", fontSize: 12 }}>
        This Week's Game Impact Scores — no games with impact data
      </div>
    );
  }

  const maxScore = Math.max(...edges.map(e => e.recommendationScore), 1);
  const svgW = edges.length * (BAR_W + GAP) + GAP;
  const svgH = CHART_H + LABEL_H + SCORE_PAD;

  return (
    <div style={{ padding: "6px 12px 4px", overflowX: "auto" }}>
      <div style={{ fontWeight: 700, fontSize: 11, marginBottom: 4, color: "var(--text-muted)", letterSpacing: "0.04em" }}>
        THIS WEEK'S GAME IMPACT
      </div>
      <svg width={svgW} height={svgH} style={{ display: "block" }}>
        {edges.map((e, i) => {
          const rootFor = e.source.split(":").pop() ?? "";
          const against = e.target.split(":").pop() ?? "";
          const barH = Math.max(4, (e.recommendationScore / maxScore) * CHART_H);
          const x    = GAP + i * (BAR_W + GAP);
          const y    = CHART_H - barH;
          const color =
            e.type === "improvesOdds" ? "#38bdf8"
            : e.type === "hurtsOdds"  ? "#f97316"
            : e.type === "winsOver"   ? "#6b7280"
            : "#9ca3af";
          const lx   = x + BAR_W / 2;
          const ly   = CHART_H + 10;
          return (
            <g key={e.id}>
              <rect x={x} y={y} width={BAR_W} height={barH} fill={color} rx={3} />
              <text x={lx} y={CHART_H - barH - 3} textAnchor="middle" fontSize={8} fill="var(--text)">
                {e.recommendationScore}%
              </text>
              {/* X-axis label: "ROOT vs OPP", rotated 40° */}
              <text
                x={lx} y={ly} textAnchor="end"
                fontSize={8} fill="var(--text-muted)"
                transform={`rotate(-40, ${lx}, ${ly})`}
              >
                {rootFor} vs {against}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  root: {
    display:       "flex",
    flexDirection: "column" as const,
    height:        "calc(100vh - 56px)",
    overflow:      "hidden",
    background:    "var(--bg)",
  },
  controls: {
    display:      "flex",
    alignItems:   "center",
    gap:          8,
    padding:      "5px 10px",
    borderBottom: "1px solid var(--border)",
    background:   "var(--surface)",
    flexWrap:     "wrap" as const,
    flexShrink:   0,
  },
  canvasArea: {
    display:  "flex",
    flex:     1,
    overflow: "hidden",
  },
  canvasWrapper: {
    flex:     1,
    position: "relative" as const,
    overflow: "hidden",
  },
  inspector: {
    borderLeft:    "1px solid var(--border)",
    background:    "var(--surface)",
    overflowY:     "auto" as const,
    display:       "flex",
    flexDirection: "column" as const,
  },
  inspectorHeader: {
    padding:      "8px 12px",
    fontWeight:   600,
    fontSize:     12,
    borderBottom: "1px solid var(--border)",
    background:   "var(--bg-soft, var(--surface))",
    color:        "var(--text-muted)",
    flexShrink:   0,
  },
  chartWrapper: {
    borderTop:     "1px solid var(--border)",
    background:    "var(--surface)",
    flexShrink:    0,
    display:       "flex",
    flexDirection: "column" as const,
    overflow:      "hidden",
  },
  inspectorResizeHandle: {
    width:      5,
    cursor:     "col-resize",
    background: "var(--border)",
    flexShrink: 0,
    userSelect: "none" as const,
  },
  bottomResizeHandle: {
    height:     5,
    cursor:     "row-resize",
    background: "var(--border)",
    flexShrink: 0,
    userSelect: "none" as const,
  },
  legendPanel: {
    flexShrink: 0,
    borderLeft: "1px solid var(--border)",
    overflowY:  "auto" as const,
    padding:    "4px 8px",
  },
  chartToggle: {
    width:      "100%",
    padding:    6,
    border:     "none",
    borderTop:  "1px solid var(--border)",
    background: "var(--surface)",
    cursor:     "pointer",
    fontSize:   13,
    color:      "var(--text-muted)",
  },
  recentreBtn: {
    padding:      "4px 10px",
    borderRadius: 6,
    border:       "1px solid var(--border)",
    background:   "var(--surface)",
    color:        "var(--text-muted)",
    fontSize:     12,
    fontWeight:   600,
    cursor:       "pointer",
    fontFamily:   "var(--font-data)",
  },
} as const;
