"""Layer 0 — CLI-as-agent-contract foundation.

Covers the re-entrant data-home lock, the registry-mutation audit log, and the
`registry_mutation` decorator that wraps every agent-writable CRUD verb so it
runs under the lock and leaves an audit trail. See
`strategy/agent-tooling-roadmap.md`.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest


def test_lock_is_reentrant(tmp_data_home):
    """A nested acquisition must NOT deadlock (two flock fds in one process
    would otherwise block forever) and depth must unwind correctly."""
    import hub

    assert hub._LOCK_DEPTH == 0
    with hub.data_home_lock():
        assert hub._LOCK_DEPTH == 1
        with hub.data_home_lock():  # re-entrant no-op
            assert hub._LOCK_DEPTH == 2
        assert hub._LOCK_DEPTH == 1
    assert hub._LOCK_DEPTH == 0


def test_registry_sha_tracks_changes(tmp_data_home):
    import hub

    hub.save_registry({"skills": {}, "projects": {}, "bundles": {}})
    before = hub._registry_sha()
    hub.save_registry({"skills": {}, "projects": {}, "bundles": {"b": {"skills": []}}})
    after = hub._registry_sha()
    assert before and after and before != after


def test_append_audit_shape_and_actor(tmp_data_home, monkeypatch):
    import hub

    monkeypatch.setenv("SKILL_HUB_ACTOR", "goal-runner")
    hub.append_audit("set-meta", SimpleNamespace(name="x", project="demo"), "aaa", "bbb")

    line = hub.audit_log_path().read_text().strip().splitlines()[-1]
    rec = json.loads(line)
    assert rec["verb"] == "set-meta"
    assert rec["actor"] == "goal-runner"
    assert rec["target"] == {"name": "x", "project": "demo"}
    assert rec["changed"] is True  # aaa != bbb
    assert rec["sha_before"] == "aaa" and rec["sha_after"] == "bbb"
    assert "ts" in rec


def test_append_audit_is_best_effort(tmp_data_home, monkeypatch):
    """A failure inside auditing must never propagate."""
    import hub

    monkeypatch.setattr(hub, "audit_log_path", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    # Should swallow the error, not raise.
    hub.append_audit("v", SimpleNamespace(), "a", "b")


def test_registry_mutation_decorator_locks_and_audits(tmp_data_home):
    import hub

    hub.save_registry({"skills": {}, "projects": {}, "bundles": {}})
    seen = {}

    @hub.registry_mutation("unit-verb")
    def fake(args):
        seen["depth"] = hub._LOCK_DEPTH  # proves we run under the lock
        reg = hub.load_registry()
        reg.setdefault("bundles", {})["x"] = {"skills": []}
        hub.save_registry(reg)

    fake(SimpleNamespace(name="x"))

    assert seen["depth"] >= 1
    assert hub._LOCK_DEPTH == 0  # unwound
    rec = json.loads(hub.audit_log_path().read_text().strip().splitlines()[-1])
    assert rec["verb"] == "unit-verb"
    assert rec["target"] == {"name": "x"}
    assert rec["changed"] is True


def test_core_crud_verbs_are_decorated():
    """The agent-writable verbs must carry the audit/lock wrapper."""
    import hub

    for fn_name in (
        "cmd_enable",
        "cmd_disable",
        "cmd_new",
        "cmd_set_meta",
        "cmd_archive",
        "cmd_rename",
        "cmd_bundle_new",
        "cmd_bundle_update",
        "cmd_bundle_delete",
        "cmd_bundle_apply",
        "cmd_bundle_remove",
        "cmd_project_import_skill",
    ):
        fn = getattr(hub, fn_name)
        assert getattr(fn, "__wrapped__", None) is not None, f"{fn_name} not decorated"


# ── 0d: dry-run on destructive verbs ─────────────────────────────────────────


def test_dry_run_archive_mutates_nothing(tmp_data_home):
    import hub

    hub.save_registry(
        {
            "skills": {"s1": {"source": "~/x", "type": "claude-skill", "scope": "global"}},
            "projects": {},
            "bundles": {},
        }
    )
    hub.load_registry()  # settle one-time schema migrations
    before = hub._registry_sha()
    hub.cmd_archive(SimpleNamespace(skill="s1", dry_run=True))
    assert hub._registry_sha() == before
    assert "s1" in hub.load_registry()["skills"]


def test_dry_run_rename_mutates_nothing(tmp_data_home):
    import hub

    hub.save_registry(
        {
            "skills": {"old": {"source": "~/x", "type": "claude-skill", "scope": "global"}},
            "projects": {},
            "bundles": {},
        }
    )
    hub.load_registry()  # settle one-time schema migrations
    before = hub._registry_sha()
    hub.cmd_rename(SimpleNamespace(old_name="old", new_name="new", dry_run=True))
    assert hub._registry_sha() == before
    assert "old" in hub.load_registry()["skills"]


def test_dry_run_bundle_delete_mutates_nothing(tmp_data_home):
    import hub

    hub.save_registry(
        {
            "skills": {},
            "projects": {"p": {"path": "/tmp", "bundles": ["b"], "enabled": []}},
            "bundles": {"b": {"skills": []}},
        }
    )
    hub.load_registry()  # settle one-time schema migrations
    before = hub._registry_sha()
    hub.cmd_bundle_delete(SimpleNamespace(bundle_name="b", dry_run=True))
    assert hub._registry_sha() == before
    assert "b" in hub.load_registry()["bundles"]
