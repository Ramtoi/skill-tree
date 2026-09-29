"""Bundled native hook codecs.

This module contains only the small, deterministic translation layer between the
hub's canonical hook vocabulary and the nested command entries used by the two
hook-capable harnesses.  Filesystem paths and host policy stay in
``hook_adapters``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Optional

from skill_hub.domain.harnesses.harness_adapter_api import (
    HookNativeCodec,
    HookNativeEntry,
    HookNativeRequest,
    HookNativeResult,
)

_CLAUDE_EVENTS = (
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
)
_CODEX_EVENTS = (
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "UserPromptSubmit",
    "SessionStart",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
)
_MCP_PREFIX = "mcp__"
_CODEX_TOOLS = frozenset({"Edit", "Write", "MultiEdit", "Bash"})
_CODEX_ALIASES = {
    "Edit": "apply_patch",
    "Write": "apply_patch",
    "MultiEdit": "apply_patch",
}


def _decode_nested(event: object, entry: object) -> tuple[HookNativeEntry, ...]:
    """Decode every nested command entry, retaining the old permissive coercions."""
    if not isinstance(entry, Mapping) and not hasattr(entry, "get"):
        return ()
    get_entry = getattr(entry, "get", None)
    if not callable(get_entry):
        return ()
    matcher = str(get_entry("matcher", ""))
    inner = get_entry("hooks")
    try:
        inner_entries = list(inner) if inner is not None else []
    except TypeError:
        return ()
    decoded: list[HookNativeEntry] = []
    for item in inner_entries:
        get_item = getattr(item, "get", None)
        if not callable(get_item) or get_item("type") != "command":
            continue
        timeout = get_item("timeout")
        decoded.append(HookNativeEntry(
            event=str(event),
            matcher=matcher,
            command=str(get_item("command", "")),
            timeout=int(timeout) if isinstance(timeout, int) else None,
        ))
    return tuple(decoded)


class _HookCodec:
    def __init__(
        self,
        harness_id: str,
        events: tuple[str, ...],
        supported_tools: Optional[frozenset[str]] = None,
    ) -> None:
        self.harness_id = harness_id
        self._events = events
        self._supported_tools = supported_tools

    def supported_events(self) -> tuple[str, ...]:
        return self._events

    def translate_tools(self, tools: tuple[str, ...]) -> Optional[str]:
        if not tools:
            return ""
        output: list[str] = []
        for tool in tools:
            if tool.startswith(_MCP_PREFIX):
                native = tool
            elif self._supported_tools is not None and tool not in self._supported_tools:
                continue
            else:
                native = _CODEX_ALIASES.get(tool, tool) if self.harness_id == "codex" else tool
            if native not in output:
                output.append(native)
        return "|".join(output) if output else None

    def encode(self, request: HookNativeRequest) -> HookNativeResult:
        if request.event not in self._events:
            return HookNativeResult(
                skip_reasons=(f"event {request.event!r} is not supported on {self.harness_id}",)
            )
        matcher = request.matcher or self.translate_tools(request.tools)
        if matcher is None:
            return HookNativeResult(skip_reasons=(
                f"no canonical tool in {list(request.tools)!r} maps to a native matcher on {self.harness_id}",
            ))
        return HookNativeResult(HookNativeEntry(
            event=request.event,
            matcher=matcher,
            command=request.command,
            timeout=request.timeout,
        ))

    def decode(self, event: object, entry: object) -> tuple[HookNativeEntry, ...]:
        return _decode_nested(event, entry)


class ClaudeHookCodec(_HookCodec):
    def __init__(self) -> None:
        super().__init__("claude-code", _CLAUDE_EVENTS)


class CodexHookCodec(_HookCodec):
    def __init__(self) -> None:
        super().__init__("codex", _CODEX_EVENTS, _CODEX_TOOLS)


_BUNDLED_CODECS: dict[str, HookNativeCodec] = {
    "claude-code": ClaudeHookCodec(),
    "codex": CodexHookCodec(),
}


def bundled_codec(harness_id: str) -> HookNativeCodec:
    """Return the codec for a hook-capable harness, or raise for an unknown id."""
    try:
        return _BUNDLED_CODECS[harness_id]
    except KeyError as exc:
        raise ValueError(f"unknown hook harness: {harness_id!r}") from exc


def hook_codec(harness_id: str) -> Optional[HookNativeCodec]:
    """Return a codec when one exists; unknown harnesses have no native codec."""
    return _BUNDLED_CODECS.get(harness_id)


def decode_nested(event: object, entry: object) -> tuple[HookNativeEntry, ...]:
    """Shared nested decoder useful to adapters and SDK consumers."""
    return _decode_nested(event, entry)
