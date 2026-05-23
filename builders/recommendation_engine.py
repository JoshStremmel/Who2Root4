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


@dataclass
class RootingRecommendation:
    game_iri:       str
    root_for_abbr:  str
    root_for_name:  str
    against_abbr:   str
    against_name:   str
    score:          float
    reasoning:      str
    home_abbr:      str
    away_abbr:      str


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
        self._wins_cache: dict[str, int] = {}
        # Previous-season win counts keyed by team abbreviation (underdog fallback)
        self._prev_wins: dict[str, int] = {
            sd["abbr"]: sd["wins"]
            for sd in (prev_season_standings or [])
        }

    # ── Public API ────────────────────────────────────────────────────────────

    def generate_recommendations(self) -> list[RootingRecommendation]:
        """
        Score every upcoming (status=pre) or live (status=in) game
        and return a ranked list of RootingRecommendations.
        Returns an empty list if the favorite team is eliminated from playoff contention.
        """
        if self._is_playoff_eliminated(self.fav_abbr):
            return []

        games = self._fetch_relevant_games()
        recs  = []
        for game_data in games:
            rec = self._score_game(game_data)
            if rec is not None:
                recs.append(rec)

        recs.sort(key=lambda r: r.score, reverse=True)
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
            print(f"  No suggestions — {fav_name} have been eliminated from playoff contention.")
            return
        if not recs:
            print("  No actionable recommendations this week.")
            return
        for i, r in enumerate(recs, 1):
            bar = "#" * int(r.score * 20)
            print(f"\n  #{i}  Root for: {r.root_for_name:25s}  vs  {r.against_name}")
            print(f"      Score:    {r.score:.3f}  [{bar:<20}]")
            print(f"      Why:      {r.reasoning}")
        print()

    # ── Scoring Logic ─────────────────────────────────────────────────────────

    def _score_game(self, gd: dict) -> RootingRecommendation | None:
        """
        For a game not involving the favorite team, decide:
          - Which side to root for (the one that helps the fav most)
          - Compute a composite impact score

        Score components
        ────────────────
        divisional_bonus   : 0.20–0.40  (opponent in same division; full 0.40 only when
                                         both fav and rival are still in title contention,
                                         scaled by fav's closeness to the division lead;
                                         falls back to 0.20 if title is out of reach AND
                                         the team still has a wildcard path)
        conference_bonus   : 0.20  (opponent in same conference, only when fav has a
                                    realistic wildcard path)
        scenario_bonus     : 0.25  (game satisfies an active scenario requirement)
        dislike_bonus      : 0.15  (loathed team is involved)
        record_delta       : 0.10  (how close standings are)
        postseason_bonus   : 0.10  (extra weight for playoff games)
        """
        home = gd["home_abbr"]
        away = gd["away_abbr"]

        # Skip games involving the favorite team itself
        if home == self.fav_abbr or away == self.fav_abbr:
            return None

        home_conf = CONFERENCE_MAP.get(home, "")
        away_conf = CONFERENCE_MAP.get(away, "")

        # Only care about same-conference games (or postseason)
        is_postseason = gd.get("is_postseason", False)
        if not is_postseason:
            if home_conf != self.fav_conf and away_conf != self.fav_conf:
                return None

        # Active scenario requirements for the fav team
        active_scenario_wins   = self._active_scenario_wins()
        active_scenario_losses = self._active_scenario_losses()
        has_wc_path            = self._has_wildcard_path()

        # Skip games with no direct playoff bearing for the fav team.
        # record_delta and team_strength are tiebreakers, not reasons to care.
        if not self._has_direct_playoff_impact(
            home, away,
            active_scenario_wins, active_scenario_losses,
            has_wc_path, is_postseason,
        ):
            return None

        home_score_val = self._score_for(
            home, away,
            DIVISION_MAP.get(home, ""), home_conf,
            active_scenario_wins, active_scenario_losses,
            is_postseason, has_wc_path,
        )
        away_score_val = self._score_for(
            away, home,
            DIVISION_MAP.get(away, ""), away_conf,
            active_scenario_wins, active_scenario_losses,
            is_postseason, has_wc_path,
        )

        # Underdog tiebreaker: when odds (or prev-season record) reveal a clear underdog,
        # add a tiny bonus to that side so the engine prefers rooting for them when
        # the base scores are equal or near-equal.
        underdog = self._resolve_underdog(home, away, gd)
        _ud_bonus = 0.02
        adj_home = home_score_val + (_ud_bonus if home == underdog else 0.0)
        adj_away = away_score_val + (_ud_bonus if away == underdog else 0.0)

        if adj_home >= adj_away:
            root_abbr    = home
            against_abbr = away
            total_score  = home_score_val
        else:
            root_abbr    = away
            against_abbr = home
            total_score  = away_score_val

        # Skip if either team is eliminated — their result no longer affects the playoff picture
        if not is_postseason and (
            self._is_playoff_eliminated(root_abbr)
            or self._is_playoff_eliminated(against_abbr)
        ):
            return None

        # Team-strength tiebreaker: gameImportance = base + 0.05 * avgTeamStrength
        avg_strength = (self._strength_score(home) + self._strength_score(away)) / 2
        total_score += 0.05 * avg_strength

        reasoning = self._build_reasoning(
            root_abbr, against_abbr,
            DIVISION_MAP.get(root_abbr, ""),
            CONFERENCE_MAP.get(root_abbr, ""),
            total_score,
            active_scenario_wins, active_scenario_losses,
            is_postseason, has_wc_path,
        )

        return RootingRecommendation(
            game_iri      = gd["game_iri"],
            root_for_abbr = root_abbr,
            root_for_name = self._team_name(root_abbr),
            against_abbr  = against_abbr,
            against_name  = self._team_name(against_abbr),
            score         = min(total_score, 1.0),
            reasoning     = reasoning,
            home_abbr     = home,
            away_abbr     = away,
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
        """Return a raw impact score for rooting for `candidate` winning."""
        score = 0.0

        opp_div  = DIVISION_MAP.get(opponent, "")
        opp_conf = CONFERENCE_MAP.get(opponent, "")

        # Divisional / conference impact
        if opp_div == self.fav_div:
            fav_contending = self._in_division_contention(self.fav_abbr)
            opp_contending = self._in_division_contention(opponent)
            if fav_contending and opp_contending:
                # Title race still alive for both sides — scale by how close fav is to the lead
                games_rem  = self._games_remaining()
                fav_gb     = self._games_back(self.fav_abbr)
                title_urgency = max(0.0, 1.0 - fav_gb / max(games_rem, 1))
                score += 0.20 + 0.20 * title_urgency  # 0.20–0.40
            elif has_wc_path:
                # Division title out of reach for fav or rival, but wildcard still alive —
                # opponent's loss still has wildcard implications
                score += 0.20
            # else: no wildcard path either — this division game has no playoff bearing
        elif opp_conf == self.fav_conf and has_wc_path:
            # Conference rival bonus only when team can realistically reach a wildcard
            score += 0.20

        # Scenario-aware bonus: candidate winning satisfies a required win
        if candidate in scenario_wins:
            score += 0.25

        # Scenario-aware bonus: opponent losing satisfies a required loss
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

        # Postseason games always matter more
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
                games_rem = self._games_remaining()
                parts.append(
                    f"{against_abbr} is a division rival still in the title race "
                    f"({fav_gb:.1f} GB, {games_rem} weeks left) — their loss directly helps"
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
            parts.append("indirect playoff impact")

        return "; ".join(parts) + f" (score {score:.2f})"

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
        are locked by teams the fav cannot catch.  A team that can only reach the
        playoffs as a division winner returns False here.
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

    def _has_direct_playoff_impact(
        self,
        home: str,
        away: str,
        scenario_wins: set[str],
        scenario_losses: set[str],
        has_wc_path: bool,
        is_postseason: bool,
    ) -> bool:
        """
        Return True if this game has a direct playoff bearing for the fav team.
        Rejects games whose only contribution would be the minor record_delta /
        team_strength components, which are tiebreakers, not reasons to care.
        """
        if is_postseason:
            return True
        if home in scenario_wins or away in scenario_wins:
            return True
        if home in scenario_losses or away in scenario_losses:
            return True
        if home in self.disliked or away in self.disliked:
            return True

        home_div = DIVISION_MAP.get(home, "")
        away_div = DIVISION_MAP.get(away, "")

        # Division title race: both fav and the rival in this game must still be in contention
        fav_contending = self._in_division_contention(self.fav_abbr)
        if home_div == self.fav_div and fav_contending and self._in_division_contention(home):
            return True
        if away_div == self.fav_div and fav_contending and self._in_division_contention(away):
            return True

        if has_wc_path:
            # Division game: opponent's loss affects standings even outside title race
            if home_div == self.fav_div or away_div == self.fav_div:
                return True
            # Conference game: wildcard odds
            home_conf = CONFERENCE_MAP.get(home, "")
            away_conf = CONFERENCE_MAP.get(away, "")
            if home_conf == self.fav_conf or away_conf == self.fav_conf:
                return True

        return False

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
        """Estimate regular-season games remaining based on current week.
        current_week is the first unplayed (or in-progress) week, so weeks
        current_week through 18 inclusive are all still live."""
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

        # 1. Spread — most direct signal; skip pick-em (spread == 0)
        if spread is not None:
            if spread < 0:
                return away   # home favored → away is underdog
            if spread > 0:
                return home   # away favored → home is underdog

        # 2. Money-line comparison — more negative = bigger favorite
        if hml is not None and aml is not None:
            if hml < aml:
                return away
            if aml < hml:
                return home

        # 3. ESPN homeFavorite flag
        if hfav is not None:
            return away if hfav else home

        # 4. Previous-season record fallback
        h_prev = self._prev_wins.get(home)
        a_prev = self._prev_wins.get(away)
        if h_prev is not None and a_prev is not None and h_prev != a_prev:
            return away if h_prev > a_prev else home

        return None  # genuinely indeterminate — no bonus applied

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
