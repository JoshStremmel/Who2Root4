"""
api/server.py
─────────────
FastAPI server for Who2Root4.

Routes
──────
  GET /api/graph-data?team=CIN&week=1&season=2026
      Returns g3-toolkit-compatible graph JSON for the Graph View page.

  GET /           → serves index.html (existing static frontend)
  GET /graph      → serves graph/dist/index.html (Vite-built graph view)
  GET /static/*   → serves src/ directory (CSS, JSX, JS assets)

Run locally
───────────
  pip install fastapi uvicorn
  uvicorn api.server:app --reload --port 8000
"""

from __future__ import annotations

import logging
import re
import sys
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# ── Python path setup ─────────────────────────────────────────────────────────
# Make builders/ and queries/ importable without installing the project.
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "builders"))
sys.path.insert(0, str(ROOT / "queries"))

from builders.espn_fetcher import (
    CONFERENCE_MAP,
    DIVISION_MAP,
    fetch_scoreboard,
    fetch_standings,
    parse_scoreboard,
    parse_standings,
)
from builders.rdf_builder import GAME, GRAPH, IMPACT, NFL, OUTCOME, TEAM, NFLGraphBuilder
from builders.recommendation_engine import Mode, RecommendationEngine, RootingRecommendation
from queries.sparql_queries import ALL_IMPACT_EDGES, ALL_TEAMS, run_query

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s")
logger = logging.getLogger(__name__)

# ── Static team metadata ──────────────────────────────────────────────────────
# Brand hex colors (without #) and display names, keyed by ESPN abbreviation.
TEAM_META: dict[str, dict[str, str]] = {
    "ARI": {"color": "97233f", "name": "Cardinals",  "city": "Arizona"},
    "ATL": {"color": "a71930", "name": "Falcons",    "city": "Atlanta"},
    "BAL": {"color": "241773", "name": "Ravens",     "city": "Baltimore"},
    "BUF": {"color": "00338d", "name": "Bills",      "city": "Buffalo"},
    "CAR": {"color": "0085ca", "name": "Panthers",   "city": "Carolina"},
    "CHI": {"color": "0b162a", "name": "Bears",      "city": "Chicago"},
    "CIN": {"color": "fb4f14", "name": "Bengals",    "city": "Cincinnati"},
    "CLE": {"color": "311d00", "name": "Browns",     "city": "Cleveland"},
    "DAL": {"color": "003594", "name": "Cowboys",    "city": "Dallas"},
    "DEN": {"color": "fb4f14", "name": "Broncos",    "city": "Denver"},
    "DET": {"color": "0076b6", "name": "Lions",      "city": "Detroit"},
    "GB":  {"color": "203731", "name": "Packers",    "city": "Green Bay"},
    "HOU": {"color": "03202f", "name": "Texans",     "city": "Houston"},
    "IND": {"color": "002c5f", "name": "Colts",      "city": "Indianapolis"},
    "JAX": {"color": "006778", "name": "Jaguars",    "city": "Jacksonville"},
    "KC":  {"color": "e31837", "name": "Chiefs",     "city": "Kansas City"},
    "LAC": {"color": "0080c6", "name": "Chargers",   "city": "Los Angeles"},
    "LAR": {"color": "003594", "name": "Rams",       "city": "Los Angeles"},
    "LV":  {"color": "000000", "name": "Raiders",    "city": "Las Vegas"},
    "MIA": {"color": "008e97", "name": "Dolphins",   "city": "Miami"},
    "MIN": {"color": "4f2683", "name": "Vikings",    "city": "Minnesota"},
    "NE":  {"color": "002a5c", "name": "Patriots",   "city": "New England"},
    "NO":  {"color": "d3bc8d", "name": "Saints",     "city": "New Orleans"},
    "NYG": {"color": "0b2265", "name": "Giants",     "city": "New York"},
    "NYJ": {"color": "125740", "name": "Jets",       "city": "New York"},
    "PHI": {"color": "004c54", "name": "Eagles",     "city": "Philadelphia"},
    "PIT": {"color": "ffb612", "name": "Steelers",   "city": "Pittsburgh"},
    "SEA": {"color": "002244", "name": "Seahawks",   "city": "Seattle"},
    "SF":  {"color": "aa0000", "name": "49ers",      "city": "San Francisco"},
    "TB":  {"color": "d50a0a", "name": "Buccaneers", "city": "Tampa Bay"},
    "TEN": {"color": "19c6ff", "name": "Titans",     "city": "Tennessee"},
    "WAS": {"color": "5a1414", "name": "Commanders", "city": "Washington"},
}

ESPN_LOGO_URL = "https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/{abbr}.png"

# ── FastAPI app ───────────────────────────────────────────────────────────────

app = FastAPI(title="Who2Root4 Graph API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)


# ── Graph data endpoint ───────────────────────────────────────────────────────

@app.get("/api/graph-data")
async def get_graph_data(
    team: str = Query("CIN", description="Favorite team abbreviation"),
    week: Optional[int] = Query(None, description="Specific week (default: current)"),
    season: Optional[int] = Query(None, description="Season year (default: current)"),
) -> JSONResponse:
    """
    Build the RDF holonic dataset for the requested week/team and return a
    g3-toolkit-compatible graph JSON payload.
    """
    fav = team.upper()
    try:
        return JSONResponse(content=await _build_graph_payload(fav, week, season))
    except Exception as exc:
        logger.exception("Graph data build failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


async def _build_graph_payload(
    fav: str,
    week: Optional[int],
    season: Optional[int],
) -> dict[str, Any]:
    # ── 1. Fetch ESPN scoreboard ──────────────────────────────────────
    logger.info("Fetching scoreboard (week=%s season=%s)", week, season)
    raw_scoreboard = fetch_scoreboard(week=week, season=season)
    parsed = parse_scoreboard(raw_scoreboard)
    current_week: int = parsed["week"]
    current_season: int = season or parsed["season"]
    games: list[dict] = parsed["games"]
    season_type_id: int = parsed.get("season_type_id", 2)
    is_preseason: bool = season_type_id == 1

    # ── 2. Build holonic RDF graph ────────────────────────────────────
    builder = NFLGraphBuilder()
    ontology_dir = ROOT / "ontology"
    if ontology_dir.exists():
        builder.load_ontologies(ontology_dir)

    builder.add_teams_from_scoreboard(parsed)
    builder.add_games(parsed)

    # ── 3. Standings ──────────────────────────────────────────────────
    parsed_standings: list[dict] = []
    try:
        raw_standings = fetch_standings()
        parsed_standings = parse_standings(raw_standings)
        builder.add_standings(parsed_standings)
        builder.add_teams_from_standings(parsed_standings)
    except Exception as exc:
        logger.warning("Standings unavailable: %s", exc)

    builder.add_competition_edges()
    builder.add_impact_edges()

    if parsed_standings:
        builder.add_playoff_spot_assignments()

    ds = builder.dataset

    # ── 4. SPARQL queries ─────────────────────────────────────────────
    impact_rows = run_query(ds, ALL_IMPACT_EDGES)
    team_rows   = run_query(ds, ALL_TEAMS)

    # ── 5. Recommendations ────────────────────────────────────────────
    recs: list[RootingRecommendation] = []
    try:
        engine = RecommendationEngine(
            dataset=ds,
            favorite_team_abbr=fav,
            mode=Mode.OVERALL,
        )
        recs = engine.generate_recommendations()
        engine.write_recommendations_to_graph(recs)
    except Exception as exc:
        logger.warning("Recommendations unavailable: %s", exc)

    # ── 6. Shape response ─────────────────────────────────────────────
    return _shape_response(
        fav, current_week, current_season,
        games, team_rows, impact_rows, recs,
        parsed_standings, is_preseason,
    )


def _shape_response(
    fav: str,
    week: int,
    season: int,
    games: list[dict],
    team_rows: list[dict],
    impact_rows: list[dict],
    recs: list[RootingRecommendation],
    standings: list[dict],
    is_preseason: bool,
) -> dict[str, Any]:
    # Build standings lookup
    standings_map = {s["abbr"]: s for s in standings}

    # Collect team IRIs and names from SPARQL
    team_info: dict[str, dict] = {}  # iri → {name, division, conference}
    for row in team_rows:
        iri = row.get("team")
        if not iri:
            continue
        if iri not in team_info:
            team_info[iri] = {}
        for key in ("name", "division", "conference", "wins", "losses", "winPct"):
            if row.get(key):
                team_info[iri][key] = row[key]

    # Build node list
    nodes: list[dict] = []
    for iri, info in team_info.items():
        abbr = iri.split(":")[-1] if ":" in iri else iri
        meta = TEAM_META.get(abbr, {})
        sd   = standings_map.get(abbr, {})
        wins  = int(sd.get("wins", 0) or 0)
        losses = int(sd.get("losses", 0) or 0)
        nodes.append({
            "id":                iri,
            "label":             info.get("name") or meta.get("name") or abbr,
            "abbreviation":      abbr,
            "division":          _fmt_division(info.get("division") or DIVISION_MAP.get(abbr, "")),
            "conference":        _fmt_conference(info.get("conference") or CONFERENCE_MAP.get(abbr, "")),
            "wins":              wins,
            "losses":            losses,
            "playoffSeed":       sd.get("playoffSeed"),
            "playoffProbability":_playoff_prob(abbr, standings_map),
            "color":             meta.get("color", "888888"),
            "logoUrl":           ESPN_LOGO_URL.format(abbr=abbr.lower()),
        })

    # Build recommendation lookup by (root_for_abbr, against_abbr)
    rec_by_pair: dict[tuple[str, str], RootingRecommendation] = {}
    for rec in recs:
        rec_by_pair[(rec.root_for_abbr, rec.against_abbr)] = rec

    # Build edge list from impact rows
    edges: list[dict] = []
    seen_edge_keys: set[tuple[str, str, str]] = set()

    for row in impact_rows:
        outcome_iri  = row.get("outcome", "")
        impact_type  = row.get("impactType", "")
        affected_iri = row.get("team", "")
        score_str    = row.get("score")

        if not outcome_iri or not affected_iri:
            continue

        parsed_out = _parse_outcome_iri(outcome_iri)
        if not parsed_out:
            continue

        winner_abbr = parsed_out["winner"]
        loser_abbr  = parsed_out["home"] if parsed_out["winner"] == parsed_out["away"] else parsed_out["home"]
        # Correct: loser is whichever of home/away is not the winner
        if parsed_out["winner"] == parsed_out["home"]:
            loser_abbr = parsed_out["away"]
        else:
            loser_abbr = parsed_out["home"]

        winner_iri = f"urn:nfl:team:{winner_abbr}"
        loser_iri  = f"urn:nfl:team:{loser_abbr}"

        if "improvesOdds" in impact_type:
            # Winner's win improves affected team's odds
            # (affected = winner itself for improvesOdds)
            source_iri = winner_iri
            target_iri = affected_iri
            edge_type  = "improvesOdds"
        else:
            # Winner's win reduces affected team's odds
            source_iri = winner_iri
            target_iri = affected_iri
            edge_type  = "hurtsOdds"

        edge_key = (source_iri, target_iri, edge_type)
        if edge_key in seen_edge_keys:
            continue
        seen_edge_keys.add(edge_key)

        # Skip self-loops (a win always improves the winner's own odds —
        # not visually useful in the graph)
        if source_iri == target_iri:
            continue

        affected_abbr = affected_iri.split(":")[-1] if ":" in affected_iri else affected_iri
        rec = rec_by_pair.get((winner_abbr, affected_abbr)) or \
              rec_by_pair.get((loser_abbr, winner_abbr))

        impact_score = float(score_str) if score_str else 0.5
        game_suffix  = f"{parsed_out['season']}_W{parsed_out['week']:02d}_{parsed_out['away']}_{parsed_out['home']}"

        edges.append({
            "id":                  f"edge-{game_suffix}-{edge_type[:1].upper()}-{affected_abbr}",
            "source":              source_iri,
            "target":              target_iri,
            "type":                edge_type,
            "impactScore":         round(impact_score, 4),
            "week":                week,
            "gameId":              f"urn:nfl:game:{game_suffix}",
            "recommendationScore": int(round(rec.score * 100)) if rec else 0,
            "reasoning":           rec.reasoning if rec else "",
        })

    # Offseason / preseason: synthesise edges from scheduled game matchups
    # when no completed-game impact edges exist.
    if not edges and games:
        edges = _synthetic_edges_from_games(games, fav, week, standings_map)
        is_preseason = True

    return {
        "nodes": nodes,
        "edges": edges,
        "meta": {
            "favoriteTeam": fav,
            "week":         week,
            "season":       season,
            "isPreseason":  is_preseason,
            "gameCount":    len(games),
        },
    }


def _synthetic_edges_from_games(
    games: list[dict],
    fav: str,
    week: int,
    standings_map: dict[str, dict],
) -> list[dict]:
    """
    When no completed games exist, create estimated impact edges from the
    scheduled matchups.  Impact score is approximated from divisional
    relatedness.  Type is from the fav team's perspective.
    """
    edges: list[dict] = []
    fav_div  = DIVISION_MAP.get(fav, "")
    fav_conf = CONFERENCE_MAP.get(fav, "")

    for game in games:
        home_abbr = game["home"]["abbr"]
        away_abbr = game["away"]["abbr"]

        home_iri = f"urn:nfl:team:{home_abbr}"
        away_iri = f"urn:nfl:team:{away_abbr}"

        home_div  = DIVISION_MAP.get(home_abbr, "")
        away_div  = DIVISION_MAP.get(away_abbr, "")
        home_conf = CONFERENCE_MAP.get(home_abbr, "")
        away_conf = CONFERENCE_MAP.get(away_abbr, "")

        # Base importance
        if home_div == away_div:
            base = 1.0
        elif home_conf == away_conf:
            base = 0.75
        else:
            base = 0.5

        # Edge type from fav's perspective
        if home_abbr == fav or away_abbr == fav:
            edge_type = "neutral"
        elif (home_div == fav_div and home_conf == fav_conf) or \
             (away_div == fav_div and away_conf == fav_conf):
            edge_type = "improvesOdds"   # rival losing could help
        elif home_conf == fav_conf or away_conf == fav_conf:
            edge_type = "improvesOdds"
        else:
            edge_type = "neutral"

        game_id = game.get("id", f"{home_abbr}_{away_abbr}")
        edges.append({
            "id":                  f"edge-pre-{game_id}",
            "source":              home_iri,
            "target":              away_iri,
            "type":                edge_type,
            "impactScore":         round(base, 4),
            "week":                week,
            "gameId":              game_id,
            "recommendationScore": 0,
            "reasoning":           "Preseason projection — based on Vegas odds (no completed games yet)",
        })

    return edges


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_outcome_iri(iri: str) -> dict[str, Any] | None:
    """
    Parse  urn:nfl:outcome:2025_W01_CIN_BAL_CINWin
    into   {"season": 2025, "week": 1, "away": "CIN", "home": "BAL", "winner": "CIN"}
    """
    raw = iri.replace("urn:nfl:outcome:", "")
    # Outcome format: {SEASON}_W{NN}_{AWAY}_{HOME}_{WINNER}Win
    m = re.match(r"^(\d{4})_W(\d{2})_([A-Z]+)_([A-Z]+)_([A-Z]+)Win$", raw)
    if not m:
        return None
    return {
        "season": int(m.group(1)),
        "week":   int(m.group(2)),
        "away":   m.group(3),
        "home":   m.group(4),
        "winner": m.group(5),
    }


def _fmt_division(raw: str) -> str:
    """'AFCNorth' or 'urn:nfl:AFCNorth'  →  'AFC North'"""
    raw = raw.split(":")[-1] if ":" in raw else raw
    # Insert space before the last capital-followed-by-lower sequence
    # e.g. "AFCNorth" → "AFC North", "NFCSouth" → "NFC South"
    return re.sub(r"([A-Z][a-z]+)", r" \1", raw).strip()


def _fmt_conference(raw: str) -> str:
    """'urn:nfl:AFC' → 'AFC'"""
    return raw.split(":")[-1] if ":" in raw else raw


def _playoff_prob(abbr: str, standings_map: dict[str, dict]) -> float:
    """Rough playoff probability from win percentage (heuristic)."""
    sd = standings_map.get(abbr, {})
    wins   = float(sd.get("wins",   0) or 0)
    losses = float(sd.get("losses", 0) or 0)
    total  = wins + losses
    if total == 0:
        return 0.5
    win_pct = wins / total
    # Linear scale: 0% win_pct → 0.0 prob, 60%+ win_pct → 1.0 prob
    return round(min(1.0, max(0.0, (win_pct - 0.3) / 0.4)), 4)


# ── Static file serving ───────────────────────────────────────────────────────
# Mount only if directories exist (not available during unit tests).

_graph_dist = ROOT / "graph" / "dist"
_src_dir    = ROOT / "src"

if _graph_dist.exists():
    app.mount("/graph/assets", StaticFiles(directory=str(_graph_dist / "assets")), name="graph-assets")

    @app.get("/graph")
    async def serve_graph() -> FileResponse:
        return FileResponse(str(_graph_dist / "index.html"))

    @app.get("/graph/{path:path}")
    async def serve_graph_path(path: str) -> FileResponse:
        candidate = _graph_dist / path
        if candidate.exists():
            return FileResponse(str(candidate))
        return FileResponse(str(_graph_dist / "index.html"))

if _src_dir.exists():
    app.mount("/src", StaticFiles(directory=str(_src_dir)), name="src")

    @app.get("/")
    async def serve_root() -> FileResponse:
        return FileResponse(str(ROOT / "index.html"))
