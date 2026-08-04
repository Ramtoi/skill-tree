"""Personal per-project permission tier → `.claude/settings.local.json`.

Proves the gitignored personal tier end-to-end-ish: a project with a
`permissions_local` block, when resolved + written via the Claude adapter using
a personal ProjectScope, lands in `settings.local.json` and contains ONLY the
personal rules — never the shared (`permissions`) or global ones.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

import permission_adapters as pa
from permissions import (
    ProjectScope,
    read_sidecar,
    resolve_project_local_own,
    resolve_project_own,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
HUB_PY = REPO_ROOT / "hub.py"


def _cli_env(data_home: Path) -> dict[str, str]:
    env = {
        **os.environ,
        "SKILL_HUB_HOME": str(data_home),
        "SKILL_HUB_CODE": str(REPO_ROOT),
    }
    env.pop("SKILL_HUB_DIR", None)
    return env


def _cli(args: list[str], data_home: Path, stdin: str | None = None):
    return subprocess.run(
        [sys.executable, str(HUB_PY), *args],
        capture_output=True,
        text=True,
        env=_cli_env(data_home),
        cwd=str(data_home),
        input=stdin,
    )


def _seed_project(data_home: Path, name: str, path: Path) -> None:
    (data_home / "registry.yaml").write_text(
        yaml.safe_dump(
            {
                "harnesses_global": [],
                "projects": {name: {"path": str(path)}},
                "skills": {},
            },
            sort_keys=False,
        )
    )


@pytest.fixture(autouse=True)
def _reset_backup_state():
    pa._reset_backup_session_state_for_tests()
    yield
    pa._reset_backup_session_state_for_tests()


def _project_cfg(path: Path) -> dict:
    return {
        "path": str(path),
        # Shared, committed rules.
        "permissions": {"allow": [{"pattern": "Bash(npm:*)", "kind": "allow"}]},
        # Personal, gitignored rules.
        "permissions_local": {
            "allow": [{"pattern": "Bash(my-secret-tool:*)", "kind": "allow"}],
            "deny": [{"pattern": "Bash(rm:*)", "kind": "deny"}],
        },
    }


def test_personal_scope_targets_settings_local_json(tmp_path):
    adapter = pa.ClaudePermissionAdapter()
    personal = ProjectScope(name="alpha", path=str(tmp_path), personal=True)
    shared = ProjectScope(name="alpha", path=str(tmp_path))

    assert str(adapter.target_files(personal, "claude-code")).endswith(
        ".claude/settings.local.json"
    )
    # The shared scope still targets the committed file — they never collide.
    assert str(adapter.target_files(shared, "claude-code")).endswith(
        ".claude/settings.json"
    )
    # Distinct slugs so their sidecars/backups never clobber each other.
    assert personal.slug != shared.slug


def test_personal_tier_writes_only_personal_rules(tmp_data_home, tmp_path):
    proj = _project_cfg(tmp_path)
    adapter = pa.ClaudePermissionAdapter()

    # Write the SHARED block to the committed file.
    shared_scope = ProjectScope(name="alpha", path=str(tmp_path))
    shared_perms = resolve_project_own(proj)
    for w in adapter.translate(shared_perms, shared_scope, "claude-code").writes:
        adapter.apply(shared_scope, w, "claude-code")

    # Write the PERSONAL block to the gitignored local file.
    personal_scope = ProjectScope(name="alpha", path=str(tmp_path), personal=True)
    local_perms = resolve_project_local_own(proj)
    for w in adapter.translate(local_perms, personal_scope, "claude-code").writes:
        adapter.apply(personal_scope, w, "claude-code")

    committed = json.loads((tmp_path / ".claude/settings.json").read_text())
    local = json.loads((tmp_path / ".claude/settings.local.json").read_text())

    # The committed file holds ONLY the shared rule.
    assert "Bash(npm:*)" in committed["permissions"]["allow"]
    assert "Bash(my-secret-tool:*)" not in committed["permissions"].get("allow", [])

    # The local file holds ONLY the personal rules — not the shared one.
    assert "Bash(my-secret-tool:*)" in local["permissions"]["allow"]
    assert "Bash(rm:*)" in local["permissions"]["deny"]
    assert "Bash(npm:*)" not in local["permissions"].get("allow", [])


def test_personal_tier_round_trips_idempotently(tmp_data_home, tmp_path):
    proj = _project_cfg(tmp_path)
    adapter = pa.ClaudePermissionAdapter()
    personal_scope = ProjectScope(name="alpha", path=str(tmp_path), personal=True)
    target = tmp_path / ".claude/settings.local.json"

    def sync_once():
        local_perms = resolve_project_local_own(proj)
        for w in adapter.translate(local_perms, personal_scope, "claude-code").writes:
            adapter.apply(personal_scope, w, "claude-code")

    sync_once()
    first = target.read_text()
    sync_once()
    second = target.read_text()
    # No duplication on re-sync (prior managed keys stripped before re-write).
    assert first == second
    data = json.loads(second)
    assert data["permissions"]["allow"].count("Bash(my-secret-tool:*)") == 1

    # The personal scope owns its own sidecar, distinct from the shared scope's.
    assert read_sidecar("claude-code", personal_scope) is not None
    assert read_sidecar("claude-code", ProjectScope(name="alpha", path=str(tmp_path))) is None


# ── CLI: `permissions {set,show,add} --personal --project <n>` ──────────────


def test_cli_set_show_personal_round_trips(tmp_data_home, tmp_path):
    _seed_project(tmp_data_home, "alpha", tmp_path)
    payload = json.dumps(
        {"allow": [{"pattern": "Bash(my-secret-tool:*)", "kind": "allow"}]}
    )
    r = _cli(
        ["permissions", "set", "--project", "alpha", "--personal", "--stdin-json"],
        tmp_data_home,
        stdin=payload,
    )
    assert r.returncode == 0, r.stderr

    # show --personal returns the personal rule.
    rs = _cli(
        ["permissions", "show", "--project", "alpha", "--personal", "--json"],
        tmp_data_home,
    )
    assert rs.returncode == 0, rs.stderr
    personal = json.loads(rs.stdout)
    assert "Bash(my-secret-tool:*)" in [x["pattern"] for x in personal["allow"]]

    # The committed (shared) block is NOT polluted.
    rc = _cli(
        ["permissions", "show", "--project", "alpha", "--json"], tmp_data_home
    )
    assert rc.returncode == 0, rc.stderr
    shared = json.loads(rc.stdout)
    assert shared["allow"] == []

    # Registry persisted into permissions_local, not permissions.
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    proj = reg["projects"]["alpha"]
    assert proj["permissions_local"]["allow"][0]["pattern"] == "Bash(my-secret-tool:*)"
    assert not (proj.get("permissions") or {}).get("allow")


def test_cli_add_personal_writes_local_block(tmp_data_home, tmp_path):
    _seed_project(tmp_data_home, "alpha", tmp_path)
    r = _cli(
        [
            "permissions", "add", "--project", "alpha", "--personal",
            "--kind", "allow", "--pattern", "Bash(git:*)",
        ],
        tmp_data_home,
    )
    assert r.returncode == 0, r.stderr
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    proj = reg["projects"]["alpha"]
    assert proj["permissions_local"]["allow"][0]["pattern"] == "Bash(git:*)"
    # Shared block untouched.
    assert not (proj.get("permissions") or {}).get("allow")


def test_cli_personal_without_project_errors(tmp_data_home):
    (tmp_data_home / "registry.yaml").write_text(
        yaml.safe_dump(
            {"harnesses_global": [], "projects": {}, "skills": {}}, sort_keys=False
        )
    )
    r = _cli(
        ["permissions", "show", "--global", "--personal", "--json"], tmp_data_home
    )
    assert r.returncode != 0
    assert "personal" in (r.stderr + r.stdout).lower()
