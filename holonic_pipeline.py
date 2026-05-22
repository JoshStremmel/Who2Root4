"""
holonic_pipeline.py
────────────────────
End-to-end pipeline using the holonic library's HolonicDataset.

This replaces pipeline.py for production use. The raw-rdflib pipeline.py
remains available for comparison / offline use without the holonic package.

Quick start
───────────
    # Current week, Bengals fan
    python holonic_pipeline.py --team CIN

    # Full season with disk cache
    python holonic_pipeline.py --team CIN --full-season --season 2025

    # Save to TriG
    python holonic_pipeline.py --team CIN --full-season --output holarchy.trig

    # Use Fuseki instead of in-memory rdflib
    python holonic_pipeline.py --team CIN --fuseki http://localhost:3030/nfl
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

# ── import path ───────────────────────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent / "builders"))
sys.path.insert(0, str(Path(__file__).parent / "queries"))

from holonic import HolonicDataset

from builders.espn_fetcher import (
    fetch_scoreboard, fetch_standings,
    parse_scoreboard, parse_standings,
)
from builders.holonic_builder import NFLHolonicBuilder, _team_iri
from builders.membrane_validator import MembraneValidator
from builders.scenario_builder import ScenarioBuilder
from builders.season_ingester import SeasonIngester
from builders.rdf_builder import NFLGraphBuilder       # still used for SPARQL layer
from builders.recommendation_engine import RecommendationEngine
from queries.sparql_queries import (
    ALL_TEAMS, COMPLETED_GAMES, UPCOMING_GAMES, DIVISION_LEADERS,
    CURRENT_PLAYOFF_SEEDS, ALL_IMPACT_EDGES,
    ALL_ACTIVE_SCENARIOS, SCENARIOS_FOR_TEAM, DESTINY_CONTROL_GAMES,
    GAMES_BY_WEEK, TEAM_FULL_SCHEDULE,
    run_query, print_results,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


def main() -> None:
    args = _parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # ── 1. Initialise HolonicDataset ──────────────────────────────────────────
    if args.fuseki:
        from holonic.backends import FusekiBackend
        backend = FusekiBackend(args.fuseki)
        ds = HolonicDataset(backend=backend, metadata_updates="off")
        logger.info("Using Fuseki backend: %s", args.fuseki)
    else:
        ds = HolonicDataset(metadata_updates="off")
        logger.info("Using in-memory rdflib backend")

    holonic_builder = NFLHolonicBuilder(ds)

    # ── 2. Build structural skeleton ──────────────────────────────────────────
    holonic_builder.build_structure()

    # ── 3. Fetch + ingest game data ───────────────────────────────────────────
    all_games:       list[dict] = []
    parsed_standings: list[dict] = []
    team_schedule:   dict[str, list[str]] = {}

    if args.full_season:
        # Full-season: use SeasonIngester for caching + temporal edges,
        # then mirror into HolonicDataset via holonic_builder
        season = args.season or _current_season()

        # We still need the rdflib builder for the SeasonIngester internals
        raw_builder = NFLGraphBuilder()
        ingester = SeasonIngester(
            builder       = raw_builder,
            season        = season,
            cache_dir     = args.cache_dir,
            force_refresh = args.force_refresh,
        )
        ingester.ingest(
            from_week    = args.from_week,
            through_week = args.through_week,
        )
        if args.postseason:
            ingester.ingest_postseason()
        ingester.print_summary()

        all_games    = ingester.all_games()
        team_schedule = ingester._team_schedule  # abbr → [game_iris]

        # Mirror into holonic
        parsed_standings = ingester.ingest_standings()
        holonic_builder.add_teams(parsed_standings)

        # Batch-add all games week by week
        seasons_weeks: dict[tuple, list[dict]] = {}
        for game in all_games:
            key = (game["season"], game["week"])
            seasons_weeks.setdefault(key, []).append(game)

        for (season_yr, week), games in sorted(seasons_weeks.items()):
            fake_parsed = {
                "season"     : season_yr,
                "week"       : week,
                "season_type": games[0].get("season_type", "Regular Season"),
                "games"      : games,
            }
            holonic_builder.add_games(fake_parsed)

        # Convert rdflib game IRI objects to plain strings for temporal edges
        str_schedule = {
            abbr: [str(iri) for iri in iris]
            for abbr, iris in team_schedule.items()
        }
        holonic_builder.write_temporal_edges(str_schedule)

    else:
        # Single-week path
        if args.json_file:
            logger.info("Loading scoreboard from %s", args.json_file)
            with open(args.json_file) as f:
                raw_scoreboard = json.load(f)
        else:
            logger.info("Fetching NFL scoreboard from ESPN …")
            raw_scoreboard = fetch_scoreboard(week=args.week, season=args.season)
            if args.save_json:
                Path(args.save_json).write_text(json.dumps(raw_scoreboard, indent=2))

        parsed = parse_scoreboard(raw_scoreboard)
        all_games = parsed["games"]

        logger.info(
            "Season %d | %s | Week %d | %d games",
            parsed["season"], parsed["season_type"],
            parsed["week"], len(parsed["games"]),
        )

        try:
            parsed_standings = parse_standings(fetch_standings())
            holonic_builder.add_teams(parsed_standings)
        except Exception as exc:
            logger.warning("Standings unavailable (%s) — using scoreboard teams", exc)
            holonic_builder.add_teams_from_scoreboard(parsed)
            parsed_standings = []

        holonic_builder.add_games(parsed)

    # ── 4. Portals ────────────────────────────────────────────────────────────
    holonic_builder.add_competition_portals()
    holonic_builder.add_impact_portals(all_games)

    # ── 5. Scenarios ──────────────────────────────────────────────────────────
    scenario_builder: ScenarioBuilder | None = None
    if parsed_standings:
        # ScenarioBuilder still uses raw rdflib internally for its reasoning
        raw_builder_for_scenarios = NFLGraphBuilder()
        raw_builder_for_scenarios.add_standings(parsed_standings)

        scenario_builder = ScenarioBuilder(
            dataset   = raw_builder_for_scenarios.dataset,
            standings = parsed_standings,
            games     = all_games,
        )
        scenario_builder.generate_clinch_scenarios()
        scenario_builder.generate_elimination_scenarios()
        holonic_builder.add_scenario_holons(scenario_builder._scenarios)

    # ── 6. Flush metadata ─────────────────────────────────────────────────────
    logger.info("Refreshing holonic metadata …")
    ds.refresh_all_metadata()
    logger.info("Metadata refresh complete.")

    # ── 7. Membrane validation ─────────────────────────────────────────────────
    shapes_path = Path(__file__).parent / "ontology" / "nfl-shapes.ttl"
    if shapes_path.exists():
        validator = MembraneValidator(ds, shapes_path=shapes_path)
        validator.install_shapes()
        if args.validate:
            report = validator.validate_all()
            validator.print_report(report)
        elif args.team:
            validator.print_team_health(args.team)

    # ── 7. Summary via holonic API ────────────────────────────────────────────
    print(ds.summary())

    # List all holons
    holons = ds.list_holons_summary()
    print(f"\n  Total holons registered: {len(holons)}")
    for h in sorted(holons, key=lambda x: x.label or ""):
        print(f"    {h.label:35s}  {h.iri}")

    # List portals
    portals = ds.list_portals()
    print(f"\n  Total portals registered: {len(portals)}")

    # ── 8. Scenarios (printed from scenario_builder) ──────────────────────────
    if scenario_builder and args.team:
        scenario_builder.print_scenarios(args.team)

    # ── 9. Recommendations (via SPARQL over holonic store) ────────────────────
    if args.team and parsed_standings:
        # The recommendation engine queries the HolonicDataset's underlying
        # rdflib store directly — its SPARQL patterns target the interior
        # named graphs which HolonicDataset writes to the same rdflib.Dataset
        try:
            from holonic.backends import RdflibBackend
            underlying_ds = ds.backend._ds  # rdflib.Dataset
            engine = RecommendationEngine(
                dataset            = underlying_ds,
                favorite_team_abbr = args.team,
                disliked_teams     = args.dislikes or [],
            )
            recs = engine.generate_recommendations()
            engine.print_recommendations(recs)
        except AttributeError:
            logger.warning(
                "Could not access underlying rdflib dataset for recommendations. "
                "Use pipeline.py for recommendation queries with non-rdflib backends."
            )

    if args.team:
        # Neighborhood view
        team_holon_iri = _team_iri(args.team.upper())
        try:
            neighborhood = ds.holon_neighborhood(team_holon_iri, depth=2)
            print(f"\n  Neighborhood of {args.team.upper()} (depth=2):")
            print(f"    Nodes : {len(neighborhood.nodes)}")
            print(f"    Edges : {len(neighborhood.edges)}")
        except Exception as exc:
            logger.debug("Neighborhood query skipped: %s", exc)

    # ── 10. Serialize ──────────────────────────────────────────────────────────
    if args.output:
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        ds.export(str(out), format="trig")
        logger.info("Dataset exported → %s", out)

    logger.info("Holonic pipeline complete.")


def _current_season() -> int:
    from datetime import date
    today = date.today()
    return today.year if today.month >= 7 else today.year - 1


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Who2Root4 — Holonic NFL Pipeline (HolonicDataset)"
    )
    p.add_argument("--team",          metavar="ABBR")
    p.add_argument("--dislikes",      metavar="ABBR", nargs="*")
    p.add_argument("--full-season",   action="store_true")
    p.add_argument("--postseason",    action="store_true",
                   help="Also ingest postseason rounds")
    p.add_argument("--season",        type=int)
    p.add_argument("--week",          type=int)
    p.add_argument("--from-week",     type=int, default=1)
    p.add_argument("--through-week",  type=int)
    p.add_argument("--cache-dir",     default=".cache/espn")
    p.add_argument("--force-refresh", action="store_true")
    p.add_argument("--output",        metavar="PATH")
    p.add_argument("--json-file",     metavar="PATH")
    p.add_argument("--save-json",     metavar="PATH")
    p.add_argument("--fuseki",        metavar="URL",
                   help="Fuseki endpoint URL (e.g. http://localhost:3030/nfl)")
    p.add_argument("--validate",      action="store_true",
                   help="Run full SHACL membrane validation after build")
    p.add_argument("--verbose", "-v", action="store_true")
    return p.parse_args()


if __name__ == "__main__":
    main()
