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
  color: string;        // hex without #
  logoUrl: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: "improvesOdds" | "hurtsOdds" | "neutral";
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
