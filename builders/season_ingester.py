"""
season_ingester.py
──────────────────
Ingests a full NFL season week-by-week from the ESPN API into the holonic
RDF dataset.

Features
────────
- Fetches weeks 1–18 (or 1–current week) with disk caching
- Writes each week into its own named graph: urn:nfl:graph:games:<season>:<week>
- Links game holons with nfl:nextGame / nfl:previousGame temporal edges
- Tracks per-team schedule order for sequential game chaining
- Respects a configurable rate-limit delay between requests
- Skips weeks that are fully cached unless --force-refresh is passed

Usage
─────
    from season_ingester import SeasonIngester
    from rdf_builder import NFLGraphBuilder

    builder = NFLGraphBuilder()
    ingester = SeasonIngester(builder, season=2025, cache_dir=".cache/espn")
    ingester.ingest(through_week=14)       # weeks 1–14
    ingester.write_temporal_edges()
    ingester.print_summary()
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

from rdflib import XSD, Literal, URIRef

from espn_fetcher import (
    fetch_scoreboard,
    fetch_postseason_scoreboard,
    parse_scoreboard,
    parse_standings,
    fetch_standings,
    SEASON_TYPE_REGULAR,
    SEASON_TYPE_POSTSEASON,
    POSTSEASON_WEEKS,
    POSTSEASON_WEEKS_COUNT,
)
from rdf_builder import (
    NFL, GRAPH,
    NFLGraphBuilder,
    _game_iri,
    _team_iri,
    _week_graph_iri,
)

logger = logging.getLogger(__name__)

NFL_REGULAR_SEASON_WEEKS = 18
DEFAULT_REQUEST_DELAY    = 1.2   # seconds between ESPN API calls


class SeasonIngester:
    """
    Orchestrates full-season ingestion into a NFLGraphBuilder dataset.
    """

    def __init__(
        self,
        builder:       NFLGraphBuilder,
        season:        int,
        cache_dir:     str | Path = ".cache/espn",
        request_delay: float = DEFAULT_REQUEST_DELAY,
        force_refresh: bool  = False,
        sim_week:      int | None = None,
    ) -> None:
        self.builder       = builder
        self.season        = season
        self.cache_dir     = Path(cache_dir)
        self.request_delay = request_delay
        self.force_refresh = force_refresh
        self.sim_week      = sim_week

        self.cache_dir.mkdir(parents=True, exist_ok=True)

        # week → list of parsed game dicts
        self._weeks_loaded:  list[int]         = []
        self._all_games:     list[dict]        = []
        # team_abbr → ordered list of game IRIs (chronological)
        self._team_schedule: dict[str, list[URIRef]] = {}

    # ── Public API ─────────────────────────────────────────────────────────────

    def ingest(
        self,
        through_week: int | None = None,
        from_week:    int = 1,
    ) -> None:
        """
        Fetch and load weeks from_week through through_week (inclusive).

        Parameters
        ----------
        through_week : last week to ingest. None = all 18 weeks.
        from_week    : first week to ingest (default 1).
        """
        end_week = through_week or NFL_REGULAR_SEASON_WEEKS

        logger.info(
            "Ingesting season %d weeks %d–%d …", self.season, from_week, end_week
        )

        for week in range(from_week, end_week + 1):
            parsed = self._load_week(week)
            if parsed is None:
                logger.info("Week %d: no data available yet, stopping.", week)
                break

            if self.sim_week is not None and week >= self.sim_week:
                parsed = self._blank_future_games(parsed)
                logger.debug("Week %02d: results blanked (sim mode, sim_week=%d)",
                             week, self.sim_week)

            games = parsed.get("games", [])
            if not games:
                logger.info("Week %d: empty scoreboard, skipping.", week)
                continue

            # Add teams and games into the dataset.
            # In sim mode, skip add_teams_from_scoreboard for blanked weeks —
            # ESPN's cached scoreboard carries real team records for those weeks,
            # which would overwrite the correctly-derived sim standings.
            if self.sim_week is None or week < self.sim_week:
                self.builder.add_teams_from_scoreboard(parsed)
            self.builder.add_games(parsed)

            # Track game IRIs per team for temporal linking
            for game in games:
                g_iri = _game_iri(game)
                for side in ("home", "away"):
                    abbr = game[side]["abbr"]
                    self._team_schedule.setdefault(abbr, []).append(g_iri)

            self._all_games.extend(games)
            self._weeks_loaded.append(week)

            logger.info(
                "Week %02d: loaded %d games (total so far: %d)",
                week, len(games), len(self._all_games),
            )

            # Polite delay between API calls
            if week < end_week:
                time.sleep(self.request_delay)

        logger.info(
            "Ingestion complete: %d weeks, %d games total",
            len(self._weeks_loaded), len(self._all_games),
        )

    def ingest_postseason(self) -> None:
        """
        Fetch and load all postseason rounds (Wild Card through Super Bowl).
        Postseason games are stored in week-scoped named graphs with
        week_label ("Wild Card", "Divisional", etc.) preserved in the
        interior facts.
        """
        logger.info("Ingesting postseason for season %d …", self.season)

        for week in range(1, POSTSEASON_WEEKS_COUNT + 1):
            parsed = self._load_week(week,
                                     season_type=SEASON_TYPE_POSTSEASON)
            if parsed is None:
                logger.debug("Postseason week %d: no data", week)
                continue

            games = parsed.get("games", [])
            if not games:
                logger.debug("Postseason week %d: empty, skipping", week)
                continue

            round_label = POSTSEASON_WEEKS.get(week, f"Postseason Week {week}")
            logger.info("Postseason week %d (%s): %d games",
                        week, round_label, len(games))

            self.builder.add_teams_from_scoreboard(parsed)
            self.builder.add_games(parsed)

            # Track in team schedule for temporal edges
            # Use offset weeks (100+) to keep postseason after regular season
            offset_week = 100 + week
            for game in games:
                from rdf_builder import _game_iri
                g_iri = _game_iri(game)
                for side in ("home", "away"):
                    abbr = game[side]["abbr"]
                    self._team_schedule.setdefault(abbr, []).append(g_iri)

            self._all_games.extend(games)
            self._weeks_loaded.append(offset_week)

        logger.info("Postseason ingestion complete.")

    def ingest_standings(self) -> list[dict]:
        """
        Fetch current standings, add to dataset, return parsed list.
        Cached as standings_<season>.json.
        """
        cache_path = self.cache_dir / f"standings_{self.season}.json"
        if not self.force_refresh and cache_path.exists():
            logger.info("Standings: loading from cache %s", cache_path)
            raw = json.loads(cache_path.read_text())
        else:
            logger.info("Standings: fetching from ESPN …")
            raw = fetch_standings()
            cache_path.write_text(json.dumps(raw, indent=2))
            time.sleep(self.request_delay)

        parsed = parse_standings(raw)
        self.builder.add_standings(parsed)
        self.builder.add_teams_from_standings(parsed)
        return parsed

    def write_temporal_edges(self) -> None:
        """
        Write nfl:nextGame and nfl:previousGame edges between consecutive
        game holons for each team's schedule.

        Also writes nfl:dependsOn edges between a game and the previous
        game involving any of the same teams (captures schedule context).
        """
        written = 0
        for abbr, game_iris in self._team_schedule.items():
            # game_iris is already in week order (ingestion order = chronological)
            for i in range(len(game_iris) - 1):
                current_iri = game_iris[i]
                next_iri    = game_iris[i + 1]

                # Write into the holarchy context graph
                g = self.builder._g_holarchy
                g.add((current_iri, NFL.nextGame,     next_iri))
                g.add((next_iri,    NFL.previousGame, current_iri))

                # nfl:dependsOn — next game "depends on" outcome of this one
                g.add((next_iri, NFL.dependsOn, current_iri))
                written += 1

        logger.info("Temporal edges written: %d nextGame/previousGame pairs", written)

    def write_week_sequence_edges(self) -> None:
        """
        Link week-level named graphs together in sequence:
          graph:games:<season>:<week> nfl:nextGame graph:games:<season>:<week+1>
        """
        g = self.builder._g_holarchy
        for i in range(len(self._weeks_loaded) - 1):
            this_week = self._weeks_loaded[i]
            next_week = self._weeks_loaded[i + 1]
            # Postseason weeks are stored with offset 100+
            this_type = 3 if this_week >= 100 else 2
            next_type = 3 if next_week >= 100 else 2
            this_real = this_week - 100 if this_week >= 100 else this_week
            next_real = next_week - 100 if next_week >= 100 else next_week
            this_iri  = _week_graph_iri(self.season, this_real, this_type)
            next_iri  = _week_graph_iri(self.season, next_real, next_type)
            g.add((this_iri, NFL.nextGame,     next_iri))
            g.add((next_iri, NFL.previousGame, this_iri))

        logger.info(
            "Week-sequence edges written for %d weeks", len(self._weeks_loaded)
        )

    def all_games(self) -> list[dict]:
        """Return all parsed game dicts loaded across all weeks."""
        return list(self._all_games)

    def current_week(self) -> int | None:
        """Return the current week (first unplayed in sim mode, last loaded otherwise)."""
        if self.sim_week is not None:
            return self.sim_week
        return self._weeks_loaded[-1] if self._weeks_loaded else None

    def print_summary(self) -> None:
        """Print a compact ingestion summary to stdout."""
        total    = len(self._all_games)
        complete = sum(1 for g in self._all_games if g.get("status") == "post")
        upcoming = sum(1 for g in self._all_games if g.get("status") == "pre")
        live     = sum(1 for g in self._all_games if g.get("status") == "in")

        print(f"\n{'='*55}")
        print(f"  Season {self.season} — Ingestion Summary")
        print(f"{'='*55}")
        print(f"  Weeks loaded : {self._weeks_loaded[0] if self._weeks_loaded else '—'}"
              f"–{self._weeks_loaded[-1] if self._weeks_loaded else '—'}"
              f"  ({len(self._weeks_loaded)} weeks)")
        print(f"  Total games  : {total}")
        print(f"    Completed  : {complete}")
        print(f"    Upcoming   : {upcoming}")
        print(f"    Live       : {live}")
        print(f"  Teams tracked: {len(self._team_schedule)}")
        print()

    def compute_standings_from_games(self) -> list[dict]:
        """
        Derive standings from completed games loaded so far.
        Used in simulation mode so standings reflect the simulated point in time
        rather than the live ESPN standings endpoint.
        """
        from espn_fetcher import DIVISION_MAP, CONFERENCE_MAP

        records: dict[str, dict] = {}

        for game in self._all_games:
            if game["status"] != "post":
                continue
            for side, opp_side in [("home", "away"), ("away", "home")]:
                team = game[side]
                abbr = team["abbr"]
                if abbr not in records:
                    records[abbr] = {
                        "abbr": abbr,
                        "name": team["name"],
                        "wins": 0, "losses": 0, "ties": 0,
                        "points_for": 0, "points_against": 0,
                    }
                r = records[abbr]
                r["points_for"]     += game.get(f"{side}_score") or 0
                r["points_against"] += game.get(f"{opp_side}_score") or 0
                if game["winner_abbr"] == abbr:
                    r["wins"] += 1
                elif game["loser_abbr"] == abbr:
                    r["losses"] += 1
                elif game["winner_abbr"] is None:
                    r["ties"] += 1

        result = []
        for abbr, r in records.items():
            total = r["wins"] + r["losses"] + r["ties"]
            win_pct = round((r["wins"] + 0.5 * r["ties"]) / total, 4) if total else 0.0
            result.append({
                **r,
                "win_pct"  : win_pct,
                "division" : DIVISION_MAP.get(abbr, ""),
                "conference": CONFERENCE_MAP.get(abbr, ""),
            })

        logger.info(
            "Computed standings from completed games: %d teams", len(result)
        )
        return result

    def _blank_future_games(self, parsed: dict) -> dict:
        """Return a copy of a parsed scoreboard with all game results stripped."""
        blanked_games = []
        for game in parsed.get("games", []):
            blanked_games.append({
                **game,
                "status"      : "pre",
                "status_detail": "Scheduled",
                "home_score"  : None,
                "away_score"  : None,
                "winner_abbr" : None,
                "loser_abbr"  : None,
            })
        return {**parsed, "games": blanked_games}

    # ── Cache helpers ─────────────────────────────────────────────────────────

    def _cache_path(self, week: int,
                    season_type: int = SEASON_TYPE_REGULAR) -> Path:
        suffix = "post" if season_type == SEASON_TYPE_POSTSEASON else "reg"
        return self.cache_dir / f"scoreboard_{self.season}_{suffix}_w{week:02d}.json"

    def _load_week(self, week: int,
                   season_type: int = SEASON_TYPE_REGULAR) -> dict[str, Any] | None:
        """
        Return a parsed scoreboard dict for the given week and season type.
        Uses disk cache if available and not force-refreshing.
        Returns None if ESPN returns an empty/future week.
        """
        path = self._cache_path(week, season_type)

        if not self.force_refresh and path.exists():
            logger.debug("Week %02d (type %d): cache hit %s", week, season_type, path)
            raw = json.loads(path.read_text())
        else:
            logger.debug("Week %02d (type %d): fetching from ESPN …",
                         week, season_type)
            try:
                raw = fetch_scoreboard(week=week, season=self.season,
                                       season_type=season_type)
            except Exception as exc:
                logger.warning("Week %02d (type %d): fetch failed (%s)",
                               week, season_type, exc)
                return None
            path.write_text(json.dumps(raw, indent=2))

        parsed = parse_scoreboard(raw)

        if not parsed.get("games"):
            return None

        return parsed
