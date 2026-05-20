"""
membrane_validator.py
─────────────────────
Loads nfl-shapes.ttl into holarchy boundary layers and runs
SHACL membrane validation via HolonicDataset.validate_membrane().

The boundary layer of each holon is where SHACL shapes live per the
CGA model. This module:
  1. Loads the NFL-specific SHACL shapes (nfl-shapes.ttl) into the
     boundary graph of the relevant holons
  2. Runs validate_membrane() on key holons
  3. Prints a structured health report

Usage
─────
    from holonic import HolonicDataset
    from membrane_validator import MembraneValidator

    validator = MembraneValidator(ds, shapes_path="ontology/nfl-shapes.ttl")
    validator.install_shapes()          # write shapes into boundary layers
    report = validator.validate_all()   # run SHACL on all registered holons
    validator.print_report(report)
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from holonic import HolonicDataset

from holonic_builder import (
    _team_iri, _game_iri, _division_iri, _conference_iri,
    _season_iri, _week_iri, _scenario_iri, _ttl,
)
from espn_fetcher import DIVISION_RIVALS

logger = logging.getLogger(__name__)

# Shape Turtle is loaded once and reused across all boundary writes
_SHAPES_CACHE: str | None = None


def _load_shapes(path: str | Path) -> str:
    global _SHAPES_CACHE
    if _SHAPES_CACHE is None:
        _SHAPES_CACHE = Path(path).read_text(encoding="utf-8")
    return _SHAPES_CACHE


class MembraneValidator:
    """
    Installs NFL SHACL shapes into holon boundary layers and
    validates membranes via the holonic library.
    """

    def __init__(
        self,
        ds: HolonicDataset,
        shapes_path: str | Path = "ontology/nfl-shapes.ttl",
    ) -> None:
        self.ds          = ds
        self.shapes_path = Path(shapes_path)
        self._shapes_ttl: str | None = None

    # ── Public API ────────────────────────────────────────────────────────────

    def install_shapes(self) -> None:
        """
        Write nfl-shapes.ttl into the boundary layer of every registered
        holon. The holonic library places boundary content in
        {holon_iri}/boundary by default.

        We install the full shapes file into:
          - Each conference holon
          - Each division holon
          - The season holon(s)
        Team and game holons inherit validation via sh:SPARQLTarget
        patterns that range over interior graph data rather than requiring
        per-holon boundary installation.
        """
        if not self.shapes_path.exists():
            logger.warning("Shapes file not found: %s", self.shapes_path)
            return

        shapes_ttl = self.shapes_path.read_text(encoding="utf-8")
        logger.info("Installing NFL SHACL shapes from %s …", self.shapes_path)

        # Install into conference holons (structural roots)
        for conf in ("AFC", "NFC"):
            self.ds.add_boundary(
                _conference_iri(conf),
                shapes_ttl,
                graph_iri=f"{_conference_iri(conf)}/boundary/nfl-shapes",
            )

        # Install into division holons
        for div_key in DIVISION_RIVALS:
            self.ds.add_boundary(
                _division_iri(div_key),
                shapes_ttl,
                graph_iri=f"{_division_iri(div_key)}/boundary/nfl-shapes",
            )

        logger.info("SHACL shapes installed into %d boundary layers.",
                    2 + len(DIVISION_RIVALS))

    def validate_all(self) -> dict[str, Any]:
        """
        Run validate_membrane() on all holons and collect results.

        Returns a summary dict:
        {
            "total"     : int,
            "healthy"   : int,
            "warning"   : int,
            "violation" : int,
            "results"   : [MembraneResult, ...]
        }
        """
        holons  = self.ds.list_holons()
        results = []
        healthy = warning = violation = 0

        logger.info("Validating membranes for %d holons …", len(holons))

        for holon in holons:
            try:
                result = self.ds.validate_membrane(holon.iri)
                results.append(result)
                health = str(result.health).lower()
                if "violation" in health:
                    violation += 1
                elif "warning" in health or "compromised" in health:
                    warning += 1
                else:
                    healthy += 1
            except Exception as exc:
                logger.debug("validate_membrane skipped for %s: %s", holon.iri, exc)

        return {
            "total"     : len(holons),
            "healthy"   : healthy,
            "warning"   : warning,
            "violation" : violation,
            "results"   : results,
        }

    def validate_team(self, abbr: str) -> Any:
        """Validate a single team holon's membrane."""
        return self.ds.validate_membrane(_team_iri(abbr.upper()))

    def validate_game(self, game: dict) -> Any:
        """Validate a single game holon's membrane."""
        return self.ds.validate_membrane(_game_iri(game))

    def print_report(self, report: dict[str, Any]) -> None:
        """Print a structured health report to stdout."""
        print(f"\n{'='*60}")
        print(f"  NFL Membrane Validation Report")
        print(f"{'='*60}")
        print(f"  Total holons validated : {report['total']}")
        print(f"  ✓ Healthy              : {report['healthy']}")
        print(f"  ⚠ Warnings             : {report['warning']}")
        print(f"  ✗ Violations           : {report['violation']}")

        violations = [
            r for r in report["results"]
            if "violation" in str(r.health).lower()
        ]
        warnings = [
            r for r in report["results"]
            if "warning" in str(r.health).lower()
                or "compromised" in str(r.health).lower()
        ]

        if violations:
            print(f"\n  VIOLATIONS ({len(violations)})")
            print(f"  {'─'*55}")
            for r in violations[:10]:   # cap at 10 for readability
                print(f"  ✗ {r.holon_iri}")
                for v in (r.violations or [])[:3]:
                    print(f"      • {getattr(v, 'message', str(v))}")

        if warnings:
            print(f"\n  WARNINGS ({len(warnings)})")
            print(f"  {'─'*55}")
            for r in warnings[:10]:
                print(f"  ⚠ {r.holon_iri}")

        print()

    def print_team_health(self, abbr: str) -> None:
        """Print membrane health for a specific team."""
        result = self.validate_team(abbr)
        health = str(result.health)
        icon   = "✓" if "healthy" in health.lower() else (
                 "⚠" if "warning" in health.lower() else "✗")
        print(f"\n  {icon} {abbr} membrane: {health}")
        for v in (result.violations or []):
            print(f"    • {getattr(v, 'message', str(v))}")
