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
    ) -> None:
        self.dataset          = dataset
        self.fav_abbr         = favorite_team_abbr.upper()
        self.fav_iri          = _team_iri(self.fav_abbr)
        self.disliked         = [d.upper() for d in (disliked_teams or [])]
        self.user_iri_str     = user_iri
        self.user_iri         = URIRef(user_iri)
        self.fav_div          = DIVISION_MAP.get(self.fav_abbr, "")
        self.fav_conf         = CONFERENCE_MAP.get(self.fav_abbr, "")

    # ── Public API ────────────────────────────────────────────────────────────

    def generate_recommendations(self) -> list[RootingRecommendation]:
        """
        Score every upcoming (status=pre) or live (status=in) game
        and return a ranked list of RootingRecommendations.
        """
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
        if not recs:
            print("  No actionable recommendations this week.")
            return
        for i, r in enumerate(recs, 1):
            bar = "█" * int(r.score * 20)
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
        divisional_bonus   : 0.40  (opponent in same division as fav)
        conference_bonus   : 0.20  (opponent in same conference)
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

        home_score_val = self._score_for(
            home, away,
            DIVISION_MAP.get(home, ""), home_conf,
            active_scenario_wins, active_scenario_losses,
            is_postseason,
        )
        away_score_val = self._score_for(
            away, home,
            DIVISION_MAP.get(away, ""), away_conf,
            active_scenario_wins, active_scenario_losses,
            is_postseason,
        )

        if home_score_val >= away_score_val:
            root_abbr    = home
            against_abbr = away
            total_score  = home_score_val
        else:
            root_abbr    = away
            against_abbr = home
            total_score  = away_score_val

        reasoning = self._build_reasoning(
            root_abbr, against_abbr,
            DIVISION_MAP.get(root_abbr, ""),
            CONFERENCE_MAP.get(root_abbr, ""),
            total_score,
            active_scenario_wins, active_scenario_losses,
            is_postseason,
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
    ) -> float:
        """Return a raw impact score for rooting for `candidate` winning."""
        score = 0.0

        opp_div  = DIVISION_MAP.get(opponent, "")
        opp_conf = CONFERENCE_MAP.get(opponent, "")

        # Divisional / conference impact
        if opp_div == self.fav_div:
            score += 0.40
        elif opp_conf == self.fav_conf:
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
    ) -> str:
        parts = []
        opp_div  = DIVISION_MAP.get(against_abbr, "")
        opp_conf = CONFERENCE_MAP.get(against_abbr, "")

        if is_postseason:
            parts.append("postseason game — every result reshapes the bracket")
        elif opp_div == self.fav_div:
            parts.append(f"{against_abbr} is a division rival — their loss directly helps")
        elif opp_conf == self.fav_conf:
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
        """Pull upcoming/live games from the dataset via SPARQL."""
        q = """
        PREFIX nfl:  <urn:nfl:>
        SELECT ?game ?home ?away ?status
        WHERE {
            GRAPH ?g {
                ?game a nfl:Game ;
                      nfl:homeTeam ?home ;
                      nfl:awayTeam ?away ;
                      nfl:status   ?status .
                FILTER(?status IN ("pre", "in"))
            }
        }
        """
        rows = []
        for row in self.dataset.query(q):
            rows.append({
                "game_iri"     : str(row.game),
                "home_abbr"    : self._abbr_from_iri(str(row.home)),
                "away_abbr"    : self._abbr_from_iri(str(row.away)),
                "status"       : str(row.status),
                "is_postseason": "holon:game" in str(row.game) and False,
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

    @staticmethod
    def _abbr_from_iri(iri: str) -> str:
        return iri.split(":")[-1]
