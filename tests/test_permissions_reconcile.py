"""Unified reconcile flow tests (D3 / change rework-permissions-model §7).

`hub permissions reconcile` subsumes adopt+import: discover pre-existing native
rules across harnesses, classify merged/conflict/un-importable, then apply as a
single transaction per scope (backup → registry → native auto-sync, with
rollback). Driven in-process; HOME + harness detection monkeypatched per test.
"""

from __future__ import annotations

import argparse
import io
import json
from pathlib import Path

import yaml

import hub
import permission_adapters as pa


def _seed_registry(data_home: Path, registry: dict) -> None:
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _read_registry(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text())


def _ns(global_=True, project=None, harness=None, json_out=True,
        apply=False, decisions_stdin=False) -> argparse.Namespace:
    return argparse.Namespace(
        global_=global_, project=project, harness=harness, json=json_out,
        apply=apply, decisions_stdin=decisions_stdin,
    )


def _stdin(monkeypatch, decisions: list) -> None:
    monkeypatch.setattr(
        "sys.stdin", io.StringIO(json.dumps({"decisions": decisions}))
    )


def _write_claude_global(fake_home: Path, allow=None, deny=None) -> Path:
    settings = fake_home / ".claude" / "settings.json"
    settings.parent.mkdir(parents=True, exist_ok=True)
    block: dict = {}
    if allow:
        block["allow"] = allow
    if deny:
        block["deny"] = deny
    settings.write_text(json.dumps({"permissions": block}, indent=2) + "\n")
    return settings


# ─────────────────────────────────────────────────────────────────────────────
# Discovery / classification
# ─────────────────────────────────────────────────────────────────────────────


def test_same_rule_across_harnesses_collapses(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """Same command + decision in claude-code and pi → one affinity-free merged."""
    fake_home = tmp_path / "home"
    (fake_home / ".claude" / "projects").mkdir(parents=True)
    (fake_home / ".pi" / "agent").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))
    # Same allow rule in both harness global files.
    (fake_home / ".claude" / "settings.json").write_text(
        json.dumps({"permissions": {"allow": ["Bash(npm:*)"]}}, indent=2) + "\n"
    )
    (fake_home / ".pi" / "agent" / "settings.json").write_text(
        json.dumps({"permissions": {"allow": ["Bash(npm:*)"]}}, indent=2) + "\n"
    )

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code", "pi"})
    _seed_registry(
        tmp_data_home,
        {"harnesses_global": [], "permissions_global": {}, "projects": {}, "skills": {}},
    )
    hub.cmd_permissions_reconcile(_ns())
    view = json.loads(capsys.readouterr().out)
    merged = [m for m in view["merged"] if m["pattern"] == "Bash(npm:*)"]
    assert len(merged) == 1
    assert merged[0]["harnesses"] is None  # collapsed → all harnesses
    assert {s["harness"] for s in merged[0]["sources"]} == {"claude-code", "pi"}


def test_divergent_decisions_are_a_conflict_not_auto_picked(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    fake_home = tmp_path / "home"
    (fake_home / ".claude" / "projects").mkdir(parents=True)
    (fake_home / ".pi" / "agent").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))
    (fake_home / ".claude" / "settings.json").write_text(
        json.dumps({"permissions": {"allow": ["Bash(npm:*)"]}}, indent=2) + "\n"
    )
    (fake_home / ".pi" / "agent" / "settings.json").write_text(
        json.dumps({"permissions": {"deny": ["Bash(npm:*)"]}}, indent=2) + "\n"
    )

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code", "pi"})
    _seed_registry(
        tmp_data_home,
        {"harnesses_global": [], "permissions_global": {}, "projects": {}, "skills": {}},
    )
    hub.cmd_permissions_reconcile(_ns())
    view = json.loads(capsys.readouterr().out)
    conflicts = [c for c in view["conflicts"] if c["pattern"] == "Bash(npm:*)"]
    assert len(conflicts) == 1
    assert set(conflicts[0]["options"].keys()) == {"allow", "deny"}
    # Not auto-picked into merged.
    assert all(m["pattern"] != "Bash(npm:*)" for m in view["merged"])


def test_un_representable_codex_rule_flagged_and_left_in_place(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """A Codex rule using match/not_match is un-importable and stays untouched."""
    fake_home = tmp_path / "home"
    rules_dir = fake_home / ".codex" / "rules"
    rules_dir.mkdir(parents=True)
    default_rules = rules_dir / "default.rules"
    default_rules.write_text(
        'prefix_rule(\n    pattern = ["npm"],\n    match = ["test"],\n'
        '    decision = "allow",\n)\n'
    )
    before = default_rules.read_text()
    monkeypatch.setenv("HOME", str(fake_home))

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"codex"})
    _seed_registry(
        tmp_data_home,
        {"harnesses_global": ["codex"], "permissions_global": {},
         "projects": {}, "skills": {}},
    )
    hub.cmd_permissions_reconcile(_ns())
    view = json.loads(capsys.readouterr().out)
    assert view["un_importable"]
    assert any("match" in (u.get("reason") or "") for u in view["un_importable"])
    # Left untouched in its native file.
    assert default_rules.read_text() == before


# ─────────────────────────────────────────────────────────────────────────────
# Transactional apply
# ─────────────────────────────────────────────────────────────────────────────


def test_apply_imports_and_autosyncs_no_separate_sync(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """Apply imports the rule into the registry AND native files agree without a
    separate sync; the user-authored origin entry is MOVEd to hub-managed."""
    fake_home = tmp_path / "home"
    (fake_home / ".claude" / "projects").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))
    settings = _write_claude_global(fake_home, allow=["Bash(npm:*)"])

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    _seed_registry(
        tmp_data_home,
        {"harnesses_global": ["claude-code"], "permissions_global": {},
         "projects": {}, "skills": {}},
    )
    pa._reset_backup_session_state_for_tests()
    _stdin(monkeypatch, [
        {"pattern": "Bash(npm:*)", "kind": "allow", "action": "import"}
    ])
    hub.cmd_permissions_reconcile(_ns(apply=True, decisions_stdin=True))
    summary = json.loads(capsys.readouterr().out)
    assert summary["imported"] == 1
    assert summary["synced_files"]  # native auto-synced

    # Registry has the rule.
    reg = _read_registry(tmp_data_home)
    allow = reg["permissions_global"].get("allow") or []
    assert any((r.get("pattern") if isinstance(r, dict) else r) == "Bash(npm:*)"
               for r in allow)

    # Native file has it exactly once (hub-managed), claimed by the sidecar.
    data = json.loads(settings.read_text())
    assert data["permissions"]["allow"].count("Bash(npm:*)") == 1
    from permissions import GlobalScope, read_sidecar

    sc = read_sidecar("claude-code", GlobalScope())
    assert sc is not None and "permissions.allow[0]" in sc.managed_keys

    # Re-discovery does NOT re-surface the now-hub-managed rule (idempotent).
    hub.cmd_permissions_reconcile(_ns())
    view = json.loads(capsys.readouterr().out)
    assert all(m["pattern"] != "Bash(npm:*)" for m in view["merged"])


def test_imported_rule_excised_from_claude_origin(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """MOVE: an imported rule does not remain as a separate user-authored entry.
    With a user rule plus a to-import rule, after import the user rule stays and
    the imported rule is hub-managed — never duplicated as both."""
    fake_home = tmp_path / "home"
    (fake_home / ".claude" / "projects").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))
    settings = _write_claude_global(fake_home, allow=["Bash(npm:*)", "Bash(git:*)"])

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    _seed_registry(
        tmp_data_home,
        {"harnesses_global": ["claude-code"], "permissions_global": {},
         "projects": {}, "skills": {}},
    )
    pa._reset_backup_session_state_for_tests()
    # Import npm, keep git as user-authored.
    _stdin(monkeypatch, [
        {"pattern": "Bash(npm:*)", "kind": "allow", "action": "import"},
        {"pattern": "Bash(git:*)", "kind": "allow", "action": "keep"},
    ])
    hub.cmd_permissions_reconcile(_ns(apply=True, decisions_stdin=True))
    capsys.readouterr()

    allow = json.loads(settings.read_text())["permissions"]["allow"]
    # npm present once (hub-managed), git still present (user-authored).
    assert allow.count("Bash(npm:*)") == 1
    assert "Bash(git:*)" in allow

    # git is NOT hub-managed; npm IS.
    from permissions import GlobalScope, read_sidecar

    sc = read_sidecar("claude-code", GlobalScope())
    managed_patterns = set()
    for key in sc.managed_keys:
        # map key index back to the pattern
        idx = int(key.split("[")[1].rstrip("]"))
        managed_patterns.add(allow[idx])
    assert "Bash(npm:*)" in managed_patterns
    assert "Bash(git:*)" not in managed_patterns


def test_failure_after_registry_write_rolls_back(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """Injected failure in the native auto-sync rolls back BOTH the registry and
    the native origin files."""
    fake_home = tmp_path / "home"
    (fake_home / ".claude" / "projects").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))
    settings = _write_claude_global(fake_home, allow=["Bash(npm:*)"])
    before_native = settings.read_bytes()

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    _seed_registry(
        tmp_data_home,
        {"harnesses_global": ["claude-code"], "permissions_global": {},
         "projects": {}, "skills": {}, "remotes": {}},
    )
    before_reg = _read_registry(tmp_data_home)

    # Make the native auto-sync step explode after the registry write.
    def _boom(*a, **k):
        raise RuntimeError("injected native-write failure")

    monkeypatch.setattr(hub, "_sync_scope_native", _boom)
    pa._reset_backup_session_state_for_tests()
    _stdin(monkeypatch, [
        {"pattern": "Bash(npm:*)", "kind": "allow", "action": "import"}
    ])
    try:
        hub.cmd_permissions_reconcile(_ns(apply=True, decisions_stdin=True))
        raised = False
    except RuntimeError:
        raised = True
    assert raised

    # Registry rolled back: no npm import survived.
    after_reg = _read_registry(tmp_data_home)
    assert (after_reg.get("permissions_global") or {}).get("allow") in (None, [])
    assert after_reg == before_reg
    # Native origin restored to its pre-apply bytes (rule not excised).
    assert settings.read_bytes() == before_native


def test_conflict_resolution_applies_chosen_decision(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    fake_home = tmp_path / "home"
    (fake_home / ".claude" / "projects").mkdir(parents=True)
    (fake_home / ".pi" / "agent").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))
    (fake_home / ".claude" / "settings.json").write_text(
        json.dumps({"permissions": {"allow": ["Bash(npm:*)"]}}, indent=2) + "\n"
    )
    (fake_home / ".pi" / "agent" / "settings.json").write_text(
        json.dumps({"permissions": {"deny": ["Bash(npm:*)"]}}, indent=2) + "\n"
    )

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code", "pi"})
    _seed_registry(
        tmp_data_home,
        {"harnesses_global": ["claude-code", "pi"], "permissions_global": {},
         "projects": {}, "skills": {}},
    )
    pa._reset_backup_session_state_for_tests()
    # Resolve the allow/deny conflict by choosing `deny`.
    _stdin(monkeypatch, [
        {"pattern": "Bash(npm:*)", "kind": "deny", "action": "import"}
    ])
    hub.cmd_permissions_reconcile(_ns(apply=True, decisions_stdin=True))
    summary = json.loads(capsys.readouterr().out)
    assert summary["conflicts_resolved"] == 1

    reg = _read_registry(tmp_data_home)
    block = reg["permissions_global"]
    deny = [(r.get("pattern") if isinstance(r, dict) else r) for r in (block.get("deny") or [])]
    allow = [(r.get("pattern") if isinstance(r, dict) else r) for r in (block.get("allow") or [])]
    assert "Bash(npm:*)" in deny
    assert "Bash(npm:*)" not in allow


# ─────────────────────────────────────────────────────────────────────────────
# Global blocking guarantee + deliberate-delete
# ─────────────────────────────────────────────────────────────────────────────


def test_reconcile_resolves_global_blocking(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """A pre-existing global rule blocks the global sync stream; after reconcile
    the block is managed and a subsequent sync no longer blocks."""
    fake_home = tmp_path / "home"
    (fake_home / ".claude" / "projects").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))
    _write_claude_global(fake_home, allow=["Bash(npm:*)"])

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    _seed_registry(
        tmp_data_home,
        {"harnesses_global": ["claude-code"], "permissions_global": {},
         "projects": {}, "skills": {}},
    )
    # Before reconcile: sync blocks the global scope.
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))
    out = capsys.readouterr().out
    assert "AdoptionRequired" in out or "blocked" in out

    # Reconcile imports the rule.
    pa._reset_backup_session_state_for_tests()
    _stdin(monkeypatch, [
        {"pattern": "Bash(npm:*)", "kind": "allow", "action": "import"}
    ])
    hub.cmd_permissions_reconcile(_ns(apply=True, decisions_stdin=True))
    capsys.readouterr()

    # After reconcile: sync no longer blocks (block is managed).
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))
    out2 = capsys.readouterr().out
    assert "AdoptionRequired" not in out2


def test_deliberate_delete_not_resurfaced(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """After importing a rule (now hub-managed) it is not re-surfaced as a fresh
    candidate — the first-contact / deliberate-delete guarantee for Claude."""
    fake_home = tmp_path / "home"
    (fake_home / ".claude" / "projects").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))
    _write_claude_global(fake_home, allow=["Bash(npm:*)"])

    import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    _seed_registry(
        tmp_data_home,
        {"harnesses_global": ["claude-code"], "permissions_global": {},
         "projects": {}, "skills": {}},
    )
    pa._reset_backup_session_state_for_tests()
    _stdin(monkeypatch, [
        {"pattern": "Bash(npm:*)", "kind": "allow", "action": "import"}
    ])
    hub.cmd_permissions_reconcile(_ns(apply=True, decisions_stdin=True))
    capsys.readouterr()

    # Now delete the rule from the registry → re-sync removes it from native.
    reg = _read_registry(tmp_data_home)
    reg["permissions_global"] = {}
    _seed_registry(tmp_data_home, reg)
    pa._reset_backup_session_state_for_tests()
    hub.cmd_sync(argparse.Namespace(skip_permissions=False))
    capsys.readouterr()

    # Discovery surfaces nothing (rule gone from native, sidecar empty/clean).
    hub.cmd_permissions_reconcile(_ns())
    view = json.loads(capsys.readouterr().out)
    assert all(m["pattern"] != "Bash(npm:*)" for m in view["merged"])
