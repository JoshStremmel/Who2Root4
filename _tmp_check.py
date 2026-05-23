"""Reproduce the PIT scenario builder output."""
import json, sys
sys.path.insert(0, "builders")
sys.path.insert(0, ".")
from espn_fetcher import parse_scoreboard, DIVISION_MAP, CONFERENCE_MAP
from rdf_builder import NFLGraphBuilder
from scenario_builder import ScenarioBuilder
from tiebreaker import Team as TBTeam, Game as TBGame, resolve_division_tie
from collections import defaultdict

all_game_dicts = []
for wk in range(1, 19):
    try:
        raw = json.loads(open(f".cache/espn/scoreboard_2025_reg_w{wk:02d}.json").read())
        parsed = parse_scoreboard(raw)
        all_game_dicts.extend(parsed.get("games", []))
    except FileNotFoundError:
        break

post_games = [g for g in all_game_dicts if g.get("status") == "post"]
pre_games  = [g for g in all_game_dicts if g.get("status") in ("pre", "in")]
print(f"Games: post={len(post_games)}, pre/in={len(pre_games)}")

# Derive standings from completed games
teams_wins = defaultdict(int)
teams_losses = defaultdict(int)
teams_ties = defaultdict(int)
for g in post_games:
    h, a = g["home"]["abbr"], g["away"]["abbr"]
    w = g.get("winner_abbr")
    l = g.get("loser_abbr")
    if w and l:
        teams_wins[w] += 1
        teams_losses[l] += 1
    elif g.get("home_score") == g.get("away_score") and g.get("home_score") is not None:
        teams_ties[h] += 1
        teams_ties[a] += 1

all_abbrs = set()
for g in all_game_dicts:
    all_abbrs.add(g["home"]["abbr"])
    all_abbrs.add(g["away"]["abbr"])

derived = []
for abbr in sorted(all_abbrs):
    w = teams_wins.get(abbr, 0)
    l = teams_losses.get(abbr, 0)
    t = teams_ties.get(abbr, 0)
    g = w + l + t
    pct = (w + 0.5*t)/g if g else 0.0
    derived.append({
        "abbr": abbr,
        "wins": w, "losses": l, "ties": t,
        "win_pct": pct,
        "division": DIVISION_MAP.get(abbr, ""),
        "conference": CONFERENCE_MAP.get(abbr, ""),
    })

afc_north = [t for t in derived if DIVISION_MAP.get(t["abbr"]) == "AFCNorth"]
print("\nAFCNorth:")
for t in sorted(afc_north, key=lambda x: -x["wins"]):
    print(f"  {t['abbr']:4} {t['wins']}-{t['losses']}")

# Compute division tiebreaker order
tb_teams = [TBTeam.from_standings_dict(sd) for sd in derived]
tb_games_completed = [TBGame.from_dict(g) for g in post_games]

div_tb_order = {}
by_div = defaultdict(list)
for t in tb_teams:
    by_div[t.division].append(t)

for div, teams in by_div.items():
    by_pct = defaultdict(list)
    for t in teams:
        by_pct[round(t.win_pct, 4)].append(t)
    ordered = []
    for pct in sorted(by_pct.keys(), reverse=True):
        group = by_pct[pct]
        if len(group) == 1:
            ordered.append(group[0].id)
        else:
            result = resolve_division_tie(group, tb_games_completed, tb_teams)
            ordered.extend(t.id for t in result)
    div_tb_order[div] = ordered

print(f"\nAFCNorth tiebreaker order: {div_tb_order.get('AFCNorth')}")

# Build scenario builder
builder = NFLGraphBuilder()
last_parsed = parse_scoreboard(json.loads(open(".cache/espn/scoreboard_2025_reg_w18.json").read()))
builder.add_teams_from_scoreboard(last_parsed)
builder.add_standings(derived)
builder.add_teams_from_standings(derived)

sb = ScenarioBuilder(
    dataset=builder.dataset,
    standings=derived,
    games=all_game_dicts,
    tiebreaker_order=div_tb_order,
)
sb.generate_clinch_scenarios()
sb.generate_elimination_scenarios()

print("\n--- PIT scenarios ---")
sb.print_scenarios("PIT")
print("--- BAL scenarios ---")
sb.print_scenarios("BAL")
