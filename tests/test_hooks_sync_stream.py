"""Hooks sync stream + shared doctor rollup + sidecar handover (hooks-surface
tasks 2.2 / 2.3 / 2.4).

These drive `hub.cmd_sync` directly with `detect_installed` monkeypatched and a
fake HOME so global-scope hook writes land in an isolated tree. The capability
probe is real for claude-code (installed ⇒ SUPPORTED, no subprocess); scenarios
that need FEATURE_OFF / uninstall monkeypatch `harness_probe.probe_and_cache`.
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

import hub
import permission_adapters as pa
from harness_probe import FEATURE_OFF, NOT_INSTALLED, SUPPORTED, HookCapability
from permissions import GlobalScope, ProjectScope, read_sidecar, write_sidecar

REPO_ROOT = Path(__file__).resolve().parent.parent
LSP_SCRIPT = REPO_ROOT / "hooks" / "lsp-report" / "lsp_report.py"


def _seed(data_home: Path, registry: dict) -> None:
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _claude_only(monkeypatch, installed=("claude-code",)):
    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: set(installed))


def _fake_home(monkeypatch, tmp_path) -> Path:
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    return home


def _base_registry(proj_path: Path, *, with_hook=True, with_perm_danger=False) -> dict:
    reg: dict = {
        "harnesses_global": ["claude-code"],
        "permissions_global": {},
        "projects": {"alpha": {"path": str(proj_path), "permissions": {}}},
        "skills": {},
    }
    if with_hook:
        reg["hooks"] = {
            "myhook": {
                "event": "PostToolUse",
                "matcher": "Edit",
                "command": "/bin/echo hi",
            }
        }
        reg["hooks_global"] = ["myhook"]
    if with_perm_danger:
        reg["permissions_global"] = {"allow": [{"pattern": "Bash(*)", "kind": "allow"}]}
    return reg


# ─────────────────────────────────────────────────────────────────────────────
# Task 2.3 — stream wiring
# ─────────────────────────────────────────────────────────────────────────────


def test_hooks_stream_writes_global_and_project(tmp_data_home, tmp_path, monkeypatch, capsys):
    _claude_only(monkeypatch)
    home = _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _base_registry(proj))
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace())
    out = capsys.readouterr().out
    assert "Hooks:" in out

    g = json.loads((home / ".claude" / "settings.json").read_text())
    assert g["hooks"]["PostToolUse"][0]["hooks"][0]["command"] == "/bin/echo hi"
    # Project scope routes to the personal, gitignored settings.local.json.
    local = json.loads((proj / ".claude" / "settings.local.json").read_text())
    assert local["hooks"]["PostToolUse"][0]["matcher"] == "Edit"


def test_skip_hooks_skips_only_hooks(tmp_data_home, tmp_path, monkeypatch, capsys):
    _claude_only(monkeypatch)
    home = _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    reg = _base_registry(proj)
    reg["permissions_global"] = {"allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]}
    _seed(tmp_data_home, reg)
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace(skip_hooks=True))
    out = capsys.readouterr().out
    assert "Hooks:" in out and "skipped" in out

    g = json.loads((home / ".claude" / "settings.json").read_text())
    # Permissions still ran…
    assert "Bash(npm:*)" in g["permissions"]["allow"]
    # …but no hooks were written.
    assert "hooks" not in g


def test_permissions_then_hooks_share_settings_no_corruption(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """Global permissions + a global hook both target ~/.claude/settings.json.
    The file must hold BOTH sections and stay valid JSON (no interleaving)."""
    _claude_only(monkeypatch)
    home = _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    reg = _base_registry(proj)
    reg["permissions_global"] = {"allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]}
    _seed(tmp_data_home, reg)
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    raw = (home / ".claude" / "settings.json").read_text()
    data = json.loads(raw)  # valid JSON (no corruption)
    assert "Bash(npm:*)" in data["permissions"]["allow"]
    assert data["hooks"]["PostToolUse"][0]["hooks"][0]["command"] == "/bin/echo hi"
    # The two writers use disjoint sidecars.
    perms_sc = read_sidecar("claude-code", GlobalScope(), "")
    hooks_sc = read_sidecar("claude-code", GlobalScope(), "hooks")
    assert any(k.startswith("permissions.") for k in perms_sc.managed_keys)
    assert not any(k.startswith("hooks.") for k in perms_sc.managed_keys)
    assert all(k.startswith("hooks.") for k in hooks_sc.managed_keys)


def test_feature_off_keeps_entries_and_surfaces_disabled(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    _claude_only(monkeypatch)
    home = _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _base_registry(proj))
    pa._reset_backup_session_state_for_tests()

    # First sync (SUPPORTED) writes the hook.
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    settings = home / ".claude" / "settings.json"
    before = settings.read_text()
    assert "PostToolUse" in before

    # Second sync with the feature toggled OFF: entries kept, disabled surfaced.
    import harness_probe

    def _feature_off(*a, **k):
        return {"claude-code": HookCapability("claude-code", FEATURE_OFF, "off")}

    monkeypatch.setattr(harness_probe, "probe_and_cache", _feature_off)
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace())
    out = capsys.readouterr().out
    assert "feature off" in out
    # File unchanged — entries preserved, not stripped.
    assert settings.read_text() == before


def test_uninstalled_harness_gets_cleaned(tmp_data_home, tmp_path, monkeypatch, capsys):
    _claude_only(monkeypatch)
    home = _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _base_registry(proj))
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    settings = home / ".claude" / "settings.json"
    assert "PostToolUse" in settings.read_text()

    # Now claude-code is uninstalled — the cleanup pass strips its native hooks.
    _claude_only(monkeypatch, installed=())
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    data = json.loads(settings.read_text())
    assert "hooks" not in data
    assert read_sidecar("claude-code", GlobalScope(), "hooks") is None


def test_project_narrowing_away_from_a_harness_cleans_that_projects_hooks(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """A project's own additive `harnesses:` list narrowing away from a harness
    (while that harness stays installed and could still be effective for OTHER
    projects) must strip THIS project's now-orphaned native hook entries —
    `apply()` is never called again for a harness no longer in this project's
    effective set, so only an explicit per-project cleanup catches it."""
    _claude_only(monkeypatch)
    home = _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    reg = _base_registry(proj)
    reg["harnesses_global"] = []  # nothing globally on
    reg["projects"]["alpha"]["harnesses"] = ["claude-code"]  # additive, per-project
    _seed(tmp_data_home, reg)
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    settings = proj / ".claude" / "settings.local.json"
    assert "PostToolUse" in settings.read_text()

    # Narrow the project's own harnesses list away from claude-code entirely.
    reg["projects"]["alpha"]["harnesses"] = []
    _seed(tmp_data_home, reg)
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace())
    out = capsys.readouterr().out
    assert "no longer effective for this project" in out
    data = json.loads(settings.read_text())
    assert "hooks" not in data
    assert read_sidecar("claude-code", ProjectScope(name="alpha", path=str(proj)), "hooks") is None


def test_installed_harness_with_not_installed_probe_verdict_keeps_entries(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """A harness genuinely installed (per `detect_installed`, the config-dir
    marker check) must NEVER be cleaned just because the probe's narrower
    `shutil.which` binary lookup came back NOT_INSTALLED (e.g. a transient PATH
    miss in a hermetic subprocess environment) — that combination used to be
    treated as "uninstalled" and would silently strip the harness's real hooks.
    """
    import harnesses as _harnesses

    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".codex").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"codex"})
    proj = tmp_path / "alpha"
    proj.mkdir()
    reg = _base_registry(proj)
    reg["harnesses_global"] = ["codex"]
    _seed(tmp_data_home, reg)
    pa._reset_backup_session_state_for_tests()

    # Hermetic: force the probe verdict rather than relying on a real `codex`
    # binary being on the test runner's PATH (it may not be, e.g. in CI).
    import harness_probe

    def _probe_supported(*a, **k):
        return {"codex": HookCapability("codex", SUPPORTED, "installed")}

    def _probe_not_installed(*a, **k):
        return {"codex": HookCapability("codex", NOT_INSTALLED, "codex binary not found on PATH")}

    # First sync: codex is installed and SUPPORTED — hook is written for real.
    monkeypatch.setattr(harness_probe, "probe_and_cache", _probe_supported)
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    config_toml = home / ".codex" / "config.toml"
    before = config_toml.read_text()
    assert "hooks" in before

    # Second sync: `detect_installed` still says codex IS installed, but the
    # probe (e.g. its `codex` binary lookup failing on a stripped PATH) reports
    # NOT_INSTALLED. The cleanup pass must NOT strip codex's real hooks.
    monkeypatch.setattr(harness_probe, "probe_and_cache", _probe_not_installed)
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    assert config_toml.read_text() == before  # untouched — codex is still installed
    assert read_sidecar("codex", GlobalScope(), "hooks") is not None


# ─────────────────────────────────────────────────────────────────────────────
# Task 2.2 — legacy permissions→hooks sidecar handover
# ─────────────────────────────────────────────────────────────────────────────


def test_sidecar_handover_no_orphans_after_full_cycle(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """A pre-release install: a hook entry in ~/.claude/settings.json tracked by a
    hooks.* key in the PERMISSIONS sidecar. After a full sync cycle it must be
    owned by the hooks-kind sidecar, with exactly ONE native entry (no dup)."""
    _claude_only(monkeypatch)
    home = _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()

    settings = home / ".claude" / "settings.json"
    settings.write_text(json.dumps({
        "permissions": {"allow": ["Read(*)"]},
        "hooks": {
            "PostToolUse": [
                {"matcher": "Edit", "hooks": [{"type": "command", "command": "/bin/echo hi"}]}
            ]
        },
    }, indent=2) + "\n")
    # Legacy permissions sidecar tracks BOTH a perm rule and the hook.
    write_sidecar(
        "claude-code",
        GlobalScope(),
        ["permissions.allow[0]", "hooks.PostToolUse[0]"],
        settings,
        "",
    )

    reg = _base_registry(proj)
    reg["permissions_global"] = {"allow": [{"pattern": "Read(*)", "kind": "allow"}]}
    _seed(tmp_data_home, reg)
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    # The permissions sidecar no longer claims any hook key.
    perms_sc = read_sidecar("claude-code", GlobalScope(), "")
    assert not any(k.startswith("hooks.") for k in perms_sc.managed_keys)
    # Exactly one native hook entry (old removed, hooks stream re-wrote once).
    data = json.loads(settings.read_text())
    assert len(data["hooks"]["PostToolUse"]) == 1
    # And it is now owned by the hooks-kind sidecar.
    hooks_sc = read_sidecar("claude-code", GlobalScope(), "hooks")
    assert [k.split("#", 1)[0] for k in hooks_sc.managed_keys] == ["hooks.PostToolUse[0]"]


def test_handover_helper_is_idempotent(tmp_data_home, tmp_path, monkeypatch):
    home = _fake_home(monkeypatch, tmp_path)
    settings = home / ".claude" / "settings.json"
    settings.write_text(json.dumps({
        "hooks": {"PostToolUse": [
            {"matcher": "Edit", "hooks": [{"type": "command", "command": "/x"}]}
        ]}
    }) + "\n")
    write_sidecar("claude-code", GlobalScope(), ["hooks.PostToolUse[0]"], settings, "")

    first = hub.migrate_permissions_hook_sidecars()
    assert len(first) == 1 and first[0]["removed_keys"] == ["hooks.PostToolUse[0]"]
    # Second run: nothing left to migrate.
    assert hub.migrate_permissions_hook_sidecars() == []


def test_handover_backs_up_the_native_file_before_stripping(
    tmp_data_home, tmp_path, monkeypatch
):
    """HOOKS-BUG-03: the handover rewrites a real user settings file. It was the
    one native write path with NO backup — an unrecoverable edit if the strip is
    wrong. Exactly one backup must land, byte-equal to the PRE-strip file."""
    home = _fake_home(monkeypatch, tmp_path)
    settings = home / ".claude" / "settings.json"
    original = json.dumps({
        "model": "opus",
        "hooks": {"PostToolUse": [
            {"matcher": "Edit", "hooks": [{"type": "command", "command": "/x"}]}
        ]},
    }, indent=2) + "\n"
    settings.write_text(original)
    write_sidecar("claude-code", GlobalScope(), ["hooks.PostToolUse[0]"], settings, "")
    pa._reset_backup_session_state_for_tests()

    assert len(hub.migrate_permissions_hook_sidecars()) == 1
    assert "PostToolUse" not in settings.read_text()      # the strip happened

    backup_dir = (
        tmp_data_home / "_hub-backups" / "permissions" / "claude-code" / "global"
    )
    backups = list(backup_dir.glob("*.json"))
    assert len(backups) == 1
    assert backups[0].read_text() == original


# ─────────────────────────────────────────────────────────────────────────────
# Task 2.4 — shared doctor rollup skip-flag matrix
# ─────────────────────────────────────────────────────────────────────────────


def _danger_registry(tmp_data_home, tmp_path, monkeypatch):
    _claude_only(monkeypatch)
    _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _base_registry(proj, with_perm_danger=True))
    pa._reset_backup_session_state_for_tests()
    return proj


def test_doctor_runs_by_default_and_danger_exits(tmp_data_home, tmp_path, monkeypatch, capsys):
    _danger_registry(tmp_data_home, tmp_path, monkeypatch)
    with pytest.raises(SystemExit) as exc:
        hub.cmd_sync(argparse.Namespace())
    assert exc.value.code == 2
    assert "Doctor:" in capsys.readouterr().out


def test_skip_permissions_doctor_still_runs_no_perm_danger(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    _danger_registry(tmp_data_home, tmp_path, monkeypatch)
    # Permissions skipped ⇒ the Bash(*) danger is not scanned; doctor still runs
    # (covering hooks) and does not exit non-zero here.
    hub.cmd_sync(argparse.Namespace(skip_permissions=True))
    out = capsys.readouterr().out
    assert "Doctor:" in out
    assert "UNBOUNDED_BASH" not in out


def test_skip_hooks_doctor_still_covers_permissions_danger(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    _danger_registry(tmp_data_home, tmp_path, monkeypatch)
    with pytest.raises(SystemExit) as exc:
        hub.cmd_sync(argparse.Namespace(skip_hooks=True))
    assert exc.value.code == 2
    out = capsys.readouterr().out
    assert "Doctor:" in out and "UNBOUNDED_BASH" in out


def test_both_skipped_doctor_does_not_run(tmp_data_home, tmp_path, monkeypatch, capsys):
    _danger_registry(tmp_data_home, tmp_path, monkeypatch)
    # Neither stream ran ⇒ no doctor, no danger exit.
    hub.cmd_sync(argparse.Namespace(skip_permissions=True, skip_hooks=True))
    out = capsys.readouterr().out
    assert "Doctor:" not in out


# ─────────────────────────────────────────────────────────────────────────────
# The REAL built-in lsp-report, end-to-end through `hub sync`
#
# Everything above (and every lsp_report_sync unit test) works from a hand-built
# `ResolvedHook` or a monkeypatched built-in. These drive the actual on-disk
# `code_home()/hooks/lsp-report/hook.yaml` through the whole chain:
#   hooks_global → resolve_*_hooks → bake_resolved_hooks → adapter → settings file
# and pin the seam that unit tests cannot see: that the `--config` path inside the
# WRITTEN command is exactly the file `materialize_lsp_report` produced.
# ─────────────────────────────────────────────────────────────────────────────


def _lsp_registry(proj_path: Path, *, attach_global=True, hook_settings=None) -> dict:
    """A registry attaching the REAL built-in `lsp-report` (no `hooks:` block —
    the name must resolve from code_home()/hooks/, not the registry)."""
    reg: dict = {
        "harnesses_global": ["claude-code"],
        "permissions_global": {},
        "projects": {"alpha": {"path": str(proj_path), "permissions": {}}},
        "skills": {},
    }
    if attach_global:
        reg["hooks_global"] = ["lsp-report"]
    if hook_settings is not None:
        reg["projects"]["alpha"]["hook_settings"] = {"lsp-report": hook_settings}
    return reg


def _one_command(settings_path: Path) -> str:
    """The single PostToolUse command hub wrote into a settings file."""
    data = json.loads(settings_path.read_text())
    entries = data["hooks"]["PostToolUse"]
    assert len(entries) == 1, entries
    hooks = entries[0]["hooks"]
    assert len(hooks) == 1, hooks
    return hooks[0]["command"]


def _config_arg(command: str) -> Path:
    """The `--config` value from a baked command (shlex — the paths are quoted)."""
    tokens = shlex.split(command)
    idx = tokens.index("--config")
    return Path(tokens[idx + 1])


def test_builtin_lsp_report_flows_through_sync_to_both_scopes(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """LSP-1: the shipped built-in reaches BOTH native files with a baked command
    whose `--config` points at the per-scope config sync actually materialized."""
    monkeypatch.setenv("SKILL_TREE_PYTHON", sys.executable)
    _claude_only(monkeypatch)
    home = _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _lsp_registry(proj))
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    for settings_path, scope_slug in (
        (home / ".claude" / "settings.json", "global"),
        (proj / ".claude" / "settings.local.json", "project-alpha"),
    ):
        data = json.loads(settings_path.read_text())
        entry = data["hooks"]["PostToolUse"][0]
        # tools: [Edit, Write, MultiEdit] → the claude-family matcher.
        assert entry["matcher"] == "Edit|Write|MultiEdit"

        command = _one_command(settings_path)
        # The hook.yaml placeholder must NEVER reach a harness.
        assert command != "python3 lsp_report.py --config lsp-report.json"
        tokens = shlex.split(command)
        assert tokens[0] == sys.executable
        assert Path(tokens[1]) == LSP_SCRIPT
        assert Path(tokens[1]).exists()

        # The seam: the --config in the written command IS the materialized file.
        config_path = _config_arg(command)
        expected = tmp_data_home / "state" / "hooks" / f"lsp-report.{scope_slug}.json"
        assert config_path == expected
        assert config_path.is_file(), f"baked --config points at a nonexistent file"

        # …and it carries the shipped per-language defaults (hook.yaml settings).
        cfg = json.loads(config_path.read_text())
        assert cfg["languages"]["python"] == {
            "enabled": True,
            "mode": "advisory",
            "timeout": 30,
        }
        assert cfg["languages"]["go"]["enabled"] is True
        assert cfg["languages"]["typescript"]["enabled"] is False
        assert cfg["languages"]["rust"]["enabled"] is False


def test_builtin_lsp_report_project_hook_settings_reach_the_baked_config(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """LSP-1: a project `hook_settings` override deep-merges into the PROJECT
    config file only — the global config keeps the shipped defaults. A scope-slug
    mismatch between materialize and bake would silently serve the wrong set."""
    monkeypatch.setenv("SKILL_TREE_PYTHON", sys.executable)
    _claude_only(monkeypatch)
    home = _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(
        tmp_data_home,
        _lsp_registry(
            proj,
            hook_settings={
                "languages": {"typescript": {"enabled": True, "mode": "blocking"}}
            },
        ),
    )
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    proj_cfg = json.loads(
        _config_arg(
            _one_command(proj / ".claude" / "settings.local.json")
        ).read_text()
    )
    # Override applied…
    assert proj_cfg["languages"]["typescript"] == {
        "enabled": True,
        "mode": "blocking",
        "timeout": 30,  # deep-merged, not replaced
    }
    # …and the untouched languages survive the merge.
    assert proj_cfg["languages"]["python"]["enabled"] is True

    global_cfg = json.loads(
        _config_arg(_one_command(home / ".claude" / "settings.json")).read_text()
    )
    assert global_cfg["languages"]["typescript"]["enabled"] is False


def test_baked_lsp_report_command_runs_as_a_harness_would_invoke_it(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """LSP-1: execute the EXACT string hub wrote, through a shell, with a hook
    payload on stdin — the only invocation shape production ever uses. A broken
    interpreter/script/--config seam fails here and nowhere else."""
    monkeypatch.setenv("SKILL_TREE_PYTHON", sys.executable)
    _claude_only(monkeypatch)
    home = _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _lsp_registry(proj))
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    command = _one_command(home / ".claude" / "settings.json")
    # A markdown edit → no language checker fires, so this stays hermetic/fast.
    (proj / "README.md").write_text("# hi\n")
    payload = {
        "cwd": str(proj),
        "tool_name": "Edit",
        "tool_input": {"file_path": str(proj / "README.md")},
    }
    completed = subprocess.run(
        command,
        shell=True,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout == ""


def test_lsp_report_baked_command_is_byte_stable_across_syncs(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """LSP-1: an unchanged interpreter ⇒ identical command ⇒ the adapter's
    byte-stable re-sync writes nothing (no churn in the user's settings file)."""
    monkeypatch.setenv("SKILL_TREE_PYTHON", sys.executable)
    _claude_only(monkeypatch)
    home = _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _lsp_registry(proj))
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    settings = home / ".claude" / "settings.json"
    before = settings.read_text()

    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    assert settings.read_text() == before


def test_registry_definition_shadows_the_builtin_lsp_report_through_sync(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """LSP-1 / shadow-by-registry-name: a registry `hooks:` entry named
    `lsp-report` shadows the built-in end-to-end — the DEFINITION that reaches the
    adapter is the registry one (its `matcher`/`event`, not the built-in's
    Edit|Write|MultiEdit tools), and the shadow warning is emitted.

    HOOKS-BUG-06: the shadow now extends to the COMMAND. `bake_resolved_hooks`
    used to key off the NAME alone, so it silently overwrote the user's command
    with the built-in's baked `lsp_report.py` invocation — running code the user
    never asked for, and contradicting docs/HOOKS.md ("used in full"). Provenance
    gates the bake, so the registry command survives verbatim."""
    monkeypatch.setenv("SKILL_TREE_PYTHON", sys.executable)
    _claude_only(monkeypatch)
    home = _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    reg = _lsp_registry(proj)
    reg["hooks"] = {
        "lsp-report": {
            "event": "PostToolUse",
            "matcher": "Bash",
            "command": "/bin/echo shadowed",
        }
    }
    _seed(tmp_data_home, reg)
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace())
    captured = capsys.readouterr()

    settings = home / ".claude" / "settings.json"
    entries = json.loads(settings.read_text())["hooks"]["PostToolUse"]
    # Exactly one entry — the built-in did NOT also get written alongside it.
    assert len(entries) == 1
    # The registry definition's own matcher won over the built-in's tool family.
    assert entries[0]["matcher"] == "Bash"
    assert "Edit|Write|MultiEdit" not in json.dumps(entries)
    assert "shadows the built-in" in captured.err
    # …and its COMMAND is used verbatim — no baked lsp_report.py rewrite.
    assert entries[0]["hooks"][0]["command"] == "/bin/echo shadowed"
    assert "lsp_report.py" not in json.dumps(entries)
    # A shadowed built-in also materializes no per-scope config for itself.
    assert not (tmp_data_home / "state" / "hooks" / "lsp-report.global.json").exists()


def test_detaching_lsp_report_strips_it_from_the_native_files(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """LSP-1: dropping the built-in from `hooks_global` removes its native entries
    (the reconciler owns them via the hooks-kind sidecar)."""
    monkeypatch.setenv("SKILL_TREE_PYTHON", sys.executable)
    _claude_only(monkeypatch)
    home = _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _lsp_registry(proj))
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    settings = home / ".claude" / "settings.json"
    assert "lsp_report.py" in settings.read_text()

    _seed(tmp_data_home, _lsp_registry(proj, attach_global=False))
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    assert "hooks" not in json.loads(settings.read_text())


# ─────────────────────────────────────────────────────────────────────────────
# LSP-5 — a hook-LIBRARY danger finding fails the sync end-to-end
#
# The permissions leg of the rollup already has an exit-code test; the HOOKS leg
# (hub.py's `getattr(risks, "detect_hook_risks", …)` + TypeError fallback) did
# not. If either defensive branch ever swallows the call, every hook danger
# silently becomes a clean sync while the permissions test stays green.
# ─────────────────────────────────────────────────────────────────────────────


def _sudo_hook_registry(proj_path: Path) -> dict:
    return {
        "harnesses_global": ["claude-code"],
        "permissions_global": {},  # NO permission danger — isolate the hooks leg
        "projects": {"alpha": {"path": str(proj_path), "permissions": {}}},
        "skills": {},
        "hooks": {
            "elevate": {
                "event": "PostToolUse",
                "matcher": "Bash",
                "command": "sudo /bin/echo hi",
            }
        },
        "hooks_global": ["elevate"],
    }


def test_hook_runs_sudo_danger_exits_sync_nonzero(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    _claude_only(monkeypatch)
    _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _sudo_hook_registry(proj))
    pa._reset_backup_session_state_for_tests()

    with pytest.raises(SystemExit) as exc:
        hub.cmd_sync(argparse.Namespace())
    assert exc.value.code == 2
    out = capsys.readouterr().out
    assert "HOOK_RUNS_SUDO" in out
    assert "danger findings" in out
    # And it is the HOOKS leg, not a permissions rule, that produced it.
    assert "UNBOUNDED_BASH" not in out


def test_hook_danger_still_fails_sync_with_permissions_skipped(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """`--skip-permissions` leaves the hooks leg as the ONLY doctor input — the
    danger exit must still come through."""
    _claude_only(monkeypatch)
    _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _sudo_hook_registry(proj))
    pa._reset_backup_session_state_for_tests()

    with pytest.raises(SystemExit) as exc:
        hub.cmd_sync(argparse.Namespace(skip_permissions=True))
    assert exc.value.code == 2
    assert "HOOK_RUNS_SUDO" in capsys.readouterr().out


def test_skip_hooks_suppresses_the_hook_danger_exit(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """Complement: with the hooks stream skipped there are no hook targets, so the
    same sudo hook produces no finding and sync succeeds."""
    _claude_only(monkeypatch)
    _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _sudo_hook_registry(proj))
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace(skip_hooks=True))
    out = capsys.readouterr().out
    assert "HOOK_RUNS_SUDO" not in out
    assert "sync complete" in out


def test_broken_script_hook_is_reported_as_warning_without_failing_sync(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """HOOK_BROKEN_SCRIPT is a warning — surfaced in the rollup, but sync still
    exits 0 (only `danger` fails the sync)."""
    _claude_only(monkeypatch)
    _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    reg = _sudo_hook_registry(proj)
    reg["hooks"]["elevate"]["command"] = str(tmp_path / "gone" / "missing_hook.py")
    _seed(tmp_data_home, reg)
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace())
    out = capsys.readouterr().out
    assert "HOOK_BROKEN_SCRIPT" in out
    assert "warning" in out
    assert "sync complete" in out


def test_lsp_checker_missing_is_info_and_does_not_fail_sync(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """An enabled lsp-report language whose checker binary is absent surfaces as
    LSP_CHECKER_MISSING (info) through the real built-in — never a sync failure."""
    monkeypatch.setenv("SKILL_TREE_PYTHON", sys.executable)
    _claude_only(monkeypatch)
    _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _lsp_registry(proj))
    pa._reset_backup_session_state_for_tests()

    import risks

    # Hermetic: no checker binary resolves, whatever the runner has installed.
    monkeypatch.setattr(risks.shutil, "which", lambda name: None)
    hub.cmd_sync(argparse.Namespace())
    out = capsys.readouterr().out
    assert "LSP_CHECKER_MISSING" in out
    assert "(info)" in out
    assert "sync complete" in out


# ─────────────────────────────────────────────────────────────────────────────
# LSP-9 — an adapter blowing up degrades to "stream errored", never a traceback
# ─────────────────────────────────────────────────────────────────────────────


def test_hook_adapter_exception_degrades_to_rc1_and_writes_the_sync_report(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """`adapter.apply` raising is caught per (scope, harness): sync exits 1 with a
    'stream errors' message AND still writes state/sync-report.json (the report's
    'written on every exit path' guarantee)."""
    _claude_only(monkeypatch)
    _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _base_registry(proj))
    pa._reset_backup_session_state_for_tests()

    import hook_adapters

    adapter = hook_adapters.get_hook_adapter("claude-code")
    assert adapter is not None

    def _boom(*a, **k):
        raise RuntimeError("adapter exploded")

    monkeypatch.setattr(type(adapter), "apply", _boom)

    with pytest.raises(SystemExit) as exc:
        hub.cmd_sync(argparse.Namespace())
    assert exc.value.code == 1
    out = capsys.readouterr().out
    assert "apply failed: adapter exploded" in out
    assert "stream errors" in out

    report = json.loads((tmp_data_home / "state" / "sync-report.json").read_text())
    assert report["global"]["hooks"]["ok"] is False
    assert any(
        "adapter exploded" in e["message"] for e in report["global"]["hooks"]["errors"]
    )


# ─────────────────────────────────────────────────────────────────────────────
# HOOKS-BUG-04 — the PRE-adapter section of the hooks stream (handover, probe,
# hook resolution, lsp-report bake) used to run unwrapped, and `cmd_sync` had no
# try/finally around `write_sync_report`. A bake failure therefore escaped
# `cmd_sync` as a raw traceback AFTER the skills/MCP/permissions streams had
# already written, and the "written on every exit path" report never landed.
# ─────────────────────────────────────────────────────────────────────────────


def test_bake_failure_degrades_to_rc1_and_still_writes_the_sync_report(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    monkeypatch.setenv("SKILL_TREE_PYTHON", sys.executable)
    _claude_only(monkeypatch)
    _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _lsp_registry(proj))
    pa._reset_backup_session_state_for_tests()

    # Make ONLY the lsp-report config dir unwritable — the sync report itself
    # lives one level up in state/, so it must still be written.
    hooks_state = tmp_data_home / "state" / "hooks"
    hooks_state.mkdir(parents=True, exist_ok=True)
    hooks_state.chmod(0o500)
    try:
        with pytest.raises(SystemExit) as exc:
            hub.cmd_sync(argparse.Namespace())
        assert exc.value.code == 1                    # degraded, not a crash
        out = capsys.readouterr().out
        assert "hook resolution failed" in out
        assert "stream errors" in out

        report = json.loads((tmp_data_home / "state" / "sync-report.json").read_text())
        assert report["global"]["hooks"]["ok"] is False
        messages = [e["message"] for e in report["global"]["hooks"]["errors"]]
        assert any("hook resolution failed" in m for m in messages)
        # The failure is isolated per scope: global AND the project both report.
        assert any(m.startswith("global ") for m in messages)
        assert any(m.startswith("alpha ") for m in messages)
    finally:
        hooks_state.chmod(0o700)


def test_sync_report_is_written_even_when_a_stream_raises(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """The try/finally guarantee itself: an unexpected exception from a stream
    propagates (no silent swallow) but the report still lands on disk."""
    _claude_only(monkeypatch)
    _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _base_registry(proj))
    pa._reset_backup_session_state_for_tests()

    def _boom(*a, **k):
        raise RuntimeError("stream exploded")

    monkeypatch.setattr(hub, "_run_doctor_rollup", _boom)

    with pytest.raises(RuntimeError, match="stream exploded"):
        hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    assert (tmp_data_home / "state" / "sync-report.json").exists()


# ─────────────────────────────────────────────────────────────────────────────
# HOOKS-CORE-04 — stream error handling beyond the raising adapter: an honest
# `result.error`, partial-failure isolation, and rc precedence vs the doctor.
# ─────────────────────────────────────────────────────────────────────────────


def _erroring_apply(message: str):
    """A `ClaudeHookAdapter.apply` replacement that reports a write failure the
    honest way — a populated `result.error`, not an exception."""
    import hook_adapters

    def _apply(self, scope, resolved_hooks, harness_id, capability=None):
        res = hook_adapters.HookApplyResult(
            harness_id=harness_id, scope=scope.slug, target=None
        )
        res.error = message
        return res

    return _apply


def test_hook_adapter_result_error_fails_sync_and_lands_in_the_report(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """An adapter that returns `result.error` (rather than raising) must be just
    as loud: rc 1 → non-zero exit, the message printed, and `global.hooks` in the
    sync report flipped to ok=False carrying the error. A write failure that
    exited 0 would tell CI the machine is configured when the hook is absent."""
    _claude_only(monkeypatch)
    _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _base_registry(proj))
    pa._reset_backup_session_state_for_tests()

    import hook_adapters

    adapter = hook_adapters.get_hook_adapter("claude-code")
    monkeypatch.setattr(
        type(adapter), "apply", _erroring_apply("settings.json is read-only")
    )

    with pytest.raises(SystemExit) as exc:
        hub.cmd_sync(argparse.Namespace())
    assert exc.value.code == 1
    out = capsys.readouterr().out
    assert "settings.json is read-only" in out
    assert "stream errors" in out

    report = json.loads((tmp_data_home / "state" / "sync-report.json").read_text())
    assert report["global"]["hooks"]["ok"] is False
    messages = [e["message"] for e in report["global"]["hooks"]["errors"]]
    # Both the global pass and the per-project pass report their own failure.
    assert any(m.startswith("global [claude-code]") for m in messages)
    assert any(m.startswith("alpha [claude-code]") for m in messages)
    assert all(e["stage"] == "hooks" for e in report["global"]["hooks"]["errors"])


def test_global_hook_failure_does_not_abort_the_project_passes(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """A blow-up in the GLOBAL pass must not swallow the rest of the stream: every
    registered project is still reconciled (its native hook really lands) even
    though the sync as a whole exits non-zero."""
    _claude_only(monkeypatch)
    _fake_home(monkeypatch, tmp_path)
    alpha = tmp_path / "alpha"
    alpha.mkdir()
    beta = tmp_path / "beta"
    beta.mkdir()
    reg = _base_registry(alpha)
    reg["projects"]["beta"] = {"path": str(beta), "permissions": {}}
    _seed(tmp_data_home, reg)
    pa._reset_backup_session_state_for_tests()

    import hook_adapters

    adapter = hook_adapters.get_hook_adapter("claude-code")
    real_apply = type(adapter).apply

    def _apply(self, scope, resolved_hooks, harness_id, capability=None):
        if isinstance(scope, GlobalScope):
            raise RuntimeError("global write exploded")
        return real_apply(self, scope, resolved_hooks, harness_id, capability)

    monkeypatch.setattr(type(adapter), "apply", _apply)

    with pytest.raises(SystemExit) as exc:
        hub.cmd_sync(argparse.Namespace())
    assert exc.value.code == 1
    capsys.readouterr()

    # BOTH projects were still processed after the global failure.
    for proj in (alpha, beta):
        data = json.loads((proj / ".claude" / "settings.local.json").read_text())
        assert data["hooks"]["PostToolUse"][0]["hooks"][0]["command"] == "/bin/echo hi"
    report = json.loads((tmp_data_home / "state" / "sync-report.json").read_text())
    errors = [e["message"] for e in report["global"]["hooks"]["errors"]]
    assert errors == ["global [claude-code] apply failed: global write exploded"]


def test_doctor_danger_rc2_beats_a_hook_write_error_rc1(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """When the hooks stream errors (rc 1) AND the doctor finds a danger (rc 2),
    the danger code wins — callers keying off exit status must see the worse one."""
    _danger_registry(tmp_data_home, tmp_path, monkeypatch)

    import hook_adapters

    adapter = hook_adapters.get_hook_adapter("claude-code")
    monkeypatch.setattr(type(adapter), "apply", _erroring_apply("write failed"))

    with pytest.raises(SystemExit) as exc:
        hub.cmd_sync(argparse.Namespace())
    assert exc.value.code == 2
    out = capsys.readouterr().out
    assert "danger findings" in out
    report = json.loads((tmp_data_home / "state" / "sync-report.json").read_text())
    assert report["global"]["hooks"]["ok"] is False
    assert report["ok"] is False


def test_hooks_stream_ok_when_nothing_fails(tmp_data_home, tmp_path, monkeypatch, capsys):
    """The negative control for the three above: a clean stream reports no errors
    and sync exits 0."""
    _claude_only(monkeypatch)
    _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    _seed(tmp_data_home, _base_registry(proj))
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace())
    assert "sync complete" in capsys.readouterr().out
    report = json.loads((tmp_data_home / "state" / "sync-report.json").read_text())
    assert report["global"]["hooks"] == {"ok": True, "errors": []}


# ─────────────────────────────────────────────────────────────────────────────
# HOOKS-CORE-05 — the SHIPPED hooks/lsp-report/hook.yaml as a cross-harness
# contract: loaded through the real code_home(), its event/tools must survive the
# per-harness gates on EVERY hook-capable harness. A typo in `event:` or a tool
# name makes the built-in resolve but never write, with no error anywhere.
# ─────────────────────────────────────────────────────────────────────────────


def _builtin_lsp():
    import hooks_model

    builtins = hooks_model.load_builtin_hooks()  # real code_home()
    assert "lsp-report" in builtins, (
        f"the shipped built-in vanished — load_builtin_hooks() saw {sorted(builtins)}"
    )
    return builtins["lsp-report"]


def test_shipped_builtin_lsp_report_loads_from_the_real_code_home():
    """No monkeypatched loader: the on-disk hook.yaml must parse, be tagged
    builtin, and carry the fields the stream needs (a YAML error or a renamed dir
    makes `load_builtin_hooks` warn + skip — the hook silently disappears)."""
    d = _builtin_lsp()
    assert d.provenance == "builtin"
    assert d.event == "PostToolUse"
    assert d.command  # non-empty (the placeholder rewritten at bake time)
    assert d.tools == ["Edit", "Write", "MultiEdit"]
    assert isinstance(d.settings, dict) and d.settings.get("languages")


def test_shipped_builtin_event_and_tools_survive_every_harness_gate():
    """The two gates that silently drop a hook mid-sync, checked against the real
    definition: `event_supported` (per-harness event catalog) and `translate_tools`
    (returns None ⇒ the adapter SKIPS the whole write)."""
    import tool_catalog as tc

    d = _builtin_lsp()
    assert d.event in tc.CANONICAL_EVENTS
    for harness in ("claude-code", "codex"):
        assert tc.event_supported(d.event, harness), (
            f"built-in event {d.event!r} is not supported on {harness}"
        )
        matcher = tc.translate_tools(d.tools, harness)
        assert matcher is not None, (
            f"built-in tools {d.tools!r} translate to nothing on {harness} — the "
            f"adapter would skip the write with no error"
        )
        assert matcher != ""  # never degrade to the match-everything matcher
    assert tc.translate_tools(d.tools, "claude-code") == "Edit|Write|MultiEdit"
    assert tc.translate_tools(d.tools, "codex") == "apply_patch"


def test_shipped_builtin_lsp_report_reaches_codex_global_config(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """End-to-end on the OTHER hook-capable harness: the registry-free built-in
    resolves, bakes, and lands in ~/.codex/config.toml with the codex-native
    `apply_patch` matcher and a string command."""
    import harness_probe
    import harnesses as _harnesses

    monkeypatch.setenv("SKILL_TREE_PYTHON", sys.executable)
    home = tmp_path / "home"
    (home / ".codex").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"codex"})
    monkeypatch.setattr(
        harness_probe, "probe_and_cache",
        lambda *a, **k: {"codex": HookCapability("codex", SUPPORTED, "installed")},
    )
    proj = tmp_path / "alpha"
    proj.mkdir()
    reg = {
        "harnesses_global": ["codex"],
        "permissions_global": {},
        "projects": {"alpha": {"path": str(proj), "permissions": {}}},
        "skills": {},
        "hooks_global": ["lsp-report"],
    }
    _seed(tmp_data_home, reg)
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    import tomlkit

    doc = tomlkit.parse((home / ".codex" / "config.toml").read_text())
    entries = doc["hooks"]["PostToolUse"]
    assert len(entries) == 1
    assert entries[0]["matcher"] == "apply_patch"
    command = entries[0]["hooks"][0]["command"]
    assert isinstance(command, str)
    tokens = shlex.split(command)
    assert tokens[0] == sys.executable
    assert Path(tokens[1]) == LSP_SCRIPT
    codex_keys = read_sidecar("codex", GlobalScope(), "hooks").managed_keys
    assert [k.split("#", 1)[0] for k in codex_keys] == ["hooks.PostToolUse[0]"]


# ─────────────────────────────────────────────────────────────────────────────
# HOOKS-CORE-07 — harness affinity is matched by EXACT id. A definition naming a
# harness id that no installed harness answers to (a typo such as `claude`
# instead of `claude-code`, or a harness the user later removed) must reach
# nothing — and must not be mistaken for "no affinity ⇒ every harness".
# ─────────────────────────────────────────────────────────────────────────────


def test_hook_affinity_naming_no_effective_harness_writes_nothing(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    _claude_only(monkeypatch)
    home = _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    reg = _base_registry(proj)
    reg["hooks"]["myhook"]["harnesses"] = ["claude"]  # NOT the `claude-code` id
    _seed(tmp_data_home, reg)
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace())
    out = capsys.readouterr().out
    assert "Hooks:" in out

    # No native hook anywhere, and no sidecar claiming one.
    assert "hooks" not in json.loads((home / ".claude" / "settings.json").read_text())
    assert not (proj / ".claude" / "settings.local.json").exists()
    assert read_sidecar("claude-code", GlobalScope(), "hooks") is None
    assert read_sidecar(
        "claude-code", ProjectScope(name="alpha", path=str(proj)), "hooks"
    ) is None
    # An unreachable hook is a configuration problem, not a write failure.
    report = json.loads((tmp_data_home / "state" / "sync-report.json").read_text())
    assert report["global"]["hooks"] == {"ok": True, "errors": []}


def test_hook_affinity_with_the_exact_id_does_reach_the_harness(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """The positive control for the test above — same registry, correct id."""
    _claude_only(monkeypatch)
    home = _fake_home(monkeypatch, tmp_path)
    proj = tmp_path / "alpha"
    proj.mkdir()
    reg = _base_registry(proj)
    reg["hooks"]["myhook"]["harnesses"] = ["claude-code"]
    _seed(tmp_data_home, reg)
    pa._reset_backup_session_state_for_tests()

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    data = json.loads((home / ".claude" / "settings.json").read_text())
    assert data["hooks"]["PostToolUse"][0]["hooks"][0]["command"] == "/bin/echo hi"
