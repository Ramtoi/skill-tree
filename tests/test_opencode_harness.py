"""opencode harness: MCP adapter, permission adapter, and agent-docs policy.

Covers the `opencode-harness` capability — the opencode.json `mcp` shape, the
`permission.bash` last-match-wins translation, merge-preservation, sidecar
tracking, cleanup, discovery round-trip, and AGENTS.md canonical-root behaviour.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import agent_docs
import mcp_adapters
import permission_adapters as pa
from mcp_adapters import McpServerSpec, OpenCodeMcpAdapter
from permissions import (
    GlobalScope,
    Hook,
    NormalizedPermissions,
    PermissionFeature,
    ProjectScope,
    Rule,
    read_sidecar,
)


@pytest.fixture(autouse=True)
def _reset_backup_state():
    pa._reset_backup_session_state_for_tests()
    yield
    pa._reset_backup_session_state_for_tests()


# ─────────────────────────────────────────────────────────────────────────────
# MCP adapter — opencode.json `mcp`
# ─────────────────────────────────────────────────────────────────────────────


def test_mcp_entry_uses_opencode_shape(tmp_path):
    adapter = OpenCodeMcpAdapter()
    proj = tmp_path / "proj"
    proj.mkdir()
    spec = McpServerSpec(name="foo", command="npx", args=["-y", "foo-mcp"], env={"TOKEN": "x"})
    assert adapter.write(proj, [spec]) is True

    doc = json.loads((proj / "opencode.json").read_text())
    assert doc["mcp"]["foo"] == {
        "type": "local",
        "command": ["npx", "-y", "foo-mcp"],
        "enabled": True,
        "environment": {"TOKEN": "x"},
    }


def test_mcp_entry_omits_empty_environment(tmp_path):
    adapter = OpenCodeMcpAdapter()
    proj = tmp_path / "proj"
    proj.mkdir()
    adapter.write(proj, [McpServerSpec(name="bare", command="server", args=[], env={})])
    entry = json.loads((proj / "opencode.json").read_text())["mcp"]["bare"]
    assert "environment" not in entry
    assert entry == {"type": "local", "command": ["server"], "enabled": True}


def test_mcp_preserves_unrelated_config(tmp_path):
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "opencode.json").write_text(json.dumps({
        "model": "anthropic/claude-sonnet-4-5",
        "permission": {"edit": "deny"},
        "mcp": {"bar": {"type": "local", "command": ["x"]}},
    }))
    OpenCodeMcpAdapter().write(proj, [McpServerSpec(name="foo", command="npx", args=[], env={})])

    doc = json.loads((proj / "opencode.json").read_text())
    assert doc["model"] == "anthropic/claude-sonnet-4-5"
    assert doc["permission"] == {"edit": "deny"}
    assert doc["mcp"]["bar"] == {"type": "local", "command": ["x"]}
    assert "foo" in doc["mcp"]


def test_mcp_malformed_json_is_skipped_not_rewritten(tmp_path, capsys):
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "opencode.json").write_text("{ not json")
    assert OpenCodeMcpAdapter().write(proj, [McpServerSpec(name="foo", command="x")]) is False
    # File left byte-identical — never rewritten.
    assert (proj / "opencode.json").read_text() == "{ not json"
    assert "skipping opencode MCP" in capsys.readouterr().err


def test_mcp_remove_targets_only_named_keys(tmp_path):
    proj = tmp_path / "proj"
    proj.mkdir()
    adapter = OpenCodeMcpAdapter()
    adapter.write(proj, [
        McpServerSpec(name="foo", command="a"),
        McpServerSpec(name="baz", command="b"),
    ])
    assert adapter.remove(proj, {"foo"}) is True
    doc = json.loads((proj / "opencode.json").read_text())
    assert "foo" not in doc["mcp"]
    assert "baz" in doc["mcp"]


def test_mcp_dispatch_distinct_from_claude_and_codex():
    """opencode's MCP adapter is keyed separately so its write is independent."""
    assert mcp_adapters.get_adapter("opencode") is not None
    assert mcp_adapters.get_adapter("opencode") is not mcp_adapters.get_adapter("claude")
    assert mcp_adapters.get_adapter("opencode") is not mcp_adapters.get_adapter("codex")


# ─────────────────────────────────────────────────────────────────────────────
# Permission adapter — opencode.json `permission.bash`
# ─────────────────────────────────────────────────────────────────────────────


def _proj_scope(tmp_path: Path) -> ProjectScope:
    return ProjectScope(name="alpha", path=str(tmp_path))


def _apply(adapter, perms, scope, harness="opencode"):
    result = adapter.translate(perms, scope, harness)
    for w in result.writes:
        adapter.apply(scope, w, harness)
    return result


def test_bash_allow_rule_becomes_prefix(tmp_data_home, tmp_path):
    adapter = pa.OpenCodePermissionAdapter()
    scope = _proj_scope(tmp_path)
    _apply(adapter, NormalizedPermissions(allow=[Rule("Bash(npm:*)", "allow")]), scope)
    doc = json.loads((tmp_path / "opencode.json").read_text())
    assert doc["permission"]["bash"] == {"npm *": "allow"}


def test_multiword_and_kind_mapping_with_last_match_ordering(tmp_data_home, tmp_path):
    adapter = pa.OpenCodePermissionAdapter()
    scope = _proj_scope(tmp_path)
    perms = NormalizedPermissions(
        allow=[Rule("Bash(git:*)", "allow")],
        deny=[Rule("Bash(git push:*)", "deny")],
        ask=[Rule("Bash(rm:*)", "ask")],
    )
    _apply(adapter, perms, scope)
    bash = json.loads((tmp_path / "opencode.json").read_text())["permission"]["bash"]
    assert bash["git *"] == "allow"
    assert bash["git push *"] == "deny"
    assert bash["rm *"] == "ask"
    # Most-specific LAST: "git push *" must come after "git *" (last-match-wins).
    keys = list(bash.keys())
    assert keys.index("git *") < keys.index("git push *")


def test_global_scope_targets_config_home(tmp_data_home, tmp_path, monkeypatch):
    # Redirect HOME so the global path lands in the tmp tree.
    monkeypatch.setenv("HOME", str(tmp_path))
    adapter = pa.OpenCodePermissionAdapter()
    target = adapter.target_files(GlobalScope(), "opencode")
    assert target == tmp_path / ".config" / "opencode" / "opencode.json"


def test_hooks_and_non_bash_and_unbounded_are_skipped(tmp_data_home, tmp_path):
    adapter = pa.OpenCodePermissionAdapter()
    scope = _proj_scope(tmp_path)
    perms = NormalizedPermissions(
        allow=[Rule("Read(*)", "allow"), Rule("Bash(*)", "allow")],
        hooks=[Hook("PreToolUse", "Bash", "echo hi")],
    )
    result = adapter.translate(perms, scope, "opencode")
    features = {s.feature for s in result.skipped}
    assert PermissionFeature.HOOKS.value in features
    # Read(*) and Bash(*) both skipped → nothing translatable was written.
    bash = result.writes[0].payload["bash"]
    assert bash == {}
    skipped_patterns = {s.rule_pattern for s in result.skipped}
    assert "Read(*)" in skipped_patterns
    assert "Bash(*)" in skipped_patterns


def test_capabilities_exclude_hooks(tmp_path):
    caps = pa.OpenCodePermissionAdapter().capabilities()
    assert caps == {
        PermissionFeature.TOOL_ALLOWLIST,
        PermissionFeature.TOOL_DENYLIST,
        PermissionFeature.TOOL_ASK,
    }
    assert PermissionFeature.HOOKS not in caps


def test_permission_preserves_user_keys_and_tracks_sidecar(tmp_data_home, tmp_path):
    (tmp_path / "opencode.json").write_text(json.dumps({
        "model": "anthropic/claude-sonnet-4-5",
        "mcp": {"foo": {"type": "local", "command": ["x"]}},
        "permission": {"edit": "deny"},
    }))
    adapter = pa.OpenCodePermissionAdapter()
    scope = _proj_scope(tmp_path)
    _apply(adapter, NormalizedPermissions(allow=[Rule("Bash(npm:*)", "allow")]), scope)

    doc = json.loads((tmp_path / "opencode.json").read_text())
    assert doc["model"] == "anthropic/claude-sonnet-4-5"
    assert doc["mcp"]["foo"] == {"type": "local", "command": ["x"]}
    assert doc["permission"]["edit"] == "deny"          # user key preserved
    assert doc["permission"]["bash"] == {"npm *": "allow"}

    sc = read_sidecar("opencode", scope)
    assert sc is not None
    assert sc.managed_keys == ["permission.bash.npm *"]


def test_cleanup_removes_only_managed_keys(tmp_data_home, tmp_path):
    (tmp_path / "opencode.json").write_text(json.dumps({
        "permission": {"edit": "deny", "bash": {"yarn *": "allow"}},  # user-authored
    }))
    adapter = pa.OpenCodePermissionAdapter()
    scope = _proj_scope(tmp_path)
    _apply(adapter, NormalizedPermissions(allow=[Rule("Bash(npm:*)", "allow")]), scope)
    # Both present now.
    bash = json.loads((tmp_path / "opencode.json").read_text())["permission"]["bash"]
    assert bash == {"yarn *": "allow", "npm *": "allow"}

    assert adapter.cleanup(scope, "opencode") is True
    doc = json.loads((tmp_path / "opencode.json").read_text())
    # Hub-managed npm gone; user yarn + edit survive.
    assert doc["permission"]["bash"] == {"yarn *": "allow"}
    assert doc["permission"]["edit"] == "deny"
    assert read_sidecar("opencode", scope) is None


def test_resync_is_byte_identical(tmp_data_home, tmp_path):
    adapter = pa.OpenCodePermissionAdapter()
    scope = _proj_scope(tmp_path)
    perms = NormalizedPermissions(
        allow=[Rule("Bash(git:*)", "allow"), Rule("Bash(npm:*)", "allow")],
        deny=[Rule("Bash(git push:*)", "deny")],
    )
    _apply(adapter, perms, scope)
    first = (tmp_path / "opencode.json").read_text()
    _apply(adapter, perms, scope)  # re-sync with the same registry state
    assert (tmp_path / "opencode.json").read_text() == first


def test_no_file_created_when_nothing_translatable(tmp_data_home, tmp_path):
    adapter = pa.OpenCodePermissionAdapter()
    scope = _proj_scope(tmp_path)
    _apply(adapter, NormalizedPermissions(allow=[Rule("Bash(*)", "allow")]), scope)
    assert not (tmp_path / "opencode.json").exists()


def test_bare_string_bash_default_is_promoted(tmp_data_home, tmp_path):
    (tmp_path / "opencode.json").write_text(json.dumps({"permission": {"bash": "ask"}}))
    adapter = pa.OpenCodePermissionAdapter()
    scope = _proj_scope(tmp_path)
    _apply(adapter, NormalizedPermissions(allow=[Rule("Bash(npm:*)", "allow")]), scope)
    bash = json.loads((tmp_path / "opencode.json").read_text())["permission"]["bash"]
    assert bash == {"*": "ask", "npm *": "allow"}  # user default preserved under "*"


def test_discover_existing_round_trips(tmp_data_home, tmp_path):
    (tmp_path / "opencode.json").write_text(json.dumps({
        "permission": {"bash": {"npm *": "allow", "rm *": "ask", "git push *": "deny", "*": "ask"}}
    }))
    adapter = pa.OpenCodePermissionAdapter()
    scope = _proj_scope(tmp_path)
    disc = adapter.discover_existing(scope, "opencode")
    assert sorted(r.pattern for r in disc.allow) == ["Bash(npm:*)"]
    assert sorted(r.pattern for r in disc.ask) == ["Bash(rm:*)"]
    assert sorted(r.pattern for r in disc.deny) == ["Bash(git push:*)"]
    # The unbounded "*" default is not represented as a discrete rule.
    all_patterns = [r.pattern for r in disc.allow + disc.ask + disc.deny]
    assert all("Bash(:*)" not in p for p in all_patterns)


# ─────────────────────────────────────────────────────────────────────────────
# Agent-docs canonical root — opencode is an AGENTS.md harness
# ─────────────────────────────────────────────────────────────────────────────


def test_opencode_only_canonicalizes_to_agents():
    proj = {"path": "/x", "harnesses": ["opencode"]}
    res = agent_docs.resolve_canonical_root(proj, {}, installed={"opencode"})
    assert res == {"canonical": "AGENTS.md", "derived": None}
    assert agent_docs.required_root_files({"opencode"}) == {"AGENTS.md"}


def test_opencode_plus_claude_requires_agents_and_derived_claude():
    proj = {"path": "/x", "harnesses": ["claude-code", "opencode"]}
    res = agent_docs.resolve_canonical_root(
        proj, {}, installed={"claude-code", "opencode"}
    )
    assert res == {"canonical": "AGENTS.md", "derived": "CLAUDE.md"}
