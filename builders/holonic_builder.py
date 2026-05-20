"""
holonic_builder.py
──────────────────
NFL → HolonicDataset integration layer.

Replaces the raw-rdflib NFLGraphBuilder with proper holonic first-class
citizens: holons, interior layers, boundary membranes, portals, and a
context layer for provenance.

Holon IRI conventions (aligned with urn:holon:* pattern from holonic lib)
──────────────────────────────────────────────────────────────────────────
  Team holon       : urn:nfl:holon:team:<ABBR>
  Game holon       : urn:nfl:holon:game:<SEASON>:W<WK>:<AWAY>_<HOME>
  Week holon       : urn:nfl:holon:week:<SEASON>:W<WK>
  Season holon     : urn:nfl:holon:season:<SEASON>
  Division holon   : urn:nfl:holon:division:<DIV_KEY>
  Conference holon : urn:nfl:holon:conference:<CONF>
  Scenario holon   : urn:nfl:holon:scenario:<SLUG>

Layer graph IRIs  (default holonic convention: {holon_iri}/interior etc.)
──────────────────────────────────────────────────────────────────────────
  interior   : domain facts (team record, game score, standings)
  boundary   : SHACL shapes + portal definitions
  projection : external-facing summary (recommendation data, playoff seed)
  context    : provenance, traversal history, temporal chain

Portal IRI conventions
──────────────────────
  urn:nfl:portal:team:<ABBR>:to:game:<GAME_SLUG>
  urn:nfl:portal:game:<GAME_SLUG>:impacts:team:<ABBR>
  urn:nfl:portal:scenario:<SLUG>:requires:team:<ABBR>

Usage
─────
    from holonic import HolonicDataset
    from holonic_builder import NFLHolonicBuilder

    ds = HolonicDataset(metadata_updates="off")   # off = fast batch mode
    builder = NFLHolonicBuilder(ds)
    builder.build_structure()                     # conferences, divisions
    builder.add_teams(parsed_standings)
    builder.add_games(parsed_scoreboard)
    builder.add_competition_portals()
    builder.add_impact_portals(all_games)
    builder.add_scenario_holons(scenarios)
    ds.refresh_all_metadata()                     # one pass at the end
    ds.export("holarchy.trig", format="trig")
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

from holonic import HolonicDataset

from espn_fetcher import CONFERENCE_MAP, DIVISION_MAP, DIVISION_RIVALS

logger = logging.getLogger(__name__)

# ── IRI helpers ───────────────────────────────────────────────────────────────

CGA  = "urn:holonic:ontology:"
NFL  = "urn:nfl:"

def _slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", s)

def _team_iri(abbr: str) -> str:
    return f"urn:nfl:holon:team:{abbr.upper()}"

def _game_slug(game: dict) -> str:
    s = game["season"]
    w = game["week"]
    home = game["home"]["abbr"]
    away = game["away"]["abbr"]
    return f"{s}_W{w:02d}_{away}_{home}"

def _game_iri(game: dict) -> str:
    return f"urn:nfl:holon:game:{_game_slug(game)}"

def _week_iri(season: int, week: int) -> str:
    return f"urn:nfl:holon:week:{season}:W{week:02d}"

def _season_iri(season: int) -> str:
    return f"urn:nfl:holon:season:{season}"

def _division_iri(div_key: str) -> str:
    return f"urn:nfl:holon:division:{div_key}"

def _conference_iri(conf: str) -> str:
    return f"urn:nfl:holon:conference:{conf}"

def _scenario_iri(slug: str) -> str:
    return f"urn:nfl:holon:scenario:{_slug(slug)}"

def _portal_iri(*parts: str) -> str:
    return "urn:nfl:portal:" + ":".join(_slug(p) for p in parts)

# ── TTL snippet helpers ───────────────────────────────────────────────────────

_PREFIXES = """\
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix nfl:  <urn:nfl:> .
@prefix cga:  <urn:holonic:ontology:> .
@prefix prov: <http://www.w3.org/ns/prov#> .
"""

def _ttl(body: str) -> str:
    """Prepend standard prefixes to a Turtle snippet."""
    return _PREFIXES + "\n" + body


# ── Main builder ──────────────────────────────────────────────────────────────

class NFLHolonicBuilder:
    """
    Builds a holonic NFL knowledge graph using HolonicDataset.

    Call build_structure() once, then add_teams(), add_games(),
    add_competition_portals(), add_impact_portals(), and
    add_scenario_holons() in any order.

    For best performance, construct HolonicDataset with
    metadata_updates="off" and call ds.refresh_all_metadata() once
    at the very end.
    """

    def __init__(self, ds: HolonicDataset) -> None:
        self.ds = ds
        self._seasons_seen:    set[int]  = set()
        self._weeks_seen:      set[tuple[int,int]] = set()
        self._teams_seen:      set[str]  = set()
        self._games_seen:      set[str]  = set()

    # ── 1. Structural skeleton ────────────────────────────────────────────────

    def build_structure(self) -> None:
        """
        Create the top-level structural holons:
          - 2 Conference holons  (AFC, NFC)
          - 8 Division holons    (AFCNorth … NFCWest)
        These are created once and serve as cga:memberOf parents
        for team holons.
        """
        logger.info("Building structural skeleton (conferences + divisions) …")

        conf_holons = [
            {"iri": _conference_iri("AFC"), "label": "AFC",
             "holon_type": "cga:DataHolon"},
            {"iri": _conference_iri("NFC"), "label": "NFC",
             "holon_type": "cga:DataHolon"},
        ]

        div_holons = []
        for div_key, members in DIVISION_RIVALS.items():
            conf = "AFC" if "AFC" in div_key else "NFC"
            div_holons.append({
                "iri":       _division_iri(div_key),
                "label":     div_key,
                "member_of": _conference_iri(conf),
                "holon_type": "cga:DataHolon",
            })

        self.ds.bulk_load(holons=conf_holons + div_holons)

        # Interior facts for each conference
        for conf in ("AFC", "NFC"):
            self.ds.add_interior(
                _conference_iri(conf),
                _ttl(f'<{_conference_iri(conf)}> nfl:name "{conf}" .'),
            )

        # Interior facts for each division
        for div_key, members in DIVISION_RIVALS.items():
            conf = "AFC" if "AFC" in div_key else "NFC"
            members_ttl = "\n".join(
                f'<{_division_iri(div_key)}> nfl:hasMember <{_team_iri(m)}> .'
                for m in members
            )
            self.ds.add_interior(
                _division_iri(div_key),
                _ttl(
                    f'<{_division_iri(div_key)}> nfl:name "{div_key}" ;\n'
                    f'    nfl:conference <{_conference_iri(conf)}> .\n'
                    + members_ttl
                ),
            )

        logger.info("Structural skeleton complete.")

    # ── 2. Team holons ────────────────────────────────────────────────────────

    def add_teams(self, standings: list[dict]) -> None:
        """
        Create one holon per team (cga:DataHolon), populate interior
        with standings facts, and write a projection summary.
        """
        logger.info("Adding %d team holons …", len(standings))

        holon_specs = []
        for sd in standings:
            abbr = sd["abbr"]
            div  = sd.get("division", DIVISION_MAP.get(abbr, ""))
            holon_specs.append({
                "iri":       _team_iri(abbr),
                "label":     sd["name"],
                "member_of": _division_iri(div) if div else None,
                "holon_type": "cga:DataHolon",
            })

        self.ds.bulk_load(holons=holon_specs)

        for sd in standings:
            abbr = sd["abbr"]
            if abbr in self._teams_seen:
                continue
            self._teams_seen.add(abbr)
            self._write_team_interior(sd)
            self._write_team_projection(sd)

        logger.info("Team holons complete.")

    def add_teams_from_scoreboard(self, parsed: dict) -> None:
        """
        Add team holons from scoreboard data when standings aren't available.
        Creates minimal interior (name, abbr, conference, division only).
        """
        seen: set[str] = set()
        holon_specs = []
        for game in parsed.get("games", []):
            for side in ("home", "away"):
                td   = game[side]
                abbr = td["abbr"]
                if abbr in seen or not abbr:
                    continue
                seen.add(abbr)
                div = DIVISION_MAP.get(abbr, "")
                holon_specs.append({
                    "iri":       _team_iri(abbr),
                    "label":     td["name"],
                    "member_of": _division_iri(div) if div else None,
                    "holon_type": "cga:DataHolon",
                })

        self.ds.bulk_load(holons=holon_specs)

        for game in parsed.get("games", []):
            for side in ("home", "away"):
                td   = game[side]
                abbr = td["abbr"]
                if abbr in self._teams_seen or not abbr:
                    continue
                self._teams_seen.add(abbr)
                self.ds.add_interior(
                    _team_iri(abbr),
                    _ttl(
                        f'<{_team_iri(abbr)}>\n'
                        f'    nfl:name         "{td["name"]}" ;\n'
                        f'    nfl:abbreviation "{abbr}" ;\n'
                        f'    nfl:conference   <{_conference_iri(CONFERENCE_MAP.get(abbr,""))}> ;\n'
                        f'    nfl:division     <{_division_iri(DIVISION_MAP.get(abbr,""))}> .\n'
                    ),
                )

    # ── 3. Season / Week / Game holons ───────────────────────────────────────

    def add_season(self, season: int) -> None:
        """Create a season holon if not already present."""
        if season in self._seasons_seen:
            return
        self._seasons_seen.add(season)
        self.ds.add_holon(_season_iri(season), f"NFL Season {season}",
                          holon_type="cga:DataHolon")
        self.ds.add_interior(
            _season_iri(season),
            _ttl(f'<{_season_iri(season)}> nfl:year "{season}"^^xsd:integer .'),
        )

    def add_week(self, season: int, week: int, season_type: str = "Regular Season") -> None:
        """Create a week holon inside a season holon."""
        key = (season, week)
        if key in self._weeks_seen:
            return
        self._weeks_seen.add(key)
        self.add_season(season)
        self.ds.add_holon(
            _week_iri(season, week),
            f"Season {season} Week {week}",
            member_of=_season_iri(season),
            holon_type="cga:DataHolon",
        )
        self.ds.add_interior(
            _week_iri(season, week),
            _ttl(
                f'<{_week_iri(season, week)}>\n'
                f'    nfl:weekNumber "{week}"^^xsd:integer ;\n'
                f'    nfl:season     <{_season_iri(season)}> ;\n'
                f'    nfl:seasonType "{season_type}" .\n'
            ),
        )

    def add_games(self, parsed: dict) -> None:
        """
        Create game holons for every event in a parsed scoreboard.
        Each game is a cga:DataHolon, member of its week holon.
        Completed games also get a context layer with outcome provenance.
        """
        season = parsed["season"]
        week   = parsed["week"]
        self.add_week(season, week, parsed.get("season_type", "Regular Season"))

        game_specs = []
        for game in parsed.get("games", []):
            g_iri = _game_iri(game)
            if g_iri in self._games_seen:
                continue
            game_specs.append({
                "iri":       g_iri,
                "label":     game["name"],
                "member_of": _week_iri(season, week),
                "holon_type": "cga:DataHolon",
            })

        self.ds.bulk_load(holons=game_specs)

        for game in parsed.get("games", []):
            g_iri = _game_iri(game)
            if g_iri in self._games_seen:
                continue
            self._games_seen.add(g_iri)
            self._write_game_interior(game)
            if game.get("status") == "post" and game.get("winner_abbr"):
                self._write_game_context(game)

        logger.info("Added games for season %d week %d", season, week)

    # ── 4. Competition portals ────────────────────────────────────────────────

    def add_competition_portals(self) -> None:
        """
        Add cga:IconPortal (no CONSTRUCT, referential) edges for:
          - divisionalRival  (team → team, same division)
          - competesWith     (team → team, same conference)
        Uses IconPortal (no construct_query) since these are structural
        references, not data transformations.
        """
        logger.info("Writing competition portals …")
        portal_specs = []

        for div_key, members in DIVISION_RIVALS.items():
            for abbr in members:
                for rival in members:
                    if rival == abbr:
                        continue
                    p_iri = _portal_iri("rival", abbr, rival)
                    portal_specs.append({
                        "iri":         p_iri,
                        "source_iri":  _team_iri(abbr),
                        "target_iri":  _team_iri(rival),
                        "portal_type": "cga:IconPortal",
                        "label":       f"{abbr} divisional rival → {rival}",
                        "extra_ttl":   f'<{p_iri}> nfl:portalRole "divisionalRival" .',
                    })

        self.ds.bulk_load(portals=portal_specs)
        logger.info("Competition portals written (%d).", len(portal_specs))

    # ── 5. Impact portals ─────────────────────────────────────────────────────

    def add_impact_portals(self, all_games: list[dict]) -> None:
        """
        For every completed game, add cga:TransformPortal edges that
        project outcome data from the game holon into each team's
        projection layer.

        The CONSTRUCT query materialises:
          - Whether the team won or lost
          - The impact score (divisional=1.0, conference=0.75, other=0.4)

        This is the 'portals as hyperedge traversals' pattern:
          game interior → (portal) → team projection
        """
        logger.info("Writing impact portals for completed games …")
        portal_specs = []

        for game in all_games:
            if game.get("status") != "post":
                continue
            winner = game.get("winner_abbr")
            loser  = game.get("loser_abbr")
            if not winner:
                continue

            g_iri = _game_iri(game)
            home_div  = DIVISION_MAP.get(game["home"]["abbr"], "")
            away_div  = DIVISION_MAP.get(game["away"]["abbr"], "")
            impact_score = (
                1.0 if home_div == away_div else
                0.75 if CONFERENCE_MAP.get(game["home"]["abbr"]) ==
                        CONFERENCE_MAP.get(game["away"]["abbr"]) else
                0.4
            )

            for team_abbr, result in [(winner, "win"), (loser, "loss")]:
                if not team_abbr:
                    continue
                p_iri = _portal_iri("impact", _game_slug(game), team_abbr)
                construct = _build_impact_construct(
                    g_iri, _team_iri(team_abbr), result, impact_score
                )
                portal_specs.append({
                    "iri":            p_iri,
                    "source_iri":     g_iri,
                    "target_iri":     _team_iri(team_abbr),
                    "construct_query": construct,
                    "portal_type":    "cga:TransformPortal",
                    "label":          f"Game impact → {team_abbr} ({result})",
                })

        self.ds.bulk_load(portals=portal_specs)
        logger.info("Impact portals written (%d).", len(portal_specs))

    # ── 6. Scenario holons ────────────────────────────────────────────────────

    def add_scenario_holons(self, scenarios: list[Any]) -> None:
        """
        Convert ScenarioBuilder Scenario objects into proper holons.
        Each scenario is a cga:DataHolon, member of its beneficiary team.
        Portals (cga:IconPortal) connect the scenario to the teams
        whose win/loss it requires.
        """
        logger.info("Adding %d scenario holons …", len(scenarios))

        holon_specs  = []
        portal_specs = []

        for sc in scenarios:
            sc_iri = _scenario_iri(sc.label)
            holon_specs.append({
                "iri":       sc_iri,
                "label":     sc.label,
                "member_of": _team_iri(sc.beneficiary),
                "holon_type": "cga:DataHolon",
            })

            # Required wins → IconPortal scenario → team
            for win_abbr in sc.required_wins:
                p_iri = _portal_iri("scenario", sc.label, "needs_win", win_abbr)
                portal_specs.append({
                    "iri":         p_iri,
                    "source_iri":  sc_iri,
                    "target_iri":  _team_iri(win_abbr),
                    "portal_type": "cga:IconPortal",
                    "label":       f"{sc.label} requires win from {win_abbr}",
                    "extra_ttl":   f'<{p_iri}> nfl:requirementType "win" .',
                })

            # Required losses → IconPortal scenario → team
            for loss_abbr in sc.required_losses:
                p_iri = _portal_iri("scenario", sc.label, "needs_loss", loss_abbr)
                portal_specs.append({
                    "iri":         p_iri,
                    "source_iri":  sc_iri,
                    "target_iri":  _team_iri(loss_abbr),
                    "portal_type": "cga:IconPortal",
                    "label":       f"{sc.label} requires loss from {loss_abbr}",
                    "extra_ttl":   f'<{p_iri}> nfl:requirementType "loss" .',
                })

        self.ds.bulk_load(holons=holon_specs, portals=portal_specs)

        # Interior facts for each scenario
        for sc in scenarios:
            sc_iri = _scenario_iri(sc.label)
            self.ds.add_interior(
                sc_iri,
                _ttl(
                    f'<{sc_iri}>\n'
                    f'    nfl:scenarioType    "{sc.scenario_type}" ;\n'
                    f'    nfl:isActive        "{str(sc.is_active).lower()}"^^xsd:boolean ;\n'
                    f'    nfl:remainingGames  "{sc.remaining_games}"^^xsd:integer ;\n'
                    f'    nfl:beneficiary     <{_team_iri(sc.beneficiary)}> .\n'
                ),
            )

        logger.info("Scenario holons complete.")

    # ── 7. Temporal chain ─────────────────────────────────────────────────────

    def write_temporal_edges(self, team_schedule: dict[str, list[str]]) -> None:
        """
        Write nfl:nextGame / nfl:previousGame into each game's context layer.
        team_schedule maps team abbr → ordered list of game IRIs (strings).
        """
        logger.info("Writing temporal context edges …")
        written = 0
        for abbr, game_iris in team_schedule.items():
            for i in range(len(game_iris) - 1):
                cur_iri  = game_iris[i]
                next_iri = game_iris[i + 1]
                # Context layer: provenance / temporal annotations
                self.ds.add_context(
                    cur_iri,
                    _ttl(
                        f'<{cur_iri}>\n'
                        f'    nfl:nextGame     <{next_iri}> ;\n'
                        f'    nfl:dependsOn    <{next_iri}> .\n'
                    ),
                )
                written += 1
        logger.info("Temporal context edges written: %d", written)

    # ── Private helpers ───────────────────────────────────────────────────────

    def _write_team_interior(self, sd: dict) -> None:
        abbr = sd["abbr"]
        self.ds.add_interior(
            _team_iri(abbr),
            _ttl(
                f'<{_team_iri(abbr)}>\n'
                f'    nfl:name             "{sd["name"]}" ;\n'
                f'    nfl:abbreviation     "{abbr}" ;\n'
                f'    nfl:wins             "{sd["wins"]}"^^xsd:integer ;\n'
                f'    nfl:losses           "{sd["losses"]}"^^xsd:integer ;\n'
                f'    nfl:ties             "{sd["ties"]}"^^xsd:integer ;\n'
                f'    nfl:winPct           "{sd["win_pct"]}"^^xsd:float ;\n'
                f'    nfl:pointsFor        "{sd["points_for"]}"^^xsd:integer ;\n'
                f'    nfl:pointsAgainst    "{sd["points_against"]}"^^xsd:integer ;\n'
                f'    nfl:conference       <{_conference_iri(sd["conference"])}>  ;\n'
                f'    nfl:division         <{_division_iri(sd["division"])}> .\n'
            ),
        )

    def _write_team_projection(self, sd: dict) -> None:
        """Projection layer: lightweight summary for recommendation engine."""
        abbr = sd["abbr"]
        wins   = sd["wins"]
        losses = sd["losses"]
        self.ds.add_projection(
            _team_iri(abbr),
            _ttl(
                f'<{_team_iri(abbr)}>\n'
                f'    nfl:record      "{wins}-{losses}" ;\n'
                f'    nfl:winPct      "{sd["win_pct"]}"^^xsd:float .\n'
            ),
        )

    def _write_game_interior(self, game: dict) -> None:
        g_iri = _game_iri(game)
        home  = game["home"]
        away  = game["away"]

        lines = [
            f'<{g_iri}>',
            f'    nfl:homeTeam    <{_team_iri(home["abbr"])}> ;',
            f'    nfl:awayTeam    <{_team_iri(away["abbr"])}> ;',
            f'    nfl:week        "{game["week"]}"^^xsd:integer ;',
            f'    nfl:season      "{game["season"]}"^^xsd:integer ;',
            f'    nfl:seasonType  "{game["season_type"]}" ;',
            f'    nfl:status      "{game["status"]}" ;',
        ]
        if game.get("venue"):
            lines.append(f'    nfl:venue       "{game["venue"]}" ;')
        if game.get("start_time"):
            lines.append(f'    nfl:startTime   "{game["start_time"]}"^^xsd:dateTime ;')
        if game.get("home_score") is not None:
            lines.append(f'    nfl:homeScore   "{game["home_score"]}"^^xsd:integer ;')
        if game.get("away_score") is not None:
            lines.append(f'    nfl:awayScore   "{game["away_score"]}"^^xsd:integer ;')
        # Close the block
        lines[-1] = lines[-1].rstrip(";") + " ."

        self.ds.add_interior(g_iri, _ttl("\n".join(lines)))

    def _write_game_context(self, game: dict) -> None:
        """Context layer: outcome provenance for completed games."""
        g_iri   = _game_iri(game)
        now     = datetime.now(timezone.utc).isoformat()
        winner  = game["winner_abbr"]
        loser   = game.get("loser_abbr", "")
        act_iri = f"{g_iri}/context/outcome_activity"

        ttl_body = (
            f'<{act_iri}> a prov:Activity ;\n'
            f'    prov:startedAtTime  "{now}"^^xsd:dateTime ;\n'
            f'    prov:generated      <{g_iri}> ;\n'
            f'    nfl:winner          <{_team_iri(winner)}> ;\n'
        )
        if loser:
            ttl_body += f'    nfl:loser           <{_team_iri(loser)}> ;\n'
        ttl_body += (
            f'    nfl:homeScore       "{game["home_score"]}"^^xsd:integer ;\n'
            f'    nfl:awayScore       "{game["away_score"]}"^^xsd:integer .\n'
        )

        self.ds.add_context(g_iri, _ttl(ttl_body))


# ── CONSTRUCT query factory ───────────────────────────────────────────────────

def _build_impact_construct(
    game_iri: str,
    team_iri: str,
    result: str,       # "win" | "loss"
    impact_score: float,
) -> str:
    """
    Build the SPARQL CONSTRUCT that projects outcome impact from a game
    holon's interior into a team holon's projection layer.

    The projection asserts:
      team nfl:hasOutcome  [game, result, score]
    """
    return f"""
PREFIX nfl:  <urn:nfl:>
PREFIX xsd:  <http://www.w3.org/2001/XMLSchema#>
PREFIX prov: <http://www.w3.org/ns/prov#>

CONSTRUCT {{
    <{team_iri}> nfl:hasGameResult <{game_iri}> .
    <{game_iri}> nfl:result        "{result}" ;
                 nfl:impactScore   "{impact_score}"^^xsd:float .
}}
WHERE {{
    GRAPH ?interior {{
        <{game_iri}> nfl:status "post" .
    }}
}}
""".strip()
