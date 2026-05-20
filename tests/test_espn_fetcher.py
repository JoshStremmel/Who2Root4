"""
tests/test_espn_fetcher.py
───────────────────────────
Unit tests for espn_fetcher.parse_scoreboard() and parse_standings().
No network calls — all tests use fixtures.py mock data.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "builders"))
sys.path.insert(0, str(Path(__file__).parent))

import pytest
from fixtures import (
    REGULAR_SCOREBOARD,
    POSTSEASON_SCOREBOARD,
    COMPLETED_DIVISIONAL_EVENT,
    UPCOMING_DIVISIONAL_EVENT,
    LIVE_CONFERENCE_EVENT,
    make_raw_scoreboard,
    make_event,
)
from espn_fetcher import (
    parse_scoreboard,
    SEASON_TYPE_REGULAR,
    SEASON_TYPE_POSTSEASON,
    POSTSEASON_WEEKS,
    DIVISION_MAP,
    CONFERENCE_MAP,
)


# ── parse_scoreboard: basic structure ────────────────────────────────────────

class TestParseScoreboardStructure:

    def test_returns_required_keys(self):
        result = parse_scoreboard(REGULAR_SCOREBOARD)
        for key in ("season", "season_type", "season_type_id",
                    "week", "week_label", "is_postseason", "games"):
            assert key in result, f"Missing key: {key}"

    def test_season_year(self):
        result = parse_scoreboard(REGULAR_SCOREBOARD)
        assert result["season"] == 2025

    def test_week_number(self):
        result = parse_scoreboard(REGULAR_SCOREBOARD)
        assert result["week"] == 14

    def test_regular_season_type(self):
        result = parse_scoreboard(REGULAR_SCOREBOARD)
        assert result["season_type_id"] == SEASON_TYPE_REGULAR
        assert result["is_postseason"] is False
        assert result["week_label"] == "Week 14"

    def test_game_count(self):
        result = parse_scoreboard(REGULAR_SCOREBOARD)
        assert len(result["games"]) == 4

    def test_empty_events_returns_empty_games(self):
        raw = make_raw_scoreboard(events=[])
        result = parse_scoreboard(raw)
        assert result["games"] == []


# ── parse_scoreboard: postseason ─────────────────────────────────────────────

class TestParseScoreboardPostseason:

    def test_postseason_flag(self):
        result = parse_scoreboard(POSTSEASON_SCOREBOARD)
        assert result["is_postseason"] is True
        assert result["season_type_id"] == SEASON_TYPE_POSTSEASON

    def test_postseason_week_label(self):
        result = parse_scoreboard(POSTSEASON_SCOREBOARD)
        assert result["week_label"] == "Wild Card"

    def test_postseason_week_labels_map(self):
        for week_num, expected_label in POSTSEASON_WEEKS.items():
            raw = make_raw_scoreboard(
                week=week_num,
                season_type_id=3,
                season_type_name="Postseason",
                events=[],
            )
            result = parse_scoreboard(raw)
            assert result["week_label"] == expected_label

    def test_postseason_game_has_is_postseason_flag(self):
        result = parse_scoreboard(POSTSEASON_SCOREBOARD)
        assert len(result["games"]) == 1
        assert result["games"][0]["is_postseason"] is True


# ── parse_scoreboard: game dict fields ───────────────────────────────────────

class TestParseScoreboardGameFields:

    @pytest.fixture
    def games(self):
        return parse_scoreboard(REGULAR_SCOREBOARD)["games"]

    def test_game_has_required_fields(self, games):
        required = ("id", "name", "week", "season", "season_type",
                    "season_type_id", "is_postseason", "week_label",
                    "start_time", "status", "status_detail", "venue",
                    "home", "away", "home_score", "away_score",
                    "winner_abbr", "loser_abbr")
        for game in games:
            for field in required:
                assert field in game, f"Missing field '{field}' in game {game['id']}"

    def test_completed_game_has_winner(self, games):
        completed = next(g for g in games if g["status"] == "post")
        assert completed["winner_abbr"] == "BAL"
        assert completed["loser_abbr"]  == "CIN"

    def test_completed_game_scores(self, games):
        completed = next(g for g in games if g["status"] == "post")
        assert completed["home_score"] == 27
        assert completed["away_score"] == 17

    def test_upcoming_game_no_winner(self, games):
        upcoming = next(g for g in games if g["status"] == "pre")
        assert upcoming["winner_abbr"] is None
        assert upcoming["loser_abbr"]  is None

    def test_live_game_no_winner_yet(self, games):
        live = next(g for g in games if g["status"] == "in")
        assert live["winner_abbr"] is None

    def test_home_team_abbr(self, games):
        completed = next(g for g in games if g["status"] == "post")
        assert completed["home"]["abbr"] == "BAL"

    def test_away_team_abbr(self, games):
        completed = next(g for g in games if g["status"] == "post")
        assert completed["away"]["abbr"] == "CIN"

    def test_team_conference_populated(self, games):
        for game in games:
            for side in ("home", "away"):
                abbr = game[side]["abbr"]
                conf = game[side]["conference"]
                if abbr in CONFERENCE_MAP:
                    assert conf == CONFERENCE_MAP[abbr], \
                        f"{abbr} conference mismatch: {conf} != {CONFERENCE_MAP[abbr]}"

    def test_team_division_populated(self, games):
        for game in games:
            for side in ("home", "away"):
                abbr = game[side]["abbr"]
                div  = game[side]["division"]
                if abbr in DIVISION_MAP:
                    assert div == DIVISION_MAP[abbr], \
                        f"{abbr} division mismatch: {div} != {DIVISION_MAP[abbr]}"

    def test_tie_game_no_winner(self):
        tie_event = make_event(
            "tie01", "CIN", "PIT",
            "Cincinnati Bengals", "Pittsburgh Steelers",
            home_score=17, away_score=17,
            status_state="post", status_detail="Final",
        )
        raw = make_raw_scoreboard(events=[tie_event])
        result = parse_scoreboard(raw)
        game = result["games"][0]
        assert game["winner_abbr"] is None
        assert game["loser_abbr"]  is None


# ── Division / Conference map completeness ────────────────────────────────────

class TestDivisionConferenceMap:

    def test_all_32_teams_have_division(self):
        assert len(DIVISION_MAP) == 32, \
            f"Expected 32 teams in DIVISION_MAP, got {len(DIVISION_MAP)}"

    def test_all_32_teams_have_conference(self):
        assert len(CONFERENCE_MAP) == 32

    def test_afc_teams_are_afc(self):
        afc_teams = ["BAL","CIN","CLE","PIT","HOU","IND","JAX","TEN",
                     "BUF","MIA","NE","NYJ","DEN","KC","LV","LAC"]
        for abbr in afc_teams:
            assert CONFERENCE_MAP.get(abbr) == "AFC", f"{abbr} should be AFC"

    def test_nfc_teams_are_nfc(self):
        nfc_teams = ["CHI","DET","GB","MIN","ATL","CAR","NO","TB",
                     "DAL","NYG","PHI","WAS","ARI","LAR","SF","SEA"]
        for abbr in nfc_teams:
            assert CONFERENCE_MAP.get(abbr) == "NFC", f"{abbr} should be NFC"

    def test_each_division_has_4_teams(self):
        from collections import Counter
        counts = Counter(DIVISION_MAP.values())
        for div, count in counts.items():
            assert count == 4, f"{div} has {count} teams, expected 4"
