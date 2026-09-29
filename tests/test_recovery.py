"""skill_hub/application/backup/recovery.py + hub_cli/recovery.py.

Covers PLAN §1-4,7 / A4-A10, A12-A14. Uses `tmp_data_home`; never touches a
real registry. Fake git repos stand in for local checkouts and sources —
never a real network clone.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from skill_hub.application.backup import recovery


def _git(path, *args):
    subprocess.run(["git", "-C", str(path), *args], check=True, capture_output=True, text=True)


def _repo(path, *, remote=None):
    path.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(path)], check=True, capture_output=True, text=True)
    _git(path, "config", "user.email", "test@example.invalid")
    _git(path, "config", "user.name", "Recovery Test")
    (path / "README.md").write_text("fixture\n")
    _git(path, "add", "README.md")
    _git(path, "commit", "-q", "-m", "fixture")
    if remote:
        _git(path, "remote", "add", "origin", remote)


def invoke(monkeypatch, capsys, *args):
    import hub

    monkeypatch.setattr(sys, "argv", ["hub", *args])
    code = 0
    try:
        hub.main()
    except SystemExit as exc:
        code = exc.code
    output = capsys.readouterr()
    assert output.out, f"expected JSON, exit={code}: {output.err}"
    return code, json.loads(output.out)


def _write_registry(tmp_data_home, registry):
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry))


def _base_registry(**projects):
    return {"version": "1", "skills": {}, "bundles": {}, "sources": {}, "projects": projects}


# ─────────────────────────────────────────────────────────────────────────────
# A14 — status works with no record, gates only on real pending work
# ─────────────────────────────────────────────────────────────────────────────


def test_status_on_healthy_install_never_gates(tmp_data_home):
    project_path = tmp_data_home / "app"
    project_path.mkdir()
    registry = _base_registry(app={"path": str(project_path), "enabled": [], "bundles": []})
    payload = recovery.build_status(registry, recovery.empty_record())
    assert payload["needs_recovery"] is False
    assert payload["projects"][0]["status"] == "ready"
    assert payload["projects_summary"]["ready"] == 1


def test_status_on_old_restore_with_no_record_needs_recovery(tmp_data_home):
    registry = _base_registry(app={"path": "/nonexistent/app", "path_unresolved": True, "enabled": [], "bundles": []})
    payload = recovery.build_status(registry, recovery.empty_record())
    assert payload["needs_recovery"] is True
    assert payload["projects"][0]["status"] == "pending"
    assert payload["projects"][0]["attached"] is False


def test_finish_permits_deferrals_and_turns_off_the_gate(tmp_data_home):
    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []})
    record = recovery.empty_record()
    recovery.set_project_job(record, "app", "failed", detail="clone failed")
    record = recovery.mark_finished(record)
    payload = recovery.build_status(registry, record)
    assert payload["needs_recovery"] is False
    assert payload["projects"][0]["status"] == "failed"  # still visible/retryable


# ─────────────────────────────────────────────────────────────────────────────
# A10 — persisted "running" is only interrupted when the owning pid is dead
# ─────────────────────────────────────────────────────────────────────────────


def test_running_job_with_live_pid_stays_running(tmp_data_home):
    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []})
    record = recovery.empty_record()
    recovery.set_project_job(record, "app", "running", pid=os.getpid())
    rows = recovery.project_status_rows(registry, record)
    assert rows[0]["status"] == "running"


def test_running_job_with_dead_pid_is_interrupted(tmp_data_home):
    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []})
    record = recovery.empty_record()
    # A pid essentially guaranteed not to exist.
    recovery.set_project_job(record, "app", "running", pid=2**30 - 1)
    rows = recovery.project_status_rows(registry, record)
    assert rows[0]["status"] == "interrupted"


def test_start_resumes_same_snapshot_without_losing_progress(tmp_data_home):
    record = recovery.empty_record()
    record = recovery.start_operation(record, snapshot_key="snap-1", stage="library")
    recovery.set_project_job(record, "app", "ready", detail="attached")
    op_id = record["operation_id"]

    resumed = recovery.start_operation(record, snapshot_key="snap-1", stage="projects")
    assert resumed["operation_id"] == op_id
    assert resumed["stage"] == "projects"
    assert resumed["projects"]["app"]["status"] == "ready"


def test_start_resets_only_when_snapshot_identity_changes(tmp_data_home):
    record = recovery.empty_record()
    record = recovery.start_operation(record, snapshot_key="snap-1")
    recovery.set_project_job(record, "app", "ready")
    fresh = recovery.start_operation(record, snapshot_key="snap-2")
    assert fresh["operation_id"] != record["operation_id"]
    assert fresh["projects"] == {}


# ─────────────────────────────────────────────────────────────────────────────
# A6 — explicit skip is record-only
# ─────────────────────────────────────────────────────────────────────────────


def test_skip_project_cli_never_touches_the_registry(tmp_data_home, monkeypatch, capsys):
    import hub

    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": ["x"], "bundles": ["b"]})
    _write_registry(tmp_data_home, registry)
    before = (tmp_data_home / "registry.yaml").read_text()
    monkeypatch.setattr(hub, "_auto_sync", lambda *a, **kw: pytest.fail("skip must never sync"))

    code, reply = invoke(
        monkeypatch, capsys, "recovery", "skip", "--project", "app", "--reason", "moved elsewhere", "--json"
    )
    assert code == 0 and reply["ok"] is True
    after = (tmp_data_home / "registry.yaml").read_text()
    assert before == after

    status_code, status = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    row = status["projects"][0]
    assert row["status"] == "skipped"
    assert row["path"] == "/nonexistent"  # loadout/settings untouched


def test_skip_unknown_project_is_a_json_verdict_not_a_crash(tmp_data_home, monkeypatch, capsys):
    _write_registry(tmp_data_home, _base_registry())
    code, reply = invoke(monkeypatch, capsys, "recovery", "skip", "--project", "ghost", "--json")
    assert code == 0
    assert reply["ok"] is False
    assert reply["error"]["code"] == "unknown_project"


# ─────────────────────────────────────────────────────────────────────────────
# A7 — a repository association alone never attaches
# ─────────────────────────────────────────────────────────────────────────────


def test_set_repository_never_touches_path_or_attachment(tmp_data_home, monkeypatch, capsys):
    import hub

    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []})
    _write_registry(tmp_data_home, registry)
    monkeypatch.setattr(hub, "_auto_sync", lambda *a, **kw: pytest.fail("must never sync"))

    code, reply = invoke(
        monkeypatch, capsys, "recovery", "set-repository", "--project", "app",
        "--url", "https://github.com/example-org/app.git", "--json",
    )
    assert code == 0 and reply["ok"] is True

    saved = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())["projects"]["app"]
    assert saved["path"] == "/nonexistent"
    assert saved["path_unresolved"] is True
    assert saved["repository"]["url"] == "https://github.com/example-org/app.git"


@pytest.mark.parametrize("prior", ["skipped", "deferred"])
def test_set_repository_clears_a_prior_skip(tmp_data_home, monkeypatch, capsys, prior):
    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []})
    _write_registry(tmp_data_home, registry)
    invoke(monkeypatch, capsys, "recovery", "skip", "--project", "app", "--json")
    record = recovery.read_record()
    recovery.set_project_job(record, "app", prior)
    recovery.write_record(record)
    invoke(
        monkeypatch, capsys, "recovery", "set-repository", "--project", "app",
        "--url", "https://github.com/example-org/app.git", "--json",
    )
    _, status = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    assert status["projects"][0]["status"] == "pending"  # no longer "skipped"


# ─────────────────────────────────────────────────────────────────────────────
# A4 — identity-only discovery: never folder/project name
# ─────────────────────────────────────────────────────────────────────────────


def test_discover_matches_identity_ignores_folder_name(tmp_data_home):
    root = tmp_data_home / "roots"
    same_identity_different_name = root / "totally-different-folder-name"
    _repo(same_identity_different_name, remote="git@github.com:example-org/app.git")
    same_name_wrong_identity = root / "app"
    _repo(same_name_wrong_identity, remote="git@github.com:example-org/OTHER.git")

    registry = _base_registry(
        app={
            "path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": [],
            "repository": {"url": "https://github.com/example-org/app.git", "remote": "origin", "subdirectory": "."},
        }
    )
    result = recovery.discover_matches(registry, "app", [root])
    matched_paths = {m["path"] for m in result["matches"]}
    assert str(same_identity_different_name) in matched_paths
    assert str(same_name_wrong_identity) not in matched_paths


def test_discover_requires_a_stored_repository(tmp_data_home):
    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []})
    with pytest.raises(recovery.RecoveryError) as exc:
        recovery.discover_matches(registry, "app", [tmp_data_home])
    assert exc.value.code == "no_repository"


# ─────────────────────────────────────────────────────────────────────────────
# Attach — never runs clean_project_artifacts on the historical path
# ─────────────────────────────────────────────────────────────────────────────


def test_attach_never_touches_the_historical_path(tmp_data_home, monkeypatch, capsys):
    import hub
    from skill_hub.entrypoints.cli import project as project_cli

    historical = tmp_data_home / "unrelated-repo-now-lives-here"
    historical.mkdir()
    (historical / "someone-elses-file.txt").write_text("do not touch\n")

    new_checkout = tmp_data_home / "app-checkout"
    new_checkout.mkdir()

    registry = _base_registry(
        app={"path": str(historical), "path_unresolved": True, "enabled": [], "bundles": []}
    )
    _write_registry(tmp_data_home, registry)
    monkeypatch.setattr(hub, "_auto_sync", lambda *a, **kw: pytest.fail("attach must never sync"))
    monkeypatch.setattr(
        project_cli, "clean_project_artifacts",
        lambda *a, **kw: pytest.fail("attach must never clean the historical path"),
    )

    code, reply = invoke(
        monkeypatch, capsys, "recovery", "attach", "--project", "app", "--path", str(new_checkout), "--json"
    )
    assert code == 0 and reply["ok"] is True
    assert (historical / "someone-elses-file.txt").exists()

    saved = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())["projects"]["app"]
    assert saved["path"] == str(new_checkout.resolve())
    assert "path_unresolved" not in saved


def test_attach_adopts_unambiguous_identity_from_explicit_selection(tmp_data_home, monkeypatch, capsys):
    checkout = tmp_data_home / "checkout"
    _repo(checkout, remote="git@github.com:example-org/app.git")
    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []})
    _write_registry(tmp_data_home, registry)

    code, reply = invoke(
        monkeypatch, capsys, "recovery", "attach", "--project", "app", "--path", str(checkout), "--json"
    )
    assert code == 0 and reply["ok"] is True
    saved = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())["projects"]["app"]
    assert saved["repository"]["url"] == "git@github.com:example-org/app.git"


def test_attach_refuses_a_repository_mismatch_with_no_override(tmp_data_home, monkeypatch, capsys):
    checkout = tmp_data_home / "wrong-repo"
    _repo(checkout, remote="git@github.com:example-org/OTHER.git")
    registry = _base_registry(
        app={
            "path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": [],
            "repository": {"url": "https://github.com/example-org/app.git", "remote": "origin", "subdirectory": "."},
        }
    )
    _write_registry(tmp_data_home, registry)

    code, reply = invoke(
        monkeypatch, capsys, "recovery", "attach", "--project", "app", "--path", str(checkout), "--json"
    )
    assert code == 0
    assert reply["ok"] is False
    assert reply["error"]["code"] == "repository_mismatch"
    saved = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())["projects"]["app"]
    assert saved["path_unresolved"] is True  # refused — nothing changed


# ─────────────────────────────────────────────────────────────────────────────
# A8 — clone never overwrites an existing (non-empty) destination
# ─────────────────────────────────────────────────────────────────────────────


def test_stage_and_commit_clone_roundtrip(tmp_data_home):
    origin = tmp_data_home / "origin.git"
    _repo(origin)
    (tmp_data_home / "dest").mkdir()
    destination = tmp_data_home / "dest" / "app"

    staged = recovery.stage_clone(str(origin), destination)
    assert not destination.exists()
    result = recovery.commit_clone(staged["temp_dir"], staged["destination"])
    assert result == destination
    assert (destination / "README.md").exists()
    assert not os.path.exists(staged["temp_dir"])


def test_commit_clone_refuses_a_nonempty_destination_and_cleans_only_the_temp(tmp_data_home):
    origin = tmp_data_home / "origin.git"
    _repo(origin)
    destination = tmp_data_home / "dest"
    destination.mkdir(parents=True)
    (destination / "keep-me.txt").write_text("do not delete\n")

    staged = recovery.stage_clone(str(origin), destination.parent / "other-name")
    with pytest.raises(recovery.RecoveryError) as exc:
        recovery.commit_clone(staged["temp_dir"], destination)
    assert exc.value.code == "destination_not_empty"
    assert not os.path.exists(staged["temp_dir"])
    assert (destination / "keep-me.txt").exists()


def test_commit_clone_permits_an_empty_destination(tmp_data_home):
    origin = tmp_data_home / "origin.git"
    _repo(origin)
    destination = tmp_data_home / "dest"
    destination.mkdir(parents=True)

    staged = recovery.stage_clone(str(origin), destination.parent / "temp-source")
    result = recovery.commit_clone(staged["temp_dir"], destination)
    assert result == destination
    assert (destination / "README.md").exists()


# ─────────────────────────────────────────────────────────────────────────────
# A9 — source recovery rechecks that registered skill paths actually exist
# ─────────────────────────────────────────────────────────────────────────────


def test_restore_sources_flags_missing_skill_paths_even_on_a_reported_clone_success(tmp_data_home, monkeypatch):
    from skill_hub.application.backup import restore as _restore

    registry = _base_registry()
    registry["sources"] = {"src1": {"type": "git", "url": "https://example.invalid/src1.git"}}
    registry["skills"] = {
        "diag": {
            "type": "claude-skill", "managed": "external",
            "origin": {"source": "src1"},
            "source": str(tmp_data_home / "nonexistent-skill-dir"),
        }
    }
    monkeypatch.setattr(
        _restore, "restore_source",
        lambda registry, source_id, **kw: {"ok": True, "source": source_id, "cloned": True, "detail": "re-cloned"},
    )
    results = recovery.restore_sources(registry, ["src1"])
    assert results[0]["ok"] is False
    assert results[0]["missing_skill_paths"] == ["diag"]


def test_restore_sources_is_idempotent_on_a_healthy_cache(tmp_data_home):
    cache = tmp_data_home / "sources" / "src1" / "worktree"
    _repo(cache)
    registry = _base_registry()
    registry["sources"] = {"src1": {"type": "git", "url": "https://example.invalid/src1.git", "cache": str(cache)}}
    results = recovery.restore_sources(registry, ["src1"])
    assert results[0]["ok"] is True
    assert results[0]["cloned"] is False


# ─────────────────────────────────────────────────────────────────────────────
# A12 — local-only source recovery preserves equipment, checks identity when declared
# ─────────────────────────────────────────────────────────────────────────────


def test_local_source_candidates_finds_only_missing_local_skills(tmp_data_home):
    present = tmp_data_home / "present-skill"
    present.mkdir()
    (present / "SKILL.md").write_text("# Present skill\n")
    registry = _base_registry()
    registry["skills"] = {
        "present": {"type": "claude-skill", "managed": "local", "source": str(present)},
        "missing": {"type": "claude-skill", "managed": "local", "source": str(tmp_data_home / "gone")},
        "external": {
            "type": "claude-skill", "managed": "external", "origin": {"source": "src1"},
            "source": str(tmp_data_home / "also-gone"),
        },
    }
    names = {c["skill"] for c in recovery.local_source_candidates(registry)}
    assert names == {"missing"}


def test_set_local_source_rejects_a_declared_identity_mismatch(tmp_data_home):
    candidate = tmp_data_home / "candidate"
    candidate.mkdir()
    (candidate / "SKILL.md").write_text("---\nname: some-other-skill\ndescription: x\n---\nbody\n")
    registry = _base_registry()
    registry["skills"] = {"gh-fix-ci": {"type": "claude-skill", "managed": "local", "source": "/gone"}}
    with pytest.raises(recovery.RecoveryError) as exc:
        recovery.set_local_source(registry, "gh-fix-ci", candidate)
    assert exc.value.code == "identity_mismatch"


def test_set_local_source_accepts_explicit_selection_with_no_frontmatter_name(tmp_data_home):
    # Item 7: an absent-name SKILL.md is only accepted when the folder's OWN
    # identity is unambiguous — here its basename matches the registered name.
    candidate = tmp_data_home / "gh-fix-ci"
    candidate.mkdir()
    (candidate / "SKILL.md").write_text("---\ndescription: fixture, no name key\n---\nbody\n")
    registry = _base_registry()
    registry["skills"] = {"gh-fix-ci": {"type": "claude-skill", "managed": "local", "source": "/gone"}}
    result = recovery.set_local_source(registry, "gh-fix-ci", candidate)
    assert result["source"] == str(candidate.resolve())
    assert registry["skills"]["gh-fix-ci"]["managed"] == "local"  # untouched


def test_set_local_source_rejects_ambiguous_absent_name_with_mismatched_folder(tmp_data_home):
    candidate = tmp_data_home / "random-folder-name"
    candidate.mkdir()
    (candidate / "SKILL.md").write_text("---\ndescription: fixture, no name key\n---\nbody\n")
    registry = _base_registry()
    registry["skills"] = {"gh-fix-ci": {"type": "claude-skill", "managed": "local", "source": "/gone"}}
    with pytest.raises(recovery.RecoveryError) as exc:
        recovery.set_local_source(registry, "gh-fix-ci", candidate)
    assert exc.value.code == "ambiguous_identity"


def test_set_local_source_accepts_absent_name_when_original_source_basename_matches(tmp_data_home):
    candidate = tmp_data_home / "some-other-folder"
    candidate.mkdir()
    (candidate / "SKILL.md").write_text("---\ndescription: fixture, no name key\n---\nbody\n")
    registry = _base_registry()
    registry["skills"] = {
        "gh-fix-ci": {"type": "claude-skill", "managed": "local", "source": str(tmp_data_home / "gone" / "gh-fix-ci")}
    }
    result = recovery.set_local_source(registry, "gh-fix-ci", candidate)
    assert result["source"] == str(candidate.resolve())


def test_set_local_source_mcp_server_needs_no_skill_md(tmp_data_home):
    candidate = tmp_data_home / "mcp-dir"
    candidate.mkdir()
    (candidate / "server.py").write_text("# placeholder mcp server\n")
    registry = _base_registry()
    registry["skills"] = {"skt-mcp": {"type": "mcp-server", "managed": "local", "source": "/gone"}}
    result = recovery.set_local_source(registry, "skt-mcp", candidate)
    assert result["source"] == str(candidate.resolve())


def test_skip_local_source_cli_is_record_only(tmp_data_home, monkeypatch, capsys):
    registry = _base_registry()
    registry["skills"] = {"gh-fix-ci": {"type": "claude-skill", "managed": "local", "source": "/gone", "enabled": True}}
    _write_registry(tmp_data_home, registry)
    before = (tmp_data_home / "registry.yaml").read_text()
    code, reply = invoke(monkeypatch, capsys, "recovery", "skip-local-source", "--skill", "gh-fix-ci", "--json")
    assert code == 0 and reply["ok"] is True
    assert (tmp_data_home / "registry.yaml").read_text() == before


# ─────────────────────────────────────────────────────────────────────────────
# A13 — recovery never publishes backup, dispatches remotes, or clears reconcile
# ─────────────────────────────────────────────────────────────────────────────


def test_recovery_sync_runs_local_only_and_never_touches_backup_or_remotes(tmp_data_home, monkeypatch, capsys):
    import hub
    from skill_hub.application.backup import backup as _backup

    registry = _base_registry()
    registry["backup"] = {"pending_reconcile": True, "enabled": False}
    _write_registry(tmp_data_home, registry)

    monkeypatch.setattr(_backup, "run_backup", lambda *a, **kw: pytest.fail("recovery sync must never push a backup"))

    def _forbidden_sync(args):
        assert getattr(args, "skip_backup", False) is True
        assert getattr(args, "skip_remotes", False) is True
        # Emulate a minimal successful sync report write.
        from skill_hub.application.sync import sync_engine

        report = sync_engine.new_sync_report()
        sync_engine.write_sync_report(report)

    monkeypatch.setattr(hub, "cmd_sync", _forbidden_sync)
    code, reply = invoke(monkeypatch, capsys, "recovery", "sync", "--json")
    assert code == 0 and reply["ok"] is True
    saved = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert saved["backup"]["pending_reconcile"] is True  # never auto-cleared


def test_sync_summary_reflects_the_real_report_not_attach_readiness(tmp_data_home):
    report = {
        "ok": False,
        "global": {"skipped": ["remotes", "backup"], "permissions": {"ok": True, "errors": []},
                   "hooks": {"ok": True, "errors": []}, "doctor": {"ok": True, "errors": []},
                   "skills": {"errors": []}},
        "projects": {
            "app": {"ok": True, "errors": [], "quarantined": None},
            "skipped-app": {"ok": True, "errors": [], "quarantined": "path_unresolved", "outcome": "skipped"},
            "broken-app": {"ok": False, "errors": ["boom"]},
        },
    }
    summary = recovery.summarize_sync_report(report)
    assert summary["ready"] == ["app"]
    assert summary["skipped"] == ["skipped-app"]
    assert summary["failed"] == ["broken-app"]


# ─────────────────────────────────────────────────────────────────────────────
# GitHub repository listing — typed errors, no token leakage, bounded caching
# ─────────────────────────────────────────────────────────────────────────────


def test_github_repos_reports_unavailable_when_gh_is_missing(tmp_data_home, monkeypatch):
    monkeypatch.setattr(recovery, "resolve_binary", lambda name: None)
    result = recovery.list_github_repositories()
    assert result["ok"] is False
    assert result["error_kind"] == "gh_unavailable"


def test_github_repos_query_searches_beyond_the_first_page_via_cache(tmp_data_home, monkeypatch):
    monkeypatch.setattr(recovery, "resolve_binary", lambda name: "/usr/bin/gh")
    calls = {"n": 0}

    def fake_run(args, **kwargs):
        calls["n"] += 1
        assert "api" in args
        if args[-1] == "user":
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps({"login": "octocat"}), stderr="")
        page = 1
        for part in args:
            if part.startswith("user/repos"):
                for kv in part.split("?", 1)[1].split("&"):
                    if kv.startswith("page="):
                        page = int(kv.split("=")[1])
        if page == 1:
            payload = [{"full_name": f"org/repo-{i}", "clone_url": "u"} for i in range(100)]
        elif page == 2:
            payload = [{"full_name": "org/match-me", "clone_url": "u"}]
        else:
            payload = []
        return subprocess.CompletedProcess(args, 0, stdout=json.dumps(payload), stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    result = recovery.list_github_repositories("match-me", page=1, per_page=30)
    assert result["ok"] is True
    assert any(r["full_name"] == "org/match-me" for r in result["repositories"])
    assert result["truncated"] is False

    # A second search within the TTL reuses the CACHED repo list — it still
    # re-checks the current account login (cheap, one call), but must not
    # re-paginate the whole account again.
    calls["n"] = 0
    result2 = recovery.list_github_repositories("match-me", page=1, per_page=30)
    assert result2["ok"] is True
    assert calls["n"] == 1  # only the login check; no `user/repos` refetch


def test_github_repos_reports_unauthenticated(tmp_data_home, monkeypatch):
    monkeypatch.setattr(recovery, "resolve_binary", lambda name: "/usr/bin/gh")
    monkeypatch.setattr(
        subprocess, "run",
        lambda args, **kw: subprocess.CompletedProcess(
            args, 1, stdout="", stderr="You are not logged in. Run gh auth login."
        ),
    )
    result = recovery.list_github_repositories()
    assert result["ok"] is False
    assert result["error_kind"] == "unauthenticated"


def test_github_repos_cache_does_not_leak_across_accounts(tmp_data_home, monkeypatch):
    monkeypatch.setattr(recovery, "resolve_binary", lambda name: "/usr/bin/gh")
    login = {"who": "account-a"}

    def fake_run(args, **kwargs):
        if args[-1] == "user":
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps({"login": login["who"]}), stderr="")
        page = None
        for part in args:
            if part.startswith("user/repos"):
                for kv in part.split("?", 1)[1].split("&"):
                    if kv.startswith("page="):
                        page = int(kv.split("=")[1])
        payload = (
            [{"full_name": f"{login['who']}/repo", "clone_url": "u"}] if page == 1 else []
        )
        return subprocess.CompletedProcess(args, 0, stdout=json.dumps(payload), stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    first = recovery.list_github_repositories("repo", page=1, per_page=30)
    assert [r["full_name"] for r in first["repositories"]] == ["account-a/repo"]

    # The `gh` account switches. The next search must not read account-a's
    # cached list even though it is still within the TTL.
    login["who"] = "account-b"
    second = recovery.list_github_repositories("repo", page=1, per_page=30)
    assert [r["full_name"] for r in second["repositories"]] == ["account-b/repo"]


def test_github_repos_truncation_is_reported_not_silent(tmp_data_home, monkeypatch):
    monkeypatch.setattr(recovery, "resolve_binary", lambda name: "/usr/bin/gh")
    monkeypatch.setattr(recovery, "MAX_GITHUB_FETCH", 100)
    monkeypatch.setattr(recovery, "GITHUB_PAGE_SIZE", 100)

    def fake_run(args, **kwargs):
        if args[-1] == "user":
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps({"login": "octocat"}), stderr="")
        # Every page comes back full — the account has more than the cap.
        payload = [{"full_name": f"org/repo-{i}", "clone_url": "u"} for i in range(100)]
        return subprocess.CompletedProcess(args, 0, stdout=json.dumps(payload), stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    result = recovery.list_github_repositories("nonexistent-repo-name", page=1, per_page=30)
    assert result["ok"] is True
    assert result["repositories"] == []
    assert result["truncated"] is True


# ─────────────────────────────────────────────────────────────────────────────
# Argparse wiring smoke test (CLI slice rule: must go through hub.main())
# ─────────────────────────────────────────────────────────────────────────────


def test_recovery_status_crosses_the_real_parser(tmp_data_home, monkeypatch, capsys):
    _write_registry(tmp_data_home, _base_registry())
    code, reply = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    assert code == 0
    assert reply["ok"] is True
    assert reply["projects"] == []
    assert reply["needs_recovery"] is False


# ─────────────────────────────────────────────────────────────────────────────
# Frontend wire reconciliation (app/src/lib/recoveryContract.ts): `completed`
# /`dismissed` are booleans, `finish` closes the journey outright, `start`
# reopens it, `discover`/`github-repos` carry flat string errors.
# ─────────────────────────────────────────────────────────────────────────────


def test_finish_refuses_while_a_project_is_unresolved(tmp_data_home, monkeypatch, capsys):
    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []})
    _write_registry(tmp_data_home, registry)
    code, reply = invoke(monkeypatch, capsys, "recovery", "finish", "--json")
    assert code == 0
    assert reply["ok"] is False
    assert reply["error"]["code"] == "unresolved_items"


def test_finish_sets_both_completed_and_dismissed_booleans_once_resolved(tmp_data_home, monkeypatch, capsys):
    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []})
    _write_registry(tmp_data_home, registry)
    invoke(monkeypatch, capsys, "recovery", "skip", "--project", "app", "--json")
    code, reply = invoke(monkeypatch, capsys, "recovery", "finish", "--json")
    assert code == 0
    assert reply["completed"] is True
    assert reply["dismissed"] is True
    assert reply["needs_recovery"] is False


def test_finish_defer_marks_unresolved_rows_deferred_not_skipped(tmp_data_home, monkeypatch, capsys):
    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []})
    _write_registry(tmp_data_home, registry)
    code, reply = invoke(monkeypatch, capsys, "recovery", "finish", "--defer", "--json")
    assert code == 0
    assert reply["completed"] is True
    row = reply["projects"][0]
    assert row["status"] == "deferred"
    assert row["status"] != "skipped"


def test_finish_defer_preserves_failed_source_details_and_successful_sources(tmp_data_home):
    healthy_cache = tmp_data_home / "sources" / "ready" / "worktree"
    _repo(healthy_cache)
    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []})
    registry["sources"] = {
        "failed": {"type": "git", "url": "https://example.invalid/failed.git"},
        "ready": {"type": "git", "url": "https://example.invalid/ready.git", "cache": str(healthy_cache)},
    }
    record = recovery.start_operation(recovery.empty_record(), snapshot_key=None)
    recovery.set_source_job(record, "failed", "failed", detail="SSH authentication failed")
    recovery.set_source_job(record, "ready", "ready", detail="recovered")
    recovery.finish_operation(registry, record, defer=True)

    status = recovery.build_status(registry, record)
    rows = {row["id"]: row for row in status["sources"]}
    assert rows["failed"]["status"] == "failed"
    assert rows["failed"]["detail"] == "SSH authentication failed"
    assert rows["ready"]["status"] == "ready"
    assert status["completed"] is True
    assert status["dismissed"] is True


def test_finish_refuses_a_current_sync_with_delivery_failures_but_defer_can_close(tmp_data_home):
    project_path = tmp_data_home / "app"
    project_path.mkdir()
    registry = _base_registry(app={"path": str(project_path), "enabled": [], "bundles": []})
    _write_registry(tmp_data_home, registry)
    record = recovery.start_operation(recovery.empty_record(), snapshot_key=None)
    recovery.record_sync_result(
        record,
        {
            "ok": False,
            "counts": {"success": 0, "skipped": 0, "failed": 1},
            "failed_projects": ["app"],
            "project_failures": {"app": ["Could not write project files"]},
            "global_failures": [],
            "error": None,
        },
        registry_hash=recovery.registry_content_hash(tmp_data_home),
    )
    with pytest.raises(recovery.RecoveryError) as exc:
        recovery.finish_operation(registry, record)
    assert exc.value.code == "unresolved_items"
    assert "local sync" in str(exc.value)

    recovery.finish_operation(registry, record, defer=True)
    assert record["sync"]["project_failures"] == {"app": ["Could not write project files"]}
    assert record["completed_at"] is not None


def test_finish_refuses_global_failure_without_attached_projects(tmp_data_home):
    registry = _base_registry()
    _write_registry(tmp_data_home, registry)
    record = recovery.start_operation(recovery.empty_record(), snapshot_key=None)
    recovery.record_sync_result(
        record,
        {"ok": False, "counts": {"success": 0, "skipped": 0, "failed": 0},
         "global_failures": ["hooks: source missing"]},
        registry_hash=recovery.registry_content_hash(tmp_data_home),
    )
    with pytest.raises(recovery.RecoveryError, match="local sync"):
        recovery.finish_operation(registry, record)
    assert record.get("completed_at") is None
    recovery.finish_operation(registry, record, defer=True)
    assert record["sync"]["global_failures"] == ["hooks: source missing"]


def test_attach_succeeds_on_one_project_despite_a_dismissed_operation(tmp_data_home, monkeypatch, capsys):
    checkout = tmp_data_home / "checkout"
    _repo(checkout, remote="git@github.com:example-org/app.git")
    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []})
    _write_registry(tmp_data_home, registry)
    invoke(monkeypatch, capsys, "recovery", "skip", "--project", "app", "--json")
    finish_code, finish_reply = invoke(monkeypatch, capsys, "recovery", "finish", "--json")
    assert finish_code == 0 and finish_reply["completed"] is True

    code, reply = invoke(
        monkeypatch, capsys, "recovery", "attach", "--project", "app", "--path", str(checkout), "--json"
    )
    assert code == 0 and reply["ok"] is True
    _, status = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    row = status["projects"][0]
    assert row["status"] == "ready"
    assert row["attached"] is True


def test_stale_completed_record_from_an_earlier_restore_does_not_hide_new_work(tmp_data_home, monkeypatch, capsys):
    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []})
    registry["bootstrap"] = {
        "restored_from": "git@github.com:example-org/backup.git",
        "restored_at": "2026-01-01T00:00:00Z",
    }
    _write_registry(tmp_data_home, registry)

    # A PRIOR restore of the same backup repo was fully finished.
    old_identity = recovery.current_snapshot_identity(registry)
    record = recovery.empty_record()
    record["operation_id"] = "old-op"
    record["snapshot_key"] = old_identity
    record = recovery.mark_finished(record)
    recovery.write_record(record)

    # A NEW restore of the SAME repo lands (fresh `restored_at`) with the
    # project still pending — the OLD operation's completed/dismissed must
    # not suppress this, even though `start` was never called yet.
    registry["bootstrap"]["restored_at"] = "2026-02-01T00:00:00Z"
    _write_registry(tmp_data_home, registry)

    code, reply = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    assert code == 0
    assert reply["needs_recovery"] is True
    assert reply["completed"] is False
    assert reply["dismissed"] is False


def test_healthy_install_never_gates_even_with_a_stale_completed_record(tmp_data_home, monkeypatch, capsys):
    project_path = tmp_data_home / "app"
    project_path.mkdir()
    registry = _base_registry(app={"path": str(project_path), "enabled": [], "bundles": []})
    registry["bootstrap"] = {
        "restored_from": "git@github.com:example-org/backup.git", "restored_at": "2026-01-01T00:00:00Z",
    }
    _write_registry(tmp_data_home, registry)

    record = recovery.empty_record()
    record["operation_id"] = "old-op"
    record["snapshot_key"] = "some-other-identity-entirely"
    record = recovery.mark_finished(record)
    recovery.write_record(record)

    code, reply = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    assert code == 0
    assert reply["needs_recovery"] is False


def test_discover_error_is_a_flat_string(tmp_data_home, monkeypatch, capsys):
    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []})
    _write_registry(tmp_data_home, registry)
    code, reply = invoke(
        monkeypatch, capsys, "recovery", "discover", "--project", "app", "--root", str(tmp_data_home), "--json"
    )
    assert code == 0
    assert reply["ok"] is False
    assert isinstance(reply["error"], str)
    assert "error_kind" not in reply


def test_sync_result_is_the_flat_wire_shape(tmp_data_home, monkeypatch, capsys):
    import hub
    from skill_hub.application.sync import sync_engine

    _write_registry(tmp_data_home, _base_registry())

    def _fake_sync(args):
        report = sync_engine.new_sync_report()
        report["projects"] = {
            "app": {"ok": True, "errors": []},
            "skipped-app": {"ok": True, "errors": [], "quarantined": "x", "outcome": "skipped"},
        }
        sync_engine.write_sync_report(report)

    monkeypatch.setattr(hub, "cmd_sync", _fake_sync)
    code, reply = invoke(monkeypatch, capsys, "recovery", "sync", "--json")
    assert code == 0
    assert reply["counts"] == {"success": 1, "skipped": 1, "failed": 0}
    assert reply["failed_projects"] == []
    assert all(isinstance(item, str) for item in reply["global_failures"])
    assert reply["error"] is None


def test_sync_result_exposes_readable_project_and_global_failures(tmp_data_home, monkeypatch, capsys):
    import hub
    from skill_hub.application.sync import sync_engine

    _write_registry(tmp_data_home, _base_registry())

    def _fake_sync(args):
        report = sync_engine.new_sync_report()
        report["projects"] = {
            "dev": {
                "ok": False,
                "errors": [{"stage": "symlink", "message": "source missing: /tmp/skill"}],
            },
        }
        report["global"]["hooks"] = {"ok": False, "errors": [{"message": "hook stream failed"}]}
        sync_engine.write_sync_report(report)

    monkeypatch.setattr(hub, "cmd_sync", _fake_sync)
    code, reply = invoke(monkeypatch, capsys, "recovery", "sync", "--json")
    assert code == 0
    assert reply["project_failures"] == {"dev": ["symlink: source missing: /tmp/skill"]}
    assert reply["global_failures"] == ["hooks: hook stream failed"]
    assert all("{" not in failure for failure in reply["global_failures"])

    saved = recovery.read_record()
    assert saved["sync"]["project_failures"] == reply["project_failures"]
    assert saved["sync"]["global_failures"] == reply["global_failures"]


def test_sync_catches_a_failing_cmd_sync_and_still_reports_the_current_run(tmp_data_home, monkeypatch, capsys):
    """Item 11: a `SystemExit` from `hub.cmd_sync` (stream failure / doctor
    danger) must not crash `hub recovery sync` before it can emit JSON — the
    report `cmd_sync`'s own try/finally just wrote is still the current run's,
    and this command must read and report it truthfully."""
    import hub
    from skill_hub.application.sync import sync_engine

    _write_registry(tmp_data_home, _base_registry())

    def _failing_sync(args):
        report = sync_engine.new_sync_report()
        report["projects"] = {"app": {"ok": False, "errors": ["stream write failed"]}}
        sync_engine.write_sync_report(report)
        raise SystemExit(1)

    monkeypatch.setattr(hub, "cmd_sync", _failing_sync)
    code, reply = invoke(monkeypatch, capsys, "recovery", "sync", "--json")
    assert code == 0
    assert reply["ok"] is False
    assert reply["sync_exit_code"] == 1
    assert reply["counts"]["failed"] == 1
    assert reply["error"] is not None


def test_sync_persists_evidence_so_finish_knows_delivery_was_attempted(tmp_data_home, monkeypatch, capsys):
    """The second half of item 11's requirement: `finish` cannot claim
    delivery happened for an attached project if `sync` never ran."""
    import hub
    from skill_hub.application.sync import sync_engine

    project_path = tmp_data_home / "app"
    project_path.mkdir()
    registry = _base_registry(app={"path": str(project_path), "enabled": [], "bundles": []})
    _write_registry(tmp_data_home, registry)

    code, reply = invoke(monkeypatch, capsys, "recovery", "finish", "--json")
    assert code == 0
    assert reply["ok"] is False
    assert "sync" in reply["error"]["message"]

    def _fake_sync(args):
        sync_engine.write_sync_report(sync_engine.new_sync_report())

    monkeypatch.setattr(hub, "cmd_sync", _fake_sync)
    invoke(monkeypatch, capsys, "recovery", "sync", "--json")
    code, reply = invoke(monkeypatch, capsys, "recovery", "finish", "--json")
    assert code == 0 and reply.get("completed") is True


# ─────────────────────────────────────────────────────────────────────────────
# Item 1 — source_status_rows must not read `ready` when a registered skill
# path is missing, even though the git cache itself is present
# ─────────────────────────────────────────────────────────────────────────────


def test_source_status_row_is_not_ready_when_a_registered_skill_path_is_missing(tmp_data_home):
    cache = tmp_data_home / "sources" / "src1" / "worktree"
    _repo(cache)
    registry = _base_registry()
    registry["sources"] = {"src1": {"type": "git", "url": "https://example.invalid/src1.git", "cache": str(cache)}}
    registry["skills"] = {
        "diag": {
            "type": "claude-skill", "managed": "external", "origin": {"source": "src1"},
            "source": str(tmp_data_home / "does-not-exist"),
        }
    }
    rows = recovery.source_status_rows(registry, recovery.empty_record())
    assert rows[0]["healthy"] is False
    assert rows[0]["status"] == "pending"
    assert "diag" in rows[0]["detail"]


# ─────────────────────────────────────────────────────────────────────────────
# Item 8 — discover returns the registered subdirectory, not the checkout root
# ─────────────────────────────────────────────────────────────────────────────


def test_discover_match_path_is_the_registered_subdirectory_and_attach_accepts_it(tmp_data_home):
    root = tmp_data_home / "roots"
    checkout = root / "monorepo"
    _repo(checkout, remote="git@github.com:example-org/mono.git")
    (checkout / "packages" / "app").mkdir(parents=True)
    registry = _base_registry(
        app={
            "path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": [],
            "repository": {
                "url": "https://github.com/example-org/mono.git", "remote": "origin",
                "subdirectory": "packages/app",
            },
        }
    )
    result = recovery.discover_matches(registry, "app", [root])
    assert len(result["matches"]) == 1
    match_path = result["matches"][0]["path"]
    assert match_path == str(checkout / "packages" / "app")

    # And attach succeeds directly with that path — no subdirectory_mismatch.
    plan = recovery.plan_attach(registry, "app", match_path)
    assert plan["new_path"] == str((checkout / "packages" / "app").resolve())


# ─────────────────────────────────────────────────────────────────────────────
# Item 9 — stage_clone never deletes anything; it only creates its own dir
# ─────────────────────────────────────────────────────────────────────────────


def test_stage_clone_never_calls_rmtree_before_owning_the_temp_dir(tmp_data_home, monkeypatch):
    calls = []
    monkeypatch.setattr(recovery.shutil, "rmtree", lambda *a, **kw: calls.append(a))
    origin = tmp_data_home / "origin.git"
    _repo(origin)
    (tmp_data_home / "dest").mkdir()
    staged = recovery.stage_clone(str(origin), tmp_data_home / "dest" / "app")
    assert calls == []  # a clean clone never removes anything
    assert Path(staged["temp_dir"]).is_dir()


def test_stage_clone_reuses_source_transport_without_mutating_auth(tmp_data_home, monkeypatch):
    destination_parent = tmp_data_home / "dest"
    destination_parent.mkdir()
    calls = {}

    def fake_transport(url, registry):
        calls["transport"] = (url, registry)
        return [{
            "method": "gh",
            "url": "https://github.com/example-org/app.git",
            "args": ["-c", "credential.helper=!temporary"],
            "env": {"GIT_SSH_COMMAND": "ssh -o BatchMode=yes"},
        }]

    def fake_run(args, **kwargs):
        calls["run"] = (args, kwargs)
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    registry = {"backup": {"auth": {"method": "ssh"}}}
    monkeypatch.setattr(recovery._restore, "source_transport_attempts", fake_transport)
    monkeypatch.setattr(recovery.subprocess, "run", fake_run)
    staged = recovery.stage_clone(
        "git@github.com:example-org/app.git",
        destination_parent / "app",
        timeout=17,
        registry=registry,
    )
    try:
        assert calls["transport"] == ("git@github.com:example-org/app.git", registry)
        args, kwargs = calls["run"]
        assert args[:4] == ["git", "-c", "credential.helper=!temporary", "clone"]
        assert args[-2] == "https://github.com/example-org/app.git"
        assert kwargs["timeout"] == 17
        assert kwargs["env"]["GIT_TERMINAL_PROMPT"] == "0"
        assert kwargs["env"]["GIT_SSH_COMMAND"] == "ssh -o BatchMode=yes"
    finally:
        recovery.cleanup_clone_temp(staged["temp_dir"])


def test_stage_clone_preferred_gh_skips_recorded_ssh_transport(tmp_data_home, monkeypatch):
    destination_parent = tmp_data_home / "dest"
    destination_parent.mkdir()
    calls = []
    monkeypatch.setattr(
        recovery._restore._backup,
        "detect_auth",
        lambda preferred=None, **kwargs: {"method": "gh", "ladder": []},
    )

    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    monkeypatch.setattr(recovery.subprocess, "run", fake_run)
    staged = recovery.stage_clone(
        "git@github.com:example-org/app.git",
        destination_parent / "app",
        registry={"backup": {"auth": "gh"}},
    )
    try:
        assert len(calls) == 1
        args, _kwargs = calls[0]
        assert args[:4] == ["git", "-c", "credential.helper=!gh auth git-credential", "clone"]
        assert args[-2] == "https://github.com/example-org/app.git"
    finally:
        recovery.cleanup_clone_temp(staged["temp_dir"])


def test_stage_clone_selected_ssh_falls_back_once_to_https(tmp_data_home, monkeypatch):
    destination_parent = tmp_data_home / "dest"
    destination_parent.mkdir()
    calls = []
    monkeypatch.setattr(
        recovery._restore._backup,
        "detect_auth",
        lambda preferred=None, **kwargs: {
            "method": "ssh",
            "ladder": [{"method": "pat", "available": True}],
        },
    )
    monkeypatch.setattr(recovery._restore._backup_git, "get_pat", lambda: "test-token")

    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        if len(calls) == 1:
            return subprocess.CompletedProcess(args, 128, stdout="", stderr="Permission denied (publickey).")
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    monkeypatch.setattr(recovery.subprocess, "run", fake_run)
    staged = recovery.stage_clone(
        "git@github.com:example-org/app.git",
        destination_parent / "app",
        registry={"backup": {"auth": "auto"}},
    )
    try:
        assert len(calls) == 2
        assert calls[0][0][-2] == "git@github.com:example-org/app.git"
        assert calls[1][0][-2] == "https://github.com/example-org/app.git"
        assert calls[1][1]["env"]["SKILL_HUB_BACKUP_TOKEN"] == "test-token"
    finally:
        recovery.cleanup_clone_temp(staged["temp_dir"])


def test_stage_clone_cleans_up_only_its_own_temp_on_keyboard_interrupt(tmp_data_home, monkeypatch):
    origin = tmp_data_home / "origin.git"
    _repo(origin)
    (tmp_data_home / "dest").mkdir()

    def fake_run(*a, **kw):
        raise KeyboardInterrupt()

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(KeyboardInterrupt):
        recovery.stage_clone(str(origin), tmp_data_home / "dest" / "app")
    assert list((tmp_data_home / "dest").iterdir()) == []


# ─────────────────────────────────────────────────────────────────────────────
# Item 10 — clone: correct remote naming, mid-clone revalidation
# ─────────────────────────────────────────────────────────────────────────────


def test_plan_attach_after_clone_must_use_origin_not_the_stored_remote_name(tmp_data_home):
    """`git clone` always names the remote it creates "origin" — a stored
    association recorded under a different remote name (`set-repository
    --remote upstream`) must not make a freshly-cloned checkout look
    mismatched."""
    target = tmp_data_home / "freshly-cloned"
    _repo(target, remote="https://github.com/example-org/app.git")  # what `git clone` actually produces
    registry = _base_registry(
        app={
            "path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": [],
            "repository": {"url": "https://github.com/example-org/app.git", "remote": "upstream", "subdirectory": "."},
        }
    )
    plan = recovery.plan_attach(registry, "app", target, remote="origin")
    assert plan["new_path"] == str(target.resolve())


def test_clone_cli_attaches_using_the_actual_origin_remote_name(tmp_data_home, monkeypatch, capsys):
    registry = _base_registry(
        app={
            "path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": [],
            "repository": {"url": "https://github.com/example-org/app.git", "remote": "upstream", "subdirectory": "."},
        }
    )
    _write_registry(tmp_data_home, registry)
    destination = tmp_data_home / "cloned-app"

    def fake_stage_clone(url, dest, **kwargs):
        dest = Path(dest)
        temp_dir = dest.parent / ".fake-clone-temp"
        _repo(temp_dir, remote="https://github.com/example-org/app.git")
        return {"temp_dir": str(temp_dir), "destination": str(dest)}

    monkeypatch.setattr(recovery, "stage_clone", fake_stage_clone)
    code, reply = invoke(
        monkeypatch, capsys, "recovery", "clone", "--project", "app", "--destination", str(destination), "--json"
    )
    assert code == 0 and reply["ok"] is True
    saved = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())["projects"]["app"]
    assert saved["path"] == str(destination.resolve())
    assert "path_unresolved" not in saved


def test_clone_aborts_if_association_changes_mid_clone_and_leaves_project_unattached(
    tmp_data_home, monkeypatch, capsys
):
    registry = _base_registry(
        app={
            "path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": [],
            "repository": {"url": "https://github.com/example-org/app.git", "remote": "origin", "subdirectory": "."},
        }
    )
    _write_registry(tmp_data_home, registry)
    destination = tmp_data_home / "cloned-app"

    def fake_stage_clone(url, dest, **kwargs):
        # Another process changes the association WHILE this network clone
        # runs — deliberately unlocked (item 12).
        current = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
        current["projects"]["app"]["repository"]["url"] = "https://github.com/example-org/changed.git"
        _write_registry(tmp_data_home, current)
        dest = Path(dest)
        temp_dir = dest.parent / ".race-temp"
        temp_dir.mkdir(parents=True)
        return {"temp_dir": str(temp_dir), "destination": str(dest)}

    monkeypatch.setattr(recovery, "stage_clone", fake_stage_clone)
    code, reply = invoke(
        monkeypatch, capsys, "recovery", "clone", "--project", "app", "--destination", str(destination), "--json"
    )
    assert code == 0
    assert reply["ok"] is False
    assert reply["error"]["code"] == "association_changed"
    assert not destination.exists()
    assert not (tmp_data_home / ".race-temp").exists()  # temp cleaned up
    saved = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())["projects"]["app"]
    assert saved["path_unresolved"] is True


# ─────────────────────────────────────────────────────────────────────────────
# Item 12 — restore-source: retries incomplete non-skipped sources, persists
# per source (an earlier success survives a later crash)
# ─────────────────────────────────────────────────────────────────────────────


def test_restore_source_all_skips_explicitly_skipped_sources(tmp_data_home, monkeypatch, capsys):
    registry = _base_registry()
    registry["sources"] = {
        "src1": {"type": "git", "url": "https://example.invalid/src1.git"},
        "src2": {"type": "git", "url": "https://example.invalid/src2.git"},
    }
    _write_registry(tmp_data_home, registry)
    invoke(monkeypatch, capsys, "recovery", "skip-source", "src2", "--json")

    from skill_hub.application.backup import restore as _restore

    def fake_restore_source(registry, source_id, **kwargs):
        if source_id == "src2":
            pytest.fail("must not retry an explicitly skipped source")
        return {"ok": True, "source": source_id, "cloned": True, "cache": "x", "detail": "cloned"}

    monkeypatch.setattr(_restore, "restore_source", fake_restore_source)
    code, reply = invoke(monkeypatch, capsys, "recovery", "restore-source", "--all", "--json")
    assert code == 0 and reply["ok"] is True
    skipped_result = next(r for r in reply["results"] if r["source"] == "src2")
    assert skipped_result.get("skipped") is True


def test_restore_source_all_persists_earlier_success_when_a_later_source_crashes(tmp_data_home, monkeypatch, capsys):
    registry = _base_registry()
    registry["sources"] = {
        "src1": {"type": "git", "url": "https://example.invalid/src1.git"},
        "src2": {"type": "git", "url": "https://example.invalid/src2.git"},
    }
    _write_registry(tmp_data_home, registry)

    from skill_hub.application.backup import restore as _restore

    def fake_restore_source(registry, source_id, **kwargs):
        if source_id == "src1":
            registry["sources"]["src1"]["status"] = "up-to-date"
            registry["sources"]["src1"]["current_ref"] = "abc123"
            return {"ok": True, "source": "src1", "cloned": True, "cache": "x", "detail": "cloned"}
        raise RuntimeError("boom — src2 crashes unexpectedly")

    monkeypatch.setattr(_restore, "restore_source", fake_restore_source)
    with pytest.raises(RuntimeError):
        invoke(monkeypatch, capsys, "recovery", "restore-source", "--all", "--json")

    saved = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert saved["sources"]["src1"]["status"] == "up-to-date"


# ─────────────────────────────────────────────────────────────────────────────
# Item 1 — needs_recovery stays true for the WHOLE active operation, not just
# while rows are outstanding; healthy never-restored installs stay ungated;
# a direct mutation auto-initializes the operation without an explicit start
# ─────────────────────────────────────────────────────────────────────────────


def test_needs_recovery_stays_true_after_every_row_resolves_until_finish(tmp_data_home, monkeypatch, capsys):
    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []})
    registry["bootstrap"] = {
        "restored_from": "git@github.com:example-org/backup.git", "restored_at": "2026-01-01T00:00:00Z",
    }
    _write_registry(tmp_data_home, registry)

    invoke(monkeypatch, capsys, "recovery", "start", "--json")
    code, reply = invoke(monkeypatch, capsys, "recovery", "skip", "--project", "app", "--json")
    assert code == 0

    # Every row is now settled (skipped) — but the operation is still active
    # (never finished), so the reopen banner must not disappear yet.
    _, status = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    assert status["projects"][0]["status"] == "skipped"
    assert status["needs_recovery"] is True

    code, reply = invoke(monkeypatch, capsys, "recovery", "finish", "--json")
    assert code == 0 and reply["completed"] is True
    _, status = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    assert status["needs_recovery"] is False


def test_healthy_never_restored_install_stays_ungated_by_an_unrelated_local_source(tmp_data_home, monkeypatch, capsys):
    project_path = tmp_data_home / "app"
    project_path.mkdir()
    registry = _base_registry(app={"path": str(project_path), "enabled": [], "bundles": []})
    registry["skills"] = {
        "broken-unrelated": {"type": "claude-skill", "managed": "local", "source": str(tmp_data_home / "gone")}
    }
    # No `bootstrap.restored_from` at all — this machine never restored anything.
    _write_registry(tmp_data_home, registry)

    code, reply = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    assert code == 0
    assert reply["local_sources"][0]["status"] == "pending"  # the break is real...
    assert reply["needs_recovery"] is False  # ...but never gates an unrestored install


def test_direct_mutation_auto_initializes_the_operation_without_start(tmp_data_home, monkeypatch, capsys):
    registry = _base_registry(app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []})
    registry["bootstrap"] = {
        "restored_from": "git@github.com:example-org/backup.git", "restored_at": "2026-01-01T00:00:00Z",
    }
    _write_registry(tmp_data_home, registry)

    # No `recovery start` call at all — a direct action (e.g. a project's own
    # "Attach directory") must still work and register an active operation.
    code, reply = invoke(monkeypatch, capsys, "recovery", "skip", "--project", "app", "--json")
    assert code == 0 and reply["ok"] is True

    _, status = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    assert status["operation_id"] is not None
    assert status["needs_recovery"] is True  # active operation, not yet finished


def test_mutation_does_not_reopen_an_already_finished_operation(tmp_data_home, monkeypatch, capsys):
    registry = _base_registry(
        app={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []},
        other={"path": "/also-nonexistent", "path_unresolved": True, "enabled": [], "bundles": []},
    )
    registry["bootstrap"] = {
        "restored_from": "git@github.com:example-org/backup.git", "restored_at": "2026-01-01T00:00:00Z",
    }
    _write_registry(tmp_data_home, registry)

    invoke(monkeypatch, capsys, "recovery", "skip", "--project", "app", "--json")
    invoke(monkeypatch, capsys, "recovery", "skip", "--project", "other", "--json")
    finish_code, finish_reply = invoke(monkeypatch, capsys, "recovery", "finish", "--json")
    assert finish_code == 0 and finish_reply["completed"] is True

    # An unrelated mutation after finishing must not silently reopen it.
    invoke(monkeypatch, capsys, "recovery", "skip-local-source", "--skill", "nonexistent-skill", "--json")
    _, status = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    assert status["completed"] is True
    assert status["needs_recovery"] is False


# ─────────────────────────────────────────────────────────────────────────────
# Item 2 — persisted sync result + sync_current, invalidated by registry hash
# ─────────────────────────────────────────────────────────────────────────────


def test_status_exposes_sync_result_and_sync_current(tmp_data_home, monkeypatch, capsys):
    import hub
    from skill_hub.application.sync import sync_engine

    project_path = tmp_data_home / "app"
    project_path.mkdir()
    registry = _base_registry(app={"path": str(project_path), "enabled": [], "bundles": []})
    _write_registry(tmp_data_home, registry)

    def _fake_sync(args):
        report = sync_engine.new_sync_report()
        report["projects"] = {"app": {"ok": True, "errors": []}}
        sync_engine.write_sync_report(report)

    monkeypatch.setattr(hub, "cmd_sync", _fake_sync)
    invoke(monkeypatch, capsys, "recovery", "sync", "--json")

    _, status = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    assert status["sync_result"] is not None
    assert status["sync_result"]["counts"]["success"] == 1
    assert status["sync_current"] is True


def test_sync_current_is_invalidated_by_a_later_registry_change(tmp_data_home, monkeypatch, capsys):
    import hub
    from skill_hub.application.sync import sync_engine

    project_path = tmp_data_home / "app"
    project_path.mkdir()
    registry = _base_registry(
        app={"path": str(project_path), "enabled": [], "bundles": []},
        other={"path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": []},
    )
    _write_registry(tmp_data_home, registry)

    def _fake_sync(args):
        sync_engine.write_sync_report(sync_engine.new_sync_report())

    monkeypatch.setattr(hub, "cmd_sync", _fake_sync)
    invoke(monkeypatch, capsys, "recovery", "sync", "--json")
    _, status = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    assert status["sync_current"] is True

    # The registry changes (an unrelated project attaches its repository) —
    # the prior sync's evidence must no longer be considered current.
    invoke(
        monkeypatch, capsys, "recovery", "set-repository", "--project", "other",
        "--url", "https://github.com/example-org/other.git", "--json",
    )
    _, status = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    assert status["sync_current"] is False
    assert status["sync_result"] is not None  # the evidence itself is still there, just stale


def test_finish_requires_a_fresh_sync_after_a_later_registry_change(tmp_data_home, monkeypatch, capsys):
    import hub
    from skill_hub.application.sync import sync_engine

    project_path = tmp_data_home / "app"
    project_path.mkdir()
    registry = _base_registry(app={"path": str(project_path), "enabled": [], "bundles": []})
    _write_registry(tmp_data_home, registry)

    def _fake_sync(args):
        sync_engine.write_sync_report(sync_engine.new_sync_report())

    monkeypatch.setattr(hub, "cmd_sync", _fake_sync)
    invoke(monkeypatch, capsys, "recovery", "sync", "--json")

    # Touch the registry afterward (a source recovered, say) without syncing again.
    invoke(monkeypatch, capsys, "recovery", "skip-source", "irrelevant-does-not-exist", "--json")
    registry_now = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    registry_now["sources"] = {"new-src": {"type": "git", "url": "https://example.invalid/x.git"}}
    _write_registry(tmp_data_home, registry_now)

    code, reply = invoke(monkeypatch, capsys, "recovery", "finish", "--json")
    assert code == 0
    assert reply["ok"] is False
    assert "sync" in reply["error"]["message"]


# ─────────────────────────────────────────────────────────────────────────────
# Item 4 — clone validates BEFORE commit; concurrent project change detected
# ─────────────────────────────────────────────────────────────────────────────


def test_clone_never_leaves_a_destination_behind_on_subdirectory_mismatch(tmp_data_home, monkeypatch, capsys):
    registry = _base_registry(
        app={
            "path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": [],
            "repository": {
                "url": "https://github.com/example-org/mono.git", "remote": "origin",
                "subdirectory": "packages/does-not-exist-in-the-clone",
            },
        }
    )
    _write_registry(tmp_data_home, registry)
    destination = tmp_data_home / "cloned-app"

    def fake_stage_clone(url, dest, **kwargs):
        dest = Path(dest)
        temp_dir = dest.parent / ".fake-clone-temp"
        _repo(temp_dir, remote="https://github.com/example-org/mono.git")  # no packages/ subdir in it
        return {"temp_dir": str(temp_dir), "destination": str(dest)}

    monkeypatch.setattr(recovery, "stage_clone", fake_stage_clone)
    code, reply = invoke(
        monkeypatch, capsys, "recovery", "clone", "--project", "app", "--destination", str(destination), "--json"
    )
    assert code == 0
    assert reply["ok"] is False
    # Neither the real destination NOR the temp staging dir survive.
    assert not destination.exists()
    assert not (tmp_data_home / ".fake-clone-temp").exists()


def test_clone_aborts_when_the_project_was_attached_by_another_action_mid_clone(tmp_data_home, monkeypatch, capsys):
    registry = _base_registry(
        app={
            "path": "/nonexistent", "path_unresolved": True, "enabled": [], "bundles": [],
            "repository": {"url": "https://github.com/example-org/app.git", "remote": "origin", "subdirectory": "."},
        }
    )
    _write_registry(tmp_data_home, registry)
    destination = tmp_data_home / "cloned-app"
    elsewhere = tmp_data_home / "already-attached-elsewhere"
    _repo(elsewhere, remote="https://github.com/example-org/app.git")

    def fake_stage_clone(url, dest, **kwargs):
        # A concurrent explicit `attach` lands on this SAME project while
        # this clone's network step (deliberately unlocked) runs.
        invoke_direct_attach()
        dest = Path(dest)
        temp_dir = dest.parent / ".race-attach-temp"
        _repo(temp_dir, remote="https://github.com/example-org/app.git")
        return {"temp_dir": str(temp_dir), "destination": str(dest)}

    def invoke_direct_attach():
        current = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
        current["projects"]["app"]["path"] = str(elsewhere)
        current["projects"]["app"].pop("path_unresolved", None)
        _write_registry(tmp_data_home, current)

    monkeypatch.setattr(recovery, "stage_clone", fake_stage_clone)
    code, reply = invoke(
        monkeypatch, capsys, "recovery", "clone", "--project", "app", "--destination", str(destination), "--json"
    )
    assert code == 0
    assert reply["ok"] is False
    assert reply["error"]["code"] == "project_changed"
    assert not destination.exists()
    saved = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())["projects"]["app"]
    assert saved["path"] == str(elsewhere)  # the concurrent attach was preserved, not overwritten


# ─────────────────────────────────────────────────────────────────────────────
# Item 5 — single explicit source retry always runs; --all skips ready too
# ─────────────────────────────────────────────────────────────────────────────


def test_single_id_restore_source_retries_despite_a_prior_explicit_skip(tmp_data_home, monkeypatch, capsys):
    registry = _base_registry()
    registry["sources"] = {"src1": {"type": "git", "url": "https://example.invalid/src1.git"}}
    _write_registry(tmp_data_home, registry)
    invoke(monkeypatch, capsys, "recovery", "skip-source", "src1", "--json")

    from skill_hub.application.backup import restore as _restore

    calls = []
    monkeypatch.setattr(
        _restore, "restore_source",
        lambda registry, sid, **kw: (calls.append(sid), {"ok": True, "source": sid, "cloned": True, "cache": "x"})[1],
    )
    code, reply = invoke(monkeypatch, capsys, "recovery", "restore-source", "src1", "--json")
    assert code == 0 and reply["ok"] is True
    assert calls == ["src1"]  # the explicit retry actually ran, not filtered out

    _, status = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    row = next(r for r in status["sources"] if r["id"] == "src1")
    assert row["status"] != "skipped"


def test_restore_source_all_skips_already_healthy_sources_with_no_side_effects(tmp_data_home, monkeypatch, capsys):
    healthy_cache = tmp_data_home / "healthy"
    _repo(healthy_cache)
    registry = _base_registry()
    registry["sources"] = {
        "healthy-src": {"type": "git", "url": "https://example.invalid/h.git", "cache": str(healthy_cache)},
        "broken-src": {"type": "git", "url": "https://example.invalid/b.git"},
    }
    _write_registry(tmp_data_home, registry)

    from skill_hub.application.backup import restore as _restore

    def fake_restore_source(registry, source_id, **kwargs):
        if source_id == "healthy-src":
            pytest.fail("must not re-clone/checkout an already-healthy source in --all")
        return {"ok": True, "source": source_id, "cloned": True, "cache": "x"}

    monkeypatch.setattr(_restore, "restore_source", fake_restore_source)
    code, reply = invoke(monkeypatch, capsys, "recovery", "restore-source", "--all", "--json")
    assert code == 0 and reply["ok"] is True
    healthy_result = next(r for r in reply["results"] if r["source"] == "healthy-src")
    assert healthy_result["ok"] is True


# ─────────────────────────────────────────────────────────────────────────────
# Item 6 — GitHub search continuation beyond the fetch cap
# ─────────────────────────────────────────────────────────────────────────────


def test_github_repos_fetch_more_continues_past_the_cap(tmp_data_home, monkeypatch):
    monkeypatch.setattr(recovery, "resolve_binary", lambda name: "/usr/bin/gh")
    monkeypatch.setattr(recovery, "MAX_GITHUB_FETCH", 100)
    monkeypatch.setattr(recovery, "GITHUB_PAGE_SIZE", 100)

    def fake_run(args, **kwargs):
        if args[-1] == "user":
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps({"login": "octocat"}), stderr="")
        page = 1
        for part in args:
            if part.startswith("user/repos"):
                for kv in part.split("?", 1)[1].split("&"):
                    if kv.startswith("page="):
                        page = int(kv.split("=")[1])
        if page == 1:
            payload = [{"full_name": f"org/repo-{i}", "clone_url": "u"} for i in range(100)]
        elif page == 2:
            payload = [{"full_name": "org/deep-match", "clone_url": "u"}]
        else:
            payload = []
        return subprocess.CompletedProcess(args, 0, stdout=json.dumps(payload), stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    first = recovery.list_github_repositories("deep-match", page=1, per_page=30)
    assert first["ok"] is True
    assert first["repositories"] == []
    assert first["truncated"] is True  # capped at the first 100 — not "no matches anywhere"

    more = recovery.list_github_repositories("deep-match", page=1, per_page=30, fetch_more=True)
    assert more["ok"] is True
    assert [r["full_name"] for r in more["repositories"]] == ["org/deep-match"]


def test_github_repos_fetch_more_is_a_no_op_when_nothing_was_truncated(tmp_data_home, monkeypatch):
    monkeypatch.setattr(recovery, "resolve_binary", lambda name: "/usr/bin/gh")
    calls = {"n": 0}

    def fake_run(args, **kwargs):
        calls["n"] += 1
        if args[-1] == "user":
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps({"login": "octocat"}), stderr="")
        payload = [{"full_name": "org/only-repo", "clone_url": "u"}]
        return subprocess.CompletedProcess(args, 0, stdout=json.dumps(payload), stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    first = recovery.list_github_repositories("only", page=1, per_page=30)
    assert first["truncated"] is False
    calls["n"] = 0
    again = recovery.list_github_repositories("only", page=1, per_page=30, fetch_more=True)
    assert again["ok"] is True
    assert calls["n"] == 1  # only the login re-check; nothing was truncated, so no refetch


def test_empty_skill_directory_is_not_recovered_content(tmp_path):
    folder = tmp_path / "empty-skill"
    folder.mkdir()
    cfg = {"type": "claude-skill", "source": str(folder)}
    assert not recovery._skill_source_exists(cfg)
    assert recovery.local_source_candidates({"skills": {"empty-skill": cfg}})
    (folder / "SKILL.md").write_text("# Skill\n")
    assert recovery._skill_source_exists(cfg)
    assert not recovery.local_source_candidates({"skills": {"empty-skill": cfg}})


@pytest.mark.parametrize("association", [
    "https://github.com/org/repo.git", {"url": "https://github.com/org/repo.git", "remote": "origin"},
])
def test_attach_malformed_association_is_a_persisted_json_failure(tmp_data_home, monkeypatch, capsys, association):
    checkout = tmp_data_home / "checkout"
    checkout.mkdir()
    _write_registry(tmp_data_home, _base_registry(app={
        "path": "/historical", "path_unresolved": True, "repository": association,
    }))
    code, result = invoke(
        monkeypatch, capsys, "recovery", "attach", "--project", "app", "--path", str(checkout), "--json",
    )
    assert code == 0
    assert result["ok"] is False
    assert result["error"]["code"] == "invalid_association"
    _, status = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    assert status["projects"][0]["status"] == "failed"
    assert status["projects"][0]["detail"]


def test_clone_unwritable_parent_is_a_persisted_json_failure(tmp_data_home, monkeypatch, capsys):
    _write_registry(tmp_data_home, _base_registry(app={
        "path": "/historical", "path_unresolved": True,
        "repository": {"url": "https://github.com/org/repo.git", "remote": "origin", "subdirectory": "."},
    }))
    def denied(**kwargs):
        raise PermissionError("fixture destination is not writable")
    monkeypatch.setattr(recovery.tempfile, "mkdtemp", denied)
    code, result = invoke(
        monkeypatch, capsys, "recovery", "clone", "--project", "app",
        "--destination", str(tmp_data_home / "checkout"), "--json",
    )
    assert code == 0
    assert result["error"]["code"] == "invalid_destination"
    _, status = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    assert status["projects"][0]["status"] == "failed"
    assert "not writable" in status["projects"][0]["detail"]
    assert not (tmp_data_home / "checkout").exists()


def test_local_source_progress_is_usable_and_survives_success(tmp_path):
    folder = tmp_path / "local"
    folder.mkdir()
    registry = {"skills": {"local": {"type": "claude-skill", "managed": "local", "source": str(folder)}}}
    record = recovery.empty_record()
    assert recovery.local_source_rows(registry, record)[0]["status"] == "pending"
    (folder / "SKILL.md").write_text("# Local skill\n")
    recovery.set_local_source_job(record, "local", "ready", detail="source attached")
    rows = recovery.local_source_rows(registry, record)
    assert rows[0]["status"] == "ready"
    assert rows[0]["detail"] == "source attached"


@pytest.mark.parametrize("superseded_by", ["skip", "restore"])
def test_clone_preserves_a_concurrent_decision(tmp_data_home, monkeypatch, capsys, superseded_by):
    _write_registry(tmp_data_home, _base_registry(app={
        "path": "/historical", "path_unresolved": True,
        "repository": {"url": "https://github.com/org/repo.git", "remote": "origin", "subdirectory": "."},
    }))
    destination = tmp_data_home / "checkout"
    staging = tmp_data_home / ".owned-clone"

    def clone_then_skip(url, dest, **kwargs):
        _repo(staging, remote=url)
        if superseded_by == "skip":
            record = recovery.read_record()
            recovery.set_project_job(record, "app", "skipped", detail="user skipped during clone")
            recovery.write_record(record)
        else:
            registry = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
            registry["bootstrap"] = {"restored_from": "new-snapshot", "restored_at": "2030-01-01T00:00:00Z"}
            _write_registry(tmp_data_home, registry)
        return {"temp_dir": str(staging), "destination": str(dest)}

    monkeypatch.setattr(recovery, "stage_clone", clone_then_skip)
    code, result = invoke(
        monkeypatch, capsys, "recovery", "clone", "--project", "app",
        "--destination", str(destination), "--json",
    )
    assert code == 0
    assert result["ok"] is False
    assert result["error"]["code"] == "project_changed"
    assert not destination.exists()
    assert not staging.exists()
    _, status = invoke(monkeypatch, capsys, "recovery", "status", "--json")
    assert status["projects"][0]["status"] == ("skipped" if superseded_by == "skip" else "pending")
    assert yaml.safe_load((tmp_data_home / "registry.yaml").read_text())["projects"]["app"]["path_unresolved"]
