# Who2Root4

NFL rooting recommendation engine — tells you which games to watch and who to root for based on your favorite team's playoff path.

Live at **[who2root4.vercel.app](https://who2root4.vercel.app)**

---

## How it works

1. **Data**: `pipeline.py` fetches ESPN scoreboard JSON and caches it to `.cache/espn/`. These files are committed to the repo.
2. **Engine**: `src/root4.js (ROOT4)` is the single canonical calculation module — standings, playoff probabilities, tiebreakers, recommendations, and scenarios all live here.
3. **Main app**: `index.html` + `src/` — loads ESPN data from GitHub, runs the engine, and renders the UI.
4. **Graph view**: `graph/` — a separate Vite/TypeScript app that visualizes playoff impact as an interactive node graph. It imports the same engine so calculations are always identical to the main site.

---

## Architecture

```
src/
  root4.js       ← ROOT4: single source of truth for all NFL calculations
  root4.d.ts     ← TypeScript declarations (used by the graph app)
  data.js        ← ESPN data loader; calls engine functions; sets window.* globals
  app.jsx        ← main React app shell
  recs.jsx       ← "This Week" recommendations view
  standings.jsx  ← division standings + playoff bracket
  scenarios.jsx  ← clinch / elimination scenarios
  schedule.jsx   ← weekly schedule grid
  detail.jsx     ← game detail overlay

graph/
  src/
    lib/
      nfl-data.ts    ← ESPN data loader for the graph view
      ugm-builder.ts ← builds UGM graph nodes/edges; imports ROOT4 via @root4 alias
    pages/
      GraphView.tsx
    components/
      PlayoffGraph.tsx

builders/
  espn_fetcher.py    ← ESPN API client
  season_ingester.py ← full-season ingestion with disk caching

pipeline.py          ← ESPN data fetcher (run to refresh cached data)
```

### ROOT4 — the single calculation engine

`src/root4.js` exports pure functions — they take data as parameters and return results with no side effects or global reads:

| Function | Description |
|---|---|
| `computeStandings(teams, tiebreakers)` | 7-seed playoff picture per conference |
| `computeTiebreakerReasons(teams)` | Full NFL two-club tiebreaker rules |
| `buildTeamStrengths(teams)` | 6-signal strength score [0,1] per team |
| `computeRecommendations(fav, dislikes, mode, ...)` | Ranked rooting recommendations |
| `computeScenarios(fav, ...)` | Clinch / elimination paths |
| `availableModes(fav, ...)` | Which modes are still reachable |
| `modeScore(...)` | Per-game impact score for a given mode |

**Main app** wraps these as `window.*` globals so JSX components work without changes.
**Graph app** imports them directly via Vite alias `@root4 → ../../src/root4.js`.

When you change `src/root4.js`, every part of the site updates — no sync required.

---

## Development

### Refresh ESPN data

```bash
python pipeline.py                          # current season
python pipeline.py --season 2025 --through-week 14
python pipeline.py --force-refresh
```

### Run the graph view

```bash
pnpm dev:graph    # starts at http://localhost:5174/graph/
```

### Build for production

```bash
pnpm build:graph  # builds graph app to dist/graph/
```

Vercel builds the graph app and serves the main app as static files.

---

## Design decisions

- **No server-side calculations** — everything computes in the browser from cached ESPN JSON. The site works as long as `.cache/espn/` files are committed.
- **ROOT4** — `src/root4.js` is the only place NFL math lives. Both views import from it.
- **Python = data only** — `pipeline.py` and `builders/` fetch and cache ESPN data. No calculations happen in Python.
- **Graph view uses UGM** — `@g3t/core` UGM powers the interactive graph visualization. Node/edge data comes from ROOT4.

---

## Stack

| Layer | Tech |
|---|---|
| Main app | React 18 (CDN), Babel standalone, vanilla CSS |
| Graph view | React 18, Vite, TypeScript, @g3t/core UGM, Cytoscape |
| ROOT4 engine | Vanilla ES module JavaScript (`src/root4.js`) |
| Data pipeline | Python 3, requests |
| Deployment | Vercel |
