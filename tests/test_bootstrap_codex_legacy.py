"""Tests for bootstrap importer's Codex/Agents dual-source handling (task 10.4)."""

from __future__ import annotations

from pathlib import Path

import pytest


def _write_skill(target: Path, name: str, body: str = "test") -> Path:
    target.mkdir(parents=True, exist_ok=True)
    (target / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: |\n  {body}\n---\n"
    )
    return target


@pytest.fixture
def codex_scan_env(tmp_data_home, monkeypatch):
    """Plant claude/agents/legacy-codex/pi scan roots inside the tmp data home."""
    import hub

    roots = {}
    for origin in ("claude", "agents", "legacy-codex", "pi"):
        roots[origin] = tmp_data_home / f"fake-{origin}"
        roots[origin].mkdir(parents=True)
    monkeypatch.setattr(
        hub,
        "IMPORT_SCAN_ROOTS",
        [
            ("claude", roots["claude"]),
            ("agents", roots["agents"]),
            ("legacy-codex", roots["legacy-codex"]),
            ("pi", roots["pi"]),
        ],
    )
    return roots


def test_skill_in_both_agents_and_legacy_codex_yields_single_candidate(codex_scan_env):
    """A skill `s` present in both ~/.agents/skills/ and ~/.codex/skills/
    surfaces exactly one candidate; the kept one references the agents source."""
    import hub

    _write_skill(codex_scan_env["agents"] / "shared-skill", "shared-skill", "from-agents")
    _write_skill(codex_scan_env["legacy-codex"] / "shared-skill", "shared-skill", "from-codex")

    candidates = hub.scan_import_candidates({"skills": {}})
    shared = [c for c in candidates if c.get("name") == "shared-skill"]
    assert len(shared) == 1
    assert shared[0]["origin"] == "agents"


def test_skill_only_in_legacy_codex_keeps_legacy_origin(codex_scan_env):
    """A skill only present in ~/.codex/skills/ is offered with origin=legacy-codex."""
    import hub

    _write_skill(codex_scan_env["legacy-codex"] / "old-only", "old-only")

    candidates = hub.scan_import_candidates({"skills": {}})
    found = [c for c in candidates if c.get("name") == "old-only"]
    assert len(found) == 1
    assert found[0]["origin"] == "legacy-codex"


def test_skill_in_claude_and_agents_preserves_first_seen(codex_scan_env):
    """Iteration order: claude precedes agents → claude origin wins on dedupe."""
    import hub

    _write_skill(codex_scan_env["claude"] / "ubiquitous", "ubiquitous", "claude-version")
    _write_skill(codex_scan_env["agents"] / "ubiquitous", "ubiquitous", "agents-version")

    candidates = hub.scan_import_candidates({"skills": {}})
    found = [c for c in candidates if c.get("name") == "ubiquitous"]
    assert len(found) == 1
    assert found[0]["origin"] == "claude"
