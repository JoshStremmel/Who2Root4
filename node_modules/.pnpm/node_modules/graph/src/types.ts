/** Shape of the /api/graph-data response. */

export interface GraphNode {
  id: string;
  label: string;
  abbreviation: string;
  division: string;
  conference: string;
  wins: number;
  losses: number;
  playoffSeed: number | null;
  playoffProbability: number;
  color: string;              // hex without # (kept for reference, not used in graph colors)
  standingKind: "division_leader" | "wildcard" | "in_hunt" | "eliminated";
  nodeLabel: string;          // abbreviation + optional seed, e.g. "CIN\n#3"
  isFavorite: boolean;
  is1SeedContender: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: "improvesOdds" | "hurtsOdds" | "winsOver";
  impactScore: number;
  week: number;
  gameId: string;
  recommendationScore: number;
  reasoning: string;
}

export interface GraphMeta {
  favoriteTeam: string;
  week: number;
  season: number;
  isPreseason: boolean;
  gameCount: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: GraphMeta;
}
