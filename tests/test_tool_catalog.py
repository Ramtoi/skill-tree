"""Tests for tool_catalog.py — matcher translation + per-event support catalog."""

from __future__ import annotations

import json
from pathlib import Path

import tool_catalog as tc

CORPUS = json.loads(
    (Path(__file__).parent / "fixtures" / "hook_catalog_corpus.json").read_text()
)


# ─────────────────────────────────────────────────────────────────────────────
# Matcher translation
# ─────────────────────────────────────────────────────────────────────────────


def test_edit_family_collapses_to_apply_patch_on_codex():
    assert tc.translate_tools(["Edit", "Write", "MultiEdit"], "codex") == "apply_patch"


def test_edit_family_passthrough_on_claude():
    assert (
        tc.translate_tools(["Edit", "Write", "MultiEdit"], "claude-code")
        == "Edit|Write|MultiEdit"
    )


def test_all_tools_dropped_returns_none():
    # Read has no codex mapping and is not in codex's canonical tool set → dropped.
    assert tc.translate_tools(["Read"], "codex") is None


def test_partial_drop_keeps_supported_tools():
    # Read drops; Bash survives on codex.
    assert tc.translate_tools(["Read", "Bash"], "codex") == "Bash"


def test_empty_list_is_empty_matcher_not_none():
    assert tc.translate_tools([], "codex") == ""
    assert tc.translate_tools([], "claude-code") == ""


def test_mixed_edit_and_bash_on_codex():
    assert tc.translate_tools(["Edit", "Bash"], "codex") == "apply_patch|Bash"


def test_mcp_token_passes_through_on_every_harness():
    assert tc.translate_tools(["mcp__memory"], "codex") == "mcp__memory"
    assert tc.translate_tools(["mcp__memory"], "claude-code") == "mcp__memory"


def test_unknown_harness_passes_everything_through():
    assert tc.translate_tools(["Read", "Bash"], "some-future-harness") == "Read|Bash"


def test_claude_passthrough_preserves_order_and_dedupes():
    assert tc.translate_tools(["Bash", "Read", "Bash"], "claude-code") == "Bash|Read"


# ─────────────────────────────────────────────────────────────────────────────
# Event support catalog
# ─────────────────────────────────────────────────────────────────────────────


def test_posttooluse_supported_on_both():
    assert tc.event_supported("PostToolUse", "claude-code") is True
    assert tc.event_supported("PostToolUse", "codex") is True


def test_permission_request_supported_on_both():
    assert tc.event_supported("PermissionRequest", "claude-code") is True
    assert tc.event_supported("PermissionRequest", "codex") is True


def test_session_end_is_claude_only():
    assert tc.event_supported("SessionEnd", "claude-code") is True
    assert tc.event_supported("SessionEnd", "codex") is False


def test_bogus_event_supported_nowhere():
    assert tc.event_supported("BogusEventXyz", "claude-code") is False
    assert tc.event_supported("BogusEventXyz", "codex") is False


def test_opencode_and_pi_support_no_hook_events():
    for harness in ("opencode", "pi", "unknown-harness"):
        assert tc.event_supported("PostToolUse", harness) is False
        assert tc.harness_events(harness) == []


def test_codex_supports_exactly_ten_events():
    events = tc.harness_events("codex")
    assert len(events) == 10
    assert set(events) == {
        "PreToolUse",
        "PermissionRequest",
        "PostToolUse",
        "PreCompact",
        "PostCompact",
        "SessionStart",
        "UserPromptSubmit",
        "SubagentStart",
        "SubagentStop",
        "Stop",
    }


def test_claude_supports_all_canonical_events_in_order():
    assert tc.harness_events("claude-code") == tc.CANONICAL_EVENTS
    assert len(tc.CANONICAL_EVENTS) == 14


def test_harness_events_preserve_canonical_order():
    codex_events = tc.harness_events("codex")
    # Order matches CANONICAL_EVENTS filtering, not insertion order of the set.
    expected = [e for e in tc.CANONICAL_EVENTS if e in set(codex_events)]
    assert codex_events == expected


# ─────────────────────────────────────────────────────────────────────────────
# MCP tool derivation
# ─────────────────────────────────────────────────────────────────────────────


def test_mcp_tool_names_from_registry():
    registry = {
        "skills": {
            "memory": {"type": "mcp-server"},
            "github-mcp": {"type": "mcp-server"},
            "some-skill": {"type": "claude-skill"},
        }
    }
    assert tc.mcp_tool_names(registry) == ["mcp__github-mcp", "mcp__memory"]


def test_mcp_tool_names_empty_registry():
    assert tc.mcp_tool_names({}) == []
    assert tc.mcp_tool_names({"skills": {}}) == []


def test_tool_vocabulary_includes_canonical_and_mcp():
    registry = {"skills": {"memory": {"type": "mcp-server"}}}
    vocab = tc.tool_vocabulary(registry)
    assert "Edit" in vocab
    assert "Bash" in vocab
    assert "mcp__memory" in vocab
    assert vocab == sorted(vocab)


def test_tool_vocabulary_without_registry_is_canonical_only():
    vocab = tc.tool_vocabulary()
    assert "Edit" in vocab
    assert not any(t.startswith("mcp__") for t in vocab)


# ─────────────────────────────────────────────────────────────────────────────
# Shared golden corpus — the ONE pin both this module and the hand-copied TS
# mirror (`app/src/lib/hookCatalog.ts`, asserted by app/src/test/hookHelpers.test.ts)
# are checked against, so the editor's reach display can never claim a hook
# reaches a harness that `_resolve_matcher` will silently skip at write time.
# Same pattern as tests/fixtures/agent_docs_corpus.json (Python ↔ Rust).
# ─────────────────────────────────────────────────────────────────────────────


def test_canonical_events_match_shared_corpus():
    assert tc.CANONICAL_EVENTS == CORPUS["canonical_events"]


def test_harness_event_support_matches_shared_corpus():
    for harness, expected in CORPUS["harness_events"].items():
        assert tc.harness_events(harness) == expected, harness
        for event in CORPUS["canonical_events"]:
            assert tc.event_supported(event, harness) is (event in expected), (
                harness,
                event,
            )


def test_canonical_tools_match_shared_corpus():
    assert sorted(tc.CANONICAL_TOOLS) == CORPUS["canonical_tools_sorted"]
