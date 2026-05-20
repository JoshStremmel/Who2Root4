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
  ?seasontype=2&week=<WEEK>&dates=<SEASON_YEAR>

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


def fetch_scoreboard(week: int | None = None, season: int | None = None) -> dict[str, Any]:
    """
    Fetch the NFL scoreboard.

    Parameters
    ----------
    week   : specific week number (1–18 regular season). None = current week.
    season : 4-digit season year (e.g. 2025). None = current season.

    Returns
    -------
    Raw ESPN JSON payload.
    """
    params: dict[str, Any] = {}
    if week is not None:
        params["seasontype"] = 2  # regular season
        params["week"] = week
    if season is not None:
        params["dates"] = season
    logger.info("Fetching scoreboard: %s", params or "current week")
    return _get(f"{BASE}/scoreboard", params=params)


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
        "season"    : int,
        "season_type": str,   # "Regular Season" | "Postseason" | "Preseason"
        "week"      : int,
        "games"     : [<game_dict>, ...]
    }

    Each game_dict:
    {
        "id"          : str,           # ESPN event id
        "name"        : str,           # "Cincinnati Bengals at Baltimore Ravens"
        "week"        : int,
        "season"      : int,
        "season_type" : str,
        "start_time"  : str,           # ISO-8601
        "status"      : str,           # "pre" | "in" | "post"
        "status_detail": str,          # "Scheduled" | "Final" | "1st Quarter" …
        "venue"       : str,
        "home"        : <team_dict>,
        "away"        : <team_dict>,
        "home_score"  : int | None,
        "away_score"  : int | None,
        "winner_abbr" : str | None,    # abbr of winning team, or None if not final
        "loser_abbr"  : str | None,
    }

    Each team_dict embedded inside a game:
    {
        "id"          : str,
        "uid"         : str,
        "abbr"        : str,
        "name"        : str,           # full name, e.g. "Cincinnati Bengals"
        "short_name"  : str,           # e.g. "Bengals"
        "location"    : str,           # city/region, e.g. "Cincinnati"
        "logo"        : str,           # URL
        "color"       : str,           # primary hex
        "record"      : str,           # e.g. "10-6-0"
        "wins"        : int,
        "losses"      : int,
        "ties"        : int,
        "conference"  : str,           # "AFC" | "NFC"
        "division"    : str,           # e.g. "AFCNorth"
    }
    """
    season_data = data.get("season", {})
    week_data   = data.get("week", {})
    events      = data.get("events", [])

    season_year = season_data.get("year", 0)
    season_type = season_data.get("type", {}).get("name", "Unknown")
    week_number = week_data.get("number", 0)

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
        status_val = status_type.get("state", "pre")  # pre | in | post

        winner_abbr: str | None = None
        loser_abbr:  str | None = None
        if status_val == "post" and home_score is not None and away_score is not None:
            if home_score > away_score:
                winner_abbr = _team_abbr(home_comp)
                loser_abbr  = _team_abbr(away_comp)
            elif away_score > home_score:
                winner_abbr = _team_abbr(away_comp)
                loser_abbr  = _team_abbr(home_comp)
            # ties: both remain None

        game = {
            "id"           : event.get("id", ""),
            "name"         : event.get("name", ""),
            "week"         : week_number,
            "season"       : season_year,
            "season_type"  : season_type,
            "start_time"   : event.get("date", ""),
            "status"       : status_val,
            "status_detail": status_type.get("detail", ""),
            "venue"        : comp.get("venue", {}).get("fullName", ""),
            "home"         : _parse_competitor(home_comp),
            "away"         : _parse_competitor(away_comp),
            "home_score"   : home_score,
            "away_score"   : away_score,
            "winner_abbr"  : winner_abbr,
            "loser_abbr"   : loser_abbr,
        }
        games.append(game)

    return {
        "season"      : season_year,
        "season_type" : season_type,
        "week"        : week_number,
        "games"       : games,
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
