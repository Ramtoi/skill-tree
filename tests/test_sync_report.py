"""Tests for the structured sync report (<data_home>/state/sync-report.json).

The report is a derived per-run log written on EVERY exit path of `hub sync`.
These tests drive `cmd_sync` in-process with an isolated data home + fake HOME
(so global-skill / permission writes never touch the real user config) and a
patched `detect_installed` so the effective harness set is deterministic.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import pytest
import yaml


def _seed_skill(data_home: Path, name: str) -> Path:
    src = data_home / "skills" / name
    src.mkdir(parents=True, exist_ok=True)
    (src / "SKILL.md").write_text(f"---\nname: {name}\ndescription: t\n---\n")
    return src


@pytest.fixture
def sync_env(tmp_data_home, tmp_path, monkeypatch):
    """Claude-only project with one enabled skill; HOME + harness set isolated."""
    import harnesses as _harnesses

    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})

    skill_src = _seed_skill(tmp_data_home, "brainstorm")
    proj_path = tmp_path / "alpha"
    proj_path.mkdir()

    registry = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": {
            "brainstorm": {
                "version": "1.0.0",
                "description": "",
                "source": str(skill_src),
                "type": "claude-skill",
                "scope": "portable",
                "upstream": None,
            }
        },
        "projects": {
            "alpha": {
                "path": str(proj_path),
                "enabled": ["brainstorm"],
                "bundles": [],
                "harnesses": [],
            }
        },
        "bundles": {},
    }
    (tmp_data_home / "registry.yaml").write_text(
        yaml.safe_dump(registry, sort_keys=False)
    )
    return tmp_data_home, proj_path


def _mutate_registry(data_home: Path, fn) -> None:
    reg = yaml.safe_load((data_home / "registry.yaml").read_text())
    fn(reg)
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))


def _report(data_home: Path) -> dict:
    path = data_home / "state" / "sync-report.json"
    assert path.exists(), "sync report was not written"
    return json.loads(path.read_text())


def test_report_written_with_full_shape(sync_env, capsys):
    import hub

    data_home, proj_path = sync_env
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    rep = _report(data_home)
    assert rep["schema_version"] == 1
    assert isinstance(rep["generated_at"], str) and rep["generated_at"].endswith("Z")
    assert rep["registry_sha256"]
    assert isinstance(rep["registry_mtime"], float)
    assert rep["ok"] is True

    g = rep["global"]
    assert set(g.keys()) == {"skipped", "skills", "mcp", "permissions", "remotes"}
    # No scope:global skills registered — the project skill counts per-project.
    assert g["skills"] == {"writes": 0, "removed": 0}
    assert g["permissions"]["ok"] is True
    assert g["remotes"] == {"attempted": 0, "alarming": 0}

    assert "alpha" in rep["projects"]
    prec = rep["projects"]["alpha"]
    assert set(prec.keys()) >= {
        "ts",
        "ok",
        "errors",
        "writes",
        "removed",
        "affinity_skips",
    }
    assert prec["ok"] is True
    assert prec["errors"] == []
    assert prec["writes"] == 1
    assert prec["removed"] == 0
    assert prec["affinity_skips"] == []
    # The symlink actually landed.
    assert (proj_path / ".claude" / "skills" / "brainstorm").is_symlink()


def test_report_write_is_atomic_no_temp_left(sync_env, capsys):
    import hub

    data_home, _ = sync_env
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    state = data_home / "state"
    assert (state / "sync-report.json").exists()
    # No partial/temp file lingers after the atomic os.replace.
    assert not list(state.glob("sync-report.json.tmp"))
    # And the final file is valid JSON (no truncation).
    json.loads((state / "sync-report.json").read_text())


def test_registry_sha256_matches_post_sync_recompute(sync_env, capsys):
    import hub

    data_home, _ = sync_env
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    rep = _report(data_home)
    expected = hashlib.sha256(
        (data_home / "registry.yaml").read_bytes()
    ).hexdigest()
    assert rep["registry_sha256"] == expected


def test_induced_project_error_sets_ok_false(sync_env, capsys):
    import hub

    data_home, _ = sync_env
    # Repoint the skill source at a path with no SKILL.md → "source missing".
    _mutate_registry(
        data_home,
        lambda r: r["skills"]["brainstorm"].__setitem__(
            "source", str(data_home / "skills" / "does-not-exist")
        ),
    )
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    rep = _report(data_home)
    assert rep["ok"] is False
    prec = rep["projects"]["alpha"]
    assert prec["ok"] is False
    assert prec["errors"], "expected an error entry"
    err = prec["errors"][0]
    assert err["stage"] == "symlink"
    assert "source missing" in err["message"]


def test_affinity_skip_recorded(sync_env, capsys):
    import hub

    data_home, proj_path = sync_env
    # Skill targets codex only; project is claude-code only → zero agents.
    _mutate_registry(
        data_home,
        lambda r: r["skills"]["brainstorm"].__setitem__("harnesses", ["codex"]),
    )
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    rep = _report(data_home)
    skips = rep["projects"]["alpha"]["affinity_skips"]
    assert len(skips) == 1
    assert skips[0] == {
        "skill": "brainstorm",
        "skill_harnesses": ["codex"],
        "project_harnesses": ["claude-code"],
    }
    # Nothing was written for this project.
    assert not (proj_path / ".claude" / "skills" / "brainstorm").exists()
    assert rep["projects"]["alpha"]["writes"] == 0
    # An affinity skip is not itself an error.
    assert rep["projects"]["alpha"]["ok"] is True


def test_skip_flags_recorded_in_global_skipped(sync_env, capsys):
    import hub

    data_home, _ = sync_env
    args = argparse.Namespace(skip_permissions=True, skip_remotes=True)
    hub.cmd_sync(args)
    capsys.readouterr()

    rep = _report(data_home)
    assert set(rep["global"]["skipped"]) == {"permissions", "remotes"}
    # Skipped permissions default to ok (the stream never ran).
    assert rep["global"]["permissions"]["ok"] is True
    assert rep["ok"] is True


def test_report_written_on_permission_error_exit(sync_env, capsys):
    import hub

    data_home, _ = sync_env
    # An unbounded Bash allow is a doctor DANGER finding → sync exits non-zero.
    _mutate_registry(
        data_home,
        lambda r: r.__setitem__(
            "permissions_global",
            {"allow": [{"pattern": "Bash(*)", "kind": "allow"}]},
        ),
    )
    with pytest.raises(SystemExit) as exc:
        hub.cmd_sync(argparse.Namespace())
    assert exc.value.code != 0
    capsys.readouterr()

    # The report must have been written BEFORE the exit.
    rep = _report(data_home)
    assert rep["ok"] is False
    assert rep["global"]["permissions"]["ok"] is False
    assert rep["global"]["permissions"]["errors"], "expected permission errors"
