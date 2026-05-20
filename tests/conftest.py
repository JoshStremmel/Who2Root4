"""
conftest.py
───────────
Pytest configuration for the Who2Root4 test suite.
Adds builders/ and queries/ to sys.path so all test files
can import project modules without relative import hacks.
"""

import sys
from pathlib import Path

# Make builders/ and queries/ importable from any test file
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "builders"))
sys.path.insert(0, str(ROOT / "queries"))
sys.path.insert(0, str(ROOT / "tests"))
