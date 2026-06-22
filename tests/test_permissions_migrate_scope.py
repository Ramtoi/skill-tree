"""De-duplication migration tests (D2 / change rework-permissions-model §3).

`hub permissions migrate-scope` strips global-sourced hub-managed rules out of
project native files, leaving project-owned and user-authored rules in place.
Driven in-process; HOME + harness detection monkeypatched per test.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import yaml

import hub
import permission_adapters as pa


def _seed_registry(data_home: Path, registry: dict) -> None:
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _write_claude_project_settings(
    data_home: Path, proj_dir: Path, proj_name: str, allow: list[str], managed_idx: list[int]
) -> None:
    """Write a project .claude/settings.json + a sidecar claiming managed_idx."""
    from permissions import ProjectScope, write_sidecar

    settings = proj_dir / ".claude" / "settings.json"
    settings.parent.mkdir(parents=True, exist_ok=True)
    settings.write_text(json.dumps({"permissions": {"allow": allow}}, indent=2) + "\n")
    scope = ProjectScope(name=proj_name, path=str(proj_dir))
    write_sidecar(
        "claude-code",
        scope,
        [f"permissions.allow[{i}]" for i in managed_idx],
        settings,
    )


def _ns(apply=False, json_out=False) -> argparse.Namespace:
    return argparse.Namespace(apply=apply, json=json_out)


def _patch_claude(monkeypatch):
    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})


# ─────────────────────────────────────────────────────────────────────────────
# Dry-run previews removals without writing
# ─────────────────────────────────────────────────────────────────────────────


def test_dry_run_previews_without_writing(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    _patch_claude(monkeypatch)
    proj_dir = tmp_path / "alpha"
    # allow[0]=npm (global, hub-managed), [1]=git (own, hub-managed),
    # [2]=ls (user-authored, NOT hub-managed)
    _write_claude_project_settings(
        tmp_data_home, proj_dir, "alpha",
        ["Bash(npm:*)", "Bash(git:*)", "Bash(ls:*)"],
        managed_idx=[0, 1],
    )
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["claude-code"],
            "permissions_global": {
                "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
            },
            "projects": {
                "alpha": {
                    "path": str(proj_dir),
                    "permissions": {
                        "allow": [{"pattern": "Bash(git:*)", "kind": "allow"}]
                    },
                },
            },
            "skills": {},
        },
    )
    settings = proj_dir / ".claude" / "settings.json"
    before = settings.read_bytes()

    hub.cmd_permissions_migrate_scope(_ns(json_out=True))
    body = json.loads(capsys.readouterr().out)

    assert body["apply"] is False
    entry = next(e for e in body["entries"] if e["harness_id"] == "claude-code")
    removed = {(r["pattern"], r["kind"]) for r in entry["removed"]}
    assert ("Bash(npm:*)", "allow") in removed  # global, not owned
    # git is owned → kept; ls is not hub-managed → not even considered
    assert all(r["pattern"] != "Bash(git:*)" for r in entry["removed"])
    assert entry["applied"] is False

    # No mutation on dry-run.
    assert settings.read_bytes() == before


# ─────────────────────────────────────────────────────────────────────────────
# Apply removes only globally-sourced hub-managed rules
# ─────────────────────────────────────────────────────────────────────────────


def test_apply_removes_only_global_sourced_managed_rules(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    _patch_claude(monkeypatch)
    proj_dir = tmp_path / "alpha"
    _write_claude_project_settings(
        tmp_data_home, proj_dir, "alpha",
        ["Bash(npm:*)", "Bash(git:*)", "Bash(ls:*)"],
        managed_idx=[0, 1],
    )
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["claude-code"],
            "permissions_global": {
                "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
            },
            "projects": {
                "alpha": {
                    "path": str(proj_dir),
                    "permissions": {
                        "allow": [{"pattern": "Bash(git:*)", "kind": "allow"}]
                    },
                },
            },
            "skills": {},
        },
    )
    pa._reset_backup_session_state_for_tests()
    hub.cmd_permissions_migrate_scope(_ns(apply=True, json_out=True))
    body = json.loads(capsys.readouterr().out)
    entry = next(e for e in body["entries"] if e["harness_id"] == "claude-code")
    assert entry["applied"] is True
    assert entry["backup_path"]
    assert Path(entry["backup_path"]).exists()

    settings = proj_dir / ".claude" / "settings.json"
    allow = json.loads(settings.read_text())["permissions"]["allow"]
    # global-sourced npm removed; own git + user-authored ls retained
    assert "Bash(npm:*)" not in allow
    assert "Bash(git:*)" in allow
    assert "Bash(ls:*)" in allow

    # Sidecar re-indexed: git (was idx 1) now idx 0 and still claimed.
    from permissions import ProjectScope, read_sidecar

    scope = ProjectScope(name="alpha", path=str(proj_dir))
    sc = read_sidecar("claude-code", scope)
    assert sc is not None
    assert sc.managed_keys == ["permissions.allow[0]"]


def test_owned_and_global_rule_is_kept(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """A rule in BOTH global and the project's own block is retained."""
    _patch_claude(monkeypatch)
    proj_dir = tmp_path / "alpha"
    _write_claude_project_settings(
        tmp_data_home, proj_dir, "alpha", ["Bash(npm:*)"], managed_idx=[0]
    )
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["claude-code"],
            "permissions_global": {
                "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
            },
            "projects": {
                "alpha": {
                    "path": str(proj_dir),
                    "permissions": {
                        "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
                    },
                },
            },
            "skills": {},
        },
    )
    pa._reset_backup_session_state_for_tests()
    hub.cmd_permissions_migrate_scope(_ns(apply=True))
    capsys.readouterr()

    settings = proj_dir / ".claude" / "settings.json"
    allow = json.loads(settings.read_text())["permissions"]["allow"]
    assert "Bash(npm:*)" in allow  # owned → kept


def test_no_global_block_is_noop(tmp_data_home, tmp_path, monkeypatch, capsys):
    """With no global rules there is nothing to de-duplicate against."""
    _patch_claude(monkeypatch)
    proj_dir = tmp_path / "alpha"
    _write_claude_project_settings(
        tmp_data_home, proj_dir, "alpha", ["Bash(npm:*)"], managed_idx=[0]
    )
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["claude-code"],
            "permissions_global": {},
            "projects": {
                "alpha": {
                    "path": str(proj_dir),
                    "permissions": {
                        "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
                    },
                },
            },
            "skills": {},
        },
    )
    hub.cmd_permissions_migrate_scope(_ns(json_out=True))
    body = json.loads(capsys.readouterr().out)
    assert body["entries"] == []


def test_unmanaged_project_file_skipped(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """A project file hub doesn't manage (no sidecar) is left untouched."""
    _patch_claude(monkeypatch)
    proj_dir = tmp_path / "alpha"
    settings = proj_dir / ".claude" / "settings.json"
    settings.parent.mkdir(parents=True, exist_ok=True)
    # Native file with a global-matching rule but NO sidecar (user-authored).
    settings.write_text(
        json.dumps({"permissions": {"allow": ["Bash(npm:*)"]}}, indent=2) + "\n"
    )
    before = settings.read_bytes()
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["claude-code"],
            "permissions_global": {
                "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
            },
            "projects": {
                "alpha": {"path": str(proj_dir), "permissions": {}},
            },
            "skills": {},
        },
    )
    pa._reset_backup_session_state_for_tests()
    hub.cmd_permissions_migrate_scope(_ns(apply=True, json_out=True))
    body = json.loads(capsys.readouterr().out)
    assert body["entries"] == []
    assert settings.read_bytes() == before  # untouched (not hub-managed)
