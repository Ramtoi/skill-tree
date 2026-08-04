"""Tests for §1: registry source model, ownership inference, and the
read-only ``hub source list`` / ``hub source status`` commands.

These tests are hermetic: ``tmp_data_home`` isolates ``SKILL_HUB_HOME`` to a
tmp dir, and ``SKILL_HUB_CODE`` is pointed at another tmp dir whenever a test
needs to model code-home starter skills.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

import hub


def _seed_registry(tmp_data_home: Path, registry: dict) -> Path:
    reg_path = tmp_data_home / "registry.yaml"
    import yaml

    reg_path.write_text(yaml.safe_dump(registry, sort_keys=False))
    return reg_path


def _seed_code_home(tmp_data_home: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    # Place code_root as a sibling of the per-test data home so each test gets
    # a unique code-home; the shared pytest tmp dir was causing collisions.
    code_root = tmp_data_home.parent / f"{tmp_data_home.name}-code"
    code_root.mkdir(exist_ok=True)
    (code_root / "hub.py").write_text("# placeholder so _resolve_code_home_path matches\n")
    (code_root / "skills").mkdir(exist_ok=True)
    monkeypatch.setenv("SKILL_HUB_CODE", str(code_root))
    return code_root


# ─── validate_source_id ─────────────────────────────────────────────────────


def test_validate_source_id_accepts_slug(tmp_data_home):
    hub.validate_source_id("org-skills")


def test_validate_source_id_rejects_invalid(tmp_data_home):
    with pytest.raises(SystemExit):
        hub.validate_source_id("Org Skills")


def test_validate_source_id_rejects_reserved(tmp_data_home):
    with pytest.raises(SystemExit):
        hub.validate_source_id("local")
    with pytest.raises(SystemExit):
        hub.validate_source_id("starter")


# ─── normalize_subpath_within (path safety) ─────────────────────────────────


def test_normalize_subpath_within_accepts_simple_relative(tmp_path):
    base = tmp_path / "checkout"
    base.mkdir()
    resolved = hub.normalize_subpath_within(base, "skills/foo")
    assert resolved == (base / "skills" / "foo").resolve()


def test_normalize_subpath_within_accepts_empty(tmp_path):
    base = tmp_path / "checkout"
    base.mkdir()
    assert hub.normalize_subpath_within(base, "") == base.resolve()
    assert hub.normalize_subpath_within(base, ".") == base.resolve()


def test_normalize_subpath_within_rejects_absolute(tmp_path):
    base = tmp_path / "checkout"
    base.mkdir()
    with pytest.raises(ValueError):
        hub.normalize_subpath_within(base, "/etc/passwd")


def test_normalize_subpath_within_rejects_traversal(tmp_path):
    base = tmp_path / "checkout"
    base.mkdir()
    with pytest.raises(ValueError):
        hub.normalize_subpath_within(base, "../outside")


def test_normalize_subpath_within_rejects_symlink_escape(tmp_path):
    base = tmp_path / "checkout"
    base.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (base / "escape").symlink_to(outside)
    # Symlink target resolves outside base — must be rejected.
    with pytest.raises(ValueError):
        hub.normalize_subpath_within(base, "escape")


# ─── infer_skill_ownership ──────────────────────────────────────────────────


def test_ownership_data_home_path_is_local(tmp_data_home, monkeypatch):
    _seed_code_home(tmp_data_home, monkeypatch)
    skill_dir = hub.hub_skills_dir() / "grill"
    skill_dir.mkdir(parents=True)
    info = hub.infer_skill_ownership("grill", {"source": str(skill_dir)})
    assert info == {"source_id": "local", "managed": "local", "warning": None}


def test_ownership_code_home_starter_is_starter(tmp_data_home, monkeypatch):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    starter_skill = code_root / "skills" / "brainstorm"
    starter_skill.mkdir(parents=True)
    info = hub.infer_skill_ownership("brainstorm", {"source": str(starter_skill)})
    assert info["source_id"] == "starter"
    assert info["managed"] == "starter"


def test_ownership_explicit_external_uses_origin(tmp_data_home, monkeypatch):
    _seed_code_home(tmp_data_home, monkeypatch)
    cfg = {
        "source": "/anywhere",
        "managed": "external",
        "origin": {"source": "org-skills", "source_type": "git", "path": "skills/foo", "ref": "abc"},
    }
    info = hub.infer_skill_ownership("foo", cfg)
    assert info == {"source_id": "org-skills", "managed": "external", "warning": None}


def test_ownership_external_without_origin_warns(tmp_data_home, monkeypatch):
    _seed_code_home(tmp_data_home, monkeypatch)
    cfg = {"source": "/anywhere", "managed": "external"}
    info = hub.infer_skill_ownership("foo", cfg)
    assert info["source_id"] == "unknown"
    assert info["managed"] == "external"
    assert info["warning"]


def test_ownership_explicit_local_overrides_path(tmp_data_home, monkeypatch):
    _seed_code_home(tmp_data_home, monkeypatch)
    cfg = {"source": "/some/other/place", "managed": "local"}
    info = hub.infer_skill_ownership("foo", cfg)
    assert info == {"source_id": "local", "managed": "local", "warning": None}


def test_ownership_unknown_path_falls_back_to_local_with_warning(tmp_data_home, monkeypatch):
    _seed_code_home(tmp_data_home, monkeypatch)
    cfg = {"source": "/totally/unrelated"}
    info = hub.infer_skill_ownership("foo", cfg)
    assert info["source_id"] == "local"
    assert info["warning"]


# ─── validate_sources_registry ──────────────────────────────────────────────


def test_validate_sources_registry_empty_ok(tmp_data_home):
    assert hub.validate_sources_registry({}) == []
    assert hub.validate_sources_registry({"sources": {}}) == []


def test_validate_sources_registry_rejects_reserved_id(tmp_data_home):
    errs = hub.validate_sources_registry({"sources": {"local": {"type": "git", "url": "x"}}})
    assert any("reserved" in e for e in errs)


def test_validate_sources_registry_requires_url_for_git(tmp_data_home):
    errs = hub.validate_sources_registry({"sources": {"org": {"type": "git"}}})
    assert any("url" in e for e in errs)


def test_validate_sources_registry_rejects_absolute_path(tmp_data_home):
    errs = hub.validate_sources_registry(
        {"sources": {"org": {"type": "git", "url": "git@x:y.git", "path": "/etc"}}}
    )
    assert any("repo-relative" in e for e in errs)


def test_validate_sources_registry_rejects_traversal_path(tmp_data_home):
    errs = hub.validate_sources_registry(
        {"sources": {"org": {"type": "git", "url": "git@x:y.git", "path": "../etc"}}}
    )
    assert any("repo-relative" in e for e in errs)


def test_validate_sources_registry_rejects_invalid_slug(tmp_data_home):
    errs = hub.validate_sources_registry({"sources": {"Org Skills": {"type": "git", "url": "x"}}})
    assert any("invalid source id" in e for e in errs)


# ─── list_sources / get_source / imported_skills_for_source ────────────────


def test_list_sources_always_includes_builtins(tmp_data_home):
    out = hub.list_sources({})
    ids = [s["id"] for s in out]
    assert "local" in ids
    assert "starter" in ids
    assert all(s["builtin"] for s in out)


def test_list_sources_counts_skills_per_source(tmp_data_home, monkeypatch):
    _seed_code_home(tmp_data_home, monkeypatch)
    skill_dir = hub.hub_skills_dir() / "grill"
    skill_dir.mkdir(parents=True)
    registry = {
        "skills": {
            "grill": {"source": str(skill_dir), "type": "claude-skill"},
            "foo": {
                "source": "/cache/org/foo",
                "managed": "external",
                "origin": {"source": "org-skills", "path": "skills/foo", "ref": "x"},
            },
        },
        "sources": {
            "org-skills": {
                "type": "git",
                "name": "Org Skills",
                "url": "git@example.com:org/skills.git",
            }
        },
    }
    out = {s["id"]: s for s in hub.list_sources(registry)}
    assert out["local"]["skill_count"] == 1
    assert out["starter"]["skill_count"] == 0
    assert "org-skills" in out
    assert out["org-skills"]["skill_count"] == 1
    assert out["org-skills"]["url"] == "git@example.com:org/skills.git"
    assert out["org-skills"]["status"] == "unknown"
    assert out["org-skills"]["builtin"] is False


def test_imported_skills_for_source(tmp_data_home):
    registry = {
        "skills": {
            "foo": {
                "source": "/cache/foo",
                "managed": "external",
                "origin": {"source": "org-skills", "path": "skills/foo"},
            },
            "bar": {"source": "/cache/bar", "managed": "local"},
        }
    }
    items = hub.imported_skills_for_source(registry, "org-skills")
    assert len(items) == 1
    assert items[0]["name"] == "foo"
    assert items[0]["managed"] == "external"


# ─── CLI contract: `hub source list --json` / `hub source status --json` ────


def _run_hub_cli(tmp_data_home: Path, code_root: Path, args: list[str]) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["SKILL_HUB_HOME"] = str(tmp_data_home)
    env["SKILL_HUB_CODE"] = str(code_root)
    env.pop("SKILL_HUB_DIR", None)
    repo_root = Path(__file__).resolve().parent.parent
    return subprocess.run(
        [sys.executable, str(repo_root / "hub.py"), *args],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(repo_root),
    )


def test_cli_source_list_json_lists_builtins_only(tmp_data_home, monkeypatch):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home, {"version": "1", "skills": {}})

    result = _run_hub_cli(tmp_data_home, code_root, ["source", "list", "--json"])
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    ids = [s["id"] for s in payload["sources"]]
    assert "local" in ids
    assert "starter" in ids
    assert payload["errors"] == []


def test_cli_source_list_json_includes_git_source(tmp_data_home, monkeypatch):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(
        tmp_data_home,
        {
            "version": "1",
            "skills": {},
            "sources": {
                "org-skills": {
                    "type": "git",
                    "name": "Org Skills",
                    "url": "git@example.com:org/skills.git",
                    "branch": "main",
                    "status": "update-available",
                    "current_ref": "abc123",
                    "remote_ref": "def456",
                }
            },
        },
    )

    result = _run_hub_cli(tmp_data_home, code_root, ["source", "list", "--json"])
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    git = next(s for s in payload["sources"] if s["id"] == "org-skills")
    assert git["type"] == "git"
    assert git["status"] == "update-available"
    assert git["url"] == "git@example.com:org/skills.git"
    assert git["current_ref"] == "abc123"
    assert git["remote_ref"] == "def456"


def test_cli_source_status_unknown_id_errors(tmp_data_home, monkeypatch):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(tmp_data_home, {"version": "1", "skills": {}})
    result = _run_hub_cli(tmp_data_home, code_root, ["source", "status", "does-not-exist", "--json"])
    assert result.returncode == 0  # --json prints error payload
    payload = json.loads(result.stdout)
    assert payload["source"] is None
    assert "not found" in payload["error"]


def test_cli_source_status_returns_imported_skills(tmp_data_home, monkeypatch):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    _seed_registry(
        tmp_data_home,
        {
            "version": "1",
            "skills": {
                "android-compose-ui": {
                    "source": "/cache/org/skills/android-compose-ui",
                    "type": "claude-skill",
                    "scope": "portable",
                    "managed": "external",
                    "origin": {"source": "org-skills", "path": "skills/android-compose-ui", "ref": "abc"},
                }
            },
            "sources": {
                "org-skills": {
                    "type": "git",
                    "name": "Org Skills",
                    "url": "git@example.com:org/skills.git",
                }
            },
        },
    )
    result = _run_hub_cli(tmp_data_home, code_root, ["source", "status", "org-skills", "--json"])
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["source"]["id"] == "org-skills"
    names = [s["name"] for s in payload["skills"]]
    assert "android-compose-ui" in names


# ─── Backward compatibility: existing registry without `sources:` still loads ─


def test_registry_without_sources_loads_normally(tmp_data_home, monkeypatch):
    code_root = _seed_code_home(tmp_data_home, monkeypatch)
    skill_dir = hub.hub_skills_dir() / "grill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("---\nname: grill\ndescription: x\n---\n")
    _seed_registry(
        tmp_data_home,
        {
            "version": "1",
            "skills": {
                "grill": {
                    "source": str(skill_dir),
                    "type": "claude-skill",
                    "scope": "portable",
                    "upstream": None,
                }
            },
        },
    )
    result = _run_hub_cli(tmp_data_home, code_root, ["source", "list", "--json"])
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    by_id = {s["id"]: s for s in payload["sources"]}
    assert by_id["local"]["skill_count"] == 1
