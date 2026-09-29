"""Kept-decisions store + divergence payload (permissions-divergence-fixes 5.1/5.3b).

"Keep" persists to `state/reconcile/<scope>.kept.json` so kept candidates stop
inflating the app's unmanaged-rules chip; un-keep lifts the fingerprint; a kind
change invalidates it (the situation the user decided about changed). The
`divergence` block on `permissions show --json` feeds the chip + staleness
notice without running a full reconcile.
"""

from __future__ import annotations

import argparse
import io
import json
from pathlib import Path

import pytest
import yaml

import hub
from skill_hub.domain.permissions.permissions import GlobalScope
from skill_hub.infrastructure.permissions import permission_adapters as pa


@pytest.fixture(autouse=True)
def _use_test_home_for_captured_layouts(monkeypatch):
    monkeypatch.delenv("SKILL_HUB_CLAUDE_HOME", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)


def _seed(data_home: Path, permissions_global=None, projects=None) -> None:
    (data_home / "registry.yaml").write_text(yaml.safe_dump({
        "harnesses_global": ["claude-code"],
        "permissions_global": permissions_global or {},
        "projects": projects or {},
        "skills": {},
        "remotes": {},
    }, sort_keys=False))


def _global_settings(fake_home: Path, allow) -> Path:
    p = fake_home / ".claude" / "settings.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"permissions": {"allow": allow}}, indent=2) + "\n")
    return p


def _setup(tmp_path, monkeypatch, tmp_data_home, allow, permissions_global=None):
    fake_home = tmp_path / "home"
    (fake_home / ".claude" / "projects").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))
    settings = _global_settings(fake_home, allow)
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    monkeypatch.setattr(_harnesses, "detect_installed", lambda: {"claude-code"})
    _seed(tmp_data_home, permissions_global=permissions_global)
    pa._reset_backup_session_state_for_tests()
    return settings


def _reconcile_ns(apply=False, decisions_stdin=False):
    return argparse.Namespace(
        global_=True, project=None, harness=None, json=True,
        apply=apply, decisions_stdin=decisions_stdin,
    )


def _run_discovery(capsys) -> dict:
    hub.cmd_permissions_reconcile(_reconcile_ns())
    return json.loads(capsys.readouterr().out)


def _apply_decisions(monkeypatch, capsys, decisions) -> None:
    monkeypatch.setattr(
        "sys.stdin", io.StringIO(json.dumps({"decisions": decisions}))
    )
    hub.cmd_permissions_reconcile(_reconcile_ns(apply=True, decisions_stdin=True))
    capsys.readouterr()


def test_keep_persists_and_marks_candidate(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    settings = _setup(tmp_path, monkeypatch, tmp_data_home, ["Bash(user:*)"])

    view = _run_discovery(capsys)
    assert [m["kept"] for m in view["merged"]] == [False]

    _apply_decisions(monkeypatch, capsys, [
        {"pattern": "Bash(user:*)", "kind": "allow", "action": "keep"},
    ])
    store = json.loads(
        (tmp_data_home / "state" / "reconcile" / "global.kept.json").read_text()
    )
    assert store["kept"] == [{
        "pattern": "Bash(user:*)", "kind": "allow", "source_file": str(settings),
    }]

    view = _run_discovery(capsys)
    assert [m["kept"] for m in view["merged"]] == [True]


def test_unkeep_lifts_fingerprint(tmp_data_home, tmp_path, monkeypatch, capsys):
    _setup(tmp_path, monkeypatch, tmp_data_home, ["Bash(user:*)"])
    _apply_decisions(monkeypatch, capsys, [
        {"pattern": "Bash(user:*)", "kind": "allow", "action": "keep"},
    ])
    assert _run_discovery(capsys)["merged"][0]["kept"] is True

    _apply_decisions(monkeypatch, capsys, [
        {"pattern": "Bash(user:*)", "kind": "allow", "action": "unkeep"},
    ])
    assert _run_discovery(capsys)["merged"][0]["kept"] is False


def test_kind_change_invalidates_kept_fingerprint(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    fake_home = tmp_path / "home"
    settings = _setup(tmp_path, monkeypatch, tmp_data_home, ["Bash(user:*)"])
    _apply_decisions(monkeypatch, capsys, [
        {"pattern": "Bash(user:*)", "kind": "allow", "action": "keep"},
    ])
    # The rule's kind changes in the native file: allow → ask.
    settings.write_text(json.dumps(
        {"permissions": {"ask": ["Bash(user:*)"]}}, indent=2) + "\n")

    view = _run_discovery(capsys)
    (m,) = view["merged"]
    assert m["kind"] == "ask"
    assert m["kept"] is False  # fingerprint (pattern, allow, file) no longer matches


def test_corrupt_store_treated_as_empty(tmp_data_home, tmp_path, monkeypatch, capsys):
    _setup(tmp_path, monkeypatch, tmp_data_home, ["Bash(user:*)"])
    store_path = tmp_data_home / "state" / "reconcile" / "global.kept.json"
    store_path.parent.mkdir(parents=True, exist_ok=True)
    store_path.write_text("{not json")
    view = _run_discovery(capsys)
    assert view["merged"][0]["kept"] is False


# ── divergence payload (permissions show --json) ─────────────────────────────


def _show_json(capsys) -> dict:
    hub.cmd_permissions_show(argparse.Namespace(
        global_=True, project=None, effective=False, personal=False, json=True,
    ))
    return json.loads(capsys.readouterr().out)


def test_divergence_counts_unmanaged_and_excludes_kept(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    _setup(tmp_path, monkeypatch, tmp_data_home,
           ["Bash(user-a:*)", "Bash(user-b:*)"])

    payload = _show_json(capsys)
    div = payload["divergence"]
    assert div["unmanaged_count"] == 2
    assert div["harnesses"]["claude-code"]["unmanaged"] == 2
    assert div["stale"] is None  # hub never wrote this scope — unknown

    _apply_decisions(monkeypatch, capsys, [
        {"pattern": "Bash(user-a:*)", "kind": "allow", "action": "keep"},
    ])
    div = _show_json(capsys)["divergence"]
    assert div["unmanaged_count"] == 1


def test_divergence_staleness_flips_on_registry_edit(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    _setup(
        tmp_path, monkeypatch, tmp_data_home, [],
        permissions_global={"allow": [{"pattern": "Bash(git:*)", "kind": "allow"}]},
    )
    # A real apply records block_sha256 in the sidecar.
    from skill_hub.domain.permissions.permissions import NormalizedPermissions, Rule

    adapter = pa.ClaudePermissionAdapter()
    perms = NormalizedPermissions(allow=[Rule(pattern="Bash(git:*)", kind="allow")])
    result = adapter.translate(perms, GlobalScope(), "claude-code")
    assert adapter.apply(GlobalScope(), result.writes[0], "claude-code")

    div = _show_json(capsys)["divergence"]
    assert div["stale"] is False
    assert div["last_written_at"]

    # Registry edited after the write (the incident's shape): block changes,
    # no sync ran — the payload must say stale.
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    reg["permissions_global"]["allow"].append(
        {"pattern": "Bash(node:*)", "kind": "allow"}
    )
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    div = _show_json(capsys)["divergence"]
    assert div["stale"] is True
    assert div["harnesses"]["claude-code"]["stale"] is True
