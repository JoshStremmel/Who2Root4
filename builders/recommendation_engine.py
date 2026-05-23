"""
recommendation_engine.py
────────────────────────
Generates rooting recommendations by reasoning over the holonic RDF graph.

Modes
─────
  OVERALL       — base playoff contention (division + wildcard, combined)
  DIVISION      — win the division title (only div-rival games matter)
  WILDCARD      — earn a wild-card berth (all conf games equal weight)
  CONF_ONE_SEED — get the #1 conference seed (conf games, weighted by rival wins)
  TANK          — worst record for best draft pick (reversed logic)

Usage
─────
    from recommendation_engine import RecommendationEngine, Mode
    engine = RecommendationEngine(builder.dataset, "CIN", mode=Mode.DIVISION)
    recs   = engine.generate_recommendations()
    engine.print_recommendations(recs)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Any

from rdflib import RDF, XSD, Dataset, Literal, URIRef

from rdf_builder import (
    DIVISION_MAP, CONFERENCE_MAP, GAME, GRAPH, IMPACT, NFL, PLAYOFF, REC, TEAM, USER,
    _game_iri, _team_iri,
)

logger = logging.getLogger(__name__)

_STRENGTH_WEIGHT: dict[str, float] = {"high": 0.35, "medium": 0.20, "low": 0.10}


class Mode(str, Enum):
    OVERALL       = "overall"
    DIVISION      = "division"
    WILDCARD      = "wildcard"
    CONF_ONE_SEED = "conf_one_seed"
    TANK          = "tank"


@dataclass
class RootingRecommendation:
    game_iri:        str
    root_for_abbr:   str
    root_for_name:   str
    against_abbr:    str
    against_name:    str
    score:           float
    reasoning:       str
    home_abbr:       str
    away_abbr:       str
    category:        str   = ""
    strength:        str   = ""
    strength_weight: float = 0.0


class RecommendationEngine:
    """
    Reasons over the holonic dataset to produce ranked rooting recommendations
    for a given user's favorite team.
    """

    def __init__(
        self,
        dataset:               Dataset,
        favorite_team_abbr:    str,
        disliked_teams:        list[str] | None = None,
        user_iri:              str = "urn:nfl:user:default",
        prev_season_standings: list[dict] | None = None,
        current_week:          int | None = None,
        mode:                  str | Mode = Mode.OVERALL,
    ) -> None:
        self.dataset          = dataset
        self.fav_abbr         = favorite_team_abbr.upper()
        self.fav_iri          = _team_iri(self.fav_abbr)
        self.disliked         = [d.upper() for d in (disliked_teams or [])]
        self.user_iri_str     = user_iri
        self.user_iri         = URIRef(user_iri)
        self.fav_div          = DIVISION_MAP.get(self.fav_abbr, "")
        self.fav_conf         = CONFERENCE_MAP.get(self.fav_abbr, "")
        self.current_week     = current_week
        self.mode             = Mode(mode) if isinstance(mode, str) else mode
        self._wins_cache:   dict[str, int] = {}
        self._losses_cache: dict[str, int] = {}
        self._future_fav_opponents: set[str] | None = None
        self._prev_wins: dict[str, int] = {
            sd["abbr"]: sd["wins"]
            for sd in (prev_season_standings or [])
        }

    # ── Public API ────────────────────────────────────────────────────────────

    def available_modes(self) -> list[Mode]:
        """Return which modes are currently reachable given standings."""
        modes = [Mode.OVERALL]
        if self._division_path_alive():
            modes.append(Mode.DIVISION)
        if self._has_wildcard_path():
            modes.append(Mode.WILDCARD)
        if self._conf_one_seed_possible():
            modes.append(Mode.CONF_ONE_SEED)
        modes.append(Mode.TANK)
        return modes

    def generate_recommendations(self) -> list[RootingRecommendation]:
        """Score every upcoming/live game and return a ranked list."""
        games = self._fetch_relevant_games()
        recs  = []
        for game_data in games:
            rec = self._score_game(game_data)
            if rec is not None:
                recs.append(rec)
        recs.sort(key=lambda r: (r.score, r.strength_weight), reverse=True)
        return recs

    def write_recommendations_to_graph(
        self, recs: list[RootingRecommendation]
    ) -> None:
        """Materialise recommendations as RDF triples in graph:recommendations."""
        g = self.dataset.graph(GRAPH["recommendations"])

        g.add((self.user_iri, RDF.type, NFL.User))
        g.add((self.user_iri, NFL.favoriteTeam, self.fav_iri))
        for d in self.disliked:
            g.add((self.user_iri, NFL.dislikes, _team_iri(d)))

        for i, rec in enumerate(recs):
            rec_iri = REC[f"rec_{i+1:03d}_{rec.root_for_abbr}"]
            g.add((rec_iri, RDF.type,             NFL.Recommendation))
            g.add((rec_iri, NFL.rootFor,          _team_iri(rec.root_for_abbr)))
            g.add((rec_iri, NFL.against,          _team_iri(rec.against_abbr)))
            g.add((rec_iri, NFL.forGame,          URIRef(rec.game_iri)))
            g.add((rec_iri, NFL.benefitsTeam,     self.fav_iri))
            g.add((rec_iri, NFL.recommendationScore,
                    Literal(round(rec.score, 4), datatype=XSD.float)))
            g.add((rec_iri, NFL.reasoning,        Literal(rec.reasoning)))
            if rec.category:
                g.add((rec_iri, NFL.category, Literal(rec.category)))
            if rec.strength:
                g.add((rec_iri, NFL.strength, Literal(rec.strength)))
            g.add((rec_iri, NFL.strengthWeight,
                    Literal(round(rec.strength_weight, 4), datatype=XSD.float)))
            g.add((rec_iri, IMPACT.improvesOdds, self.fav_iri))
            g.add((_team_iri(rec.against_abbr), IMPACT.harmsOdds, self.fav_iri))
            g.add((self.user_iri, NFL.shouldRootFor, rec_iri))

        logger.info("Wrote %d recommendations to graph:recommendations", len(recs))

    def print_recommendations(self, recs: list[RootingRecommendation]) -> None:
        """Print a human-readable ranked recommendation list."""
        fav_name = self._team_name(self.fav_abbr)
        mode_labels = {
            Mode.OVERALL:       "Overall Playoff Contention",
            Mode.DIVISION:      f"Division Title Path ({self.fav_div})",
            Mode.WILDCARD:      f"{self.fav_conf} Wild Card Path",
            Mode.CONF_ONE_SEED: f"{self.fav_conf} Conference #1 Seed",
            Mode.TANK:          "Tank for Draft Pick",
        }
        print(f"\n{'='*65}")
        print(f"  ROOTING GUIDE for {fav_name} fans")
        print(f"  Mode: {mode_labels.get(self.mode, self.mode.value)}")

        available = self.available_modes()
        if len(available) < 5:
            avail_str = " | ".join(mode_labels.get(m, m.value) for m in available)
            print(f"  Available: {avail_str}")

        print(f"{'='*65}")

        if self.mode == Mode.TANK:
            fav_wins   = self._wins(self.fav_abbr)
            fav_losses = self._losses(self.fav_abbr)
            print(f"  Record: {fav_wins}-{fav_losses}  |  Root for {fav_name} to LOSE every game")
        elif self._is_playoff_eliminated(self.fav_abbr):
            print(f"  Note: {fav_name} have been eliminated from playoff contention.")

        # ── Fav team's own game ───────────────────────────────────────────────
        fav_games = self._get_fav_game_info()
        if fav_games:
            print(f"\n  YOUR GAME")
            for g in fav_games:
                loc      = "vs" if g["is_home"] else "@"
                opp_name = self._team_name(g["opponent"])
                print(f"  {fav_name} {loc} {opp_name}")
                print(f"  → {g['blurb']}")

        if not recs:
            print("  No actionable recommendations this week.")
            return

        # ── Tank mode display ─────────────────────────────────────────────────
        if self.mode == Mode.TANK:
            print(f"\n  DRAFT POSITIONING — games closest to your win total matter most")
            for i, r in enumerate(recs, 1):
                bar = "#" * int(r.score * 20)
                print(f"\n  #{i}  Root for: {r.root_for_name:25s}  vs  {r.against_name}")
                print(f"      Draft Impact: {r.score:.3f}  [{bar:<20}]")
                print(f"      Why: {r.reasoning}")
            print()
            return

        # ── Standard display ──────────────────────────────────────────────────
        impact_label = {
            Mode.DIVISION:      "division impact",
            Mode.WILDCARD:      "wildcard impact",
            Mode.CONF_ONE_SEED: "#1 seed impact",
        }.get(self.mode, "playoff impact")

        impactful = [r for r in recs if r.score > 0.001]
        no_impact  = [r for r in recs if r.score <= 0.001]

        for i, r in enumerate(impactful, 1):
            bar = "#" * int(r.score * 20)
            print(f"\n  #{i}  Root for: {r.root_for_name:25s}  vs  {r.against_name}")
            if r.category and r.strength:
                print(f"      [{r.strength.upper():<6}] {r.category}")
            print(f"      Score:    {r.score:.3f}  [{bar:<20}]")
            print(f"      Why:      {r.reasoning}")

        if no_impact:
            print(f"\n  ── No {impact_label} ({len(no_impact)} game(s)) ────────────────")
            for i, r in enumerate(no_impact, len(impactful) + 1):
                print(f"\n  #{i}  Root for: {r.root_for_name:25s}  vs  {r.against_name}")
                print(f"      Score:    0.000  [no {impact_label}]")
                print(f"      Why:      {r.reasoning}")
        print()

    # ── Scoring Logic ─────────────────────────────────────────────────────────

    def _score_game(self, gd: dict) -> RootingRecommendation | None:
        """
        Score a single game. Returns None only for fav team's own games.
        Branches to _score_game_tank() in TANK mode.
        """
        home = gd["home_abbr"]
        away = gd["away_abbr"]
        if home == self.fav_abbr or away == self.fav_abbr:
            return None

        if self.mode == Mode.TANK:
            return self._score_game_tank(gd)

        is_postseason = gd.get("is_postseason", False)

        active_scenario_wins   = self._active_scenario_wins()
        active_scenario_losses = self._active_scenario_losses()
        has_wc_path            = self._has_wildcard_path()

        home_conf = CONFERENCE_MAP.get(home, "")
        away_conf = CONFERENCE_MAP.get(away, "")
        if is_postseason or home_conf == self.fav_conf or away_conf == self.fav_conf:
            home_playoff_val = self._score_for(
                home, away,
                DIVISION_MAP.get(home, ""), home_conf,
                active_scenario_wins, active_scenario_losses,
                is_postseason, has_wc_path,
            )
            away_playoff_val = self._score_for(
                away, home,
                DIVISION_MAP.get(away, ""), away_conf,
                active_scenario_wins, active_scenario_losses,
                is_postseason, has_wc_path,
            )
            underdog = self._resolve_underdog(home, away, gd)
            _ud = 0.02
            adj_home = home_playoff_val + (_ud if home == underdog else 0.0)
            adj_away = away_playoff_val + (_ud if away == underdog else 0.0)
            if adj_home >= adj_away:
                playoff_root, playoff_against, playoff_score = home, away, home_playoff_val
            else:
                playoff_root, playoff_against, playoff_score = away, home, away_playoff_val
        else:
            playoff_root, playoff_against, playoff_score = home, away, 0.0

        if not is_postseason and playoff_score > 0 and (
            self._is_playoff_eliminated(playoff_root)
            or self._is_playoff_eliminated(playoff_against)
        ):
            playoff_score = 0.0

        # ── Scenario detectors (mode-filtered) ────────────────────────────────
        fav_future_opps     = self._get_future_fav_opponents()
        all_scenario_recs: list[dict] = []

        # DivisionRivalTank: all non-tank modes
        all_scenario_recs += self._scenario_division_rival_tank(home, away)

        # OpponentTanking: all non-tank modes
        all_scenario_recs += self._scenario_opponent_tanking(home, away, fav_future_opps)

        # PlayoffSoftening / UpsetRooting: not DIVISION (irrelevant for div title focus)
        if self.mode not in (Mode.DIVISION,):
            all_scenario_recs += self._scenario_playoff_softening(home, away)
            all_scenario_recs += self._scenario_upset_rooting(home, away)

        # DraftPositioning: OVERALL and WILDCARD only
        if self.mode in (Mode.OVERALL, Mode.WILDCARD):
            all_scenario_recs += self._scenario_draft_positioning(home, away)

        # Dislikes: always
        all_scenario_recs += self._scenario_dislikes(home, away)

        home_weight = sum(s["strength_weight"] for s in all_scenario_recs if s["root_for"] == home)
        away_weight = sum(s["strength_weight"] for s in all_scenario_recs if s["root_for"] == away)

        if home_weight > 0 or away_weight > 0:
            if home_weight >= away_weight:
                root_abbr, against_abbr = home, away
                matching = [s for s in all_scenario_recs if s["root_for"] == home]
                scenario_weight = home_weight
            else:
                root_abbr, against_abbr = away, home
                matching = [s for s in all_scenario_recs if s["root_for"] == away]
                scenario_weight = away_weight

            primary         = max(matching, key=lambda s: s["strength_weight"])
            category        = primary["category"]
            strength        = primary["strength"]
            strength_weight = primary["strength_weight"]

            total_score = playoff_score if root_abbr == playoff_root else 0.0

            sorted_scenarios = sorted(matching, key=lambda s: s["strength_weight"], reverse=True)
            why_parts = [sorted_scenarios[0]["why"]]
            if (len(sorted_scenarios) > 1
                    and sorted_scenarios[1]["strength_weight"] >= 0.20
                    and sorted_scenarios[1]["category"] != sorted_scenarios[0]["category"]):
                why_parts.append(sorted_scenarios[1]["why"])

            if playoff_score > 0 and root_abbr == playoff_root and sorted_scenarios[0]["strength_weight"] < 0.35:
                ps_str = self._build_reasoning(
                    root_abbr, against_abbr,
                    DIVISION_MAP.get(root_abbr, ""),
                    CONFERENCE_MAP.get(root_abbr, ""),
                    playoff_score,
                    active_scenario_wins, active_scenario_losses,
                    is_postseason, has_wc_path,
                )
                ps_str = ps_str.rsplit(" (score", 1)[0]
                if ps_str and ps_str not in why_parts:
                    why_parts.append(ps_str)
            reasoning = "; ".join(why_parts) + f" (score {total_score:.2f})"

        else:
            root_abbr, against_abbr = playoff_root, playoff_against
            total_score     = playoff_score
            strength_weight = 0.0

            if total_score > 0:
                category = "direct_playoff_impact"
                strength = "low"
            else:
                category = "no_impact"
                strength = ""

            reasoning = self._build_reasoning(
                root_abbr, against_abbr,
                DIVISION_MAP.get(root_abbr, ""),
                CONFERENCE_MAP.get(root_abbr, ""),
                total_score,
                active_scenario_wins, active_scenario_losses,
                is_postseason, has_wc_path,
            )

        if total_score > 0:
            avg_strength = (self._strength_score(home) + self._strength_score(away)) / 2
            total_score  = min(total_score + 0.05 * avg_strength, 1.0)

        return RootingRecommendation(
            game_iri        = gd["game_iri"],
            root_for_abbr   = root_abbr,
            root_for_name   = self._team_name(root_abbr),
            against_abbr    = against_abbr,
            against_name    = self._team_name(against_abbr),
            score           = total_score,
            reasoning       = reasoning,
            home_abbr       = home,
            away_abbr       = away,
            category        = category,
            strength        = strength,
            strength_weight = strength_weight,
        )

    def _score_game_tank(self, gd: dict) -> RootingRecommendation | None:
        """
        Tank mode: root for the team with fewer (or equal) wins so they move
        up the standings and stop competing for the worst-record draft slot.

        Score = proximity of both teams to fav team's win total (0–1).
        Division rivals winning gets a bonus (want them to accumulate wins
        so the whole division isn't tanking below us).
        """
        home = gd["home_abbr"]
        away = gd["away_abbr"]
        if home == self.fav_abbr or away == self.fav_abbr:
            return None

        fav_wins  = self._wins(self.fav_abbr)
        home_wins = self._wins(home)
        away_wins = self._wins(away)

        # Root for the team with fewer wins (bring them up, stay at the bottom)
        if home_wins <= away_wins:
            root_abbr, against_abbr = home, away
            root_wins, opp_wins = home_wins, away_wins
        else:
            root_abbr, against_abbr = away, home
            root_wins, opp_wins = away_wins, home_wins

        # Score: teams closest to fav's win count affect our draft slot most
        home_gap = abs(home_wins - fav_wins)
        away_gap = abs(away_wins - fav_wins)
        min_gap  = min(home_gap, away_gap)

        if min_gap == 0:
            base_score = 0.50
        elif min_gap == 1:
            base_score = 0.35
        elif min_gap == 2:
            base_score = 0.20
        elif min_gap == 3:
            base_score = 0.10
        else:
            base_score = 0.05

        # Division rivals winning moves them up and out of our draft range
        is_div_rival = DIVISION_MAP.get(root_abbr) == self.fav_div
        if is_div_rival:
            base_score = min(base_score + 0.15, 1.0)

        # Reasoning
        if root_wins < fav_wins:
            why = (
                f"{root_abbr} ({root_wins}W) is below you in wins — "
                f"their win brings them up and protects your draft slot"
            )
        elif root_wins == fav_wins:
            why = (
                f"{root_abbr} ({root_wins}W) is tied with you — "
                f"their win separates them from your draft range"
            )
        else:
            why = (
                f"neither team threatens your draft slot; "
                f"root for the worse-record team to clear the field below you"
            )

        strength = "high" if base_score >= 0.35 else ("medium" if base_score >= 0.20 else "low")

        return RootingRecommendation(
            game_iri        = gd["game_iri"],
            root_for_abbr   = root_abbr,
            root_for_name   = self._team_name(root_abbr),
            against_abbr    = against_abbr,
            against_name    = self._team_name(against_abbr),
            score           = base_score,
            reasoning       = why + f" (score {base_score:.2f})",
            home_abbr       = home,
            away_abbr       = away,
            category        = "TankPositioning",
            strength        = strength,
            strength_weight = _STRENGTH_WEIGHT.get(strength, 0.10),
        )

    def _score_for(
        self,
        candidate:      str,
        opponent:       str,
        candidate_div:  str,
        candidate_conf: str,
        scenario_wins:   set[str],
        scenario_losses: set[str],
        is_postseason:   bool,
        has_wc_path:     bool = True,
    ) -> float:
        """
        Return a raw playoff-impact score for rooting for `candidate` winning
        (= `opponent` losing). Weights depend on self.mode.

        OVERALL       — division urgency + wildcard conference bonus
        DIVISION      — division bonus only; conference non-div games get 0
        WILDCARD      — flat 0.20 for any conference opponent loss
        CONF_ONE_SEED — flat bonus scaled by opponent's win count (leader matters most)
        """
        score    = 0.0
        opp_div  = DIVISION_MAP.get(opponent, "")
        opp_conf = CONFERENCE_MAP.get(opponent, "")
        is_same_div  = (opp_div  == self.fav_div)
        is_same_conf = (opp_conf == self.fav_conf)

        if self.mode == Mode.DIVISION:
            if is_same_div:
                fav_contending = self._in_division_contention(self.fav_abbr)
                opp_contending = self._in_division_contention(opponent)
                if fav_contending and opp_contending:
                    games_rem     = self._games_remaining()
                    fav_gb        = self._games_back(self.fav_abbr)
                    title_urgency = max(0.0, 1.0 - fav_gb / max(games_rem, 1))
                    score += 0.25 + 0.25 * title_urgency   # 0.25–0.50
                else:
                    score += 0.25
            # non-division games contribute 0 conf bonus in DIVISION mode

        elif self.mode == Mode.WILDCARD:
            # All conference losses are equally valuable for wildcard positioning
            if is_same_conf or is_same_div:
                score += 0.20

        elif self.mode == Mode.CONF_ONE_SEED:
            # Any conference loss helps; opponent's win count weights urgency
            if is_same_conf or is_same_div:
                opp_wins_norm = min(self._wins(opponent) / 17.0, 1.0)
                score += 0.20 + 0.10 * opp_wins_norm   # 0.20–0.30

        else:  # Mode.OVERALL
            if is_same_div:
                fav_contending = self._in_division_contention(self.fav_abbr)
                opp_contending = self._in_division_contention(opponent)
                if fav_contending and opp_contending:
                    games_rem     = self._games_remaining()
                    fav_gb        = self._games_back(self.fav_abbr)
                    title_urgency = max(0.0, 1.0 - fav_gb / max(games_rem, 1))
                    score += 0.20 + 0.20 * title_urgency
                elif has_wc_path:
                    score += 0.20
            elif is_same_conf and has_wc_path:
                score += 0.20

        # Scenario-aware bonus (active clinch/elimination nodes in the graph)
        if candidate in scenario_wins:
            score += 0.25
        if opponent in scenario_losses:
            score += 0.25

        # Dislike bonus
        if opponent in self.disliked:
            score += 0.15

        # Record closeness (small tiebreaker)
        fav_rec = self._win_pct(self.fav_abbr)
        opp_rec = self._win_pct(opponent)
        delta   = abs(fav_rec - opp_rec)
        score  += max(0.0, 0.10 - delta * 0.2)

        if is_postseason:
            score += 0.10

        return score

    def _build_reasoning(
        self,
        root_abbr:       str,
        against_abbr:    str,
        root_div:        str,
        root_conf:       str,
        score:           float,
        scenario_wins:   set[str],
        scenario_losses: set[str],
        is_postseason:   bool,
        has_wc_path:     bool = True,
    ) -> str:
        parts    = []
        opp_div  = DIVISION_MAP.get(against_abbr, "")
        opp_conf = CONFERENCE_MAP.get(against_abbr, "")

        # Mode-specific target label
        target = {
            Mode.DIVISION:      "division title odds",
            Mode.CONF_ONE_SEED: "#1 seed odds",
        }.get(self.mode, "wild card odds")

        if is_postseason:
            parts.append("postseason game — every result reshapes the bracket")
        elif opp_div == self.fav_div:
            fav_contending = self._in_division_contention(self.fav_abbr)
            opp_contending = self._in_division_contention(against_abbr)
            if fav_contending and opp_contending:
                fav_gb    = self._games_back(self.fav_abbr)
                opp_gb    = self._games_back(against_abbr)
                games_rem = self._games_remaining()
                if fav_gb == 0.0 and opp_gb > 0.0:
                    gb_str = f"{against_abbr} is {opp_gb:.1f} GB behind you"
                elif opp_gb == 0.0 and fav_gb > 0.0:
                    gb_str = f"you are {fav_gb:.1f} GB behind {against_abbr}"
                elif fav_gb < opp_gb:
                    gb_str = f"{against_abbr} is {opp_gb - fav_gb:.1f} GB behind you"
                elif opp_gb < fav_gb:
                    gb_str = f"you are {fav_gb - opp_gb:.1f} GB behind {against_abbr}"
                else:
                    gb_str = "tied in the division"
                parts.append(
                    f"{against_abbr} is a division rival in a title race "
                    f"({gb_str}, {games_rem} weeks left) — their loss directly helps"
                )
            elif has_wc_path or self.mode == Mode.DIVISION:
                reason = (
                    "division title out of reach for your team"
                    if not self._in_division_contention(self.fav_abbr)
                    else f"{against_abbr} eliminated from division title race"
                )
                parts.append(
                    f"{against_abbr} is a division rival ({reason}) — "
                    f"their loss improves {target}"
                )
        elif opp_conf == self.fav_conf and (
            has_wc_path or self.mode in (Mode.WILDCARD, Mode.CONF_ONE_SEED)
        ):
            if self.mode == Mode.CONF_ONE_SEED:
                against_wins = self._wins(against_abbr)
                parts.append(
                    f"{against_abbr} ({against_wins}W) is a {self.fav_conf} rival — "
                    f"their loss improves {target}"
                )
            else:
                parts.append(
                    f"{against_abbr} is a conference competitor — "
                    f"their loss improves {target}"
                )

        if root_abbr in scenario_wins:
            parts.append(f"{root_abbr} winning satisfies an active clinch scenario requirement")
        if against_abbr in scenario_losses:
            parts.append(f"{against_abbr} losing satisfies an active clinch scenario requirement")
        if against_abbr in self.disliked:
            parts.append(f"you also dislike {against_abbr}")

        if not parts:
            parts.append("no direct playoff impact")

        return "; ".join(parts) + f" (score {score:.2f})"

    # ── New Scenario Detectors ────────────────────────────────────────────────

    def _scenario_division_rival_tank(self, home: str, away: str) -> list[dict]:
        """Root against any division rival. Strength: high."""
        results: list[dict] = []
        for team in (home, away):
            if DIVISION_MAP.get(team) == self.fav_div and team != self.fav_abbr:
                opponent = away if team == home else home
                results.append({
                    "root_for":        opponent,
                    "against":         team,
                    "category":        "DivisionRivalTank",
                    "strength":        "high",
                    "strength_weight": _STRENGTH_WEIGHT["high"],
                    "why": (
                        f"{team} is a division rival — root for their opponent "
                        f"to hurt their standings"
                    ),
                })
        return results

    def _scenario_opponent_tanking(
        self, home: str, away: str, future_opponents: set[str]
    ) -> list[dict]:
        """Root against upcoming fav-team opponents. Strength: medium."""
        results: list[dict] = []
        for team in (home, away):
            if team not in future_opponents:
                continue
            opponent = away if team == home else home
            w = self._wins(team)
            l = self._losses(team)
            if w > l:
                results.append({
                    "root_for":        opponent,
                    "against":         team,
                    "category":        "OpponentTanking",
                    "strength":        "medium",
                    "strength_weight": _STRENGTH_WEIGHT["medium"],
                    "why": (
                        f"{team} ({w}-{l}) is an upcoming opponent on a winning record — "
                        f"root against them to cool their momentum before your matchup"
                    ),
                })
            elif l > w:
                results.append({
                    "root_for":        opponent,
                    "against":         team,
                    "category":        "OpponentTanking",
                    "strength":        "medium",
                    "strength_weight": _STRENGTH_WEIGHT["medium"],
                    "why": (
                        f"{team} ({w}-{l}) is an upcoming opponent on a losing skid — "
                        f"root against them to keep their locker room fractured"
                    ),
                })
        return results

    def _scenario_playoff_softening(self, home: str, away: str) -> list[dict]:
        """Root against same-conference teams with winning records. Strength: medium."""
        results: list[dict] = []
        for team in (home, away):
            if team == self.fav_abbr:
                continue
            if CONFERENCE_MAP.get(team) != self.fav_conf:
                continue
            w = self._wins(team)
            l = self._losses(team)
            if w > l:
                opponent = away if team == home else home
                results.append({
                    "root_for":        opponent,
                    "against":         team,
                    "category":        "PlayoffSoftening",
                    "strength":        "medium",
                    "strength_weight": _STRENGTH_WEIGHT["medium"],
                    "why": (
                        f"{team} ({w}-{l}) is a {self.fav_conf} team projecting into "
                        f"playoff seeding — dent their momentum and expose their scheme"
                    ),
                })
        return results

    def _scenario_upset_rooting(self, home: str, away: str) -> list[dict]:
        """Root for the underdog when a conference rival is a heavy home favorite. Strength: medium."""
        results: list[dict] = []
        home_wins = self._wins(home)
        away_wins = self._wins(away)
        home_conf = CONFERENCE_MAP.get(home, "")

        if (home_conf == self.fav_conf
                and home != self.fav_abbr
                and home_wins - away_wins >= 4):
            gap = home_wins - away_wins
            results.append({
                "root_for":        away,
                "against":         home,
                "category":        "UpsetRooting",
                "strength":        "medium",
                "strength_weight": _STRENGTH_WEIGHT["medium"],
                "why": (
                    f"{home} ({home_wins}W) is a {self.fav_conf} heavy favorite at home "
                    f"vs {away} ({away_wins}W, {gap}-win gap) — "
                    f"trap game potential, root for the upset to expose their scheme"
                ),
            })
        return results

    def _scenario_draft_positioning(self, home: str, away: str) -> list[dict]:
        """
        Root against div rivals / conf threats with 6–9 wins — in no man's land.
        Strength: low.
        """
        results: list[dict] = []
        for team in (home, away):
            if team == self.fav_abbr:
                continue
            is_div_rival   = DIVISION_MAP.get(team) == self.fav_div
            is_conf_threat = CONFERENCE_MAP.get(team) == self.fav_conf
            if not (is_div_rival or is_conf_threat):
                continue
            w = self._wins(team)
            if 6 <= w <= 9:
                opponent = away if team == home else home
                label = "division rival" if is_div_rival else "conference threat"
                results.append({
                    "root_for":        opponent,
                    "against":         team,
                    "category":        "DraftPositioning",
                    "strength":        "low",
                    "strength_weight": _STRENGTH_WEIGHT["low"],
                    "why": (
                        f"{team} ({w}W) is a {label} stuck in no man's land — "
                        f"threatening week-to-week but not good enough to contend; "
                        f"keep them losing"
                    ),
                })
        return results

    def _scenario_dislikes(self, home: str, away: str) -> list[dict]:
        """Root against any disliked team regardless of conference. Strength: medium."""
        results: list[dict] = []
        for team in (home, away):
            if team in self.disliked:
                opponent = away if team == home else home
                results.append({
                    "root_for":        opponent,
                    "against":         team,
                    "category":        "Dislikes",
                    "strength":        "medium",
                    "strength_weight": _STRENGTH_WEIGHT["medium"],
                    "why":             f"you dislike {team}",
                })
        return results

    # ── Scenario helpers ──────────────────────────────────────────────────────

    def _active_scenario_wins(self) -> set[str]:
        q = f"""
        PREFIX nfl:  <urn:nfl:>
        PREFIX cga:  <urn:holonic:ontology:>
        SELECT ?team WHERE {{
            GRAPH ?g {{
                ?scenario nfl:isActive "true"^^<http://www.w3.org/2001/XMLSchema#boolean> ;
                          nfl:beneficiary <urn:nfl:holon:team:{self.fav_abbr}> .
                ?portal cga:sourceHolon ?scenario ;
                        nfl:requirementType "win" ;
                        cga:targetHolon ?team .
            }}
        }}
        """
        abbrs: set[str] = set()
        try:
            for row in self.dataset.query(q):
                abbrs.add(str(row.team).split(":")[-1])
        except Exception:
            pass
        return abbrs

    def _active_scenario_losses(self) -> set[str]:
        q = f"""
        PREFIX nfl:  <urn:nfl:>
        PREFIX cga:  <urn:holonic:ontology:>
        SELECT ?team WHERE {{
            GRAPH ?g {{
                ?scenario nfl:isActive "true"^^<http://www.w3.org/2001/XMLSchema#boolean> ;
                          nfl:beneficiary <urn:nfl:holon:team:{self.fav_abbr}> .
                ?portal cga:sourceHolon ?scenario ;
                        nfl:requirementType "loss" ;
                        cga:targetHolon ?team .
            }}
        }}
        """
        abbrs: set[str] = set()
        try:
            for row in self.dataset.query(q):
                abbrs.add(str(row.team).split(":")[-1])
        except Exception:
            pass
        return abbrs

    # ── Data helpers ──────────────────────────────────────────────────────────

    def _get_fav_game_info(self) -> list[dict]:
        """Return the fav team's upcoming/live game(s) this week with a win-impact blurb."""
        week_filter = (
            f"FILTER(?week = {self.current_week})"
            if self.current_week is not None else ""
        )
        fav_iri = f"urn:nfl:team:{self.fav_abbr}"
        q = f"""
        PREFIX nfl: <urn:nfl:>
        SELECT ?game ?home ?away WHERE {{
            GRAPH ?g {{
                ?game a nfl:Game ;
                      nfl:status ?status ;
                      nfl:homeTeam ?home ;
                      nfl:awayTeam ?away ;
                      nfl:week ?week .
                FILTER(?status IN ("pre", "in"))
                FILTER(?home = <{fav_iri}> || ?away = <{fav_iri}>)
                {week_filter}
            }}
        }}
        """
        results = []
        try:
            for row in self.dataset.query(q):
                home_abbr = self._abbr_from_iri(str(row.home))
                away_abbr = self._abbr_from_iri(str(row.away))
                opponent  = away_abbr if home_abbr == self.fav_abbr else home_abbr
                is_home   = home_abbr == self.fav_abbr
                results.append({
                    "home":     home_abbr,
                    "away":     away_abbr,
                    "opponent": opponent,
                    "is_home":  is_home,
                    "blurb":    self._win_impact_blurb(opponent),
                })
        except Exception:
            pass
        return results

    def _win_impact_blurb(self, opponent: str) -> str:
        """One-line description of what winning/losing the fav's own game would accomplish."""
        if self.mode == Mode.TANK:
            fav_wins   = self._wins(self.fav_abbr)
            fav_losses = self._losses(self.fav_abbr)
            opp_wins   = self._wins(opponent)
            return (
                f"TANK: root for {opponent} ({opp_wins}W) to WIN — "
                f"a {self.fav_abbr} loss improves draft positioning "
                f"(current: {fav_wins}-{fav_losses})"
            )

        games_rem    = self._games_remaining()
        fav_gb       = self._games_back(self.fav_abbr)
        is_div_rival = DIVISION_MAP.get(opponent) == self.fav_div

        if self._is_playoff_eliminated(self.fav_abbr):
            return "out of playoff contention — playing for pride and draft position"

        if self.mode == Mode.DIVISION or self._in_division_contention(self.fav_abbr):
            if fav_gb == 0.0:
                if is_div_rival:
                    opp_gb = self._games_back(opponent)
                    return (
                        f"win to extend your division lead over {opponent} "
                        f"({opp_gb:.1f} GB behind, {games_rem} weeks left)"
                    )
                return f"win to stay atop the {self.fav_div} ({games_rem} weeks left)"
            else:
                if is_div_rival:
                    return (
                        f"win to cut the gap — {self.fav_abbr} is {fav_gb:.1f} GB back "
                        f"with {games_rem} weeks left"
                    )
                return (
                    f"win to stay in the {self.fav_div} race "
                    f"({fav_gb:.1f} GB back, {games_rem} weeks left)"
                )

        if self.mode == Mode.CONF_ONE_SEED:
            conf_leader_wins = self._conf_leader_wins()
            fav_wins = self._wins(self.fav_abbr)
            gap = conf_leader_wins - fav_wins
            return (
                f"win to chase the {self.fav_conf} #1 seed "
                f"({gap}W behind the leader, {games_rem} weeks left)"
            )

        if self._has_wildcard_path():
            return f"win to strengthen your {self.fav_conf} wildcard position"

        return "win to keep playoff hopes alive"

    def _get_future_fav_opponents(self) -> set[str]:
        if self._future_fav_opponents is not None:
            return self._future_fav_opponents

        fav_iri = f"urn:nfl:team:{self.fav_abbr}"
        q = f"""
        PREFIX nfl: <urn:nfl:>
        SELECT ?opponent WHERE {{
            GRAPH ?g {{
                ?game a nfl:Game ;
                      nfl:status "pre" ;
                      nfl:homeTeam ?home ;
                      nfl:awayTeam ?away .
                FILTER(?home = <{fav_iri}> || ?away = <{fav_iri}>)
                BIND(IF(?home = <{fav_iri}>, ?away, ?home) AS ?opponent)
            }}
        }}
        """
        opponents: set[str] = set()
        try:
            for row in self.dataset.query(q):
                opponents.add(self._abbr_from_iri(str(row.opponent)))
        except Exception:
            pass
        self._future_fav_opponents = opponents
        return opponents

    def _fetch_relevant_games(self) -> list[dict[str, Any]]:
        """Pull upcoming/live games from the dataset via SPARQL, including odds."""
        week_filter = (
            f"FILTER(?week = {self.current_week})"
            if self.current_week is not None else ""
        )
        q = f"""
        PREFIX nfl:  <urn:nfl:>
        SELECT ?game ?home ?away ?status
               ?spread ?homeMoneyLine ?awayMoneyLine ?homeFavorite
        WHERE {{
            GRAPH ?g {{
                ?game a nfl:Game ;
                      nfl:homeTeam ?home ;
                      nfl:awayTeam ?away ;
                      nfl:status   ?status ;
                      nfl:week     ?week .
                FILTER(?status IN ("pre", "in"))
                {week_filter}
                OPTIONAL {{ ?game nfl:spread        ?spread }}
                OPTIONAL {{ ?game nfl:homeMoneyLine ?homeMoneyLine }}
                OPTIONAL {{ ?game nfl:awayMoneyLine ?awayMoneyLine }}
                OPTIONAL {{ ?game nfl:homeFavorite  ?homeFavorite }}
            }}
        }}
        """
        rows = []
        for row in self.dataset.query(q):
            rows.append({
                "game_iri"      : str(row.game),
                "home_abbr"     : self._abbr_from_iri(str(row.home)),
                "away_abbr"     : self._abbr_from_iri(str(row.away)),
                "status"        : str(row.status),
                "is_postseason" : False,
                "spread"        : self._safe_float(row.spread),
                "home_moneyline": self._safe_int_val(row.homeMoneyLine),
                "away_moneyline": self._safe_int_val(row.awayMoneyLine),
                "home_favorite" : self._safe_bool(row.homeFavorite),
            })
        return rows

    # ── Availability checks ───────────────────────────────────────────────────

    def _division_path_alive(self) -> bool:
        """Team can still mathematically win the division."""
        max_wins  = self._wins(self.fav_abbr) + self._games_remaining()
        div_peers = [t for t in DIVISION_MAP if DIVISION_MAP[t] == self.fav_div and t != self.fav_abbr]
        return all(self._wins(t) <= max_wins for t in div_peers)

    def _conf_one_seed_possible(self) -> bool:
        """Team can still mathematically get the #1 conference seed."""
        max_wins   = self._wins(self.fav_abbr) + self._games_remaining()
        conf_peers = [t for t in CONFERENCE_MAP if CONFERENCE_MAP[t] == self.fav_conf and t != self.fav_abbr]
        return all(self._wins(t) <= max_wins for t in conf_peers)

    def _conf_leader_wins(self) -> int:
        """Win count of the current conference leader."""
        best = 0
        for t in CONFERENCE_MAP:
            if CONFERENCE_MAP[t] == self.fav_conf:
                best = max(best, self._wins(t))
        return best

    # ── Standings helpers ─────────────────────────────────────────────────────

    def _team_name(self, abbr: str) -> str:
        q = f"""
        PREFIX nfl: <urn:nfl:>
        SELECT ?name WHERE {{
            GRAPH ?g {{ <urn:nfl:team:{abbr}> nfl:name ?name }}
        }} LIMIT 1
        """
        for row in self.dataset.query(q):
            return str(row.name)
        return abbr

    def _win_pct(self, abbr: str) -> float:
        q = f"""
        PREFIX nfl: <urn:nfl:>
        SELECT ?pct WHERE {{
            GRAPH ?g {{ <urn:nfl:team:{abbr}> nfl:winPct ?pct }}
        }} LIMIT 1
        """
        for row in self.dataset.query(q):
            try:
                return float(str(row.pct))
            except (ValueError, TypeError):
                pass
        return 0.5

    def _strength_score(self, abbr: str) -> float:
        q = f"""
        PREFIX nfl: <urn:nfl:>
        SELECT ?score WHERE {{
            GRAPH ?g {{ <urn:nfl:team:{abbr}> nfl:strengthScore ?score }}
        }} LIMIT 1
        """
        for row in self.dataset.query(q):
            try:
                return float(str(row.score))
            except (ValueError, TypeError):
                pass
        return 0.5

    def _wins(self, abbr: str) -> int:
        if abbr in self._wins_cache:
            return self._wins_cache[abbr]
        q = f"""
        PREFIX nfl: <urn:nfl:>
        SELECT ?wins WHERE {{
            GRAPH ?g {{ <urn:nfl:team:{abbr}> nfl:wins ?wins }}
        }} LIMIT 1
        """
        result = 0
        for row in self.dataset.query(q):
            try:
                result = int(str(row.wins))
                break
            except (ValueError, TypeError):
                pass
        self._wins_cache[abbr] = result
        return result

    def _losses(self, abbr: str) -> int:
        if abbr in self._losses_cache:
            return self._losses_cache[abbr]
        q = f"""
        PREFIX nfl: <urn:nfl:>
        SELECT ?losses WHERE {{
            GRAPH ?g {{ <urn:nfl:team:{abbr}> nfl:losses ?losses }}
        }} LIMIT 1
        """
        result = 0
        for row in self.dataset.query(q):
            try:
                result = int(str(row.losses))
                break
            except (ValueError, TypeError):
                pass
        self._losses_cache[abbr] = result
        return result

    def _is_playoff_eliminated(self, abbr: str) -> bool:
        conf = CONFERENCE_MAP.get(abbr, "")
        if not conf:
            return False
        games_rem    = self._games_remaining()
        max_possible = self._wins(abbr) + games_rem
        conf_peers   = [t for t, c in CONFERENCE_MAP.items() if c == conf and t != abbr]
        teams_ahead  = sum(1 for t in conf_peers if self._wins(t) > max_possible)
        return teams_ahead >= 7

    def _has_wildcard_path(self) -> bool:
        max_wins = self._wins(self.fav_abbr) + self._games_remaining()
        blocking = sum(
            1
            for t in CONFERENCE_MAP
            if CONFERENCE_MAP.get(t) == self.fav_conf
            and DIVISION_MAP.get(t) != self.fav_div
            and self._wins(t) > max_wins
        )
        return blocking < 3

    def _games_back(self, abbr: str) -> float:
        q = f"""
        PREFIX nfl: <urn:nfl:>
        SELECT ?gb WHERE {{
            GRAPH ?g {{ <urn:nfl:team:{abbr}> nfl:gamesBack ?gb }}
        }} LIMIT 1
        """
        for row in self.dataset.query(q):
            try:
                return float(str(row.gb))
            except (ValueError, TypeError):
                pass
        return 0.0

    def _games_remaining(self) -> int:
        if self.current_week is None:
            return 9
        return max(0, 19 - self.current_week)

    def _in_division_contention(self, abbr: str) -> bool:
        return self._games_back(abbr) <= self._games_remaining()

    def _resolve_underdog(self, home: str, away: str, gd: dict) -> str | None:
        spread = gd.get("spread")
        hml    = gd.get("home_moneyline")
        aml    = gd.get("away_moneyline")
        hfav   = gd.get("home_favorite")

        if spread is not None:
            if spread < 0:
                return away
            if spread > 0:
                return home

        if hml is not None and aml is not None:
            if hml < aml:
                return away
            if aml < hml:
                return home

        if hfav is not None:
            return away if hfav else home

        h_prev = self._prev_wins.get(home)
        a_prev = self._prev_wins.get(away)
        if h_prev is not None and a_prev is not None and h_prev != a_prev:
            return away if h_prev > a_prev else home

        return None

    # ── Type-coercion helpers ─────────────────────────────────────────────────

    @staticmethod
    def _safe_float(val: Any) -> float | None:
        try:
            return float(str(val))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _safe_int_val(val: Any) -> int | None:
        try:
            return int(str(val))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _safe_bool(val: Any) -> bool | None:
        if val is None:
            return None
        s = str(val).lower()
        if s == "true":
            return True
        if s == "false":
            return False
        return None

    @staticmethod
    def _abbr_from_iri(iri: str) -> str:
        return iri.split(":")[-1]
