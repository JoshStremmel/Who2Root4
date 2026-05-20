"""
tests/test_sparql_queries.py
──────────────────────────────
Unit tests for the SPARQL query library — verifies all named queries
return structurally valid results against a loaded dataset.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "builders"))
sys.path.insert(0, str(Path(__file__).parent.parent / "queries"))
sys.path.insert(0, str(Path(__file__).parent))

import pytest
from fixtures import REGULAR_SCOREBOARD, STANDINGS
from espn_fetcher import parse_scoreboard
from rdf_builder import NFLGraphBuilder, _team_iri
from scenario_builder import ScenarioBuilder
from sparql_queries import (
    ALL_TEAMS,
    COMPLETED_GAMES,
    UPCOMING_GAMES,
    TEAM_SCHEDULE,
    DIVISIONAL_RIVALS,
    CONFERENCE_COMPETITORS,
    DIVISION_LEADERS,
    ALL_IMPACT_EDGES,
    GAMES_HELPING_TEAM,
    GAMES_HURTING_TEAM,
    LIST_ALL_HOLONS,
    ALL_ACTIVE_SCENARIOS,
    SCENARIOS_FOR_TEAM,
    SCENARIO_REQUIREMENTS,
    GAMES_BY_WEEK,
    TEAM_FULL_SCHEDULE,
    run_query,
    print_results,
)


@pytest.fixture(scope="module")
def ds():
    """Fully loaded dataset shared across all query tests."""
    b = NFLGraphBuilder()
    parsed = parse_scoreboard(REGULAR_SCOREBOARD)
    b.add_teams_from_scoreboard(parsed)
    b.add_games(parsed)
    b.add_standings(STANDINGS)
    b.add_teams_from_standings(STANDINGS)
    b.add_competition_edges()
    b.add_impact_edges()
    b.add_playoff_spot_assignments()

    sb = ScenarioBuilder(
        dataset   = b.dataset,
        standings = STANDINGS,
        games     = parsed["games"],
    )
    sb.generate_clinch_scenarios()
    sb.generate_elimination_scenarios()

    return b.dataset


# ── run_query helper ──────────────────────────────────────────────────────────

class TestRunQuery:

    def test_returns_list(self, ds):
        results = run_query(ds, ALL_TEAMS)
        assert isinstance(results, list)

    def test_rows_are_dicts(self, ds):
        results = run_query(ds, ALL_TEAMS)
        for row in results:
            assert isinstance(row, dict)

    def test_binding_substitution(self, ds):
        cin_iri = str(_team_iri("CIN"))
        results = run_query(
            ds, GAMES_HELPING_TEAM,
            bindings={"team_iri": cin_iri}
        )
        assert isinstance(results, list)

    def test_empty_query_returns_empty_list(self, ds):
        # Query for a team that doesn't exist
        results = run_query(
            ds, GAMES_HELPING_TEAM,
            bindings={"team_iri": "urn:nfl:team:ZZZ"}
        )
        assert results == []


# ── Team queries ──────────────────────────────────────────────────────────────

class TestTeamQueries:

    def test_all_teams_returns_results(self, ds):
        results = run_query(ds, ALL_TEAMS)
        assert len(results) > 0

    def test_all_teams_has_name_field(self, ds):
        results = run_query(ds, ALL_TEAMS)
        for row in results:
            assert "name" in row

    def test_team_schedule_for_cin(self, ds):
        results = run_query(
            ds, TEAM_SCHEDULE,
            bindings={"team_iri": str(_team_iri("CIN"))}
        )
        assert isinstance(results, list)

    def test_team_full_schedule_for_cin(self, ds):
        results = run_query(
            ds, TEAM_FULL_SCHEDULE,
            bindings={"team_iri": str(_team_iri("CIN"))}
        )
        assert isinstance(results, list)


# ── Game queries ──────────────────────────────────────────────────────────────

class TestGameQueries:

    def test_completed_games_returns_results(self, ds):
        results = run_query(ds, COMPLETED_GAMES)
        assert len(results) >= 1  # BAL-CIN was completed

    def test_completed_games_has_winner(self, ds):
        results = run_query(ds, COMPLETED_GAMES)
        for row in results:
            assert "winnerName" in row

    def test_upcoming_games_returns_results(self, ds):
        results = run_query(ds, UPCOMING_GAMES)
        # PIT at CLE was upcoming
        assert len(results) >= 1

    def test_games_by_week_returns_results(self, ds):
        results = run_query(ds, GAMES_BY_WEEK)
        assert len(results) >= 1
        for row in results:
            assert "week" in row
            assert "gameCount" in row


# ── Competition queries ───────────────────────────────────────────────────────

class TestCompetitionQueries:

    def test_divisional_rivals_returns_results(self, ds):
        results = run_query(ds, DIVISIONAL_RIVALS)
        assert len(results) > 0

    def test_bal_has_3_rivals(self, ds):
        results = run_query(ds, DIVISIONAL_RIVALS)
        bal_rivals = [r for r in results if "BAL" in str(r.get("team", ""))]
        assert len(bal_rivals) == 3

    def test_conference_competitors_returns_results(self, ds):
        results = run_query(ds, CONFERENCE_COMPETITORS)
        assert len(results) > 0

    def test_division_leaders_returns_results(self, ds):
        results = run_query(ds, DIVISION_LEADERS)
        assert len(results) > 0

    def test_division_leaders_has_leader_field(self, ds):
        results = run_query(ds, DIVISION_LEADERS)
        for row in results:
            assert "leader" in row or "leaderName" in row


# ── Impact queries ────────────────────────────────────────────────────────────

class TestImpactQueries:

    def test_all_impact_edges_returns_results(self, ds):
        results = run_query(ds, ALL_IMPACT_EDGES)
        assert len(results) >= 1

    def test_games_helping_cin(self, ds):
        results = run_query(
            ds, GAMES_HELPING_TEAM,
            bindings={"team_iri": str(_team_iri("CIN"))}
        )
        # BAL beat CIN so no games help CIN from this week's data
        # (CIN lost, so opponent wins don't help them)
        assert isinstance(results, list)

    def test_games_hurting_cin(self, ds):
        results = run_query(
            ds, GAMES_HURTING_TEAM,
            bindings={"team_iri": str(_team_iri("CIN"))}
        )
        # CIN lost to BAL → one game hurts them
        assert len(results) >= 1


# ── Scenario queries ──────────────────────────────────────────────────────────

class TestScenarioQueries:

    def test_all_active_scenarios_returns_list(self, ds):
        results = run_query(ds, ALL_ACTIVE_SCENARIOS)
        assert isinstance(results, list)

    def test_scenarios_for_cin_returns_list(self, ds):
        results = run_query(
            ds, SCENARIOS_FOR_TEAM,
            bindings={"team_iri": str(_team_iri("CIN"))}
        )
        assert isinstance(results, list)

    def test_scenario_requirements_for_cin(self, ds):
        results = run_query(
            ds, SCENARIO_REQUIREMENTS,
            bindings={"team_iri": str(_team_iri("CIN"))}
        )
        assert isinstance(results, list)


# ── Holarchy registry ─────────────────────────────────────────────────────────

class TestHolarchyQueries:

    def test_list_all_holons_returns_results(self, ds):
        results = run_query(ds, LIST_ALL_HOLONS)
        assert len(results) > 0

    def test_holons_have_type_field(self, ds):
        results = run_query(ds, LIST_ALL_HOLONS)
        for row in results:
            assert "type" in row


# ── print_results smoke test ──────────────────────────────────────────────────

class TestPrintResults:

    def test_print_results_no_raise(self, ds, capsys):
        results = run_query(ds, ALL_TEAMS)
        print_results(results, title="Test")
        captured = capsys.readouterr()
        assert "Test" in captured.out

    def test_print_empty_results(self, capsys):
        print_results([], title="Empty")
        captured = capsys.readouterr()
        assert "no results" in captured.out.lower() or "Empty" in captured.out
