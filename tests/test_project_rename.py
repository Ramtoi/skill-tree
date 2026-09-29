"""`hub project rename`: the registry key moves with its block, the name-keyed
sidecars under state/ follow, and every refusal leaves the registry untouched."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pytest
import yaml


def _write_registry(tmp_data_home: Path, projects: dict) -> None:
    registry = {"version": "1", "skills": {}, "projects": projects, "bundles": {}}
    (tmp_data_home / "registry.yaml").write_text(
        yaml.safe_dump(registry, sort_keys=False)
    )


def _read_projects(tmp_data_home: Path) -> dict:
    return yaml.safe_load((tmp_data_home / "registry.yaml").read_text())["projects"]


def _touch(path: Path, payload: dict | None = None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload or {"marker": path.name}))
    return path


@pytest.fixture
def two_projects(tmp_data_home: Path) -> dict:
    alpha = tmp_data_home / "projects" / "alpha"
    beta = tmp_data_home / "projects" / "beta"
    alpha.mkdir(parents=True)
    beta.mkdir(parents=True)
    projects = {
        "alpha": {
            "path": str(alpha),
            "enabled": ["brainstorm"],
            "bundles": ["android"],
            "harnesses": ["codex"],
            "permissions": {"allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]},
            "invocation_overrides": {"brainstorm": "user-only"},
        },
        "beta": {"path": str(beta), "enabled": [], "bundles": []},
    }
    _write_registry(tmp_data_home, projects)
    return projects


def test_rename_moves_block_and_keeps_order(tmp_data_home, two_projects, monkeypatch):
    import hub

    synced: list[bool] = []
    monkeypatch.setattr(hub, "_auto_sync", lambda **_kwargs: synced.append(True))

    hub.cmd_project_rename(argparse.Namespace(name="alpha", new_name="alpha-two"))

    projects = _read_projects(tmp_data_home)
    assert list(projects) == ["alpha-two", "beta"]
    assert projects["alpha-two"] == two_projects["alpha"]
    assert synced == [True]


def test_rename_moves_every_name_keyed_sidecar(tmp_data_home, two_projects, monkeypatch):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda **_kwargs: None)
    state = tmp_data_home / "state"
    moved = [
        state / "claude-code" / "project-alpha.managed.json",
        state / "claude-code" / "project-alpha.hooks.managed.json",
        state / "claude-code" / "project-alpha-local.managed.json",
        state / "codex" / "project-alpha.rules.managed.json",
        state / "reconcile" / "project-alpha.kept.json",
        state / "hooks" / "lsp-report.project-alpha.json",
    ]
    for p in moved:
        _touch(p)
    kept = [
        # Another project whose name merely starts with ours.
        state / "claude-code" / "project-alpha-app.managed.json",
        state / "claude-code" / "global.managed.json",
        state / "claude-code" / "project-beta.managed.json",
        # A nested directory is not a sidecar and is never walked.
        state / "remote_alpha" / "project-alpha.managed.json",
    ]
    for p in kept:
        _touch(p)
    nested = state / "claude-code" / "deeper" / "project-alpha.managed.json"
    _touch(nested)

    hub.cmd_project_rename(argparse.Namespace(name="alpha", new_name="omega"))

    for p in moved:
        assert not p.exists(), p
        dst = p.with_name(p.name.replace("project-alpha", "project-omega"))
        assert dst.exists(), dst
        assert json.loads(dst.read_text()) == {"marker": p.name}
    for p in kept:
        assert p.exists(), p
    assert nested.exists()


def test_rename_refuses_bad_targets(tmp_data_home, two_projects, monkeypatch):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda **_kwargs: None)

    for new_name in ("beta", "Bad Name", "UPPER"):
        with pytest.raises(SystemExit):
            hub.cmd_project_rename(argparse.Namespace(name="alpha", new_name=new_name))
        assert list(_read_projects(tmp_data_home)) == ["alpha", "beta"]

    with pytest.raises(SystemExit):
        hub.cmd_project_rename(argparse.Namespace(name="nope", new_name="fine"))


def test_rename_to_same_name_is_a_noop(tmp_data_home, two_projects, monkeypatch, capsys):
    import hub

    synced: list[bool] = []
    monkeypatch.setattr(hub, "_auto_sync", lambda **_kwargs: synced.append(True))

    hub.cmd_project_rename(argparse.Namespace(name="alpha", new_name="alpha"))

    assert "already has that name" in capsys.readouterr().out
    assert list(_read_projects(tmp_data_home)) == ["alpha", "beta"]
    assert synced == []


def test_rename_refuses_when_target_sidecar_exists(tmp_data_home, two_projects, monkeypatch):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda **_kwargs: None)
    state = tmp_data_home / "state" / "claude-code"
    src = _touch(state / "project-alpha.managed.json")
    stale = _touch(state / "project-omega.managed.json", {"stale": True})

    with pytest.raises(SystemExit):
        hub.cmd_project_rename(argparse.Namespace(name="alpha", new_name="omega"))

    assert list(_read_projects(tmp_data_home)) == ["alpha", "beta"]
    assert src.exists()
    assert json.loads(stale.read_text()) == {"stale": True}
