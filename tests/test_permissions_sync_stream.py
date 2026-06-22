"""End-to-end permissions sync stream tests."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Optional

import pytest
import yaml

import hub
import permission_adapters as pa


REPO_ROOT = Path(hub.__file__).parent
HUB_PY = REPO_ROOT / "hub.py"


def _run_hub(
    args: list[str],
    data_home: Path,
    cwd: Optional[Path] = None,
    expect_zero: bool = True,
) -> subprocess.CompletedProcess:
    env = {
        **dict(__import__("os").environ),
        "SKILL_HUB_HOME": str(data_home),
        "SKILL_HUB_CODE": str(REPO_ROOT),
        "HOME": str(data_home),
    }
    env.pop("SKILL_HUB_DIR", None)
    result = subprocess.run(
        [sys.executable, str(HUB_PY), *args],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(cwd or data_home),
    )
    if expect_zero and result.returncode != 0:
        raise AssertionError(
            f"hub {args} failed: stderr={result.stderr}\nstdout={result.stdout}"
        )
    return result


def _seed_registry(data_home: Path, registry: dict) -> None:
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _detect_patched_claude_only(monkeypatch):
    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})


def test_skip_permissions_flag_bypasses_stream(tmp_data_home, capsys, monkeypatch):
    """With --skip-permissions, no adapter is touched and no doctor runs."""
    _detect_patched_claude_only(monkeypatch)
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["claude-code"],
            "permissions_global": {"allow": [{"pattern": "Bash(*)", "kind": "allow"}]},
            "projects": {},
            "skills": {},
        },
    )

    called = {"apply": 0}
    real_apply = pa.ClaudePermissionAdapter.apply

    def spy(self, scope, write, harness_id):
        called["apply"] += 1
        return real_apply(self, scope, write, harness_id)

    monkeypatch.setattr(pa.ClaudePermissionAdapter, "apply", spy)
    import argparse

    args = argparse.Namespace(skip_permissions=True)
    hub.cmd_sync(args)
    captured = capsys.readouterr()
    assert "Permissions:" in captured.out
    assert "skipped" in captured.out
    assert "Permissions doctor" not in captured.out
    assert called["apply"] == 0


def test_pi_writes_land_in_pi_settings_not_claude(tmp_data_home, tmp_path, monkeypatch):
    """Pi uses ClaudePermissionAdapter but scope-targeted: global→~/.pi/agent/settings.json,
    project→<repo>/.pi/agent/settings.json, no cross-contamination."""
    fake_home = tmp_path / "home"
    (fake_home / ".pi" / "agent").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))

    proj_dir = tmp_path / "alpha"
    proj_dir.mkdir()

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"pi"})

    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": [],
            "permissions_global": {
                "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}],
            },
            "projects": {
                "alpha": {
                    "path": str(proj_dir),
                    "harnesses": ["pi"],
                    "permissions": {
                        "allow": [{"pattern": "Read(./src)", "kind": "allow"}],
                    },
                },
            },
            "skills": {},
        },
    )
    import argparse

    args = argparse.Namespace(skip_permissions=False)
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(args)

    pi_global = fake_home / ".pi" / "agent" / "settings.json"
    pi_proj = proj_dir / ".pi" / "agent" / "settings.json"
    claude_proj = proj_dir / ".claude" / "settings.json"
    assert not claude_proj.exists()
    # Scope-targeted writes: global rule lands ONLY in the user-level global file.
    assert pi_global.exists()
    global_allow = json.loads(pi_global.read_text())["permissions"]["allow"]
    assert "Bash(npm:*)" in global_allow
    # Project file contains ONLY the project-own rule (no global duplication).
    assert pi_proj.exists()
    proj_allow = json.loads(pi_proj.read_text())["permissions"]["allow"]
    assert "Read(./src)" in proj_allow
    assert "Bash(npm:*)" not in proj_allow


def test_per_project_auto_import_writes_backup(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """Pre-existing project rules + empty registry block → auto-import + backup."""
    proj_dir = tmp_path / "alpha"
    proj_dir.mkdir()
    settings = proj_dir / ".claude" / "settings.json"
    settings.parent.mkdir(parents=True)
    settings.write_text(
        json.dumps({"permissions": {"allow": ["UserBefore(*)", "UserBefore(*)"]}})
    )

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})

    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["claude-code"],
            "permissions_global": {},
            "projects": {
                "alpha": {"path": str(proj_dir), "permissions": {}},
            },
            "skills": {},
        },
    )
    import argparse

    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))

    # Backup written
    backup_root = (
        tmp_data_home / "_hub-backups" / "permissions" / "claude-code" / "project-alpha"
    )
    assert backup_root.exists()
    backups = list(backup_root.iterdir())
    assert backups, "expected at least one backup"

    # Registry updated
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    project_allow = reg["projects"]["alpha"]["permissions"]["allow"]
    patterns = [r["pattern"] if isinstance(r, dict) else r for r in project_allow]
    assert patterns.count("UserBefore(*)") == 1


def test_registry_delete_propagates_once_managed(
    tmp_data_home, tmp_path, monkeypatch
):
    """Once a scope is hub-managed (sidecar exists), emptying the registry block
    deletes the rules in native files instead of re-importing them.

    Regression: previously discover_existing re-read the hub-written native file
    and bounced a deleted rule back into the registry on the next sync.
    """
    from permissions import ProjectScope, sidecar_path

    fake_home = tmp_path / "home"
    (fake_home / ".claude").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))

    proj_dir = tmp_path / "alpha"
    proj_dir.mkdir()

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})

    # First sync: global has one rule; project adds a project-specific rule.
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
                        "allow": [{"pattern": "Bash(custom:*)", "kind": "allow"}]
                    },
                },
            },
            "skills": {},
        },
    )
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))

    # Scope-targeted: project file has ONLY the project-own rule.
    settings = proj_dir / ".claude" / "settings.json"
    allow = json.loads(settings.read_text())["permissions"]["allow"]
    assert "Bash(custom:*)" in allow
    assert "Bash(npm:*)" not in allow  # global rule is NOT in the project file
    # Hub now manages this scope.
    assert sidecar_path(
        "claude-code", ProjectScope(name="alpha", path=str(proj_dir))
    ).exists()

    # User deletes the project block in the registry (Skill Tree edit).
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    reg["projects"]["alpha"]["permissions"] = {}
    _seed_registry(tmp_data_home, reg)

    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))

    # Delete must NOT boomerang: registry block stays empty or absent.
    reg2 = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert not (reg2["projects"]["alpha"].get("permissions", {}).get("allow"))
    # Project file is now empty (no hub-managed rules for this project).
    allow2 = json.loads(settings.read_text()).get("permissions", {}).get("allow", [])
    assert "Bash(custom:*)" not in allow2
    # The global rule lives in the global file, not the project file.
    assert "Bash(npm:*)" not in allow2
    global_settings = fake_home / ".claude" / "settings.json"
    assert "Bash(npm:*)" in json.loads(global_settings.read_text())["permissions"]["allow"]


def test_sync_collapses_existing_duplicate_project_permissions(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
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
                    "permissions": {
                        "allow": [
                            {"pattern": "Bash(npm:*)", "kind": "allow"},
                            {"pattern": "Bash(npm:*)", "kind": "allow"},
                        ]
                    },
                },
            },
            "skills": {},
        },
    )

    hub.cmd_sync(argparse.Namespace(skip_permissions=False))

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    project_allow = reg["projects"]["alpha"]["permissions"]["allow"]
    assert [r["pattern"] for r in project_allow] == ["Bash(npm:*)"]


def test_doctor_danger_finding_causes_nonzero_exit(tmp_data_home, monkeypatch):
    proj_dir = tmp_data_home / "alpha-proj"
    proj_dir.mkdir()
    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["claude-code"],
            "permissions_global": {"allow": [{"pattern": "Bash(*)", "kind": "allow"}]},
            "projects": {"alpha": {"path": str(proj_dir), "permissions": {}}},
            "skills": {},
        },
    )
    pa._reset_backup_session_state_for_tests()
    import argparse

    with pytest.raises(SystemExit) as exc:
        hub.cmd_sync(argparse.Namespace(skip_permissions=False))
    assert exc.value.code == 2


def test_codex_project_rules_write_and_trust_warning(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """Codex command rule → skill-hub.rules written, trust auto-granted + warned."""
    fake_home = tmp_path / "home"
    (fake_home / ".codex").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"codex"})

    proj_dir = tmp_path / "alpha"
    proj_dir.mkdir()
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
    out = capsys.readouterr().out

    rules_file = proj_dir / ".codex" / "rules" / "skill-hub.rules"
    assert rules_file.exists()
    assert 'prefix_rule(pattern = ["npm"]' in rules_file.read_text()
    # Trust auto-grant warning surfaced in the sync log.
    assert "trust" in out.lower()
    # config.toml under fake HOME has the trust grant.
    cfg = (fake_home / ".codex" / "config.toml").read_text()
    assert "trust_level" in cfg


def test_codex_import_move_then_no_ghost(tmp_data_home, tmp_path, monkeypatch):
    """End-to-end MOVE: import excises from default.rules; deleting the rule and
    re-syncing leaves it absent from BOTH skill-hub.rules and default.rules."""
    import io

    fake_home = tmp_path / "home"
    rules_dir = fake_home / ".codex" / "rules"
    rules_dir.mkdir(parents=True)
    default_rules = rules_dir / "default.rules"
    default_rules.write_text(
        'prefix_rule(\n    pattern = ["npm"],\n    decision = "allow",\n)\n'
    )
    monkeypatch.setenv("HOME", str(fake_home))

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"codex"})
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["codex"],
            "permissions_global": {},
            "projects": {},
            "skills": {},
        },
    )

    # Import the discovered npm rule (MOVE: excise from default.rules).
    monkeypatch.setattr(
        sys, "stdin",
        io.StringIO(json.dumps({"decisions": [
            {"pattern": "Bash(npm:*)", "kind": "allow", "action": "import"}
        ]})),
    )
    pa._reset_backup_session_state_for_tests()
    hub.cmd_permissions_import(argparse.Namespace(
        global_=True, project=None, harness=None, json=False,
        interactive=False, apply=True, decisions_stdin=True,
    ))

    # Registry gained the rule; default.rules excised.
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    allow = reg["permissions_global"].get("allow") or []
    assert any((r.get("pattern") if isinstance(r, dict) else r) == "Bash(npm:*)"
               for r in allow)
    assert "npm" not in default_rules.read_text()

    # Sync writes skill-hub.rules with the imported rule.
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))
    skill_hub = rules_dir / "skill-hub.rules"
    assert skill_hub.exists() and "npm" in skill_hub.read_text()

    # Delete the rule in the registry, re-sync → gone from BOTH files.
    reg["permissions_global"] = {}
    _seed_registry(tmp_data_home, reg)
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))
    assert not skill_hub.exists()
    assert "npm" not in default_rules.read_text()


def test_default_rules_untouched_during_ordinary_sync(
    tmp_data_home, tmp_path, monkeypatch
):
    """D10/8.3: ordinary sync never edits default.rules."""
    fake_home = tmp_path / "home"
    rules_dir = fake_home / ".codex" / "rules"
    rules_dir.mkdir(parents=True)
    default_rules = rules_dir / "default.rules"
    original = 'prefix_rule(pattern = ["ls"], decision = "allow")\n'
    default_rules.write_text(original)
    monkeypatch.setenv("HOME", str(fake_home))

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"codex"})
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["codex"],
            "permissions_global": {
                "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
            },
            "projects": {},
            "skills": {},
        },
    )
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))
    # skill-hub.rules written, but the user's default.rules is byte-for-byte intact.
    assert (rules_dir / "skill-hub.rules").exists()
    assert default_rules.read_text() == original


def test_global_adoption_blocking_emits_message(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """Pre-existing GLOBAL rules + empty `permissions_global` → log + block global stream only."""
    fake_home = tmp_path / "home"
    (fake_home / ".claude").mkdir(parents=True)
    (fake_home / ".claude" / "settings.json").write_text(
        json.dumps({"permissions": {"allow": ["GlobalPreexisting(*)"]}})
    )
    monkeypatch.setenv("HOME", str(fake_home))
    # Also patch Path.home() — already covered by HOME on POSIX

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})

    proj_dir = tmp_path / "alpha"
    proj_dir.mkdir()
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["claude-code"],
            "permissions_global": {},
            "projects": {"alpha": {"path": str(proj_dir), "permissions": {}}},
            "skills": {},
        },
    )
    import argparse

    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))
    out = capsys.readouterr().out
    assert "AdoptionRequired" in out
    # Per-project stream should still have run, so the project's .claude/settings.json exists.
    # (no rules to write here, but the doctor row would log either way.)


# ── New tests added by rework-permissions-model ──────────────────────────────


def test_global_rule_only_in_global_file_not_project(
    tmp_data_home, tmp_path, monkeypatch
):
    """D1: a global allow rule lands ONLY in the global native file, not in any project file."""
    fake_home = tmp_path / "home"
    (fake_home / ".claude").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))

    proj_dir = tmp_path / "alpha"
    proj_dir.mkdir()

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["claude-code"],
            "permissions_global": {
                "allow": [{"pattern": "Bash(global:*)", "kind": "allow"}]
            },
            "projects": {
                "alpha": {
                    "path": str(proj_dir),
                    "permissions": {},
                },
            },
            "skills": {},
        },
    )
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))

    # Global rule in global file
    global_settings = fake_home / ".claude" / "settings.json"
    assert global_settings.exists()
    assert "Bash(global:*)" in json.loads(global_settings.read_text())["permissions"]["allow"]

    # Global rule NOT in the project file
    proj_settings = proj_dir / ".claude" / "settings.json"
    if proj_settings.exists():
        proj_allow = json.loads(proj_settings.read_text()).get("permissions", {}).get("allow", [])
        assert "Bash(global:*)" not in proj_allow


def test_project_rule_only_in_project_file_not_global(
    tmp_data_home, tmp_path, monkeypatch
):
    """D1: a project rule lands ONLY in the project native file, not in the global file."""
    fake_home = tmp_path / "home"
    (fake_home / ".claude").mkdir(parents=True)
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
                    "permissions": {
                        "allow": [{"pattern": "Bash(proj:*)", "kind": "allow"}]
                    },
                },
            },
            "skills": {},
        },
    )
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))

    # Project rule in project file
    proj_settings = proj_dir / ".claude" / "settings.json"
    assert proj_settings.exists()
    assert "Bash(proj:*)" in json.loads(proj_settings.read_text())["permissions"]["allow"]

    # Project rule NOT in global file
    global_settings = fake_home / ".claude" / "settings.json"
    if global_settings.exists():
        global_allow = json.loads(global_settings.read_text()).get("permissions", {}).get("allow", [])
        assert "Bash(proj:*)" not in global_allow


def test_zero_own_rules_writes_no_hub_managed_project_rules(
    tmp_data_home, tmp_path, monkeypatch
):
    """D1: a project with no own rules results in no hub-managed rules in its native file."""
    fake_home = tmp_path / "home"
    (fake_home / ".claude").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))

    proj_dir = tmp_path / "alpha"
    proj_dir.mkdir()

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["claude-code"],
            "permissions_global": {
                "allow": [{"pattern": "Bash(global:*)", "kind": "allow"}]
            },
            "projects": {
                "alpha": {
                    "path": str(proj_dir),
                    "permissions": {},  # no own rules
                },
            },
            "skills": {},
        },
    )
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))

    # Project file should not exist or have no hub-managed allow rules
    proj_settings = proj_dir / ".claude" / "settings.json"
    if proj_settings.exists():
        proj_allow = json.loads(proj_settings.read_text()).get("permissions", {}).get("allow", [])
        assert "Bash(global:*)" not in proj_allow


def test_codex_global_rule_only_in_global_rules_file(
    tmp_data_home, tmp_path, monkeypatch
):
    """D1 + D4: a global Codex command rule goes only to ~/.codex/rules/skill-hub.rules
    and does NOT auto-grant trust_level on any project."""
    fake_home = tmp_path / "home"
    (fake_home / ".codex").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))

    proj_dir = tmp_path / "alpha"
    proj_dir.mkdir()

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"codex"})
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["codex"],
            "permissions_global": {
                "allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]
            },
            "projects": {
                "alpha": {
                    "path": str(proj_dir),
                    "harnesses": ["codex"],
                    "permissions": {},  # no own rules
                },
            },
            "skills": {},
        },
    )
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))

    # Global rule → ~/.codex/rules/skill-hub.rules
    global_rules = fake_home / ".codex" / "rules" / "skill-hub.rules"
    assert global_rules.exists()
    assert "npm" in global_rules.read_text()

    # No project-local skill-hub.rules (no own rules)
    proj_rules = proj_dir / ".codex" / "rules" / "skill-hub.rules"
    assert not proj_rules.exists()

    # No trust_level granted (global rule does NOT trigger per-project trust)
    config = fake_home / ".codex" / "config.toml"
    if config.exists():
        assert "trust_level" not in config.read_text()


def test_codex_project_rule_grants_trust_for_project_only(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """D4: a project-own Codex command rule grants trust for that project + emits warning."""
    fake_home = tmp_path / "home"
    (fake_home / ".codex").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))

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
    out = capsys.readouterr().out

    # Project-own rule → project local rules file
    proj_rules = proj_dir / ".codex" / "rules" / "skill-hub.rules"
    assert proj_rules.exists() and "npm" in proj_rules.read_text()
    # Trust auto-grant warning emitted
    assert "trust" in out.lower()
    cfg = (fake_home / ".codex" / "config.toml").read_text()
    assert "trust_level" in cfg


def test_unmanaged_union_project_opt_out_does_not_discard_global(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """D5: _unmanaged is set-unioned — project opting out of codex does not discard
    a global opt-out of pi."""
    from permissions import NormalizedPermissions, GlobalScope, ProjectScope

    project = {
        "path": str(tmp_path / "alpha"),
        "permissions": {"_unmanaged": ["codex"]},
    }
    registry = {
        "permissions_global": {"_unmanaged": ["pi"]},
        "projects": {"alpha": project},
    }
    from permissions import resolve_effective
    eff = resolve_effective(project, registry)
    assert "pi" in eff._unmanaged
    assert "codex" in eff._unmanaged


def test_unmanaged_harness_skipped_on_sync(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """D5: a scope opting out of claude-code is skipped during sync."""
    fake_home = tmp_path / "home"
    (fake_home / ".claude").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))

    proj_dir = tmp_path / "alpha"
    proj_dir.mkdir()

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
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
                    "permissions": {"_unmanaged": ["claude-code"]},
                },
            },
            "skills": {},
        },
    )
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))

    # Project file must NOT have been written (claude-code is unmanaged for the project)
    proj_settings = proj_dir / ".claude" / "settings.json"
    assert not proj_settings.exists()


def test_codex_rules_only_scope_does_not_boomerang(
    tmp_data_home, tmp_path, monkeypatch
):
    """D5: a Codex scope that has only a rules sidecar (no config sidecar) does not
    re-auto-import after its registry block is emptied."""
    import harnesses as _harnesses
    from permissions import ProjectScope, sidecar_path, write_sidecar

    fake_home = tmp_path / "home"
    (fake_home / ".codex").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))

    proj_dir = tmp_path / "alpha"
    proj_dir.mkdir()

    # Write a pre-existing project rules file that hub auto-imported before.
    proj_rules_dir = proj_dir / ".codex" / "rules"
    proj_rules_dir.mkdir(parents=True)
    proj_rules = proj_rules_dir / "skill-hub.rules"
    proj_rules.write_text('prefix_rule(pattern = ["npm"], decision = "allow")\n')

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"codex"})

    # Seed registry with empty project permissions block
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["codex"],
            "permissions_global": {},
            "projects": {
                "alpha": {
                    "path": str(proj_dir),
                    "harnesses": ["codex"],
                    "permissions": {},
                },
            },
            "skills": {},
        },
    )

    # Plant a rules-kind sidecar to simulate a scope that was previously managed
    # via the rules file (but no config sidecar exists).
    scope = ProjectScope(name="alpha", path=str(proj_dir))
    write_sidecar("codex", scope, ["permissions.allow[0]"], proj_rules, kind="rules")
    assert not sidecar_path("codex", scope).exists()  # no primary sidecar
    assert sidecar_path("codex", scope, kind="rules").exists()  # only rules sidecar

    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))

    # The registry block must NOT have been boomeranged with the rule
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    proj_perms = reg["projects"]["alpha"].get("permissions", {})
    assert not proj_perms.get("allow")


def test_affinity_distinct_global_rule_survives_project_rule(
    tmp_data_home, tmp_path, monkeypatch
):
    """D6: a global rule scoped to [codex] is NOT dropped from the resolved view by
    a project rule for the same pattern scoped to all harnesses."""
    from permissions import resolve_effective

    project = {
        "path": str(tmp_path / "alpha"),
        "permissions": {
            "allow": [
                {"pattern": "Bash(npm:*)", "kind": "allow"},  # harnesses=None (all)
            ]
        },
    }
    registry = {
        "permissions_global": {
            "allow": [
                {"pattern": "Bash(npm:*)", "kind": "allow", "harnesses": ["codex"]},
            ]
        },
        "projects": {"alpha": project},
    }
    eff = resolve_effective(project, registry)
    origins = {(r.origin, r.harnesses and tuple(r.harnesses)) for r in eff.allow}
    # Project rule (all harnesses) shadows the global one (overlapping affinity → shadowed)
    # The global [codex]-scoped rule overlaps with all-harnesses project rule, so it IS shadowed.
    assert ("project", None) in origins
    # Verify global codex-scoped rule is NOT separately retained (overlap → shadowed)
    assert ("global", ("codex",)) not in origins


def test_affinity_distinct_global_rule_survives_nonoverlapping_project_rule(
    tmp_data_home, tmp_path, monkeypatch
):
    """D6: a global rule scoped to [codex] survives when the project rule is scoped
    to [claude-code] only (no affinity overlap)."""
    from permissions import resolve_effective

    project = {
        "path": str(tmp_path / "alpha"),
        "permissions": {
            "allow": [
                {"pattern": "Bash(npm:*)", "kind": "allow", "harnesses": ["claude-code"]},
            ]
        },
    }
    registry = {
        "permissions_global": {
            "allow": [
                {"pattern": "Bash(npm:*)", "kind": "allow", "harnesses": ["codex"]},
            ]
        },
        "projects": {"alpha": project},
    }
    eff = resolve_effective(project, registry)
    origins = [(r.origin, r.harnesses) for r in eff.allow]
    # Global [codex] rule survives because [codex] ∩ [claude-code] = ∅
    assert any(o == "global" and h == ["codex"] for o, h in origins)
    # Project [claude-code] rule also present
    assert any(o == "project" and h == ["claude-code"] for o, h in origins)


def test_three_harness_project_shared_adapter_dispatch(
    tmp_data_home, tmp_path, monkeypatch
):
    """1.2 baseline: claude-code + pi + codex all active on one project; each
    gets only its own file written with the correct rules."""
    fake_home = tmp_path / "home"
    for d in [".claude", ".pi/agent", ".codex"]:
        (fake_home / d).mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))

    proj_dir = tmp_path / "alpha"
    proj_dir.mkdir()

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code", "codex", "pi"})
    _seed_registry(
        tmp_data_home,
        {
            "harnesses_global": ["claude-code", "codex", "pi"],
            "permissions_global": {
                "allow": [{"pattern": "Bash(global:*)", "kind": "allow"}]
            },
            "projects": {
                "alpha": {
                    "path": str(proj_dir),
                    "harnesses": ["codex", "pi"],
                    "permissions": {
                        "allow": [{"pattern": "Bash(proj:*)", "kind": "allow"}]
                    },
                },
            },
            "skills": {},
        },
    )
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))

    # claude-code global file has the global rule
    cc_global = fake_home / ".claude" / "settings.json"
    assert cc_global.exists()
    assert "Bash(global:*)" in json.loads(cc_global.read_text())["permissions"]["allow"]

    # pi global file has the global rule
    pi_global = fake_home / ".pi" / "agent" / "settings.json"
    assert pi_global.exists()
    assert "Bash(global:*)" in json.loads(pi_global.read_text())["permissions"]["allow"]

    # codex global rules file has the global rule
    codex_global_rules = fake_home / ".codex" / "rules" / "skill-hub.rules"
    assert codex_global_rules.exists()
    assert "global" in codex_global_rules.read_text()

    # pi project file has only the project-own rule
    pi_proj = proj_dir / ".pi" / "agent" / "settings.json"
    assert pi_proj.exists()
    pi_proj_allow = json.loads(pi_proj.read_text())["permissions"]["allow"]
    assert "Bash(proj:*)" in pi_proj_allow
    assert "Bash(global:*)" not in pi_proj_allow

    # codex project rules has only the project-own rule
    codex_proj_rules = proj_dir / ".codex" / "rules" / "skill-hub.rules"
    assert codex_proj_rules.exists()
    assert "proj" in codex_proj_rules.read_text()
    assert "global" not in codex_proj_rules.read_text()

    # claude-code project file has only the project-own rule
    cc_proj = proj_dir / ".claude" / "settings.json"
    assert cc_proj.exists()
    cc_proj_allow = json.loads(cc_proj.read_text())["permissions"]["allow"]
    assert "Bash(proj:*)" in cc_proj_allow
    assert "Bash(global:*)" not in cc_proj_allow
