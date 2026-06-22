"""Tests for skill_hub_mcp_server.py — the control-plane MCP server.

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


# ─────────────────────────────────────────────────────────────────────────────
# 1. initialize + tools/list contract
# ─────────────────────────────────────────────────────────────────────────────

EXPECTED_TOOLS = {
    "skill_create",
    "skill_set_meta",
    "skill_rename",
    "skill_archive",
    "skill_enable",
    "skill_disable",
    "skill_import_project",
    "bundle_new",
    "bundle_update",
    "bundle_delete",
    "bundle_apply",
    "bundle_remove",
    "sync",
    "skill_list",
    "bundle_list",
    "doctor",
    "permissions_show",
    "harness_list",
    "skill_candidates",
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
    assert init["result"]["serverInfo"]["name"] == "skill-hub"

    tools = _by_id(responses, 2)["result"]["tools"]
    names = {t["name"] for t in tools}
    assert names == EXPECTED_TOOLS
    # No permission/harness write tool may be present.
    assert not (names & FORBIDDEN_TOOLS)
    # Every tool declares a JSON-schema input.
    for t in tools:
        assert t["inputSchema"]["type"] == "object"


# ─────────────────────────────────────────────────────────────────────────────
# 2. skill_create then skill_list — new skill shows up
# ─────────────────────────────────────────────────────────────────────────────


def test_skill_create_then_list(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "skill_create", "arguments": {"name": "demo-skill"}},
            },
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "skill_list", "arguments": {}},
            },
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


# ─────────────────────────────────────────────────────────────────────────────
# 3. skill_archive safe-by-default destructive gating
# ─────────────────────────────────────────────────────────────────────────────


def test_skill_archive_safe_by_default(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "skill_create", "arguments": {"name": "doomed"}},
            },
            # No confirm → must be a preview, skill survives.
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "skill_archive", "arguments": {"skill": "doomed"}},
            },
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "skill_list", "arguments": {}},
            },
            # confirm=true → actually archives.
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "skill_archive",
                    "arguments": {"skill": "doomed", "confirm": True},
                },
            },
            {
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {"name": "skill_list", "arguments": {}},
            },
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
            # Enable a skill that does not exist → cmd_enable sys.exit(1).
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "skill_enable",
                    "arguments": {"skill": "nope", "project": "nope-proj"},
                },
            },
            # Server must still answer this.
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "skill_list", "arguments": {}},
            },
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
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "permissions_add", "arguments": {}},
            },
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "harness_list", "arguments": {}},
            },
        ],
    )
    # A forbidden write tool simply does not exist → JSON-RPC method-not-found.
    err = _by_id(responses, 1)
    assert err["error"]["code"] == -32601
    # Server is still alive.
    assert _tool_result(_by_id(responses, 2))["ok"] is True


# ─────────────────────────────────────────────────────────────────────────────
# 5. hub mcp-control install/uninstall idempotency (in-process)
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
# 6. skill_candidates — discover then adopt removes the find
# ─────────────────────────────────────────────────────────────────────────────


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


def test_skill_candidates_discover_then_adopt(tmp_data_home, tmp_path):
    proj_path = tmp_path / "myproj"
    proj_path.mkdir()
    _write_registry_with_project(tmp_data_home, "myproj", proj_path)
    _author_project_skill(proj_path, "hand-authored")

    # (a) discovery surfaces the NEW candidate.
    responses = _rpc(
        tmp_data_home,
        [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "skill_candidates", "arguments": {}},
            },
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "skill_candidates",
                    "arguments": {"project": "myproj"},
                },
            },
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

    # (b) adopt it, then re-discover → no longer a candidate.
    responses2 = _rpc(
        tmp_data_home,
        [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "skill_import_project",
                    "arguments": {"name": "hand-authored", "project": "myproj"},
                },
            },
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "skill_candidates", "arguments": {}},
            },
        ],
    )

    adopted = _tool_result(_by_id(responses2, 1))
    assert adopted["ok"] is True, adopted

    after = _tool_result(_by_id(responses2, 2))
    assert after["ok"] is True
    assert "hand-authored" not in {c["name"] for c in after["result"]["candidates"]}
