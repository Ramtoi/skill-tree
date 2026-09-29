"""Tests for hub.migrate_hooks_to_library + its wiring into hub.load_registry
(hooks-surface D6: legacy permissions*.hooks rows move to the top-level
`hooks:` library + hooks_global/project attach lists).

Personal-tier permissions live under a project's `permissions_local` block
(confirmed via grep of hub.py/permissions.py — NOT `permissions_global`'s
non-existent personal tier; the global scope has no personal tier at all).
Per D6, personal-tier rows attach to the SAME project `hooks` list as the
project-tier (`permissions`) rows — both are project attaches, just sourced
from different legacy blocks.
"""

from __future__ import annotations

import yaml


def _write_registry(tmp_data_home, data: dict) -> None:
    (tmp_data_home / "registry.yaml").write_text(
        yaml.safe_dump(data, sort_keys=False)
    )


def _backup_dir(tmp_data_home):
    return tmp_data_home / "_hub-backups" / "registry"


def _base_registry(**extra) -> dict:
    reg = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": {},
        "projects": {},
        "bundles": {},
    }
    reg.update(extra)
    return reg


# ─────────────────────────────────────────────────────────────────────────────
# Direct unit tests of migrate_hooks_to_library
# ─────────────────────────────────────────────────────────────────────────────


def test_no_hooks_anywhere_is_a_noop_no_mutation_no_backup(tmp_data_home):
    import hub

    reg = _base_registry(permissions_global={"allow": [], "hooks": []})
    _write_registry(tmp_data_home, reg)

    changed = hub.migrate_hooks_to_library(reg)
    assert changed is False
    assert "hooks" not in reg or reg.get("hooks") == {}
    assert not _backup_dir(tmp_data_home).exists()


def test_global_permissions_hooks_migrate_to_hooks_global(tmp_data_home):
    import hub

    reg = _base_registry(
        permissions_global={
            "allow": [],
            "hooks": [
                {
                    "event": "PreToolUse",
                    "matcher": "Bash",
                    "command": "echo global-hook",
                    "timeout": 15,
                }
            ],
        }
    )
    _write_registry(tmp_data_home, reg)

    changed = hub.migrate_hooks_to_library(reg)
    assert changed is True

    assert reg["permissions_global"]["hooks"] == []
    assert list(reg["hooks"]) == ["imported-hook-1"]
    definition = reg["hooks"]["imported-hook-1"]
    assert definition["event"] == "PreToolUse"
    assert definition["matcher"] == "Bash"
    assert definition["command"] == "echo global-hook"
    assert definition["timeout"] == 15
    assert reg["hooks_global"] == ["imported-hook-1"]

    assert _backup_dir(tmp_data_home).exists()
    backups = list(_backup_dir(tmp_data_home).glob("pre-hooks-migration-*.yaml"))
    assert len(backups) == 1


def test_project_permissions_hooks_migrate_to_project_attach(tmp_data_home):
    import hub

    reg = _base_registry(
        projects={
            "alpha": {
                "path": "/a",
                "enabled": [],
                "bundles": [],
                "permissions": {
                    "allow": [],
                    "hooks": [
                        {"event": "PostToolUse", "command": "echo project-hook"}
                    ],
                },
            }
        }
    )
    _write_registry(tmp_data_home, reg)

    changed = hub.migrate_hooks_to_library(reg)
    assert changed is True

    assert reg["projects"]["alpha"]["permissions"]["hooks"] == []
    assert list(reg["hooks"]) == ["imported-hook-1"]
    assert reg["hooks"]["imported-hook-1"]["command"] == "echo project-hook"
    assert reg["projects"]["alpha"]["hooks"] == ["imported-hook-1"]
    # Global attach list untouched (project-scope migration only).
    assert reg.get("hooks_global", []) == []


def test_personal_tier_permissions_local_hooks_migrate_to_same_project_attach(
    tmp_data_home,
):
    """D6: personal-tier (`permissions_local`) rows attach to the project's
    `hooks` list — the SAME attach list a project-tier row would use."""
    import hub

    reg = _base_registry(
        projects={
            "alpha": {
                "path": "/a",
                "enabled": [],
                "bundles": [],
                "permissions_local": {
                    "allow": [],
                    "hooks": [
                        {"event": "SessionStart", "command": "echo personal-hook"}
                    ],
                },
            }
        }
    )
    _write_registry(tmp_data_home, reg)

    changed = hub.migrate_hooks_to_library(reg)
    assert changed is True

    assert reg["projects"]["alpha"]["permissions_local"]["hooks"] == []
    assert list(reg["hooks"]) == ["imported-hook-1"]
    assert reg["hooks"]["imported-hook-1"]["command"] == "echo personal-hook"
    # Same attach list as a project-tier row — `hooks`, not a separate list.
    assert reg["projects"]["alpha"]["hooks"] == ["imported-hook-1"]


def test_mixed_scopes_in_one_registry_all_migrate_deterministically(tmp_data_home):
    import hub

    reg = _base_registry(
        permissions_global={
            "allow": [],
            "hooks": [{"event": "PreToolUse", "command": "echo g"}],
        },
        projects={
            "beta": {
                "path": "/b",
                "enabled": [],
                "bundles": [],
                "permissions": {
                    "allow": [],
                    "hooks": [{"event": "Stop", "command": "echo beta-project"}],
                },
                "permissions_local": {
                    "allow": [],
                    "hooks": [
                        {"event": "SessionStart", "command": "echo beta-personal"}
                    ],
                },
            },
            "alpha": {
                "path": "/a",
                "enabled": [],
                "bundles": [],
                "permissions": {
                    "allow": [],
                    "hooks": [{"event": "PostToolUse", "command": "echo alpha-project"}],
                },
            },
        },
    )
    _write_registry(tmp_data_home, reg)

    changed = hub.migrate_hooks_to_library(reg)
    assert changed is True

    # Deterministic order: global, then per-project (sorted by name) — alpha's
    # `permissions` row before beta's `permissions` then `permissions_local` rows.
    assert list(reg["hooks"]) == [
        "imported-hook-1",
        "imported-hook-2",
        "imported-hook-3",
        "imported-hook-4",
    ]
    assert reg["hooks"]["imported-hook-1"]["command"] == "echo g"
    assert reg["hooks"]["imported-hook-2"]["command"] == "echo alpha-project"
    assert reg["hooks"]["imported-hook-3"]["command"] == "echo beta-project"
    assert reg["hooks"]["imported-hook-4"]["command"] == "echo beta-personal"

    assert reg["hooks_global"] == ["imported-hook-1"]
    assert reg["projects"]["alpha"]["hooks"] == ["imported-hook-2"]
    assert reg["projects"]["beta"]["hooks"] == ["imported-hook-3", "imported-hook-4"]


def test_name_collision_skips_to_next_free_ordinal(tmp_data_home):
    import hub

    reg = _base_registry(
        hooks={"imported-hook-1": {"event": "PreToolUse", "command": "existing"}},
        permissions_global={
            "allow": [],
            "hooks": [{"event": "PostToolUse", "command": "echo new"}],
        },
    )
    _write_registry(tmp_data_home, reg)

    changed = hub.migrate_hooks_to_library(reg)
    assert changed is True

    assert set(reg["hooks"]) == {"imported-hook-1", "imported-hook-2"}
    assert reg["hooks"]["imported-hook-1"]["command"] == "existing"
    assert reg["hooks"]["imported-hook-2"]["command"] == "echo new"
    assert reg["hooks_global"] == ["imported-hook-2"]


def test_rerun_is_a_noop_byte_identical_no_new_backup(tmp_data_home):
    import hub

    reg = _base_registry(
        permissions_global={
            "allow": [],
            "hooks": [{"event": "PreToolUse", "command": "echo g"}],
        }
    )
    _write_registry(tmp_data_home, reg)

    assert hub.migrate_hooks_to_library(reg) is True
    snapshot = yaml.safe_dump(reg, sort_keys=False)
    backups_after_first = list(
        _backup_dir(tmp_data_home).glob("pre-hooks-migration-*.yaml")
    )
    assert len(backups_after_first) == 1

    assert hub.migrate_hooks_to_library(reg) is False
    assert yaml.safe_dump(reg, sort_keys=False) == snapshot

    backups_after_second = list(
        _backup_dir(tmp_data_home).glob("pre-hooks-migration-*.yaml")
    )
    assert len(backups_after_second) == 1  # no new backup on the no-op re-run


def test_harnesses_affinity_is_preserved_through_migration(tmp_data_home):
    import hub

    reg = _base_registry(
        permissions_global={
            "allow": [],
            "hooks": [
                {
                    "event": "PreToolUse",
                    "command": "echo g",
                    "harnesses": ["codex"],
                }
            ],
        }
    )
    _write_registry(tmp_data_home, reg)

    hub.migrate_hooks_to_library(reg)
    assert reg["hooks"]["imported-hook-1"]["harnesses"] == ["codex"]


# ─────────────────────────────────────────────────────────────────────────────
# Integration via hub.load_registry()
# ─────────────────────────────────────────────────────────────────────────────


def test_load_registry_applies_hooks_migration_and_persists(tmp_data_home):
    import hub

    reg = _base_registry(
        permissions_global={
            "allow": [],
            "hooks": [{"event": "PreToolUse", "command": "echo g"}],
        }
    )
    _write_registry(tmp_data_home, reg)

    loaded = hub.load_registry()
    assert loaded["hooks_global"] == ["imported-hook-1"]
    assert loaded["hooks"]["imported-hook-1"]["command"] == "echo g"
    assert loaded["permissions_global"]["hooks"] == []

    on_disk = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert on_disk["hooks_global"] == ["imported-hook-1"]
    assert on_disk["permissions_global"]["hooks"] == []


def test_load_registry_twice_is_idempotent_no_new_backup(tmp_data_home):
    import hub

    reg = _base_registry(
        permissions_global={
            "allow": [],
            "hooks": [{"event": "PreToolUse", "command": "echo g"}],
        }
    )
    _write_registry(tmp_data_home, reg)

    first = hub.load_registry()
    backups_after_first = list(
        _backup_dir(tmp_data_home).glob("pre-hooks-migration-*.yaml")
    )
    assert len(backups_after_first) == 1

    second = hub.load_registry()
    assert second["hooks_global"] == first["hooks_global"]
    assert second["hooks"] == first["hooks"]

    backups_after_second = list(
        _backup_dir(tmp_data_home).glob("pre-hooks-migration-*.yaml")
    )
    assert len(backups_after_second) == 1


def test_load_registry_with_no_legacy_hooks_creates_no_backup(tmp_data_home):
    import hub

    reg = _base_registry()
    _write_registry(tmp_data_home, reg)

    hub.load_registry()
    assert not _backup_dir(tmp_data_home).exists()
