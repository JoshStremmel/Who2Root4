"""
sparql_queries.py
─────────────────
Ready-to-run SPARQL queries against the holonic NFL RDF dataset.

All queries use the shared PREFIX block defined in PREFIXES and can be
executed via `run_query(ds, QUERY_NAME)` or directly via rdflib.

Usage
-----
    from sparql_queries import run_query, FIND_GAMES_HELPING_TEAM
    results = run_query(builder.dataset, FIND_GAMES_HELPING_TEAM,
                        bindings={"team": "urn:nfl:team:CIN"})
"""

from __future__ import annotations

from typing import Any

from rdflib import Dataset, URIRef
from rdflib.plugins.sparql import prepareQuery

PREFIXES = """
PREFIX rdf:     <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs:    <http://www.w3.org/2000/01/rdf-schema#>
PREFIX xsd:     <http://www.w3.org/2001/XMLSchema#>
PREFIX nfl:     <urn:nfl:>
PREFIX team:    <urn:nfl:team:>
PREFIX game:    <urn:nfl:game:>
PREFIX outcome: <urn:nfl:outcome:>
PREFIX playoff: <urn:nfl:playoff:>
PREFIX impact:  <urn:nfl:impact:>
PREFIX rec:     <urn:nfl:recommendation:>
PREFIX user:    <urn:nfl:user:>
PREFIX graph:   <urn:nfl:graph:>
"""

# ─────────────────────────────────────────────────────────────────────────────
# 1. Team Queries
# ─────────────────────────────────────────────────────────────────────────────

ALL_TEAMS = PREFIXES + """
SELECT ?team ?name ?wins ?losses ?winPct ?division ?conference
WHERE {
    GRAPH ?g {
        ?team a nfl:Team ;
              nfl:name ?name .
        OPTIONAL { ?team nfl:wins ?wins }
        OPTIONAL { ?team nfl:losses ?losses }
        OPTIONAL { ?team nfl:winPct ?winPct }
        OPTIONAL { ?team nfl:division ?division }
        OPTIONAL { ?team nfl:conference ?conference }
    }
}
ORDER BY ?conference ?division DESC(?winPct)
"""

TEAM_DETAIL = PREFIXES + """
SELECT ?predicate ?value
WHERE {
    GRAPH ?g {
        ?team ?predicate ?value .
        FILTER(?team = <{team_iri}>)
    }
}
"""

DIVISION_STANDINGS = PREFIXES + """
SELECT ?team ?name ?wins ?losses ?ties ?winPct ?gamesBack
WHERE {
    GRAPH graph:standings {
        ?team a nfl:Team ;
              nfl:division <{division_iri}> ;
              nfl:name ?name ;
              nfl:wins ?wins ;
              nfl:losses ?losses .
        OPTIONAL { ?team nfl:ties ?ties }
        OPTIONAL { ?team nfl:winPct ?winPct }
    }
    OPTIONAL {
        GRAPH graph:competition {
            ?team nfl:gamesBack ?gamesBack .
        }
    }
}
ORDER BY DESC(?winPct)
"""

CURRENT_PLAYOFF_SEEDS = PREFIXES + """
SELECT ?team ?name ?spot ?seed ?conference
WHERE {
    GRAPH graph:standings {
        ?team a nfl:Team ;
              nfl:name ?name ;
              nfl:currentlyHolds ?spot .
        OPTIONAL { ?spot nfl:seed ?seed }
        OPTIONAL { ?spot nfl:conference ?conference }
    }
}
ORDER BY ?conference ?seed
"""

# ─────────────────────────────────────────────────────────────────────────────
# 2. Game Queries
# ─────────────────────────────────────────────────────────────────────────────

ALL_GAMES_THIS_WEEK = PREFIXES + """
SELECT ?game ?homeName ?awayName ?homeScore ?awayScore ?status ?startTime ?venue
WHERE {
    GRAPH ?g {
        ?game a nfl:Game ;
              nfl:homeTeam ?home ;
              nfl:awayTeam ?away ;
              nfl:status ?status .
        OPTIONAL { ?game nfl:homeScore ?homeScore }
        OPTIONAL { ?game nfl:awayScore ?awayScore }
        OPTIONAL { ?game nfl:startTime ?startTime }
        OPTIONAL { ?game nfl:venue ?venue }
    }
    GRAPH ?th { ?home nfl:name ?homeName }
    GRAPH ?ta { ?away nfl:name ?awayName }
}
ORDER BY ?startTime
"""

COMPLETED_GAMES = PREFIXES + """
SELECT ?game ?homeName ?awayName ?homeScore ?awayScore ?winnerName
WHERE {
    GRAPH ?g {
        ?game a nfl:Game ;
              nfl:status "post" ;
              nfl:homeTeam ?home ;
              nfl:awayTeam ?away ;
              nfl:winner ?winner .
        OPTIONAL { ?game nfl:homeScore ?homeScore }
        OPTIONAL { ?game nfl:awayScore ?awayScore }
    }
    GRAPH ?th { ?home  nfl:name ?homeName }
    GRAPH ?ta { ?away  nfl:name ?awayName }
    GRAPH ?tw { ?winner nfl:name ?winnerName }
}
ORDER BY ?game
"""

UPCOMING_GAMES = PREFIXES + """
SELECT ?game ?homeName ?awayName ?startTime ?venue
WHERE {
    GRAPH ?g {
        ?game a nfl:Game ;
              nfl:status "pre" ;
              nfl:homeTeam ?home ;
              nfl:awayTeam ?away .
        OPTIONAL { ?game nfl:startTime ?startTime }
        OPTIONAL { ?game nfl:venue ?venue }
    }
    GRAPH ?th { ?home nfl:name ?homeName }
    GRAPH ?ta { ?away nfl:name ?awayName }
}
ORDER BY ?startTime
"""

TEAM_SCHEDULE = PREFIXES + """
SELECT ?game ?opponent ?opponentName ?homeAway ?score ?opponentScore ?status
WHERE {
    GRAPH ?g {
        ?game a nfl:Game .
        {
            ?game nfl:homeTeam <{team_iri}> ;
                  nfl:awayTeam ?opponent .
            BIND("home" AS ?homeAway)
            OPTIONAL { ?game nfl:homeScore ?score }
            OPTIONAL { ?game nfl:awayScore ?opponentScore }
        } UNION {
            ?game nfl:awayTeam <{team_iri}> ;
                  nfl:homeTeam ?opponent .
            BIND("away" AS ?homeAway)
            OPTIONAL { ?game nfl:awayScore ?score }
            OPTIONAL { ?game nfl:homeScore ?opponentScore }
        }
        OPTIONAL { ?game nfl:status ?status }
    }
    GRAPH ?to { ?opponent nfl:name ?opponentName }
}
ORDER BY ?game
"""

# ─────────────────────────────────────────────────────────────────────────────
# 3. Impact Queries
# ─────────────────────────────────────────────────────────────────────────────

GAMES_HELPING_TEAM = PREFIXES + """
SELECT ?outcome ?winnerName ?impactScore
WHERE {
    GRAPH graph:outcomes {
        ?outcome a nfl:Outcome ;
                 impact:improvesOdds <{team_iri}> ;
                 nfl:winner ?winner .
        OPTIONAL { ?outcome impact:score ?impactScore }
    }
    GRAPH ?tw { ?winner nfl:name ?winnerName }
}
ORDER BY DESC(?impactScore)
"""

GAMES_HURTING_TEAM = PREFIXES + """
SELECT ?outcome ?loserName ?impactScore
WHERE {
    GRAPH graph:outcomes {
        ?outcome a nfl:Outcome ;
                 impact:reducesOdds <{team_iri}> ;
                 nfl:loser ?loser .
        OPTIONAL { ?outcome impact:score ?impactScore }
    }
    GRAPH ?tl { ?loser nfl:name ?loserName }
}
ORDER BY DESC(?impactScore)
"""

ALL_IMPACT_EDGES = PREFIXES + """
SELECT ?outcome ?impactType ?team ?teamName ?score
WHERE {
    GRAPH graph:outcomes {
        ?outcome ?impactType ?team .
        OPTIONAL { ?outcome impact:score ?score }
        FILTER(?impactType IN (impact:improvesOdds, impact:reducesOdds))
    }
    GRAPH ?t { ?team nfl:name ?teamName }
}
ORDER BY ?team DESC(?score)
"""

# ─────────────────────────────────────────────────────────────────────────────
# 4. Competition Queries
# ─────────────────────────────────────────────────────────────────────────────

DIVISIONAL_RIVALS = PREFIXES + """
SELECT ?team ?teamName ?rival ?rivalName
WHERE {
    GRAPH graph:competition {
        ?team nfl:divisionalRival ?rival .
    }
    GRAPH ?tt { ?team  nfl:name ?teamName }
    GRAPH ?tr { ?rival nfl:name ?rivalName }
}
ORDER BY ?teamName
"""

CONFERENCE_COMPETITORS = PREFIXES + """
SELECT ?teamA ?nameA ?teamB ?nameB
WHERE {
    GRAPH graph:competition {
        ?teamA nfl:competesWith ?teamB .
    }
    GRAPH ?ta { ?teamA nfl:name ?nameA }
    GRAPH ?tb { ?teamB nfl:name ?nameB }
    FILTER(STR(?teamA) < STR(?teamB))
}
ORDER BY ?nameA
"""

DIVISION_LEADERS = PREFIXES + """
SELECT ?division ?leader ?leaderName ?wins ?losses
WHERE {
    GRAPH graph:competition {
        ?division nfl:divisionLeader ?leader .
    }
    GRAPH ?tg { ?leader nfl:name ?leaderName }
    GRAPH graph:standings {
        ?leader nfl:wins ?wins ;
                nfl:losses ?losses .
    }
}
ORDER BY ?division
"""

INDIRECT_THREAT_CHAIN = PREFIXES + """
SELECT ?competitor ?competitorName ?spot ?spotName
WHERE {
    GRAPH graph:competition {
        <{team_iri}> nfl:competesWith ?competitor .
    }
    GRAPH graph:standings {
        ?competitor nfl:currentlyHolds ?spot .
    }
    OPTIONAL {
        GRAPH ?tg { ?competitor nfl:name ?competitorName }
    }
    OPTIONAL { ?spot nfl:name ?spotName }
}
"""

# ─────────────────────────────────────────────────────────────────────────────
# 5. Holarchy / Registry Queries
# ─────────────────────────────────────────────────────────────────────────────

LIST_ALL_HOLONS = PREFIXES + """
SELECT ?holon ?type ?interiorGraph
WHERE {
    GRAPH graph:holarchy {
        ?holon rdf:type ?type .
        OPTIONAL { ?holon nfl:hasInteriorGraph ?interiorGraph }
    }
}
ORDER BY ?type ?holon
"""

HOLARCHY_TOPOLOGY = PREFIXES + """
SELECT ?game ?homeName ?awayName ?week ?season ?status
WHERE {
    GRAPH graph:holarchy {
        ?game rdf:type nfl:Game .
    }
    GRAPH ?g {
        ?game nfl:homeTeam ?home ;
              nfl:awayTeam ?away .
        OPTIONAL { ?game nfl:week ?week }
        OPTIONAL { ?game nfl:season ?season }
        OPTIONAL { ?game nfl:status ?status }
    }
    GRAPH ?th { ?home nfl:name ?homeName }
    GRAPH ?ta { ?away nfl:name ?awayName }
}
ORDER BY ?season ?week
"""

# ─────────────────────────────────────────────────────────────────────────────
# 6. Scenario Queries
# ─────────────────────────────────────────────────────────────────────────────

ALL_ACTIVE_SCENARIOS = PREFIXES + """
PREFIX scenario: <urn:nfl:scenario:>

SELECT ?scenario ?label ?type ?beneficiary ?beneficiaryName ?remaining
WHERE {
    GRAPH graph:scenarios {
        ?scenario a playoff:Scenario ;
                  nfl:name ?label ;
                  nfl:scenarioType ?type ;
                  playoff:beneficiary ?beneficiary ;
                  nfl:isActive "true"^^xsd:boolean ;
                  nfl:remainingGames ?remaining .
    }
    GRAPH ?tb { ?beneficiary nfl:name ?beneficiaryName }
}
ORDER BY ?beneficiaryName ?type
"""

SCENARIOS_FOR_TEAM = PREFIXES + """
PREFIX scenario: <urn:nfl:scenario:>

SELECT ?scenario ?label ?type ?remaining ?isActive
WHERE {
    GRAPH graph:scenarios {
        ?scenario a playoff:Scenario ;
                  nfl:name ?label ;
                  nfl:scenarioType ?type ;
                  nfl:remainingGames ?remaining ;
                  nfl:isActive ?isActive ;
                  playoff:beneficiary <{team_iri}> .
    }
}
ORDER BY ?type
"""

SCENARIO_REQUIREMENTS = PREFIXES + """
PREFIX scenario: <urn:nfl:scenario:>

SELECT ?scenario ?label ?requiresWin ?requiresWinName ?requiresLoss ?requiresLossName
WHERE {
    GRAPH graph:scenarios {
        ?scenario a playoff:Scenario ;
                  nfl:name ?label ;
                  playoff:beneficiary <{team_iri}> .
        OPTIONAL {
            ?scenario playoff:requires ?req1 .
            ?req1 nfl:requiresWinFrom ?requiresWin .
        }
        OPTIONAL {
            ?scenario playoff:requires ?req2 .
            ?req2 nfl:requiresLossFrom ?requiresLoss .
        }
    }
    OPTIONAL { GRAPH ?tw { ?requiresWin  nfl:name ?requiresWinName  } }
    OPTIONAL { GRAPH ?tl { ?requiresLoss nfl:name ?requiresLossName } }
}
ORDER BY ?label
"""

DESTINY_CONTROL_GAMES = PREFIXES + """
SELECT ?game ?homeName ?awayName ?controlsFor ?controlsForName
WHERE {
    GRAPH graph:outcomes {
        ?outcome impact:controlsDestiny ?controlsFor .
        ?outcome nfl:forGame ?game .
    }
    GRAPH ?g {
        ?game nfl:homeTeam ?home ;
              nfl:awayTeam ?away ;
              nfl:status ?status .
        FILTER(?status IN ("pre", "in"))
    }
    GRAPH ?th { ?home nfl:name ?homeName }
    GRAPH ?ta { ?away nfl:name ?awayName }
    GRAPH ?tc { ?controlsFor nfl:name ?controlsForName }
}
ORDER BY ?controlsForName
"""

CLINCH_SCENARIOS_BY_CONFERENCE = PREFIXES + """
PREFIX scenario: <urn:nfl:scenario:>

SELECT ?conference ?beneficiaryName ?type ?remaining
WHERE {
    GRAPH graph:scenarios {
        ?scenario a playoff:Scenario ;
                  nfl:scenarioType ?type ;
                  playoff:beneficiary ?beneficiary ;
                  nfl:isActive "true"^^xsd:boolean ;
                  nfl:remainingGames ?remaining .
        FILTER(?type IN ("clinch_division", "clinch_wildcard"))
    }
    GRAPH ?tb {
        ?beneficiary nfl:name ?beneficiaryName ;
                     nfl:conference ?conf .
    }
    BIND(STRAFTER(STR(?conf), "urn:nfl:") AS ?conference)
}
ORDER BY ?conference ?remaining ?beneficiaryName
"""

# ─────────────────────────────────────────────────────────────────────────────
# 7. Season / Temporal Queries
# ─────────────────────────────────────────────────────────────────────────────

TEAM_FULL_SCHEDULE = PREFIXES + """
SELECT ?game ?week ?opponent ?opponentName ?homeAway ?score ?opponentScore ?status
WHERE {
    GRAPH ?g {
        ?game a nfl:Game ;
              nfl:week ?week .
        {
            ?game nfl:homeTeam <{team_iri}> ;
                  nfl:awayTeam ?opponent .
            BIND("home" AS ?homeAway)
            OPTIONAL { ?game nfl:homeScore ?score }
            OPTIONAL { ?game nfl:awayScore ?opponentScore }
        } UNION {
            ?game nfl:awayTeam <{team_iri}> ;
                  nfl:homeTeam ?opponent .
            BIND("away" AS ?homeAway)
            OPTIONAL { ?game nfl:awayScore ?score }
            OPTIONAL { ?game nfl:homeScore ?opponentScore }
        }
        OPTIONAL { ?game nfl:status ?status }
    }
    GRAPH ?to { ?opponent nfl:name ?opponentName }
}
ORDER BY ?week
"""

SEASON_RECORD_BY_WEEK = PREFIXES + """
SELECT ?week (COUNT(?win) AS ?wins) (COUNT(?loss) AS ?losses)
WHERE {
    GRAPH ?g {
        ?game a nfl:Game ;
              nfl:week ?week ;
              nfl:status "post" .
        {
            ?game nfl:winner <{team_iri}> .
            BIND(?game AS ?win)
        } UNION {
            ?game nfl:loser <{team_iri}> .
            BIND(?game AS ?loss)
        }
    }
}
GROUP BY ?week
ORDER BY ?week
"""

TEMPORAL_CHAIN = PREFIXES + """
SELECT ?game ?nextGame ?week ?nextWeek
WHERE {
    GRAPH graph:holarchy {
        ?game nfl:nextGame ?nextGame .
        FILTER(
            EXISTS { GRAPH ?g1 { ?game nfl:homeTeam <{team_iri}> } } ||
            EXISTS { GRAPH ?g2 { ?game nfl:awayTeam <{team_iri}> } }
        )
    }
    GRAPH ?g3 { ?game     nfl:week ?week }
    GRAPH ?g4 { ?nextGame nfl:week ?nextWeek }
}
ORDER BY ?week
"""

GAMES_BY_WEEK = PREFIXES + """
SELECT ?week (COUNT(?game) AS ?gameCount) (COUNT(?complete) AS ?completed)
WHERE {
    GRAPH ?g {
        ?game a nfl:Game ;
              nfl:week ?week .
        OPTIONAL {
            ?game nfl:status "post" .
            BIND(?game AS ?complete)
        }
    }
}
GROUP BY ?week
ORDER BY ?week
"""

WEEK_SEQUENCE = PREFIXES + """
SELECT ?thisWeekGraph ?nextWeekGraph
WHERE {
    GRAPH graph:holarchy {
        ?thisWeekGraph nfl:nextGame ?nextWeekGraph .
        FILTER(STRSTARTS(STR(?thisWeekGraph), "urn:nfl:graph:games:"))
    }
}
ORDER BY ?thisWeekGraph
"""

# ─────────────────────────────────────────────────────────────────────────────
# Execution helpers
# ─────────────────────────────────────────────────────────────────────────────

def run_query(
    dataset: Dataset,
    query_str: str,
    bindings: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """
    Execute a SPARQL SELECT query on the dataset.

    Parameters
    ----------
    dataset  : rdflib Dataset
    query_str: SPARQL SELECT string (use {placeholder} for IRI substitution)
    bindings : dict of str placeholder → IRI string (substituted before parse)

    Returns
    -------
    List of row dicts  {var_name: value}
    """
    q = query_str
    if bindings:
        for key, val in bindings.items():
            q = q.replace(f"{{{key}}}", val)

    rows = []
    for row in dataset.query(q):
        rows.append({str(var): str(val) if val is not None else None
                     for var, val in zip(row.labels, row)})
    return rows


def print_results(rows: list[dict], title: str = "") -> None:
    """Pretty-print query results to stdout."""
    if title:
        print(f"\n{'='*60}")
        print(f"  {title}")
        print(f"{'='*60}")
    if not rows:
        print("  (no results)")
        return
    headers = list(rows[0].keys())
    col_w   = {h: max(len(h), max((len(str(r[h] or "")) for r in rows), default=0))
               for h in headers}
    header_line = "  " + "  ".join(h.ljust(col_w[h]) for h in headers)
    print(header_line)
    print("  " + "-" * (sum(col_w.values()) + 2 * len(headers)))
    for row in rows:
        print("  " + "  ".join(str(row.get(h, "") or "").ljust(col_w[h]) for h in headers))
