"""Disable lifecycle correctness (D7 / change rework-permissions-model §8).

Covers `hub permissions disable --mode {restore,detach}`:
- restore reverts a native file to its pre-hub backup, removes hub-granted
  Codex trust, deletes the hub-generated rules file, drops the registry block
  and sidecar;
- restore with NO pre-hub backup strips hub-managed keys in place (incl. Codex
  trust_level) and reports `no_backup` rather than leaving things diverged;
- detach leaves native files byte-for-byte unchanged and its message matches;
- a disabled (unmanaged) scope is skipped on subsequent sync.

Driven in-process via `hub.cmd_sync` + `hub.cmd_permissions_disable` with HOME
and harness detection monkeypatched per test (same pattern as the sync-stream
suite).
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


def _read_registry(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text())


def _disable_ns(mode: str, *, project=None, global_=False, all_=False,
                apply=False, json_out=False, harness=None) -> argparse.Namespace:
    return argparse.Namespace(
        mode=mode,
        project=project,
        global_=global_,
        all=all_,
        apply=apply,
        json=json_out,
        harness=harness,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Restore — reverts to backup, undoes Codex trust
# ─────────────────────────────────────────────────────────────────────────────


def test_restore_reverts_codex_config_removes_trust_and_rules(
    tmp_data_home, tmp_path, monkeypatch
):
    """A pre-hub config.toml backup is reinstated on restore: hub-granted
    trust_level disappears, skill-hub.rules is deleted, block + sidecar dropped."""
    fake_home = tmp_path / "home"
    (fake_home / ".codex").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))

    # Pre-hub config.toml with user content and NO trust_level.
    config = fake_home / ".codex" / "config.toml"
    original = 'model = "gpt-5"\n'
    config.write_text(original)

    proj_dir = tmp_path / "alpha"
    proj_dir.mkdir()

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"codex"})
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["codex"],
            "permissions_global": {},
            "projects": {
                "alpha": {
                    "path": str(proj_dir),
                    "harnesses": ["codex"],
                    "permissions": {
                        "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
                    },
                },
            },
            "skills": {},
        },
    )
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))

    # Sanity: hub wrote trust + a rules file.
    assert "trust_level" in config.read_text()
    proj_rules = proj_dir / ".codex" / "rules" / "skill-hub.rules"
    assert proj_rules.exists()

    # Restore.
    pa._reset_backup_session_state_for_tests()
    hub.cmd_permissions_disable(
        _disable_ns("restore", project="alpha", apply=True)
    )

    # Config reverted to its pre-hub bytes (trust gone).
    assert config.read_text() == original
    assert "trust_level" not in config.read_text()
    # Hub-generated rules file deleted.
    assert not proj_rules.exists()
    # Registry block dropped; harness marked unmanaged.
    reg = _read_registry(tmp_data_home)
    perms = reg["projects"]["alpha"].get("permissions", {})
    assert not perms.get("allow")
    assert "codex" in (perms.get("_unmanaged") or [])
    # Sidecars gone.
    from permissions import ProjectScope, read_sidecar

    scope = ProjectScope(name="alpha", path=str(proj_dir))
    assert read_sidecar("codex", scope) is None
    assert read_sidecar("codex", scope, kind="rules") is None


# ─────────────────────────────────────────────────────────────────────────────
# Restore — no backup: strip in place + report
# ─────────────────────────────────────────────────────────────────────────────


def test_restore_no_backup_strips_managed_keys_and_reports(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """With no pre-hub config.toml, restore surgically strips hub-managed keys
    (incl. trust_level) and flags `no_backup` instead of diverging."""
    fake_home = tmp_path / "home"
    (fake_home / ".codex").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))

    config = fake_home / ".codex" / "config.toml"
    assert not config.exists()  # no pre-hub file → no backup will be made

    proj_dir = tmp_path / "alpha"
    proj_dir.mkdir()

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"codex"})
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["codex"],
            "permissions_global": {},
            "projects": {
                "alpha": {
                    "path": str(proj_dir),
                    "harnesses": ["codex"],
                    "permissions": {
                        "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
                    },
                },
            },
            "skills": {},
        },
    )
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))
    assert "trust_level" in config.read_text()
    proj_rules = proj_dir / ".codex" / "rules" / "skill-hub.rules"
    assert proj_rules.exists()
    capsys.readouterr()  # drain the sync output before capturing disable --json

    # Restore --json to inspect the no_backup flag.
    pa._reset_backup_session_state_for_tests()
    hub.cmd_permissions_disable(
        _disable_ns("restore", project="alpha", apply=True, json_out=True)
    )
    body = json.loads(capsys.readouterr().out)
    entry = next(e for e in body["entries"] if e["harness_id"] == "codex")
    assert entry["no_backup"] is True
    assert entry["applied"] is True

    # trust_level stripped in place even without a backup.
    assert "trust_level" not in config.read_text()
    # Hub-generated rules file removed.
    assert not proj_rules.exists()
    # Sidecars gone.
    from permissions import ProjectScope, read_sidecar

    scope = ProjectScope(name="alpha", path=str(proj_dir))
    assert read_sidecar("codex", scope) is None
    assert read_sidecar("codex", scope, kind="rules") is None


# ─────────────────────────────────────────────────────────────────────────────
# Detach — native files untouched
# ─────────────────────────────────────────────────────────────────────────────


def test_detach_leaves_native_files_byte_identical(
    tmp_data_home, tmp_path, monkeypatch
):
    """detach drops hub's claim + registry block but leaves the native file
    byte-for-byte unchanged."""
    fake_home = tmp_path / "home"
    (fake_home / ".claude" / "projects").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))

    proj_dir = tmp_path / "alpha"
    (proj_dir / ".claude").mkdir(parents=True)

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["claude-code"],
            "permissions_global": {},
            "projects": {
                "alpha": {
                    "path": str(proj_dir),
                    "harnesses": ["claude-code"],
                    "permissions": {
                        "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
                    },
                },
            },
            "skills": {},
        },
    )
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))

    proj_settings = proj_dir / ".claude" / "settings.json"
    assert proj_settings.exists()
    before = proj_settings.read_bytes()

    pa._reset_backup_session_state_for_tests()
    hub.cmd_permissions_disable(
        _disable_ns("detach", project="alpha", apply=True)
    )

    # Native file untouched.
    assert proj_settings.read_bytes() == before
    # Registry block dropped, harness marked unmanaged.
    reg = _read_registry(tmp_data_home)
    perms = reg["projects"]["alpha"].get("permissions", {})
    assert not perms.get("allow")
    assert "claude-code" in (perms.get("_unmanaged") or [])


def test_detach_dry_run_message_matches_behavior(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """detach dry-run says it drops hub's claim and leaves rules in place — it
    does not claim a native rewrite."""
    fake_home = tmp_path / "home"
    (fake_home / ".claude" / "projects").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))

    proj_dir = tmp_path / "alpha"
    proj_dir.mkdir()

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["claude-code"],
            "permissions_global": {},
            "projects": {
                "alpha": {
                    "path": str(proj_dir),
                    "harnesses": ["claude-code"],
                    "permissions": {
                        "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
                    },
                },
            },
            "skills": {},
        },
    )
    hub.cmd_permissions_disable(
        _disable_ns("detach", project="alpha", apply=False)
    )
    out = capsys.readouterr().out
    assert "leave native files as-is" in out
    # detach entries must not be flagged will_write.
    hub.cmd_permissions_disable(
        _disable_ns("detach", project="alpha", apply=False, json_out=True)
    )
    body = json.loads(capsys.readouterr().out)
    for e in body["entries"]:
        assert e["action"] == "detach"
        assert e["will_write"] is False


# ─────────────────────────────────────────────────────────────────────────────
# Disabled scope skipped on subsequent sync
# ─────────────────────────────────────────────────────────────────────────────


def test_disabled_scope_skipped_on_subsequent_sync(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """After detach, a re-added rule in the same scope is NOT written on sync
    because the harness is in `_unmanaged`."""
    fake_home = tmp_path / "home"
    (fake_home / ".claude" / "projects").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))

    proj_dir = tmp_path / "alpha"
    (proj_dir / ".claude").mkdir(parents=True)

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["claude-code"],
            "permissions_global": {},
            "projects": {
                "alpha": {
                    "path": str(proj_dir),
                    "harnesses": ["claude-code"],
                    "permissions": {
                        "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
                    },
                },
            },
            "skills": {},
        },
    )
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))

    # Detach the project scope, then re-add a rule alongside the _unmanaged flag.
    pa._reset_backup_session_state_for_tests()
    hub.cmd_permissions_disable(
        _disable_ns("detach", project="alpha", apply=True)
    )
    capsys.readouterr()

    reg = _read_registry(tmp_data_home)
    reg["projects"]["alpha"]["permissions"]["allow"] = [
        {"pattern": "Bash(pytest:*)", "kind": "allow"}
    ]
    _seed_registry(tmp_data_home, reg)

    proj_settings = proj_dir / ".claude" / "settings.json"
    before = proj_settings.read_bytes() if proj_settings.exists() else None

    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))

    # The re-added rule must NOT have been written for the disabled harness.
    if proj_settings.exists():
        allow = json.loads(proj_settings.read_text()).get("permissions", {}).get(
            "allow", []
        )
        assert "Bash(pytest:*)" not in allow
    # File unchanged from pre-sync state.
    after = proj_settings.read_bytes() if proj_settings.exists() else None
    assert after == before
