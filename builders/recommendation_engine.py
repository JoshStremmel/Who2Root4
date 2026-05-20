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
        divisional_bonus  : 0.40  (opponent in same division)
        conference_bonus  : 0.25  (opponent in same conference)
        record_delta      : 0.20  (how many games ahead/behind)
        dislike_bonus     : 0.15  (loathed team is involved)
        """
        home = gd["home_abbr"]
        away = gd["away_abbr"]

        # Skip games involving the favorite team itself
        if home == self.fav_abbr or away == self.fav_abbr:
            return None

        home_div  = DIVISION_MAP.get(home, "")
        away_div  = DIVISION_MAP.get(away, "")
        home_conf = CONFERENCE_MAP.get(home, "")
        away_conf = CONFERENCE_MAP.get(away, "")

        # Only care about same-conference games
        if home_conf != self.fav_conf and away_conf != self.fav_conf:
            return None

        home_score_val = self._score_for(home, away, home_div, home_conf)
        away_score_val = self._score_for(away, home, away_div, away_conf)

        # Root for the team whose WIN helps the fav most
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
            DIVISION_MAP.get(root_abbr, ""), CONFERENCE_MAP.get(root_abbr, ""),
            total_score,
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
        candidate: str,   # team whose win we're evaluating
        opponent:  str,
        candidate_div: str,
        candidate_conf: str,
    ) -> float:
        """Return a raw impact score for rooting for `candidate` winning."""
        score = 0.0

        # Opponent is in our division → their loss helps us most
        opp_div  = DIVISION_MAP.get(opponent, "")
        opp_conf = CONFERENCE_MAP.get(opponent, "")

        if opp_div == self.fav_div:
            score += 0.40   # opponent losing in our division = best case
        elif opp_conf == self.fav_conf:
            score += 0.20   # opponent losing in our conference still helps

        # Candidate winning tightens their division vs someone we care about
        if candidate_div == self.fav_div:
            score += 0.10   # same-division team winning pushes a rival back

        # Dislike bonus: if the opponent is a team we dislike, rooting against them is rewarding
        if opponent in self.disliked:
            score += 0.15

        # Small record-based delta (prefer games where standings are close)
        fav_rec  = self._win_pct(self.fav_abbr)
        opp_rec  = self._win_pct(opponent)
        delta    = abs(fav_rec - opp_rec)
        score   += max(0.0, 0.15 - delta * 0.3)   # close records → higher relevance

        return score

    def _build_reasoning(
        self,
        root_abbr: str,
        against_abbr: str,
        root_div: str,
        root_conf: str,
        score: float,
    ) -> str:
        parts = []
        opp_div  = DIVISION_MAP.get(against_abbr, "")
        opp_conf = CONFERENCE_MAP.get(against_abbr, "")

        if opp_div == self.fav_div:
            parts.append(f"{against_abbr} is a division rival — their loss directly helps")
        elif opp_conf == self.fav_conf:
            parts.append(f"{against_abbr} is a conference competitor — their loss improves wild card odds")
        if against_abbr in self.disliked:
            parts.append(f"you also dislike {against_abbr}")
        if not parts:
            parts.append("indirect playoff impact")
        return "; ".join(parts) + f" (score {score:.2f})"

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
                "game_iri" : str(row.game),
                "home_abbr": self._abbr_from_iri(str(row.home)),
                "away_abbr": self._abbr_from_iri(str(row.away)),
                "status"   : str(row.status),
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
