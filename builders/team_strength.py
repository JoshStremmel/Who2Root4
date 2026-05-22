"""
team_strength.py
────────────────
Compute a continuous teamStrengthScore for each NFL team from parsed game data.
Used as a tiebreaker in game importance ranking so that even when two games have
the same base importance, the one involving stronger teams scores higher.

Five weighted signals (all normalized to [0, 1] over active teams):
  1. Point differential          weight 0.35
  2. Strength of schedule        weight 0.25
  3. Division standing bonus     weight 0.20  (already [0,1], not re-normalized)
  4. Recent form (last 4 games)  weight 0.12
  5. Win margin consistency      weight 0.08

Teams with 0 completed games receive 0.5 neutral for signals 1, 2, 4, 5.
"""

from __future__ import annotations

from espn_fetcher import DIVISION_MAP


_POSITION_BONUSES = [1.0, 0.66, 0.33, 0.0]


def computeAllTeamStrengths(
    all_games: list[dict],
    standings: list[dict] | None = None,
) -> dict[str, dict]:
    """
    Compute a multi-signal teamStrengthScore for every team in all_games.

    Parameters
    ----------
    all_games : list of parsed game dicts (from parse_scoreboard / SeasonIngester)
    standings : optional list of standings dicts from parse_standings

    Returns
    -------
    dict: teamAbbr → {
        "strengthScore":        float,   # final composite [0,1]
        "pointDiff":            float,   # normalized signal 1
        "sos":                  float,   # normalized signal 2
        "divisionBonus":        float,   # signal 3 (already [0,1])
        "recentForm":           float,   # normalized signal 4
        "winMarginConsistency": float,   # normalized signal 5
        "name":                 str,
    }
    """
    raw: dict[str, dict] = {}

    def _ensure(abbr: str, name: str = "") -> None:
        if abbr not in raw:
            raw[abbr] = {
                "name": name,
                "net_points": 0,
                "opp_win_pcts": [],
                "completed_games": [],  # list of (start_time, won:bool, margin:int)
                "win_margins": [],
                "s3_raw": 0.0,
                "s4_raw": 0.0,
                "s5_raw": 0.0,
                "has_completed": False,
            }
        if name and not raw[abbr]["name"]:
            raw[abbr]["name"] = name

    # Seed from standings so teams with 0 completed games still appear
    standings_map: dict[str, dict] = {}
    if standings:
        for sd in standings:
            abbr = sd["abbr"]
            standings_map[abbr] = sd
            _ensure(abbr, sd.get("name", abbr))

    # Accumulate per-game signals from completed games
    for game in all_games:
        if game.get("status") != "post":
            continue

        home = game.get("home", {})
        away = game.get("away", {})
        home_abbr = home.get("abbr", "")
        away_abbr = away.get("abbr", "")
        if not home_abbr or not away_abbr:
            continue

        home_score = game.get("home_score") or 0
        away_score = game.get("away_score") or 0
        margin = home_score - away_score
        start_time = game.get("start_time", "")
        winner_abbr = game.get("winner_abbr")

        _ensure(home_abbr, home.get("name", ""))
        _ensure(away_abbr, away.get("name", ""))

        home_won = winner_abbr == home_abbr
        away_won = winner_abbr == away_abbr

        # Signal 1: net point differential
        raw[home_abbr]["net_points"] += margin
        raw[away_abbr]["net_points"] -= margin

        # Signal 2: SOS — opponent win percentage (record embedded in game data)
        away_total = away.get("wins", 0) + away.get("losses", 0)
        if away_total > 0:
            raw[home_abbr]["opp_win_pcts"].append(away.get("wins", 0) / away_total)

        home_total = home.get("wins", 0) + home.get("losses", 0)
        if home_total > 0:
            raw[away_abbr]["opp_win_pcts"].append(home.get("wins", 0) / home_total)

        # Signal 4: recent form (date + outcome)
        raw[home_abbr]["completed_games"].append((start_time, home_won, abs(margin)))
        raw[away_abbr]["completed_games"].append((start_time, away_won, abs(margin)))

        # Signal 5: win margins (wins only)
        if home_won:
            raw[home_abbr]["win_margins"].append(abs(margin))
        if away_won:
            raw[away_abbr]["win_margins"].append(abs(margin))

        raw[home_abbr]["has_completed"] = True
        raw[away_abbr]["has_completed"] = True

    if not raw:
        return {}

    # Signal 3: Division standing bonus
    _compute_division_bonus(raw, all_games, standings_map)

    # Signals 4 and 5 — derive scalar values from accumulated lists
    for data in raw.values():
        # Signal 4: weighted recent form (last 4 games, most recent = 4 pts)
        recent = sorted(data["completed_games"], key=lambda x: x[0], reverse=True)[:4]
        weights = [4, 3, 2, 1]
        weighted_wins = sum(w for w, (_, won, _) in zip(weights, recent) if won)
        data["s4_raw"] = weighted_wins / 10.0

        # Signal 5: average win margin
        wm = data["win_margins"]
        data["s5_raw"] = sum(wm) / len(wm) if wm else 0.0

    # Normalize signals 1, 2, 4, 5 over active teams only
    active_abbrs = [a for a in raw if raw[a]["has_completed"]]
    inactive_abbrs = [a for a in raw if not raw[a]["has_completed"]]

    result: dict[str, dict] = {}

    if active_abbrs:
        s1_vals = [raw[a]["net_points"] for a in active_abbrs]
        s2_vals = [
            sum(raw[a]["opp_win_pcts"]) / len(raw[a]["opp_win_pcts"])
            if raw[a]["opp_win_pcts"] else 0.5
            for a in active_abbrs
        ]
        s4_vals = [raw[a]["s4_raw"] for a in active_abbrs]
        s5_vals = [raw[a]["s5_raw"] for a in active_abbrs]

        s1_norm = _normalize(s1_vals)
        s2_norm = _normalize(s2_vals)
        s4_norm = _normalize(s4_vals)
        s5_norm = _normalize(s5_vals)

        for i, abbr in enumerate(active_abbrs):
            s3 = raw[abbr]["s3_raw"]
            strength = (
                0.35 * s1_norm[i]
                + 0.25 * s2_norm[i]
                + 0.20 * s3
                + 0.12 * s4_norm[i]
                + 0.08 * s5_norm[i]
            )
            result[abbr] = {
                "strengthScore":        round(strength, 4),
                "pointDiff":            round(s1_norm[i], 4),
                "sos":                  round(s2_norm[i], 4),
                "divisionBonus":        round(s3, 4),
                "recentForm":           round(s4_norm[i], 4),
                "winMarginConsistency": round(s5_norm[i], 4),
                "name": raw[abbr]["name"],
            }

    # Teams with 0 completed games: neutral 0.5 for signals 1, 2, 4, 5
    for abbr in inactive_abbrs:
        s3 = raw[abbr]["s3_raw"]
        strength = 0.35 * 0.5 + 0.25 * 0.5 + 0.20 * s3 + 0.12 * 0.5 + 0.08 * 0.5
        result[abbr] = {
            "strengthScore":        round(strength, 4),
            "pointDiff":            0.5,
            "sos":                  0.5,
            "divisionBonus":        round(s3, 4),
            "recentForm":           0.5,
            "winMarginConsistency": 0.5,
            "name": raw[abbr]["name"],
        }

    return result


def print_strength_table(
    strength_map: dict[str, dict],
    standings: list[dict] | None = None,
) -> None:
    """Print a sorted debug table of all teams' strength scores and signal breakdowns."""
    if not strength_map:
        print("  (no strength data)")
        return

    records: dict[str, str] = {}
    if standings:
        for sd in standings:
            records[sd["abbr"]] = f"{sd['wins']}-{sd['losses']}"

    rows = sorted(strength_map.items(), key=lambda x: x[1]["strengthScore"], reverse=True)

    print(f"\n{'='*93}")
    print("  Team Strength Scores  (sorted descending)")
    print(f"{'='*93}")
    header = (
        f"  {'Team':<28} {'W-L':<7} {'Strength':>8}"
        f"  {'PtDiff':>7}  {'SOS':>7}  {'DivRnk':>7}  {'Form':>7}  {'Margin':>7}"
    )
    print(header)
    print("  " + "-" * 91)
    for abbr, data in rows:
        name = data.get("name") or abbr
        rec = records.get(abbr, "?-?")
        print(
            f"  {name:<28} {rec:<7} {data['strengthScore']:>8.4f}"
            f"  {data['pointDiff']:>7.4f}  {data['sos']:>7.4f}"
            f"  {data['divisionBonus']:>7.4f}  {data['recentForm']:>7.4f}"
            f"  {data['winMarginConsistency']:>7.4f}"
        )
    print()


# ── Internal helpers ──────────────────────────────────────────────────────────

def _normalize(vals: list[float]) -> list[float]:
    mn, mx = min(vals), max(vals)
    if mx == mn:
        return [0.5] * len(vals)
    return [(v - mn) / (mx - mn) for v in vals]


def _win_pct(wins: int, losses: int) -> float:
    total = wins + losses
    return wins / total if total > 0 else 0.0


def _compute_division_bonus(
    raw: dict[str, dict],
    all_games: list[dict],
    standings_map: dict[str, dict],
) -> None:
    """Assign s3_raw (division standing bonus) to each team in raw."""

    def _record(abbr: str) -> tuple[int, int]:
        if abbr in standings_map:
            sd = standings_map[abbr]
            return sd.get("wins", 0), sd.get("losses", 0)
        w = sum(
            1 for g in all_games
            if g.get("status") == "post" and g.get("winner_abbr") == abbr
        )
        l = sum(
            1 for g in all_games
            if g.get("status") == "post" and g.get("loser_abbr") == abbr
        )
        return w, l

    # Group teams by division
    div_groups: dict[str, list[str]] = {}
    for abbr in raw:
        div = DIVISION_MAP.get(abbr, "")
        if div:
            div_groups.setdefault(div, []).append(abbr)

    for div, members in div_groups.items():
        # Sort by win percentage descending
        ranked = sorted(members, key=lambda a: _win_pct(*_record(a)), reverse=True)

        # Walk through grouped by tied win_pct; share bonus positions within each tie group
        i = 0
        rank = 0
        while i < len(ranked):
            pct_i = round(_win_pct(*_record(ranked[i])), 6)
            j = i + 1
            while j < len(ranked) and round(_win_pct(*_record(ranked[j])), 6) == pct_i:
                j += 1
            tied = ranked[i:j]
            tied_positions = range(rank, rank + len(tied))
            avg_bonus = sum(
                _POSITION_BONUSES[p] if p < len(_POSITION_BONUSES) else 0.0
                for p in tied_positions
            ) / len(tied)
            for a in tied:
                raw[a]["s3_raw"] = avg_bonus
            rank += len(tied)
            i = j
