"""Tests for migrate_harnesses_schema + registry round-trip (tasks 2.3, 2.4)."""

from __future__ import annotations

import yaml


def test_migration_sets_harnesses_global_to_claude_code():
    import hub

    reg = {"version": "1", "skills": {}, "projects": {}, "bundles": {}}
    changed = hub.migrate_harnesses_schema(reg)
    assert changed is True
    assert reg["harnesses_global"] == ["claude-code"]


def test_migration_sets_project_harnesses_to_pi():
    import hub

    reg = {
        "version": "1",
        "skills": {},
        "projects": {
            "alpha": {"path": "/a", "enabled": [], "bundles": []},
            "beta": {"path": "/b", "enabled": [], "bundles": []},
        },
        "bundles": {},
    }
    hub.migrate_harnesses_schema(reg)
    assert reg["projects"]["alpha"]["harnesses"] == ["pi"]
    assert reg["projects"]["beta"]["harnesses"] == ["pi"]


def test_migration_is_idempotent_no_op_second_call():
    import hub

    reg = {"version": "1", "skills": {}, "projects": {}, "bundles": {}}
    assert hub.migrate_harnesses_schema(reg) is True

    # Capture the post-migration shape
    snapshot = yaml.safe_dump(reg, sort_keys=False)

    assert hub.migrate_harnesses_schema(reg) is False
    assert yaml.safe_dump(reg, sort_keys=False) == snapshot


def test_migration_preserves_existing_values():
    """If a project already has harnesses, don't overwrite."""
    import hub

    reg = {
        "version": "1",
        "harnesses_global": ["claude-code", "codex"],
        "skills": {},
        "projects": {
            "alpha": {"path": "/a", "enabled": [], "bundles": [], "harnesses": ["codex"]},
        },
        "bundles": {},
    }
    assert hub.migrate_harnesses_schema(reg) is False  # idempotency marker
    assert reg["harnesses_global"] == ["claude-code", "codex"]
    assert reg["projects"]["alpha"]["harnesses"] == ["codex"]


def test_migration_applied_via_load_registry(tmp_data_home):
    """load_registry() applies migration on first read + persists."""
    import hub

    # Seed an unmigrated registry on disk
    reg_path = tmp_data_home / "registry.yaml"
    reg_path.write_text(
        yaml.safe_dump(
            {
                "version": "1",
                "skills": {},
                "projects": {
                    "alpha": {"path": "/a", "enabled": [], "bundles": []},
                },
                "bundles": {},
            },
            sort_keys=False,
        )
    )

    loaded = hub.load_registry()
    assert loaded["harnesses_global"] == ["claude-code"]
    assert loaded["projects"]["alpha"]["harnesses"] == ["pi"]

    # Persisted to disk
    on_disk = yaml.safe_load(reg_path.read_text())
    assert on_disk["harnesses_global"] == ["claude-code"]
    assert on_disk["projects"]["alpha"]["harnesses"] == ["pi"]


def test_save_registry_round_trip_preserves_new_fields(tmp_data_home):
    """Writing then re-reading must preserve harnesses_global + project harnesses."""
    import hub

    reg = {
        "version": "1",
        "harnesses_global": ["claude-code", "codex"],
        "skills": {},
        "projects": {
            "alpha": {
                "path": "/a",
                "enabled": ["s1"],
                "bundles": ["b1"],
                "harnesses": ["pi"],
            }
        },
        "bundles": {},
    }
    hub.save_registry(reg)
    reloaded = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert reloaded["harnesses_global"] == ["claude-code", "codex"]
    assert reloaded["projects"]["alpha"]["harnesses"] == ["pi"]
    assert reloaded["projects"]["alpha"]["bundles"] == ["b1"]
    assert reloaded["projects"]["alpha"]["enabled"] == ["s1"]


def test_save_registry_preserves_key_order(tmp_data_home):
    """save_registry uses sort_keys=False; top-level field order is preserved."""
    import hub

    reg = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": {},
        "projects": {},
        "bundles": {},
    }
    hub.save_registry(reg)
    text = (tmp_data_home / "registry.yaml").read_text()
    # `version` appears before `harnesses_global` in our dict order
    v_idx = text.index("version:")
    hg_idx = text.index("harnesses_global:")
    assert v_idx < hg_idx
