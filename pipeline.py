"""
pipeline.py
───────────
End-to-end pipeline: fetch ESPN data → build holonic RDF graph → run queries → recommendations.

Quick start
──────────
    # Current week only, Bengals fan
    python pipeline.py --team CIN

    # Fast mode: only rooting recommendations, no extra output
    python pipeline.py --team CIN --full-season --fast

    # Specific week/season
    python pipeline.py --team CIN --week 14 --season 2025

    # Full season (all weeks up to current), with disk cache
    python pipeline.py --team CIN --full-season --season 2025

    # Full season through a specific week
    python pipeline.py --team CIN --full-season --through-week 14 --season 2025

    # Save full dataset to TriG
    python pipeline.py --team CIN --full-season --output holarchy.trig

    # Also write per-graph Turtle files
    python pipeline.py --team CIN --full-season --output holarchy.trig --dump-graphs

    # Dry-run: load from saved JSON (no network call, single week)
    python pipeline.py --team CIN --json-file espn_data.json

    # Force re-fetch even if cache exists
    python pipeline.py --team CIN --full-season --force-refresh
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

# ── adjust import path so builders/ modules resolve ──────────────────────────
sys.path.insert(0, str(Path(__file__).parent / "builders"))
sys.path.insert(0, str(Path(__file__).parent / "queries"))

from builders.espn_fetcher import (
    fetch_scoreboard, fetch_standings, fetch_standings_season,
    parse_scoreboard, parse_standings,
)
from builders.rdf_builder import NFLGraphBuilder, GRAPH
from builders.scenario_builder import ScenarioBuilder
from builders.season_ingester import SeasonIngester
from builders.recommendation_engine import RecommendationEngine, Mode
from builders.team_strength import computeAllTeamStrengths, print_strength_table
from queries.sparql_queries import (
    ALL_TEAMS, COMPLETED_GAMES, UPCOMING_GAMES, DIVISION_LEADERS,
    CURRENT_PLAYOFF_SEEDS, ALL_IMPACT_EDGES, LIST_ALL_HOLONS,
    ALL_ACTIVE_SCENARIOS, SCENARIOS_FOR_TEAM, DESTINY_CONTROL_GAMES,
    GAMES_BY_WEEK, WEEK_SEQUENCE, TEAM_FULL_SCHEDULE,
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
    elif args.fast:
        logging.getLogger().setLevel(logging.WARNING)

    builder = NFLGraphBuilder()

    ontology_dir = Path(__file__).parent / "ontology"
    if ontology_dir.exists():
        builder.load_ontologies(ontology_dir)

    all_games:       list[dict] = []
    parsed_standings: list[dict] = []
    current_week:    int | None  = None

    # ── 1. Ingest game data ───────────────────────────────────────────────────

    if args.full_season:
        # ── Full-season path ──────────────────────────────────────────────────
        season = args.season or _current_season()
        ingester = SeasonIngester(
            builder       = builder,
            season        = season,
            cache_dir     = args.cache_dir,
            force_refresh = args.force_refresh,
            sim_week      = args.sim_week,
        )
        ingester.ingest(
            from_week    = args.from_week,
            # In sim mode, fetch all weeks so the full schedule is visible;
            # the ingester blanks results for weeks >= sim_week.
            through_week = args.through_week if not args.sim_week else 18,
        )
        if args.postseason:
            ingester.ingest_postseason()
        ingester.write_temporal_edges()
        ingester.write_week_sequence_edges()
        if not args.fast:
            ingester.print_summary()

        all_games    = ingester.all_games()
        current_week = ingester.current_week()

        if args.sim_week:
            parsed_standings = ingester.compute_standings_from_games()
        else:
            parsed_standings = ingester.ingest_standings()

    else:
        # ── Single-week path ──────────────────────────────────────────────────
        if args.json_file:
            logger.info("Loading scoreboard from %s", args.json_file)
            with open(args.json_file) as f:
                raw_scoreboard = json.load(f)
        else:
            logger.info("Fetching NFL scoreboard from ESPN …")
            raw_scoreboard = fetch_scoreboard(week=args.week, season=args.season)
            if args.save_json:
                p = Path(args.save_json)
                p.write_text(json.dumps(raw_scoreboard, indent=2))
                logger.info("Raw ESPN JSON saved → %s", p)

        parsed = parse_scoreboard(raw_scoreboard)
        current_week = parsed["week"]
        all_games    = parsed["games"]

        builder.add_teams_from_scoreboard(parsed)
        builder.add_games(parsed)

        logger.info(
            "Season %d | %s | Week %d | %d games",
            parsed["season"], parsed["season_type"],
            parsed["week"],   len(parsed["games"]),
        )

        try:
            raw_standings    = fetch_standings()
            parsed_standings = parse_standings(raw_standings)
        except Exception as exc:
            logger.warning("Standings fetch failed (%s) — standings features disabled", exc)

    # ── 2. Enrich graph ───────────────────────────────────────────────────────

    if parsed_standings:
        builder.add_standings(parsed_standings)
        builder.add_teams_from_standings(parsed_standings)

    # Compute team strength scores (used as tiebreaker in game importance)
    strength_map = computeAllTeamStrengths(all_games, parsed_standings or [])
    if strength_map:
        builder.add_team_strengths(strength_map)
        if not args.fast:
            print_strength_table(strength_map, parsed_standings or [])

    # Resolve division tiebreakers before graph enrichment so everything
    # downstream (competition edges, seeds, scenarios) uses consistent ordering.
    div_tb_order: dict[str, list[str]] = {}
    if parsed_standings:
        div_tb_order = _resolve_division_tiebreakers(parsed_standings, all_games)

    builder.add_competition_edges(tiebreaker_order=div_tb_order)
    builder.add_impact_edges(strength_map=strength_map if strength_map else None)

    if parsed_standings:
        builder.add_playoff_spot_assignments(tiebreaker_order=div_tb_order)
        if div_tb_order:
            _emit_tiebreaker_rdf(div_tb_order, parsed_standings, all_games, builder)

    # ── 3. Scenario holons ────────────────────────────────────────────────────

    scenario_builder: ScenarioBuilder | None = None
    if parsed_standings:
        scenario_builder = ScenarioBuilder(
            dataset          = builder.dataset,
            standings        = parsed_standings,
            games            = all_games,
            tiebreaker_order = div_tb_order,
        )
        scenario_builder.generate_clinch_scenarios()
        scenario_builder.generate_elimination_scenarios()
        scenario_builder.link_scenarios_to_impact()

    # ── 4. Run SPARQL queries ─────────────────────────────────────────────────

    ds = builder.dataset

    if not args.fast:
        print_results(run_query(ds, ALL_TEAMS),              title="All Teams")
        print_results(run_query(ds, DIVISION_LEADERS),       title="Division Leaders")
        print_results(run_query(ds, ALL_IMPACT_EDGES),       title="All Impact Edges")
        print_results(run_query(ds, ALL_ACTIVE_SCENARIOS),   title="Active Playoff Scenarios")
        print_results(run_query(ds, DESTINY_CONTROL_GAMES),  title="Games That Control Destiny")
        print_results(run_query(ds, GAMES_BY_WEEK),          title="Games by Week")

        if args.full_season:
            print_results(run_query(ds, WEEK_SEQUENCE),      title="Week Graph Sequence")

        if parsed_standings:
            print_results(run_query(ds, CURRENT_PLAYOFF_SEEDS), title="Current Playoff Seeds")

        if args.team:
            print_results(
                run_query(ds, TEAM_FULL_SCHEDULE,
                          bindings={"team_iri": f"urn:nfl:team:{args.team.upper()}"}),
                title=f"{args.team.upper()} Full Schedule",
            )

    # ── 5. Recommendations ────────────────────────────────────────────────────

    if args.team:
        if scenario_builder and not args.fast:
            scenario_builder.print_scenarios(args.team)
            print_results(
                run_query(ds, SCENARIOS_FOR_TEAM,
                          bindings={"team_iri": f"urn:nfl:team:{args.team.upper()}"}),
                title=f"Scenarios — {args.team.upper()}",
            )

        # Fetch previous season standings for underdog resolution fallback
        prev_season_standings: list[dict] = []
        try:
            prev_season_year = (current_week and args.season or _current_season()) - 1
            raw_prev = fetch_standings_season(prev_season_year)
            prev_season_standings = parse_standings(raw_prev)
            logger.info(
                "Loaded %d teams from %d standings (underdog fallback)",
                len(prev_season_standings), prev_season_year,
            )
        except Exception as exc:
            logger.warning("Previous season standings unavailable (%s) — skipping underdog fallback", exc)

        engine = RecommendationEngine(
            dataset               = ds,
            favorite_team_abbr    = args.team,
            disliked_teams        = args.dislikes or [],
            prev_season_standings = prev_season_standings,
            current_week          = current_week,
            mode                  = args.mode or "overall",
        )
        # Show which modes are currently reachable
        avail = engine.available_modes()
        logger.info(
            "Available modes: %s",
            ", ".join(m.value for m in avail),
        )
        recs = engine.generate_recommendations()
        engine.print_recommendations(recs)
        engine.write_recommendations_to_graph(recs)

    # ── 6. Serialize ──────────────────────────────────────────────────────────

    if args.output:
        out = Path(args.output)
        builder.serialize(out)
        logger.info("Full dataset → %s", out)

        if args.dump_graphs:
            base = out.parent / "graphs"
            base.mkdir(exist_ok=True)
            for g in builder.dataset.graphs():
                gname = str(g.identifier).replace("urn:nfl:graph:", "").replace(":", "_")
                if gname and gname != "(default)":
                    builder.serialize_graph(
                        str(g.identifier),
                        base / f"{gname}.ttl",
                        fmt="turtle",
                    )

    logger.info("Pipeline complete.")


def _resolve_division_tiebreakers(
    parsed_standings: list[dict],
    all_games: list[dict],
) -> dict[str, list[str]]:
    """
    For every division, return teams ordered best-to-worst by the official NFL
    division tiebreaker.  Teams with different win percentages keep their
    record-based order; only same-pct groups are broken by the tiebreaker.

    Returns: {division_key: [abbr_rank1, abbr_rank2, …]}
    """
    from collections import defaultdict
    from tiebreaker import Team as TBTeam, Game as TBGame, resolve_division_tie

    tb_teams = [TBTeam.from_standings_dict(sd) for sd in parsed_standings]
    tb_games = [TBGame.from_dict(g) for g in all_games if g.get("status") == "post"]

    by_div: dict[str, list[TBTeam]] = defaultdict(list)
    for t in tb_teams:
        by_div[t.division].append(t)

    result: dict[str, list[str]] = {}
    for div, teams in by_div.items():
        by_pct: dict[float, list[TBTeam]] = defaultdict(list)
        for t in teams:
            by_pct[round(t.win_pct, 4)].append(t)

        ordered: list[str] = []
        for pct in sorted(by_pct.keys(), reverse=True):
            group = by_pct[pct]
            if len(group) > 1:
                resolved = resolve_division_tie(group, tb_games, tb_teams)
                ordered.extend(t.id for t in resolved)
            else:
                ordered.append(group[0].id)

        result[div] = ordered
        if any(len(g) > 1 for g in by_pct.values()):
            logger.info("Division tiebreaker %s: %s", div, ordered)

    return result


def _emit_tiebreaker_rdf(
    div_tb_order: dict[str, list[str]],
    parsed_standings: list[dict],
    all_games: list[dict],
    builder,
) -> None:
    """Write nfl:tiebreakOver / nfl:tiebreakReason triples for tied division groups."""
    from collections import defaultdict
    from tiebreaker import (
        Team as TBTeam, Game as TBGame,
        emit_tiebreaker_triples, resolve_with_reasons,
    )

    tb_teams  = [TBTeam.from_standings_dict(sd) for sd in parsed_standings]
    tb_games  = [TBGame.from_dict(g) for g in all_games if g.get("status") == "post"]
    team_map  = {t.id: t for t in tb_teams}

    by_div: dict[str, list[TBTeam]] = defaultdict(list)
    for t in tb_teams:
        by_div[t.division].append(t)

    for _, abbrs in div_tb_order.items():
        div_teams = [team_map[a] for a in abbrs if a in team_map]
        by_pct: dict[float, list[TBTeam]] = defaultdict(list)
        for t in div_teams:
            by_pct[round(t.win_pct, 4)].append(t)

        for group in by_pct.values():
            if len(group) > 1:
                ordered, reasons = resolve_with_reasons(
                    group, tb_games, tb_teams, "division"
                )
                emit_tiebreaker_triples(
                    ordered, reasons, builder.dataset, "division"
                )


def _current_season() -> int:
    """Best-guess current NFL season year."""
    from datetime import date
    today = date.today()
    # NFL seasons start in September; if we're before July treat as prior year's season
    return today.year if today.month >= 7 else today.year - 1


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Who2Root4 — NFL Holonic RDF Pipeline"
    )
    # Team
    p.add_argument("--team",          metavar="ABBR",
                   help="Your favorite team abbreviation (e.g. CIN, KC, BUF)")
    p.add_argument("--dislikes",      metavar="ABBR", nargs="*",
                   help="Teams you dislike (boosts recommendation score against them)")
    p.add_argument("--mode",
                   choices=["overall", "division", "wildcard", "conf_one_seed", "tank"],
                   default="overall",
                   help=(
                       "Recommendation mode: overall (default), division, wildcard, "
                       "conf_one_seed, or tank"
                   ))

    # Season scope
    p.add_argument("--full-season",   action="store_true",
                   help="Ingest all weeks of the season (uses disk cache)")
    p.add_argument("--postseason",    action="store_true",
                   help="Also ingest postseason rounds (Wild Card → Super Bowl)")
    p.add_argument("--season",        type=int,
                   help="Season year, e.g. 2025 (default: auto-detected)")
    p.add_argument("--week",          type=int,
                   help="Single week to fetch (default: current week)")
    p.add_argument("--from-week",     type=int, default=1,
                   help="First week to ingest in full-season mode (default: 1)")
    p.add_argument("--through-week",  type=int,
                   help="Last week to ingest in full-season mode (default: current)")
    p.add_argument("--sim-week",      type=int,
                   help="Simulate standing at this week: weeks >= sim-week are treated as not yet played")

    # Cache
    p.add_argument("--cache-dir",     metavar="PATH", default=".cache/espn",
                   help="Directory for ESPN JSON cache (default: .cache/espn)")
    p.add_argument("--force-refresh", action="store_true",
                   help="Re-fetch from ESPN even if cache exists")

    # Output
    p.add_argument("--output",        metavar="PATH",
                   help="Output path for serialised TriG dataset")
    p.add_argument("--dump-graphs",   action="store_true",
                   help="Also write individual named graphs as Turtle files")

    # Single-week helpers
    p.add_argument("--json-file",     metavar="PATH",
                   help="Load raw ESPN JSON from file instead of fetching (single week)")
    p.add_argument("--save-json",     metavar="PATH",
                   help="Save raw ESPN JSON to file after fetching (single week)")

    p.add_argument("--verbose", "-v", action="store_true",
                   help="Debug-level logging")
    p.add_argument("--fast",          action="store_true",
                   help="Only show rooting recommendations — skip all other output")
    return p.parse_args()


if __name__ == "__main__":
    main()
