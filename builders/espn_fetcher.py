"""
espn_fetcher.py
───────────────
Fetch raw NFL data from the ESPN public scoreboard API.

Endpoints used
──────────────
Scoreboard (current week):
  https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard

Scoreboard (specific week):
  https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard
  ?seasontype=<TYPE>&week=<WEEK>&dates=<SEASON_YEAR>

Season types
────────────
  1 = Preseason   (weeks 1–4)
  2 = Regular Season (weeks 1–18)
  3 = Postseason  (weeks 1–5: Wild Card, Divisional, Conference, Pro Bowl, Super Bowl)

Standings:
  https://site.api.espn.com/apis/site/v2/sports/football/nfl/standings

Team detail:
  https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/<TEAM_ID>
"""

from __future__ import annotations

import time
import logging
from typing import Any

import requests

logger = logging.getLogger(__name__)

BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"

# ESPN season type codes
SEASON_TYPE_PRESEASON   = 1
SEASON_TYPE_REGULAR     = 2
SEASON_TYPE_POSTSEASON  = 3

# Postseason week labels (ESPN week numbers within seasontype=3)
POSTSEASON_WEEKS = {
    1: "Wild Card",
    2: "Divisional",
    3: "Conference Championship",
    4: "Pro Bowl",
    5: "Super Bowl",
}

# Total weeks per season type
REGULAR_SEASON_WEEKS   = 18
POSTSEASON_WEEKS_COUNT = 5

# Divisional mapping for all 32 teams (ESPN abbreviation → division key)
DIVISION_MAP: dict[str, str] = {
    # AFC North
    "BAL": "AFCNorth", "CIN": "AFCNorth", "CLE": "AFCNorth", "PIT": "AFCNorth",
    # AFC South
    "HOU": "AFCSouth", "IND": "AFCSouth", "JAX": "AFCSouth", "TEN": "AFCSouth",
    # AFC East
    "BUF": "AFCEast",  "MIA": "AFCEast",  "NE":  "AFCEast",  "NYJ": "AFCEast",
    # AFC West
    "DEN": "AFCWest",  "KC":  "AFCWest",  "LV":  "AFCWest",  "LAC": "AFCWest",
    # NFC North
    "CHI": "NFCNorth", "DET": "NFCNorth", "GB":  "NFCNorth", "MIN": "NFCNorth",
    # NFC South
    "ATL": "NFCSouth", "CAR": "NFCSouth", "NO":  "NFCSouth",  "TB":  "NFCSouth",
    # NFC East
    "DAL": "NFCEast",  "NYG": "NFCEast",  "PHI": "NFCEast",  "WAS": "NFCEast",
    # NFC West
    "ARI": "NFCWest",  "LAR": "NFCWest",  "SF":  "NFCWest",  "SEA": "NFCWest",
}

CONFERENCE_MAP: dict[str, str] = {
    **{k: "AFC" for k in ["BAL","CIN","CLE","PIT","HOU","IND","JAX","TEN",
                           "BUF","MIA","NE","NYJ","DEN","KC","LV","LAC"]},
    **{k: "NFC" for k in ["CHI","DET","GB","MIN","ATL","CAR","NO","TB",
                           "DAL","NYG","PHI","WAS","ARI","LAR","SF","SEA"]},
}

# Known divisional rivals (auto-populated from division map at runtime too)
DIVISION_RIVALS: dict[str, list[str]] = {
    "AFCNorth": ["BAL","CIN","CLE","PIT"],
    "AFCSouth": ["HOU","IND","JAX","TEN"],
    "AFCEast":  ["BUF","MIA","NE","NYJ"],
    "AFCWest":  ["DEN","KC","LV","LAC"],
    "NFCNorth": ["CHI","DET","GB","MIN"],
    "NFCSouth": ["ATL","CAR","NO","TB"],
    "NFCEast":  ["DAL","NYG","PHI","WAS"],
    "NFCWest":  ["ARI","LAR","SF","SEA"],
}


def _get(url: str, params: dict | None = None, retries: int = 3) -> dict[str, Any]:
    """HTTP GET with simple retry logic."""
    for attempt in range(retries):
        try:
            resp = requests.get(url, params=params, timeout=15)
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as exc:
            logger.warning("Attempt %d failed for %s: %s", attempt + 1, url, exc)
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                raise


def fetch_scoreboard(
    week: int | None = None,
    season: int | None = None,
    season_type: int = SEASON_TYPE_REGULAR,
) -> dict[str, Any]:
    """
    Fetch the NFL scoreboard.

    Parameters
    ----------
    week        : specific week number. None = current week.
    season      : 4-digit season year. None = current season.
    season_type : 1=Preseason, 2=Regular (default), 3=Postseason.

    Returns
    -------
    Raw ESPN JSON payload.
    """
    params: dict[str, Any] = {"seasontype": season_type}
    if week is not None:
        params["week"] = week
    if season is not None:
        params["dates"] = season
    logger.info("Fetching scoreboard: %s", params)
    return _get(f"{BASE}/scoreboard", params=params)


def fetch_postseason_scoreboard(
    week: int,
    season: int | None = None,
) -> dict[str, Any]:
    """
    Fetch a specific postseason round.

    Parameters
    ----------
    week   : 1=Wild Card, 2=Divisional, 3=Conference, 4=Pro Bowl, 5=Super Bowl
    season : 4-digit season year. None = current season.
    """
    return fetch_scoreboard(week=week, season=season,
                            season_type=SEASON_TYPE_POSTSEASON)


def fetch_full_postseason(season: int | None = None) -> list[dict[str, Any]]:
    """
    Fetch all postseason rounds for a season.
    Returns a list of raw ESPN payloads (one per round that has games).
    """
    results = []
    for week in range(1, POSTSEASON_WEEKS_COUNT + 1):
        try:
            data = fetch_postseason_scoreboard(week=week, season=season)
            if data.get("events"):
                results.append(data)
                logger.info("Postseason week %d (%s): %d games",
                            week, POSTSEASON_WEEKS.get(week, "?"),
                            len(data["events"]))
            else:
                logger.debug("Postseason week %d: no events", week)
        except Exception as exc:
            logger.warning("Postseason week %d fetch failed: %s", week, exc)
    return results


def fetch_standings() -> dict[str, Any]:
    """Fetch current NFL standings."""
    logger.info("Fetching standings")
    return _get(f"{BASE}/standings")


def fetch_team(team_id: str) -> dict[str, Any]:
    """Fetch detail for a single team."""
    return _get(f"{BASE}/teams/{team_id}")


def parse_scoreboard(data: dict[str, Any]) -> dict[str, Any]:
    """
    Extract a clean, normalised representation from the raw ESPN scoreboard JSON.

    Returns
    -------
    {
        "season"     : int,
        "season_type": str,   # "Regular Season" | "Postseason" | "Preseason"
        "season_type_id": int, # 1 | 2 | 3
        "week"       : int,
        "week_label" : str,   # "Week 14" | "Wild Card" | "Super Bowl" etc.
        "is_postseason": bool,
        "games"      : [<game_dict>, ...]
    }

    Each game_dict:
    {
        "id"           : str,
        "name"         : str,
        "week"         : int,
        "season"       : int,
        "season_type"  : str,
        "season_type_id": int,
        "is_postseason": bool,
        "week_label"   : str,
        "start_time"   : str,
        "status"       : str,   # "pre" | "in" | "post"
        "status_detail": str,
        "venue"        : str,
        "home"         : <team_dict>,
        "away"         : <team_dict>,
        "home_score"   : int | None,
        "away_score"   : int | None,
        "winner_abbr"  : str | None,
        "loser_abbr"   : str | None,
    }
    """
    season_data   = data.get("season", {})
    week_data     = data.get("week", {})
    events        = data.get("events", [])

    season_year     = season_data.get("year", 0)
    season_type_obj = season_data.get("type", {})
    season_type_str = season_type_obj.get("name", "Unknown")
    season_type_id  = season_type_obj.get("id", 2)
    try:
        season_type_id = int(season_type_id)
    except (TypeError, ValueError):
        season_type_id = 2

    week_number  = week_data.get("number", 0)
    is_postseason = season_type_id == SEASON_TYPE_POSTSEASON

    # Human-readable week label
    if is_postseason:
        week_label = POSTSEASON_WEEKS.get(week_number, f"Postseason Week {week_number}")
    else:
        week_label = f"Week {week_number}"

    games = []
    for event in events:
        competitions = event.get("competitions", [])
        if not competitions:
            continue
        comp = competitions[0]

        competitors = {
            c["homeAway"]: c
            for c in comp.get("competitors", [])
        }
        home_comp = competitors.get("home", {})
        away_comp = competitors.get("away", {})

        status      = event.get("status", {})
        status_type = status.get("type", {})

        home_score = _safe_int(home_comp.get("score"))
        away_score = _safe_int(away_comp.get("score"))
        status_val = status_type.get("state", "pre")

        winner_abbr: str | None = None
        loser_abbr:  str | None = None
        if status_val == "post" and home_score is not None and away_score is not None:
            if home_score > away_score:
                winner_abbr = _team_abbr(home_comp)
                loser_abbr  = _team_abbr(away_comp)
            elif away_score > home_score:
                winner_abbr = _team_abbr(away_comp)
                loser_abbr  = _team_abbr(home_comp)

        game = {
            "id"            : event.get("id", ""),
            "name"          : event.get("name", ""),
            "week"          : week_number,
            "season"        : season_year,
            "season_type"   : season_type_str,
            "season_type_id": season_type_id,
            "is_postseason" : is_postseason,
            "week_label"    : week_label,
            "start_time"    : event.get("date", ""),
            "status"        : status_val,
            "status_detail" : status_type.get("detail", ""),
            "venue"         : comp.get("venue", {}).get("fullName", ""),
            "home"          : _parse_competitor(home_comp),
            "away"          : _parse_competitor(away_comp),
            "home_score"    : home_score,
            "away_score"    : away_score,
            "winner_abbr"   : winner_abbr,
            "loser_abbr"    : loser_abbr,
        }
        games.append(game)

    return {
        "season"        : season_year,
        "season_type"   : season_type_str,
        "season_type_id": season_type_id,
        "week"          : week_number,
        "week_label"    : week_label,
        "is_postseason" : is_postseason,
        "games"         : games,
    }


def parse_standings(data: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Extract per-team standing records from the ESPN standings payload.

    Returns a flat list of dicts:
    {
        "abbr"      : str,
        "name"      : str,
        "wins"      : int,
        "losses"    : int,
        "ties"      : int,
        "win_pct"   : float,
        "points_for": int,
        "points_against": int,
        "division"  : str,
        "conference": str,
    }
    """
    results = []
    for child in data.get("children", []):          # AFC / NFC
        conf_name = child.get("name", "")
        for division in child.get("children", []):  # AFC North, etc.
            div_name = division.get("name", "")
            div_key  = div_name.replace(" ", "")    # "AFCNorth"
            for entry in division.get("standings", {}).get("entries", []):
                team_ref = entry.get("team", {})
                abbr     = team_ref.get("abbreviation", "")
                stats    = {s["name"]: s["value"] for s in entry.get("stats", [])}
                results.append({
                    "abbr"          : abbr,
                    "name"          : team_ref.get("displayName", ""),
                    "wins"          : int(stats.get("wins", 0)),
                    "losses"        : int(stats.get("losses", 0)),
                    "ties"          : int(stats.get("ties", 0)),
                    "win_pct"       : float(stats.get("winPercent", 0.0)),
                    "points_for"    : int(stats.get("pointsFor", 0)),
                    "points_against": int(stats.get("pointsAgainst", 0)),
                    "division"      : div_key,
                    "conference"    : "AFC" if "AFC" in conf_name else "NFC",
                })
    return results


# ── Helpers ──────────────────────────────────────────────────────────────────

def _parse_competitor(comp: dict) -> dict[str, Any]:
    team = comp.get("team", {})
    abbr = team.get("abbreviation", "").upper()
    record_summary = comp.get("records", [{}])[0].get("summary", "0-0-0") if comp.get("records") else "0-0-0"
    parts = (record_summary + "-0").split("-")
    wins   = _safe_int(parts[0]) or 0
    losses = _safe_int(parts[1]) or 0
    ties   = _safe_int(parts[2]) or 0
    return {
        "id"        : team.get("id", ""),
        "uid"       : team.get("uid", ""),
        "abbr"      : abbr,
        "name"      : team.get("displayName", ""),
        "short_name": team.get("shortDisplayName", ""),
        "location"  : team.get("location", ""),
        "logo"      : (team.get("logos") or [{}])[0].get("href", ""),
        "color"     : team.get("color", ""),
        "record"    : record_summary,
        "wins"      : wins,
        "losses"    : losses,
        "ties"      : ties,
        "conference": CONFERENCE_MAP.get(abbr, ""),
        "division"  : DIVISION_MAP.get(abbr, ""),
    }


def _team_abbr(comp: dict) -> str:
    return comp.get("team", {}).get("abbreviation", "").upper()


def _safe_int(val: Any) -> int | None:
    try:
        return int(val)
    except (TypeError, ValueError):
        return None
