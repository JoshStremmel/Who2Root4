"""
tests/test_season_ingester.py
──────────────────────────────
Unit tests for SeasonIngester — verifies caching, week loading,
temporal edge writing, and postseason ingestion.
Uses monkeypatching to avoid any real network calls.
"""

import sys
import json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "builders"))
sys.path.insert(0, str(Path(__file__).parent))

import pytest
from unittest.mock import patch, MagicMock

from fixtures import (
    REGULAR_SCOREBOARD, POSTSEASON_SCOREBOARD, STANDINGS,
    make_raw_scoreboard, make_event,
)
from espn_fetcher import parse_scoreboard, parse_standings
from rdf_builder import NFLGraphBuilder
from season_ingester import SeasonIngester


# ── Helpers ───────────────────────────────────────────────────────────────────

def make_multi_week_scoreboards(season=2025, num_weeks=3):
    """Generate a dict of week → raw scoreboard for patching."""
    boards = {}
    for week in range(1, num_weeks + 1):
        event = make_event(
            f"ev_{week}_1",
            "BAL", "CIN",
            "Baltimore Ravens", "Cincinnati Bengals",
            home_score=24 if week > 1 else None,
            away_score=17 if week > 1 else None,
            status_state="post" if week > 1 else "pre",
        )
        boards[week] = make_raw_scoreboard(season=season, week=week, events=[event])
    return boards


@pytest.fixture
def builder():
    return NFLGraphBuilder()


@pytest.fixture
def ingester(builder, tmp_path):
    return SeasonIngester(
        builder       = builder,
        season        = 2025,
        cache_dir     = tmp_path / "cache",
        request_delay = 0,   # no delay in tests
    )


@pytest.fixture
def multi_week_boards():
    return make_multi_week_scoreboards(num_weeks=3)


# ── Cache behaviour ───────────────────────────────────────────────────────────

class TestCacheBehaviour:

    def test_writes_cache_file_on_fetch(self, ingester, multi_week_boards, tmp_path):
        with patch("season_ingester.fetch_scoreboard",
                   side_effect=lambda week, season, season_type: multi_week_boards.get(week, {})):
            ingester.ingest(from_week=1, through_week=1)

        cache_files = list((tmp_path / "cache").glob("*.json"))
        assert len(cache_files) >= 1

    def test_reads_from_cache_on_second_call(self, ingester, multi_week_boards, tmp_path):
        with patch("season_ingester.fetch_scoreboard",
                   side_effect=lambda week, season, season_type: multi_week_boards.get(week, {})) as mock_fetch:
            ingester.ingest(from_week=1, through_week=1)
            call_count_first = mock_fetch.call_count

        # Second ingester uses same cache dir
        ingester2 = SeasonIngester(
            builder=NFLGraphBuilder(), season=2025,
            cache_dir=tmp_path / "cache", request_delay=0,
        )
        with patch("season_ingester.fetch_scoreboard") as mock_fetch2:
            ingester2.ingest(from_week=1, through_week=1)
            # Should NOT call fetch again — cache hit
            assert mock_fetch2.call_count == 0

    def test_force_refresh_bypasses_cache(self, tmp_path, multi_week_boards):
        b = NFLGraphBuilder()
        ing = SeasonIngester(
            builder=b, season=2025,
            cache_dir=tmp_path / "cache",
            request_delay=0,
            force_refresh=True,
        )
        with patch("season_ingester.fetch_scoreboard",
                   side_effect=lambda week, season, season_type: multi_week_boards.get(week, {})) as mock_fetch:
            ing.ingest(from_week=1, through_week=2)
            assert mock_fetch.call_count == 2

    def test_cache_files_named_correctly(self, ingester, multi_week_boards, tmp_path):
        with patch("season_ingester.fetch_scoreboard",
                   side_effect=lambda week, season, season_type: multi_week_boards.get(week, {})):
            ingester.ingest(from_week=1, through_week=2)

        cache_dir = tmp_path / "cache"
        assert (cache_dir / "scoreboard_2025_reg_w01.json").exists()
        assert (cache_dir / "scoreboard_2025_reg_w02.json").exists()


# ── Ingestion correctness ─────────────────────────────────────────────────────

class TestIngestionCorrectness:

    def test_weeks_loaded_tracked(self, ingester, multi_week_boards):
        with patch("season_ingester.fetch_scoreboard",
                   side_effect=lambda week, season, season_type: multi_week_boards.get(week, {})):
            ingester.ingest(from_week=1, through_week=3)
        assert ingester._weeks_loaded == [1, 2, 3]

    def test_all_games_accumulated(self, ingester, multi_week_boards):
        with patch("season_ingester.fetch_scoreboard",
                   side_effect=lambda week, season, season_type: multi_week_boards.get(week, {})):
            ingester.ingest(from_week=1, through_week=3)
        assert len(ingester.all_games()) == 3  # one game per week

    def test_team_schedule_populated(self, ingester, multi_week_boards):
        with patch("season_ingester.fetch_scoreboard",
                   side_effect=lambda week, season, season_type: multi_week_boards.get(week, {})):
            ingester.ingest(from_week=1, through_week=3)
        assert "BAL" in ingester._team_schedule
        assert "CIN" in ingester._team_schedule

    def test_stops_on_empty_week(self, ingester, multi_week_boards):
        # Week 4 returns empty scoreboard — should stop at week 3
        def side_effect(week, season, season_type):
            return multi_week_boards.get(week, make_raw_scoreboard(week=week, events=[]))

        with patch("season_ingester.fetch_scoreboard", side_effect=side_effect):
            ingester.ingest(from_week=1, through_week=5)

        assert ingester.current_week() == 3

    def test_from_week_respected(self, ingester, multi_week_boards):
        with patch("season_ingester.fetch_scoreboard",
                   side_effect=lambda week, season, season_type: multi_week_boards.get(week, {})):
            ingester.ingest(from_week=2, through_week=3)
        assert 1 not in ingester._weeks_loaded
        assert 2 in ingester._weeks_loaded


# ── Temporal edges ────────────────────────────────────────────────────────────

class TestTemporalEdges:

    def test_temporal_edges_written(self, ingester, multi_week_boards):
        with patch("season_ingester.fetch_scoreboard",
                   side_effect=lambda week, season, season_type: multi_week_boards.get(week, {})):
            ingester.ingest(from_week=1, through_week=3)
        ingester.write_temporal_edges()

        from rdf_builder import NFL
        g = ingester.builder._g_holarchy
        next_game_edges = list(g.subject_objects(NFL.nextGame))
        assert len(next_game_edges) > 0

    def test_previous_game_edges_written(self, ingester, multi_week_boards):
        with patch("season_ingester.fetch_scoreboard",
                   side_effect=lambda week, season, season_type: multi_week_boards.get(week, {})):
            ingester.ingest(from_week=1, through_week=3)
        ingester.write_temporal_edges()

        from rdf_builder import NFL
        g = ingester.builder._g_holarchy
        prev_edges = list(g.subject_objects(NFL.previousGame))
        assert len(prev_edges) > 0

    def test_depends_on_edges_written(self, ingester, multi_week_boards):
        with patch("season_ingester.fetch_scoreboard",
                   side_effect=lambda week, season, season_type: multi_week_boards.get(week, {})):
            ingester.ingest(from_week=1, through_week=3)
        ingester.write_temporal_edges()

        from rdf_builder import NFL
        g = ingester.builder._g_holarchy
        dep_edges = list(g.subject_objects(NFL.dependsOn))
        assert len(dep_edges) > 0

    def test_week_sequence_edges_written(self, ingester, multi_week_boards):
        with patch("season_ingester.fetch_scoreboard",
                   side_effect=lambda week, season, season_type: multi_week_boards.get(week, {})):
            ingester.ingest(from_week=1, through_week=3)
        ingester.write_week_sequence_edges()

        from rdf_builder import NFL, _week_graph_iri
        g = ingester.builder._g_holarchy
        w1_iri = _week_graph_iri(2025, 1, 2)   # regular season type = 2
        w2_iri = _week_graph_iri(2025, 2, 2)
        next_edges = list(g.objects(w1_iri, NFL.nextGame))
        assert w2_iri in next_edges


# ── Postseason ingestion ──────────────────────────────────────────────────────

class TestPostseasonIngestion:

    def test_postseason_ingest_runs(self, ingester):
        with patch("season_ingester.fetch_scoreboard",
                   return_value=POSTSEASON_SCOREBOARD):
            ingester.ingest_postseason()
        # offset weeks: 101=Wild Card
        assert any(w >= 100 for w in ingester._weeks_loaded)

    def test_postseason_games_in_all_games(self, ingester):
        with patch("season_ingester.fetch_scoreboard",
                   return_value=POSTSEASON_SCOREBOARD):
            ingester.ingest_postseason()
        games = ingester.all_games()
        assert len(games) >= 1
        assert any(g.get("is_postseason") for g in games)

    def test_postseason_cache_file_named_correctly(self, ingester, tmp_path):
        with patch("season_ingester.fetch_scoreboard",
                   return_value=POSTSEASON_SCOREBOARD):
            ingester.ingest_postseason()
        cache_dir = tmp_path / "cache"
        post_files = list(cache_dir.glob("*post*"))
        assert len(post_files) >= 1


# ── print_summary smoke test ──────────────────────────────────────────────────

class TestPrintSummary:

    def test_print_summary_no_raise(self, ingester, multi_week_boards, capsys):
        with patch("season_ingester.fetch_scoreboard",
                   side_effect=lambda week, season, season_type: multi_week_boards.get(week, {})):
            ingester.ingest(from_week=1, through_week=2)
        ingester.print_summary()
        captured = capsys.readouterr()
        assert "Season 2025" in captured.out
        assert "Total games" in captured.out
