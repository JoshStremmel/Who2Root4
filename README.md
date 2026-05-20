# nfl_holonic

**ESPN → Holonic RDF Knowledge Graph** for NFL playoff reasoning.

Converts live NFL data from the ESPN public API into a semantic, quad-store–ready
knowledge graph using the `holonic` four-graph model (interior / boundary / projection / context).

---

## Install

```bash
pip install rdflib requests
# or if you want the full holonic dataset backend:
pip install holonic rdflib requests
```

---

## Quick Start

```bash
# Current week — Bengals fan
python pipeline.py --team CIN

# Specific week, save the graph
python pipeline.py --team CIN --week 14 --season 2025 --output holarchy.trig

# Also dump each named graph as individual Turtle files
python pipeline.py --team CIN --output holarchy.trig --dump-graphs

# Dislikes also affect recommendation scores
python pipeline.py --team CIN --dislikes PIT BAL --output holarchy.trig

# Offline mode (use saved ESPN JSON)
python pipeline.py --team CIN --json-file espn_data.json
```

---

## File Layout

```
nfl_holonic/
├── pipeline.py                          # Orchestration entry point
├── requirements.txt
│
├── ontology/                            # OWL 2 / RDF vocabularies
│   ├── core.ttl                         # Team, Game, Outcome, User, structural edges
│   ├── competition.ttl                  # Competitive edge properties
│   └── playoff_impact_recommendation.ttl # PlayoffSpot, Scenario, Impact, Recommendation
│
├── builders/
│   ├── espn_fetcher.py                  # ESPN API → normalised Python dicts
│   ├── rdf_builder.py                   # Dicts → holonic rdflib Dataset
│   └── recommendation_engine.py        # Graph reasoning → rooting recommendations
│
└── queries/
    └── sparql_queries.py                # Named SPARQL queries + run_query() helper
```

---

## Named Graphs (the Four-Layer Holonic Model)

| Named Graph IRI                     | Layer     | Contents                                  |
|-------------------------------------|-----------|-------------------------------------------|
| `urn:nfl:graph:team:<ABBR>`         | Interior  | Per-team facts (name, record, division)   |
| `urn:nfl:graph:games:<season>:<wk>` | Interior  | Game events for a specific week           |
| `urn:nfl:graph:outcomes`            | Interior  | Completed game outcomes + impact edges    |
| `urn:nfl:graph:competition`         | Interior  | Structural & competitive edges            |
| `urn:nfl:graph:standings`           | Interior  | Standings snapshot + playoff assignments  |
| `urn:nfl:graph:holarchy`            | Context   | Registry of all holons + their graph IRIs |
| `urn:nfl:graph:recommendations`     | Projection| User-specific rooting recommendations     |
| (default graph)                     | Boundary  | Ontology / SHACL shapes                   |

---

## Example SPARQL Queries

All queries are importable from `queries/sparql_queries.py`.

### Games that help the Bengals

```sparql
PREFIX impact: <urn:nfl:impact:>
PREFIX nfl:    <urn:nfl:>

SELECT ?outcome ?winnerName ?impactScore WHERE {
    GRAPH <urn:nfl:graph:outcomes> {
        ?outcome a nfl:Outcome ;
                 impact:improvesOdds <urn:nfl:team:CIN> ;
                 nfl:winner ?winner .
        OPTIONAL { ?outcome impact:score ?impactScore }
    }
    GRAPH ?t { ?winner nfl:name ?winnerName }
}
ORDER BY DESC(?impactScore)
```

### Who should I root for? (the inference rule)

```sparql
PREFIX nfl: <urn:nfl:>
PREFIX rec: <urn:nfl:recommendation:>

SELECT ?rootFor ?against ?score ?reasoning WHERE {
    GRAPH <urn:nfl:graph:recommendations> {
        ?r a nfl:Recommendation ;
           nfl:rootFor ?rootFor ;
           nfl:against ?against ;
           nfl:recommendationScore ?score ;
           nfl:reasoning ?reasoning .
    }
}
ORDER BY DESC(?score)
```

---

## Extending

### Swap in Apache Jena Fuseki

Replace the `rdflib` backend with `holonic`'s `FusekiBackend`:

```python
from holonic.backends.fuseki_backend import FusekiBackend
from holonic import HolonicDataset

ds = HolonicDataset(backend=FusekiBackend("http://localhost:3030", dataset="nfl"))
```

Then pass `ds.dataset` (or the backend's native dataset) to `NFLGraphBuilder`.

### Add Scenario Nodes

```python
from rdflib import URIRef, RDF, Namespace

PLAYOFF = Namespace("urn:nfl:playoff:")
ds.graph("urn:nfl:graph:scenarios").add((
    URIRef("urn:nfl:scenario:BengalsClinch"),
    RDF.type,
    PLAYOFF.Scenario,
))
```

### Add User Preferences

```python
from rdf_builder import USER, NFL, _team_iri
user_g = builder.dataset.graph("urn:nfl:graph:users")
user_g.add((USER["josh"], NFL.favoriteTeam, _team_iri("CIN")))
user_g.add((USER["josh"], NFL.dislikes,     _team_iri("PIT")))
```

---

## Architecture

```
ESPN API
   │
   ▼
espn_fetcher.py        ← HTTP → normalised Python dicts
   │
   ▼
rdf_builder.py         ← dicts → rdflib Dataset (named graphs)
   │
   ├── ontology/*.ttl  ← loaded into default graph (boundary layer)
   │
   ├── graph:team:*    ← interior: per-team holons
   ├── graph:games:*   ← interior: game holons (week-scoped)
   ├── graph:outcomes  ← interior: outcomes + impact edges
   ├── graph:competition ← interior: rivalry / competitive edges
   ├── graph:standings ← interior: standings snapshot
   └── graph:holarchy  ← context: holon registry
           │
           ▼
   recommendation_engine.py   ← SPARQL → scoring → graph:recommendations
           │
           ▼
   sparql_queries.py          ← query library + print_results()
           │
           ▼
   pipeline.py                ← CLI entry point, serialize → .trig
```
