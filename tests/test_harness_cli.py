"""Tests for the hub harness CLI commands (task 6.5)."""

from __future__ import annotations

import argparse
import json
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

    import harnesses
    import hub

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
