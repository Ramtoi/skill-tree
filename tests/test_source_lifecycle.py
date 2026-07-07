"""Tests for §3: ``hub source check`` / ``sync`` / ``remove``.

These tests build on §2's local-git-repo helpers and exercise the full
source lifecycle hermetically: no network, no real credentials.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

import hub


pytestmark = pytest.mark.skipif(
    shutil.which("git") is None, reason="git not on PATH"
)


# ─── shared helpers (mirror test_source_add.py) ────────────────────────────


def _git(*args: str, cwd: Path) -> None:
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_AUTHOR_NAME"] = "test"
    env["GIT_AUTHOR_EMAIL"] = "test@local"
    env["GIT_COMMITTER_NAME"] = "test"
    env["GIT_COMMITTER_EMAIL"] = "test@local"
    res = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
    )
    if res.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {res.stderr}")


def _make_local_repo(repo_dir: Path, layout: dict[str, str], branch: str = "main") -> Path:
    repo_dir.mkdir(parents=True, exist_ok=True)
    _git("init", "-q", "-b", branch, ".", cwd=repo_dir)
    _git("config", "user.email", "test@local", cwd=repo_dir)
    _git("config", "user.name", "test", cwd=repo_dir)
    for rel, content in layout.items():
        target = repo_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    _git("add", ".", cwd=repo_dir)
    _git("commit", "-q", "-m", "init", cwd=repo_dir)
    return repo_dir


def _commit_changes(repo_dir: Path, changes: dict[str, str | None], message: str = "update") -> None:
    """Apply file changes (None = delete) and commit."""
    for rel, content in changes.items():
        target = repo_dir / rel
        if content is None:
            if target.exists():
                target.unlink()
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
    _git("add", "-A", cwd=repo_dir)
    _git("commit", "-q", "-m", message, cwd=repo_dir)


def _skill_md(name: str, description: str = "tested external skill", version: str = "1.0.0") -> str:
    return f"---\nname: {name}\ndescription: {description}\nversion: {version}\n---\n# {name}\n"


def _seed_registry(tmp_data_home: Path, registry: dict | None = None) -> Path:
    import yaml

    reg = registry or {"version": "1", "skills": {}}
    reg_path = tmp_data_home / "registry.yaml"
    reg_path.write_text(yaml.safe_dump(reg, sort_keys=False))
    return reg_path


def _seed_code_home(tmp_data_home: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    code_root = tmp_data_home.parent / f"{tmp_data_home.name}-code"
    code_root.mkdir(exist_ok=True)
    (code_root / "hub.py").write_text("# placeholder\n")
    (code_root / "skills").mkdir(exist_ok=True)
    monkeypatch.setenv("SKILL_HUB_CODE", str(code_root))
    return code_root


def _run_hub_cli(tmp_data_home: Path, code_root: Path, args: list[str]) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["SKILL_HUB_HOME"] = str(tmp_data_home)
    env["SKILL_HUB_CODE"] = str(code_root)
    env.pop("SKILL_HUB_DIR", None)
    env["GIT_TERMINAL_PROMPT"] = "0"
    repo_root = Path(__file__).resolve().parent.parent
    return subprocess.run(
        [sys.executable, str(repo_root / "hub.py"), *args],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(repo_root),
    )


def _add_git_source(tmp_data_home: Path, code_root: Path, repo: Path, source_id: str = "org-skills") -> dict:
    url = f"file://{repo}"
    result = _run_hub_cli(
        tmp_data_home, code_root,
        ["source", "add", "git", url, "--id", source_id, "--json"],
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _load_registry(tmp_data_home: Path) -> dict:
    import yaml
    with open(tmp_data_home / "registry.yaml") as f:
        return yaml.safe_load(f) or {}


# ─── hub source check ──────────────────────────────────────────────────────


def test_source_check_up_to_date(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(tmp_path / "remote", {"skills/foo/SKILL.md": _skill_md("foo")})
    _add_git_source(tmp_data_home, code_root, repo)

    result = _run_hub_cli(tmp_data_home, code_root, ["source", "check", "org-skills", "--json"])
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["ok"] is True
    assert payload["status"] == "up-to-date"
    assert payload["current_ref"] == payload["remote_ref"]


def test_source_check_detects_update_available(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(tmp_path / "remote", {"skills/foo/SKILL.md": _skill_md("foo")})
    _add_git_source(tmp_data_home, code_root, repo)
    _commit_changes(repo, {"skills/bar/SKILL.md": _skill_md("bar")}, "add bar")

    result = _run_hub_cli(tmp_data_home, code_root, ["source", "check", "org-skills", "--json"])
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "update-available"
    assert payload["current_ref"] != payload["remote_ref"]


def test_source_check_unknown_source_errors(tmp_data_home, monkeypatch):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    result = _run_hub_cli(tmp_data_home, code_root, ["source", "check", "does-not-exist", "--json"])
    assert result.returncode == 1


# ─── hub source sync ───────────────────────────────────────────────────────


def test_source_sync_adds_new_upstream_skills(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(tmp_path / "remote", {"skills/foo/SKILL.md": _skill_md("foo")})
    _add_git_source(tmp_data_home, code_root, repo)
    _commit_changes(repo, {"skills/bar/SKILL.md": _skill_md("bar")}, "add bar")

    result = _run_hub_cli(tmp_data_home, code_root, ["source", "sync", "org-skills", "--json"])
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert "bar" in payload["added"]
    assert payload["removed_upstream"] == []
    # bar is reported as new_pending but not auto-registered.
    reg = _load_registry(tmp_data_home)
    assert "bar" not in reg["skills"]


def test_source_sync_updates_changed_skill_metadata(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(
        tmp_path / "remote",
        {"skills/foo/SKILL.md": _skill_md("foo", description="old desc")},
    )
    _add_git_source(tmp_data_home, code_root, repo)
    _commit_changes(
        repo,
        {"skills/foo/SKILL.md": _skill_md("foo", description="new desc", version="1.1.0")},
        "bump foo",
    )

    result = _run_hub_cli(tmp_data_home, code_root, ["source", "sync", "org-skills", "--json"])
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert "foo" in payload["changed"]
    reg = _load_registry(tmp_data_home)
    assert reg["skills"]["foo"]["description"] == "new desc"
    assert reg["skills"]["foo"]["version"] == "1.1.0"


def test_source_sync_marks_removed_upstream_without_deleting(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(
        tmp_path / "remote",
        {
            "skills/foo/SKILL.md": _skill_md("foo"),
            "skills/bar/SKILL.md": _skill_md("bar"),
        },
    )
    _add_git_source(tmp_data_home, code_root, repo)
    _commit_changes(repo, {"skills/bar/SKILL.md": None}, "drop bar")

    result = _run_hub_cli(tmp_data_home, code_root, ["source", "sync", "org-skills", "--json"])
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert "bar" in payload["removed_upstream"]
    reg = _load_registry(tmp_data_home)
    # bar entry still exists; just flagged source_missing.
    assert "bar" in reg["skills"]
    assert reg["skills"]["bar"].get("source_missing") is True
    # foo did not regress.
    assert reg["skills"]["foo"].get("source_missing") is not True


# ─── hub source remove ─────────────────────────────────────────────────────


def test_source_remove_dry_run_reports_impact(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(
        tmp_path / "remote",
        {
            "skills/foo/SKILL.md": _skill_md("foo"),
            "skills/bar/SKILL.md": _skill_md("bar"),
        },
    )
    _add_git_source(tmp_data_home, code_root, repo)
    # Inject a bundle and a project that reference the imported skills.
    reg = _load_registry(tmp_data_home)
    reg["bundles"] = {"android": {"skills": ["foo", "bar"]}}
    reg["projects"] = {
        "demo": {
            "path": "/tmp/demo",
            "bundles": ["android"],
            "enabled": ["foo"],
            "harnesses": ["pi"],
        }
    }
    import yaml
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    result = _run_hub_cli(
        tmp_data_home, code_root,
        ["source", "remove", "org-skills", "--dry-run", "--json"],
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    impact = payload["impact"]
    assert sorted(impact["owned_skills"]) == ["bar", "foo"]
    assert impact["affected_bundles"][0]["name"] == "android"
    assert impact["affected_projects"][0]["name"] == "demo"
    # No mutation happened.
    reg2 = _load_registry(tmp_data_home)
    assert "org-skills" in reg2["sources"]
    assert "foo" in reg2["skills"]


def test_source_remove_unequip_scrubs_everywhere(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(
        tmp_path / "remote",
        {
            "skills/foo/SKILL.md": _skill_md("foo"),
            "skills/bar/SKILL.md": _skill_md("bar"),
        },
    )
    _add_git_source(tmp_data_home, code_root, repo)
    reg = _load_registry(tmp_data_home)
    reg["bundles"] = {"android": {"skills": ["foo", "bar", "keep-me"]}}
    reg["projects"] = {
        "demo": {
            "path": "/tmp/demo",
            "bundles": ["android"],
            "enabled": ["foo", "other"],
            "harnesses": ["pi"],
        }
    }
    import yaml
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))
    cache_root = tmp_data_home / "sources" / "org-skills"
    assert cache_root.exists()

    result = _run_hub_cli(
        tmp_data_home, code_root,
        ["source", "remove", "org-skills", "--mode", "unequip", "--json"],
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["mode"] == "unequip"

    reg2 = _load_registry(tmp_data_home)
    assert "org-skills" not in (reg2.get("sources") or {})
    assert "foo" not in reg2["skills"]
    assert "bar" not in reg2["skills"]
    assert reg2["bundles"]["android"]["skills"] == ["keep-me"]
    assert reg2["projects"]["demo"]["enabled"] == ["other"]
    # Cache cleanup happened only AFTER registry mutation succeeded.
    assert not cache_root.exists()


def test_source_remove_keep_local_preserves_loadouts(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(
        tmp_path / "remote",
        {
            "skills/foo/SKILL.md": _skill_md("foo"),
            "skills/foo/extra.md": "supporting file",
        },
    )
    _add_git_source(tmp_data_home, code_root, repo)
    reg = _load_registry(tmp_data_home)
    reg["bundles"] = {"android": {"skills": ["foo"]}}
    reg["projects"] = {
        "demo": {
            "path": "/tmp/demo",
            "bundles": ["android"],
            "enabled": [],
            "harnesses": ["pi"],
        }
    }
    import yaml
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    result = _run_hub_cli(
        tmp_data_home, code_root,
        ["source", "remove", "org-skills", "--mode", "keep-local", "--json"],
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["mode"] == "keep-local"

    reg2 = _load_registry(tmp_data_home)
    assert "org-skills" not in (reg2.get("sources") or {})
    # foo remains, now local, repointed to data-home/skills/foo.
    assert reg2["skills"]["foo"]["managed"] == "local"
    assert "origin" not in reg2["skills"]["foo"]
    expected_src = tmp_data_home / "skills" / "foo"
    assert Path(reg2["skills"]["foo"]["source"]) == expected_src
    assert expected_src.exists()
    assert (expected_src / "SKILL.md").exists()
    assert (expected_src / "extra.md").exists()
    # Bundle and project loadouts preserved.
    assert reg2["bundles"]["android"]["skills"] == ["foo"]
    # Cache directory removed.
    assert not (tmp_data_home / "sources" / "org-skills").exists()


def test_source_remove_unknown_source_errors(tmp_data_home, monkeypatch):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    result = _run_hub_cli(
        tmp_data_home, code_root,
        ["source", "remove", "ghost", "--dry-run", "--json"],
    )
    assert result.returncode == 1


# ─── 3.8 Failure-mode test ─────────────────────────────────────────────────


def test_remove_with_registry_write_failure_preserves_cache(
    tmp_data_home, monkeypatch, tmp_path
):
    """Simulate ``save_registry`` raising. The cache must remain intact so the
    user can recover, and no partial mutation should be observable."""
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(tmp_path / "remote", {"skills/foo/SKILL.md": _skill_md("foo")})
    _add_git_source(tmp_data_home, code_root, repo)
    cache_before = tmp_data_home / "sources" / "org-skills"
    assert cache_before.exists()

    # Monkeypatch save_registry to fail. We need to run remove logic in-process
    # so the patch takes effect (the CLI subprocess wouldn't see it).
    monkeypatch.setattr(
        hub, "save_registry", lambda registry: (_ for _ in ()).throw(RuntimeError("disk full"))
    )

    class FakeArgs:
        id = "org-skills"
        dry_run = False
        mode = "unequip"
        json = True

    with pytest.raises(RuntimeError):
        hub.cmd_source_remove(FakeArgs())

    # Cache is still on disk; registry file is unchanged.
    assert cache_before.exists()
    reg = _load_registry(tmp_data_home)
    assert "org-skills" in (reg.get("sources") or {})
    assert "foo" in reg.get("skills", {})
