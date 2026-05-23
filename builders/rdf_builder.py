"""
rdf_builder.py
──────────────
Converts parsed ESPN NFL data into a holonic RDF dataset using rdflib.

Graph layout (named graphs)
───────────────────────────
  urn:nfl:graph:teams          – Team holons (interior facts)
  urn:nfl:graph:games:<season>:<week>  – Game holons for a specific week
  urn:nfl:graph:outcomes       – Completed game outcomes
  urn:nfl:graph:competition    – Structural & competitive edges
  urn:nfl:graph:standings      – Current standings snapshot
  urn:nfl:graph:holarchy       – Registry: which holons exist (context layer)
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rdflib import (
    RDF, XSD, Dataset, Graph, Literal, Namespace, URIRef
)
from rdflib.namespace import OWL, RDFS

from espn_fetcher import CONFERENCE_MAP, DIVISION_MAP, DIVISION_RIVALS

logger = logging.getLogger(__name__)

# ── Namespaces ────────────────────────────────────────────────────────────────

NFL     = Namespace("urn:nfl:")
TEAM    = Namespace("urn:nfl:team:")
GAME    = Namespace("urn:nfl:game:")
OUTCOME = Namespace("urn:nfl:outcome:")
PLAYOFF = Namespace("urn:nfl:playoff:")
IMPACT  = Namespace("urn:nfl:impact:")
REC     = Namespace("urn:nfl:recommendation:")
USER    = Namespace("urn:nfl:user:")
GRAPH   = Namespace("urn:nfl:graph:")

# ── Helpers ───────────────────────────────────────────────────────────────────

def _slug(s: str) -> str:
    """Turn any string into a safe IRI fragment."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", s)


def _team_iri(abbr: str) -> URIRef:
    return TEAM[abbr.upper()]


def _game_iri(game: dict) -> URIRef:
    season = game["season"]
    week   = game["week"]
    home   = game["home"]["abbr"]
    away   = game["away"]["abbr"]
    return GAME[f"{season}_W{week:02d}_{away}_{home}"]


def _outcome_iri(game: dict, winner_abbr: str) -> URIRef:
    season = game["season"]
    week   = game["week"]
    home   = game["home"]["abbr"]
    away   = game["away"]["abbr"]
    return OUTCOME[f"{season}_W{week:02d}_{away}_{home}_{winner_abbr}Win"]


def _week_graph_iri(season: int, week: int,
                    season_type_id: int = 2) -> URIRef:
    suffix = "post" if season_type_id == 3 else "reg"
    return GRAPH[f"games:{season}:{suffix}:{week:02d}"]


# ── Core Builder ──────────────────────────────────────────────────────────────

class NFLGraphBuilder:
    """
    Builds a holonic RDF Dataset from parsed ESPN data.

    Usage
    -----
    builder = NFLGraphBuilder()
    builder.load_ontologies("ontology/")   # optional but recommended
    builder.add_teams_from_scoreboard(scoreboard_parsed)
    builder.add_games(scoreboard_parsed)
    builder.add_standings(standings_parsed)
    builder.add_competition_edges()
    builder.add_impact_edges()
    ds = builder.dataset
    builder.serialize("output/holarchy.trig")
    """

    def __init__(self) -> None:
        self.dataset = Dataset()
        self._bind_namespaces(self.dataset)

        # Named graphs
        self._g_teams       = self.dataset.graph(GRAPH["teams"])
        self._g_outcomes    = self.dataset.graph(GRAPH["outcomes"])
        self._g_competition = self.dataset.graph(GRAPH["competition"])
        self._g_standings   = self.dataset.graph(GRAPH["standings"])
        self._g_holarchy    = self.dataset.graph(GRAPH["holarchy"])

        # Runtime state
        self._team_abbrs:        set[str]          = set()
        self._game_iris:         dict[str, URIRef] = {}   # espn_id → URIRef
        self._game_data:         list[dict]        = []
        self._standings:         list[dict]        = []
        self._team_graph_cache:  dict[str, Graph]  = {}   # abbr → interior graph

    # ── Public API ────────────────────────────────────────────────────────────

    def load_ontologies(self, ontology_dir: str | Path) -> None:
        """Parse all .ttl files from the ontology directory into the default graph."""
        path = Path(ontology_dir)
        default_g = self.dataset.default_context
        for ttl in sorted(path.glob("*.ttl")):
            logger.info("Loading ontology: %s", ttl)
            default_g.parse(str(ttl), format="turtle")

    def add_teams_from_scoreboard(self, parsed: dict[str, Any]) -> None:
        """
        Insert Team holons from scoreboard competitors.
        Each team gets its own interior named graph:
          urn:nfl:graph:team:<ABBR>
        plus a registration entry in the holarchy graph.
        """
        seen: set[str] = set()
        for game in parsed.get("games", []):
            for side in ("home", "away"):
                td = game[side]
                abbr = td["abbr"]
                if abbr in seen or not abbr:
                    continue
                seen.add(abbr)
                self._upsert_team(td)
        logger.info("Added/updated %d team holons", len(seen))

    def add_teams_from_standings(self, standings: list[dict]) -> None:
        """Insert or enrich team holons from the standings payload."""
        for sd in standings:
            abbr = sd["abbr"]
            t_iri = _team_iri(abbr)
            g = self._team_interior_graph(abbr)
            # Use set() so computed standings always replace any prior scoreboard values
            g.set((t_iri, NFL.wins,          Literal(sd["wins"],          datatype=XSD.integer)))
            g.set((t_iri, NFL.losses,        Literal(sd["losses"],        datatype=XSD.integer)))
            g.set((t_iri, NFL.ties,          Literal(sd["ties"],          datatype=XSD.integer)))
            g.set((t_iri, NFL.winPct,        Literal(sd["win_pct"],       datatype=XSD.float)))
            g.set((t_iri, NFL.pointsFor,     Literal(sd["points_for"],    datatype=XSD.integer)))
            g.set((t_iri, NFL.pointsAgainst, Literal(sd["points_against"], datatype=XSD.integer)))
            self._team_abbrs.add(abbr)
        logger.info("Enriched %d teams from standings", len(standings))

    def add_games(self, parsed: dict[str, Any]) -> None:
        """
        Insert Game holons into week-scoped named graphs.
        Completed games also generate Outcome holons.
        """
        season         = parsed["season"]
        week           = parsed["week"]
        season_type_id = parsed.get("season_type_id", 2)
        g_week = self.dataset.graph(_week_graph_iri(season, week, season_type_id))
        self._bind_namespaces(g_week)

        for game in parsed.get("games", []):
            self._insert_game(game, g_week)

        self._game_data.extend(parsed.get("games", []))
        logger.info("Added %d games for season %d week %d", len(parsed["games"]), season, week)

    def add_standings(self, standings: list[dict]) -> None:
        """Record the current standings snapshot in the standings graph."""
        self._standings = standings
        for sd in standings:
            abbr  = sd["abbr"]
            t_iri = _team_iri(abbr)
            self._g_standings.add((t_iri, RDF.type, NFL.Team))
            self._g_standings.set((t_iri, NFL.wins,          Literal(sd["wins"],          datatype=XSD.integer)))
            self._g_standings.set((t_iri, NFL.losses,        Literal(sd["losses"],        datatype=XSD.integer)))
            self._g_standings.set((t_iri, NFL.ties,          Literal(sd["ties"],          datatype=XSD.integer)))
            self._g_standings.set((t_iri, NFL.winPct,        Literal(sd["win_pct"],       datatype=XSD.float)))
            self._g_standings.set((t_iri, NFL.pointsFor,     Literal(sd["points_for"],    datatype=XSD.integer)))
            self._g_standings.set((t_iri, NFL.pointsAgainst, Literal(sd["points_against"], datatype=XSD.integer)))
            div_key  = sd.get("division", DIVISION_MAP.get(abbr, ""))
            conf_key = sd.get("conference", CONFERENCE_MAP.get(abbr, ""))
            if div_key:
                self._g_standings.add((t_iri, NFL.division,   NFL[div_key]))
            if conf_key:
                self._g_standings.add((t_iri, NFL.conference, NFL[conf_key]))
        logger.info("Standings graph updated for %d teams", len(standings))

    def add_competition_edges(
        self,
        tiebreaker_order: dict[str, list[str]] | None = None,
    ) -> None:
        """
        Derive structural & competitive edges:
          - divisionalRival  (all 4-team division clusters)
          - competesWith     (same conference, alive teams)
          - divisionLeader   (team with best record per division; tiebreaker
                              used when tiebreaker_order is provided)
          - gamesBack        (distance from division leader by raw record)
        """
        g = self._g_competition

        # Divisional rivals
        for div_key, members in DIVISION_RIVALS.items():
            div_iri = NFL[div_key]
            for abbr in members:
                t_iri = _team_iri(abbr)
                g.add((t_iri, NFL.division, div_iri))
                for rival_abbr in members:
                    if rival_abbr != abbr:
                        g.add((t_iri, NFL.divisionalRival, _team_iri(rival_abbr)))

        # Division leaders & games back
        if self._standings:
            by_div: dict[str, list[dict]] = {}
            for sd in self._standings:
                div = sd.get("division", DIVISION_MAP.get(sd["abbr"], ""))
                by_div.setdefault(div, []).append(sd)

            for div_key, teams in by_div.items():
                if tiebreaker_order and div_key in tiebreaker_order:
                    tb_order = tiebreaker_order[div_key]
                    sorted_teams = sorted(
                        teams,
                        key=lambda t: tb_order.index(t["abbr"])
                                      if t["abbr"] in tb_order else 999,
                    )
                else:
                    sorted_teams = sorted(
                        teams,
                        key=lambda t: (t["wins"] - t["losses"]),
                        reverse=True,
                    )
                leader = sorted_teams[0]
                leader_wins   = leader["wins"]
                leader_losses = leader["losses"]
                div_iri = NFL[div_key]
                g.add((div_iri, NFL.divisionLeader, _team_iri(leader["abbr"])))

                for team in sorted_teams:
                    games_back = ((leader_wins - team["wins"]) +
                                  (team["losses"] - leader_losses)) / 2.0
                    g.add((_team_iri(team["abbr"]), NFL.gamesBack,
                            Literal(games_back, datatype=XSD.float)))

            # competesWith — same conference, not already eliminated
            conf_teams: dict[str, list[str]] = {}
            for sd in self._standings:
                conf = sd.get("conference", CONFERENCE_MAP.get(sd["abbr"], ""))
                conf_teams.setdefault(conf, []).append(sd["abbr"])

            for conf, abbrs in conf_teams.items():
                for i, a in enumerate(abbrs):
                    for b in abbrs[i+1:]:
                        if a != b:
                            g.add((_team_iri(a), NFL.competesWith, _team_iri(b)))
                            g.add((_team_iri(b), NFL.competesWith, _team_iri(a)))

        logger.info("Competition edges written to %s", GRAPH["competition"])

    def add_impact_edges(
        self,
        strength_map: dict | None = None,
    ) -> None:
        """
        Generate impact edges on completed game outcomes:
          - outcome:XWin impact:improvesOdds  winner_team
          - outcome:XWin impact:reducesOdds   loser_team
          - game impact:affects home/away teams
        Scores are normalised [0.0 – 1.0] based on divisional/conference relevance,
        then bumped by 0.05 * avgTeamStrength so team quality breaks ties.
        """
        g = self._g_outcomes
        for game in self._game_data:
            if game["status"] != "post":
                continue
            winner_abbr = game.get("winner_abbr")
            loser_abbr  = game.get("loser_abbr")
            if not winner_abbr or not loser_abbr:
                continue   # tie

            out_iri = _outcome_iri(game, winner_abbr)

            # Base importance: divisional games matter more
            home_div = DIVISION_MAP.get(game["home"]["abbr"], "")
            away_div = DIVISION_MAP.get(game["away"]["abbr"], "")
            home_conf = CONFERENCE_MAP.get(game["home"]["abbr"], "")
            away_conf = CONFERENCE_MAP.get(game["away"]["abbr"], "")

            if home_div == away_div:
                base_score = 1.0    # divisional
            elif home_conf == away_conf:
                base_score = 0.75   # conference
            else:
                base_score = 0.5    # interconference

            # Team-strength tiebreaker: gameImportance = base + 0.05 * avgStrength, capped at 1.0
            if strength_map:
                home_str = strength_map.get(game["home"]["abbr"], {}).get("strengthScore", 0.5)
                away_str = strength_map.get(game["away"]["abbr"], {}).get("strengthScore", 0.5)
                importance = min(base_score + 0.05 * ((home_str + away_str) / 2), 1.0)
            else:
                importance = base_score

            g.add((out_iri, IMPACT.improvesOdds, _team_iri(winner_abbr)))
            g.add((out_iri, IMPACT.reducesOdds,  _team_iri(loser_abbr)))
            g.add((out_iri, IMPACT.score,
                    Literal(round(importance, 4), datatype=XSD.float)))

            # Affect edges on the game node itself
            g_game_iri = _game_iri(game)
            g.add((g_game_iri, IMPACT.affects, _team_iri(game["home"]["abbr"])))
            g.add((g_game_iri, IMPACT.affects, _team_iri(game["away"]["abbr"])))

        logger.info("Impact edges added for completed games")

    def add_team_strengths(self, strength_map: dict) -> None:
        """Write nfl:strengthScore to each team's interior graph."""
        for abbr, data in strength_map.items():
            t_iri = _team_iri(abbr)
            g = self._team_interior_graph(abbr)
            g.add((t_iri, NFL.strengthScore,
                    Literal(data["strengthScore"], datatype=XSD.float)))
        logger.info("Team strength scores written for %d teams", len(strength_map))

    def add_playoff_spot_assignments(
        self,
        tiebreaker_order: dict[str, list[str]] | None = None,
    ) -> None:
        """
        Assign nfl:currentlyHolds triples based on current standings.
        Top 4 per division → seeds 1–4. Next 3 best records per conf → wildcards.
        """
        if not self._standings:
            logger.warning("No standings loaded; skipping playoff assignment")
            return

        g = self._g_standings

        conf_division_leaders: dict[str, list[dict]] = {"AFC": [], "NFC": []}
        conf_non_leaders: dict[str, list[dict]]       = {"AFC": [], "NFC": []}

        by_div: dict[str, list[dict]] = {}
        for sd in self._standings:
            div = sd.get("division", DIVISION_MAP.get(sd["abbr"], ""))
            by_div.setdefault(div, []).append(sd)

        def _sort_div(teams: list[dict], div_key: str) -> list[dict]:
            if tiebreaker_order and div_key in tiebreaker_order:
                tb = tiebreaker_order[div_key]
                return sorted(
                    teams,
                    key=lambda t: tb.index(t["abbr"]) if t["abbr"] in tb else 999,
                )
            return sorted(teams, key=lambda t: t["win_pct"], reverse=True)

        for div_key, teams in by_div.items():
            conf = "AFC" if "AFC" in div_key else "NFC"
            sorted_t = _sort_div(teams, div_key)
            conf_division_leaders[conf].append(sorted_t[0])
            conf_non_leaders[conf].extend(sorted_t[1:])

        seed_iris = {
            "AFC": [PLAYOFF[f"AFCSeed{i}"] for i in range(1, 5)] +
                   [PLAYOFF[f"AFCWildcard{i}"] for i in range(1, 4)],
            "NFC": [PLAYOFF[f"NFCSeed{i}"] for i in range(1, 5)] +
                   [PLAYOFF[f"NFCWildcard{i}"] for i in range(1, 4)],
        }

        for conf in ("AFC", "NFC"):
            leaders  = sorted(conf_division_leaders[conf],
                              key=lambda t: t["win_pct"], reverse=True)
            wildcards = sorted(conf_non_leaders[conf],
                               key=lambda t: t["win_pct"], reverse=True)[:3]
            playoff_teams = leaders + wildcards
            for i, team in enumerate(playoff_teams):
                if i < len(seed_iris[conf]):
                    g.add((_team_iri(team["abbr"]), NFL.currentlyHolds, seed_iris[conf][i]))
                    g.add((_team_iri(team["abbr"]), NFL.competesFor,    seed_iris[conf][i]))

        logger.info("Playoff spot assignments written")

    def serialize(self, path: str | Path, fmt: str = "trig") -> None:
        """Write the full dataset to disk."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.dataset.serialize(destination=str(path), format=fmt)
        logger.info("Dataset serialised → %s", path)

    def serialize_graph(self, graph_iri: str, path: str | Path,
                        fmt: str = "turtle") -> None:
        """Serialize a single named graph."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        g = self.dataset.graph(URIRef(graph_iri))
        g.serialize(destination=str(path), format=fmt)
        logger.info("Graph %s → %s", graph_iri, path)

    # ── Private helpers ───────────────────────────────────────────────────────

    def _bind_namespaces(self, g: Graph | Dataset) -> None:
        g.bind("nfl",    NFL)
        g.bind("team",   TEAM)
        g.bind("game",   GAME)
        g.bind("outcome", OUTCOME)
        g.bind("playoff", PLAYOFF)
        g.bind("impact",  IMPACT)
        g.bind("rec",     REC)
        g.bind("user",    USER)
        g.bind("graph",   GRAPH)

    def _team_interior_graph(self, abbr: str) -> Graph:
        cached = self._team_graph_cache.get(abbr)
        if cached is not None:
            return cached
        iri = GRAPH[f"team:{abbr}"]
        g = self.dataset.graph(iri)
        self._bind_namespaces(g)
        self._team_graph_cache[abbr] = g
        return g

    def _upsert_team(self, td: dict) -> None:
        abbr  = td["abbr"]
        t_iri = _team_iri(abbr)
        g     = self._team_interior_graph(abbr)

        if abbr not in self._team_abbrs:
            # First insertion: write all static facts once
            g.add((t_iri, RDF.type,         NFL.Team))
            g.add((t_iri, NFL.name,         Literal(td["name"])))
            g.add((t_iri, NFL.abbreviation, Literal(abbr)))
            if td.get("location"):
                g.add((t_iri, NFL.location, Literal(td["location"])))
            if td.get("short_name"):
                g.add((t_iri, RDFS.label,   Literal(td["short_name"])))
            div_key  = td.get("division",   DIVISION_MAP.get(abbr, ""))
            conf_key = td.get("conference", CONFERENCE_MAP.get(abbr, ""))
            if div_key:
                g.add((t_iri, NFL.division,   NFL[div_key]))
            if conf_key:
                g.add((t_iri, NFL.conference, NFL[conf_key]))
            # Register in holarchy
            self._g_holarchy.add((t_iri, RDF.type,     NFL.Team))
            self._g_holarchy.add((t_iri, NFL.hasInteriorGraph, GRAPH[f"team:{abbr}"]))
            self._g_teams.add((t_iri, RDF.type, NFL.Team))
            self._team_abbrs.add(abbr)

        if td.get("wins") is not None:
            # Use set() so repeated calls per week don't accumulate multiple values
            g.set((t_iri, NFL.wins,   Literal(td["wins"],   datatype=XSD.integer)))
            g.set((t_iri, NFL.losses, Literal(td["losses"], datatype=XSD.integer)))
            g.set((t_iri, NFL.ties,   Literal(td["ties"],   datatype=XSD.integer)))

    def _insert_game(self, game: dict, g_week: Graph) -> None:
        g_iri  = _game_iri(game)
        self._game_iris[game["id"]] = g_iri

        g_week.add((g_iri, RDF.type,       NFL.Game))
        g_week.add((g_iri, NFL.espnId,     Literal(game["id"])))
        g_week.add((g_iri, NFL.week,       Literal(game["week"],   datatype=XSD.integer)))
        g_week.add((g_iri, NFL.season,     Literal(game["season"], datatype=XSD.integer)))
        g_week.add((g_iri, NFL.seasonType, Literal(game["season_type"])))
        g_week.add((g_iri, NFL.status,     Literal(game["status"])))
        g_week.add((g_iri, NFL.statusDetail, Literal(game["status_detail"])))
        if game.get("venue"):
            g_week.add((g_iri, NFL.venue,  Literal(game["venue"])))
        if game.get("start_time"):
            g_week.add((g_iri, NFL.startTime, Literal(game["start_time"], datatype=XSD.dateTime)))

        home_iri = _team_iri(game["home"]["abbr"])
        away_iri = _team_iri(game["away"]["abbr"])
        g_week.add((g_iri, NFL.homeTeam, home_iri))
        g_week.add((g_iri, NFL.awayTeam, away_iri))
        g_week.add((g_iri, IMPACT.affects, home_iri))
        g_week.add((g_iri, IMPACT.affects, away_iri))

        if game["home_score"] is not None:
            g_week.add((g_iri, NFL.homeScore, Literal(game["home_score"], datatype=XSD.integer)))
        if game["away_score"] is not None:
            g_week.add((g_iri, NFL.awayScore, Literal(game["away_score"], datatype=XSD.integer)))

        # Betting odds (present only for upcoming / live games)
        odds = game.get("odds")
        if odds:
            g_week.add((g_iri, NFL.spread,
                         Literal(odds["spread"], datatype=XSD.float)))
            g_week.add((g_iri, NFL.homeFavorite,
                         Literal(odds["home_is_favorite"], datatype=XSD.boolean)))
            if odds["home_moneyline"] is not None:
                g_week.add((g_iri, NFL.homeMoneyLine,
                             Literal(odds["home_moneyline"], datatype=XSD.integer)))
            if odds["away_moneyline"] is not None:
                g_week.add((g_iri, NFL.awayMoneyLine,
                             Literal(odds["away_moneyline"], datatype=XSD.integer)))
            if odds.get("details"):
                g_week.add((g_iri, NFL.oddsDetails,
                             Literal(odds["details"])))

        # Completed game → outcome holon
        if game["status"] == "post" and game.get("winner_abbr"):
            self._insert_outcome(game, g_iri, g_week)

        # Register in holarchy
        self._g_holarchy.add((g_iri, RDF.type,    NFL.Game))
        self._g_holarchy.add((g_iri, NFL.hasInteriorGraph,
                               _week_graph_iri(game["season"], game["week"],
                                               game.get("season_type_id", 2))))

    def _insert_outcome(self, game: dict, game_iri: URIRef, g_week: Graph) -> None:
        winner_abbr = game["winner_abbr"]
        loser_abbr  = game["loser_abbr"]
        out_iri     = _outcome_iri(game, winner_abbr)

        winner_iri = _team_iri(winner_abbr)
        loser_iri  = _team_iri(loser_abbr) if loser_abbr else None

        self._g_outcomes.add((out_iri, RDF.type,   NFL.Outcome))
        self._g_outcomes.add((out_iri, NFL.forGame, game_iri))
        self._g_outcomes.add((out_iri, NFL.winner,  winner_iri))
        if loser_iri:
            self._g_outcomes.add((out_iri, NFL.loser, loser_iri))
        self._g_outcomes.add((out_iri, NFL.homeScore,
                               Literal(game["home_score"], datatype=XSD.integer)))
        self._g_outcomes.add((out_iri, NFL.awayScore,
                               Literal(game["away_score"], datatype=XSD.integer)))

        g_week.add((game_iri, NFL.winner,     winner_iri))
        g_week.add((game_iri, NFL.hasOutcome, out_iri))
        if loser_iri:
            g_week.add((game_iri, NFL.loser, loser_iri))
