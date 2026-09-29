"""Canonical tool + event catalog with per-harness translation (hooks-surface D3).

A hook definition stores canonical ``event:`` and ``tools:`` (Claude's vocabulary
is the canonical one). Each harness understands a *different* subset of events and
uses *different* native tool names in its matcher, so this module owns the
canonical vocabulary and delegates native translation to the bundled codecs:

  1. the canonical TOOL vocabulary (seeded from ``subagents.KNOWN_TOOLS``) plus
     dynamically-derived MCP tool tokens (``mcp__<server>``) from the registry;
  2. the ``translate_tools`` facade, which turns a canonical ``tools`` list into
     the native matcher string for one harness;
  3. the canonical EVENT catalog with per-harness support sets — ``event_supported``
     / ``harness_events`` drive per-event write gating (an adapter never writes a
     hook for an event its harness does not understand) and the UI's reach display.

Pins come from ``openspec/changes/hooks-surface/research.md`` §"Task-0 ground truth"
(verified against the installed binaries), NOT from docs-from-memory.
"""

from __future__ import annotations

from typing import Optional

from skill_hub.infrastructure.harnesses import subagents
from skill_hub.infrastructure.harnesses.harness_bundled_hooks import ClaudeHookCodec, hook_codec

# ─────────────────────────────────────────────────────────────────────────────
# Tool vocabulary
# ─────────────────────────────────────────────────────────────────────────────

# Canonical built-in tool tokens. Seeded from the sub-agent tool vocabulary so the
# two "registered tools" surfaces never drift. MCP tool tokens are layered on top
# dynamically from the registry (they are per-machine, not a static constant).
CANONICAL_TOOLS: frozenset[str] = frozenset(subagents.KNOWN_TOOLS)
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
    # Unknown harnesses retain historical passthrough behavior.
    codec = hook_codec(harness_id) or ClaudeHookCodec()
    return codec.translate_tools(tuple(tools))


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

def event_supported(event: str, harness_id: str) -> bool:
    """True iff ``harness_id`` understands hook ``event``.

    A bogus/unknown event is unsupported on every harness. A harness with no hook
    adapter in v1 (opencode/pi/unknown id) supports no events.
    """
    codec = hook_codec(harness_id)
    return codec is not None and event in codec.supported_events()


def harness_events(harness_id: str) -> list[str]:
    """Ordered canonical events ``harness_id`` supports (canonical order preserved)."""
    codec = hook_codec(harness_id)
    if codec is None:
        return []
    support = set(codec.supported_events())
    return [e for e in CANONICAL_EVENTS if e in support]
