"""
tiebreaker.py
─────────────
Full NFL playoff seeding tiebreaker logic per official NFL tie-breaking procedures.
All records are derived from game-by-game ESPN API data — no pre-aggregated fields.

CLI usage:
    python tiebreaker.py --conference AFC --division North
    python tiebreaker.py --wildcard AFC
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent / "builders"))
sys.path.insert(0, str(Path(__file__).parent / "queries"))

from rdflib import RDF, XSD, Dataset, Literal, URIRef

from builders.espn_fetcher import (
    CONFERENCE_MAP, DIVISION_MAP, DIVISION_RIVALS,
    fetch_scoreboard, fetch_standings, parse_scoreboard, parse_standings,
)
from builders.rdf_builder import NFL, TEAM, GRAPH, _team_iri

logger = logging.getLogger(__name__)

WILDCARD_SPOTS         = 3
DIVISION_SEEDS         = 4
PLAYOFF_SPOTS_PER_CONF = 7   # 4 div winners + 3 WCs


# ── Data model ────────────────────────────────────────────────────────────────

@dataclass
class Team:
    id: str            # abbreviation e.g. "CIN"
    name: str
    division: str      # e.g. "AFCNorth"
    conference: str    # "AFC" or "NFC"
    wins: int
    losses: int
    ties: int
    points_for: int = 0
    points_against: int = 0

    @classmethod
    def from_standings_dict(cls, d: dict) -> "Team":
        abbr = d["abbr"]
        return cls(
            id=abbr,
            name=d.get("name", abbr),
            division=d.get("division", DIVISION_MAP.get(abbr, "")),
            conference=d.get("conference", CONFERENCE_MAP.get(abbr, "")),
            wins=int(d.get("wins", 0)),
            losses=int(d.get("losses", 0)),
            ties=int(d.get("ties", 0)),
            points_for=int(d.get("points_for", 0)),
            points_against=int(d.get("points_against", 0)),
        )

    @property
    def win_pct(self) -> float:
        g = self.wins + self.losses + self.ties
        return (self.wins + 0.5 * self.ties) / g if g else 0.0


@dataclass
class Game:
    id: str
    week: int
    season: int
    home_team_id: str
    away_team_id: str
    home_score: int
    away_score: int
    home_touchdowns: int | None = None
    away_touchdowns: int | None = None
    status: str = "post"        # "post" = completed
    is_postseason: bool = False

    @classmethod
    def from_dict(cls, d: dict) -> "Game":
        return cls(
            id=d.get("id", ""),
            week=d.get("week", 0),
            season=d.get("season", 0),
            home_team_id=d["home"]["abbr"],
            away_team_id=d["away"]["abbr"],
            home_score=d.get("home_score") or 0,
            away_score=d.get("away_score") or 0,
            home_touchdowns=d.get("home_touchdowns"),
            away_touchdowns=d.get("away_touchdowns"),
            status=d.get("status", "post"),
            is_postseason=d.get("is_postseason", False),
        )


# ── Low-level game helpers ────────────────────────────────────────────────────

def _completed(games: list[Game]) -> list[Game]:
    return [g for g in games if g.status == "post"]


def _team_games(team_id: str, games: list[Game]) -> list[Game]:
    return [g for g in _completed(games)
            if g.home_team_id == team_id or g.away_team_id == team_id]


def _opponent_of(game: Game, team_id: str) -> str:
    return game.away_team_id if game.home_team_id == team_id else game.home_team_id


def _game_result(game: Game, team_id: str) -> tuple[float, float, float]:
    """(wins, losses, ties) for team_id in one completed game."""
    ts = game.home_score if game.home_team_id == team_id else game.away_score
    os = game.away_score if game.home_team_id == team_id else game.home_score
    if ts > os: return 1.0, 0.0, 0.0
    if ts < os: return 0.0, 1.0, 0.0
    return 0.0, 0.0, 1.0


def _win_pct(wins: float, losses: float, ties: float) -> float:
    g = wins + losses + ties
    return (wins + 0.5 * ties) / g if g else 0.0


def _record_in_games(team_id: str, games: list[Game]) -> tuple[float, float, float]:
    w = l = t = 0.0
    for g in _completed(games):
        if g.home_team_id == team_id or g.away_team_id == team_id:
            r = _game_result(g, team_id)
            w += r[0]; l += r[1]; t += r[2]
    return w, l, t


def _net_points(team_id: str, games: list[Game]) -> int:
    scored = allowed = 0
    for g in _completed(games):
        if g.home_team_id == team_id:
            scored += g.home_score; allowed += g.away_score
        elif g.away_team_id == team_id:
            scored += g.away_score; allowed += g.home_score
    return scored - allowed


def _net_tds(team_id: str, games: list[Game]) -> int | None:
    """Returns None if any completed game lacks TD data."""
    scored = allowed = 0
    for g in _completed(games):
        if g.home_team_id == team_id:
            if g.home_touchdowns is None or g.away_touchdowns is None:
                return None
            scored += g.home_touchdowns; allowed += g.away_touchdowns
        elif g.away_team_id == team_id:
            if g.home_touchdowns is None or g.away_touchdowns is None:
                return None
            scored += g.away_touchdowns; allowed += g.home_touchdowns
    return scored - allowed


def _dense_rank(values: dict[str, float | int],
                higher_is_better: bool) -> dict[str, int]:
    """Dense ranking: tied values share a rank, next rank has no gap (1,2,2,3…)."""
    unique_sorted = sorted(set(values.values()), reverse=higher_is_better)
    val_to_rank = {v: i + 1 for i, v in enumerate(unique_sorted)}
    return {tid: val_to_rank[v] for tid, v in values.items()}


# ── Public record-computation functions ───────────────────────────────────────

def compute_head_to_head(teams: list[Team],
                          games: list[Game]) -> dict[str, float]:
    """Win % for each team in games only between the given teams."""
    ids = {t.id for t in teams}
    h2h = [g for g in _completed(games)
           if g.home_team_id in ids and g.away_team_id in ids]
    return {t.id: _win_pct(*_record_in_games(t.id, h2h)) for t in teams}


def compute_common_games(teams: list[Team],
                          games: list[Game],
                          min_common: int = 0) -> dict[str, float]:
    """
    Win % in games against opponents ALL tied teams have faced.
    Returns empty dict if common-opponent count is below min_common.
    """
    ids = {t.id for t in teams}
    per_team = []
    for t in teams:
        opps = {_opponent_of(g, t.id) for g in _team_games(t.id, games)} - ids
        per_team.append(opps)

    if not per_team:
        return {}
    common_opps = set.intersection(*per_team)
    if len(common_opps) < min_common:
        return {}

    result = {}
    for t in teams:
        relevant = [g for g in _completed(games)
                    if (g.home_team_id == t.id or g.away_team_id == t.id)
                    and _opponent_of(g, t.id) in common_opps]
        result[t.id] = _win_pct(*_record_in_games(t.id, relevant))
    return result


def _common_opponents(teams: list[Team], games: list[Game]) -> set[str]:
    ids = {t.id for t in teams}
    per_team = []
    for t in teams:
        opps = {_opponent_of(g, t.id) for g in _team_games(t.id, games)} - ids
        per_team.append(opps)
    return set.intersection(*per_team) if per_team else set()


def compute_strength_of_victory(team: Team,
                                  games: list[Game],
                                  all_teams: list[Team]) -> float:
    """Combined win % of all teams this team defeated."""
    team_map = {t.id: t for t in all_teams}
    beaten: set[str] = set()
    for g in _completed(games):
        if g.home_team_id == team.id and g.home_score > g.away_score:
            beaten.add(g.away_team_id)
        elif g.away_team_id == team.id and g.away_score > g.home_score:
            beaten.add(g.home_team_id)
    if not beaten:
        return 0.0
    opponents = [team_map[tid] for tid in beaten if tid in team_map]
    total_w = sum(t.wins + 0.5 * t.ties for t in opponents)
    total_g = sum(t.wins + t.losses + t.ties for t in opponents)
    return total_w / total_g if total_g else 0.0


def compute_strength_of_schedule(team: Team,
                                   games: list[Game],
                                   all_teams: list[Team]) -> float:
    """Combined win % of all opponents this team has faced."""
    team_map = {t.id: t for t in all_teams}
    opp_ids: set[str] = set()
    for g in _completed(games):
        if g.home_team_id == team.id:
            opp_ids.add(g.away_team_id)
        elif g.away_team_id == team.id:
            opp_ids.add(g.home_team_id)
    if not opp_ids:
        return 0.0
    opponents = [team_map[tid] for tid in opp_ids if tid in team_map]
    total_w = sum(t.wins + 0.5 * t.ties for t in opponents)
    total_g = sum(t.wins + t.losses + t.ties for t in opponents)
    return total_w / total_g if total_g else 0.0


def compute_combined_ranking(teams: list[Team],
                               reference_teams: list[Team],
                               games: list[Game]) -> dict[str, int]:
    """
    Combined rank sum (scored rank + allowed rank) among reference_teams.
    Uses dense ranking; lower sum = better seeding.
    """
    ref_scored: dict[str, int] = {}
    ref_allowed: dict[str, int] = {}
    for t in reference_teams:
        scored = allowed = 0
        for g in _completed(games):
            if g.home_team_id == t.id:
                scored += g.home_score; allowed += g.away_score
            elif g.away_team_id == t.id:
                scored += g.away_score; allowed += g.home_score
        ref_scored[t.id]  = scored
        ref_allowed[t.id] = allowed

    scored_rank  = _dense_rank(ref_scored,  higher_is_better=True)
    allowed_rank = _dense_rank(ref_allowed, higher_is_better=False)

    return {
        t.id: scored_rank.get(t.id, 0) + allowed_rank.get(t.id, 0)
        for t in teams
    }


# ── Division and conference record helpers ────────────────────────────────────

def _division_record(team: Team,
                      all_teams: list[Team],
                      games: list[Game]) -> float:
    """Win % vs all division opponents (not just tied teams)."""
    div_ids = {t.id for t in all_teams
               if t.division == team.division and t.id != team.id}
    div_games = [g for g in _completed(games)
                 if (g.home_team_id == team.id or g.away_team_id == team.id)
                 and _opponent_of(g, team.id) in div_ids]
    return _win_pct(*_record_in_games(team.id, div_games))


def _conference_record(team: Team, games: list[Game]) -> float:
    """Win % vs all conference opponents."""
    conf = team.conference
    conf_games = [g for g in _completed(games)
                  if (g.home_team_id == team.id or g.away_team_id == team.id)
                  and CONFERENCE_MAP.get(_opponent_of(g, team.id)) == conf]
    return _win_pct(*_record_in_games(team.id, conf_games))


def _net_points_conference(team: Team, games: list[Game]) -> int:
    conf = team.conference
    conf_games = [g for g in _completed(games)
                  if (g.home_team_id == team.id or g.away_team_id == team.id)
                  and CONFERENCE_MAP.get(_opponent_of(g, team.id)) == conf]
    return _net_points(team.id, conf_games)


# ── Head-to-head sweep detection ─────────────────────────────────────────────

def _h2h_sweep(teams: list[Team],
                games: list[Game]) -> tuple[Team | None, Team | None]:
    """
    Detect a sweep winner (beat all others) or sweep loser (lost to all others).
    Returns (winner, loser) — either or both may be None.
    Only applicable for wild card 3+ procedure Step 2.
    """
    ids = {t.id for t in teams}
    h2h = [g for g in _completed(games)
           if g.home_team_id in ids and g.away_team_id in ids]

    sweep_winner = sweep_loser = None
    for candidate in teams:
        others = {t.id for t in teams if t.id != candidate.id}
        beaten: set[str] = set()
        lost_to: set[str] = set()
        for g in h2h:
            opp = _opponent_of(g, candidate.id)
            if opp not in ids:
                continue
            r = _game_result(g, candidate.id)
            if r[0] == 1.0:
                beaten.add(opp)
            elif r[1] == 1.0:
                lost_to.add(opp)
        if beaten >= others:
            sweep_winner = candidate
        if lost_to >= others:
            sweep_loser = candidate

    return sweep_winner, sweep_loser


# ── Core recursive tiebreaker ─────────────────────────────────────────────────

def _apply_step(
    teams: list[Team],
    step_name: str,
    scores: dict[str, Any],     # pre-computed; None value = skip this step
    higher_better: bool,
    all_games: list[Game],
    all_teams: list[Team],
    mode: str,
) -> list[Team] | None:
    """
    Try to differentiate `teams` using pre-computed scores.
    Returns an ordered list on success, None if step was skipped or tied.
    Groups that remain tied after this step restart from step 1 recursively.
    """
    if any(scores.get(t.id) is None for t in teams):
        return None                           # step not applicable

    unique = {scores[t.id] for t in teams}
    if len(unique) <= 1:
        return None                           # no differentiation

    by_score: dict[Any, list[Team]] = defaultdict(list)
    for t in teams:
        by_score[scores[t.id]].append(t)

    sorted_keys = sorted(by_score.keys(), reverse=higher_better)
    result: list[Team] = []
    for key in sorted_keys:
        group = by_score[key]
        if len(group) == 1:
            result.extend(group)
        else:
            result.extend(_sort_group(group, all_games, all_teams, mode))
    return result


def _sort_group(
    teams: list[Team],
    all_games: list[Game],
    all_teams: list[Team],
    mode: str,
) -> list[Team]:
    """
    Recursively sort a tied group using the appropriate tiebreaker procedure.
    mode: 'division' | 'wildcard'
    Each recursive call starts from step 1 of the relevant procedure.
    """
    if len(teams) <= 1:
        return list(teams)

    conf_teams = [t for t in all_teams if t.conference == teams[0].conference]

    # ── Wild card 3+: sweep check before scoring steps ─────────────────────────
    if mode == "wildcard" and len(teams) >= 3:
        sw, sl = _h2h_sweep(teams, all_games)
        if sw:
            rest = [t for t in teams if t.id != sw.id]
            logger.info("Wild card H2H sweep winner: %s", sw.id)
            return [sw] + _sort_group(rest, all_games, all_teams, mode)
        if sl:
            rest = [t for t in teams if t.id != sl.id]
            logger.info("Wild card H2H sweep loser (eliminated): %s", sl.id)
            return _sort_group(rest, all_games, all_teams, mode) + [sl]

    # ── Build step list ────────────────────────────────────────────────────────

    steps: list[tuple[str, dict[str, Any], bool]] = []

    # Step 1: head-to-head
    if mode == "division":
        # Division: always apply H2H among the tied group
        h2h_pcts = compute_head_to_head(teams, all_games)
        steps.append(("Head-to-head", h2h_pcts, True))
    else:
        # Wild card: H2H only if the two teams have actually played each other
        if len(teams) == 2:
            ids = {t.id for t in teams}
            played = any(
                g.home_team_id in ids and g.away_team_id in ids
                for g in _completed(all_games)
            )
            if played:
                h2h_pcts = compute_head_to_head(teams, all_games)
                steps.append(("Head-to-head", h2h_pcts, True))
        # For wildcard 3+, sweep was handled above; H2H not listed as a plain step

    # Division record (division mode only) — Step 2
    if mode == "division":
        div_rec = {t.id: _division_record(t, all_teams, all_games) for t in teams}
        steps.append(("Division record", div_rec, True))

    # Common games — Step 3 (division) / Step 3 (wildcard, after conf record below)
    # Division 2-club: min 4 common opponents required
    # Division 3+ clubs: no minimum
    # Wildcard: min 4 (added after conference record, below)
    common_opps = _common_opponents(teams, all_games)
    if mode == "division":
        min_common = 4 if len(teams) == 2 else 0
        if len(common_opps) >= min_common:
            common_pcts = compute_common_games(teams, all_games, min_common)
            if common_pcts:
                steps.append(("Common games", common_pcts, True))

    # Conference record — Step 4 (division) / Step 2 (wildcard)
    conf_rec = {t.id: _conference_record(t, all_games) for t in teams}
    steps.append(("Conference record", conf_rec, True))

    # Common games — Step 3 for wildcard (min 4, after conference record)
    if mode == "wildcard":
        if len(common_opps) >= 4:
            common_pcts = compute_common_games(teams, all_games, 4)
            if common_pcts:
                steps.append(("Common games", common_pcts, True))

    # Strength of Victory / Schedule
    sov = {t.id: compute_strength_of_victory(t, all_games, all_teams) for t in teams}
    sos = {t.id: compute_strength_of_schedule(t, all_games, all_teams) for t in teams}
    steps.append(("Strength of Victory",  sov, True))
    steps.append(("Strength of Schedule", sos, True))

    # Combined ranking — conference
    conf_rank = compute_combined_ranking(teams, conf_teams, all_games)
    steps.append(("Conference ranking", conf_rank, False))  # lower = better

    # Combined ranking — all teams
    all_rank = compute_combined_ranking(teams, all_teams, all_games)
    steps.append(("League ranking", all_rank, False))

    # Net points: common games (division) or conference games (wild card)
    if mode == "division" and len(common_opps) > 0:
        net_common = {t.id: _net_points(t.id, [
            g for g in _completed(all_games)
            if (g.home_team_id == t.id or g.away_team_id == t.id)
            and _opponent_of(g, t.id) in common_opps
        ]) for t in teams}
        steps.append(("Net points (common games)", net_common, True))
    else:
        net_conf = {t.id: _net_points_conference(t, all_games) for t in teams}
        steps.append(("Net points (conference)", net_conf, True))

    # Net points all games
    net_all = {t.id: _net_points(t.id, all_games) for t in teams}
    steps.append(("Net points (all games)", net_all, True))

    # Net touchdowns
    net_td = {t.id: _net_tds(t.id, all_games) for t in teams}
    steps.append(("Net touchdowns", net_td, True))

    # Apply steps in order
    for step_name, score_dict, higher_better in steps:
        result = _apply_step(
            teams, step_name, score_dict, higher_better,
            all_games, all_teams, mode,
        )
        if result is not None:
            logger.info(
                "Tiebreaker [%s] resolved %s via '%s'",
                mode, [t.id for t in teams], step_name,
            )
            return result

    # Coin toss: all steps exhausted without resolution
    logger.warning(
        "Tiebreaker [%s] unresolvable for %s — coin toss required",
        mode, [t.id for t in teams],
    )
    return list(teams)


# ── Public API ────────────────────────────────────────────────────────────────

def resolve_division_tie(teams: list[Team],
                          all_games: list[Game],
                          all_teams: list[Team] | None = None) -> list[Team]:
    """
    Sort tied same-division teams by official NFL division tiebreaker rules.
    Returns teams ordered best (rank 1) to worst.
    """
    if all_teams is None:
        all_teams = teams
    return _sort_group(teams, all_games, all_teams, mode="division")


def resolve_wildcard_tie(teams: list[Team],
                          all_games: list[Game],
                          all_teams: list[Team]) -> list[Team]:
    """
    Sort tied wild card candidates by official NFL wild card tiebreaker rules.
    If teams span multiple divisions, the division tiebreaker is applied first
    to reduce each division to its single highest-ranked representative.
    """
    # Group by division; apply division tiebreaker within any multi-team divisions
    by_div: dict[str, list[Team]] = defaultdict(list)
    for t in teams:
        by_div[t.division].append(t)

    # Each division's ordered sub-list (index 0 = division's representative)
    division_ordered: dict[str, list[Team]] = {}
    reps: list[Team] = []

    for div, div_teams in by_div.items():
        if len(div_teams) > 1:
            ordered = resolve_division_tie(div_teams, all_games, all_teams)
            division_ordered[div] = ordered
        else:
            division_ordered[div] = div_teams
        reps.append(division_ordered[div][0])

    # Apply wild card tiebreaker among representatives
    ordered_reps = _sort_group(reps, all_games, all_teams, mode="wildcard")

    # Build final list: each rep's division subgroup follows their rep's position
    result: list[Team] = []
    for rep in ordered_reps:
        result.extend(division_ordered[rep.division])

    return result


# ── RDF integration ───────────────────────────────────────────────────────────

def emit_tiebreaker_triples(
    ranked_teams: list[Team],
    tiebreak_reasons: dict[str, str],
    dataset: Dataset,
    seed_type: str = "division",    # "division" | "wildcard"
    conference: str = "",
) -> None:
    """
    Write tiebreaker result triples into graph:tiebreakers.

    Emits:
        team:A nfl:tiebreakOver team:B .
        team:A nfl:tiebreakReason "Division record" .
        team:A nfl:divisionSeed "1"^^xsd:int .         (if seed_type == "division")
        team:A nfl:wildcardSeed "1"^^xsd:int .         (if seed_type == "wildcard")
    """
    g = dataset.graph(GRAPH["tiebreakers"])

    for rank, team in enumerate(ranked_teams, start=1):
        t_iri = _team_iri(team.id)
        reason = tiebreak_reasons.get(team.id, "Coin toss")

        # Seed triple
        seed_pred = NFL.divisionSeed if seed_type == "division" else NFL.wildcardSeed
        g.add((t_iri, seed_pred, Literal(rank, datatype=XSD.integer)))

        # Tiebreak reason
        if reason:
            g.add((t_iri, NFL.tiebreakReason, Literal(reason)))

        # tiebreakOver edges (this team beats all lower-ranked teams)
        for lower in ranked_teams[rank:]:
            g.add((t_iri, NFL.tiebreakOver, _team_iri(lower.id)))

    logger.info(
        "Wrote tiebreaker triples for %d teams (%s)",
        len(ranked_teams), seed_type,
    )


# ── Reason extraction helper ──────────────────────────────────────────────────

def resolve_with_reasons(
    teams: list[Team],
    all_games: list[Game],
    all_teams: list[Team],
    mode: str = "division",
) -> tuple[list[Team], dict[str, str]]:
    """
    Resolve a tie and return both the ordered list and a reason dict.
    The reason for each team is the step that first differentiated them
    from the team directly below them.

    Returns:
        (ordered_teams, {team_id: step_name_that_secured_their_rank})
    """
    if mode == "wildcard":
        ordered = resolve_wildcard_tie(teams, all_games, all_teams)
    else:
        ordered = resolve_division_tie(teams, all_games, all_teams)

    # Determine reason per team by re-running each adjacent pair
    reasons: dict[str, str] = {}
    for i, team in enumerate(ordered[:-1]):
        pair = [ordered[i], ordered[i + 1]]
        if mode == "wildcard" and DIVISION_MAP.get(pair[0].id) != DIVISION_MAP.get(pair[1].id):
            pair_mode = "wildcard"
        else:
            pair_mode = "division"

        reasons[team.id] = _find_differentiating_step(pair, all_games, all_teams, pair_mode)

    if ordered:
        reasons.setdefault(ordered[-1].id, "N/A (last seed)")
    return ordered, reasons


def _find_differentiating_step(
    pair: list[Team],
    all_games: list[Game],
    all_teams: list[Team],
    mode: str,
) -> str:
    """Return the name of the first step that differentiates exactly this pair."""
    conf_teams = [t for t in all_teams if t.conference == pair[0].conference]

    checks: list[tuple[str, dict[str, Any], bool]] = []

    if mode == "division":
        # Official NFL order: H2H → div record → common games (min 4) → conf record
        checks.append(("Head-to-head", compute_head_to_head(pair, all_games), True))
        div_rec = {t.id: _division_record(t, all_teams, all_games) for t in pair}
        checks.append(("Division record", div_rec, True))
        common_pcts = compute_common_games(pair, all_games, min_common=4)
        if common_pcts:
            checks.append(("Common games", common_pcts, True))
        conf_rec = {t.id: _conference_record(t, all_games) for t in pair}
        checks.append(("Conference record", conf_rec, True))
    else:
        # Wild card: H2H (if played) → conf record → common games (min 4)
        ids = {t.id for t in pair}
        played = any(
            g.home_team_id in ids and g.away_team_id in ids
            for g in _completed(all_games)
        )
        if played:
            checks.append(("Head-to-head", compute_head_to_head(pair, all_games), True))
        conf_rec = {t.id: _conference_record(t, all_games) for t in pair}
        checks.append(("Conference record", conf_rec, True))
        common_pcts = compute_common_games(pair, all_games, min_common=4)
        if common_pcts:
            checks.append(("Common games (min 4)", common_pcts, True))

    sov = {t.id: compute_strength_of_victory(t, all_games, all_teams) for t in pair}
    sos = {t.id: compute_strength_of_schedule(t, all_games, all_teams) for t in pair}
    conf_rank = compute_combined_ranking(pair, conf_teams, all_games)
    all_rank  = compute_combined_ranking(pair, all_teams, all_games)
    net_all   = {t.id: _net_points(t.id, all_games) for t in pair}
    net_td    = {t.id: _net_tds(t.id, all_games) for t in pair}

    checks += [
        ("Strength of Victory",  sov, True),
        ("Strength of Schedule", sos, True),
        ("Conference ranking",   conf_rank, False),
        ("League ranking",       all_rank, False),
        ("Net points (all games)", net_all, True),
        ("Net touchdowns",         net_td, True),
    ]

    for step_name, scores, higher_better in checks:
        if any(scores.get(t.id) is None for t in pair):
            continue
        vals = [scores[t.id] for t in pair]
        if vals[0] != vals[1]:
            return step_name

    return "Coin toss"


# ── CLI ───────────────────────────────────────────────────────────────────────

def _fetch_season_data(season: int,
                        cache_dir: Path) -> tuple[list[Team], list[Game]]:
    """Fetch/cache all regular-season games and standings for a season."""
    from builders.espn_fetcher import SEASON_TYPE_REGULAR, REGULAR_SEASON_WEEKS

    cache_dir.mkdir(parents=True, exist_ok=True)
    all_game_dicts: list[dict] = []

    for week in range(1, REGULAR_SEASON_WEEKS + 1):
        cache_path = cache_dir / f"scoreboard_{season}_reg_w{week:02d}.json"
        if cache_path.exists():
            raw = json.loads(cache_path.read_text())
        else:
            try:
                raw = fetch_scoreboard(week=week, season=season,
                                       season_type=SEASON_TYPE_REGULAR)
                cache_path.write_text(json.dumps(raw, indent=2))
            except Exception as exc:
                logger.warning("Week %d fetch failed: %s", week, exc)
                continue

        parsed = parse_scoreboard(raw)
        games = [g for g in parsed.get("games", []) if g.get("status") == "post"]
        all_game_dicts.extend(games)
        if not parsed.get("games"):
            logger.info("Week %d: no games yet, stopping.", week)
            break

    # Standings
    standings_path = cache_dir / f"standings_{season}.json"
    if standings_path.exists():
        raw_standings = json.loads(standings_path.read_text())
    else:
        raw_standings = fetch_standings()
        standings_path.write_text(json.dumps(raw_standings, indent=2))

    parsed_standings = parse_standings(raw_standings)

    teams    = [Team.from_standings_dict(d) for d in parsed_standings]
    games    = [Game.from_dict(d) for d in all_game_dicts]
    return teams, games


def _print_tiebreaker_result(
    label: str,
    ordered: list[Team],
    reasons: dict[str, str],
) -> None:
    print(f"\n{'='*60}")
    print(f"  Tiebreaker: {label}")
    print(f"{'='*60}")
    for rank, team in enumerate(ordered, 1):
        reason = reasons.get(team.id, "")
        suffix = f"  ← {reason}" if reason and reason != "N/A (last seed)" else ""
        print(f"  #{rank}  {team.id:4s}  {team.name[:28]:28s}  "
              f"({team.wins}-{team.losses}-{team.ties}){suffix}")
    print()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-8s  %(message)s",
        datefmt="%H:%M:%S",
    )

    p = argparse.ArgumentParser(description="NFL Playoff Tiebreaker Resolver")
    p.add_argument("--conference", choices=["AFC", "NFC"],
                   help="Conference to evaluate (requires --division or --wildcard)")
    p.add_argument("--division",
                   help="Division suffix: North, South, East, West")
    p.add_argument("--wildcard", choices=["AFC", "NFC"],
                   help="Resolve wild card tie for this conference")
    p.add_argument("--season", type=int,
                   help="Season year (default: auto-detected)")
    p.add_argument("--cache-dir", default=".cache/espn",
                   help="ESPN JSON cache directory")
    p.add_argument("--min-record-tie-pct", type=float, default=0.001,
                   help="Teams within this win-pct delta are treated as tied")
    args = p.parse_args()

    from datetime import date
    season = args.season or (date.today().year
                             if date.today().month >= 7
                             else date.today().year - 1)

    cache_dir = Path(args.cache_dir)
    logger.info("Loading season %d data …", season)
    all_teams, all_games = _fetch_season_data(season, cache_dir)
    logger.info("Loaded %d teams, %d completed games", len(all_teams),
                sum(1 for g in all_games if g.status == "post"))

    delta = args.min_record_tie_pct

    if args.division and args.conference:
        div_key = f"{args.conference}{args.division}"
        div_teams = [t for t in all_teams if t.division == div_key]
        if not div_teams:
            print(f"No teams found for division: {div_key}")
            return

        # Group by win pct; report tie groups
        by_pct: dict[float, list[Team]] = defaultdict(list)
        for t in div_teams:
            by_pct[round(t.win_pct, 4)].append(t)

        any_tie = False
        for pct, group in sorted(by_pct.items(), reverse=True):
            if len(group) > 1:
                any_tie = True
                ordered, reasons = resolve_with_reasons(
                    group, all_games, all_teams, mode="division"
                )
                _print_tiebreaker_result(
                    f"{div_key} tie at {pct:.3f}", ordered, reasons
                )

        if not any_tie:
            print(f"No ties found in {div_key}.")

    elif args.wildcard:
        conf = args.wildcard
        conf_teams = [t for t in all_teams if t.conference == conf]

        # Identify division winners (best record per division)
        div_winners: set[str] = set()
        by_div: dict[str, list[Team]] = defaultdict(list)
        for t in conf_teams:
            by_div[t.division].append(t)
        for div, teams in by_div.items():
            winner = sorted(teams, key=lambda t: t.win_pct, reverse=True)[0]
            div_winners.add(winner.id)

        # Wild card candidates = non-division-winners, same conference
        wc_candidates = [t for t in conf_teams if t.id not in div_winners]

        if len(wc_candidates) <= WILDCARD_SPOTS:
            print(f"Only {len(wc_candidates)} wild card candidates — no tie to resolve.")
            return

        # Find the cutoff win% (the Nth best among WC candidates)
        sorted_wc = sorted(wc_candidates, key=lambda t: t.win_pct, reverse=True)
        cutoff_pct = sorted_wc[WILDCARD_SPOTS - 1].win_pct

        # Teams tied at or near the cutoff bubble
        bubble = [t for t in wc_candidates
                  if abs(t.win_pct - cutoff_pct) <= delta]

        if len(bubble) <= 1:
            print(f"No wild card tie at the bubble in {conf}.")
            return

        ordered, reasons = resolve_with_reasons(
            bubble, all_games, all_teams, mode="wildcard"
        )
        _print_tiebreaker_result(
            f"{conf} Wild Card bubble tie at {cutoff_pct:.3f}", ordered, reasons
        )

    else:
        p.print_help()


if __name__ == "__main__":
    main()
