"""`.claude/settings.local.json` as a permission discovery source (project scope).

Claude Code writes every session-accepted permission into the project's
personal file. Before `permissions-divergence-fixes` hub could WRITE that file
(personal tier) but never read it back — a structural blind spot. Now it is a
reconcile candidate source (candidates only, never auto-imported), a MOVE-
excision origin, and part of the transaction snapshot.
"""

from __future__ import annotations

import argparse
import io
import json
from pathlib import Path

import yaml

import hub
import skill_hub.entrypoints.cli.permissions
from skill_hub.domain.permissions.permissions import ProjectScope
from skill_hub.infrastructure.permissions import permission_adapters as pa


def _seed_registry(data_home: Path, registry: dict) -> None:
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _read_registry(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text())


def _ns(project: str, apply=False, decisions_stdin=False) -> argparse.Namespace:
    return argparse.Namespace(
        global_=False, project=project, harness=None, json=True,
        apply=apply, decisions_stdin=decisions_stdin,
    )


def _stdin(monkeypatch, decisions: list) -> None:
    monkeypatch.setattr(
        "sys.stdin", io.StringIO(json.dumps({"decisions": decisions}))
    )


def _project(tmp_path: Path, monkeypatch, tmp_data_home: Path,
             shared_allow=None, local_allow=None) -> Path:
    """A registered project with optional rules in the shared and personal files."""
    fake_home = tmp_path / "home"
    (fake_home / ".claude" / "projects").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))

    proj = tmp_path / "proj"
    (proj / ".claude").mkdir(parents=True)
    if shared_allow is not None:
        (proj / ".claude" / "settings.json").write_text(
            json.dumps({"permissions": {"allow": shared_allow}}, indent=2) + "\n"
        )
    if local_allow is not None:
        (proj / ".claude" / "settings.local.json").write_text(
            json.dumps({"permissions": {"allow": local_allow}}, indent=2) + "\n"
        )

    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    _seed_registry(tmp_data_home, {
        "harnesses_global": ["claude-code"],
        "permissions_global": {},
        "projects": {"alpha": {"path": str(proj)}},
        "skills": {},
        "remotes": {},
    })
    pa._reset_backup_session_state_for_tests()
    return proj


def test_local_settings_rule_surfaces_as_candidate(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    proj = _project(tmp_path, monkeypatch, tmp_data_home,
                    local_allow=["Bash(session-accepted:*)"])

    hub.cmd_permissions_reconcile(_ns("alpha"))
    payload = json.loads(capsys.readouterr().out)
    merged = payload.get("merged") or []
    match = [m for m in merged if m["pattern"] == "Bash(session-accepted:*)"]
    assert match, f"local rule missing from candidates: {merged}"
    sources = match[0]["sources"]
    assert any(s["file"].endswith(".claude/settings.local.json") for s in sources)
    assert str(proj) in sources[0]["file"]


def test_discover_existing_does_not_read_local_file(tmp_data_home, tmp_path, monkeypatch):
    """The sync auto-import path uses discover_existing — it must stay blind to
    the personal file so session-accepted rules are never silently ingested."""
    proj = _project(tmp_path, monkeypatch, tmp_data_home,
                    shared_allow=["Bash(shared:*)"],
                    local_allow=["Bash(session-accepted:*)"])
    adapter = pa.ClaudePermissionAdapter()
    scope = ProjectScope(name="alpha", path=str(proj))

    discovered = adapter.discover_existing(scope, "claude-code")
    patterns = {r.pattern for r in discovered.allow}
    assert "Bash(shared:*)" in patterns
    assert "Bash(session-accepted:*)" not in patterns

    # …while discover_candidates DOES see both, each tagged with its file.
    cands = adapter.discover_candidates(scope, "claude-code")
    by_pattern = {c["pattern"]: c for c in cands}
    assert by_pattern["Bash(shared:*)"]["file"].endswith(".claude/settings.json")
    assert by_pattern["Bash(session-accepted:*)"]["file"].endswith(
        ".claude/settings.local.json"
    )


def test_personal_sidecar_managed_rules_excluded(tmp_data_home, tmp_path, monkeypatch):
    """Rules hub wrote to the personal tier (its own sidecar) are not candidates."""
    proj = _project(tmp_path, monkeypatch, tmp_data_home,
                    local_allow=["Bash(hub-owned:*)", "Bash(user-added:*)"])
    from skill_hub.domain.permissions.permissions import write_sidecar

    personal = ProjectScope(name="alpha", path=str(proj), personal=True)
    write_sidecar(
        "claude-code", personal, ["permissions.allow[0]"],
        proj / ".claude" / "settings.local.json",
    )
    adapter = pa.ClaudePermissionAdapter()
    cands = adapter.discover_candidates(
        ProjectScope(name="alpha", path=str(proj)), "claude-code"
    )
    patterns = {c["pattern"] for c in cands}
    assert "Bash(user-added:*)" in patterns
    assert "Bash(hub-owned:*)" not in patterns


def test_import_moves_rule_out_of_local_file(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    proj = _project(tmp_path, monkeypatch, tmp_data_home,
                    local_allow=["Bash(session-accepted:*)", "Bash(keep-me:*)"])
    _stdin(monkeypatch, [
        {"pattern": "Bash(session-accepted:*)", "kind": "allow", "action": "import"},
    ])
    hub.cmd_permissions_reconcile(_ns("alpha", apply=True, decisions_stdin=True))
    capsys.readouterr()

    # Registry project block gained the rule…
    reg = _read_registry(tmp_data_home)
    block = reg["projects"]["alpha"]["permissions"]
    assert any(
        r.get("pattern") == "Bash(session-accepted:*)"
        for r in (block.get("allow") or [])
    )
    # …and the personal file no longer holds it (MOVE, not copy); the
    # untouched user rule survives.
    local = json.loads((proj / ".claude" / "settings.local.json").read_text())
    assert "Bash(session-accepted:*)" not in local["permissions"]["allow"]
    assert "Bash(keep-me:*)" in local["permissions"]["allow"]


def test_rollback_restores_local_file(tmp_data_home, tmp_path, monkeypatch, capsys):
    proj = _project(tmp_path, monkeypatch, tmp_data_home,
                    local_allow=["Bash(session-accepted:*)"])
    local_path = proj / ".claude" / "settings.local.json"
    before_local = local_path.read_bytes()
    # Normalize the on-disk registry once (load_registry materialises empty
    # permissions blocks) so the equality below compares canonical shapes.
    hub.load_registry()
    before_reg = _read_registry(tmp_data_home)

    def _boom(*a, **k):
        raise RuntimeError("injected native-write failure")

    monkeypatch.setattr(skill_hub.entrypoints.cli.permissions, "_sync_scope_native", _boom)
    _stdin(monkeypatch, [
        {"pattern": "Bash(session-accepted:*)", "kind": "allow", "action": "import"},
    ])
    try:
        hub.cmd_permissions_reconcile(_ns("alpha", apply=True, decisions_stdin=True))
        raised = False
    except RuntimeError:
        raised = True
    assert raised
    assert local_path.read_bytes() == before_local
    assert _read_registry(tmp_data_home) == before_reg
