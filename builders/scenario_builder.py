"""
scenario_builder.py
────────────────────
Generates playoff:Scenario holons and their playoff:requires dependency edges.

A scenario represents a condition tree: a future playoff state that a team
can reach IF a specific set of game outcomes occur. This replaces giant
procedural if-statement chains with first-class semantic graph objects.

Example scenario (Bengals clinch wildcard):
    scenario:CIN_ClinchWildcard a playoff:Scenario ;
        playoff:beneficiary team:CIN ;
        playoff:requires outcome:CIN_W14_WIN ;
        playoff:requires outcome:LAC_W14_LOSE ;
        playoff:requires outcome:DEN_W14_LOSE .

Graph written to
────────────────
    urn:nfl:graph:scenarios

Usage
─────
    from scenario_builder import ScenarioBuilder
    sb = ScenarioBuilder(builder.dataset, standings=parsed_standings)
    sb.generate_clinch_scenarios()
    sb.generate_elimination_scenarios()
    sb.print_scenarios("CIN")
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from rdflib import RDF, XSD, Dataset, Literal, Namespace, URIRef

from espn_fetcher import CONFERENCE_MAP, DIVISION_MAP, DIVISION_RIVALS
from rdf_builder import (
    GRAPH, NFL, PLAYOFF, IMPACT,
    _team_iri, _outcome_iri,
)

logger = logging.getLogger(__name__)

SCENARIO = Namespace("urn:nfl:scenario:")


@dataclass
class Scenario:
    iri:            str
    label:          str
    beneficiary:    str          # team abbr
    scenario_type:  str          # "clinch_division" | "clinch_wildcard" | "eliminated"
    required_wins:  list[str]    # team abbrs that must WIN
    required_losses: list[str]   # team abbrs that must LOSE
    remaining_games: int         # how many requirements are still unresolved
    is_active:      bool         # False if already clinched / already eliminated


class ScenarioBuilder:
    """
    Reasons over standings + remaining schedule to produce
    playoff:Scenario holons for every relevant team.
    """

    def __init__(
        self,
        dataset: Dataset,
        standings: list[dict],
        games: list[dict] | None = None,   # all parsed game dicts (any week)
    ) -> None:
        self.dataset   = dataset
        self.standings = {s["abbr"]: s for s in standings}
        self.games     = games or []
        self._g        = dataset.graph(GRAPH["scenarios"])
        self._g.bind("scenario", SCENARIO)
        self._g.bind("playoff",  PLAYOFF)
        self._g.bind("nfl",      NFL)
        self._scenarios: list[Scenario] = []

        # Pre-compute remaining schedule per team
        self._remaining: dict[str, list[dict]] = self._index_remaining_games()
        # Pre-compute completed outcomes per team
        self._completed_wins:   dict[str, set[str]] = self._index_completed_wins()
        self._completed_losses: dict[str, set[str]] = self._index_completed_losses()

    # ── Public API ────────────────────────────────────────────────────────────

    def generate_clinch_scenarios(self) -> None:
        """
        For every team still mathematically alive, generate:
          - clinch_division  (if they can still win their division)
          - clinch_wildcard  (if they can still make it as a wildcard)
        """
        for abbr, sd in self.standings.items():
            if sd.get("eliminated"):
                continue
            conf = CONFERENCE_MAP.get(abbr, "")
            div  = DIVISION_MAP.get(abbr, "")

            # Division clinch scenario
            div_scenario = self._build_division_clinch(abbr, div, conf, sd)
            if div_scenario:
                self._write_scenario(div_scenario)
                self._scenarios.append(div_scenario)

            # Wildcard clinch scenario
            wc_scenario = self._build_wildcard_clinch(abbr, conf, sd)
            if wc_scenario:
                self._write_scenario(wc_scenario)
                self._scenarios.append(wc_scenario)

        logger.info("Generated %d clinch scenarios", len(self._scenarios))

    def generate_elimination_scenarios(self) -> None:
        """
        For every team, generate an elimination scenario representing the
        conditions under which they would be mathematically eliminated.
        """
        count = 0
        for abbr, sd in self.standings.items():
            elim = self._build_elimination(abbr, sd)
            if elim:
                self._write_scenario(elim)
                self._scenarios.append(elim)
                count += 1

        logger.info("Generated %d elimination scenarios", count)

    def link_scenarios_to_impact(self) -> None:
        """
        For each active scenario, write impact:controlsDestiny edges
        from each required game outcome → the beneficiary team.
        This lets the recommendation engine find scenarios via SPARQL.
        """
        g_out = self.dataset.graph(GRAPH["outcomes"])
        for sc in self._scenarios:
            if not sc.is_active:
                continue
            ben_iri = _team_iri(sc.beneficiary)
            sc_iri  = URIRef(sc.iri)
            # Each required win: if that team wins, it helps the beneficiary
            for win_abbr in sc.required_wins:
                out_iri = self._latest_outcome_iri(win_abbr, win=True)
                if out_iri:
                    g_out.add((out_iri, IMPACT.controlsDestiny, ben_iri))
                    g_out.add((out_iri, IMPACT.helps,           ben_iri))
            # Each required loss: if that team loses, it helps the beneficiary
            for loss_abbr in sc.required_losses:
                out_iri = self._latest_outcome_iri(loss_abbr, win=False)
                if out_iri:
                    g_out.add((out_iri, IMPACT.controlsDestiny, ben_iri))
                    g_out.add((out_iri, IMPACT.helps,           ben_iri))

        logger.info("Scenario → impact edges linked")

    def print_scenarios(self, team_abbr: str | None = None) -> None:
        """Print a readable summary of generated scenarios."""
        targets = (
            [s for s in self._scenarios if s.beneficiary == team_abbr.upper()]
            if team_abbr else self._scenarios
        )
        if not targets:
            print("  No scenarios found.")
            return

        header = f"Playoff Scenarios" + (f" — {team_abbr.upper()}" if team_abbr else "")
        print(f"\n{'='*65}")
        print(f"  {header}")
        print(f"{'='*65}")

        for sc in sorted(targets, key=lambda s: s.scenario_type):
            status = "✓ ACTIVE" if sc.is_active else "✗ resolved"
            print(f"\n  [{status}] {sc.label}")
            print(f"           Type: {sc.scenario_type}")
            if sc.required_wins:
                print(f"           Need wins from:   {', '.join(sc.required_wins)}")
            if sc.required_losses:
                print(f"           Need losses from: {', '.join(sc.required_losses)}")
            print(f"           Remaining unresolved: {sc.remaining_games} game(s)")
        print()

    # ── Scenario construction ─────────────────────────────────────────────────

    def _build_division_clinch(
        self, abbr: str, div: str, conf: str, sd: dict
    ) -> Scenario | None:
        """
        Division clinch: team needs to win out AND all division rivals
        need to lose enough games that they can't catch up.
        """
        rivals = [r for r in DIVISION_RIVALS.get(div, []) if r != abbr]
        if not rivals:
            return None

        team_wins   = sd["wins"]
        team_losses = sd["losses"]
        team_remaining = len(self._remaining.get(abbr, []))

        # Check if any rival can still match the team's max possible wins
        max_team_wins = team_wins + team_remaining
        required_losses: list[str] = []
        is_active = False

        for rival_abbr in rivals:
            rival_sd = self.standings.get(rival_abbr, {})
            rival_wins = rival_sd.get("wins", 0)
            rival_remaining = len(self._remaining.get(rival_abbr, []))
            rival_max = rival_wins + rival_remaining
            if rival_max >= max_team_wins:
                required_losses.append(rival_abbr)

        # Active if the team hasn't already clinched
        best_rival_wins = max(
            (self.standings.get(r, {}).get("wins", 0) for r in rivals), default=0
        )
        is_active = team_wins <= best_rival_wins or bool(required_losses)

        required_wins = [abbr] if team_remaining > 0 else []

        remaining = (
            len([r for r in required_wins  if r not in self._completed_wins.get(abbr, set())]) +
            len([r for r in required_losses if r not in self._completed_losses.get(abbr, set())])
        )

        slug    = f"{abbr}_ClinchDivision_{div}"
        sc_iri  = str(SCENARIO[slug])
        label   = f"{abbr} clinches {div} division title"

        return Scenario(
            iri             = sc_iri,
            label           = label,
            beneficiary     = abbr,
            scenario_type   = "clinch_division",
            required_wins   = required_wins,
            required_losses = required_losses,
            remaining_games = remaining,
            is_active       = is_active,
        )

    def _build_wildcard_clinch(
        self, abbr: str, conf: str, sd: dict
    ) -> Scenario | None:
        """
        Wildcard clinch: team needs to be in the top 7 of their conference.
        Requires beating out teams currently in positions 8+ who could overtake.
        """
        conf_teams = sorted(
            [s for s in self.standings.values() if CONFERENCE_MAP.get(s["abbr"]) == conf],
            key=lambda t: t["win_pct"],
            reverse=True,
        )

        team_rank = next(
            (i for i, t in enumerate(conf_teams) if t["abbr"] == abbr), None
        )
        if team_rank is None:
            return None

        # Already a division leader → wildcard scenario not the primary path
        div = DIVISION_MAP.get(abbr, "")
        div_rivals = [r for r in DIVISION_RIVALS.get(div, []) if r != abbr]
        best_rival = max(
            (self.standings.get(r, {}).get("wins", 0) for r in div_rivals), default=0
        )
        if sd["wins"] > best_rival:
            return None  # division clinch is the relevant scenario

        # Teams currently ranked 8–10 who could jump into wildcard spots
        bubble_teams = [
            t["abbr"] for t in conf_teams[7:10]
            if t["abbr"] != abbr and
               t["wins"] + len(self._remaining.get(t["abbr"], [])) >= sd["wins"]
        ]

        required_losses = bubble_teams[:3]   # top threats only
        required_wins   = [abbr] if len(self._remaining.get(abbr, [])) > 0 else []
        is_active       = team_rank >= 7 or bool(required_losses)

        remaining = (
            len([r for r in required_wins  if r not in self._completed_wins.get(abbr, set())]) +
            len([r for r in required_losses if r not in self._completed_losses.get(abbr, set())])
        )

        slug   = f"{abbr}_ClinchWildcard_{conf}"
        sc_iri = str(SCENARIO[slug])
        label  = f"{abbr} clinches {conf} wildcard berth"

        return Scenario(
            iri             = sc_iri,
            label           = label,
            beneficiary     = abbr,
            scenario_type   = "clinch_wildcard",
            required_wins   = required_wins,
            required_losses = required_losses,
            remaining_games = remaining,
            is_active       = is_active,
        )

    def _build_elimination(self, abbr: str, sd: dict) -> Scenario | None:
        """
        Elimination scenario: conditions under which this team is
        mathematically eliminated from playoff contention.
        """
        conf = CONFERENCE_MAP.get(abbr, "")
        div  = DIVISION_MAP.get(abbr, "")

        # Division leaders cannot be eliminated — skip them entirely
        div_rivals = [r for r in DIVISION_RIVALS.get(div, []) if r != abbr]
        best_rival_wins = max(
            (self.standings.get(r, {}).get("wins", 0) for r in div_rivals),
            default=0,
        )
        if sd["wins"] > best_rival_wins:
            return None  # team leads their division, not elimination candidate

        conf_teams = sorted(
            [s for s in self.standings.values() if CONFERENCE_MAP.get(s["abbr"]) == conf],
            key=lambda t: t["win_pct"],
            reverse=True,
        )

        team_wins      = sd["wins"]
        team_remaining = len(self._remaining.get(abbr, []))
        max_team_wins  = team_wins + team_remaining

        # Count how many teams already have more max wins than us
        teams_ahead = [
            t for t in conf_teams
            if t["abbr"] != abbr and t["wins"] > max_team_wins
        ]
        already_eliminated = len(teams_ahead) >= 7

        # Teams whose wins would eliminate the team
        eliminators = [
            t["abbr"] for t in conf_teams
            if t["abbr"] != abbr and
               t["wins"] + len(self._remaining.get(t["abbr"], [])) > max_team_wins
        ][:4]

        if not eliminators and not already_eliminated:
            return None

        slug   = f"{abbr}_Eliminated_{conf}"
        sc_iri = str(SCENARIO[slug])
        label  = f"{abbr} eliminated from {conf} playoff contention"

        return Scenario(
            iri             = sc_iri,
            label           = label,
            beneficiary     = abbr,
            scenario_type   = "eliminated",
            required_wins   = eliminators,
            required_losses = [],
            remaining_games = 0,
            is_active       = not already_eliminated,
        )

    # ── RDF writer ────────────────────────────────────────────────────────────

    def _write_scenario(self, sc: Scenario) -> None:
        g       = self._g
        sc_iri  = URIRef(sc.iri)
        ben_iri = _team_iri(sc.beneficiary)

        g.add((sc_iri, RDF.type,             PLAYOFF.Scenario))
        g.add((sc_iri, NFL.name,             Literal(sc.label)))
        g.add((sc_iri, PLAYOFF.beneficiary,  ben_iri))
        g.add((sc_iri, NFL["scenarioType"],  Literal(sc.scenario_type)))
        g.add((sc_iri, NFL["isActive"],      Literal(sc.is_active,       datatype=XSD.boolean)))
        g.add((sc_iri, NFL["remainingGames"], Literal(sc.remaining_games, datatype=XSD.integer)))

        # Required wins → team must win a remaining game
        for win_abbr in sc.required_wins:
            req_iri = URIRef(f"{sc.iri}:req:win:{win_abbr}")
            g.add((sc_iri,   PLAYOFF.requires,       req_iri))
            g.add((req_iri,  NFL["requiresWinFrom"], _team_iri(win_abbr)))
            g.add((req_iri,  NFL["outcomeType"],     Literal("win")))

        # Required losses → opponent must lose
        for loss_abbr in sc.required_losses:
            req_iri = URIRef(f"{sc.iri}:req:loss:{loss_abbr}")
            g.add((sc_iri,   PLAYOFF.requires,        req_iri))
            g.add((req_iri,  NFL["requiresLossFrom"], _team_iri(loss_abbr)))
            g.add((req_iri,  NFL["outcomeType"],      Literal("loss")))

        # Link future scenario from team node
        g.add((ben_iri, NFL.futureScenario, sc_iri))

    # ── Index helpers ─────────────────────────────────────────────────────────

    def _index_remaining_games(self) -> dict[str, list[dict]]:
        """Map team abbr → list of upcoming (pre/in) game dicts."""
        idx: dict[str, list[dict]] = {}
        for game in self.games:
            if game.get("status") not in ("pre", "in"):
                continue
            for side in ("home", "away"):
                abbr = game[side]["abbr"]
                idx.setdefault(abbr, []).append(game)
        return idx

    def _index_completed_wins(self) -> dict[str, set[str]]:
        """Map team abbr → set of opponent abbrs they've already beaten."""
        idx: dict[str, set[str]] = {}
        for game in self.games:
            if game.get("status") != "post" or not game.get("winner_abbr"):
                continue
            winner = game["winner_abbr"]
            loser  = game["loser_abbr"]
            if winner and loser:
                idx.setdefault(winner, set()).add(loser)
        return idx

    def _index_completed_losses(self) -> dict[str, set[str]]:
        """Map team abbr → set of opponent abbrs that have already beaten them."""
        idx: dict[str, set[str]] = {}
        for game in self.games:
            if game.get("status") != "post" or not game.get("loser_abbr"):
                continue
            winner = game["winner_abbr"]
            loser  = game["loser_abbr"]
            if winner and loser:
                idx.setdefault(loser, set()).add(winner)
        return idx

    def _latest_outcome_iri(self, team_abbr: str, win: bool) -> URIRef | None:
        """
        Find the IRI of an upcoming game outcome node for a team.
        Returns None if no remaining game found.
        """
        remaining = self._remaining.get(team_abbr, [])
        if not remaining:
            return None
        game = remaining[0]
        winner_abbr = team_abbr if win else (
            game["away"]["abbr"] if game["home"]["abbr"] == team_abbr
            else game["home"]["abbr"]
        )
        return _outcome_iri(game, winner_abbr)
