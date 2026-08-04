"""Canonical tool + event catalog with per-harness translation (hooks-surface D3).

A hook definition stores canonical ``event:`` and ``tools:`` (Claude's vocabulary
is the canonical one). Each harness understands a *different* subset of events and
uses *different* native tool names in its matcher, so this module owns:

  1. the canonical TOOL vocabulary (seeded from ``subagents.KNOWN_TOOLS``) plus
     dynamically-derived MCP tool tokens (``mcp__<server>``) from the registry;
  2. per-harness tool aliasing + existence filtering — ``translate_tools`` turns a
     canonical ``tools`` list into the native matcher string for one harness;
  3. the canonical EVENT catalog with per-harness support sets — ``event_supported``
     / ``harness_events`` drive per-event write gating (an adapter never writes a
     hook for an event its harness does not understand) and the UI's reach display.

Pins come from ``openspec/changes/hooks-surface/research.md`` §"Task-0 ground truth"
(verified against the installed binaries), NOT from docs-from-memory.
"""

from __future__ import annotations

from typing import Optional

import subagents

# ─────────────────────────────────────────────────────────────────────────────
# Tool vocabulary
# ─────────────────────────────────────────────────────────────────────────────

# Canonical built-in tool tokens. Seeded from the sub-agent tool vocabulary so the
# two "registered tools" surfaces never drift. MCP tool tokens are layered on top
# dynamically from the registry (they are per-machine, not a static constant).
CANONICAL_TOOLS: frozenset[str] = frozenset(subagents.KNOWN_TOOLS)

# Per-harness native tool aliases: canonical name → the harness's native tool name.
# Codex's single edit tool is ``apply_patch`` (task-0: PostToolUse fires with
# ``tool_name = "apply_patch"`` for edits), so the whole Claude edit family collapses
# onto it. A canonical tool with no alias for a harness passes through unchanged.
_TOOL_ALIASES: dict[str, dict[str, str]] = {
    "codex": {
        "Edit": "apply_patch",
        "Write": "apply_patch",
        "MultiEdit": "apply_patch",
    },
}

# Canonical tools each harness actually exposes as a hook matcher target. A harness
# WITH an entry here drops any canonical tool outside the set from a translated
# matcher (e.g. a Claude-only ``Read`` on codex). A harness WITHOUT an entry
# (claude-code, or an unknown id) keeps every tool (passthrough). ``mcp__*`` tokens
# ALWAYS pass through — both hook-capable harnesses fire on MCP tools.
#
# Codex's confirmed hook-matchable tools (research stream 3 + task-0): the edit
# family (→ ``apply_patch``) and ``Bash``; MCP tokens pass through separately.
_HARNESS_CANONICAL_TOOLS: dict[str, frozenset[str]] = {
    "codex": frozenset({"Edit", "Write", "MultiEdit", "Bash"}),
}

_MCP_PREFIX = "mcp__"


def mcp_tool_names(registry: dict) -> list[str]:
    """Server-level MCP matcher tokens derived from the registry's mcp-servers.

    Every ``type: mcp-server`` skill is exposed to a harness under a server name
    equal to its registry key, and Claude/Codex match its tools with the prefix
    ``mcp__<server>`` (which matches ``mcp__<server>__<tool>`` for every tool of
    that server). Returns a sorted list of ``mcp__<name>`` tokens.
    """
    skills = (registry or {}).get("skills") or {}
    names = [
        f"{_MCP_PREFIX}{name}"
        for name, cfg in skills.items()
        if isinstance(cfg, dict) and cfg.get("type") == "mcp-server"
    ]
    return sorted(names)


def tool_vocabulary(registry: Optional[dict] = None) -> list[str]:
    """Full picker vocabulary: canonical tools + dynamic MCP server tokens, sorted."""
    tokens = set(CANONICAL_TOOLS)
    if registry:
        tokens.update(mcp_tool_names(registry))
    return sorted(tokens)


def translate_tools(tools: list[str], harness_id: str) -> Optional[str]:
    """Translate a canonical ``tools`` list into ``harness_id``'s native matcher.

    Semantics:
      * empty list → ``""`` — the empty matcher, meaning ALL tools (never None);
      * each canonical tool is aliased to its native name for the harness (no alias
        ⇒ passes through unchanged);
      * a canonical tool that does NOT exist on the target harness is DROPPED (e.g.
        a Claude-only tool on codex);
      * ``mcp__*`` tokens always pass through unchanged on every harness;
      * the native names are de-duplicated preserving first-seen order (so the codex
        edit family collapses to a single ``apply_patch``) and pipe-joined;
      * if EVERY tool drops (nothing native remains) → ``None``, signalling the
        caller to SKIP the write (translating an all-unsupported list to ``""`` would
        wrongly match every tool).
    """
    if not tools:
        return ""
    supported = _HARNESS_CANONICAL_TOOLS.get(harness_id)  # None ⇒ passthrough
    aliases = _TOOL_ALIASES.get(harness_id, {})
    out: list[str] = []
    for tool in tools:
        if tool.startswith(_MCP_PREFIX):
            native = tool  # MCP tokens pass through on every harness
        elif supported is not None and tool not in supported:
            continue  # canonical tool absent on this harness → drop
        else:
            native = aliases.get(tool, tool)
        if native not in out:
            out.append(native)
    if not out:
        return None
    return "|".join(out)


# ─────────────────────────────────────────────────────────────────────────────
# Event catalog
# ─────────────────────────────────────────────────────────────────────────────

# Canonical event vocabulary (ordered). Pinned to the Claude-family set: the 14
# hook-event tokens binary-verified in Claude Code 2.1.210 (research task-0 §0.5).
# The wider "~31 events" figure is doc-sourced and not enumerable from the binary,
# so the catalog pins exactly the verified anchor set. Claude-code supports all of
# these; codex supports the 10-event subset below.
CANONICAL_EVENTS: list[str] = [
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "UserPromptSubmit",
    "SessionStart",
    "SessionEnd",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "Notification",
    "PreCompact",
    "PostCompact",
    "FileChanged",
]

# Codex = exactly 10 events (research task-0 §0.5, pinned from the binary's
# snake_case hook-event enum; NO SessionEnd, NO Notification, NO PostToolUseFailure,
# NO FileChanged). All 10 are a subset of the canonical Claude list above.
_CODEX_EVENTS: frozenset[str] = frozenset({
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
})

# Per-harness event support. Only the two harnesses hub writes hooks to in v1 carry
# a support set; every other harness (opencode/pi/unknown) supports no hook events
# (no adapter in v1), so per-event gating skips them wholesale.
_EVENT_SUPPORT: dict[str, frozenset[str]] = {
    "claude-code": frozenset(CANONICAL_EVENTS),
    "codex": _CODEX_EVENTS,
}


def event_supported(event: str, harness_id: str) -> bool:
    """True iff ``harness_id`` understands hook ``event``.

    A bogus/unknown event is unsupported on every harness. A harness with no hook
    adapter in v1 (opencode/pi/unknown id) supports no events.
    """
    return event in _EVENT_SUPPORT.get(harness_id, frozenset())


def harness_events(harness_id: str) -> list[str]:
    """Ordered canonical events ``harness_id`` supports (canonical order preserved)."""
    support = _EVENT_SUPPORT.get(harness_id, frozenset())
    return [e for e in CANONICAL_EVENTS if e in support]
