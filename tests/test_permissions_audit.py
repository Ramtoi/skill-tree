"""Audit coverage for permissions verbs (permissions-divergence-fixes group 4).

The 2026-09-01 incident's registry edit left no trace in `state/audit.jsonl` —
permissions mutations were the only registry verbs without audit records. Now
`add/remove/set/adopt/migrate-scope/disable` are `@registry_mutation`-decorated
and `reconcile --apply` writes one manual entry per scope transaction (with
imported/dropped/kept counts); reconcile DISCOVERY stays silent because the
app's divergence chip polls it.
"""

from __future__ import annotations

import argparse
import io
import json
from pathlib import Path

import yaml

import hub
from skill_hub.infrastructure.permissions import permission_adapters as pa


def _audit_lines(data_home: Path) -> list[dict]:
    p = data_home / "state" / "audit.jsonl"
    if not p.exists():
        return []
    return [json.loads(ln) for ln in p.read_text().splitlines() if ln.strip()]


def _seed(data_home: Path, projects: dict | None = None) -> None:
    (data_home / "registry.yaml").write_text(yaml.safe_dump({
        "harnesses_global": ["claude-code"],
        "permissions_global": {},
        "projects": projects or {},
        "skills": {},
        "remotes": {},
    }, sort_keys=False))


def _add_ns(pattern: str, kind: str = "allow") -> argparse.Namespace:
    return argparse.Namespace(
        global_=True, project=None, kind=kind, pattern=pattern,
        harnesses=None, personal=False,
    )


def test_permissions_add_writes_one_audit_entry(tmp_data_home, capsys):
    _seed(tmp_data_home)
    hub.cmd_permissions_add(_add_ns("Bash(x:*)"))
    capsys.readouterr()

    entries = _audit_lines(tmp_data_home)
    assert len(entries) == 1
    e = entries[0]
    assert e["verb"] == "permissions-add"
    assert e["changed"] is True
    assert e["sha_before"] != e["sha_after"]
    assert e["target"]["pattern"] == "Bash(x:*)"
    assert e["target"]["kind"] == "allow"


def test_permissions_remove_audited(tmp_data_home, capsys):
    _seed(tmp_data_home)
    hub.cmd_permissions_add(_add_ns("Bash(x:*)"))
    hub.cmd_permissions_remove(_add_ns("Bash(x:*)"))
    capsys.readouterr()

    verbs = [e["verb"] for e in _audit_lines(tmp_data_home)]
    assert verbs == ["permissions-add", "permissions-remove"]
    assert all(e["changed"] for e in _audit_lines(tmp_data_home))


def test_noop_mutation_records_changed_false(tmp_data_home, capsys, monkeypatch):
    """A dry-run migrate-scope mutates nothing — the entry says so."""
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    _seed(tmp_data_home)
    hub.cmd_permissions_migrate_scope(
        argparse.Namespace(apply=False, json=True)
    )
    capsys.readouterr()

    entries = _audit_lines(tmp_data_home)
    assert len(entries) == 1
    assert entries[0]["verb"] == "permissions-migrate-scope"
    assert entries[0]["changed"] is False


def test_reconcile_discovery_is_silent_apply_is_audited_with_counts(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    fake_home = tmp_path / "home"
    (fake_home / ".claude" / "projects").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))
    (fake_home / ".claude" / "settings.json").write_text(
        json.dumps({"permissions": {"allow": ["Bash(pre:*)", "Bash(user:*)"]}},
                   indent=2) + "\n"
    )
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    _seed(tmp_data_home)
    pa._reset_backup_session_state_for_tests()

    ns = argparse.Namespace(
        global_=True, project=None, harness=None, json=True,
        apply=False, decisions_stdin=False,
    )
    hub.cmd_permissions_reconcile(ns)
    capsys.readouterr()
    assert _audit_lines(tmp_data_home) == []  # discovery: no audit spam

    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"decisions": [
        {"pattern": "Bash(pre:*)", "kind": "allow", "action": "import"},
        {"pattern": "Bash(user:*)", "kind": "allow", "action": "keep"},
    ]})))
    hub.cmd_permissions_reconcile(argparse.Namespace(
        global_=True, project=None, harness=None, json=True,
        apply=True, decisions_stdin=True,
    ))
    capsys.readouterr()

    entries = _audit_lines(tmp_data_home)
    assert len(entries) == 1
    e = entries[0]
    assert e["verb"] == "permissions-reconcile-apply"
    assert e["changed"] is True
    assert e["target"]["imported"] == 1
    assert e["target"]["dropped"] == 0
    assert e["target"]["kept"] == 1
