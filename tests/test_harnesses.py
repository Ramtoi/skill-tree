"""Tests for the harness registry + resolution (task 1.8)."""

from __future__ import annotations

import json

import pytest


def test_registry_has_expected_ids():
    import harnesses

    assert set(harnesses.HARNESSES.keys()) == {
        "claude-code",
        "codex",
        "pi",
        "opencode",
    }


def test_opencode_shares_agents_skills_dir_with_codex_and_pi():
    """opencode reads .agents/skills/ natively, so sync dedup collapses
    codex/pi/opencode to one symlink."""
    import harnesses

    assert (
        str(harnesses.HARNESSES["opencode"].project_skills_dir)
        == str(harnesses.HARNESSES["codex"].project_skills_dir)
        == str(harnesses.HARNESSES["pi"].project_skills_dir)
        == ".agents/skills"
    )
    # Global dir is shared with codex (~/.agents/skills) for the same dedup.
    assert (
        str(harnesses.HARNESSES["opencode"].global_skills_dir)
        == str(harnesses.HARNESSES["codex"].global_skills_dir)
        == "~/.agents/skills"
    )


def test_opencode_has_dedicated_adapter_keys_and_agents_root():
    import harnesses

    h = harnesses.HARNESSES["opencode"]
    assert h.mcp_adapter_key == "opencode"
    assert h.permission_adapter_key == "opencode"
    assert h.root_doc == "AGENTS.md"


def test_opencode_adapters_resolve_from_registry_keys():
    import harnesses
    import mcp_adapters
    import permission_adapters as pa

    h = harnesses.HARNESSES["opencode"]
    assert type(mcp_adapters.get_adapter(h.mcp_adapter_key)).__name__ == "OpenCodeMcpAdapter"
    assert type(pa.get_adapter(h.permission_adapter_key)).__name__ == "OpenCodePermissionAdapter"


def test_claude_and_pi_share_mcp_adapter_key():
    """Pi's MCP convention is the shared .mcp.json — adapter key must match claude-code."""
    import harnesses

    assert (
        harnesses.HARNESSES["claude-code"].mcp_adapter_key
        == harnesses.HARNESSES["pi"].mcp_adapter_key
        == "claude"
    )


def test_codex_and_pi_share_project_skills_dir():
    import harnesses

    assert (
        str(harnesses.HARNESSES["codex"].project_skills_dir)
        == str(harnesses.HARNESSES["pi"].project_skills_dir)
        == ".agents/skills"
    )


def test_detect_installed_returns_only_installed_set(monkeypatch):
    """Replace HARNESSES entries with synthetic ones whose detectors we control.

    Harness is a frozen dataclass, so we swap whole entries rather than mutating fields.
    """
    import dataclasses

    import harnesses

    def _swap(harness_id: str, returns: bool) -> harnesses.Harness:
        original = harnesses.HARNESSES[harness_id]
        return dataclasses.replace(original, detect=lambda v=returns: v)

    patched = {
        "claude-code": _swap("claude-code", True),
        "codex": _swap("codex", False),
        "pi": _swap("pi", True),
    }
    monkeypatch.setattr(harnesses, "HARNESSES", patched)
    assert harnesses.detect_installed() == {"claude-code", "pi"}


def test_resolve_effective_additive_global_project_intersect_installed():
    import harnesses

    project = {"harnesses": ["pi"]}
    registry = {"harnesses_global": ["claude-code"]}

    # All installed → both
    assert harnesses.resolve_effective(
        project, registry, installed={"claude-code", "codex", "pi"}
    ) == {"claude-code", "pi"}

    # Pi not installed → falls out
    assert harnesses.resolve_effective(
        project, registry, installed={"claude-code"}
    ) == {"claude-code"}

    # Nothing in effective
    assert harnesses.resolve_effective(project, registry, installed=set()) == set()


def test_resolve_effective_unknown_ids_silently_dropped():
    import harnesses

    project = {"harnesses": ["aider", "pi"]}  # aider not in HARNESSES
    registry = {"harnesses_global": ["claude-code", "future-harness"]}
    result = harnesses.resolve_effective(
        project, registry, installed={"claude-code", "codex", "pi"}
    )
    assert "aider" not in result
    assert "future-harness" not in result
    assert result == {"claude-code", "pi"}


def test_resolve_effective_empty_inputs_yields_empty_set():
    import harnesses

    assert harnesses.resolve_effective({}, {}, installed={"claude-code"}) == set()


def test_emit_schema_is_sorted_by_id():
    import harnesses

    schema = harnesses.emit_schema()
    ids = [e["id"] for e in schema]
    assert ids == sorted(ids)
    assert ids == ["claude-code", "codex", "opencode", "pi"]


def test_emit_schema_includes_required_keys():
    import harnesses

    schema = harnesses.emit_schema()
    for entry in schema:
        for key in (
            "id",
            "label",
            "project_skills_dir",
            "global_skills_dir",
            "mcp_adapter_key",
            "detect",
            "legacy_global_skills_dirs",
        ):
            assert key in entry, f"missing key {key} in entry {entry['id']}"
        assert isinstance(entry["detect"], dict)
        assert "dir" in entry["detect"] and "marker" in entry["detect"]


def test_emit_schema_json_is_stable_across_runs():
    """Golden-file style: two runs produce identical bytes."""
    import harnesses

    a = harnesses.emit_schema_json()
    b = harnesses.emit_schema_json()
    assert a == b
    # And it parses back to the same structure
    assert json.loads(a) == harnesses.emit_schema()


def test_each_harness_declares_global_doc():
    """Every supported harness points at a user-global instruction file."""
    import harnesses

    expected = {
        "claude-code": "~/.claude/CLAUDE.md",
        "codex": "~/.codex/AGENTS.md",
        "pi": "~/.pi/agent/AGENTS.md",
        "opencode": "~/.config/opencode/AGENTS.md",
    }
    for hid, path in expected.items():
        h = harnesses.HARNESSES[hid]
        assert h.global_doc is not None, f"{hid} missing global_doc"
        assert str(h.global_doc) == path


def test_emit_schema_carries_global_doc():
    """The Rust mirror consumes global_doc from emit_schema()."""
    import harnesses

    schema = {e["id"]: e for e in harnesses.emit_schema()}
    for entry in schema.values():
        assert "global_doc" in entry
    assert schema["claude-code"]["global_doc"] == "~/.claude/CLAUDE.md"
    assert schema["codex"]["global_doc"] == "~/.codex/AGENTS.md"
    assert schema["pi"]["global_doc"] == "~/.pi/agent/AGENTS.md"
    assert schema["opencode"]["global_doc"] == "~/.config/opencode/AGENTS.md"


def test_emit_schema_codex_has_legacy_dirs():
    import harnesses

    schema = {e["id"]: e for e in harnesses.emit_schema()}
    assert schema["codex"]["legacy_global_skills_dirs"] == ["~/.codex/skills"]
    assert schema["claude-code"]["legacy_global_skills_dirs"] == []
    assert schema["pi"]["legacy_global_skills_dirs"] == []


def test_dotdir_with_marker_detection_logic(tmp_path, monkeypatch):
    """DotDirWithMarker requires both dir AND marker to exist."""
    import harnesses
    from harnesses import DotDirWithMarker

    fake_dir = tmp_path / "fake-harness"
    detector = DotDirWithMarker(dir=str(fake_dir), marker="config.toml")

    # Neither exists
    assert detector() is False

    # Dir exists, no marker
    fake_dir.mkdir()
    assert detector() is False

    # Marker exists
    (fake_dir / "config.toml").write_text("")
    assert detector() is True


def test_cmd_harnesses_emit_schema_stdout_matches_module(capsys):
    """The hub harnesses emit-schema CLI command emits exactly emit_schema_json()."""
    import argparse

    import harnesses
    import hub

    hub.cmd_harnesses_emit_schema(argparse.Namespace())
    out = capsys.readouterr().out.strip()
    assert out == harnesses.emit_schema_json().strip()
    # And it round-trips through json.loads
    parsed = json.loads(out)
    assert {e["id"] for e in parsed} == {"claude-code", "codex", "pi", "opencode"}
