from __future__ import annotations

import hashlib
import subprocess
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import skill_hub.entrypoints.cli.agent_docs as agent_docs_cli
from skill_hub.infrastructure.filesystem import agent_docs


def git(root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(root), *args],
        check=check,
        capture_output=True,
        text=True,
    )


def make_repo(tmp_path: Path) -> tuple[Path, Path]:
    remote = tmp_path / "remote.git"
    project = tmp_path / "project"
    subprocess.run(
        ["git", "init", "--bare", "-q", "-b", "main", str(remote)],
        check=True,
    )
    subprocess.run(
        ["git", "init", "-q", "-b", "main", str(project)],
        check=True,
    )
    git(project, "config", "user.name", "Skill Tree tests")
    git(project, "config", "user.email", "tests@skill-tree.invalid")
    (project / "AGENTS.md").write_text("# Original\n", encoding="utf-8")
    (project / "notes.txt").write_text("original\n", encoding="utf-8")
    git(project, "add", "AGENTS.md", "notes.txt")
    git(project, "commit", "-q", "-m", "initial")
    git(project, "remote", "add", "origin", str(remote))
    git(project, "push", "-q", "-u", "origin", "main")
    return project, remote


def configured(project: Path) -> dict:
    return {
        "path": str(project),
        "agent_docs": {"publish_on_save": True},
    }


def remote_file(remote: Path, rel: str) -> str:
    result = subprocess.run(
        ["git", "--git-dir", str(remote), "show", f"main:{rel}"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def test_publish_on_save_defaults_off() -> None:
    assert agent_docs.publish_on_save_enabled({}) is False
    assert agent_docs.publish_info({}) == {
        "enabled": False,
        "remote": "origin",
        "branch": "main",
    }


def test_publish_on_save_cli_updates_project_setting(monkeypatch, capsys) -> None:
    registry = {"projects": {"demo": {"path": "/tmp/demo"}}}
    monkeypatch.setattr(agent_docs_cli.hub_core, "load_registry", lambda: registry)
    monkeypatch.setattr(agent_docs_cli.hub_core, "save_registry", lambda value: None)
    monkeypatch.setattr(agent_docs_cli, "data_home_lock", nullcontext)

    agent_docs_cli.cmd_agent_docs_publish_on_save(
        SimpleNamespace(project="demo", enable=True, disable=False, json=True)
    )

    assert registry["projects"]["demo"]["agent_docs"]["publish_on_save"] is True
    assert '"enabled": true' in capsys.readouterr().out

    agent_docs_cli.cmd_agent_docs_publish_on_save(
        SimpleNamespace(project="demo", enable=False, disable=True, json=True)
    )
    assert "agent_docs" not in registry["projects"]["demo"]


def test_main_checkout_publishes_only_agent_docs_and_preserves_staged_work(
    tmp_path: Path,
) -> None:
    project, remote = make_repo(tmp_path)
    (project / "AGENTS.md").write_text("# Published\n", encoding="utf-8")
    (project / "notes.txt").write_text("staged user work\n", encoding="utf-8")
    git(project, "add", "notes.txt")

    result = agent_docs.publish_saved_root_docs(
        configured(project),
        ["AGENTS.md"],
        {"AGENTS.md": content_hash("# Original\n")},
    )

    assert result["published"] is True
    assert remote_file(remote, "AGENTS.md") == "# Published\n"
    assert git(project, "diff", "--cached", "--name-only").stdout == "notes.txt\n"
    assert git(project, "show", "--format=", "--name-only", "HEAD").stdout == "AGENTS.md\n"


def test_feature_checkout_publishes_from_clean_origin_main_parent(tmp_path: Path) -> None:
    project, remote = make_repo(tmp_path)
    git(project, "checkout", "-q", "-b", "feature")
    (project / "feature.txt").write_text("branch-only\n", encoding="utf-8")
    git(project, "add", "feature.txt")
    git(project, "commit", "-q", "-m", "feature work")
    feature_head = git(project, "rev-parse", "HEAD").stdout.strip()
    (project / "AGENTS.md").write_text("# From worktree\n", encoding="utf-8")

    result = agent_docs.publish_saved_root_docs(configured(project), ["AGENTS.md"])

    assert result["published"] is True
    assert git(project, "rev-parse", "HEAD").stdout.strip() == feature_head
    assert remote_file(remote, "AGENTS.md") == "# From worktree\n"
    changed = subprocess.run(
        [
            "git",
            "--git-dir",
            str(remote),
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            "main",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert changed.stdout == "AGENTS.md\n"
    feature_on_main = subprocess.run(
        ["git", "--git-dir", str(remote), "cat-file", "-e", "main:feature.txt"],
        capture_output=True,
    )
    assert feature_on_main.returncode != 0


def test_remote_agent_doc_change_blocks_publish(tmp_path: Path) -> None:
    project, remote = make_repo(tmp_path)
    other = tmp_path / "other"
    subprocess.run(["git", "clone", "-q", str(remote), str(other)], check=True)
    git(other, "config", "user.name", "Other writer")
    git(other, "config", "user.email", "other@skill-tree.invalid")
    (other / "AGENTS.md").write_text("# Remote update\n", encoding="utf-8")
    git(other, "add", "AGENTS.md")
    git(other, "commit", "-q", "-m", "remote update")
    git(other, "push", "-q", "origin", "main")
    (project / "AGENTS.md").write_text("# Local edit\n", encoding="utf-8")

    result = agent_docs.publish_saved_root_docs(configured(project), ["AGENTS.md"])

    assert result["published"] is False
    assert result["reason"] == "remote_changed"
    assert remote_file(remote, "AGENTS.md") == "# Remote update\n"


def test_preexisting_uncommitted_agent_doc_drift_blocks_publish(tmp_path: Path) -> None:
    project, remote = make_repo(tmp_path)
    baseline = "# Local drift before editor opened\n"
    (project / "AGENTS.md").write_text("# New editor save\n", encoding="utf-8")

    result = agent_docs.publish_saved_root_docs(
        configured(project),
        ["AGENTS.md"],
        {"AGENTS.md": content_hash(baseline)},
    )

    assert result["published"] is False
    assert result["reason"] == "remote_changed"
    assert remote_file(remote, "AGENTS.md") == "# Original\n"
