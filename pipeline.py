"""
pipeline.py
───────────
Fetches ESPN scoreboard JSON for the current NFL season and caches it to
.cache/espn/ so the web app can read it from GitHub.

All calculations (standings, recommendations, scenarios, tiebreakers) are
handled client-side by src/engine.js — this script only fetches and caches data.

Quick start
──────────
    # Cache the current season
    python pipeline.py

    # Cache a specific season
    python pipeline.py --season 2025

    # Cache only through a specific week
    python pipeline.py --through-week 14

    # Also cache postseason rounds
    python pipeline.py --postseason

    # Force re-fetch even if cache exists
    python pipeline.py --force-refresh
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from builders.rdf_builder import NFLGraphBuilder
from builders.season_ingester import SeasonIngester

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


def _current_season() -> int:
    today = date.today()
    return today.year if today.month >= 7 else today.year - 1


def main() -> None:
    args = _parse_args()
    season = args.season or _current_season()

    logger.info("Fetching ESPN data for %d season → %s", season, args.cache_dir)

    builder = NFLGraphBuilder()
    ingester = SeasonIngester(
        builder=builder,
        season=season,
        cache_dir=args.cache_dir,
        force_refresh=args.force_refresh,
    )
    ingester.ingest(through_week=args.through_week)

    if args.postseason:
        ingester.ingest_postseason()

    logger.info("Done — cached to %s", args.cache_dir)


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Who2Root4 — ESPN data fetcher")
    p.add_argument("--season",        type=int,
                   help="Season year (default: auto-detected)")
    p.add_argument("--through-week",  type=int,
                   help="Cache only up to this week number (default: all available)")
    p.add_argument("--postseason",    action="store_true",
                   help="Also cache postseason rounds")
    p.add_argument("--cache-dir",     metavar="PATH", default=".cache/espn",
                   help="Directory for ESPN JSON cache (default: .cache/espn)")
    p.add_argument("--force-refresh", action="store_true",
                   help="Re-fetch from ESPN even if cache already exists")
    return p.parse_args()


if __name__ == "__main__":
    main()
