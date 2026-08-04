"""CLI integration tests for `hub permissions presets ...` subcommands."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
HUB_PY = REPO_ROOT / "hub.py"


def _env(data_home: Path) -> dict[str, str]:
    env = {
        **os.environ,
        "SKILL_HUB_HOME": str(data_home),
        "SKILL_HUB_CODE": str(REPO_ROOT),
    }
    env.pop("SKILL_HUB_DIR", None)
    return env


def _run(args: list[str], data_home: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(HUB_PY), *args],
        capture_output=True,
        text=True,
        env=_env(data_home),
        cwd=str(data_home),
    )


def _seed(data_home: Path, registry: dict) -> None:
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _read_registry(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text()) or {}


def _base_registry(projects: dict | None = None) -> dict:
    return {
        "harnesses_global": [],
        "projects": projects or {},
        "skills": {},
    }


# ─── list ────────────────────────────────────────────────────────────────────


def test_presets_list_includes_builtins(tmp_data_home):
    _seed(tmp_data_home, _base_registry())
    r = _run(["permissions", "presets", "list", "--json"], tmp_data_home)
    assert r.returncode == 0, r.stderr
    data = json.loads(r.stdout)
    ids = [p["id"] for p in data]
    assert "git-safe" in ids
    assert "android-gradle" in ids
    for p in data:
        if p["id"] in {"git-safe", "android-gradle"}:
            assert p["builtin"] is True
            assert p["rule_count"] > 0


def test_presets_list_does_not_modify_registry(tmp_data_home):
    _seed(tmp_data_home, _base_registry())
    before = (tmp_data_home / "registry.yaml").read_text()
    r = _run(["permissions", "presets", "list"], tmp_data_home)
    assert r.returncode == 0
    after = (tmp_data_home / "registry.yaml").read_text()
    # After load_registry runs migrations, the registry may be re-saved once,
    # but `permission_presets:` should not appear since no user presets were
    # created.
    reg_after = yaml.safe_load(after) or {}
    assert "permission_presets" not in reg_after


def test_presets_list_includes_user_presets(tmp_data_home):
    reg = _base_registry()
    reg["permission_presets"] = {
        "my-npm": {
            "name": "NPM",
            "description": "",
            "icon": "📦",
            "category": "custom",
            "rules": [{"pattern": "Bash(npm run *)", "kind": "allow"}],
        }
    }
    _seed(tmp_data_home, reg)
    r = _run(["permissions", "presets", "list", "--json"], tmp_data_home)
    assert r.returncode == 0, r.stderr
    data = json.loads(r.stdout)
    custom = [p for p in data if p["id"] == "my-npm"]
    assert len(custom) == 1
    assert custom[0]["builtin"] is False


# ─── show ────────────────────────────────────────────────────────────────────


def test_presets_show_git_safe(tmp_data_home):
    _seed(tmp_data_home, _base_registry())
    r = _run(["permissions", "presets", "show", "git-safe", "--json"], tmp_data_home)
    assert r.returncode == 0, r.stderr
    data = json.loads(r.stdout)
    assert data["id"] == "git-safe"
    fetch_rule = next(
        rule for rule in data["rules"] if rule["pattern"] == "Bash(git fetch*)"
    )
    assert fetch_rule["enabled_by_default"] is False


def test_presets_show_unknown_fails(tmp_data_home):
    _seed(tmp_data_home, _base_registry())
    r = _run(["permissions", "presets", "show", "nope"], tmp_data_home)
    assert r.returncode != 0


# ─── apply ───────────────────────────────────────────────────────────────────


def test_presets_apply_git_safe_to_project(tmp_data_home):
    reg = _base_registry({"myapp": {"path": "/tmp/myapp", "bundles": [], "enabled": []}})
    _seed(tmp_data_home, reg)
    r = _run(
        ["permissions", "presets", "apply", "git-safe", "--project", "myapp"],
        tmp_data_home,
    )
    assert r.returncode == 0, r.stderr
    reg_after = _read_registry(tmp_data_home)
    allow = reg_after["projects"]["myapp"]["permissions"]["allow"]
    patterns = [a["pattern"] for a in allow]
    assert "Bash(git status*)" in patterns
    assert "Bash(git log*)" in patterns
    # git fetch is off by default
    assert "Bash(git fetch*)" not in patterns


def test_presets_apply_idempotent(tmp_data_home):
    reg = _base_registry({"myapp": {"path": "/tmp/myapp", "bundles": [], "enabled": []}})
    _seed(tmp_data_home, reg)
    _run(
        ["permissions", "presets", "apply", "git-safe", "--project", "myapp"],
        tmp_data_home,
    )
    reg_after_1 = _read_registry(tmp_data_home)
    n1 = len(reg_after_1["projects"]["myapp"]["permissions"]["allow"])
    r = _run(
        ["permissions", "presets", "apply", "git-safe", "--project", "myapp", "--json"],
        tmp_data_home,
    )
    assert r.returncode == 0, r.stderr
    data = json.loads(r.stdout)
    assert data["added"] == 0
    reg_after_2 = _read_registry(tmp_data_home)
    n2 = len(reg_after_2["projects"]["myapp"]["permissions"]["allow"])
    assert n1 == n2


def test_presets_apply_with_rules_filter(tmp_data_home):
    reg = _base_registry({"myapp": {"path": "/tmp/myapp", "bundles": [], "enabled": []}})
    _seed(tmp_data_home, reg)
    r = _run(
        [
            "permissions",
            "presets",
            "apply",
            "git-safe",
            "--project",
            "myapp",
            "--rules",
            "Bash(git status*),Bash(git log*)",
        ],
        tmp_data_home,
    )
    assert r.returncode == 0, r.stderr
    reg_after = _read_registry(tmp_data_home)
    patterns = [a["pattern"] for a in reg_after["projects"]["myapp"]["permissions"]["allow"]]
    assert sorted(patterns) == sorted(["Bash(git status*)", "Bash(git log*)"])


def test_presets_apply_unknown_project_fails(tmp_data_home):
    _seed(tmp_data_home, _base_registry())
    r = _run(
        ["permissions", "presets", "apply", "git-safe", "--project", "nope"],
        tmp_data_home,
    )
    assert r.returncode != 0


# ─── new / update / delete ───────────────────────────────────────────────────


def test_presets_new_creates_empty_preset(tmp_data_home):
    _seed(tmp_data_home, _base_registry())
    r = _run(
        [
            "permissions",
            "presets",
            "new",
            "my-tools",
            "--name",
            "My tools",
            "--description",
            "personal",
            "--icon",
            "🔧",
        ],
        tmp_data_home,
    )
    assert r.returncode == 0, r.stderr
    reg = _read_registry(tmp_data_home)
    assert "my-tools" in reg["permission_presets"]
    entry = reg["permission_presets"]["my-tools"]
    assert entry["name"] == "My tools"
    assert entry["icon"] == "🔧"
    assert entry["rules"] == []


def test_presets_new_rejects_duplicate(tmp_data_home):
    _seed(tmp_data_home, _base_registry())
    _run(
        ["permissions", "presets", "new", "dup", "--name", "x"],
        tmp_data_home,
    )
    r = _run(
        ["permissions", "presets", "new", "dup", "--name", "y"],
        tmp_data_home,
    )
    assert r.returncode != 0


def test_presets_new_rejects_builtin_id(tmp_data_home):
    _seed(tmp_data_home, _base_registry())
    r = _run(
        ["permissions", "presets", "new", "git-safe", "--name", "x"],
        tmp_data_home,
    )
    assert r.returncode != 0


def test_presets_update_adds_and_removes_rules(tmp_data_home):
    _seed(tmp_data_home, _base_registry())
    _run(
        ["permissions", "presets", "new", "my-npm", "--name", "NPM"],
        tmp_data_home,
    )
    r1 = _run(
        [
            "permissions",
            "presets",
            "update",
            "my-npm",
            "--add-rule",
            "Bash(npm run *)",
            "--add-rule",
            "Bash(npm test*)",
        ],
        tmp_data_home,
    )
    assert r1.returncode == 0, r1.stderr
    reg = _read_registry(tmp_data_home)
    patterns = [r["pattern"] for r in reg["permission_presets"]["my-npm"]["rules"]]
    assert sorted(patterns) == sorted(["Bash(npm run *)", "Bash(npm test*)"])

    r2 = _run(
        [
            "permissions",
            "presets",
            "update",
            "my-npm",
            "--remove-rule",
            "Bash(npm test*)",
        ],
        tmp_data_home,
    )
    assert r2.returncode == 0, r2.stderr
    reg = _read_registry(tmp_data_home)
    patterns = [r["pattern"] for r in reg["permission_presets"]["my-npm"]["rules"]]
    assert patterns == ["Bash(npm run *)"]


def test_presets_update_rejects_builtin(tmp_data_home):
    _seed(tmp_data_home, _base_registry())
    r = _run(
        ["permissions", "presets", "update", "git-safe", "--name", "spoof"],
        tmp_data_home,
    )
    assert r.returncode != 0


def test_presets_delete_user_preset(tmp_data_home):
    _seed(tmp_data_home, _base_registry())
    _run(
        ["permissions", "presets", "new", "tmp-preset", "--name", "x"],
        tmp_data_home,
    )
    r = _run(["permissions", "presets", "delete", "tmp-preset"], tmp_data_home)
    assert r.returncode == 0, r.stderr
    reg = _read_registry(tmp_data_home)
    assert "tmp-preset" not in (reg.get("permission_presets") or {})


def test_presets_delete_rejects_builtin(tmp_data_home):
    _seed(tmp_data_home, _base_registry())
    r = _run(["permissions", "presets", "delete", "git-safe"], tmp_data_home)
    assert r.returncode != 0
    # The output should mention that built-ins cannot be deleted.
    blob = (r.stdout + r.stderr).lower()
    assert "built-in" in blob or "builtin" in blob
