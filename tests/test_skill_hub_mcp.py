"""Tests for skill_hub_mcp_server.py — the v2 control-plane MCP server.

The server is driven as a SUBPROCESS over newline-delimited JSON-RPC 2.0
(one JSON object per line, request → response). A minimal registry is written
into an isolated SKILL_HUB_HOME so the server has something to read/mutate.

Also covers the `hub mcp-control install/uninstall` idempotency (in-process).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
SERVER = REPO_ROOT / "skill_hub_mcp_server.py"


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _write_min_registry(home: Path) -> None:
    """A minimal but valid registry the server can load + mutate."""
    home.mkdir(parents=True, exist_ok=True)
    (home / "skills").mkdir(exist_ok=True)
    registry = {
        "harnesses_global": ["claude-code"],
        "bootstrap": {"completed_at": "2026-01-01T00:00:00", "version": 1},
        "skills": {},
        "projects": {},
        "bundles": {},
        "permissions_global": {},
    }
    with open(home / "registry.yaml", "w") as f:
        yaml.dump(registry, f, sort_keys=False, allow_unicode=True)


def _write_registry_with_project(home: Path, proj_name: str, proj_path: Path) -> None:
    """A registry that registers one project at proj_path."""
    home.mkdir(parents=True, exist_ok=True)
    (home / "skills").mkdir(exist_ok=True)
    registry = {
        "harnesses_global": ["claude-code"],
        "bootstrap": {"completed_at": "2026-01-01T00:00:00", "version": 1},
        "skills": {},
        "projects": {proj_name: {"path": str(proj_path), "bundles": [], "enabled": []}},
        "bundles": {},
        "permissions_global": {},
    }
    with open(home / "registry.yaml", "w") as f:
        yaml.dump(registry, f, sort_keys=False, allow_unicode=True)


def _author_project_skill(proj_path: Path, name: str) -> None:
    """Hand-author a project-local skill under .claude/skills/<name>/."""
    skill_dir = proj_path / ".claude" / "skills" / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: A hand-authored project-local skill.\n"
        f"version: 0.1.0\n---\n\n# {name}\n"
    )


def _server_env(home: Path) -> dict:
    env = dict(os.environ)
    env["SKILL_HUB_HOME"] = str(home)
    env.pop("SKILL_HUB_DIR", None)
    env.pop("SKILL_HUB_CODE", None)
    return env


def _rpc(home: Path, requests: list[dict]) -> list[dict]:
    """Spawn the server, send each request as one JSON line, collect responses."""
    payload = "\n".join(json.dumps(r) for r in requests) + "\n"
    proc = subprocess.run(
        [sys.executable, str(SERVER)],
        input=payload,
        capture_output=True,
        text=True,
        env=_server_env(home),
        cwd=str(REPO_ROOT),
        timeout=120,
    )
    responses = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line:
            responses.append(json.loads(line))
    return responses


def _by_id(responses: list[dict], req_id):
    for r in responses:
        if r.get("id") == req_id:
            return r
    raise AssertionError(f"no response with id={req_id} in {responses}")


def _tool_result(response: dict) -> dict:
    """Unwrap the {content:[{text:...}]} envelope into the parsed result dict."""
    text = response["result"]["content"][0]["text"]
    return json.loads(text)


def _call(name, arguments, req_id=1):
    """Build a tools/call JSON-RPC request."""
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }


def _read_registry(home: Path) -> dict:
    return yaml.safe_load((home / "registry.yaml").read_text())


# ─────────────────────────────────────────────────────────────────────────────
# 1. initialize + tools/list contract
# ─────────────────────────────────────────────────────────────────────────────

EXPECTED_TOOLS = {
    # READ (6)
    "project_list",
    "skill_list",
    "bundle_list",
    "snippet_list",
    "skill_candidates",
    "inspect",
    # WRITE — skills & bundles (8)
    "skill_create",
    "skill_set_meta",
    "skill_archive",
    "skill_import",
    "equip",
    "bundle_save",
    "bundle_delete",
    "sync",
    # WRITE — snippets (3)
    "snippet_save",
    "snippet_place",
    "snippet_delete",
}

# Hard scope rule: no permission/harness WRITE tools may ever be exposed.
FORBIDDEN_TOOLS = {
    "permissions_add",
    "permissions_set",
    "permissions_remove",
    "permissions_reconcile",
    "permissions_adopt",
    "harness_enable",
    "harness_disable",
}


def test_initialize_and_tools_list(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        ],
    )

    init = _by_id(responses, 1)
    assert init["result"]["protocolVersion"] == "2024-11-05"
    assert init["result"]["serverInfo"]["name"] == "skill-tree"
    assert init["result"]["serverInfo"]["version"] == "2.0.0"

    tools = _by_id(responses, 2)["result"]["tools"]
    names = {t["name"] for t in tools}
    assert names == EXPECTED_TOOLS
    assert len(EXPECTED_TOOLS) == 17
    # No permission/harness write tool may be present.
    assert not (names & FORBIDDEN_TOOLS)
    # Every tool declares a JSON-schema input + a non-empty description.
    for t in tools:
        assert t["inputSchema"]["type"] == "object"
        assert t["description"]


# ─────────────────────────────────────────────────────────────────────────────
# 2. skill_create then skill_list — new skill shows up
# ─────────────────────────────────────────────────────────────────────────────


def test_skill_create_then_list(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            _call("skill_create", {"name": "demo-skill"}, req_id=2),
            _call("skill_list", {}, req_id=3),
        ],
    )

    created = _tool_result(_by_id(responses, 2))
    assert created["ok"] is True
    assert created["result"]["name"] == "demo-skill"
    assert created["result"]["scope"] == "project-specific"

    listing = _tool_result(_by_id(responses, 3))
    assert listing["ok"] is True
    names = {s["name"] for s in listing["result"]["skills"]}
    assert "demo-skill" in names
    entry = next(s for s in listing["result"]["skills"] if s["name"] == "demo-skill")
    assert entry["scope"] == "project-specific"
    # v2 rows carry harness affinity + invocation mode.
    assert "harnesses" in entry
    assert entry["invocation"] == "auto"


# ─────────────────────────────────────────────────────────────────────────────
# 3. skill_archive safe-by-default destructive gating (confirm-only)
# ─────────────────────────────────────────────────────────────────────────────


def test_skill_archive_safe_by_default(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [
            _call("skill_create", {"name": "doomed"}, req_id=1),
            # No confirm → must be a preview, skill survives.
            _call("skill_archive", {"skill": "doomed"}, req_id=2),
            _call("skill_list", {}, req_id=3),
            # confirm=true → actually archives.
            _call("skill_archive", {"skill": "doomed", "confirm": True}, req_id=4),
            _call("skill_list", {}, req_id=5),
        ],
    )

    preview = _tool_result(_by_id(responses, 2))
    assert preview["ok"] is True
    assert preview["result"]["applied"] is False

    after_preview = _tool_result(_by_id(responses, 3))
    assert "doomed" in {s["name"] for s in after_preview["result"]["skills"]}

    applied = _tool_result(_by_id(responses, 4))
    assert applied["ok"] is True
    assert applied["result"]["applied"] is True

    after_apply = _tool_result(_by_id(responses, 5))
    assert "doomed" not in {s["name"] for s in after_apply["result"]["skills"]}


# ─────────────────────────────────────────────────────────────────────────────
# 4. hub.fail() → ok:false, and the server stays alive afterward
# ─────────────────────────────────────────────────────────────────────────────


def test_failing_call_does_not_kill_server(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [
            # equip onto a project that does not exist → ok:false.
            _call(
                "equip",
                {
                    "target": "skill",
                    "name": "nope",
                    "project": "nope-proj",
                    "state": "on",
                },
                req_id=1,
            ),
            # Server must still answer this.
            _call("skill_list", {}, req_id=2),
        ],
    )

    failed = _tool_result(_by_id(responses, 1))
    assert failed["ok"] is False
    assert failed["error"]

    survivor = _tool_result(_by_id(responses, 2))
    assert survivor["ok"] is True


def test_unknown_tool_returns_jsonrpc_error(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [
            # A forbidden write tool simply does not exist → method-not-found.
            _call("permissions_add", {}, req_id=1),
            # An old, folded-away tool is also gone.
            _call("harness_list", {}, req_id=2),
            # Server is still alive and answers a real tool.
            _call("skill_list", {}, req_id=3),
        ],
    )
    assert _by_id(responses, 1)["error"]["code"] == -32601
    assert _by_id(responses, 2)["error"]["code"] == -32601
    assert _tool_result(_by_id(responses, 3))["ok"] is True


# ─────────────────────────────────────────────────────────────────────────────
# 5. project_list — a registered project appears with path + active skills
# ─────────────────────────────────────────────────────────────────────────────


def test_project_list(tmp_data_home, tmp_path):
    proj_path = tmp_path / "myproj"
    proj_path.mkdir()
    _write_registry_with_project(tmp_data_home, "myproj", proj_path)

    responses = _rpc(
        tmp_data_home,
        [
            _call("skill_create", {"name": "p-skill"}, req_id=1),
            _call(
                "equip",
                {"target": "skill", "name": "p-skill", "project": "myproj", "state": "on"},
                req_id=2,
            ),
            _call("project_list", {}, req_id=3),
            _call("project_list", {"name": "myproj"}, req_id=4),
            # Unknown project → plain error (no project_list hint needed here).
            _call("project_list", {"name": "ghost"}, req_id=5),
        ],
    )

    assert _tool_result(_by_id(responses, 2))["ok"] is True

    listing = _tool_result(_by_id(responses, 3))
    assert listing["ok"] is True
    projects = {p["name"]: p for p in listing["result"]["projects"]}
    assert "myproj" in projects
    entry = projects["myproj"]
    assert entry["path"] == str(proj_path)
    assert "p-skill" in entry["active_skills"]
    assert "harnesses_effective" in entry

    one = _tool_result(_by_id(responses, 4))
    assert one["ok"] is True
    assert one["result"]["count"] == 1
    assert one["result"]["projects"][0]["name"] == "myproj"

    ghost = _tool_result(_by_id(responses, 5))
    assert ghost["ok"] is False
    assert "ghost" in ghost["error"]


# ─────────────────────────────────────────────────────────────────────────────
# 6. equip — skill + bundle, on/off round-trip via skill_list{project}
# ─────────────────────────────────────────────────────────────────────────────


def test_equip_skill_on_off_roundtrip(tmp_data_home, tmp_path):
    proj_path = tmp_path / "proj"
    proj_path.mkdir()
    _write_registry_with_project(tmp_data_home, "proj", proj_path)

    responses = _rpc(
        tmp_data_home,
        [
            _call("skill_create", {"name": "toggle-me"}, req_id=1),
            _call(
                "equip",
                {"target": "skill", "name": "toggle-me", "project": "proj", "state": "on"},
                req_id=2,
            ),
            _call("skill_list", {"project": "proj"}, req_id=3),
            _call(
                "equip",
                {"target": "skill", "name": "toggle-me", "project": "proj", "state": "off"},
                req_id=4,
            ),
            _call("skill_list", {"project": "proj"}, req_id=5),
        ],
    )

    on = _tool_result(_by_id(responses, 2))
    assert on["ok"] is True
    assert on["result"] == {
        "target": "skill",
        "name": "toggle-me",
        "project": "proj",
        "state": "on",
    }

    after_on = _tool_result(_by_id(responses, 3))
    row = next(s for s in after_on["result"]["skills"] if s["name"] == "toggle-me")
    assert row["active"] is True

    off = _tool_result(_by_id(responses, 4))
    assert off["ok"] is True

    after_off = _tool_result(_by_id(responses, 5))
    row2 = next(s for s in after_off["result"]["skills"] if s["name"] == "toggle-me")
    assert row2["active"] is False


def test_equip_bundle_on_off_roundtrip(tmp_data_home, tmp_path):
    proj_path = tmp_path / "proj"
    proj_path.mkdir()
    _write_registry_with_project(tmp_data_home, "proj", proj_path)

    responses = _rpc(
        tmp_data_home,
        [
            _call("skill_create", {"name": "in-bundle"}, req_id=1),
            _call("bundle_save", {"name": "kit", "skills": ["in-bundle"]}, req_id=2),
            _call(
                "equip",
                {"target": "bundle", "name": "kit", "project": "proj", "state": "on"},
                req_id=3,
            ),
            _call("skill_list", {"project": "proj"}, req_id=4),
            _call(
                "equip",
                {"target": "bundle", "name": "kit", "project": "proj", "state": "off"},
                req_id=5,
            ),
            _call("skill_list", {"project": "proj"}, req_id=6),
        ],
    )

    assert _tool_result(_by_id(responses, 2))["ok"] is True
    assert _tool_result(_by_id(responses, 3))["ok"] is True

    after_on = _tool_result(_by_id(responses, 4))
    row = next(s for s in after_on["result"]["skills"] if s["name"] == "in-bundle")
    assert row["active"] is True  # active via bundle

    assert _tool_result(_by_id(responses, 5))["ok"] is True
    after_off = _tool_result(_by_id(responses, 6))
    row2 = next(s for s in after_off["result"]["skills"] if s["name"] == "in-bundle")
    assert row2["active"] is False


def test_equip_with_invocation_override(tmp_data_home, tmp_path):
    proj_path = tmp_path / "proj"
    proj_path.mkdir()
    _write_registry_with_project(tmp_data_home, "proj", proj_path)

    responses = _rpc(
        tmp_data_home,
        [
            _call("skill_create", {"name": "inv-skill"}, req_id=1),
            _call(
                "equip",
                {
                    "target": "skill",
                    "name": "inv-skill",
                    "project": "proj",
                    "state": "on",
                    "invocation": "user-only",
                },
                req_id=2,
            ),
        ],
    )

    res = _tool_result(_by_id(responses, 2))
    assert res["ok"] is True
    assert res["result"]["invocation"] == "user-only"

    # The per-project override is persisted in the registry.
    reg = _read_registry(tmp_data_home)
    overrides = reg["projects"]["proj"].get("invocation_overrides") or {}
    assert overrides.get("inv-skill") == "user-only"


def test_equip_invalid_invocation_combo_errors(tmp_data_home, tmp_path):
    proj_path = tmp_path / "proj"
    proj_path.mkdir()
    _write_registry_with_project(tmp_data_home, "proj", proj_path)

    responses = _rpc(
        tmp_data_home,
        [
            _call("skill_create", {"name": "inv-skill"}, req_id=1),
            # invocation is only legal with target=skill & state=on.
            _call(
                "equip",
                {
                    "target": "skill",
                    "name": "inv-skill",
                    "project": "proj",
                    "state": "off",
                    "invocation": "user-only",
                },
                req_id=2,
            ),
            _call(
                "equip",
                {
                    "target": "bundle",
                    "name": "inv-skill",
                    "project": "proj",
                    "state": "on",
                    "invocation": "user-only",
                },
                req_id=3,
            ),
        ],
    )

    off_combo = _tool_result(_by_id(responses, 2))
    assert off_combo["ok"] is False
    assert "invocation" in (off_combo["error"] or "")

    bundle_combo = _tool_result(_by_id(responses, 3))
    assert bundle_combo["ok"] is False
    assert "invocation" in (bundle_combo["error"] or "")


def test_unknown_project_error_mentions_project_list(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [
            _call("skill_list", {"project": "ghost"}, req_id=1),
            _call(
                "equip",
                {"target": "skill", "name": "x", "project": "ghost", "state": "on"},
                req_id=2,
            ),
        ],
    )
    for rid in (1, 2):
        res = _tool_result(_by_id(responses, rid))
        assert res["ok"] is False
        assert res["error"].endswith("use project_list to discover project names")


# ─────────────────────────────────────────────────────────────────────────────
# 7. skill_set_meta — rename, reject-combination, harness affinity array
# ─────────────────────────────────────────────────────────────────────────────


def test_skill_set_meta_rename(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [
            _call("skill_create", {"name": "old-skill"}, req_id=1),
            # dry_run rename previews only.
            _call(
                "skill_set_meta",
                {"skill": "old-skill", "new_name": "new-skill", "dry_run": True},
                req_id=2,
            ),
            _call("skill_list", {}, req_id=3),
            # real rename.
            _call("skill_set_meta", {"skill": "old-skill", "new_name": "new-skill"}, req_id=4),
            _call("skill_list", {}, req_id=5),
        ],
    )

    preview = _tool_result(_by_id(responses, 2))
    assert preview["ok"] is True
    after_preview = {
        s["name"] for s in _tool_result(_by_id(responses, 3))["result"]["skills"]
    }
    assert "old-skill" in after_preview and "new-skill" not in after_preview

    renamed = _tool_result(_by_id(responses, 4))
    assert renamed["ok"] is True
    after = {s["name"] for s in _tool_result(_by_id(responses, 5))["result"]["skills"]}
    assert "new-skill" in after and "old-skill" not in after


def test_skill_set_meta_rejects_combination(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [
            _call("skill_create", {"name": "a-skill"}, req_id=1),
            _call(
                "skill_set_meta",
                {"skill": "a-skill", "new_name": "b-skill", "scope": "portable"},
                req_id=2,
            ),
            # a-skill must survive untouched.
            _call("skill_list", {}, req_id=3),
        ],
    )
    rejected = _tool_result(_by_id(responses, 2))
    assert rejected["ok"] is False
    assert "new_name" in (rejected["error"] or "")
    names = {s["name"] for s in _tool_result(_by_id(responses, 3))["result"]["skills"]}
    assert "a-skill" in names and "b-skill" not in names


def test_skill_set_meta_harnesses_array(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [
            _call("skill_create", {"name": "aff-skill"}, req_id=1),
            _call(
                "skill_set_meta",
                {"skill": "aff-skill", "harnesses": ["claude-code", "codex"]},
                req_id=2,
            ),
            _call("skill_list", {}, req_id=3),
            # Empty array clears the affinity back to all-effective.
            _call("skill_set_meta", {"skill": "aff-skill", "harnesses": []}, req_id=4),
            _call("skill_list", {}, req_id=5),
        ],
    )

    set_res = _tool_result(_by_id(responses, 2))
    assert set_res["ok"] is True
    assert set_res["result"]["harnesses"] == ["claude-code", "codex"]

    after_set = next(
        s
        for s in _tool_result(_by_id(responses, 3))["result"]["skills"]
        if s["name"] == "aff-skill"
    )
    assert after_set["harnesses"] == ["claude-code", "codex"]

    cleared = _tool_result(_by_id(responses, 4))
    assert cleared["ok"] is True
    after_clear = next(
        s
        for s in _tool_result(_by_id(responses, 5))["result"]["skills"]
        if s["name"] == "aff-skill"
    )
    assert not after_clear["harnesses"]  # None or empty


# ─────────────────────────────────────────────────────────────────────────────
# 8. bundle_save upsert + bundle_delete gating
# ─────────────────────────────────────────────────────────────────────────────


def test_bundle_save_upsert(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [
            _call("skill_create", {"name": "s1"}, req_id=1),
            _call("skill_create", {"name": "s2"}, req_id=2),
            # create WITHOUT skills → error.
            _call("bundle_save", {"name": "kit"}, req_id=3),
            # create with skills → membership set.
            _call("bundle_save", {"name": "kit", "skills": ["s1", "s2"]}, req_id=4),
            # update WITHOUT skills → membership preserved, description changed.
            _call("bundle_save", {"name": "kit", "description": "updated"}, req_id=5),
            _call("bundle_list", {}, req_id=6),
        ],
    )

    no_skills = _tool_result(_by_id(responses, 3))
    assert no_skills["ok"] is False
    assert "skills" in (no_skills["error"] or "")

    created = _tool_result(_by_id(responses, 4))
    assert created["ok"] is True
    assert created["result"]["skills"] == ["s1", "s2"]

    updated = _tool_result(_by_id(responses, 5))
    assert updated["ok"] is True
    assert updated["result"]["skills"] == ["s1", "s2"]  # unchanged
    assert updated["result"]["description"] == "updated"

    listing = _tool_result(_by_id(responses, 6))
    row = next(b for b in listing["result"]["bundles"] if b["name"] == "kit")
    assert row["skills"] == ["s1", "s2"]


def test_bundle_delete_safe_by_default(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [
            _call("skill_create", {"name": "s1"}, req_id=1),
            _call("bundle_save", {"name": "kit", "skills": ["s1"]}, req_id=2),
            _call("bundle_delete", {"name": "kit"}, req_id=3),  # preview
            _call("bundle_list", {}, req_id=4),
            _call("bundle_delete", {"name": "kit", "confirm": True}, req_id=5),
            _call("bundle_list", {}, req_id=6),
        ],
    )

    preview = _tool_result(_by_id(responses, 3))
    assert preview["ok"] is True
    assert preview["result"]["applied"] is False
    assert "kit" in {
        b["name"] for b in _tool_result(_by_id(responses, 4))["result"]["bundles"]
    }

    applied = _tool_result(_by_id(responses, 5))
    assert applied["ok"] is True
    assert applied["result"]["applied"] is True
    assert "kit" not in {
        b["name"] for b in _tool_result(_by_id(responses, 6))["result"]["bundles"]
    }


# ─────────────────────────────────────────────────────────────────────────────
# 9. inspect — sections
# ─────────────────────────────────────────────────────────────────────────────


def test_inspect_sections(tmp_data_home, tmp_path):
    proj_path = tmp_path / "proj"
    proj_path.mkdir()
    _write_registry_with_project(tmp_data_home, "proj", proj_path)

    responses = _rpc(
        tmp_data_home,
        [
            _call("inspect", {}, req_id=1),  # all sections
            _call("inspect", {"section": "harnesses"}, req_id=2),
            _call("inspect", {"section": "permissions"}, req_id=3),
            _call("inspect", {"section": "agent_docs", "project": "proj"}, req_id=4),
            _call("inspect", {"section": "bogus"}, req_id=5),
        ],
    )

    all_res = _tool_result(_by_id(responses, 1))
    assert all_res["ok"] is True
    for key in ("harnesses", "permissions", "risks", "agent_docs"):
        assert key in all_res["result"]

    harnesses_only = _tool_result(_by_id(responses, 2))
    assert harnesses_only["ok"] is True
    assert set(harnesses_only["result"]) == {"harnesses"}
    assert any(h["id"] == "claude-code" for h in harnesses_only["result"]["harnesses"])

    perms_only = _tool_result(_by_id(responses, 3))
    assert set(perms_only["result"]) == {"permissions"}
    assert perms_only["result"]["permissions"]["scope"] == "global"

    docs_only = _tool_result(_by_id(responses, 4))
    assert set(docs_only["result"]) == {"agent_docs"}
    assert docs_only["result"]["agent_docs"][0]["project"] == "proj"

    bogus = _tool_result(_by_id(responses, 5))
    assert bogus["ok"] is False


# ─────────────────────────────────────────────────────────────────────────────
# 10. sync — returns the sync report shape
# ─────────────────────────────────────────────────────────────────────────────


def test_sync_returns_report(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(tmp_data_home, [_call("sync", {}, req_id=1)])
    res = _tool_result(_by_id(responses, 1))
    assert res["ok"] is True
    assert isinstance(res["result"], dict)
    assert res["result"].get("schema_version") == 1
    assert "projects" in res["result"]
    assert "global" in res["result"]


# ─────────────────────────────────────────────────────────────────────────────
# 11. hub mcp-control install/uninstall idempotency (in-process)
# ─────────────────────────────────────────────────────────────────────────────


def test_mcp_control_install_uninstall_idempotent(tmp_data_home):
    import hub

    _write_min_registry(tmp_data_home)
    ns = argparse.Namespace(mcp_control_cmd="install")

    hub.cmd_mcp_control_install(ns)
    hub.cmd_mcp_control_install(ns)  # second install is a no-op

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    entry = reg["skills"].get(hub.MCP_CONTROL_SKILL_NAME)
    assert entry is not None
    assert entry["type"] == "mcp-server"
    assert entry["mcp"]["command"] == "python3"
    assert entry["mcp"]["args"][0].endswith("skill_hub_mcp_server.py")
    # Exactly one entry by that name (dict key uniqueness guarantees it).
    assert list(reg["skills"]).count(hub.MCP_CONTROL_SKILL_NAME) == 1

    hub.cmd_mcp_control_uninstall(argparse.Namespace())
    hub.cmd_mcp_control_uninstall(argparse.Namespace())  # idempotent

    reg2 = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert hub.MCP_CONTROL_SKILL_NAME not in reg2.get("skills", {})


# ─────────────────────────────────────────────────────────────────────────────
# 12. skill_candidates — discover then adopt (via skill_import) removes the find
# ─────────────────────────────────────────────────────────────────────────────


def test_skill_candidates_discover_then_adopt(tmp_data_home, tmp_path):
    proj_path = tmp_path / "myproj"
    proj_path.mkdir()
    _write_registry_with_project(tmp_data_home, "myproj", proj_path)
    _author_project_skill(proj_path, "hand-authored")

    # (a) discovery surfaces the NEW candidate.
    responses = _rpc(
        tmp_data_home,
        [
            _call("skill_candidates", {}, req_id=1),
            _call("skill_candidates", {"project": "myproj"}, req_id=2),
        ],
    )

    all_cands = _tool_result(_by_id(responses, 1))
    assert all_cands["ok"] is True
    found = {c["name"]: c for c in all_cands["result"]["candidates"]}
    assert "hand-authored" in found
    assert found["hand-authored"]["category"] == "NEW"
    assert found["hand-authored"]["project"] == "myproj"

    # Filtering by project returns the same find.
    filtered = _tool_result(_by_id(responses, 2))
    assert filtered["ok"] is True
    assert "hand-authored" in {c["name"] for c in filtered["result"]["candidates"]}

    # (b) adopt it via skill_import, then re-discover → no longer a candidate.
    responses2 = _rpc(
        tmp_data_home,
        [
            _call("skill_import", {"skill": "hand-authored", "project": "myproj"}, req_id=1),
            _call("skill_candidates", {}, req_id=2),
        ],
    )

    adopted = _tool_result(_by_id(responses2, 1))
    assert adopted["ok"] is True, adopted

    after = _tool_result(_by_id(responses2, 2))
    assert after["ok"] is True
    assert "hand-authored" not in {c["name"] for c in after["result"]["candidates"]}


# ─────────────────────────────────────────────────────────────────────────────
# 13. snippets — library lifecycle (save → list → show → save version bump → delete)
# ─────────────────────────────────────────────────────────────────────────────


def test_snippet_library_lifecycle(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [
            _call(
                "snippet_save",
                {
                    "name": "use-tywin",
                    "description": "how to use tywin",
                    "tags": ["verify", "cli"],
                    "body": "Run tywin against your commit range.",
                },
                req_id=1,
            ),
            _call("snippet_list", {}, req_id=2),
            _call("snippet_list", {"name": "use-tywin"}, req_id=3),
            _call(
                "snippet_save",
                {"name": "use-tywin", "body": "Use tywin --base <ref>."},
                req_id=4,
            ),
            _call("snippet_delete", {"name": "use-tywin"}, req_id=5),
            _call("snippet_list", {}, req_id=6),
        ],
    )

    created = _tool_result(_by_id(responses, 1))
    assert created["ok"] is True, created
    assert created["result"]["name"] == "use-tywin"
    assert created["result"]["version"] == 1
    assert created["result"]["tags"] == ["verify", "cli"]

    listing = _tool_result(_by_id(responses, 2))
    assert listing["ok"] is True
    names = {s["name"] for s in listing["result"]["snippets"]}
    assert "use-tywin" in names
    entry = next(s for s in listing["result"]["snippets"] if s["name"] == "use-tywin")
    assert entry["usage"]["count"] == 0  # unused

    shown = _tool_result(_by_id(responses, 3))
    assert shown["ok"] is True
    assert shown["result"]["version"] == 1
    assert "tywin" in shown["result"]["body"]

    edited = _tool_result(_by_id(responses, 4))
    assert edited["ok"] is True
    assert edited["result"]["body_changed"] is True
    assert edited["result"]["version"] == 2  # body change bumps the version

    deleted = _tool_result(_by_id(responses, 5))
    assert deleted["ok"] is True
    assert deleted["result"]["deleted"] == "use-tywin"

    after = _tool_result(_by_id(responses, 6))
    assert after["ok"] is True
    assert "use-tywin" not in {s["name"] for s in after["result"]["snippets"]}


def test_snippet_stdin_body_rejected(tmp_data_home):
    """A literal '-' body would make the cmd read stdin (our RPC channel) — reject it."""
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [_call("snippet_save", {"name": "from-stdin", "body": "-"}, req_id=1)],
    )
    res = _tool_result(_by_id(responses, 1))
    assert res["ok"] is False
    assert "stdin" in (res["error"] or "")


# ─────────────────────────────────────────────────────────────────────────────
# 14. snippets — place apply → status → remove against a real project doc
# ─────────────────────────────────────────────────────────────────────────────


def test_snippet_place_apply_status_remove(tmp_data_home, tmp_path):
    proj_path = tmp_path / "myproj"
    proj_path.mkdir()
    _write_registry_with_project(tmp_data_home, "myproj", proj_path)
    doc = proj_path / "AGENTS.md"

    # Batch A: save + apply + status. (_rpc drains the whole batch before
    # returning, so the file is inspected only after these three have run —
    # the remove is deferred to batch B so it can't pre-empt the assertion.)
    # An explicit file avoids depending on machine-detected canonical-root harnesses.
    batch_a = _rpc(
        tmp_data_home,
        [
            _call("snippet_save", {"name": "house-rules", "body": "Always verify."}, req_id=1),
            _call(
                "snippet_place",
                {"op": "apply", "name": "house-rules", "project": "myproj", "file": "AGENTS.md"},
                req_id=2,
            ),
            _call("snippet_list", {"project": "myproj"}, req_id=3),
        ],
    )

    applied = _tool_result(_by_id(batch_a, 2))
    assert applied["ok"] is True, applied
    assert applied["result"]["project"] == "myproj"
    assert doc.is_file()
    assert "house-rules" in doc.read_text()  # marker block landed

    status = _tool_result(_by_id(batch_a, 3))
    assert status["ok"] is True
    locs = status["result"]["locations"]
    assert any(l["snippet"] == "house-rules" for l in locs)

    # Batch B: remove, then confirm the block is gone from disk.
    batch_b = _rpc(
        tmp_data_home,
        [
            _call(
                "snippet_place",
                {"op": "remove", "name": "house-rules", "project": "myproj", "file": "AGENTS.md"},
                req_id=1,
            )
        ],
    )
    removed = _tool_result(_by_id(batch_b, 1))
    assert removed["ok"] is True
    assert "house-rules" not in doc.read_text()  # block excised


def test_snippet_place_apply_requires_project(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [
            _call("snippet_save", {"name": "solo", "body": "x."}, req_id=1),
            _call("snippet_place", {"op": "apply", "name": "solo"}, req_id=2),
        ],
    )
    res = _tool_result(_by_id(responses, 2))
    assert res["ok"] is False
    assert "project" in (res["error"] or "")


def test_snippet_delete_guarded_while_applied(tmp_data_home, tmp_path):
    proj_path = tmp_path / "guarded"
    proj_path.mkdir()
    _write_registry_with_project(tmp_data_home, "guarded", proj_path)

    responses = _rpc(
        tmp_data_home,
        [
            _call("snippet_save", {"name": "pinned", "body": "Pinned rule."}, req_id=1),
            _call(
                "snippet_place",
                {"op": "apply", "name": "pinned", "project": "guarded", "file": "AGENTS.md"},
                req_id=2,
            ),
            # delete without force → refused because still applied
            _call("snippet_delete", {"name": "pinned"}, req_id=3),
            # delete with force → succeeds, in-file block orphaned
            _call("snippet_delete", {"name": "pinned", "force": True}, req_id=4),
        ],
    )

    assert _tool_result(_by_id(responses, 2))["ok"] is True
    guarded = _tool_result(_by_id(responses, 3))
    assert guarded["ok"] is False  # scan-guard blocks the delete
    forced = _tool_result(_by_id(responses, 4))
    assert forced["ok"] is True
    assert forced["result"]["deleted"] == "pinned"
