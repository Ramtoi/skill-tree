"""Focused parity checks for the SDK hook codecs."""

from dataclasses import FrozenInstanceError

import pytest

from skill_hub.domain.diagnostics import tool_catalog
from skill_hub.domain.harnesses.harness_adapter_api import HookNativeRequest
from skill_hub.infrastructure.harnesses.harness_bundled_hooks import bundled_codec


@pytest.mark.parametrize("harness", ["claude-code", "codex"])
def test_codec_records_are_immutable_and_encode_isolated(harness):
    codec = bundled_codec(harness)
    request = HookNativeRequest(
        event="PostToolUse", tools=["Edit"], command="hook.py", timeout=3
    )
    with pytest.raises(FrozenInstanceError):
        request.command = "other.py"
    first = codec.encode(request)
    second = codec.encode(request)
    assert first == second
    assert first.entry is not None
    assert first.entry.command == "hook.py"
    assert first.entry is not second.entry


def test_codex_translation_keeps_alias_order_and_unknown_passthrough():
    codec = bundled_codec("codex")
    assert codec.translate_tools(("Edit", "Write", "Bash", "Edit")) == "apply_patch|Bash"
    assert codec.translate_tools(("Read",)) is None
    assert codec.translate_tools(("mcp__memory",)) == "mcp__memory"


def test_unknown_event_is_unsupported_but_unknown_tool_is_passthrough():
    request = HookNativeRequest(event="FutureEvent", tools=("future_tool",), command="x")
    result = bundled_codec("claude-code").encode(request)
    assert result.entry is None
    assert result.skip_reasons
    assert tool_catalog.translate_tools(["future_tool"], "future-harness") == "future_tool"
    assert tool_catalog.event_supported("FutureEvent", "future-harness") is False


@pytest.mark.parametrize("harness", ["claude-code", "codex"])
def test_decode_returns_all_nested_commands_and_refuses_flat_entries(harness):
    codec = bundled_codec(harness)
    entry = {
        "matcher": "Edit",
        "hooks": [
            {"type": "command", "command": "one", "timeout": 4},
            {"type": "prompt", "prompt": "ignore"},
            {"type": "command", "command": 2, "timeout": "bad"},
        ],
    }
    decoded = codec.decode("UncataloguedEvent", entry)
    assert [(item.event, item.matcher, item.command, item.timeout) for item in decoded] == [
        ("UncataloguedEvent", "Edit", "one", 4),
        ("UncataloguedEvent", "Edit", "2", None),
    ]
    assert codec.decode("PostToolUse", {"matcher": "x", "command": "flat"}) == ()
    assert codec.decode("PostToolUse", {"hooks": None}) == ()


def test_catalog_facade_retains_canonical_event_order():
    assert tool_catalog.harness_events("codex") == [
        event for event in tool_catalog.CANONICAL_EVENTS
        if event in set(bundled_codec("codex").supported_events())
    ]


@pytest.mark.parametrize("harness", ["claude", "pi", "opencode", "unknown"])
def test_adapter_aliases_and_unknown_harnesses_do_not_claim_hook_support(harness):
    assert not tool_catalog.event_supported("PostToolUse", harness)
    assert tool_catalog.harness_events(harness) == []
    assert tool_catalog.translate_tools(["Read"], harness) == "Read"


def test_hook_codec_imports_in_sdk_only_directory(tmp_path):
    import os
    import shutil
    import subprocess
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    for name in (
        "skill_hub/domain/harnesses/harness_adapter_api.py",
        "skill_hub/infrastructure/harnesses/harness_bundled_hooks.py",
    ):
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / name, tmp_path / name)
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(tmp_path)
    result = subprocess.run(
        [sys.executable, "-S", "-c",
         "from skill_hub.domain.harnesses.harness_adapter_api import HookNativeRequest; "
         "from skill_hub.infrastructure.harnesses.harness_bundled_hooks import bundled_codec; "
         "r = bundled_codec('codex').encode(HookNativeRequest('PostToolUse', ('Edit',), command='fixture')); "
         "assert r.entry.matcher == 'apply_patch'; assert r.entry.command == 'fixture'"],
        cwd=tmp_path, env=environment, capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0, result.stderr
