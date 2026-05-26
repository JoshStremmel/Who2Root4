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
    beneficiary:    str
    scenario_type:  str          # "clinch_division" | "clinch_wildcard" | "eliminated_division" | "eliminated_wildcard"
    required_wins:  list[str]    # team abbrs that must WIN (for RDF/impact edges)
    required_losses: list[str]   # team abbrs that must LOSE (for RDF/impact edges)
    remaining_games: int         # total combined "events" still needed
    is_active:      bool         # False = already clinched or already eliminated
    # Count-based display fields
    wins_needed:    int = 0
    key_wins_vs:    list[str] = field(default_factory=list)         # specific opponents on remaining schedule worth highlighting
    rival_losses_needed: dict[str, int] = field(default_factory=dict)  # rival -> min additional losses they need
    rival_games_remaining: dict[str, int] = field(default_factory=dict) # rival -> their remaining game count


class ScenarioBuilder:
    """
    Reasons over standings + remaining schedule to produce
    playoff:Scenario holons for every relevant team.
    """

    def __init__(
        self,
        dataset: Dataset,
        standings: list[dict],
        games: list[dict] | None = None,
        tiebreaker_order: dict[str, list[str]] | None = None,
    ) -> None:
        self.dataset          = dataset
        self.standings        = {s["abbr"]: s for s in standings}
        self.games            = games or []
        self.tiebreaker_order = tiebreaker_order or {}
        self._g        = dataset.graph(GRAPH["scenarios"])
        self._g.bind("scenario", SCENARIO)
        self._g.bind("playoff",  PLAYOFF)
        self._g.bind("nfl",      NFL)
        self._scenarios: list[Scenario] = []

        self._remaining: dict[str, list[dict]] = self._index_remaining_games()
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
            if self._already_wildcard_eliminated(abbr, sd):
                continue
            conf = CONFERENCE_MAP.get(abbr, "")
            div  = DIVISION_MAP.get(abbr, "")

            div_scenario = self._build_division_clinch(abbr, div, conf, sd)
            if div_scenario:
                self._write_scenario(div_scenario)
                self._scenarios.append(div_scenario)

            wc_scenario = self._build_wildcard_clinch(abbr, conf, sd)
            if wc_scenario:
                self._write_scenario(wc_scenario)
                self._scenarios.append(wc_scenario)

        logger.info("Generated %d clinch scenarios", len(self._scenarios))

    def generate_elimination_scenarios(self) -> None:
        """
        For every team, generate elimination scenarios:
          - eliminated_division  (cannot win their division)
          - eliminated_wildcard  (cannot reach any playoff berth)
        """
        count = 0
        for abbr, sd in self.standings.items():
            for builder in (self._build_division_elimination, self._build_wildcard_elimination):
                elim = builder(abbr, sd)
                if elim:
                    self._write_scenario(elim)
                    self._scenarios.append(elim)
                    count += 1

        logger.info("Generated %d elimination scenarios", count)

    def link_scenarios_to_impact(self) -> None:
        """
        For each active scenario, write impact:controlsDestiny edges
        from each required game outcome → the beneficiary team.
        """
        g_out = self.dataset.graph(GRAPH["outcomes"])
        for sc in self._scenarios:
            if not sc.is_active:
                continue
            ben_iri = _team_iri(sc.beneficiary)
            for win_abbr in sc.required_wins:
                out_iri = self._latest_outcome_iri(win_abbr, win=True)
                if out_iri:
                    g_out.add((out_iri, IMPACT.controlsDestiny, ben_iri))
                    g_out.add((out_iri, IMPACT.helps,           ben_iri))
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

        header = "Playoff Scenarios" + (f" — {team_abbr.upper()}" if team_abbr else "")
        print(f"\n{'='*65}")
        print(f"  {header}")
        print(f"{'='*65}")

        for sc in sorted(targets, key=lambda s: s.scenario_type):
            if sc.is_active:
                status = "+ ACTIVE"
            elif sc.scenario_type in ("eliminated_division", "eliminated_wildcard"):
                status = "* ELIMINATED"
            else:
                status = "* CLINCHED"
            print(f"\n  [{status}] {sc.label}")
            print(f"           Type: {sc.scenario_type}")

            if sc.is_active and sc.scenario_type in ("clinch_division", "clinch_wildcard"):
                team_rem = len(self._remaining.get(sc.beneficiary, []))
                _print_clinch_path(sc, team_rem)
            elif sc.is_active and sc.scenario_type in ("eliminated_division", "eliminated_wildcard"):
                if sc.required_wins:
                    print(f"           Eliminated by: {', '.join(sc.required_wins)}")

        print()

    # ── Scenario construction ─────────────────────────────────────────────────

    def _build_division_clinch(
        self, abbr: str, div: str, conf: str, sd: dict
    ) -> Scenario | None:
        """
        Division clinch: most likely path for the team to finish first in their division.

        Uses a proportional magic-number split: for each rival, the combined
        "clinch events" needed (team wins + rival losses) are split between the
        two teams proportionally to their remaining game counts.
        """
        rivals = [r for r in DIVISION_RIVALS.get(div, []) if r != abbr]
        if not rivals:
            return None

        team_wins      = sd["wins"]
        team_rem_list  = self._remaining.get(abbr, [])
        team_remaining = len(team_rem_list)
        max_team_wins  = team_wins + team_remaining

        # Already mathematically eliminated: a rival's current wins exceed our ceiling
        if any(
            self.standings.get(r, {}).get("wins", 0) > max_team_wins
            for r in rivals
        ):
            return None

        # Already clinched: team's current wins exceed every rival's maximum possible
        already_clinched = all(
            team_wins > self.standings.get(r, {}).get("wins", 0) + len(self._remaining.get(r, []))
            for r in rivals
        )
        if already_clinched:
            return Scenario(
                iri=str(SCENARIO[f"{abbr}_ClinchDivision_{div}"]),
                label=f"{abbr} clinches {div} division title",
                beneficiary=abbr,
                scenario_type="clinch_division",
                required_wins=[],
                required_losses=[],
                remaining_games=0,
                is_active=False,
            )

        # Per-rival magic numbers and proportional requirements
        rival_losses_needed:    dict[str, int] = {}
        rival_games_remaining:  dict[str, int] = {}
        wins_needed = 0

        for rival in rivals:
            rival_sd   = self.standings.get(rival, {})
            rival_wins = rival_sd.get("wins", 0)
            rival_rem  = len(self._remaining.get(rival, []))
            rival_games_remaining[rival] = rival_rem
            rival_max  = rival_wins + rival_rem

            if rival_max < team_wins:
                continue  # already ahead of this rival

            # Combined events needed: team wins + rival losses
            magic = rival_max - team_wins + 1
            if magic <= 0:
                continue

            total_rem = team_remaining + rival_rem
            if total_rem == 0 or magic > total_rem:
                continue  # impossible to achieve via game results alone

            # Proportional split: each side bears its share
            t_wins = max(0, min(round(magic * team_remaining / total_rem), team_remaining))
            r_losses = magic - t_wins

            # Clamp rival losses to feasible
            if r_losses > rival_rem:
                r_losses = rival_rem
                t_wins   = min(max(0, magic - r_losses), team_remaining)

            wins_needed = max(wins_needed, t_wins)
            if r_losses > 0:
                rival_losses_needed[rival] = r_losses

        if not wins_needed and not rival_losses_needed:
            return Scenario(
                iri=str(SCENARIO[f"{abbr}_ClinchDivision_{div}"]),
                label=f"{abbr} clinches {div} division title",
                beneficiary=abbr,
                scenario_type="clinch_division",
                required_wins=[],
                required_losses=[],
                remaining_games=0,
                is_active=False,
            )

        # Key matchups: remaining games the team still plays against their division rivals
        rival_set = set(rivals)
        key_wins_vs: list[str] = []
        seen: set[str] = set()
        for game in team_rem_list:
            opp = game["away"]["abbr"] if game["home"]["abbr"] == abbr else game["home"]["abbr"]
            if opp in rival_set and opp not in seen:
                key_wins_vs.append(opp)
                seen.add(opp)

        required_wins  = [abbr] if wins_needed > 0 else []
        required_losses = list(rival_losses_needed.keys())
        remaining_count = wins_needed + sum(rival_losses_needed.values())

        return Scenario(
            iri=str(SCENARIO[f"{abbr}_ClinchDivision_{div}"]),
            label=f"{abbr} clinches {div} division title",
            beneficiary=abbr,
            scenario_type="clinch_division",
            required_wins=required_wins,
            required_losses=required_losses,
            remaining_games=remaining_count,
            is_active=True,
            wins_needed=wins_needed,
            key_wins_vs=key_wins_vs,
            rival_losses_needed=rival_losses_needed,
            rival_games_remaining=rival_games_remaining,
        )

    def _build_wildcard_clinch(
        self, abbr: str, conf: str, sd: dict
    ) -> Scenario | None:
        """
        Wildcard clinch: most likely path to securing a top-7 conference berth.

        A team is already clinched only when it's mathematically impossible for
        7 or more conference opponents to all exceed the team's current win total
        (i.e., team can't fall out of the top 7 even losing every remaining game).
        """
        conf_teams = sorted(
            [s for s in self.standings.values() if CONFERENCE_MAP.get(s["abbr"]) == conf],
            key=lambda t: (t["win_pct"], t["wins"]),
            reverse=True,
        )

        team_idx = next((i for i, t in enumerate(conf_teams) if t["abbr"] == abbr), None)
        if team_idx is None:
            return None

        # Skip: team clearly leads their division → division clinch is the primary scenario
        div       = DIVISION_MAP.get(abbr, "")
        div_rivals = [r for r in DIVISION_RIVALS.get(div, []) if r != abbr]
        if div_rivals:
            best_rival_wins = max(
                self.standings.get(r, {}).get("wins", 0) for r in div_rivals
            )
            if sd["wins"] > best_rival_wins:
                return None
            div_order = self.tiebreaker_order.get(div, [])
            if div_order and div_order[0] == abbr:
                return None

        team_wins      = sd["wins"]
        team_rem_list  = self._remaining.get(abbr, [])
        team_remaining = len(team_rem_list)

        # Already clinched: fewer than 7 conference opponents can possibly finish with
        # MORE wins than the team's current win total (team is mathematically locked in)
        teams_that_can_exceed = [
            t for t in conf_teams
            if t["abbr"] != abbr
            and t["wins"] + len(self._remaining.get(t["abbr"], [])) > team_wins
        ]
        if len(teams_that_can_exceed) < 7:
            return Scenario(
                iri=str(SCENARIO[f"{abbr}_ClinchWildcard_{conf}"]),
                label=f"{abbr} clinches {conf} wildcard berth",
                beneficiary=abbr,
                scenario_type="clinch_wildcard",
                required_wins=[],
                required_losses=[],
                remaining_games=0,
                is_active=False,
            )

        # Already eliminated from all playoff contention
        if self._already_wildcard_eliminated(abbr, sd):
            return None

        # Identify the biggest threats: non-top-7 teams that could jump in at team's expense
        current_top7_set = {t["abbr"] for t in conf_teams[:7]}
        danger_teams = sorted(
            [t for t in conf_teams
             if t["abbr"] != abbr
             and t["abbr"] not in current_top7_set
             and t["wins"] + len(self._remaining.get(t["abbr"], [])) >= team_wins],
            key=lambda t: t["wins"] + len(self._remaining.get(t["abbr"], [])),
            reverse=True,
        )[:4]

        # Calculate wins needed and rival loss requirements
        wins_needed:           int              = 0
        rival_losses_needed:   dict[str, int]   = {}
        rival_games_remaining: dict[str, int]   = {}

        for danger in danger_teams:
            d_abbr = danger["abbr"]
            d_wins = danger["wins"]
            d_rem  = len(self._remaining.get(d_abbr, []))
            rival_games_remaining[d_abbr] = d_rem
            d_max  = d_wins + d_rem

            if d_max < team_wins:
                continue

            magic = d_max - team_wins + 1
            if magic <= 0:
                continue

            total_rem = team_remaining + d_rem
            if total_rem == 0 or magic > total_rem:
                continue

            t_wins  = max(0, min(round(magic * team_remaining / total_rem), team_remaining))
            r_losses = magic - t_wins

            if r_losses > d_rem:
                r_losses = d_rem
                t_wins   = min(max(0, magic - r_losses), team_remaining)

            wins_needed = max(wins_needed, t_wins)
            if r_losses > 0:
                rival_losses_needed[d_abbr] = r_losses

        # Cap required_losses at 3 (top threats only)
        required_losses = list(rival_losses_needed.keys())[:3]
        rival_losses_needed = {k: rival_losses_needed[k] for k in required_losses}

        # Key matchups: remaining games against conference danger teams
        danger_set = {d["abbr"] for d in danger_teams}
        key_wins_vs: list[str] = []
        seen: set[str] = set()
        for game in team_rem_list:
            opp = game["away"]["abbr"] if game["home"]["abbr"] == abbr else game["home"]["abbr"]
            if opp in danger_set and opp not in seen:
                key_wins_vs.append(opp)
                seen.add(opp)

        required_wins   = [abbr] if wins_needed > 0 else []
        remaining_count = wins_needed + sum(rival_losses_needed.values())
        is_active       = wins_needed > 0 or bool(rival_losses_needed)

        return Scenario(
            iri=str(SCENARIO[f"{abbr}_ClinchWildcard_{conf}"]),
            label=f"{abbr} clinches {conf} wildcard berth",
            beneficiary=abbr,
            scenario_type="clinch_wildcard",
            required_wins=required_wins,
            required_losses=required_losses,
            remaining_games=remaining_count,
            is_active=is_active,
            wins_needed=wins_needed,
            key_wins_vs=key_wins_vs,
            rival_losses_needed=rival_losses_needed,
            rival_games_remaining=rival_games_remaining,
        )

    def _build_division_elimination(self, abbr: str, sd: dict) -> Scenario | None:
        """
        Division elimination: team cannot finish first in their division.
        Distinct from wildcard elimination — a team can be division-eliminated
        while still in the wild card race.
        """
        div       = DIVISION_MAP.get(abbr, "")
        div_rivals = [r for r in DIVISION_RIVALS.get(div, []) if r != abbr]
        if not div_rivals:
            return None

        team_wins      = sd["wins"]
        team_remaining = len(self._remaining.get(abbr, []))
        max_team_wins  = team_wins + team_remaining

        already_eliminated = any(
            self.standings.get(r, {}).get("wins", 0) > max_team_wins
            for r in div_rivals
        )

        eliminators = [
            r for r in div_rivals
            if self.standings.get(r, {}).get("wins", 0) + len(self._remaining.get(r, [])) > max_team_wins
        ][:4]

        if not eliminators and not already_eliminated:
            return None

        slug   = f"{abbr}_EliminatedDivision_{div}"
        sc_iri = str(SCENARIO[slug])
        label  = f"{abbr} eliminated from {div} division race"

        return Scenario(
            iri=sc_iri,
            label=label,
            beneficiary=abbr,
            scenario_type="eliminated_division",
            required_wins=eliminators,
            required_losses=[],
            remaining_games=0,
            is_active=not already_eliminated,
        )

    def _build_wildcard_elimination(self, abbr: str, sd: dict) -> Scenario | None:
        """
        Wildcard elimination: team cannot reach any playoff berth (top 7 in conference).
        """
        conf = CONFERENCE_MAP.get(abbr, "")
        div  = DIVISION_MAP.get(abbr, "")

        div_rivals = [r for r in DIVISION_RIVALS.get(div, []) if r != abbr]
        best_rival_wins = max(
            (self.standings.get(r, {}).get("wins", 0) for r in div_rivals),
            default=0,
        )
        if sd["wins"] > best_rival_wins:
            return None

        conf_teams = sorted(
            [s for s in self.standings.values() if CONFERENCE_MAP.get(s["abbr"]) == conf],
            key=lambda t: t["win_pct"],
            reverse=True,
        )

        team_wins      = sd["wins"]
        team_remaining = len(self._remaining.get(abbr, []))
        max_team_wins  = team_wins + team_remaining

        teams_ahead = [
            t for t in conf_teams
            if t["abbr"] != abbr and t["wins"] > max_team_wins
        ]
        already_eliminated = len(teams_ahead) >= 7

        eliminators = [
            t["abbr"] for t in conf_teams
            if t["abbr"] != abbr and
               t["wins"] + len(self._remaining.get(t["abbr"], [])) > max_team_wins
        ][:4]

        if not eliminators and not already_eliminated:
            return None

        slug   = f"{abbr}_EliminatedWildcard_{conf}"
        sc_iri = str(SCENARIO[slug])
        label  = f"{abbr} eliminated from {conf} playoff contention"

        return Scenario(
            iri=sc_iri,
            label=label,
            beneficiary=abbr,
            scenario_type="eliminated_wildcard",
            required_wins=eliminators,
            required_losses=[],
            remaining_games=0,
            is_active=not already_eliminated,
        )

    def _already_wildcard_eliminated(self, abbr: str, sd: dict) -> bool:
        """True if the team is already mathematically out of all playoff contention."""
        conf = CONFERENCE_MAP.get(abbr, "")
        team_max = sd["wins"] + len(self._remaining.get(abbr, []))
        conf_teams_ahead = [
            s for s in self.standings.values()
            if s["abbr"] != abbr
            and CONFERENCE_MAP.get(s["abbr"]) == conf
            and s["wins"] > team_max
        ]
        return len(conf_teams_ahead) >= 7

    # ── Tiebreaker helpers ────────────────────────────────────────────────────

    def _team_wins_tiebreaker_over(
        self, abbr: str, rival_abbr: str, div: str
    ) -> bool:
        """Return True if abbr ranks ahead of rival_abbr in the division tiebreaker."""
        order = self.tiebreaker_order.get(div, [])
        if not order:
            return False
        try:
            return order.index(abbr) < order.index(rival_abbr)
        except ValueError:
            return False

    def _sim_wins_out_tiebreaker(
        self, abbr: str, rival_abbr: str, div: str
    ) -> bool:
        """
        Project worst-case remaining game outcomes and run the full division
        tiebreaker on the resulting complete season:
          - rival wins every remaining H2H game (worst case for team)
          - team wins all other remaining games
          - rival wins all other remaining games
          - other games: home team wins

        Returns True if team still ranks ahead of rival after simulation.
        Falls back to snapshot tiebreaker_order when tied or on import error.
        """
        import sys as _sys
        from pathlib import Path as _Path

        _root = str(_Path(__file__).parent.parent)
        if _root not in _sys.path:
            _sys.path.insert(0, _root)

        try:
            from tiebreaker import Team as TBTeam, Game as TBGame, resolve_division_tie
        except ImportError:
            return self._team_wins_tiebreaker_over(abbr, rival_abbr, div)

        projected: list = [
            TBGame.from_dict(g) for g in self.games if g.get("status") == "post"
        ]

        extra_wins:   dict[str, int] = {}
        extra_losses: dict[str, int] = {}
        seen: set = set()

        for game in self.games:
            if game.get("status") not in ("pre", "in"):
                continue
            key = game.get("id") or id(game)
            if key in seen:
                continue
            seen.add(key)

            home = game["home"]["abbr"]
            away = game["away"]["abbr"]

            if {home, away} == {abbr, rival_abbr}:
                winner, loser = rival_abbr, abbr
            elif abbr in (home, away):
                winner = abbr
                loser  = away if home == abbr else home
            elif rival_abbr in (home, away):
                winner = rival_abbr
                loser  = away if home == rival_abbr else home
            else:
                winner, loser = home, away

            extra_wins[winner]  = extra_wins.get(winner, 0) + 1
            extra_losses[loser] = extra_losses.get(loser, 0) + 1

            hs  = 21 if winner == home else 17
            as_ = 21 if winner == away else 17
            projected.append(TBGame(
                id=f"sim_{key}",
                week=game.get("week", 0),
                season=game.get("season", 2025),
                home_team_id=home,
                away_team_id=away,
                home_score=hs,
                away_score=as_,
                status="post",
            ))

        all_teams: list = [
            TBTeam(
                id=a,
                name=sd.get("name", a),
                division=DIVISION_MAP.get(a, ""),
                conference=CONFERENCE_MAP.get(a, ""),
                wins=sd["wins"]     + extra_wins.get(a, 0),
                losses=sd["losses"] + extra_losses.get(a, 0),
                ties=sd.get("ties", 0),
            )
            for a, sd in self.standings.items()
        ]

        team_obj  = next((t for t in all_teams if t.id == abbr),       None)
        rival_obj = next((t for t in all_teams if t.id == rival_abbr), None)
        if not team_obj or not rival_obj:
            return self._team_wins_tiebreaker_over(abbr, rival_abbr, div)

        result = resolve_division_tie([team_obj, rival_obj], projected, all_teams)
        if result[0].id == abbr:
            return True
        if result[0].id == rival_abbr:
            return False
        return self._team_wins_tiebreaker_over(abbr, rival_abbr, div)

    # ── RDF writer ────────────────────────────────────────────────────────────

    def _write_scenario(self, sc: Scenario) -> None:
        g       = self._g
        sc_iri  = URIRef(sc.iri)
        ben_iri = _team_iri(sc.beneficiary)

        g.add((sc_iri, RDF.type,             PLAYOFF.Scenario))
        g.add((sc_iri, NFL.name,             Literal(sc.label)))
        g.add((sc_iri, PLAYOFF.beneficiary,  ben_iri))
        g.add((sc_iri, NFL["scenarioType"],  Literal(sc.scenario_type)))
        g.add((sc_iri, NFL["isActive"],      Literal(sc.is_active,        datatype=XSD.boolean)))
        g.add((sc_iri, NFL["remainingGames"], Literal(sc.remaining_games,  datatype=XSD.integer)))

        for win_abbr in sc.required_wins:
            req_iri = URIRef(f"{sc.iri}:req:win:{win_abbr}")
            g.add((sc_iri,  PLAYOFF.requires,       req_iri))
            g.add((req_iri, NFL["requiresWinFrom"], _team_iri(win_abbr)))
            g.add((req_iri, NFL["outcomeType"],     Literal("win")))

        for loss_abbr in sc.required_losses:
            req_iri = URIRef(f"{sc.iri}:req:loss:{loss_abbr}")
            g.add((sc_iri,  PLAYOFF.requires,        req_iri))
            g.add((req_iri, NFL["requiresLossFrom"], _team_iri(loss_abbr)))
            g.add((req_iri, NFL["outcomeType"],      Literal("loss")))

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
        """Find the IRI of an upcoming game outcome node for a team."""
        remaining = self._remaining.get(team_abbr, [])
        if not remaining:
            return None
        game = remaining[0]
        winner_abbr = team_abbr if win else (
            game["away"]["abbr"] if game["home"]["abbr"] == team_abbr
            else game["home"]["abbr"]
        )
        return _outcome_iri(game, winner_abbr)


# ── Display helper ─────────────────────────────────────────────────────────────

def _print_clinch_path(sc: Scenario, team_remaining: int) -> None:
    """Print the most likely path description for a clinch scenario."""
    # Team wins line
    if sc.wins_needed > 0:
        if sc.key_wins_vs and sc.wins_needed <= len(sc.key_wins_vs):
            # All needed wins can come from specific head-to-head matchups
            vs_str = " or ".join(sc.key_wins_vs[: sc.wins_needed])
            suffix = f"vs {vs_str}"
            print(f"           Win {sc.wins_needed} game{'s' if sc.wins_needed != 1 else ''} ({suffix})")
        elif sc.key_wins_vs:
            vs_str = ", ".join(sc.key_wins_vs)
            print(
                f"           Win {sc.wins_needed} of {team_remaining} remaining games"
                f" (any opponent; key matchups: {vs_str})"
            )
        else:
            print(
                f"           Win {sc.wins_needed} of {team_remaining} remaining games"
                f" (any opponent)"
            )

    # Rival loss lines
    for rival, losses in sc.rival_losses_needed.items():
        rival_rem      = sc.rival_games_remaining.get(rival, losses)
        wins_allowed   = rival_rem - losses
        print(
            f"           Need {rival} to go {wins_allowed}-{losses}+ or worse"
            f" ({rival_rem} games remaining)"
        )
