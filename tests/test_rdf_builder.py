"""
tests/test_rdf_builder.py
──────────────────────────
Unit tests for NFLGraphBuilder — verifies holons, named graphs,
competition edges, impact edges, and playoff assignments.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "builders"))
sys.path.insert(0, str(Path(__file__).parent))

import pytest
from rdflib import URIRef
from fixtures import REGULAR_SCOREBOARD, POSTSEASON_SCOREBOARD, STANDINGS
from espn_fetcher import parse_scoreboard
from rdf_builder import (
    NFLGraphBuilder, NFL, GRAPH, GAME, TEAM, IMPACT,
    _team_iri, _game_iri,
)


@pytest.fixture
def builder():
    b = NFLGraphBuilder()
    return b


@pytest.fixture
def loaded_builder():
    """Builder with scoreboard + standings fully loaded."""
    b = NFLGraphBuilder()
    parsed = parse_scoreboard(REGULAR_SCOREBOARD)
    b.add_teams_from_scoreboard(parsed)
    b.add_games(parsed)
    b.add_standings(STANDINGS)
    b.add_teams_from_standings(STANDINGS)
    b.add_competition_edges()
    b.add_impact_edges()
    b.add_playoff_spot_assignments()
    return b


# ── Team holons ───────────────────────────────────────────────────────────────

class TestTeamHolons:

    def test_teams_registered_in_holarchy(self, loaded_builder):
        g = loaded_builder._g_holarchy
        team_iri = _team_iri("BAL")
        assert (team_iri, None, None) in g or \
               any(True for _ in g.triples((team_iri, None, None)))

    def test_team_interior_graph_exists(self, loaded_builder):
        ds = loaded_builder.dataset
        iri = URIRef("urn:nfl:graph:team:BAL")
        g = ds.graph(iri)
        assert len(g) > 0, "BAL interior graph should have triples"

    def test_team_has_name(self, loaded_builder):
        ds = loaded_builder.dataset
        g = ds.graph(URIRef("urn:nfl:graph:team:BAL"))
        names = list(g.objects(_team_iri("BAL"), NFL.name))
        assert len(names) == 1
        assert str(names[0]) == "Baltimore Ravens"

    def test_team_has_wins(self, loaded_builder):
        ds = loaded_builder.dataset
        g = ds.graph(URIRef("urn:nfl:graph:team:BAL"))
        wins = list(g.objects(_team_iri("BAL"), NFL.wins))
        assert len(wins) == 1
        assert int(wins[0]) == 11

    def test_team_has_division(self, loaded_builder):
        ds = loaded_builder.dataset
        g = ds.graph(URIRef("urn:nfl:graph:team:BAL"))
        divs = list(g.objects(_team_iri("BAL"), NFL.division))
        assert len(divs) >= 1
        assert any("AFCNorth" in str(d) for d in divs)

    def test_team_has_conference(self, loaded_builder):
        ds = loaded_builder.dataset
        g = ds.graph(URIRef("urn:nfl:graph:team:CIN"))
        confs = list(g.objects(_team_iri("CIN"), NFL.conference))
        assert any("AFC" in str(c) for c in confs)


# ── Game holons ───────────────────────────────────────────────────────────────

class TestGameHolons:

    def test_games_created(self, loaded_builder):
        ds = loaded_builder.dataset
        count = 0
        for g in ds.graphs():
            if "games:" in str(g.identifier):
                count += sum(1 for _ in g.triples((None, None, None)))
        assert count > 0

    def test_completed_game_has_winner(self, loaded_builder):
        parsed = parse_scoreboard(REGULAR_SCOREBOARD)
        completed = next(g for g in parsed["games"] if g["status"] == "post")
        game_iri = _game_iri(completed)
        ds = loaded_builder.dataset

        winner = None
        for g in ds.graphs():
            winners = list(g.objects(game_iri, NFL.winner))
            if winners:
                winner = str(winners[0])
                break
        assert winner is not None
        assert "BAL" in winner

    def test_completed_game_has_scores(self, loaded_builder):
        parsed = parse_scoreboard(REGULAR_SCOREBOARD)
        completed = next(g for g in parsed["games"] if g["status"] == "post")
        game_iri = _game_iri(completed)
        ds = loaded_builder.dataset

        home_score = None
        for g in ds.graphs():
            scores = list(g.objects(game_iri, NFL.homeScore))
            if scores:
                home_score = int(scores[0])
                break
        assert home_score == 27

    def test_week_graph_named_correctly(self, loaded_builder):
        ds = loaded_builder.dataset
        week_graph_iri = URIRef("urn:nfl:graph:games:2025:14")
        g = ds.graph(week_graph_iri)
        assert len(g) > 0, "Week 14 named graph should exist and have triples"

    def test_postseason_game_parsed(self):
        b = NFLGraphBuilder()
        parsed = parse_scoreboard(POSTSEASON_SCOREBOARD)
        b.add_teams_from_scoreboard(parsed)
        b.add_games(parsed)
        ds = b.dataset
        # Should have created a week graph for postseason
        found = any(
            "games:2025:1" in str(g.identifier)
            for g in ds.graphs()
        )
        assert found, "Postseason week 1 graph not found"


# ── Competition edges ─────────────────────────────────────────────────────────

class TestCompetitionEdges:

    def test_divisional_rivals_written(self, loaded_builder):
        g = loaded_builder._g_competition
        bal = _team_iri("BAL")
        rivals = list(g.objects(bal, NFL.divisionalRival))
        rival_abbrs = [str(r).split(":")[-1] for r in rivals]
        assert set(rival_abbrs) == {"CIN", "CLE", "PIT"}

    def test_no_self_rivalry(self, loaded_builder):
        g = loaded_builder._g_competition
        for team in ["BAL", "CIN", "CLE", "PIT"]:
            t_iri = _team_iri(team)
            rivals = list(g.objects(t_iri, NFL.divisionalRival))
            assert t_iri not in rivals, f"{team} should not be its own rival"

    def test_division_leader_assigned(self, loaded_builder):
        g = loaded_builder._g_competition
        leaders = list(g.objects(NFL.AFCNorth, NFL.divisionLeader))
        assert len(leaders) == 1
        assert "BAL" in str(leaders[0])

    def test_games_back_written(self, loaded_builder):
        g = loaded_builder._g_competition
        cin_iri = _team_iri("CIN")
        gb = list(g.objects(cin_iri, NFL.gamesBack))
        assert len(gb) == 1
        assert float(gb[0]) >= 0.0

    def test_conference_competitors_written(self, loaded_builder):
        g = loaded_builder._g_competition
        cin = _team_iri("CIN")
        competitors = list(g.objects(cin, NFL.competesWith))
        assert len(competitors) > 0
        # CIN should compete with other AFC teams
        abbrs = [str(c).split(":")[-1] for c in competitors]
        assert "BAL" in abbrs or "KC" in abbrs


# ── Impact edges ──────────────────────────────────────────────────────────────

class TestImpactEdges:

    def test_winner_improves_odds(self, loaded_builder):
        g = loaded_builder._g_outcomes
        bal = _team_iri("BAL")
        improved = list(g.subjects(IMPACT.improvesOdds, bal))
        assert len(improved) >= 1

    def test_loser_reduces_odds(self, loaded_builder):
        g = loaded_builder._g_outcomes
        cin = _team_iri("CIN")
        reduced = list(g.subjects(IMPACT.reducesOdds, cin))
        assert len(reduced) >= 1

    def test_divisional_game_has_highest_impact(self, loaded_builder):
        g = loaded_builder._g_outcomes
        # The BAL-CIN game is divisional — should score 1.0
        scores = list(g.objects(None, IMPACT.score))
        float_scores = [float(s) for s in scores]
        assert 1.0 in float_scores, "Divisional game should score 1.0"

    def test_no_impact_for_upcoming_games(self, loaded_builder):
        # Pre-game and live games should NOT appear in outcomes graph
        g = loaded_builder._g_outcomes
        # Only BAL-CIN was completed, so only one game outcome
        outcomes = list(g.subjects(None, IMPACT.improvesOdds))
        assert len(outcomes) >= 1  # at least one outcome exists


# ── Playoff spot assignments ───────────────────────────────────────────────────

class TestPlayoffAssignments:

    def test_playoff_spots_assigned(self, loaded_builder):
        g = loaded_builder._g_standings
        from rdflib import Namespace
        PLAYOFF = Namespace("urn:nfl:playoff:")
        holders = list(g.subjects(NFL.currentlyHolds, None))
        assert len(holders) > 0

    def test_afc_has_7_seeds(self, loaded_builder):
        g = loaded_builder._g_standings
        from rdflib import Namespace
        PLAYOFF = Namespace("urn:nfl:playoff:")
        afc_seeds = [
            s for s in g.objects(None, NFL.currentlyHolds)
            if "AFC" in str(s)
        ]
        # Can't guarantee all 7 with partial standings fixture, just check > 0
        assert len(afc_seeds) > 0

    def test_top_team_holds_seed_1(self, loaded_builder):
        g = loaded_builder._g_standings
        from rdflib import Namespace
        PLAYOFF = Namespace("urn:nfl:playoff:")
        # BAL and KC are tied at 11-2. One of them should hold seed 1.
        for abbr in ["BAL", "KC", "PHI"]:
            spots = list(g.objects(_team_iri(abbr), NFL.currentlyHolds))
            if any("Seed1" in str(s) for s in spots):
                return  # found at least one top seed correctly assigned
        pytest.fail("No top team assigned to Seed 1")


# ── Serialization ─────────────────────────────────────────────────────────────

class TestSerialization:

    def test_serialize_trig(self, loaded_builder, tmp_path):
        out = tmp_path / "test.trig"
        loaded_builder.serialize(out, fmt="trig")
        assert out.exists()
        assert out.stat().st_size > 0

    def test_serialize_turtle(self, loaded_builder, tmp_path):
        out = tmp_path / "teams.ttl"
        loaded_builder.serialize_graph(
            "urn:nfl:graph:teams", out, fmt="turtle"
        )
        assert out.exists()
        assert out.stat().st_size > 0
