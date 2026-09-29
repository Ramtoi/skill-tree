"""Tests for the hub harness CLI commands (task 6.5)."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import pytest
import yaml


def _seed_registry(data_home: Path, projects: dict | None = None, global_: list | None = None):
    reg = {
        "version": "1",
        "harnesses_global": global_ or [],
        "skills": {},
        "projects": projects or {},
        "bundles": {},
    }
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))


def _table_line(out: str, harness_id: str) -> str:
    """The `hub harness list` text-table row for one harness, ANSI stripped."""
    plain = re.sub(r"\x1b\[[0-9;]*m", "", out)
    for line in plain.splitlines():
        if line.startswith(harness_id):
            return line
    raise AssertionError(f"no {harness_id} row in:\n{plain}")


def test_harness_list_json_shape(tmp_data_home, capsys):
    import hub

    _seed_registry(
        tmp_data_home,
        projects={"alpha": {"path": "/a", "enabled": [], "bundles": [], "harnesses": ["pi"]}},
        global_=["claude-code"],
    )
    hub.cmd_harness_list(argparse.Namespace(json=True))
    out = capsys.readouterr().out
    payload = json.loads(out)
    by_id = {row["id"]: row for row in payload}

    assert set(by_id.keys()) == {"claude-code", "codex", "pi", "opencode"}
    assert by_id["claude-code"]["on_globally"] is True
    assert by_id["codex"]["on_globally"] is False
    assert by_id["pi"]["used_by_projects"] == ["alpha"]
    for row in payload:
        assert isinstance(row["installed"], bool)


def test_harness_list_effective_projects_global_vs_pinned(tmp_data_home, capsys):
    """A harness on the global switch reaches every registered project
    (`effective_projects`), even one that never names it in
    `projects.<n>.harnesses`. A non-global harness only reaches its pinned
    ones. `used_by_projects` keeps reporting the pinned set either way."""
    import hub

    _seed_registry(
        tmp_data_home,
        projects={
            "alpha": {"path": "/a", "enabled": [], "bundles": [], "harnesses": ["pi"]},
            "beta": {"path": "/b", "enabled": [], "bundles": []},
            "gamma": {"path": "/g", "enabled": [], "bundles": []},
        },
        global_=["claude-code"],
    )
    hub.cmd_harness_list(argparse.Namespace(json=True))
    out = capsys.readouterr().out
    payload = json.loads(out)
    by_id = {row["id"]: row for row in payload}

    # claude-code: on the global switch, no project pins it explicitly.
    assert by_id["claude-code"]["on_globally"] is True
    assert by_id["claude-code"]["used_by_projects"] == []
    assert by_id["claude-code"]["effective_projects"] == ["alpha", "beta", "gamma"]

    # pi: not global, only reaches the project that pins it.
    assert by_id["pi"]["on_globally"] is False
    assert by_id["pi"]["used_by_projects"] == ["alpha"]
    assert by_id["pi"]["effective_projects"] == ["alpha"]


def test_harness_list_effective_projects_with_no_projects_at_all(tmp_data_home, capsys):
    """No registered project means a globally-on harness reaches NOTHING.
    `effective_projects` must be empty and the text table must not print the
    "all (global)" claim over a set of zero."""
    import hub

    _seed_registry(tmp_data_home, projects={}, global_=["claude-code"])
    hub.cmd_harness_list(argparse.Namespace(json=True))
    payload = json.loads(capsys.readouterr().out)
    by_id = {row["id"]: row for row in payload}
    assert by_id["claude-code"]["on_globally"] is True
    assert by_id["claude-code"]["effective_projects"] == []
    assert by_id["claude-code"]["used_by_projects"] == []

    hub.cmd_harness_list(argparse.Namespace(json=False))
    line = _table_line(capsys.readouterr().out, "claude-code")
    assert "all (global)" not in line, line
    assert "(none)" in line, line


def test_harness_list_ignores_an_unknown_harness_id_pinned_by_a_project(
    tmp_data_home, capsys
):
    """A hand-edited `projects.<n>.harnesses` can name an id no harness
    declares. It must stay inert: no row of its own, and no leakage into any
    real harness's pinned or effective set."""
    import hub

    _seed_registry(
        tmp_data_home,
        projects={
            "alpha": {
                "path": "/a",
                "enabled": [],
                "bundles": [],
                "harnesses": ["not-a-harness", "pi"],
            },
        },
        global_=[],
    )
    hub.cmd_harness_list(argparse.Namespace(json=True))
    payload = json.loads(capsys.readouterr().out)
    by_id = {row["id"]: row for row in payload}

    assert "not-a-harness" not in by_id
    assert by_id["pi"]["effective_projects"] == ["alpha"]
    for h_id in ("claude-code", "codex", "opencode"):
        assert by_id[h_id]["used_by_projects"] == []
        assert by_id[h_id]["effective_projects"] == []


def test_harness_list_effective_projects_ignores_a_projects_own_harness_list(
    tmp_data_home, capsys
):
    """A project with no `harnesses:` key at all (or an empty one) is still
    reached by a globally-on harness — that is the whole point of the global
    switch. Sorting matches the frontend's `Object.keys().sort()`."""
    import hub

    _seed_registry(
        tmp_data_home,
        projects={
            "zulu": {"path": "/z", "enabled": [], "bundles": []},
            "Beta": {"path": "/B", "enabled": [], "bundles": [], "harnesses": []},
            "alpha": {"path": "/a", "enabled": [], "bundles": [], "harnesses": None},
        },
        global_=["claude-code"],
    )
    hub.cmd_harness_list(argparse.Namespace(json=True))
    payload = json.loads(capsys.readouterr().out)
    by_id = {row["id"]: row for row in payload}

    # Uppercase sorts before lowercase in BOTH Python's `sorted()` and JS's
    # default `Array.sort()` (code-unit order), so the two surfaces agree.
    assert by_id["claude-code"]["effective_projects"] == ["Beta", "alpha", "zulu"]
    assert by_id["claude-code"]["used_by_projects"] == []


def test_harness_list_text_table_used_by_wording(tmp_data_home, capsys):
    """The USED BY column: `all (global)` (+ the pinned tail) for a globally-on
    harness, the plain pinned list for a pinned one, `(none)` for neither."""
    import hub

    _seed_registry(
        tmp_data_home,
        projects={
            "alpha": {
                "path": "/a",
                "enabled": [],
                "bundles": [],
                "harnesses": ["claude-code", "pi"],
            },
            "beta": {"path": "/b", "enabled": [], "bundles": [], "harnesses": ["pi"]},
        },
        global_=["claude-code"],
    )
    hub.cmd_harness_list(argparse.Namespace(json=False))
    out = capsys.readouterr().out

    claude = _table_line(out, "claude-code")
    assert "all (global)" in claude, claude
    assert "pinned: alpha" in claude, claude

    pi = _table_line(out, "pi")
    assert "all (global)" not in pi, pi
    assert "alpha, beta" in pi, pi

    codex = _table_line(out, "codex")
    assert "(none)" in codex, codex


def test_harness_list_probe_includes_hook_capability(tmp_data_home, capsys, monkeypatch):
    """harness-capability-probe spec: 'On-demand probe via harness list' —
    `hub harness list --probe` must include each harness's hook-capability
    verdict/reason."""
    import hub
    from skill_hub.application.harnesses import harness_operation_context
    from skill_hub.infrastructure.harnesses import harness_probe
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    _seed_registry(tmp_data_home, global_=["claude-code"])
    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code", "codex"})
    from dataclasses import replace

    context = harness_operation_context.build_operation_context(
        tmp_data_home, harness_operation_context.KNOWN_HARNESSES,
        requested_features=("hooks", "invocation", "agent_docs", "subagents"),
        installed_harness_ids=("claude-code", "codex"),
    )
    context = replace(context, hook_observations={
        "claude-code": harness_probe.HookCapability(
            "claude-code", harness_probe.SUPPORTED, "installed").to_dict(),
        "codex": harness_probe.HookCapability(
            "codex", harness_probe.FEATURE_OFF, "hooks disabled in config.toml").to_dict(),
    })
    context_calls = []

    def context_factory(*args, **kwargs):
        context_calls.append(kwargs)
        return context

    monkeypatch.setattr(harness_operation_context, "build_operation_context", context_factory)

    hub.cmd_harness_list(argparse.Namespace(json=True, probe=True))
    out = capsys.readouterr().out
    payload = json.loads(out)
    by_id = {row["id"]: row for row in payload}

    assert by_id["claude-code"]["hook_capability"]["verdict"] == "supported"
    assert by_id["codex"]["hook_capability"]["verdict"] == "feature_off"
    assert "disabled" in by_id["codex"]["hook_capability"]["reason"]
    # A harness the probe didn't return anything for reports None, not a crash.
    assert by_id["pi"]["hook_capability"] is None

    # Without --probe, no hook_capability key is added at all.
    hub.cmd_harness_list(argparse.Namespace(json=True, probe=False))
    payload2 = json.loads(capsys.readouterr().out)
    assert "hook_capability" not in payload2[0]
    assert context_calls[0]["needs_selection"] is True
    assert context_calls[0]["force_refresh"] is True
    assert context_calls[1]["needs_selection"] is False
    assert context_calls[1]["force_refresh"] is False


def test_harness_enable_adds_to_global(tmp_data_home, capsys):
    import hub

    _seed_registry(tmp_data_home, global_=["claude-code"])
    hub.cmd_harness_enable(argparse.Namespace(id="codex"))
    capsys.readouterr()

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert set(reg["harnesses_global"]) == {"claude-code", "codex"}


def test_harness_disable_removes_from_global(tmp_data_home, capsys):
    import hub

    _seed_registry(tmp_data_home, global_=["claude-code", "codex"])
    hub.cmd_harness_disable(argparse.Namespace(id="claude-code"))
    capsys.readouterr()

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert reg["harnesses_global"] == ["codex"]


def test_harness_enable_rejects_unknown_id(tmp_data_home, capsys):
    import hub

    _seed_registry(tmp_data_home, global_=[])
    with pytest.raises(SystemExit):
        hub.cmd_harness_enable(argparse.Namespace(id="aider"))
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert reg["harnesses_global"] == []


def test_harness_enable_warns_when_not_installed(tmp_data_home, capsys, monkeypatch):
    import dataclasses

    import hub
    from skill_hub.infrastructure.harnesses import harnesses

    patched = dict(harnesses.HARNESSES)
    patched["codex"] = dataclasses.replace(patched["codex"], detect=(lambda: False))
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    _seed_registry(tmp_data_home, global_=[])
    hub.cmd_harness_enable(argparse.Namespace(id="codex"))
    captured = capsys.readouterr()
    assert "not installed on this machine" in captured.err
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert "codex" in reg["harnesses_global"]


def test_project_harnesses_show_per_source_breakdown(tmp_data_home, capsys):
    import hub

    _seed_registry(
        tmp_data_home,
        projects={"alpha": {"path": "/a", "enabled": [], "bundles": [], "harnesses": ["pi"]}},
        global_=["claude-code"],
    )
    hub.cmd_project_harnesses(
        argparse.Namespace(name="alpha", add=None, remove=None)
    )
    out = capsys.readouterr().out
    assert "global" in out and "claude-code" in out
    assert "project" in out and "pi" in out
    assert "effective" in out


def test_project_harnesses_add_remove(tmp_data_home, capsys):
    import hub

    _seed_registry(
        tmp_data_home,
        projects={"alpha": {"path": "/a", "enabled": [], "bundles": [], "harnesses": []}},
        global_=[],
    )

    hub.cmd_project_harnesses(
        argparse.Namespace(name="alpha", add="codex,pi", remove=None)
    )
    capsys.readouterr()
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert set(reg["projects"]["alpha"]["harnesses"]) == {"codex", "pi"}

    hub.cmd_project_harnesses(
        argparse.Namespace(name="alpha", add=None, remove="codex")
    )
    capsys.readouterr()
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert reg["projects"]["alpha"]["harnesses"] == ["pi"]


def test_project_harnesses_unknown_id_warns_but_accepts(tmp_data_home, capsys):
    import hub

    _seed_registry(
        tmp_data_home,
        projects={"alpha": {"path": "/a", "enabled": [], "bundles": [], "harnesses": []}},
        global_=[],
    )
    hub.cmd_project_harnesses(
        argparse.Namespace(name="alpha", add="aider", remove=None)
    )
    captured = capsys.readouterr()
    assert "unknown harness id 'aider'" in captured.err
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert "aider" in reg["projects"]["alpha"]["harnesses"]


def test_harness_list_json_serializes_frozen_observations(tmp_data_home, monkeypatch, capsys):
    import sys

    import hub
    from skill_hub.infrastructure.harnesses import harness_probe

    _seed_registry(tmp_data_home)
    monkeypatch.setattr(harness_probe, "load_cached", lambda *args: {
        "invocation": {"opencode": {"profile": "unknown", "details": {"reason": ["fixture"]}}}
    })
    monkeypatch.setattr(sys, "argv", ["hub", "harness", "list", "--json"])
    hub.main()
    rows = json.loads(capsys.readouterr().out)
    row = next(item for item in rows if item["id"] == "opencode")
    assert row["invocation_capability"]["details"] == {"reason": ["fixture"]}
