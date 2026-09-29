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
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

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
    assert set(g.keys()) == {
        "skipped", "skills", "mcp", "permissions", "hooks", "doctor", "remotes",
        # `backup` is additive (design v2 §9); `companions` likewise (A16,
        # ships-with-2 wave 2); `loadouts` likewise (usage-loadout-analytics
        # design D6, wave 1) — the frontend's SyncReportGlobal interface is
        # already a subset of what Python emits, so extra keys are tolerated
        # and `schema_version` stays at 1.
        "backup", "companions", "loadouts",
    }
    assert g["backup"]["ran"] is False  # backup not configured in this fixture
    # No scope:global skills registered — the project skill counts per-project.
    # `skipped_unowned` counts links a sweep refused to touch because another
    # install owns them — an orphan this hub may not reclaim, made visible.
    assert g["skills"] == {"writes": 0, "removed": 0, "skipped_unowned": 0}
    assert g["permissions"]["ok"] is True
    assert g["hooks"]["ok"] is True
    assert g["doctor"]["ok"] is True
    assert g["remotes"] == {"attempted": 0, "alarming": 0, "targets": {}}
    # The "2e" loadout pass (design D6): one (project, harness) pair for the
    # single project/harness this fixture registers, and a first-ever sync
    # always appends a row (no prior loadout row exists to compare against).
    assert set(g["loadouts"].keys()) == {"appended", "pairs", "errors"}
    assert g["loadouts"]["errors"] == []
    assert g["loadouts"]["pairs"] == 1
    assert g["loadouts"]["appended"] == 1

    assert "alpha" in rep["projects"]
    prec = rep["projects"]["alpha"]
    assert set(prec.keys()) >= {
        "ts",
        "ok",
        "errors",
        "writes",
        "removed",
        "affinity_skips",
        "missing_refs",
    }
    assert prec["ok"] is True
    assert prec["errors"] == []
    assert prec["writes"] == 1
    assert prec["removed"] == 0
    assert prec["affinity_skips"] == []
    assert prec["missing_refs"] == []
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

    # The report must have been written BEFORE the exit. A DANGER finding is now
    # attributed to the shared doctor rollup, not the permissions stream.
    rep = _report(data_home)
    assert rep["ok"] is False
    assert rep["global"]["doctor"]["ok"] is False
    assert rep["global"]["doctor"]["errors"], "expected doctor danger findings"


def _helper_skill_cfg(data_home: Path, scope: str = "portable") -> dict:
    return {
        "version": "1.0.0",
        "description": "",
        "source": str(data_home / "skills" / "helper"),
        "type": "claude-skill",
        "scope": scope,
        "upstream": None,
    }


def test_missing_refs_recorded_per_project(sync_env, capsys):
    import hub

    data_home, proj_path = sync_env
    (data_home / "skills" / "brainstorm" / "SKILL.md").write_text(
        "---\nname: brainstorm\ndescription: t\n---\nSee `helper` for details.\n"
    )
    _seed_skill(data_home, "helper")
    _mutate_registry(
        data_home,
        lambda r: r["skills"].__setitem__("helper", _helper_skill_cfg(data_home)),
    )
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    rep = _report(data_home)
    prec = rep["projects"]["alpha"]
    assert prec["missing_refs"] == [{"skill": "brainstorm", "refs": ["helper"]}]
    # Non-blocking: it never sets errors or flips ok.
    assert prec["ok"] is True
    assert prec["errors"] == []


def test_missing_refs_ignores_global_scope_targets(sync_env, capsys):
    import hub

    data_home, proj_path = sync_env
    (data_home / "skills" / "brainstorm" / "SKILL.md").write_text(
        "---\nname: brainstorm\ndescription: t\n---\nSee `helper` for details.\n"
    )
    _seed_skill(data_home, "helper")
    _mutate_registry(
        data_home,
        lambda r: r["skills"].__setitem__(
            "helper", _helper_skill_cfg(data_home, scope="global")
        ),
    )
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    rep = _report(data_home)
    assert rep["projects"]["alpha"]["missing_refs"] == []


def test_missing_refs_from_a_global_source_lands_on_every_project(
    sync_env, tmp_path, capsys
):
    import hub

    data_home, proj_path = sync_env
    proj2_path = tmp_path / "beta"
    proj2_path.mkdir()

    watcher_src = _seed_skill(data_home, "watcher")
    (watcher_src / "SKILL.md").write_text(
        "---\nname: watcher\ndescription: t\n---\nSee `helper` for details.\n"
    )
    _seed_skill(data_home, "helper")

    def _mut(r):
        r["skills"]["watcher"] = {
            "version": "1.0.0",
            "description": "",
            "source": str(watcher_src),
            "type": "claude-skill",
            "scope": "global",
            "upstream": None,
        }
        r["skills"]["helper"] = _helper_skill_cfg(data_home)
        r["projects"]["beta"] = {
            "path": str(proj2_path),
            "enabled": [],
            "bundles": [],
            "harnesses": [],
        }

    _mutate_registry(data_home, _mut)
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    rep = _report(data_home)
    expected = [{"skill": "watcher", "refs": ["helper"]}]
    assert rep["projects"]["alpha"]["missing_refs"] == expected
    assert rep["projects"]["beta"]["missing_refs"] == expected


def test_unequipping_last_mcp_server_still_runs_the_writer(sync_env, capsys):
    """Proves the `if resolved_mcps:` gate hub.py's project pass used to have
    was lifted (plans/A.md §3): unequipping a project's ONLY MCP server must
    still reach the writer and remove its .mcp.json entry."""
    import hub

    data_home, proj_path = sync_env
    mcp_src = data_home / "mcp-servers" / "fs-mcp"
    mcp_src.mkdir(parents=True)
    (mcp_src / "server.py").write_text("# stub\n")

    def _add_mcp(r):
        r["skills"]["fs-mcp"] = {
            "version": "1.0.0",
            "description": "",
            "source": str(mcp_src),
            "type": "mcp-server",
            "scope": "project-specific",
            "upstream": None,
            "mcp": {"command": "python3", "args": ["{source}/server.py"], "env": {}},
        }
        r["projects"]["alpha"]["enabled"].append("fs-mcp")

    _mutate_registry(data_home, _add_mcp)
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    mcp_json = proj_path / ".mcp.json"
    assert mcp_json.exists()
    assert "fs-mcp" in json.loads(mcp_json.read_text())["mcpServers"]

    def _unequip(r):
        r["projects"]["alpha"]["enabled"].remove("fs-mcp")

    _mutate_registry(data_home, _unequip)
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    assert not mcp_json.exists()


def test_report_carries_mcp_delivery_slots(sync_env, capsys):
    """`report.global.mcp.delivery` and `report.projects.<n>.mcp_delivery`
    (plans/C.md §4) are additive: a fresh report carries both, they
    serialize, and an OLDER report shape (predating this wave, missing both
    fields) still parses through `_sync_report_ok` — no `schema_version`
    bump."""
    import hub

    data_home, proj_path = sync_env
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    rep = _report(data_home)
    assert rep["global"]["mcp"]["delivery"] == []
    assert rep["projects"]["alpha"]["mcp_delivery"] == []
    json.dumps(rep)  # still fully serializable

    fresh = hub.new_sync_report()
    assert fresh["global"]["mcp"]["delivery"] == []
    proj_rec = hub.new_project_report()
    assert proj_rec["mcp_delivery"] == []

    legacy_report = {
        "projects": {"alpha": {"ok": True}},
        "global": {
            "permissions": {"ok": True},
            "hooks": {"ok": True},
            "doctor": {"ok": True},
        },
    }
    assert hub._sync_report_ok(legacy_report) is True
