"""Focused contracts for new-project worktree defaults and portability."""

from __future__ import annotations

import json
import sys

import pytest
import yaml

from skill_hub.application.backup import backup, restore
from skill_hub.application.projects import worktree_defaults


def test_resolve_normalizes_missing_target_and_disabled_access(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    base = tmp_path / "shared" / "with spaces"
    result = worktree_defaults.resolve(
        {
            "location": "shared-directory",
            "base_dir": str(base),
            "access_enabled": False,
            "include_in_backup": False,
        },
        name="payments",
        project_path=project,
    )
    assert result == {
        "path": str((base / "payments").resolve()),
        "access_enabled": False,
        "missing_directory": True,
    }


def test_project_subdirectory_keeps_custom_base_and_resolves(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    custom = tmp_path / "custom"
    defaults = worktree_defaults.normalize(
        {
            "location": "project-subdirectory",
            "base_dir": str(custom),
            "access_enabled": True,
            "include_in_backup": True,
        }
    )
    result = worktree_defaults.resolve(defaults, name="alpha", project_path=project)
    assert result["path"] == str((project / ".worktrees").resolve())
    assert result["access_enabled"] is True
    assert defaults["base_dir"] == str(custom.resolve())


def test_preview_resolves_missing_hypothetical_project_path(tmp_path):
    project = tmp_path / "future-project"
    result = worktree_defaults.resolve(
        {
            "location": "project-subdirectory",
            "base_dir": str(tmp_path / "retained-base"),
            "access_enabled": False,
            "include_in_backup": False,
        },
        name="future",
        project_path=project,
    )
    assert result["path"] == str((project / ".worktrees").resolve())
    assert result["missing_directory"] is True


def test_invalid_base_file_and_present_null_are_rejected(tmp_path):
    base_file = tmp_path / "base"
    base_file.write_text("file")
    with pytest.raises(worktree_defaults.WorktreeDefaultsError, match="directory"):
        worktree_defaults.normalize({"base_dir": str(base_file)})
    with pytest.raises(worktree_defaults.WorktreeDefaultsError, match="object"):
        worktree_defaults.effective({"worktree_defaults": None})


def test_cli_set_and_preview_use_json_envelope(tmp_data_home, tmp_path, monkeypatch, capsys):
    import hub

    project = tmp_path / "project"
    project.mkdir()
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump({"projects": {}}))
    config = json.dumps(
        {
            "location": "shared-directory",
            "base_dir": str(tmp_path / "worktrees"),
            "access_enabled": True,
            "include_in_backup": False,
        }
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["hub", "project", "worktree-defaults", "set", "--config-json", config, "--json"],
    )
    hub.main()
    saved = json.loads(capsys.readouterr().out)
    assert saved["ok"] is True
    assert saved["defaults"]["access_enabled"] is True

    monkeypatch.setattr(
        sys,
        "argv",
        [
            "hub",
            "project",
            "worktree-defaults",
            "preview",
            "--name",
            "payments",
            "--path",
            str(project),
            "--json",
        ],
    )
    hub.main()
    preview = json.loads(capsys.readouterr().out)
    assert preview["ok"] is True
    assert preview["preview"]["path"].endswith("/payments")
    assert preview["preview"]["access_enabled"] is True


def test_new_project_freezes_resolved_path_and_access(tmp_data_home, tmp_path, monkeypatch, capsys):
    import hub

    project = tmp_path / "project"
    project.mkdir()
    base = tmp_path / "worktrees"
    registry = {
        "projects": {},
        "worktree_defaults": {
            "location": "shared-directory",
            "base_dir": str(base),
            "access_enabled": True,
            "include_in_backup": False,
        },
    }
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry))
    monkeypatch.setattr(sys, "argv", ["hub", "project", "add", "payments", str(project)])
    hub.main()
    capsys.readouterr()
    saved = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert saved["projects"]["payments"]["permissions"]["worktree_access"] == {
        "enabled": True,
        "path": str((base / "payments").resolve()),
    }


def test_backup_toggle_and_restore_diff_preserve_omitted_defaults(tmp_path):
    home = tmp_path / "home"
    data_home = home / ".skill-hub"
    home.mkdir()
    data_home.mkdir()
    defaults = {
        "location": "shared-directory",
        "base_dir": str(home / "Projects" / "worktrees"),
        "access_enabled": True,
        "include_in_backup": True,
    }
    portable = backup.to_portable(
        {"worktree_defaults": defaults}, data_home=data_home, home=home
    )
    assert portable["worktree_defaults"]["base_dir"] == "{HOME}/Projects/worktrees"
    assert portable["worktree_defaults"]["include_in_backup"] is True
    landed = backup.from_portable(
        portable,
        data_home=tmp_path / "other" / ".skill-hub",
        home=tmp_path / "other",
    )
    assert landed["worktree_defaults"]["base_dir"] == "~/Projects/worktrees"
    expanded = backup.from_portable(
        portable,
        data_home=tmp_path / "other" / ".skill-hub",
        home=tmp_path / "other",
        collapse=False,
    )
    assert expanded["worktree_defaults"]["base_dir"] == str(
        (tmp_path / "other" / "Projects" / "worktrees").resolve()
    )

    target = {"worktree_defaults": {**defaults, "access_enabled": False}}
    diff = restore.diff_registry(target, {})
    assert diff["worktree_defaults"]["status"] == "preserved"
    assert diff["worktree_defaults"]["value"]["access_enabled"] is False
    replaced = restore.replace_registry(target, {})
    assert replaced["worktree_defaults"]["access_enabled"] is False

    omitted = backup.to_portable(
        {"worktree_defaults": {**defaults, "include_in_backup": False}},
        data_home=data_home,
        home=home,
    )
    assert "worktree_defaults" not in omitted


def test_backup_rejects_present_null_worktree_defaults(tmp_path):
    with pytest.raises(worktree_defaults.WorktreeDefaultsError, match="object"):
        backup.to_portable(
            {"worktree_defaults": None},
            data_home=tmp_path / ".skill-hub",
            home=tmp_path,
        )


def test_restore_report_uses_effective_path_when_home_token_crosses_symlink(tmp_path, monkeypatch):
    home = tmp_path / "home"
    outside = tmp_path / "outside"
    home.mkdir()
    outside.mkdir()
    (home / "linked").symlink_to(outside, target_is_directory=True)
    monkeypatch.setenv("HOME", str(home))
    report = restore.collect_machine_absolute(
        {"worktree_defaults": {"base_dir": str(outside)}},
        rewritten_fields=frozenset({"worktree_defaults.base_dir"}),
    )
    assert report == [
        {
            "field": "worktree_defaults.base_dir",
            "value": str(outside),
            "rewritten": False,
        }
    ]
