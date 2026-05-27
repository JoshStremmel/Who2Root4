/**
 * PlayoffGraph: three-panel graph visualization of the NFL playoff picture.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────┐
 *   │  [FacetFilter]                       [CanvasLegend] │  ← controls bar
 *   ├──────────────────────────────┬──────────────────────┤
 *   │                              │                      │
 *   │   CytoscapeCanvas            │  DetailInspector     │
 *   │   (main graph)               │  (selected node)     │
 *   │                              │                      │
 *   ├──────────────────────────────┴──────────────────────┤
 *   │   LinkedChart (edge-type breakdown bar chart)       │
 *   └─────────────────────────────────────────────────────┘
 *
 * All visualization components come from @g3t/react and @g3t/charts.
 * Selection state is shared via @g3t/react/state's Zustand store.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type { Core } from "cytoscape";
import type { UGM } from "@g3t/core";
import { createEdgeTypeBreakdown } from "@g3t/core/pipeline";
import { CytoscapeCanvas, DetailInspector } from "@g3t/react/views";
import {
  FacetFilter,
  CanvasLegend,
  ContextMenuManager,
} from "@g3t/react/controls";
import { useSelectionStore } from "@g3t/react/state";
import { LinkedChart } from "@g3t/charts";
import type { GraphData } from "../types";

// ── Visual Encoding Configuration ────────────────────────────────────────────
//
// Properties are flattened into Cytoscape data by ugmToCytoscapeElements, so
// all UGM node/edge properties are accessible via data(propName) in selectors.
//
// node[teamColor]        → team brand hex (#rrggbb)
// node[playoffProbability] → 0–1 float
// node[abbreviation]     → "CIN", "BAL", …
// edge[type]             → "improvesOdds" | "hurtsOdds" | "neutral"  (UGM edge type)
// edge[impactScore]      → 0–1 float

const PLAYOFF_GRAPH_STYLESHEET = [
  // ── Node encoding ──────────────────────────────────────────────────────────
  // Team brand color overrides the default type-palette color
  {
    selector: "node[teamColor]",
    style: {
      "background-color": "data(teamColor)",
    },
  },
  // Size ← playoff probability (30–70 px). Scoped with [prop] to avoid
  // cytoscape's "Do not assign mappings to elements without data" warning.
  {
    selector: "node[playoffProbability]",
    style: {
      width:  "mapData(playoffProbability, 0, 1, 30, 70)" as unknown as number,
      height: "mapData(playoffProbability, 0, 1, 30, 70)" as unknown as number,
    },
  },
  // Abbreviation label
  {
    selector: "node[abbreviation]",
    style: {
      label: "data(abbreviation)",
    },
  },

  // ── Edge encoding ──────────────────────────────────────────────────────────
  // Green = improves fav's odds, red = hurts odds, gray = neutral.
  // `type` is the UGM edge type — ugmToCytoscapeElements maps it to data(type).
  {
    selector: 'edge[type = "improvesOdds"]',
    style: {
      "line-color":          "#22c55e",
      "target-arrow-color":  "#22c55e",
    },
  },
  {
    selector: 'edge[type = "hurtsOdds"]',
    style: {
      "line-color":          "#ef4444",
      "target-arrow-color":  "#ef4444",
    },
  },
  {
    selector: 'edge[type = "neutral"]',
    style: {
      "line-color":          "#9ca3af",
      "target-arrow-color":  "#9ca3af",
    },
  },
  // Width ← impact score (1–8 px)
  {
    selector: "edge[impactScore]",
    style: {
      width: "mapData(impactScore, 0, 1, 1, 8)" as unknown as number,
    },
  },
] as const;

// Encoding config fed to CanvasLegend
const LEGEND_ENCODING = {
  nodeSizeProperty: "playoffProbability" as const,
  nodeSizeRange:    [30, 70] as [number, number],
  nodeColorProperty: "teamColor" as const,
  edgeWidthProperty: "impactScore" as const,
  edgeWidthRange:   [1, 8] as [number, number],
  nodeLabelProperty: "abbreviation",
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

  // Which node types to hide (driven by FacetFilter)
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());

  // Selected element for DetailInspector
  const selectedElement = useMemo((): { type: "node" | "edge"; id: string } | null => {
    const firstNode = [...selectedNodeIds][0];
    if (firstNode) return { type: "node", id: firstNode };
    const firstEdge = [...selectedEdgeIds][0];
    if (firstEdge) return { type: "edge", id: firstEdge };
    return null;
  }, [selectedNodeIds, selectedEdgeIds]);

  // ContextMenuManager wired to selection store
  const menuManagerRef = useRef<ContextMenuManager | null>(null);
  if (!menuManagerRef.current) {
    const mgr = new ContextMenuManager();
    // "Inspect" selects the node/edge so DetailInspector picks it up
    mgr.register("who2root4-inspect", [
      {
        id: "inspect",
        label: "Inspect node",
        icon: "🔍",
        filter: (t) => t.type === "node",
        action: (t) => { if (t.id) selectNodes([t.id]); },
      },
      {
        id: "inspect-edge",
        label: "Inspect edge",
        icon: "🔍",
        filter: (t) => t.type === "edge",
        action: (t) => { if (t.id) selectEdges([t.id]); },
      },
      {
        id: "focus-team",
        label: "Focus on this team's games",
        icon: "🎯",
        filter: (t) => t.type === "node",
        action: (t) => { if (t.id) selectNodes([t.id]); },
      },
    ]);
    menuManagerRef.current = mgr;
  }

  // cyRef for applying hidden-type visibility and canvas click-to-deselect
  const cyRef = useRef<Core | null>(null);

  const handleCanvasReady = useCallback(
    (cy: Core) => {
      cyRef.current = cy;
      // Tap background → clear selection
      cy.on("tap", (evt) => {
        if (evt.target === cy) {
          selectNodes([]);
          selectEdges([]);
        }
      });
      // Tap node → select
      cy.on("tap", "node", (evt) => {
        selectNodes([evt.target.id()]);
      });
      // Tap edge → select
      cy.on("tap", "edge", (evt) => {
        selectEdges([evt.target.id()]);
      });
    },
    [selectNodes, selectEdges],
  );

  // Apply hidden-type visibility whenever hiddenTypes changes
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().forEach((node) => {
      const nodeType = (node.data("_type") as string | undefined) ??
        (node.data("types") as string[] | undefined)?.[0] ?? "";
      if (hiddenTypes.has(nodeType)) {
        node.style("display", "none");
      } else {
        node.style("display", "element");
      }
    });
  }, [hiddenTypes]);

  // DataPipeline for LinkedChart: breakdown by edge type
  const chartPipeline = useMemo(() => createEdgeTypeBreakdown(), []);

  // Responsive layout
  const [showChart, setShowChart] = useState(true);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    setNarrow(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return (
    <div style={styles.root}>
      {/* Controls bar */}
      <div style={styles.controls}>
        <FacetFilter
          ugm={ugm}
          onFilterChange={setHiddenTypes}
          className="pg-facet"
        />
        <div style={{ marginLeft: "auto", flexShrink: 0 }}>
          <CanvasLegend ugm={ugm} encoding={LEGEND_ENCODING} />
        </div>
      </div>

      {/* Main two-column area */}
      <div
        style={{
          ...styles.canvasArea,
          flexDirection: narrow ? "column" : "row",
        }}
      >
        {/* Canvas */}
        <div style={styles.canvasWrapper}>
          <CytoscapeCanvas
            ugm={ugm}
            layout="fcose"
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

        {/* Inspector panel */}
        <div
          style={{
            ...styles.inspector,
            width: narrow ? "100%" : 300,
            maxHeight: narrow ? 320 : undefined,
          }}
        >
          <div style={styles.inspectorHeader}>
            {selectedElement
              ? selectedElement.type === "node"
                ? "Team Details"
                : "Edge Details"
              : "Click a node to inspect"}
          </div>
          <DetailInspector ugm={ugm} selection={selectedElement} />
          {selectedElement?.type === "node" && (
            <TeamPanel
              ugm={ugm}
              nodeId={selectedElement.id}
              graphData={graphData}
            />
          )}
        </div>
      </div>

      {/* Bottom chart (hidden behind toggle on narrow screens) */}
      {narrow && (
        <button
          style={styles.chartToggle}
          onClick={() => setShowChart((v) => !v)}
        >
          {showChart ? "▲ Hide" : "▼ Show"} Impact Chart
        </button>
      )}
      {(!narrow || showChart) && (
        <div style={styles.chartWrapper}>
          <LinkedChart
            ugm={ugm}
            pipeline={chartPipeline}
            type="bar"
            height={200}
          />
        </div>
      )}
    </div>
  );
}

// ── TeamPanel ────────────────────────────────────────────────────────────────
// Rich team-specific detail shown in the inspector when a node is selected.

interface TeamPanelProps {
  ugm: UGM;
  nodeId: string;
  graphData: GraphData;
}

function TeamPanel({ nodeId, graphData }: TeamPanelProps) {
  const node = graphData.nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  const relatedEdges = graphData.edges.filter(
    (e) => e.source === nodeId || e.target === nodeId,
  );

  return (
    <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <img
          src={node.logoUrl}
          alt={node.abbreviation}
          width={32}
          height={32}
          style={{ objectFit: "contain", flexShrink: 0 }}
          onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
        />
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{node.label}</div>
          <div style={{ color: "var(--text-muted)" }}>
            {node.wins}–{node.losses} · {node.division}
          </div>
        </div>
        {node.playoffSeed != null && (
          <div
            style={{
              marginLeft: "auto",
              background: `#${node.color}`,
              color: "#fff",
              borderRadius: 4,
              padding: "2px 6px",
              fontWeight: 700,
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            #{node.playoffSeed}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 6 }}>
        <span style={{ color: "var(--text-muted)" }}>Playoff probability: </span>
        <strong>{Math.round(node.playoffProbability * 100)}%</strong>
      </div>

      {relatedEdges.length > 0 && (
        <>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            This week ({relatedEdges.length} impacts):
          </div>
          {relatedEdges.slice(0, 6).map((e) => {
            const isSource = e.source === nodeId;
            const otherAbbr = (isSource ? e.target : e.source).split(":").pop() ?? "";
            const dotColor =
              e.type === "improvesOdds"
                ? "#22c55e"
                : e.type === "hurtsOdds"
                  ? "#ef4444"
                  : "#9ca3af";
            return (
              <div
                key={e.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "3px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: dotColor,
                    flexShrink: 0,
                  }}
                />
                <span style={{ flex: 1 }}>
                  {isSource ? "→" : "←"} {otherAbbr}
                </span>
                {e.recommendationScore > 0 && (
                  <span style={{ fontWeight: 700, color: dotColor, fontSize: 12 }}>
                    {e.recommendationScore}
                  </span>
                )}
              </div>
            );
          })}
          {relatedEdges.length > 6 && (
            <div style={{ color: "var(--text-faint)", fontSize: 11, marginTop: 4 }}>
              +{relatedEdges.length - 6} more
            </div>
          )}
          {relatedEdges[0]?.reasoning && (
            <div
              style={{
                marginTop: 6,
                color: "var(--text-muted)",
                fontStyle: "italic",
                fontSize: 11,
              }}
            >
              {relatedEdges[0].reasoning}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  root: {
    display:        "flex",
    flexDirection:  "column" as const,
    height:         "calc(100vh - 56px)",
    overflow:       "hidden",
    background:     "var(--bg)",
  },
  controls: {
    display:        "flex",
    alignItems:     "center",
    gap:            12,
    padding:        "6px 12px",
    borderBottom:   "1px solid var(--border)",
    background:     "var(--surface)",
    flexWrap:       "wrap" as const,
    flexShrink:     0,
  },
  canvasArea: {
    display:        "flex",
    flex:           1,
    overflow:       "hidden",
  },
  canvasWrapper: {
    flex:           1,
    position:       "relative" as const,
    overflow:       "hidden",
  },
  inspector: {
    borderLeft:     "1px solid var(--border)",
    background:     "var(--surface)",
    overflowY:      "auto" as const,
    display:        "flex",
    flexDirection:  "column" as const,
  },
  inspectorHeader: {
    padding:        "8px 12px",
    fontWeight:     700,
    fontSize:       13,
    borderBottom:   "1px solid var(--border)",
    background:     "var(--bg-soft, var(--surface))",
    flexShrink:     0,
  },
  chartWrapper: {
    borderTop:      "1px solid var(--border)",
    background:     "var(--surface)",
    flexShrink:     0,
  },
  chartToggle: {
    width:          "100%",
    padding:        6,
    border:         "none",
    borderTop:      "1px solid var(--border)",
    background:     "var(--surface)",
    cursor:         "pointer",
    fontSize:       13,
    color:          "var(--text-muted)",
  },
} as const;
