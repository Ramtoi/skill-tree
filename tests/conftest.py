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


@pytest.fixture(autouse=True)
def _isolate_global_mcp(monkeypatch):
    """Safety net: NO test may write a real user-global MCP config.

    `Harness.global_mcp_config` points at real absolute paths (~/.claude.json,
    ~/.codex/config.toml) that the `tmp_data_home` fixture does NOT isolate. Any
    test that runs `cmd_sync`'s global-MCP pass against the real `HARNESSES` would
    otherwise write to the user's actual config. We null out `global_mcp_config`
    on every harness by default; tests that exercise global dispatch re-patch
    `HARNESSES` with tmp paths themselves (their setattr runs after this one).
    """
    import dataclasses
    import harnesses

    patched = {
        h_id: dataclasses.replace(h, global_mcp_config=None)
        for h_id, h in harnesses.HARNESSES.items()
    }
    monkeypatch.setattr(harnesses, "HARNESSES", patched)


@pytest.fixture(autouse=True)
def _connectors_discovered():
    """Guarantee builtin/private connectors are registered before each test.

    Connector registration is now lazy (`connectors.discovery.ensure_discovered`,
    triggered on first `get_connector`/registry read) instead of at package
    import. Many suites read `REMOTE_CONNECTORS["hermes"]` (etc.) directly without
    going through `get_connector`; this autouse fixture runs the (memoized)
    discovery once so those direct reads keep working — restoring the exact
    pre-lazy state without changing any test's intent.
    """
    import connectors

    connectors.ensure_discovered()
    yield


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


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "live_codex: live codex CLI gates — opt-in via RUN_LIVE_CODEX=1 (slow, needs auth)")
    config.addinivalue_line(
        "markers",
        "slow: tests that make a real (bounded) network dial — safe but not instant")
