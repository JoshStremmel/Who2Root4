"""
tests/fixtures.py
─────────────────
Shared mock ESPN data and parsed objects used across the test suite.
No network calls are made — all data is hardcoded to match the ESPN
API shape exactly.
"""

from __future__ import annotations

# ── Raw ESPN scoreboard JSON (mocked) ─────────────────────────────────────────

def make_raw_scoreboard(
    season: int = 2025,
    week: int = 14,
    season_type_id: int = 2,
    season_type_name: str = "Regular Season",
    events: list | None = None,
) -> dict:
    """Build a minimal ESPN scoreboard payload."""
    return {
        "season": {
            "year": season,
            "type": {"id": season_type_id, "name": season_type_name},
        },
        "week": {"number": week},
        "events": events or [],
    }


def make_event(
    event_id: str,
    home_abbr: str,
    away_abbr: str,
    home_name: str,
    away_name: str,
    home_score: int | None = None,
    away_score: int | None = None,
    status_state: str = "pre",
    status_detail: str = "Scheduled",
    venue: str = "Test Stadium",
    start_time: str = "2025-12-07T18:00Z",
    home_record: str = "10-3-0",
    away_record: str = "8-5-0",
) -> dict:
    """Build a minimal ESPN event dict."""
    home_comp = _make_competitor(home_abbr, home_name, "home",
                                  home_score, home_record)
    away_comp = _make_competitor(away_abbr, away_name, "away",
                                  away_score, away_record)
    return {
        "id":   event_id,
        "name": f"{away_name} at {home_name}",
        "date": start_time,
        "status": {
            "type": {"state": status_state, "detail": status_detail}
        },
        "competitions": [{
            "competitors": [home_comp, away_comp],
            "venue": {"fullName": venue},
        }],
    }


def _make_competitor(abbr, name, home_away, score, record) -> dict:
    parts = (record + "-0").split("-")
    return {
        "homeAway": home_away,
        "score": str(score) if score is not None else None,
        "records": [{"summary": record}],
        "team": {
            "id":               abbr,
            "uid":              f"s:20~l:28~t:{abbr}",
            "abbreviation":     abbr,
            "displayName":      name,
            "shortDisplayName": name.split()[-1],
            "location":         name.split()[0],
            "color":            "ff0000",
            "logos": [{"href": f"https://example.com/{abbr}.png"}],
        },
    }


# ── Pre-built fixtures ────────────────────────────────────────────────────────

# Completed divisional game: BAL 27 CIN 17
COMPLETED_DIVISIONAL_EVENT = make_event(
    event_id    = "401547001",
    home_abbr   = "BAL",
    away_abbr   = "CIN",
    home_name   = "Baltimore Ravens",
    away_name   = "Cincinnati Bengals",
    home_score  = 27,
    away_score  = 17,
    status_state   = "post",
    status_detail  = "Final",
    home_record = "11-2-0",
    away_record = "9-4-0",
)

# Upcoming divisional game: PIT at CLE
UPCOMING_DIVISIONAL_EVENT = make_event(
    event_id  = "401547002",
    home_abbr = "CLE",
    away_abbr = "PIT",
    home_name = "Cleveland Browns",
    away_name = "Pittsburgh Steelers",
    home_record = "4-9-0",
    away_record = "9-4-0",
)

# Live conference game: BUF at KC
LIVE_CONFERENCE_EVENT = make_event(
    event_id      = "401547003",
    home_abbr     = "KC",
    away_abbr     = "BUF",
    home_name     = "Kansas City Chiefs",
    away_name     = "Buffalo Bills",
    home_score    = 14,
    away_score    = 10,
    status_state  = "in",
    status_detail = "3rd Quarter",
    home_record   = "11-2-0",
    away_record   = "10-3-0",
)

# Cross-conference game (NFC team vs AFC team)
INTERCONFERENCE_EVENT = make_event(
    event_id  = "401547004",
    home_abbr = "DAL",
    away_abbr = "KC",
    home_name = "Dallas Cowboys",
    away_name = "Kansas City Chiefs",
    home_record = "6-7-0",
    away_record = "11-2-0",
)

# Wild Card postseason game
WILD_CARD_EVENT = make_event(
    event_id      = "401700001",
    home_abbr     = "BAL",
    away_abbr     = "PIT",
    home_name     = "Baltimore Ravens",
    away_name     = "Pittsburgh Steelers",
    home_score    = 28,
    away_score    = 14,
    status_state  = "post",
    status_detail = "Final",
    home_record   = "12-5-0",
    away_record   = "10-7-0",
)

# Standard regular season scoreboard
REGULAR_SCOREBOARD = make_raw_scoreboard(
    season=2025, week=14,
    events=[
        COMPLETED_DIVISIONAL_EVENT,
        UPCOMING_DIVISIONAL_EVENT,
        LIVE_CONFERENCE_EVENT,
        INTERCONFERENCE_EVENT,
    ],
)

# Postseason scoreboard (Wild Card week)
POSTSEASON_SCOREBOARD = make_raw_scoreboard(
    season=2025, week=1,
    season_type_id=3,
    season_type_name="Postseason",
    events=[WILD_CARD_EVENT],
)

# Standings fixture (flat list matching parse_standings output)
STANDINGS = [
    # AFC North
    {"abbr":"BAL","name":"Baltimore Ravens",    "wins":11,"losses":2,"ties":0,
     "win_pct":0.846,"points_for":320,"points_against":210,
     "division":"AFCNorth","conference":"AFC"},
    {"abbr":"CIN","name":"Cincinnati Bengals",  "wins":9, "losses":4,"ties":0,
     "win_pct":0.692,"points_for":290,"points_against":245,
     "division":"AFCNorth","conference":"AFC"},
    {"abbr":"PIT","name":"Pittsburgh Steelers", "wins":9, "losses":4,"ties":0,
     "win_pct":0.692,"points_for":270,"points_against":240,
     "division":"AFCNorth","conference":"AFC"},
    {"abbr":"CLE","name":"Cleveland Browns",    "wins":4, "losses":9,"ties":0,
     "win_pct":0.308,"points_for":190,"points_against":280,
     "division":"AFCNorth","conference":"AFC"},
    # AFC West
    {"abbr":"KC", "name":"Kansas City Chiefs",  "wins":11,"losses":2,"ties":0,
     "win_pct":0.846,"points_for":330,"points_against":200,
     "division":"AFCWest","conference":"AFC"},
    {"abbr":"BUF","name":"Buffalo Bills",       "wins":10,"losses":3,"ties":0,
     "win_pct":0.769,"points_for":310,"points_against":220,
     "division":"AFCEast","conference":"AFC"},
    {"abbr":"LV", "name":"Las Vegas Raiders",   "wins":3, "losses":10,"ties":0,
     "win_pct":0.231,"points_for":170,"points_against":310,
     "division":"AFCWest","conference":"AFC"},
    {"abbr":"DEN","name":"Denver Broncos",      "wins":6, "losses":7,"ties":0,
     "win_pct":0.462,"points_for":220,"points_against":260,
     "division":"AFCWest","conference":"AFC"},
    {"abbr":"LAC","name":"Los Angeles Chargers","wins":8,"losses":5,"ties":0,
     "win_pct":0.615,"points_for":250,"points_against":240,
     "division":"AFCWest","conference":"AFC"},
    # NFC East
    {"abbr":"DAL","name":"Dallas Cowboys",      "wins":6, "losses":7,"ties":0,
     "win_pct":0.462,"points_for":240,"points_against":270,
     "division":"NFCEast","conference":"NFC"},
    {"abbr":"PHI","name":"Philadelphia Eagles", "wins":11,"losses":2,"ties":0,
     "win_pct":0.846,"points_for":340,"points_against":210,
     "division":"NFCEast","conference":"NFC"},
    {"abbr":"NYG","name":"New York Giants",     "wins":3,"losses":10,"ties":0,
     "win_pct":0.231,"points_for":160,"points_against":300,
     "division":"NFCEast","conference":"NFC"},
    {"abbr":"WAS","name":"Washington Commanders","wins":8,"losses":5,"ties":0,
     "win_pct":0.615,"points_for":260,"points_against":245,
     "division":"NFCEast","conference":"NFC"},
]
