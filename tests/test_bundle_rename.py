"""`hub bundle rename`: the registry key moves with its block, every
project/remote/cloud reference follows, and every refusal leaves the
registry untouched."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pytest
import yaml


def _write_registry(
    tmp_data_home: Path,
    bundles: dict,
    projects: dict | None = None,
    remotes: dict | None = None,
    cloud: dict | None = None,
) -> None:
    registry = {
        "version": "1",
        "skills": {
            "brainstorm": {"scope": "portable"},
            "unslop": {"scope": "portable"},
        },
        "projects": projects or {},
        "bundles": bundles,
    }
    if remotes is not None:
        registry["remotes"] = remotes
    if cloud is not None:
        registry["cloud"] = cloud
    (tmp_data_home / "registry.yaml").write_text(
        yaml.safe_dump(registry, sort_keys=False)
    )


def _read_registry(tmp_data_home: Path) -> dict:
    return yaml.safe_load((tmp_data_home / "registry.yaml").read_text())


def _snapshot(tmp_data_home: Path) -> dict:
    """The bundle-relevant slice a refusal must leave untouched.

    `load_registry()` normalizes missing top-level/per-project defaults
    (`harnesses_global`, a project's `harnesses`/`permissions`, …) and
    persists them on every read — including a read that ends in a refusal —
    so a byte-exact or deep-equality file comparison would fail on that
    unrelated normalization noise. Compare only what a bundle rename could
    plausibly touch: the bundles block itself, plus every holder's
    `bundles` list.
    """
    registry = _read_registry(tmp_data_home)
    bundles = registry.get("bundles") or {}
    projects = registry.get("projects") or {}
    remotes = registry.get("remotes") or {}
    cloud = registry.get("cloud") or {}
    return {
        "bundle_keys": list(bundles),
        "bundles": bundles,
        "project_bundles": {k: v.get("bundles") for k, v in projects.items()},
        "remote_bundles": {k: v.get("bundles") for k, v in remotes.items()},
        "cloud_bundles": {k: v.get("bundles") for k, v in cloud.items()},
    }


@pytest.fixture
def two_bundles(tmp_data_home: Path) -> dict:
    bundles = {
        "android": {
            "description": "Android tooling",
            "icon": "🤖",
            "scope": "project-specific",
            "skills": ["brainstorm", "unslop"],
        },
        "openspec": {
            "description": "OpenSpec workflow",
            "icon": "📐",
            "scope": "global",
            "skills": ["unslop"],
        },
    }
    projects = {
        "alpha": {"path": "/tmp/alpha", "enabled": [], "bundles": ["android"]},
        "beta": {"path": "/tmp/beta", "enabled": [], "bundles": ["openspec", "android"]},
        "gamma": {"path": "/tmp/gamma", "enabled": [], "bundles": []},
    }
    remotes = {
        "hermes": {"connector": "hermes", "bundles": ["android"], "enabled": []},
        "goalrunner": {"connector": "hermes", "bundles": [], "enabled": []},
    }
    cloud = {
        "claude-ai": {"bundles": ["android", "openspec"], "enabled": []},
        "chatgpt": {"bundles": [], "enabled": []},
    }
    _write_registry(tmp_data_home, bundles, projects, remotes, cloud)
    return {"bundles": bundles, "projects": projects, "remotes": remotes, "cloud": cloud}


def _ns(old, new, json_out=False):
    return argparse.Namespace(old_name=old, new_name=new, json=json_out)


def test_rename_moves_block_and_keeps_order(tmp_data_home, two_bundles, monkeypatch):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)

    hub.cmd_bundle_rename(_ns("android", "droid"))

    registry = _read_registry(tmp_data_home)
    assert list(registry["bundles"]) == ["droid", "openspec"]
    assert registry["bundles"]["droid"] == two_bundles["bundles"]["android"]
    # Untouched bundle keeps its exact content.
    assert registry["bundles"]["openspec"] == two_bundles["bundles"]["openspec"]


def test_rename_updates_project_remote_cloud_references(
    tmp_data_home, two_bundles, monkeypatch
):
    import hub

    synced: list[bool] = []
    monkeypatch.setattr(hub, "_auto_sync", lambda: synced.append(True))

    hub.cmd_bundle_rename(_ns("android", "droid"))

    registry = _read_registry(tmp_data_home)
    assert registry["projects"]["alpha"]["bundles"] == ["droid"]
    assert registry["projects"]["beta"]["bundles"] == ["openspec", "droid"]
    assert registry["projects"]["gamma"]["bundles"] == []
    assert registry["remotes"]["hermes"]["bundles"] == ["droid"]
    assert registry["remotes"]["goalrunner"]["bundles"] == []
    assert registry["cloud"]["claude-ai"]["bundles"] == ["droid", "openspec"]
    assert registry["cloud"]["chatgpt"]["bundles"] == []
    assert synced == [True]


def test_rename_prints_reference_lines(tmp_data_home, two_bundles, monkeypatch, capsys):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)

    hub.cmd_bundle_rename(_ns("android", "droid"))

    out = capsys.readouterr().out
    assert "renamed bundle 'android' → 'droid'" in out
    assert "projects" in out
    assert "alpha" in out and "beta" in out
    assert "remotes" in out
    assert "hermes" in out
    assert "cloud" in out
    assert "claude-ai" in out
    # Untouched holders never mentioned.
    assert "gamma" not in out
    assert "goalrunner" not in out
    assert "chatgpt" not in out


def test_rename_json_payload_shape(tmp_data_home, two_bundles, monkeypatch, capsys):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)

    hub.cmd_bundle_rename(_ns("android", "droid", json_out=True))

    out = capsys.readouterr().out
    payload = json.loads(out.strip().splitlines()[0])
    assert payload == {
        "renamed": {"from": "android", "to": "droid"},
        "projects": ["alpha", "beta"],
        "remotes": ["hermes"],
        "cloud": ["claude-ai"],
    }


def test_rename_linked_bundle_keeps_source(tmp_data_home, monkeypatch):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    bundles = {
        "linked": {
            "description": "Linked bundle",
            "icon": "🔗",
            "scope": "project-specific",
            "skills": ["unslop"],
            "source": "org-skills",
        },
    }
    _write_registry(
        tmp_data_home,
        bundles,
        projects={"alpha": {"path": "/tmp/alpha", "enabled": [], "bundles": ["linked"]}},
    )

    hub.cmd_bundle_rename(_ns("linked", "linked-two"))

    registry = _read_registry(tmp_data_home)
    assert list(registry["bundles"]) == ["linked-two"]
    assert registry["bundles"]["linked-two"]["source"] == "org-skills"
    assert registry["bundles"]["linked-two"]["skills"] == ["unslop"]
    assert registry["projects"]["alpha"]["bundles"] == ["linked-two"]


def test_rename_refuses_unknown_bundle(tmp_data_home, two_bundles, monkeypatch):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    before = _snapshot(tmp_data_home)

    with pytest.raises(SystemExit):
        hub.cmd_bundle_rename(_ns("nope", "whatever"))

    assert _snapshot(tmp_data_home) == before


def test_rename_refuses_invalid_slug(tmp_data_home, two_bundles, monkeypatch):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    before = _snapshot(tmp_data_home)

    for bad in ("Bad Name", "UPPER", "has space"):
        with pytest.raises(SystemExit):
            hub.cmd_bundle_rename(_ns("android", bad))
        assert _snapshot(tmp_data_home) == before


def test_rename_refuses_duplicate_target(tmp_data_home, two_bundles, monkeypatch):
    import hub

    monkeypatch.setattr(hub, "_auto_sync", lambda: None)
    before = _snapshot(tmp_data_home)

    with pytest.raises(SystemExit):
        hub.cmd_bundle_rename(_ns("android", "openspec"))

    assert _snapshot(tmp_data_home) == before


def test_rename_to_same_name_is_a_noop(tmp_data_home, two_bundles, monkeypatch, capsys):
    import hub

    synced: list[bool] = []
    monkeypatch.setattr(hub, "_auto_sync", lambda: synced.append(True))
    before = _snapshot(tmp_data_home)

    hub.cmd_bundle_rename(_ns("android", "android"))

    assert "already has that name" in capsys.readouterr().out
    assert _snapshot(tmp_data_home) == before
    assert synced == []
