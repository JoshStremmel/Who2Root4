"""
recommendation_engine.py
────────────────────────
Generates rooting recommendations by reasoning over the holonic RDF graph.

The engine implements the core inference rule from the design spec:

    If outcome:X impact:improvesOdds team:FavoriteTeam
    AND user:Josh nfl:favoriteTeam team:FavoriteTeam
    THEN user:Josh nfl:shouldRootFor outcome:X

It also computes a composite impact score for each upcoming game,
ranking which game a user should care about most this week.

Usage
─────
    from recommendation_engine import RecommendationEngine
    from rdf_builder import NFLGraphBuilder

    engine = RecommendationEngine(builder.dataset, favorite_team_abbr="CIN")
    recs   = engine.generate_recommendations()
    engine.write_recommendations_to_graph(recs)
    engine.print_recommendations(recs)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from rdflib import RDF, XSD, Dataset, Literal, URIRef

from rdf_builder import (
    DIVISION_MAP, CONFERENCE_MAP, GAME, GRAPH, IMPACT, NFL, PLAYOFF, REC, TEAM, USER,
    _game_iri, _team_iri,
)

logger = logging.getLogger(__name__)

# Numeric weight per strength tier (used for stacking and sorting)
_STRENGTH_WEIGHT: dict[str, float] = {"high": 0.35, "medium": 0.20, "low": 0.10}


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
    category:        str   = ""    # primary scenario category name
    strength:        str   = ""    # "high" | "medium" | "low" | ""
    strength_weight: float = 0.0   # sum of matching scenario weights (for UI sorting)


class RecommendationEngine:
    """
    Reasons over the holonic dataset to produce ranked rooting recommendations
    for a given user's favorite team.
    """

    def __init__(
        self,
        dataset: Dataset,
        favorite_team_abbr: str,
        disliked_teams: list[str] | None = None,
        user_iri: str = "urn:nfl:user:default",
        prev_season_standings: list[dict] | None = None,
        current_week: int | None = None,
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
        self._wins_cache:   dict[str, int] = {}
        self._losses_cache: dict[str, int] = {}
        # Cached future opponents of the fav team (populated on first use)
        self._future_fav_opponents: set[str] | None = None
        # Previous-season win counts keyed by team abbreviation (underdog fallback)
        self._prev_wins: dict[str, int] = {
            sd["abbr"]: sd["wins"]
            for sd in (prev_season_standings or [])
        }

    # ── Public API ────────────────────────────────────────────────────────────

    def generate_recommendations(self) -> list[RootingRecommendation]:
        """
        Score every upcoming (status=pre) or live (status=in) game and return
        a ranked list of RootingRecommendations.

        All games are returned — games with no impact on the fav team receive
        a score of 0.0 so the user can see the full slate.
        """
        games = self._fetch_relevant_games()
        recs  = []
        for game_data in games:
            rec = self._score_game(game_data)
            if rec is not None:
                recs.append(rec)

        # Primary sort: playoff impact score. Secondary: scenario interest (strength_weight)
        # so that within 0-impact games the most strategically interesting show first.
        recs.sort(key=lambda r: (r.score, r.strength_weight), reverse=True)
        return recs

    def write_recommendations_to_graph(
        self, recs: list[RootingRecommendation]
    ) -> None:
        """Materialise recommendations as RDF triples in graph:recommendations."""
        g = self.dataset.graph(GRAPH["recommendations"])

        # User node
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

            # Scenario fields
            if rec.category:
                g.add((rec_iri, NFL.category, Literal(rec.category)))
            if rec.strength:
                g.add((rec_iri, NFL.strength, Literal(rec.strength)))
            g.add((rec_iri, NFL.strengthWeight,
                    Literal(round(rec.strength_weight, 4), datatype=XSD.float)))

            # Impact edges: rooting for root_for improvesOdds; against team harmsOdds
            g.add((rec_iri, IMPACT.improvesOdds, self.fav_iri))
            g.add((_team_iri(rec.against_abbr), IMPACT.harmsOdds, self.fav_iri))

            # User inference triples
            g.add((self.user_iri, NFL.shouldRootFor, rec_iri))

        logger.info("Wrote %d recommendations to graph:recommendations", len(recs))

    def print_recommendations(self, recs: list[RootingRecommendation]) -> None:
        """Print a human-readable ranked recommendation list."""
        fav_name = self._team_name(self.fav_abbr)
        print(f"\n{'='*65}")
        print(f"  ROOTING GUIDE for {fav_name} fans")
        print(f"{'='*65}")
        if self._is_playoff_eliminated(self.fav_abbr):
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
            print(f"\n  ── No playoff impact ({len(no_impact)} game(s)) ────────────────")
            for i, r in enumerate(no_impact, len(impactful) + 1):
                print(f"\n  #{i}  Root for: {r.root_for_name:25s}  vs  {r.against_name}")
                print(f"      Score:    0.000  [no playoff impact]")
                print(f"      Why:      {r.reasoning}")
        print()

    # ── Scoring Logic ─────────────────────────────────────────────────────────

    def _score_game(self, gd: dict) -> RootingRecommendation | None:
        """
        Score a single game and produce a RootingRecommendation.
        Returns None only for games involving the favorite team itself.

        Every other game is returned — games with no impact get score 0.0.

        Score assembly
        ──────────────
        1. Run 5 new scenario detectors; tally weights per side (home/away).
        2. If scenarios fire, dominant side wins; scenario weights stack.
        3. Add the existing playoff-bearing score when it agrees with the direction.
        4. If no scenarios fire, fall back to existing playoff logic (or 0.0).
        5. Apply team-strength tiebreaker (+0.05 * avgStrength).

        Scenario strength weights
        ─────────────────────────
          DivisionRivalTank  : 0.35  (high)
          OpponentTanking    : 0.20  (medium)
          PlayoffSoftening   : 0.20  (medium)
          UpsetRooting       : 0.20  (medium)
          DraftPositioning   : 0.10  (low)

        Existing playoff components (still active as bonus)
        ───────────────────────────────────────────────────
          divisional_bonus   : 0.20–0.40
          conference_bonus   : 0.20
          scenario_bonus     : 0.25  (active clinch/elimination scenario)
          dislike_bonus      : 0.15
          record_delta       : 0.10
          postseason_bonus   : 0.10
        """
        home = gd["home_abbr"]
        away = gd["away_abbr"]

        # Only skip games involving the fav team itself
        if home == self.fav_abbr or away == self.fav_abbr:
            return None

        is_postseason = gd.get("is_postseason", False)

        # ── Playoff impact score ───────────────────────────────────────────────
        # Only same-conference or postseason games can move the fav's playoff odds.
        # Cross-conference games are always 0 playoff impact (score stays 0).
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

        # Zero out playoff score when either team is already eliminated (regular season)
        if not is_postseason and playoff_score > 0 and (
            self._is_playoff_eliminated(playoff_root)
            or self._is_playoff_eliminated(playoff_against)
        ):
            playoff_score = 0.0

        # ── New scenario detectors ─────────────────────────────────────────────
        fav_future_opps = self._get_future_fav_opponents()
        all_scenario_recs: list[dict] = (
            self._scenario_division_rival_tank(home, away)
            + self._scenario_opponent_tanking(home, away, fav_future_opps)
            + self._scenario_playoff_softening(home, away)
            + self._scenario_upset_rooting(home, away)
            + self._scenario_draft_positioning(home, away)
            + self._scenario_dislikes(home, away)
        )

        home_weight = sum(s["strength_weight"] for s in all_scenario_recs if s["root_for"] == home)
        away_weight = sum(s["strength_weight"] for s in all_scenario_recs if s["root_for"] == away)

        if home_weight > 0 or away_weight > 0:
            # Scenarios have a preferred direction
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

            # Impact score = playoff odds only; scenarios guide direction but don't inflate it
            total_score = playoff_score if root_abbr == playoff_root else 0.0

            # Show only top 1–2 reasons, sorted by weight
            sorted_scenarios = sorted(matching, key=lambda s: s["strength_weight"], reverse=True)
            why_parts = [sorted_scenarios[0]["why"]]
            if (len(sorted_scenarios) > 1
                    and sorted_scenarios[1]["strength_weight"] >= 0.20
                    and sorted_scenarios[1]["category"] != sorted_scenarios[0]["category"]):
                why_parts.append(sorted_scenarios[1]["why"])

            # Add playoff context when it exists and isn't implied by a high scenario
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
            # No new scenarios — fall back to existing playoff logic
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

        # Team-strength tiebreaker only applied when the game has real playoff impact,
        # so games with 0 playoff impact stay at exactly 0.0.
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

    def _score_for(
        self,
        candidate:   str,
        opponent:    str,
        candidate_div: str,
        candidate_conf: str,
        scenario_wins:   set[str],
        scenario_losses: set[str],
        is_postseason:   bool,
        has_wc_path:     bool = True,
    ) -> float:
        """Return a raw playoff-impact score for rooting for `candidate` winning."""
        score = 0.0

        opp_div  = DIVISION_MAP.get(opponent, "")
        opp_conf = CONFERENCE_MAP.get(opponent, "")

        # Divisional / conference impact
        if opp_div == self.fav_div:
            fav_contending = self._in_division_contention(self.fav_abbr)
            opp_contending = self._in_division_contention(opponent)
            if fav_contending and opp_contending:
                games_rem  = self._games_remaining()
                fav_gb     = self._games_back(self.fav_abbr)
                title_urgency = max(0.0, 1.0 - fav_gb / max(games_rem, 1))
                score += 0.20 + 0.20 * title_urgency  # 0.20–0.40
            elif has_wc_path:
                score += 0.20
        elif opp_conf == self.fav_conf and has_wc_path:
            score += 0.20

        # Scenario-aware bonus
        if candidate in scenario_wins:
            score += 0.25
        if opponent in scenario_losses:
            score += 0.25

        # Dislike bonus
        if opponent in self.disliked:
            score += 0.15

        # Record closeness
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
        parts = []
        opp_div  = DIVISION_MAP.get(against_abbr, "")
        opp_conf = CONFERENCE_MAP.get(against_abbr, "")

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
                    gb_str = f"tied in the division"
                parts.append(
                    f"{against_abbr} is a division rival in a title race "
                    f"({gb_str}, {games_rem} weeks left) — their loss directly helps"
                )
            elif has_wc_path:
                reason = (
                    "division title out of reach for your team"
                    if not self._in_division_contention(self.fav_abbr)
                    else f"{against_abbr} eliminated from division title race"
                )
                parts.append(
                    f"{against_abbr} is a division rival ({reason}) — their loss improves wild card odds"
                )
        elif opp_conf == self.fav_conf and has_wc_path:
            parts.append(f"{against_abbr} is a conference competitor — their loss improves wild card odds")

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
    #
    # Each detector returns a list of dicts:
    #   root_for        : str   — abbreviation of the team to root for
    #   against         : str   — abbreviation of the team to root against
    #   category        : str   — scenario type name
    #   strength        : str   — "high" | "medium" | "low"
    #   strength_weight : float — numeric weight (from _STRENGTH_WEIGHT)
    #   why             : str   — human-readable explanation
    #
    # Multiple detectors can fire for the same game (they stack).

    def _scenario_division_rival_tank(
        self, home: str, away: str
    ) -> list[dict]:
        """Root against any division rival regardless of standings context. Strength: high."""
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
        """
        Root against upcoming fav-team opponents:
          - winning record → cool momentum before the matchup
          - losing record  → keep the locker room fractured heading into your game
        Strength: medium.
        """
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

    def _scenario_playoff_softening(
        self, home: str, away: str
    ) -> list[dict]:
        """
        Root against same-conference teams with winning records projecting into
        playoff seeding — dent momentum and expose scheme. Strength: medium.
        """
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

    def _scenario_upset_rooting(
        self, home: str, away: str
    ) -> list[dict]:
        """
        Root for the underdog when a conference rival is a heavy home favorite
        (4+ win advantage). A team that comfortable at home is a trap-game risk.
        Strength: medium.
        """
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

    def _scenario_draft_positioning(
        self, home: str, away: str
    ) -> list[dict]:
        """
        Root against division rivals or conference threats with 6–9 wins —
        competitive enough to look relevant but not good enough to contend.
        Pushing them lower improves their draft pick without helping a real contender.
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
                    "category":       "DraftPositioning",
                    "strength":        "low",
                    "strength_weight": _STRENGTH_WEIGHT["low"],
                    "why": (
                        f"{team} ({w}W) is a {label} stuck in no man's land — "
                        f"threatening week-to-week but not good enough to contend; "
                        f"keep them losing"
                    ),
                })
        return results

    def _scenario_dislikes(
        self, home: str, away: str
    ) -> list[dict]:
        """
        Root against any team the user dislikes.
        Fires for every game involving a disliked team regardless of conference.
        Strength: medium — won't override high-strength scenarios (DivisionRivalTank)
        when they conflict, but will set direction for 0-impact games and stack
        with agreeing scenarios.
        """
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
        """
        Query the graph for teams whose WIN is required by an active
        scenario benefiting the favorite team.
        """
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
                iri = str(row.team)
                abbrs.add(iri.split(":")[-1])
        except Exception:
            pass
        return abbrs

    def _active_scenario_losses(self) -> set[str]:
        """
        Query the graph for teams whose LOSS is required by an active
        scenario benefiting the favorite team.
        """
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
                iri = str(row.team)
                abbrs.add(iri.split(":")[-1])
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
        """One-line description of what winning the fav's own game would accomplish."""
        games_rem    = self._games_remaining()
        fav_gb       = self._games_back(self.fav_abbr)
        is_div_rival = DIVISION_MAP.get(opponent) == self.fav_div

        if self._is_playoff_eliminated(self.fav_abbr):
            return "out of playoff contention — playing for pride and draft position"

        if self._in_division_contention(self.fav_abbr):
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

        if self._has_wildcard_path():
            return f"win to strengthen your {self.fav_conf} wildcard position"

        return "win to keep playoff hopes alive"

    def _get_future_fav_opponents(self) -> set[str]:
        """
        Return the set of team abbreviations the fav team still has to face
        (status=pre games in the dataset). Result is cached after first call.
        """
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
                FILTER(
                    ?home = <{fav_iri}> || ?away = <{fav_iri}>
                )
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
        """
        True if the team can no longer mathematically reach a top-7 seed in their conference.
        A team is eliminated when 7 or more conference peers already have more wins than
        the team's maximum possible win total (current wins + games remaining).
        """
        conf = CONFERENCE_MAP.get(abbr, "")
        if not conf:
            return False
        games_rem    = self._games_remaining()
        max_possible = self._wins(abbr) + games_rem
        conf_peers   = [t for t, c in CONFERENCE_MAP.items() if c == conf and t != abbr]
        teams_ahead  = sum(1 for t in conf_peers if self._wins(t) > max_possible)
        return teams_ahead >= 7

    def _has_wildcard_path(self) -> bool:
        """
        False if 3 or more non-division conference teams already have more wins than
        the fav team's maximum possible win total, meaning all three wildcard spots
        are locked by teams the fav cannot catch.
        """
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
        """Return the team's games-back from its division leader (0.0 = leader)."""
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
        """Estimate regular-season games remaining based on current week."""
        if self.current_week is None:
            return 9
        return max(0, 19 - self.current_week)

    def _in_division_contention(self, abbr: str) -> bool:
        """True if the team can still mathematically win their division."""
        return self._games_back(abbr) <= self._games_remaining()

    def _resolve_underdog(self, home: str, away: str, gd: dict) -> str | None:
        """
        Return the abbreviation of the underdog team for this game, or None.

        Resolution order:
          1. Point spread from ESPN odds   (negative = home favored)
          2. Money-line comparison         (more negative = bigger favorite)
          3. homeFavorite boolean from RDF
          4. Previous season win counts    (more wins last year → stronger team)
        """
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

    # ── Type-coercion helpers (SPARQL results are rdflib Literals) ────────────

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
