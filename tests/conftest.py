"""Shared pytest fixtures for hub.py tests.

The hub module caches `data_home()` in a module-global. Tests that mutate
env vars MUST reset `hub._DATA_HOME_CACHE = None` before calling the resolver,
which is what `tmp_data_home` does for you.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Ensure repo root is importable.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


@pytest.fixture
def tmp_data_home(tmp_path, monkeypatch):
    """Isolated data home per test.

    Sets `SKILL_HUB_HOME` to a tmp dir, unsets `SKILL_HUB_DIR` and
    `SKILL_HUB_CODE`, and resets `hub._DATA_HOME_CACHE` so the next
    `data_home()` resolves to the tmp path.
    """
    import hub

    monkeypatch.setenv("SKILL_HUB_HOME", str(tmp_path))
    monkeypatch.delenv("SKILL_HUB_DIR", raising=False)
    monkeypatch.delenv("SKILL_HUB_CODE", raising=False)
    hub._DATA_HOME_CACHE = None
    # Also reset the one-shot warning state so per-test ordering doesn't matter.
    hub._DEPRECATION_WARNED = False
    hub._LEGACY_FALLBACK_WARNED = False
    yield tmp_path
    hub._DATA_HOME_CACHE = None


@pytest.fixture
def clean_env(monkeypatch):
    """Unset all SKILL_HUB_* env vars + reset cache for the test."""
    import hub

    monkeypatch.delenv("SKILL_HUB_HOME", raising=False)
    monkeypatch.delenv("SKILL_HUB_DIR", raising=False)
    monkeypatch.delenv("SKILL_HUB_CODE", raising=False)
    hub._DATA_HOME_CACHE = None
    hub._DEPRECATION_WARNED = False
    hub._LEGACY_FALLBACK_WARNED = False
    yield
    hub._DATA_HOME_CACHE = None


def write_skill_md(target: Path, name: str, description: str = "test skill") -> Path:
    """Helper: write a minimal SKILL.md and return its parent dir."""
    target.mkdir(parents=True, exist_ok=True)
    (target / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: |\n  {description}\n---\n"
    )
    return target
