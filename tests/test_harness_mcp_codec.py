"""Focused contract tests for the SDK-only bundled MCP codecs."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from skill_hub.domain.harnesses.harness_adapter_api import McpNativeRequest, McpNativeResult, thaw_mcp_value
from skill_hub.domain.mcp import mcp_spec
from skill_hub.infrastructure.harnesses.harness_bundled_mcp import bundled_codec, encode_native


def _request(**changes: object) -> McpNativeRequest:
    values: dict[str, object] = {
        "name": "demo",
        "command": "python3",
        "args": ("server.py",),
        "env": {"TOKEN": "${TOKEN}", "PLAIN": "value"},
        "transport": "stdio",
        "timeout_ms": 1001,
    }
    values.update(changes)
    return McpNativeRequest(**values)  # type: ignore[arg-type]


def test_request_and_result_freeze_nested_caller_data() -> None:
    env = {"TOKEN": "${TOKEN}"}
    request = _request(env=env)
    env["TOKEN"] = "changed"
    assert request.env["TOKEN"] == "${TOKEN}"
    with pytest.raises(TypeError):
        request.env["TOKEN"] = "changed"  # type: ignore[index]

    entry = {"nested": {"args": ["one"]}}
    result = McpNativeResult(entry)
    entry["nested"]["args"].append("two")  # type: ignore[index]
    assert result.native_entry["nested"]["args"] == ("one",)  # type: ignore[index]
    with pytest.raises(TypeError):
        result.native_entry["nested"]["args"] = ()  # type: ignore[index]


def test_codec_calls_do_not_share_mutable_output() -> None:
    first = encode_native(_request(), "claude")
    second = encode_native(_request(), "claude")
    assert first == second
    assert first.native_entry is not second.native_entry
    with pytest.raises(TypeError):
        first.native_entry["args"] = ()  # type: ignore[index]
    assert second.native_entry["args"] == ("server.py",)  # type: ignore[index]


@pytest.mark.parametrize(
    "value",
    [
        ["one", {"nested": ("two",)}],
        ("one", {"nested": ["two"]}),
        {"nested": {"deep": ["two"]}},
        {"one", "two"},
        frozenset({"one", "two"}),
    ],
)
def test_host_bridge_preserves_legacy_nested_value_types(value: object) -> None:
    stdio = mcp_spec.McpServerSpec(
        name="demo",
        command="python3",
        env={"VALUE": value},  # type: ignore[dict-item]
    )
    stdio_entry, _ = mcp_spec.to_native(stdio, "claude")
    assert type(stdio_entry["env"]["VALUE"]) is type(value)
    assert stdio_entry["env"]["VALUE"] == value

    remote = mcp_spec.McpServerSpec(
        name="demo",
        transport="http",
        url="https://example.test/mcp",
        headers={"X-Value": value},  # type: ignore[dict-item]
    )
    remote_entry, _ = mcp_spec.to_native(remote, "claude")
    assert type(remote_entry["headers"]["X-Value"]) is type(value)
    assert remote_entry["headers"]["X-Value"] == value


@pytest.mark.parametrize(
    ("adapter", "codec_request", "expected_entry", "expected_skips"),
    [
        (
            "claude",
            _request(),
            {
                "command": "python3",
                "args": ["server.py"],
                "env": {"TOKEN": "${TOKEN}", "PLAIN": "value"},
                "timeout": 1001,
            },
            [],
        ),
        (
            "codex",
            _request(),
            {
                "command": "python3",
                "args": ["server.py"],
                "env": {"PLAIN": "value"},
                "env_vars": ["TOKEN"],
                "startup_timeout_sec": 2,
            },
            [],
        ),
        (
            "codex",
            _request(transport="sse", url="https://example.test/mcp"),
            {},
            ["codex_no_sse"],
        ),
        (
            "claude",
            _request(
                transport="http",
                url="https://example.test/mcp",
                headers={"Authorization": "Bearer ${TOKEN}", "X-Org": "acme"},
            ),
            {
                "type": "http",
                "url": "https://example.test/mcp",
                "headers": {"Authorization": "Bearer ${TOKEN}", "X-Org": "acme"},
                "timeout": 1001,
            },
            [],
        ),
        (
            "codex",
            _request(
                transport="http",
                url="https://example.test/mcp",
                headers={"Authorization": "Bearer ${TOKEN}", "X-Org": "acme", "X-Key": "${KEY}"},
            ),
            {
                "url": "https://example.test/mcp",
                "bearer_token_env_var": "TOKEN",
                "env_http_headers": {"X-Key": "KEY"},
                "http_headers": {"X-Org": "acme"},
                "tool_timeout_sec": 2,
                "startup_timeout_sec": 2,
            },
            [],
        ),
        (
            "opencode",
            _request(),
            {
                "type": "local",
                "command": ["python3", "server.py"],
                "enabled": True,
                "environment": {"TOKEN": "{env:TOKEN}", "PLAIN": "value"},
                "timeout": 1001,
            },
            [],
        ),
        (
            "opencode",
            _request(
                transport="http",
                url="https://example.test/mcp",
                headers={"Authorization": "${TOKEN:-fallback}", "X-Org": "acme"},
            ),
            {
                "type": "remote",
                "url": "https://example.test/mcp",
                "enabled": True,
                "headers": {"X-Org": "acme"},
                "timeout": 1001,
            },
            ["opencode_default_dropped:Authorization"],
        ),
    ],
)
def test_bundled_codecs_preserve_native_shapes(
    adapter: str,
    codec_request: McpNativeRequest,
    expected_entry: dict[str, object],
    expected_skips: list[str],
) -> None:
    result = bundled_codec(adapter).encode(codec_request)
    assert thaw_mcp_value(result.native_entry) == expected_entry
    assert result.skip_reasons == tuple(expected_skips)


def test_host_bridge_preserves_legacy_tuple_shape_and_unknown_failure() -> None:
    spec = mcp_spec.McpServerSpec(
        "demo", "python3", ["server.py"], {"TOKEN": "${TOKEN}"}, timeout_ms=1001
    )
    entry, skips = mcp_spec.to_native(spec, "codex")
    assert entry == {
        "command": "python3",
        "args": ["server.py"],
        "env": {},
        "env_vars": ["TOKEN"],
        "startup_timeout_sec": 2,
    }
    assert skips == []
    with pytest.raises(ValueError, match="unknown MCP adapter key"):
        mcp_spec.to_native(spec, "not-bundled")


def test_codec_imports_from_sdk_only_directory(tmp_path: Path) -> None:
    """The bundled module must import without the host application's modules."""
    root = Path(__file__).resolve().parents[1]
    (tmp_path / "skill_hub/domain/harnesses/harness_adapter_api.py").parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(
        root / "skill_hub/domain/harnesses/harness_adapter_api.py",
        tmp_path / "skill_hub/domain/harnesses/harness_adapter_api.py",
    )
    (tmp_path / "skill_hub/infrastructure/harnesses/harness_bundled_mcp.py").parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(
        root / "skill_hub/infrastructure/harnesses/harness_bundled_mcp.py",
        tmp_path / "skill_hub/infrastructure/harnesses/harness_bundled_mcp.py",
    )
    env = os.environ.copy()
    env["PYTHONPATH"] = str(tmp_path)
    completed = subprocess.run(
        [
            sys.executable,
            "-S",
            "-c",
            "from skill_hub.domain.harnesses.harness_adapter_api import McpNativeRequest; "
            "from skill_hub.infrastructure.harnesses.harness_bundled_mcp import encode_native; "
            "r=encode_native(McpNativeRequest(name='x'), 'claude'); "
            "assert r.native_entry['command'] == ''",
        ],
        cwd=tmp_path,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
