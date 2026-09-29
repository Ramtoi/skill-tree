"""Optional repository association crosses the real parser without syncing."""

import json
import subprocess
import sys

import pytest
import yaml


def invoke(monkeypatch, capsys, *args):
    import hub

    monkeypatch.setattr(sys, "argv", ["hub", *args])
    code = 0
    try:
        hub.main()
    except SystemExit as exc:
        code = exc.code
    output = capsys.readouterr()
    assert output.out, f"Expected JSON command result, exit={code}: {output.err}"
    return code, json.loads(output.out)


@pytest.fixture
def project(tmp_data_home, monkeypatch):
    import hub

    path = tmp_data_home / "project"
    path.mkdir()
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(["git", "-C", str(path), "remote", "add", "origin",
                    "git@github.com:example-org/example-app.git"], check=True)
    cfg = {"path": str(path), "enabled": [], "bundles": [],
           "permissions": {"worktree_access": {"enabled": False, "path": "~/worktrees/app"}}}
    registry = {"version": "1", "skills": {}, "bundles": {}, "projects": {"app": cfg}}
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry))
    monkeypatch.setattr(hub, "_auto_sync", lambda: pytest.fail("repository metadata must not sync"))
    return path, cfg


def test_path_only_show_does_not_probe_git(tmp_data_home, project, monkeypatch, capsys):
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: pytest.fail("show must not probe Git"))
    code, reply = invoke(monkeypatch, capsys, "project", "repository", "show", "app", "--json")
    assert code == 0
    assert reply["ok"] is True
    assert reply["repository"] is None


def test_set_clear_roundtrip_preserves_project(tmp_data_home, project, monkeypatch, capsys):
    _, cfg = project
    code, reply = invoke(monkeypatch, capsys, "project", "repository", "set", "app", "--json")
    assert code == 0 and reply["ok"]
    assert reply["repository"] == {"url": "git@github.com:example-org/example-app.git",
                                   "remote": "origin", "subdirectory": "."}
    saved = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())["projects"]["app"]
    assert saved == {**cfg, "repository": reply["repository"]}
    code, reply = invoke(monkeypatch, capsys, "project", "repository", "clear", "app", "--json")
    assert code == 0 and reply["repository"] is None
    saved = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())["projects"]["app"]
    assert saved == cfg


def test_inspection_failure_is_readable_without_mutation(tmp_data_home, project, monkeypatch, capsys):
    before = (tmp_data_home / "registry.yaml").read_bytes()
    code, reply = invoke(monkeypatch, capsys, "project", "repository", "inspect", "app",
                         "--remote", "missing", "--json")
    assert code == 0 and not reply["ok"]
    assert reply["error"]["code"] == "remote_not_found"
    assert (tmp_data_home / "registry.yaml").read_bytes() == before


def test_failed_set_has_nonzero_mutation_result(tmp_data_home, project, monkeypatch, capsys):
    before = (tmp_data_home / "registry.yaml").read_bytes()
    code, reply = invoke(monkeypatch, capsys, "project", "repository", "set", "app",
                         "--remote", "missing", "--json")
    assert code == 1 and not reply["ok"]
    assert (tmp_data_home / "registry.yaml").read_bytes() == before
