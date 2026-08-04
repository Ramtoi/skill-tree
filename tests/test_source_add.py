"""Tests for §2: `hub source add git` — URL parsing, candidate discovery,
candidate classification, and the CLI command (dry-run and apply modes).

All Git interactions use temporary local repositories accessed via ``file://``
URLs — no network, no real credentials.
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


# ─── shared helpers ─────────────────────────────────────────────────────────


pytestmark = pytest.mark.skipif(
    shutil.which("git") is None, reason="git not on PATH"
)


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
    """Create a local Git repository populated with ``layout``.

    ``layout`` maps repo-relative paths to file contents.
    """
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


def _skill_md(name: str, description: str = "tested external skill") -> str:
    return f"---\nname: {name}\ndescription: {description}\nversion: 1.0.0\n---\n# {name}\n"


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


# ─── parse_git_url ──────────────────────────────────────────────────────────


def test_parse_git_url_ssh_form():
    out = hub.parse_git_url("git@github.com:foo/bar.git")
    assert out == {"clone_url": "git@github.com:foo/bar.git", "branch": None, "path": None}


def test_parse_git_url_https_plain():
    out = hub.parse_git_url("https://github.com/foo/bar.git")
    assert out["clone_url"] == "https://github.com/foo/bar.git"
    assert out["branch"] is None
    assert out["path"] is None


def test_parse_git_url_github_tree_with_path():
    out = hub.parse_git_url("https://github.com/foo/bar/tree/dev/skills/sub")
    assert out["clone_url"] == "https://github.com/foo/bar.git"
    assert out["branch"] == "dev"
    assert out["path"] == "skills/sub"


def test_parse_git_url_github_tree_branch_only():
    out = hub.parse_git_url("https://github.com/foo/bar/tree/dev")
    assert out["clone_url"] == "https://github.com/foo/bar.git"
    assert out["branch"] == "dev"
    assert out["path"] is None


def test_parse_git_url_rejects_empty():
    with pytest.raises(ValueError):
        hub.parse_git_url("")


# ─── derive_source_id_from_url ──────────────────────────────────────────────


def test_derive_source_id_https():
    assert hub.derive_source_id_from_url("https://github.com/org/skill-pack.git") == "skill-pack"


def test_derive_source_id_ssh():
    assert hub.derive_source_id_from_url("git@github.com:org/my-skills.git") == "my-skills"


def test_derive_source_id_lowercases():
    assert hub.derive_source_id_from_url("https://github.com/org/MixedCase.git") == "mixedcase"


# ─── discover_candidates ────────────────────────────────────────────────────


def test_discover_candidates_root_single(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "SKILL.md").write_text(_skill_md("solo"))
    out = hub.discover_candidates(repo, "")
    names = [c["name"] for c in out]
    assert names == ["solo"]
    assert out[0]["origin_path"] == ""


def test_discover_candidates_skills_folder(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "skills" / "foo").mkdir(parents=True)
    (repo / "skills" / "foo" / "SKILL.md").write_text(_skill_md("foo"))
    (repo / "skills" / "bar").mkdir()
    (repo / "skills" / "bar" / "SKILL.md").write_text(_skill_md("bar"))
    out = hub.discover_candidates(repo, "")
    names = sorted(c["name"] for c in out)
    assert names == ["bar", "foo"]


def test_discover_candidates_mcp_servers_folder(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "mcp-servers" / "reviewer").mkdir(parents=True)
    (repo / "mcp-servers" / "reviewer" / "SKILL.md").write_text(_skill_md("reviewer"))
    out = hub.discover_candidates(repo, "")
    names = [c["name"] for c in out]
    assert names == ["reviewer"]


def test_discover_candidates_immediate_children(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "a").mkdir()
    (repo / "a" / "SKILL.md").write_text(_skill_md("a"))
    (repo / "b").mkdir()
    (repo / "b" / "SKILL.md").write_text(_skill_md("b"))
    out = hub.discover_candidates(repo, "")
    names = sorted(c["name"] for c in out)
    assert names == ["a", "b"]


def test_discover_candidates_subdir(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "packs" / "android" / "foo").mkdir(parents=True)
    (repo / "packs" / "android" / "foo" / "SKILL.md").write_text(_skill_md("foo"))
    out = hub.discover_candidates(repo, "packs/android")
    assert [c["name"] for c in out] == ["foo"]
    assert out[0]["origin_path"] == str(Path("packs/android/foo"))


def test_discover_candidates_category_nested(tmp_path):
    """Category-grouped repos (skills/<category>/<skill>/) are discovered."""
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "skills" / "engineering" / "diagnose").mkdir(parents=True)
    (repo / "skills" / "engineering" / "diagnose" / "SKILL.md").write_text(
        _skill_md("diagnose")
    )
    (repo / "skills" / "productivity" / "handoff").mkdir(parents=True)
    (repo / "skills" / "productivity" / "handoff" / "SKILL.md").write_text(
        _skill_md("handoff")
    )
    out = hub.discover_candidates(repo, "")
    by_name = {c["name"]: c for c in out}
    assert sorted(by_name) == ["diagnose", "handoff"]
    assert by_name["diagnose"]["origin_path"] == str(
        Path("skills/engineering/diagnose")
    )
    assert by_name["handoff"]["origin_path"] == str(
        Path("skills/productivity/handoff")
    )


def test_discover_candidates_stops_at_skill(tmp_path):
    """A SKILL.md inside an already-matched skill dir is not a second candidate."""
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "outer" / "inner").mkdir(parents=True)
    (repo / "outer" / "SKILL.md").write_text(_skill_md("outer"))
    (repo / "outer" / "inner" / "SKILL.md").write_text(_skill_md("inner"))
    out = hub.discover_candidates(repo, "")
    assert [c["name"] for c in out] == ["outer"]


def test_discover_candidates_depth_cap(tmp_path):
    """A SKILL.md deeper than MAX_SCAN_DEPTH levels below base is not found."""
    repo = tmp_path / "repo"
    repo.mkdir()
    deep = repo
    for i in range(hub.MAX_SCAN_DEPTH + 1):
        deep = deep / f"d{i}"
    deep.mkdir(parents=True)
    (deep / "SKILL.md").write_text(_skill_md("toodeep"))
    out = hub.discover_candidates(repo, "")
    assert out == []


def test_discover_candidates_traversal_rejected(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    out = hub.discover_candidates(repo, "../escape")
    assert out == []


def test_discover_candidates_symlink_escape_ignored(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "SKILL.md").write_text(_skill_md("evil"))
    (repo / "leak").symlink_to(outside)
    out = hub.discover_candidates(repo, "")
    assert all(c["name"] != "evil" for c in out)


def test_discover_candidates_invalid_skill_skipped(tmp_path):
    """A directory whose SKILL.md has no name should not appear."""
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "skills" / "x").mkdir(parents=True)
    (repo / "skills" / "x" / "SKILL.md").write_text("---\ndescription: nameless\n---\n")
    out = hub.discover_candidates(repo, "")
    assert out == []


# ─── classify_candidates ────────────────────────────────────────────────────


def test_classify_new(tmp_path):
    cands = [{"name": "foo", "version": "1.0.0", "description": "x", "origin_path": "skills/foo"}]
    out = hub.classify_candidates(cands, {"skills": {}}, "org")
    assert out[0]["category"] == "NEW"


def test_classify_imported_for_same_source(tmp_path):
    cands = [{"name": "foo", "version": "1.0.0", "description": "x", "origin_path": "skills/foo"}]
    registry = {
        "skills": {
            "foo": {
                "source": "/cache/org/foo",
                "managed": "external",
                "origin": {"source": "org", "path": "skills/foo"},
            }
        }
    }
    out = hub.classify_candidates(cands, registry, "org")
    assert out[0]["category"] == "IMPORTED"


def test_classify_conflict_with_local(tmp_path):
    cands = [{"name": "foo", "version": "1.0.0", "description": "x", "origin_path": "skills/foo"}]
    registry = {"skills": {"foo": {"source": "/some/local/foo", "managed": "local"}}}
    out = hub.classify_candidates(cands, registry, "org")
    assert out[0]["category"] == "CONFLICT"
    assert out[0]["existing_managed"] == "local"


def test_classify_invalid_slug(tmp_path):
    cands = [{"name": "Bad Name", "version": "1.0.0", "description": "x", "origin_path": "x"}]
    out = hub.classify_candidates(cands, {"skills": {}}, "org")
    assert out[0]["category"] == "INVALID"


# ─── CLI: hub source add git ─ dry-run ─────────────────────────────────────


def test_cli_source_add_dry_run_lists_candidates(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(
        tmp_path / "remote",
        {
            "skills/foo/SKILL.md": _skill_md("foo"),
            "skills/bar/SKILL.md": _skill_md("bar"),
        },
    )
    url = f"file://{repo}"
    result = _run_hub_cli(
        tmp_data_home,
        code_root,
        ["source", "add", "git", url, "--id", "org-skills", "--dry-run", "--json"],
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["ok"]
    assert payload["preview"] is True
    assert payload["counts"]["new"] == 2
    names = sorted(c["name"] for c in payload["candidates"])
    assert names == ["bar", "foo"]
    # Registry should NOT have been mutated.
    import yaml
    with open(tmp_data_home / "registry.yaml") as f:
        reg = yaml.safe_load(f) or {}
    assert "sources" not in reg or reg["sources"] == {}


# ─── CLI: hub source add git ─ apply ───────────────────────────────────────


def test_cli_source_add_applies_and_registers(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(
        tmp_path / "remote",
        {
            "skills/foo/SKILL.md": _skill_md("foo"),
            "skills/bar/SKILL.md": _skill_md("bar"),
        },
    )
    url = f"file://{repo}"
    result = _run_hub_cli(
        tmp_data_home,
        code_root,
        ["source", "add", "git", url, "--id", "org-skills", "--name", "Org Skills", "--json"],
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["ok"]
    assert payload["preview"] is False
    assert sorted(payload["registered"]) == ["bar", "foo"]

    import yaml
    with open(tmp_data_home / "registry.yaml") as f:
        reg = yaml.safe_load(f) or {}
    assert reg["sources"]["org-skills"]["name"] == "Org Skills"
    assert reg["sources"]["org-skills"]["url"] == url
    assert reg["skills"]["foo"]["managed"] == "external"
    assert reg["skills"]["foo"]["origin"]["source"] == "org-skills"
    assert reg["skills"]["foo"]["origin"]["path"].endswith("skills/foo")
    # Source skill files now exist in the per-source cache.
    assert (tmp_data_home / "sources" / "org-skills" / "worktree" / "skills" / "foo" / "SKILL.md").exists()


def test_cli_source_add_with_subdir(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(
        tmp_path / "remote",
        {
            "packs/android/foo/SKILL.md": _skill_md("foo"),
            # An out-of-subdir skill that should NOT be discovered.
            "other/bar/SKILL.md": _skill_md("bar"),
        },
    )
    url = f"file://{repo}"
    result = _run_hub_cli(
        tmp_data_home,
        code_root,
        ["source", "add", "git", url, "--id", "org-skills", "--path", "packs/android", "--json"],
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["registered"] == ["foo"]


def test_cli_source_add_dry_run_rejects_duplicate_id(tmp_data_home, monkeypatch, tmp_path):
    """Adding a source whose id is already taken fails on the --dry-run path too.

    Re-adding an existing source is not the re-import path (that is `source
    sync`); `source add` must reject a taken id. The collision check runs ahead
    of the clone so the dry-run Preview fails honestly instead of passing and
    then failing at Apply (regression guard for the source-id collision fix).
    """
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(
        tmp_data_home,
        {
            "version": "1",
            "skills": {
                "foo": {
                    "source": "/cache/foo",
                    "managed": "external",
                    "origin": {"source": "org-skills", "path": "skills/foo"},
                }
            },
            "sources": {
                "org-skills": {
                    "type": "git",
                    "name": "Org Skills",
                    "url": "file:///placeholder",
                }
            },
        },
    )
    repo = _make_local_repo(
        tmp_path / "remote",
        {"skills/foo/SKILL.md": _skill_md("foo")},
    )
    url = f"file://{repo}"
    result = _run_hub_cli(
        tmp_data_home,
        code_root,
        ["source", "add", "git", url, "--id", "org-skills", "--dry-run", "--json"],
    )
    assert result.returncode == 1, result.stdout
    payload = json.loads(result.stdout)
    assert payload["ok"] is False
    assert "already exists" in payload["error"]


def test_cli_source_add_conflict_with_local(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    skill_dir = hub.hub_skills_dir() / "grill"
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(_skill_md("grill"))
    _seed_registry(
        tmp_data_home,
        {
            "version": "1",
            "skills": {
                "grill": {
                    "source": str(skill_dir),
                    "type": "claude-skill",
                    "scope": "portable",
                    "managed": "local",
                }
            },
        },
    )
    repo = _make_local_repo(
        tmp_path / "remote",
        {"skills/grill/SKILL.md": _skill_md("grill")},
    )
    url = f"file://{repo}"
    result = _run_hub_cli(
        tmp_data_home,
        code_root,
        ["source", "add", "git", url, "--id", "org-skills", "--json"],
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    # CONFLICT candidates are skipped on apply (no conflict resolution flag yet).
    assert payload["counts"]["conflicts"] == 1
    assert payload["registered"] == []
    assert any(s["reason"] == "CONFLICT" for s in payload["skipped"])
    # Existing local entry is preserved.
    import yaml
    with open(tmp_data_home / "registry.yaml") as f:
        reg = yaml.safe_load(f) or {}
    assert reg["skills"]["grill"]["managed"] == "local"


def test_cli_source_add_invalid_skill_skipped(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    repo = _make_local_repo(
        tmp_path / "remote",
        {
            "skills/Bad Name/SKILL.md": "---\nname: Bad Name\ndescription: x\n---\n",
            "skills/good/SKILL.md": _skill_md("good"),
        },
    )
    url = f"file://{repo}"
    result = _run_hub_cli(
        tmp_data_home,
        code_root,
        ["source", "add", "git", url, "--id", "org-skills", "--json"],
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    # Bad-Name is filtered at discovery (slug doesn't match) — it does not even
    # show up as INVALID since we never construct a candidate for it. The
    # `good` skill registers normally.
    assert payload["registered"] == ["good"]


def test_cli_source_add_duplicate_id_rejected(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(
        tmp_data_home,
        {
            "version": "1",
            "skills": {},
            "sources": {"org-skills": {"type": "git", "name": "Org", "url": "x"}},
        },
    )
    result = _run_hub_cli(
        tmp_data_home,
        code_root,
        ["source", "add", "git", "git@x:y.git", "--id", "org-skills", "--json"],
    )
    assert result.returncode == 1
    payload = json.loads(result.stdout)
    assert payload["ok"] is False
    assert "already exists" in payload["error"]


def test_cli_source_add_reserved_id_rejected(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    result = _run_hub_cli(
        tmp_data_home,
        code_root,
        ["source", "add", "git", "git@x:y.git", "--id", "local", "--json"],
    )
    assert result.returncode != 0
    # `validate_source_id` uses `fail()` which prints to stdout, not JSON, so
    # check that the run errored.


def test_cli_source_add_traversal_path_rejected(tmp_data_home, monkeypatch, tmp_path):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    result = _run_hub_cli(
        tmp_data_home,
        code_root,
        ["source", "add", "git", "git@x:y.git", "--id", "org", "--path", "../etc", "--json"],
    )
    assert result.returncode == 1
    payload = json.loads(result.stdout)
    assert payload["ok"] is False
    assert "resolves outside" in payload["error"] or "traversal" in payload["error"].lower()


def test_cli_source_add_clone_failure_reports_error(tmp_data_home, monkeypatch, tmp_path):
    """Cloning a path that does not exist must surface a friendly error without
    persisting anything in the registry."""
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home)
    nonexistent_url = f"file://{tmp_path}/does-not-exist"
    result = _run_hub_cli(
        tmp_data_home,
        code_root,
        ["source", "add", "git", nonexistent_url, "--id", "ghost", "--json"],
    )
    assert result.returncode == 1
    payload = json.loads(result.stdout)
    assert payload["ok"] is False
    import yaml
    with open(tmp_data_home / "registry.yaml") as f:
        reg = yaml.safe_load(f) or {}
    assert "ghost" not in (reg.get("sources") or {})
