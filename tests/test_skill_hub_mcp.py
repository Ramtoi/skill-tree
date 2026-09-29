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
SERVER = REPO_ROOT / "skill_hub/entrypoints/mcp/skill_hub_mcp_server.py"


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
    # WRITE — skills & bundles (9)
    "skill_create",
    "skill_set_meta",
    "skill_archive",
    "skill_import",
    "equip",
    "skill_companions_set",
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

# Wave F — annotations/outputSchema/structuredContent, sorted tools/list.
# plans/F.md §2 "Annotation assignment" table, revision 2 (grill N6).
READ_TOOLS = {
    "project_list",
    "skill_list",
    "bundle_list",
    "snippet_list",
    "skill_candidates",
    "inspect",
}

# N6: skill_import removes the hand-authored folder from the user's repo, so
# it is flagged destructive alongside skill_archive/bundle_delete/snippet_delete.
DESTRUCTIVE_TOOLS = {"skill_archive", "bundle_delete", "snippet_delete", "skill_import"}

# Per-field spec defaults: readOnlyHint false, destructiveHint TRUE,
# idempotentHint false, openWorldHint TRUE — an absent hint is NOT "unknown",
# it is that default. So every non-read tool that isn't genuinely destructive
# sets destructiveHint: False explicitly, and every tool (this server acts
# only on the local registry, a closed domain) sets openWorldHint: False.
EXPECTED_ANNOTATIONS = {
    "project_list": {"readOnlyHint": True, "idempotentHint": True, "openWorldHint": False},
    "skill_list": {"readOnlyHint": True, "idempotentHint": True, "openWorldHint": False},
    "bundle_list": {"readOnlyHint": True, "idempotentHint": True, "openWorldHint": False},
    "snippet_list": {"readOnlyHint": True, "idempotentHint": True, "openWorldHint": False},
    "skill_candidates": {"readOnlyHint": True, "idempotentHint": True, "openWorldHint": False},
    "inspect": {"readOnlyHint": True, "idempotentHint": True, "openWorldHint": False},
    "skill_create": {"destructiveHint": False, "openWorldHint": False},
    "skill_set_meta": {
        "idempotentHint": True,
        "destructiveHint": False,
        "openWorldHint": False,
    },
    "skill_archive": {"destructiveHint": True, "openWorldHint": False},
    "skill_import": {"destructiveHint": True, "openWorldHint": False},
    "equip": {"idempotentHint": True, "destructiveHint": False, "openWorldHint": False},
    "bundle_save": {"idempotentHint": True, "destructiveHint": False, "openWorldHint": False},
    "bundle_delete": {
        "destructiveHint": True,
        "idempotentHint": True,
        "openWorldHint": False,
    },
    "sync": {"idempotentHint": True, "destructiveHint": False, "openWorldHint": False},
    "snippet_save": {
        "idempotentHint": True,
        "destructiveHint": False,
        "openWorldHint": False,
    },
    "snippet_place": {
        "idempotentHint": True,
        "destructiveHint": False,
        "openWorldHint": False,
    },
    "snippet_delete": {
        "destructiveHint": True,
        "idempotentHint": True,
        "openWorldHint": False,
    },
    "skill_companions_set": {
        "idempotentHint": True,
        "destructiveHint": False,
        "openWorldHint": False,
    },
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
    assert len(EXPECTED_TOOLS) == 18
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
    # A skill with no `ships_with` block still reports the companions fields
    # (all empty/false) — `cmd_enable` is always called with json=True now.
    assert on["result"] == {
        "target": "skill",
        "name": "toggle-me",
        "project": "proj",
        "state": "on",
        "already_enabled": False,
        "companions_pending": [],
        "provisioned": {},
    }

    after_on = _tool_result(_by_id(responses, 3))
    row = next(s for s in after_on["result"]["skills"] if s["name"] == "toggle-me")
    assert row["active"] is True

    off = _tool_result(_by_id(responses, 4))
    assert off["ok"] is True
    assert off["result"]["removed_companions"] == {
        "agents": [],
        "hooks": [],
        "permissions": [],
    }

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


# ─────────────────────────────────────────────────────────────────────────────
# 6b. equip — `companions` flag (skill-shipped agents/hooks/permission rules)
# ─────────────────────────────────────────────────────────────────────────────

SHIPS_WITH_SKILL_MD = """\
---
name: ships-skill
description: Ships with a deny permission rule.
ships_with:
  permissions:
    deny: ["Bash(git push --force:*)"]
---

Body.
"""


def _write_registry_with_ships_with_skill(
    home: Path, skill_dir: Path, proj_name: str, proj_path: Path
) -> None:
    """A registry with one `ships_with` skill (a bare permission rule — no
    agents/hooks, so plan_provision needs no harness-probe cache) and one
    project on claude-code (the only harness this fixture "installs")."""
    home.mkdir(parents=True, exist_ok=True)
    (home / "skills").mkdir(exist_ok=True)
    registry = {
        "harnesses_global": ["claude-code"],
        "bootstrap": {"completed_at": "2026-01-01T00:00:00", "version": 1},
        "skills": {
            "ships-skill": {
                "type": "claude-skill",
                "scope": "portable",
                "source": str(skill_dir),
                "description": "Ships with a deny permission rule.",
            }
        },
        "projects": {proj_name: {"path": str(proj_path), "bundles": [], "enabled": []}},
        "bundles": {},
        "permissions_global": {},
    }
    with open(home / "registry.yaml", "w") as f:
        yaml.dump(registry, f, sort_keys=False, allow_unicode=True)


def test_equip_companions_flag_provisions(tmp_data_home, tmp_path, _fake_home):
    # claude-code detection marker, under the same fake $HOME the subprocess
    # inherits (autouse `_fake_home` faked HOME/USERPROFILE for this process;
    # `_server_env` copies `os.environ`, so the subprocess sees it too).
    (_fake_home / ".claude" / "projects").mkdir(parents=True)

    skill_dir = tmp_path / "skill-src" / "ships-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(SHIPS_WITH_SKILL_MD)

    proj_path = tmp_path / "proj"
    proj_path.mkdir()
    _write_registry_with_ships_with_skill(tmp_data_home, skill_dir, "proj", proj_path)

    responses = _rpc(
        tmp_data_home,
        [
            _call(
                "equip",
                {
                    "target": "skill",
                    "name": "ships-skill",
                    "project": "proj",
                    "state": "on",
                    "companions": True,
                },
                req_id=1,
            ),
        ],
    )

    res = _tool_result(_by_id(responses, 1))
    assert res["ok"] is True
    assert res["result"]["companions_pending"] == []
    assert res["result"]["provisioned"]["permissions"] == [
        {"pattern": "Bash(git push --force:*)", "kind": "deny"}
    ]

    reg = _read_registry(tmp_data_home)
    ledger = reg["projects"]["proj"]["companions"]["ships-skill"]
    # A19/C2 (ships-with-2 wave 2): the ledger itself is native v2 — `added`
    # records that this rule was newly attached, not already present.
    assert ledger["permissions"] == [
        {"pattern": "Bash(git push --force:*)", "kind": "deny", "added": True}
    ]


def test_equip_parses_needs_provisioning_from_first_line(tmp_data_home, tmp_path, _fake_home):
    (_fake_home / ".claude" / "projects").mkdir(parents=True)

    skill_dir = tmp_path / "skill-src" / "ships-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(SHIPS_WITH_SKILL_MD)

    proj_path = tmp_path / "proj"
    proj_path.mkdir()
    _write_registry_with_ships_with_skill(tmp_data_home, skill_dir, "proj", proj_path)

    # Neither companions:true nor companions:false — the two-phase gate (A4):
    # cmd_enable prints its exit-2 payload as the FIRST stdout line, then
    # tails auto-sync chatter (more lines follow) — that tail must never
    # corrupt the parse.
    responses = _rpc(
        tmp_data_home,
        [
            _call(
                "equip",
                {
                    "target": "skill",
                    "name": "ships-skill",
                    "project": "proj",
                    "state": "on",
                },
                req_id=1,
            ),
        ],
    )

    res = _tool_result(_by_id(responses, 1))
    assert res["ok"] is False
    assert res["error"] == "needs_provisioning"
    payload = res["result"]["needs_provisioning"]
    assert payload["skill"] == "ships-skill"
    assert payload["project"] == "proj"
    assert payload["companions_pending"] == []
    assert any(item["kind"] == "permission" for item in payload["items"])

    # C3(iii)/A4: the equip itself already landed even though provisioning
    # was gated — the registry has the skill in `enabled`, just no ledger.
    reg = _read_registry(tmp_data_home)
    assert "ships-skill" in reg["projects"]["proj"]["enabled"]
    assert "ships-skill" not in (reg["projects"]["proj"].get("companions") or {})


# ─────────────────────────────────────────────────────────────────────────────
# 6c. skill_companions_set — I6/D10 whole-block replace
# ─────────────────────────────────────────────────────────────────────────────


def test_skill_companions_set_tool(tmp_data_home, tmp_path, _fake_home):
    (_fake_home / ".claude" / "projects").mkdir(parents=True)

    skill_dir = tmp_path / "skill-src" / "ships-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(SHIPS_WITH_SKILL_MD)

    proj_path = tmp_path / "proj"
    proj_path.mkdir()
    _write_registry_with_ships_with_skill(tmp_data_home, skill_dir, "proj", proj_path)
    # Activate the skill on the project directly (no equip round-trip needed
    # here) so the reconcile pass actually walks that scope.
    reg = _read_registry(tmp_data_home)
    reg["projects"]["proj"]["enabled"] = ["ships-skill"]
    with open(tmp_data_home / "registry.yaml", "w") as f:
        yaml.dump(reg, f, sort_keys=False, allow_unicode=True)

    new_block = {
        "agents": [],
        "hooks": [],
        "permissions": {
            "allow": [],
            "deny": ["Bash(git push --force:*)", "Bash(rm -rf:*)"],
            "ask": [],
        },
    }
    responses = _rpc(
        tmp_data_home,
        [
            _call(
                "skill_companions_set",
                {"skill": "ships-skill", "block": new_block},
                req_id=1,
            ),
        ],
    )

    res = _tool_result(_by_id(responses, 1))
    assert res["ok"] is True
    result = res["result"]
    assert result["ok"] is True
    assert result["skill"] == "ships-skill"
    assert result["block"]["permissions"]["deny"] == [
        "Bash(git push --force:*)",
        "Bash(rm -rf:*)",
    ]
    assert result["kept_files"] == []
    # I7 reconcile record: the skill has no ledger entry on "proj" yet, so
    # its companions are reported pending (never auto-written by `set`
    # itself — only `hub sync`/`hub enable --with-companions` write), for
    # every scope that walked the skill. R27: `pending` is one vocabulary —
    # companion names (here the two deny patterns), never the bare skill name.
    reconcile = result["reconcile"]
    assert "global" in reconcile
    assert "proj" in reconcile["projects"]
    pending = reconcile["projects"]["proj"]["pending"]
    assert "Bash(git push --force:*)" in pending
    assert "Bash(rm -rf:*)" in pending
    assert "ships-skill" not in pending

    # The rewrite actually landed on disk.
    md_text = (skill_dir / "SKILL.md").read_text()
    assert "Bash(rm -rf:*)" in md_text

    # The registry mirror picked up the new block too.
    reg = _read_registry(tmp_data_home)
    assert reg["skills"]["ships-skill"]["ships_with"]["permissions"]["deny"] == [
        "Bash(git push --force:*)",
        "Bash(rm -rf:*)",
    ]

    # Refuses a source-managed skill (D10 step 1) with the {ok:false, error,
    # field} validation shape — never writes anything.
    reg["skills"]["managed-skill"] = {
        "type": "claude-skill",
        "scope": "portable",
        "managed": "external",
        "origin": {"source": "org-skills"},
        "description": "An externally-managed skill.",
    }
    with open(tmp_data_home / "registry.yaml", "w") as f:
        yaml.dump(reg, f, sort_keys=False, allow_unicode=True)

    refused = _rpc(
        tmp_data_home,
        [
            _call(
                "skill_companions_set",
                {
                    "skill": "managed-skill",
                    "block": {"agents": [], "hooks": [], "permissions": {}},
                },
                req_id=2,
            ),
        ],
    )
    refused_res = _tool_result(_by_id(refused, 2))
    assert refused_res["ok"] is False
    assert refused_res["result"]["ok"] is False
    assert refused_res["result"]["field"] == "skill"
    assert "external" in refused_res["result"]["error"]

    # Refused before any write — the registry entry is byte-untouched.
    reg3 = _read_registry(tmp_data_home)
    assert "ships_with" not in reg3["skills"]["managed-skill"]


def test_skill_companions_set_requires_skill_and_block(tmp_data_home):
    _write_min_registry(tmp_data_home)
    responses = _rpc(
        tmp_data_home,
        [
            _call("skill_companions_set", {"block": {}}, req_id=1),
            _call("skill_companions_set", {"skill": "demo"}, req_id=2),
        ],
    )
    missing_skill = _tool_result(_by_id(responses, 1))
    assert missing_skill["ok"] is False
    assert "skill" in missing_skill["error"]

    missing_block = _tool_result(_by_id(responses, 2))
    assert missing_block["ok"] is False
    assert "block" in missing_block["error"]


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
    assert entry["mcp"]["command"] == sys.executable
    assert entry["mcp"]["args"][0].endswith("skill_hub/entrypoints/mcp/skill_hub_mcp_server.py")
    # Exactly one entry by that name (dict key uniqueness guarantees it).
    assert list(reg["skills"]).count(hub.MCP_CONTROL_SKILL_NAME) == 1

    hub.cmd_mcp_control_uninstall(argparse.Namespace())
    hub.cmd_mcp_control_uninstall(argparse.Namespace())  # idempotent

    reg2 = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert hub.MCP_CONTROL_SKILL_NAME not in reg2.get("skills", {})
    assert reg2["control_plane_mcp"]["opted_out"] is True


def test_control_setup_migrates_owned_legacy_registration(tmp_data_home):
    from skill_hub.entrypoints.cli import mcp_control

    _write_min_registry(tmp_data_home)
    registry = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    registry["skills"][mcp_control.LEGACY_MCP_CONTROL_SKILL_NAME] = {
        "type": "mcp-server",
        "scope": "global",
        "mcp": {
            "command": "python3",
            "args": ["/old/app/skill_hub/entrypoints/mcp/skill_hub_mcp_server.py"],
            "env": {"SKILL_HUB_ACTOR": "skill-hub-mcp"},
        },
    }

    result = mcp_control.ensure_control_plane_setup(registry, selected_harnesses=["claude-code"])

    assert result["server"] == "migrated"
    assert mcp_control.LEGACY_MCP_CONTROL_SKILL_NAME not in registry["skills"]
    entry = registry["skills"][mcp_control.MCP_CONTROL_SKILL_NAME]
    assert entry["mcp"]["command"] == sys.executable
    assert entry["mcp"]["args"][0].endswith("skill_hub/entrypoints/mcp/skill_hub_mcp_server.py")
    assert entry["scope"] == "global"


def test_control_setup_preserves_user_collision(tmp_data_home):
    from skill_hub.entrypoints.cli import mcp_control

    _write_min_registry(tmp_data_home)
    registry = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    custom = {"type": "mcp-server", "scope": "global", "mcp": {"command": "node", "args": ["custom.js"]}}
    registry["skills"][mcp_control.MCP_CONTROL_SKILL_NAME] = custom

    result = mcp_control.ensure_control_plane_setup(registry)

    assert result["server"] == "collision"
    assert result["changed"] is False
    assert registry["skills"][mcp_control.MCP_CONTROL_SKILL_NAME] == custom


def test_control_setup_promotes_only_managed_companion(tmp_data_home, tmp_path, monkeypatch):
    from skill_hub.application.skills import starter_skills
    from skill_hub.entrypoints.cli import mcp_control

    pack = tmp_path / "pack"
    skill = pack / "skt-mcp"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: skt-mcp\ndescription: Control Skill Tree.\n---\n\n# Skill Tree\n"
    )
    monkeypatch.setenv(starter_skills.STARTER_ROOT_ENV, str(pack))
    _write_min_registry(tmp_data_home)
    registry = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())

    result = mcp_control.ensure_control_plane_setup(registry, selected_harnesses=["codex"])

    assert result["companion"] == "provisioned"
    companion = registry["skills"]["skt-mcp"]
    assert companion["managed"] == "starter"
    assert companion["scope"] == "global"
    assert companion["harnesses"] == ["codex"]

    custom_registry = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    custom_registry["skills"]["skt-mcp"] = {"type": "claude-skill", "scope": "portable", "source": "/mine"}
    result = mcp_control.ensure_control_plane_setup(custom_registry, selected_harnesses=["codex"])
    assert result["companion"] == "collision"
    assert custom_registry["skills"]["skt-mcp"]["scope"] == "portable"


# ─── TA-1-e64c: argv-layer smoke case, so a removed/broken parser reds here ──
#
# `mcp-control` has no `--json` flag (unlike the other four slices in this
# finding); its "status" verb prints plain text, so this pins exit code and a
# stable text fragment rather than a payload key.


def test_mcp_control_status_reached_through_hub_main_argv(tmp_data_home, monkeypatch, capsys):
    """`hub mcp-control status` must be reachable through the real argparse
    dispatch table, not only through a hand-built Namespace."""
    import hub

    _write_min_registry(tmp_data_home)
    monkeypatch.setattr(sys, "argv", ["hub", "mcp-control", "status"])
    code = 0
    try:
        hub.main()
    except SystemExit as exc:
        code = exc.code
    out = capsys.readouterr().out
    assert code == 0
    assert "registered:" in out


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


# ─────────────────────────────────────────────────────────────────────────────
# Wave F — tool annotations, outputSchema, structuredContent, sorted tools/list
#
# These drive skill_hub_mcp_server's handlers directly, in-process (no
# subprocess, no network, no $HOME access — `_fake_home` in conftest.py is
# autouse regardless). plans/F.md §5.
# ─────────────────────────────────────────────────────────────────────────────


def test_tools_list_is_sorted():
    from skill_hub.entrypoints.mcp import skill_hub_mcp_server as mcp

    resp = mcp.handle_tools_list(1)
    names = [t["name"] for t in resp["result"]["tools"]]
    assert names == sorted(names)


def test_expected_tools_unchanged():
    from skill_hub.entrypoints.mcp import skill_hub_mcp_server as mcp

    resp = mcp.handle_tools_list(1)
    names = {t["name"] for t in resp["result"]["tools"]}
    assert names == EXPECTED_TOOLS
    assert len(EXPECTED_TOOLS) == 18


def test_every_tool_carries_an_output_schema():
    from skill_hub.entrypoints.mcp import skill_hub_mcp_server as mcp

    resp = mcp.handle_tools_list(1)
    tools = resp["result"]["tools"]
    assert len(tools) == 18
    for t in tools:
        assert t["outputSchema"] == mcp.TOOL_OUTPUT_SCHEMA


def test_annotations_match_the_table():
    from skill_hub.entrypoints.mcp import skill_hub_mcp_server as mcp

    resp = mcp.handle_tools_list(1)
    by_name = {t["name"]: t["annotations"] for t in resp["result"]["tools"]}
    assert by_name == EXPECTED_ANNOTATIONS
    # Negative: every tool sets openWorldHint: False (this server acts only on
    # the local registry, a closed domain — the spec's documented default for
    # this hint is TRUE, so it must be set explicitly); no tool sets `title`
    # (the tool names are already the display names).
    for ann in by_name.values():
        assert ann.get("openWorldHint") is False
        assert "title" not in ann


def test_read_tools_are_read_only():
    from skill_hub.entrypoints.mcp import skill_hub_mcp_server as mcp

    resp = mcp.handle_tools_list(1)
    by_name = {t["name"]: t["annotations"] for t in resp["result"]["tools"]}
    for name in READ_TOOLS:
        assert by_name[name].get("readOnlyHint") is True
        assert "destructiveHint" not in by_name[name]


def test_destructive_tools_are_flagged():
    from skill_hub.entrypoints.mcp import skill_hub_mcp_server as mcp

    resp = mcp.handle_tools_list(1)
    by_name = {t["name"]: t["annotations"] for t in resp["result"]["tools"]}
    flagged = {n for n, a in by_name.items() if a.get("destructiveHint") is True}
    assert flagged == DESTRUCTIVE_TOOLS


def test_no_read_tool_is_destructive():
    # Cross-check against 5/6, read from the server (not the two literal sets
    # alone) so this fails if the feature itself is reverted.
    from skill_hub.entrypoints.mcp import skill_hub_mcp_server as mcp

    by_name = {
        t["name"]: t["annotations"] for t in mcp.handle_tools_list(1)["result"]["tools"]
    }
    read = {n for n, a in by_name.items() if a.get("readOnlyHint") is True}
    destructive = {n for n, a in by_name.items() if a.get("destructiveHint") is True}
    assert read == READ_TOOLS
    assert read.isdisjoint(destructive)


def test_tools_call_returns_structured_content(tmp_data_home):
    from skill_hub.entrypoints.mcp import skill_hub_mcp_server as mcp

    _write_min_registry(tmp_data_home)
    resp = mcp.handle_tools_call(1, {"name": "bundle_list", "arguments": {}})
    result = resp["result"]
    text_payload = json.loads(result["content"][0]["text"])
    assert result["structuredContent"] == text_payload
    assert text_payload["ok"] is True


def test_tools_call_error_path_is_structured_too(tmp_data_home, monkeypatch):
    from skill_hub.entrypoints.mcp import skill_hub_mcp_server as mcp

    _write_min_registry(tmp_data_home)

    def _boom(_args):
        raise RuntimeError("boom")

    orig = mcp.TOOLS["sync"]
    monkeypatch.setitem(mcp.TOOLS, "sync", (_boom, *orig[1:]))

    resp = mcp.handle_tools_call(1, {"name": "sync", "arguments": {}})
    result = resp["result"]
    text_payload = json.loads(result["content"][0]["text"])
    assert result["structuredContent"] == text_payload
    assert text_payload["ok"] is False
    assert text_payload["error"]


def test_text_block_bytes_are_unchanged(tmp_data_home):
    from skill_hub.entrypoints.mcp import skill_hub_mcp_server as mcp

    _write_min_registry(tmp_data_home)
    resp = mcp.handle_tools_call(1, {"name": "bundle_list", "arguments": {}})
    text = resp["result"]["content"][0]["text"]
    structured = resp["result"]["structuredContent"]
    # Pins that nobody "improved" the serializer (indent, sorted keys, ...)
    # while adding the structured twin.
    assert text == json.dumps(structured)


def test_three_tuple_entry_does_not_crash_tools_list(monkeypatch):
    from skill_hub.entrypoints.mcp import skill_hub_mcp_server as mcp

    orig = mcp.TOOLS["sync"]
    monkeypatch.setitem(mcp.TOOLS, "sync", orig[:3])

    resp = mcp.handle_tools_list(1)
    tools = {t["name"]: t for t in resp["result"]["tools"]}
    assert len(tools) == 18
    assert "annotations" not in tools["sync"]
    assert tools["sync"]["outputSchema"] == mcp.TOOL_OUTPUT_SCHEMA


def test_scaffold_template_declares_annotations_and_structured_content():
    from skill_hub.entrypoints.cli.skill import MCP_SERVER_TEMPLATE

    assert "outputSchema" in MCP_SERVER_TEMPLATE
    assert "structuredContent" in MCP_SERVER_TEMPLATE
    assert "annotations" in MCP_SERVER_TEMPLATE
    assert "sorted(TOOLS.items())" in MCP_SERVER_TEMPLATE
    # A string check, not an execution — but the rendered template must still
    # be syntactically valid Python (catches a broken f-string or brace).
    compile(MCP_SERVER_TEMPLATE.format(name="demo"), "<mcp-server-template>", "exec")


def test_scaffold_template_protocol_matches_the_control_plane():
    from skill_hub.entrypoints.cli.skill import MCP_SERVER_TEMPLATE
    from skill_hub.entrypoints.mcp.skill_hub_mcp_server import PROTOCOL_VERSION

    assert f'"{PROTOCOL_VERSION}"' in MCP_SERVER_TEMPLATE


def test_skill_import_is_flagged_destructive():
    """(N6) skill_import removes the folder from the user's repo — destructive."""
    from skill_hub.entrypoints.mcp import skill_hub_mcp_server as mcp

    resp = mcp.handle_tools_list(1)
    by_name = {t["name"]: t["annotations"] for t in resp["result"]["tools"]}
    assert by_name["skill_import"].get("destructiveHint") is True
    assert DESTRUCTIVE_TOOLS == {
        "skill_archive",
        "bundle_delete",
        "snippet_delete",
        "skill_import",
    }


def test_inspect_keeps_one_native_snapshot_when_detection_changes(tmp_data_home, tmp_path, monkeypatch):
    from skill_hub.application.harnesses import harness_runtime
    from skill_hub.entrypoints.mcp import skill_hub_mcp_server as server
    from skill_hub.infrastructure.harnesses import harnesses

    project = tmp_path / "project"
    project.mkdir()
    (project / "CLAUDE.md").write_text("# Fixture instructions\n")
    registry = {
        "harnesses_global": ["claude-code"],
        "permissions_global": {"allow": ["Bash(*)"]},
        "projects": {"fixture": {"path": str(project), "harnesses": []}},
    }
    monkeypatch.setattr(server, "_load_registry_or_error", lambda: (registry, None))
    detections = []

    def detect():
        detections.append(True)
        return {"claude-code"} if len(detections) == 1 else set()

    monkeypatch.setattr(harnesses, "detect_installed", detect)
    monkeypatch.setattr(harness_runtime, "inventory", lambda *args: pytest.fail("inspect probed runtime"))
    response = server.tool_inspect({"section": "all"})
    assert response["ok"], response
    result = response["result"]
    assert next(row for row in result["harnesses"] if row["id"] == "claude-code")["installed"]
    assert any(row["code"] == "UNBOUNDED_BASH" for row in result["risks"]["findings"])
    assert result["agent_docs"][0]["state"] == "ok"
    assert len(detections) == 1


def test_inspect_permissions_only_does_not_detect_harnesses(tmp_data_home, monkeypatch):
    from skill_hub.entrypoints.mcp import skill_hub_mcp_server as server
    from skill_hub.infrastructure.harnesses import harnesses

    monkeypatch.setattr(server, "_load_registry_or_error", lambda: ({}, None))
    monkeypatch.setattr(harnesses, "detect_installed", lambda: pytest.fail("unneeded detection"))
    assert server.tool_inspect({"section": "permissions"})["ok"]


def test_inspect_unavailable_routes_preserve_risk_findings_without_fallback(tmp_data_home, monkeypatch):
    from dataclasses import replace

    from skill_hub.application.harnesses import harness_operation_context as contexts
    from skill_hub.entrypoints.mcp import skill_hub_mcp_server as server
    from skill_hub.infrastructure.permissions import permission_adapters

    context = contexts.build_operation_context(
        tmp_data_home, ("claude-code",), requested_features=("permissions", "agent_docs"),
        installed_harness_ids=("claude-code",),
    )
    context = replace(context, routes={})
    monkeypatch.setattr(permission_adapters, "get_adapter", lambda *args: pytest.fail("legacy fallback"))
    result = server._risk_findings(
        {"permissions_global": {"allow": ["Bash(*)"]}}, context=context,
    )
    assert [row["code"] for row in result["findings"]] == ["UNBOUNDED_BASH"]


def test_inspect_documents_respect_configured_participation(tmp_data_home, tmp_path, monkeypatch):
    from skill_hub.entrypoints.mcp import skill_hub_mcp_server as server
    from skill_hub.infrastructure.harnesses import harnesses

    project = tmp_path / "project"
    project.mkdir()
    (project / "CLAUDE.md").write_text("# Foreign instructions\n")
    registry = {"projects": {"fixture": {"path": str(project), "harnesses": []}}}
    monkeypatch.setattr(server, "_load_registry_or_error", lambda: (registry, None))
    monkeypatch.setattr(harnesses, "detect_installed", lambda: {"claude-code"})
    response = server.tool_inspect({"section": "agent_docs"})
    assert response["ok"], response
    assert response["result"]["agent_docs"][0]["state"] == "none"
    assert (project / "CLAUDE.md").read_text() == "# Foreign instructions\n"


def test_control_setup_keeps_metadata_and_affinity_on_repeat(tmp_data_home):
    from copy import deepcopy

    from skill_hub.entrypoints.cli import mcp_control

    registry = {"skills": {}, "projects": {}, "bundles": {}}
    mcp_control.ensure_control_plane_setup(registry, selected_harnesses=["codex"])
    entry = registry["skills"]["skill-tree"]
    entry["description"] = "My control server"
    entry["mcp"]["timeout_ms"] = 12000
    before = deepcopy(registry)
    mcp_control.ensure_control_plane_setup(registry, selected_harnesses=["codex"])
    assert registry == before


def test_bootstrap_preserves_control_optout(tmp_data_home, monkeypatch):
    import hub
    from skill_hub.entrypoints.cli import bootstrap, mcp_control

    _write_min_registry(tmp_data_home)
    hub.cmd_mcp_control_uninstall(argparse.Namespace())
    monkeypatch.setattr(hub, "cmd_sync", lambda *a, **k: None)
    monkeypatch.setattr(bootstrap, "_bootstrap_global_permissions_adopt", lambda *a: None)
    hub.cmd_bootstrap(argparse.Namespace(force=True, yes=True, dry_run=False,
                                        json=False, skip_migrate=True, plan_stdin=False))
    registry = hub.load_registry()
    assert mcp_control._setup_opted_out(registry)
    assert "skill-tree" not in registry["skills"]
