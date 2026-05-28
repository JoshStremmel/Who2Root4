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
import { ContextMenuManager } from "@g3t/react/controls";
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

type LayoutType = "default" | "circle" | "standings" | "bracket";

function applyTeamPositions(cy: Core) {
  cy.nodes().forEach(node => {
    const abbr = node.data("abbreviation") as string;
    const pos = TEAM_POSITIONS[abbr];
    if (pos) node.position(pos);
  });
  cy.fit(cy.elements(), 40);
}

// Current Standings: seeds stacked with a gentle outward arc to reduce edge overlap
function applyStandingsLayout(cy: Core) {
  cy.batch(() => {
    for (const conf of ["AFC", "NFC"] as const) {
      const baseX    = conf === "AFC" ? 220 : 780;
      const curveSide = conf === "AFC" ? -1 : 1;  // AFC curves left, NFC curves right
      const nodes = cy.nodes(`[conference = "${conf}"]`).sort((a, b) => {
        const sa = a.data("playoffSeed") as number | null;
        const sb = b.data("playoffSeed") as number | null;
        if (sa == null && sb == null) return 0;
        if (sa == null) return 1;
        if (sb == null) return -1;
        return sa - sb;
      });
      const total = nodes.length;
      nodes.forEach((n, i) => {
        const t = total > 1 ? i / (total - 1) : 0.5;
        const curve = Math.sin(t * Math.PI) * 90 * curveSide;
        n.position({ x: baseX + curve, y: 80 + i * 105 });
      });
    }
  });
  cy.fit(cy.elements(), 40);
}

// Playoff Bracket: actual matchup structure
// Seed 1 = bye (top), then 2v7, 3v6, 4v5 as paired matchups
// AFC home seeds on left col, WC seeds on inner col; NFC mirrored
function applyBracketLayout(cy: Core) {
  const Y_BASE = 100, Y_STEP = 155;
  cy.batch(() => {
    for (const conf of ["AFC", "NFC"]) {
      const homeX = conf === "AFC" ? 120 : 880;
      const wcX   = conf === "AFC" ? 310 : 690;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const seedMap = new Map<number, any>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const unseeded: any[] = [];
      cy.nodes(`[conference = "${conf}"]`).forEach(n => {
        const s = n.data("playoffSeed") as number | null;
        if (s != null) seedMap.set(s, n);
        else unseeded.push(n);
      });
      // Home seeds (1=bye, 2, 3, 4) — left/right outer column
      ([1, 2, 3, 4] as const).forEach((s, i) => {
        const n = seedMap.get(s);
        if (n) n.position({ x: homeX, y: Y_BASE + i * Y_STEP });
      });
      // Wild-card seeds facing their home-seed opponent
      // row 0 = seed 1 bye (no WC), row 1 = 2v7, row 2 = 3v6, row 3 = 4v5
      ([null, 7, 6, 5] as (number | null)[]).forEach((s, i) => {
        if (s == null) return;
        const n = seedMap.get(s);
        if (n) n.position({ x: wcX, y: Y_BASE + i * Y_STEP });
      });
      // Unseeded teams spread below the bracket
      const outBase = conf === "AFC" ? 120 : 500;
      const outStep = conf === "AFC" ? 80  : 80;
      unseeded.forEach((n, i) => {
        n.position({ x: outBase + (i % 5) * outStep, y: Y_BASE + 4 * Y_STEP + Math.floor(i / 5) * 100 });
      });
    }
  });
  cy.fit(cy.elements(), 40);
}

function applyCircleLayout(cy: Core) {
  const nodes = cy.nodes();
  const n = nodes.length;
  if (n === 0) return;
  cy.batch(() => {
    nodes.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      node.position({ x: 500 + 400 * Math.cos(angle), y: 480 + 400 * Math.sin(angle) });
    });
  });
  cy.fit(cy.elements(), 40);
}

function applyLayout(cy: Core, layout: LayoutType) {
  if (layout === "bracket")   applyBracketLayout(cy);
  else if (layout === "standings") applyStandingsLayout(cy);
  else if (layout === "circle")    applyCircleLayout(cy);
  else applyTeamPositions(cy);
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
  // Size ← playoff probability, non-linear (prob^1.7): 0%→15px, 70%→62px, 100%→100px
  {
    selector: "node[playoffProbability]",
    style: {
      width:  ((ele: any) => { const p = ele.data("playoffProbability") ?? 0; return 15 + Math.pow(p, 1.7) * 85; }) as unknown as number,
      height: ((ele: any) => { const p = ele.data("playoffProbability") ?? 0; return 15 + Math.pow(p, 1.7) * 85; }) as unknown as number,
    },
  },
  // Edge base — labels off by default, styled for when toggled on
  {
    selector: "edge",
    style: {
      label:                  "",
      "font-size":            "8px",
      "text-rotation":        "autorotate",
      "text-margin-y":        -7,
      "color":                "#ffffff",
      "text-outline-color":   "#1f2937",
      "text-outline-width":   1.5,
      "text-outline-opacity": 0.8,
    },
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


// ── Props ────────────────────────────────────────────────────────────────────

export interface PlayoffGraphProps {
  ugm: UGM;
  graphData: GraphData;
  mode: string;
  onModeChange: (m: string) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export function PlayoffGraph({ ugm, graphData, mode, onModeChange }: PlayoffGraphProps) {
  const { selectedNodeIds, selectedEdgeIds, selectNodes, selectEdges } =
    useSelectionStore();

  // ── Filter state ─────────────────────────────────────────────────────────
  const [visibleConfs, setVisibleConfs] = useState(new Set(["AFC", "NFC"]));
  const [visibleKinds, setVisibleKinds] = useState(
    new Set(["division_leader", "wildcard", "in_hunt", "eliminated"]),
  );
  const [visibleEdgeTypes, setVisibleEdgeTypes] = useState(new Set(["winsOver"]));
  const [only1Seed, setOnly1Seed] = useState(false);
  const [showImpactsOnTeam, setShowImpactsOnTeam] = useState(true);
  const [showTeamImpactOnOthers, setShowTeamImpactOnOthers] = useState(true);
  const [showEdgeLabels, setShowEdgeLabels] = useState(false);
  const [activeLayout, setActiveLayout] = useState<LayoutType>("default");
  const layoutRef = useRef<LayoutType>("default");
  // Tracks current firstNode inside tap-handler closures (avoids stale closure)
  const firstNodeRef = useRef<string | null>(null);
  const [legendPos, setLegendPos] = useState({ x: 10, y: 60 });
  const canvasWrapperRef = useRef<HTMLDivElement | null>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  // Pinned node: when an edge connected to the active node is tapped, remember
  // the node so its edges stay visible even if the store clears selectedNodeIds.
  const [pinnedNodeId, setPinnedNodeId] = useState<string | null>(null);

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
      cy.one("layoutstop", () => { applyLayout(cy, layoutRef.current); });
      setTimeout(() => { applyLayout(cy, layoutRef.current); }, 0);

      cy.on("tap", (evt) => {
        if (evt.target === cy) { selectNodes([]); selectEdges([]); setSelectedEdge(null); setPinnedNodeId(null); }
      });
      cy.on("tap", "node", (evt) => { selectNodes([evt.target.id()]); setSelectedEdge(null); setPinnedNodeId(null); });
      cy.on("tap", "edge", (evt) => {
        const e   = evt.target;
        const src = e.source().id();
        const tgt = e.target().id();
        const cur = firstNodeRef.current;
        if (!cur || (src !== cur && tgt !== cur)) {
          selectNodes([]);
          setPinnedNodeId(null);
        } else {
          // Edge is connected to the active node — pin it so its edges stay visible
          setPinnedNodeId(cur);
        }
        selectEdges([e.id()]);
        setSelectedEdge({
          id: e.id(),
          source: src,
          target: tgt,
          type:   e.data("type") as GraphEdge["type"],
          impactScore:         e.data("impactScore")         ?? 0,
          week:                e.data("week")                ?? 0,
          gameId:              e.data("gameId")              ?? "",
          recommendationScore: e.data("recommendationScore") ?? 0,
          reasoning:           e.data("reasoning")           ?? "",
        });
      });
    },
    [selectNodes, selectEdges],
  );

  // Reapply layout when UGM updates; also clear any stale edge/pin selection
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    setSelectedEdge(null);
    setPinnedNodeId(null);
    setTimeout(() => { applyLayout(cy, layoutRef.current); }, 50);
  }, [ugm]);

  // Layout change handler
  const handleLayoutChange = (l: LayoutType) => {
    setActiveLayout(l);
    layoutRef.current = l;
    const cy = cyRef.current;
    if (cy) applyLayout(cy, l);
  };

  // Legend drag handler — clamped to canvas bounds
  const startLegendDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX - legendPos.x;
    const startY = e.clientY - legendPos.y;
    const onMove = (ev: MouseEvent) => {
      let nx = ev.clientX - startX;
      let ny = ev.clientY - startY;
      const wrapper = canvasWrapperRef.current;
      const legend  = legendRef.current;
      if (wrapper && legend) {
        nx = Math.max(0, Math.min(wrapper.clientWidth  - legend.offsetWidth,  nx));
        ny = Math.max(0, Math.min(wrapper.clientHeight - legend.offsetHeight, ny));
      }
      setLegendPos({ x: nx, y: ny });
    };
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Selected element
  const firstNode = [...selectedNodeIds][0] ?? null;
  // effectiveNode: the node driving visibility — either directly selected or pinned via an edge tap
  const effectiveNode = firstNode || pinnedNodeId;
  firstNodeRef.current = effectiveNode;   // keep ref in sync for tap-handler closures
  const selectedNodeData = effectiveNode
    ? graphData.nodes.find(n => n.id === effectiveNode) ?? null
    : null;

  // Combined visibility + coloring effect.
  // improvesOdds/hurtsOdds are hidden by default; only the selected node's
  // edges are revealed, filtered by direction toggle.
  // ugm in deps so new edges are hidden immediately after data loads.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.elements().removeStyle("display");
    cy.nodes().removeStyle("opacity");
    cy.edges().removeStyle("opacity");

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

    // improvesOdds/hurtsOdds: always hidden globally; reveal per direction toggle
    cy.edges('[type = "improvesOdds"],[type = "hurtsOdds"]').style("display", "none");
    if (effectiveNode) {
      const sel = cy.getElementById(effectiveNode);
      if (sel.length) {
        const oddsSelector = '[type = "improvesOdds"],[type = "hurtsOdds"]';
        if (showImpactsOnTeam) {
          sel.incomers(oddsSelector).style("display", "element");
        }
        if (showTeamImpactOnOthers) {
          sel.outgoers(oddsSelector).style("display", "element");
        }
      }
    }

    // Re-hide any edge that touches a hidden node (overrides the reveal above)
    toHideNodes.connectedEdges().style("display", "none");

    // winsOver coloring: outgoing=green (win), incoming=red (loss)
    cy.edges('[type = "winsOver"]').removeStyle("line-color target-arrow-color");
    if (effectiveNode) {
      const sel = cy.getElementById(effectiveNode);
      if (sel.length) {
        sel.outgoers('edge[type = "winsOver"]').style({
          "line-color": "#22c55e", "target-arrow-color": "#22c55e",
        });
        sel.incomers('edge[type = "winsOver"]').style({
          "line-color": "#ef4444", "target-arrow-color": "#ef4444",
        });
      }
    }
    // Gray out: edge selection always takes priority — only the edge + its two
    // endpoint nodes stay fully visible. Falls back to node-neighborhood when
    // no edge is selected.
    if (selectedEdge) {
      const endpointIds = new Set([selectedEdge.source, selectedEdge.target]);
      cy.nodes().filter(n => !endpointIds.has(n.id())).style("opacity", 0.15);
      cy.edges().filter(e => e.id() !== selectedEdge.id).style("opacity", 0.15);
    } else if (effectiveNode) {
      const sel = cy.getElementById(effectiveNode);
      if (sel.length) {
        const connectedIds = new Set<string>([effectiveNode]);
        cy.edges().filter(e =>
          e.style("display") !== "none" &&
          (e.source().id() === effectiveNode || e.target().id() === effectiveNode)
        ).forEach(e => { connectedIds.add(e.source().id()); connectedIds.add(e.target().id()); });
        cy.nodes().filter(n => !connectedIds.has(n.id())).style("opacity", 0.15);
        cy.edges().filter(e =>
          e.source().id() !== effectiveNode && e.target().id() !== effectiveNode
        ).style("opacity", 0.15);
      }
    }

    // Edge labels
    cy.edges().style("label", "");
    if (showEdgeLabels) {
      cy.edges('[type = "improvesOdds"]').style("label", "Improves Odds");
      cy.edges('[type = "hurtsOdds"]').style("label", "Hurts Odds");
      if (effectiveNode) {
        const sel = cy.getElementById(effectiveNode);
        if (sel.length) {
          sel.outgoers('edge[type = "winsOver"]').style("label", "Defeated");
          sel.incomers('edge[type = "winsOver"]').style("label", "Defeated");
        }
      }
    }
  }, [visibleConfs, visibleKinds, only1Seed, visibleEdgeTypes, effectiveNode, selectedEdge, ugm,
      showImpactsOnTeam, showTeamImpactOnOthers, showEdgeLabels]);

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
          showImpactsOnTeam={showImpactsOnTeam}
          showTeamImpactOnOthers={showTeamImpactOnOthers}
          showEdgeLabels={showEdgeLabels}
          onToggleConf={toggleConf}
          onToggleKind={toggleKind}
          onToggleEdgeType={toggleEdgeType}
          onToggle1Seed={() => setOnly1Seed(v => !v)}
          onToggleImpactsOnTeam={() => setShowImpactsOnTeam(v => !v)}
          onToggleTeamImpactOnOthers={() => setShowTeamImpactOnOthers(v => !v)}
          onToggleEdgeLabels={() => setShowEdgeLabels(v => !v)}
        />
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <select
            value={activeLayout}
            onChange={(e) => handleLayoutChange(e.target.value as LayoutType)}
            style={{
              ...styles.recentreBtn,
              padding: "4px 8px",
              appearance: "auto" as unknown as undefined,
              colorScheme: "inherit" as React.CSSProperties["colorScheme"],
            }}
          >
            <option value="default">Default</option>
            <option value="circle">Circular</option>
            <option value="standings">Current Standings</option>
            <option value="bracket">Playoff Bracket</option>
          </select>
          <button
            style={styles.recentreBtn}
            onClick={() => cyRef.current && applyLayout(cyRef.current, activeLayout)}
            title="Refit graph on screen"
          >
            ⊙ Recenter
          </button>
        </div>
      </div>

      {/* Main two-column area */}
      <div style={{ ...styles.canvasArea, flexDirection: narrow ? "column" : "row" }}>
        {/* Canvas */}
        <div ref={canvasWrapperRef} style={styles.canvasWrapper}>
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
          <PlayoffLegend pos={legendPos} onDragStart={startLegendDrag} legendRef={legendRef} />
        </div>

        {/* Inspector resize handle */}
        {!narrow && (
          <div style={styles.inspectorResizeHandle} onMouseDown={startInspectorResize} />
        )}

        {/* Inspector panel */}
        <div style={{ ...styles.inspector, width: narrow ? "100%" : inspectorWidth, maxHeight: narrow ? 320 : undefined }}>
          <div style={styles.inspectorHeader}>
            {selectedEdge
              ? "Game Details"
              : selectedNodeData
                ? "Team Details"
                : "Click any team to view details"}
          </div>
          {selectedEdge ? (
            <EdgeDetail edge={selectedEdge} />
          ) : selectedNodeData ? (
            <TeamPanel node={selectedNodeData} graphData={graphData} />
          ) : null}
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
            <ImpactChart
              graphData={graphData}
              selectedNodeId={firstNode}
              mode={mode}
              onModeChange={onModeChange}
            />
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
  showImpactsOnTeam: boolean;
  showTeamImpactOnOthers: boolean;
  showEdgeLabels: boolean;
  onToggleConf: (c: string) => void;
  onToggleKind: (k: string) => void;
  onToggleEdgeType: (t: string) => void;
  onToggle1Seed: () => void;
  onToggleImpactsOnTeam: () => void;
  onToggleTeamImpactOnOthers: () => void;
  onToggleEdgeLabels: () => void;
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
  showImpactsOnTeam, showTeamImpactOnOthers, showEdgeLabels,
  onToggleConf, onToggleKind, onToggleEdgeType, onToggle1Seed,
  onToggleImpactsOnTeam, onToggleTeamImpactOnOthers, onToggleEdgeLabels,
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
        <span style={chipStyles.label}>FILTERS:</span>
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
        <FilterChip active={showImpactsOnTeam} onClick={onToggleImpactsOnTeam} color="#7c3aed">
          Impacts on Team
        </FilterChip>
        <FilterChip active={showTeamImpactOnOthers} onClick={onToggleTeamImpactOnOthers} color="#0891b2">
          Impacts on Others
        </FilterChip>
        <span style={{ ...chipStyles.divider }} />
        <FilterChip active={showEdgeLabels} onClick={onToggleEdgeLabels} color="#64748b">
          Labels
        </FilterChip>
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

// ── Shared helpers ────────────────────────────────────────────────────────────

function edgeTypeColor(type: string): string {
  if (type === "improvesOdds") return "#38bdf8";
  if (type === "hurtsOdds")    return "#f97316";
  if (type === "winsOver")     return "#6b7280";
  return "#9ca3af";
}

// ── CollapsibleSection ────────────────────────────────────────────────────────

function CollapsibleSection({ title, count, children }: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: "100%", display: "flex", alignItems: "center",
          justifyContent: "space-between", padding: "6px 0",
          background: "none", border: "none", cursor: "pointer",
          fontSize: 12, fontWeight: 600, color: "var(--text-muted)",
          fontFamily: "var(--font-data)", textAlign: "left",
        }}
      >
        <span>
          {title}{" "}
          <span style={{ opacity: 0.6, fontWeight: 400 }}>({count})</span>
        </span>
        <span style={{ fontSize: 10, opacity: 0.6 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ maxHeight: 220, overflowY: "auto", paddingBottom: 6 }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── PlayoffLegend (floating, draggable) ───────────────────────────────────────

const LEGEND_EDGE_ITEMS = [
  { color: "#38bdf8", label: "Improves Odds" },
  { color: "#f97316", label: "Hurts Odds"    },
  { color: "#22c55e", label: "Win (selected)"},
  { color: "#ef4444", label: "Loss (selected)"},
  { color: "#6b7280", label: "Wins Over"     },
];

function PlayoffLegend({ pos, onDragStart, legendRef }: {
  pos: { x: number; y: number };
  onDragStart: (e: React.MouseEvent) => void;
  legendRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={legendRef}
      onMouseDown={onDragStart}
      style={{
        position: "absolute", left: pos.x, top: pos.y,
        zIndex: 10, cursor: "grab",
        background: "color-mix(in oklch, var(--surface) 92%, transparent)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "8px 10px",
        fontSize: 11,
        minWidth: 138,
        boxShadow: "0 2px 10px rgba(0,0,0,0.18)",
        userSelect: "none",
      }}
    >
      {/* Size */}
      <div style={legendHead}>SIZE</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--text-faint)", flexShrink: 0 }} />
        <span style={{ color: "var(--text-muted)", flex: 1, fontSize: 11 }}>Playoff Probability</span>
        <div style={{ width: 16, height: 16, borderRadius: "50%", background: "var(--text-muted)", flexShrink: 0 }} />
      </div>

      {/* Conference */}
      <div style={legendHead}>CONFERENCE</div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
        <div style={{ width: 13, height: 13, borderRadius: "50%", background: "#b91c1c",
          boxShadow: "0 0 0 3px rgba(239,68,68,0.4)", flexShrink: 0 }} />
        <span style={{ color: "var(--text-muted)" }}>AFC</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
        <div style={{ width: 13, height: 13, borderRadius: "50%", background: "#1d4ed8",
          boxShadow: "0 0 0 3px rgba(59,130,246,0.4)", flexShrink: 0 }} />
        <span style={{ color: "var(--text-muted)" }}>NFC</span>
      </div>

      {/* Edges */}
      <div style={legendHead}>EDGES</div>
      {LEGEND_EDGE_ITEMS.map(({ color, label }) => (
        <div key={label} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
          <div style={{ width: 16, height: 2.5, background: color, borderRadius: 1, flexShrink: 0 }} />
          <span style={{ color: "var(--text-muted)" }}>{label}</span>
        </div>
      ))}
    </div>
  );
}

const legendHead: React.CSSProperties = {
  fontWeight: 700, color: "var(--text-faint)", fontSize: 9,
  letterSpacing: "0.07em", marginBottom: 4, marginTop: 2,
};

// ── TeamPanel ─────────────────────────────────────────────────────────────────

interface TeamPanelProps {
  node: GraphNode;
  graphData: GraphData;
}

function TeamPanel({ node, graphData }: TeamPanelProps) {
  const teamColor = node.color ? `#${node.color}` : (node.conference === "AFC" ? "#dc2626" : "#2563eb");
  const seedBadgeColor = node.isFavorite ? "#f59e0b" : teamColor;

  const wins = graphData.edges
    .filter(e => e.type === "winsOver" && e.source === node.id)
    .sort((a, b) => a.week - b.week);
  const losses = graphData.edges
    .filter(e => e.type === "winsOver" && e.target === node.id)
    .sort((a, b) => a.week - b.week);
  const wlItems = [
    ...wins.map(e => ({ isWin: true,  opp: e.target.split(":").pop()!, week: e.week })),
    ...losses.map(e => ({ isWin: false, opp: e.source.split(":").pop()!, week: e.week })),
  ].sort((a, b) => a.week - b.week);

  const impactsOnTeam = graphData.edges
    .filter(e => e.target === node.id && e.type !== "winsOver")
    .sort((a, b) => b.recommendationScore - a.recommendationScore);

  const teamImpacts = graphData.edges
    .filter(e => e.source === node.id && e.type !== "winsOver")
    .sort((a, b) => b.recommendationScore - a.recommendationScore);

  return (
    <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", fontSize: 13 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{
          width: 36, height: 36, borderRadius: "50%",
          background: teamColor, color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontWeight: 800, fontSize: 12, flexShrink: 0,
        }}>
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
      <div style={{ marginBottom: 6 }}>
        <span style={{ color: "var(--text-muted)" }}>Status: </span>
        <strong style={{ textTransform: "capitalize" }}>
          {node.standingKind.replace("_", " ")}
        </strong>
      </div>

      {/* Wins & Losses */}
      <CollapsibleSection title="Wins &amp; Losses" count={wlItems.length}>
        {wlItems.length === 0 ? (
          <div style={{ color: "var(--text-faint)", fontSize: 11 }}>No results yet</div>
        ) : wlItems.map((item, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6,
            padding: "3px 0", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
            <span style={{ color: item.isWin ? "#22c55e" : "#ef4444",
              fontWeight: 700, fontSize: 11, width: 12 }}>
              {item.isWin ? "W" : "L"}
            </span>
            <span style={{ flex: 1 }}>
              {item.isWin ? "Beat" : "Lost to"} <strong>{item.opp}</strong>
            </span>
            <span style={{ color: "var(--text-faint)", fontSize: 11 }}>Wk {item.week}</span>
          </div>
        ))}
      </CollapsibleSection>

      {/* Impacts on this team */}
      <CollapsibleSection title="Impacts on Team" count={impactsOnTeam.length}>
        {impactsOnTeam.length === 0 ? (
          <div style={{ color: "var(--text-faint)", fontSize: 11 }}>No impacts this week</div>
        ) : impactsOnTeam.map(e => {
          const color = edgeTypeColor(e.type);
          return (
            <div key={e.id} style={{ display: "flex", alignItems: "flex-start", gap: 6,
              padding: "4px 0", borderBottom: "1px solid var(--border)", fontSize: 11 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: color,
                flexShrink: 0, marginTop: 2 }} />
              <span style={{ flex: 1, color: "var(--text-muted)", lineHeight: 1.4 }}>
                {e.reasoning}
              </span>
              {e.recommendationScore > 0 && (
                <span style={{ fontWeight: 700, color, fontSize: 11, flexShrink: 0 }}>
                  {e.recommendationScore}%
                </span>
              )}
            </div>
          );
        })}
      </CollapsibleSection>

      {/* This team's impacts on others */}
      <CollapsibleSection title="Impacts on Others" count={teamImpacts.length}>
        {teamImpacts.length === 0 ? (
          <div style={{ color: "var(--text-faint)", fontSize: 11 }}>No outgoing impacts this week</div>
        ) : teamImpacts.map(e => {
          const color = edgeTypeColor(e.type);
          return (
            <div key={e.id} style={{ display: "flex", alignItems: "flex-start", gap: 6,
              padding: "4px 0", borderBottom: "1px solid var(--border)", fontSize: 11 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: color,
                flexShrink: 0, marginTop: 2 }} />
              <span style={{ flex: 1, color: "var(--text-muted)", lineHeight: 1.4 }}>
                {e.reasoning}
              </span>
              {e.recommendationScore > 0 && (
                <span style={{ fontWeight: 700, color, fontSize: 11, flexShrink: 0 }}>
                  {e.recommendationScore}%
                </span>
              )}
            </div>
          );
        })}
      </CollapsibleSection>
    </div>
  );
}

// ── EdgeDetail ────────────────────────────────────────────────────────────────

function EdgeDetail({ edge }: { edge: GraphEdge }) {
  const src   = edge.source.split(":").pop() ?? "";
  const tgt   = edge.target.split(":").pop() ?? "";
  const color = edgeTypeColor(edge.type);

  const headline =
    edge.type === "winsOver"
      ? `${src} defeated ${tgt}`
      : edge.type === "improvesOdds"
        ? `${src} winning improves ${tgt}'s odds`
        : `${src} winning hurts ${tgt}'s odds`;

  return (
    <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: color,
          flexShrink: 0, marginTop: 3 }} />
        <div style={{ fontWeight: 700, lineHeight: 1.35 }}>{headline}</div>
      </div>
      {edge.type === "winsOver" ? (
        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Week {edge.week}</div>
      ) : (
        edge.recommendationScore > 0 && (
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 4 }}>
            Impact: <strong style={{ color }}>{edge.recommendationScore}%</strong>
          </div>
        )
      )}
      {edge.reasoning && (
        <div style={{ color: "var(--text-muted)", fontStyle: "italic", fontSize: 11, marginTop: 5 }}>
          {edge.reasoning}
        </div>
      )}
    </div>
  );
}

// ── ImpactChart ───────────────────────────────────────────────────────────────
// Left panel: mode selector. Right panel: scrollable SVG showing every game
// this week, colored by which team to root for relative to the selected node.

const MODES = [
  { key: "overall",       label: "Overall"  },
  { key: "division",      label: "Division" },
  { key: "wildcard",      label: "Wild Card"},
  { key: "conf_one_seed", label: "#1 Seed"  },
  { key: "tank",          label: "Tank"     },
] as const;

function ImpactChart({ graphData, selectedNodeId, mode, onModeChange }: {
  graphData: GraphData;
  selectedNodeId: string | null;
  mode: string;
  onModeChange: (m: string) => void;
}) {
  const CHART_H   = 100;
  const LABEL_H   = 18;  // just team abbr below bar
  const SCORE_PAD = 14;
  const BAR_W     = 36;
  const GAP       = 5;

  const teamColorMap = new Map(
    graphData.nodes.map(n => [n.abbreviation, n.color ? `#${n.color}` : "#6b7280"])
  );

  // Only use selected node — no fallback to favorite team
  const effectiveId   = selectedNodeId;
  const effectiveAbbr = effectiveId?.split(":").pop() ?? null;

  const gameImpacts = [...graphData.games].map(game => {
    const isOwnGame = effectiveAbbr != null &&
      (game.home === effectiveAbbr || game.away === effectiveAbbr);
    if (isOwnGame) {
      return { game, rootFor: effectiveAbbr!, score: 1.0, isOwnGame: true };
    }
    if (!effectiveId) return { game, rootFor: null as string | null, score: 0, isOwnGame: false };
    const edge = graphData.edges.find(
      e => e.gameId === game.id && e.target === effectiveId && e.type === "improvesOdds"
    );
    return {
      game,
      rootFor: edge ? edge.source.split(":").pop()! : null,
      score:   edge ? edge.impactScore : 0,
      isOwnGame: false,
    };
  }).sort((a, b) => b.score - a.score);

  const maxScore = Math.max(...gameImpacts.map(g => g.score), 0.01);
  const svgW = gameImpacts.length * (BAR_W + GAP) + GAP;
  const svgH = CHART_H + LABEL_H + SCORE_PAD;

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      {/* Mode selector */}
      <div style={{
        width: 82, flexShrink: 0, borderRight: "1px solid var(--border)",
        display: "flex", flexDirection: "column", gap: 3, padding: "6px 6px",
        overflowY: "auto",
      }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)",
          letterSpacing: "0.05em", marginBottom: 2 }}>
          MODE
        </div>
        {MODES.map(m => (
          <button
            key={m.key}
            onClick={() => onModeChange(m.key)}
            style={{
              padding: "5px 6px", borderRadius: 6,
              border: `1.5px solid ${mode === m.key ? "var(--accent, #3b82f6)" : "var(--border)"}`,
              background: mode === m.key ? "var(--accent, #3b82f6)" : "transparent",
              color: mode === m.key ? "#fff" : "var(--text-muted)",
              fontSize: 11, fontWeight: 600, cursor: "pointer",
              textAlign: "left" as const, fontFamily: "var(--font-data)",
              transition: "all 0.12s",
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Chart */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column",
        overflow: "hidden", padding: "6px 0 0 8px" }}>
        <div style={{ fontWeight: 700, fontSize: 11, marginBottom: 3,
          color: "var(--text-muted)", letterSpacing: "0.04em", flexShrink: 0 }}>
          THIS WEEK&apos;S GAME IMPACT
          {effectiveAbbr
            ? <span style={{ fontWeight: 400, opacity: 0.65 }}> · {effectiveAbbr}</span>
            : <span style={{ fontWeight: 400, opacity: 0.45 }}> · select a team</span>
          }
        </div>
        {gameImpacts.length === 0 ? (
          <div style={{ color: "var(--text-faint)", fontSize: 11, padding: 8 }}>
            No games scheduled
          </div>
        ) : (
          <div style={{ overflowX: "auto", overflowY: "hidden", flex: 1 }}>
            <svg width={svgW} height={svgH} style={{ display: "block" }}>
              {gameImpacts.map(({ game, rootFor, score }, i) => {
                const hasSelection = effectiveId != null;
                const barH  = hasSelection ? Math.max(4, (score / maxScore) * CHART_H) : 6;
                const x     = GAP + i * (BAR_W + GAP);
                const y     = CHART_H - barH;
                const lx    = x + BAR_W / 2;
                const ly    = CHART_H + 11;
                const color = (hasSelection && rootFor)
                  ? (teamColorMap.get(rootFor) ?? "#6b7280")
                  : "#4b5563";
                const pct   = (hasSelection && score > 0.005) ? `${Math.round(score * 100)}%` : "";
                const label = (hasSelection && rootFor) ? rootFor : "";
                return (
                  <g key={game.id}>
                    <rect x={x} y={y} width={BAR_W} height={barH} fill={color} rx={3} />
                    {pct && (
                      <text x={lx} y={y - 3} textAnchor="middle"
                        fontSize={8} fill="var(--text)">{pct}</text>
                    )}
                    {label && (
                      <text x={lx} y={ly} textAnchor="middle" fontSize={10} fontWeight="800"
                        fill={color}
                        style={{ filter: "drop-shadow(0 0 3px var(--surface)) drop-shadow(0 0 3px var(--surface))" }}>
                        {label}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        )}
      </div>
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
