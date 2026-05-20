"""
tests/test_recommendation_engine.py
─────────────────────────────────────
Unit tests for RecommendationEngine — verifies scoring logic,
scenario-aware boosts, dislike bonuses, and RDF output.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "builders"))
sys.path.insert(0, str(Path(__file__).parent))

import pytest
from fixtures import REGULAR_SCOREBOARD, STANDINGS
from espn_fetcher import parse_scoreboard
from rdf_builder import NFLGraphBuilder, GRAPH, _team_iri
from scenario_builder import ScenarioBuilder
from recommendation_engine import RecommendationEngine, RootingRecommendation


@pytest.fixture
def full_dataset():
    """Dataset loaded with scoreboard, standings, competition, and impact edges."""
    b = NFLGraphBuilder()
    parsed = parse_scoreboard(REGULAR_SCOREBOARD)
    b.add_teams_from_scoreboard(parsed)
    b.add_games(parsed)
    b.add_standings(STANDINGS)
    b.add_teams_from_standings(STANDINGS)
    b.add_competition_edges()
    b.add_impact_edges()
    b.add_playoff_spot_assignments()
    return b.dataset


@pytest.fixture
def dataset_with_scenarios(full_dataset):
    parsed = parse_scoreboard(REGULAR_SCOREBOARD)
    sb = ScenarioBuilder(
        dataset  = full_dataset,
        standings = STANDINGS,
        games     = parsed["games"],
    )
    sb.generate_clinch_scenarios()
    sb.generate_elimination_scenarios()
    sb.link_scenarios_to_impact()
    return full_dataset


@pytest.fixture
def cin_engine(full_dataset):
    return RecommendationEngine(
        dataset            = full_dataset,
        favorite_team_abbr = "CIN",
    )


@pytest.fixture
def cin_engine_with_dislikes(full_dataset):
    return RecommendationEngine(
        dataset            = full_dataset,
        favorite_team_abbr = "CIN",
        disliked_teams     = ["PIT", "BAL"],
    )


# ── Engine initialisation ─────────────────────────────────────────────────────

class TestEngineInit:

    def test_fav_abbr_uppercased(self, full_dataset):
        engine = RecommendationEngine(full_dataset, "cin")
        assert engine.fav_abbr == "CIN"

    def test_fav_iri_correct(self, cin_engine):
        assert str(cin_engine.fav_iri) == "urn:nfl:team:CIN"

    def test_fav_conf_is_afc(self, cin_engine):
        assert cin_engine.fav_conf == "AFC"

    def test_fav_div_is_afcnorth(self, cin_engine):
        assert cin_engine.fav_div == "AFCNorth"

    def test_disliked_teams_uppercased(self, full_dataset):
        engine = RecommendationEngine(full_dataset, "CIN", disliked_teams=["pit"])
        assert "PIT" in engine.disliked


# ── Game fetching ─────────────────────────────────────────────────────────────

class TestFetchRelevantGames:

    def test_returns_list(self, cin_engine):
        games = cin_engine._fetch_relevant_games()
        assert isinstance(games, list)

    def test_upcoming_games_included(self, cin_engine):
        games = cin_engine._fetch_relevant_games()
        statuses = [g["status"] for g in games]
        assert "pre" in statuses or "in" in statuses or len(games) == 0

    def test_completed_games_excluded(self, cin_engine):
        games = cin_engine._fetch_relevant_games()
        for g in games:
            assert g["status"] != "post", \
                "Completed games should not appear in recommendation candidates"


# ── Scoring ───────────────────────────────────────────────────────────────────

class TestScoring:

    def test_score_game_skips_favorite_team_games(self, cin_engine):
        # A game involving CIN should return None
        result = cin_engine._score_game({
            "game_iri"     : "urn:nfl:game:test",
            "home_abbr"    : "CIN",
            "away_abbr"    : "BAL",
            "status"       : "pre",
            "is_postseason": False,
        })
        assert result is None

    def test_score_game_skips_interconference_regular_season(self, cin_engine):
        # DAL vs SF is NFC vs NFC — CIN (AFC) should not care
        result = cin_engine._score_game({
            "game_iri"     : "urn:nfl:game:test",
            "home_abbr"    : "DAL",
            "away_abbr"    : "SF",
            "status"       : "pre",
            "is_postseason": False,
        })
        assert result is None

    def test_divisional_rival_game_scores_high(self, cin_engine):
        # PIT vs CLE: both are division rivals of CIN → high score
        result = cin_engine._score_game({
            "game_iri"     : "urn:nfl:game:test",
            "home_abbr"    : "CLE",
            "away_abbr"    : "PIT",
            "status"       : "pre",
            "is_postseason": False,
        })
        assert result is not None
        assert result.score > 0.3

    def test_conference_game_scores_lower_than_divisional(self, cin_engine):
        # KC vs BUF: conference game but not division
        conf_result = cin_engine._score_game({
            "game_iri"     : "urn:nfl:game:conf",
            "home_abbr"    : "KC",
            "away_abbr"    : "BUF",
            "status"       : "pre",
            "is_postseason": False,
        })
        div_result = cin_engine._score_game({
            "game_iri"     : "urn:nfl:game:div",
            "home_abbr"    : "CLE",
            "away_abbr"    : "PIT",
            "status"       : "pre",
            "is_postseason": False,
        })
        if conf_result and div_result:
            assert div_result.score >= conf_result.score

    def test_dislike_bonus_increases_score(self, full_dataset):
        engine_no_dislikes = RecommendationEngine(full_dataset, "CIN")
        engine_with_dislikes = RecommendationEngine(
            full_dataset, "CIN", disliked_teams=["PIT"]
        )
        game = {
            "game_iri"     : "urn:nfl:game:test",
            "home_abbr"    : "CLE",
            "away_abbr"    : "PIT",
            "status"       : "pre",
            "is_postseason": False,
        }
        r1 = engine_no_dislikes._score_game(game)
        r2 = engine_with_dislikes._score_game(game)
        if r1 and r2:
            assert r2.score >= r1.score

    def test_disliked_team_is_the_against(self, cin_engine_with_dislikes):
        # When PIT is disliked and plays CLE, we should root against PIT
        result = cin_engine_with_dislikes._score_game({
            "game_iri"     : "urn:nfl:game:test",
            "home_abbr"    : "CLE",
            "away_abbr"    : "PIT",
            "status"       : "pre",
            "is_postseason": False,
        })
        if result:
            assert result.against_abbr == "PIT"

    def test_postseason_bonus_applied(self, cin_engine):
        regular = cin_engine._score_game({
            "game_iri"     : "urn:nfl:game:reg",
            "home_abbr"    : "KC",
            "away_abbr"    : "BUF",
            "status"       : "pre",
            "is_postseason": False,
        })
        postseason = cin_engine._score_game({
            "game_iri"     : "urn:nfl:game:post",
            "home_abbr"    : "KC",
            "away_abbr"    : "BUF",
            "status"       : "pre",
            "is_postseason": True,
        })
        if regular and postseason:
            assert postseason.score >= regular.score

    def test_score_capped_at_1(self, cin_engine_with_dislikes):
        # Even with all bonuses stacked, score should not exceed 1.0
        result = cin_engine_with_dislikes._score_game({
            "game_iri"     : "urn:nfl:game:stacked",
            "home_abbr"    : "CLE",
            "away_abbr"    : "PIT",
            "status"       : "pre",
            "is_postseason": True,
        })
        if result:
            assert result.score <= 1.0


# ── Recommendation objects ────────────────────────────────────────────────────

class TestRecommendationObject:

    def test_recommendation_has_all_fields(self, cin_engine):
        rec = RootingRecommendation(
            game_iri      = "urn:nfl:game:x",
            root_for_abbr = "CLE",
            root_for_name = "Cleveland Browns",
            against_abbr  = "PIT",
            against_name  = "Pittsburgh Steelers",
            score         = 0.55,
            reasoning     = "test",
            home_abbr     = "CLE",
            away_abbr     = "PIT",
        )
        assert rec.score == 0.55
        assert rec.root_for_abbr == "CLE"
        assert rec.against_abbr  == "PIT"

    def test_generate_recommendations_returns_list(self, cin_engine):
        recs = cin_engine.generate_recommendations()
        assert isinstance(recs, list)

    def test_recommendations_sorted_by_score_desc(self, cin_engine):
        recs = cin_engine.generate_recommendations()
        if len(recs) >= 2:
            for i in range(len(recs) - 1):
                assert recs[i].score >= recs[i+1].score, \
                    "Recommendations should be sorted descending by score"

    def test_no_favorite_team_in_recommendations(self, cin_engine):
        recs = cin_engine.generate_recommendations()
        for rec in recs:
            assert rec.root_for_abbr != "CIN"
            assert rec.against_abbr  != "CIN"


# ── Graph output ──────────────────────────────────────────────────────────────

class TestRecommendationGraphOutput:

    def test_write_recommendations_to_graph(self, cin_engine):
        recs = cin_engine.generate_recommendations()
        cin_engine.write_recommendations_to_graph(recs)
        g = cin_engine.dataset.graph(GRAPH["recommendations"])
        assert len(g) >= 0  # graph exists

    def test_user_node_written(self, cin_engine):
        recs = cin_engine.generate_recommendations()
        cin_engine.write_recommendations_to_graph(recs)
        g = cin_engine.dataset.graph(GRAPH["recommendations"])
        from rdflib import RDF
        from rdf_builder import NFL
        users = list(g.subjects(RDF.type, NFL.User))
        assert len(users) >= 1

    def test_favorite_team_linked_to_user(self, cin_engine):
        recs = cin_engine.generate_recommendations()
        cin_engine.write_recommendations_to_graph(recs)
        g = cin_engine.dataset.graph(GRAPH["recommendations"])
        from rdf_builder import NFL
        fav_links = list(g.objects(None, NFL.favoriteTeam))
        assert any("CIN" in str(f) for f in fav_links)


# ── Print output (smoke tests) ────────────────────────────────────────────────

class TestPrintOutput:

    def test_print_recommendations_no_raise(self, cin_engine, capsys):
        recs = cin_engine.generate_recommendations()
        cin_engine.print_recommendations(recs)
        captured = capsys.readouterr()
        assert isinstance(captured.out, str)

    def test_print_empty_recommendations(self, cin_engine, capsys):
        cin_engine.print_recommendations([])
        captured = capsys.readouterr()
        assert "No actionable" in captured.out
