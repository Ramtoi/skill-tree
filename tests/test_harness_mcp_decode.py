"""Focused contract tests for native MCP decoding."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from skill_hub.domain.harnesses.harness_adapter_api import McpDecodedEntry, McpNativeDecodeResult, thaw_mcp_value
from skill_hub.infrastructure.harnesses.harness_bundled_mcp import bundled_decoder, decode_native


def test_decoded_entries_and_warnings_are_immutable() -> None:
    result = decode_native(
        {"command": "node", "args": ["server.js"], "env": {"TOKEN": "x"}},
        "claude",
    )
    assert result.entry is not None
    assert result.entry.args == ("server.js",)
    assert thaw_mcp_value(result.entry.env) == {"TOKEN": "x"}
    with pytest.raises(TypeError):
        result.entry.env["TOKEN"] = "changed"  # type: ignore[index]
    with pytest.raises(ValueError, match="exactly one"):
        McpNativeDecodeResult()
    with pytest.raises(ValueError, match="exactly one"):
        McpNativeDecodeResult(entry=result.entry, reason="bad")


def test_claude_decoder_preserves_generic_repairs_and_refusals() -> None:
    result = decode_native(
        {"command": ["node", "server.js"], "args": ["--quiet"], "extra": True},
        "claude",
    )
    assert result.entry is not None
    assert result.entry.command == "node"
    assert result.entry.args == ("server.js", "--quiet")
    assert result.warnings == ("command_list_split", "dropped_field:extra")
    assert decode_native({"headersHelper": {}}, "claude").reason == "headers_helper"
    assert decode_native({"type": "ws", "url": "https://example.test"}, "claude").reason == "ws_transport"


def test_generic_decoder_rejects_malformed_header_maps_and_duplicates() -> None:
    assert decode_native(
        {"type": "http", "url": "https://example.test", "headers": ["helper"]}, "claude"
    ).reason == "headers_helper"
    assert decode_native(
        {
            "type": "http",
            "url": "https://example.test",
            "headers": {"X-Token": "one", "x-token": "two"},
        },
        "claude",
    ).reason == "duplicate_header:x-token"


def test_generic_decoder_coerces_scalar_environment_values_in_warning_order() -> None:
    result = decode_native(
        {"command": "node", "env": {"COUNT": 3, "$odd": "$OTHER"}}, "claude"
    )
    assert result.entry is not None
    assert result.entry.env["COUNT"] == "3"
    assert result.warnings == ("env_value_coerced:COUNT", "env_key_unusual:$odd", "unexpanded_ref:$OTHER")


@pytest.mark.parametrize(
    ("native", "reason"),
    [
        ({"auth": "oauth"}, "oauth_block"),
        ({"http_headers_helper": "helper"}, "headers_helper"),
        ({"command": "node", "env": "helper"}, "malformed_field:env"),
    ],
)
def test_codex_decoder_preserves_refusals(native: dict, reason: str) -> None:
    assert decode_native(native, "codex").reason == reason


def test_codex_decoder_merges_timeouts_and_header_maps() -> None:
    result = decode_native(
        {
            "url": "https://example.test/mcp",
            "http_headers": {"X-Org": "acme"},
            "env_http_headers": {"X-Key": "KEY"},
            "bearer_token_env_var": "TOKEN",
            "startup_timeout_sec": 2,
            "tool_timeout_sec": 3,
        },
        "codex",
    )
    assert result.entry is not None
    assert result.entry.transport == "http"
    assert result.entry.headers["Authorization"] == "Bearer ${TOKEN}"
    assert result.entry.timeout_ms == 3000
    assert result.warnings == ("timeout_merged",)


def test_opencode_decoder_accepts_string_local_and_remote_forms() -> None:
    local = decode_native(
        {"type": "local", "command": "node", "environment": {"TOKEN": "{env:TOKEN}"}},
        "opencode",
    )
    assert local.entry is not None
    assert local.entry.command == "node"
    assert local.entry.env["TOKEN"] == "${TOKEN}"
    remote = decode_native(
        {"type": "remote", "url": "https://example.test", "headers": {"X-Key": "{env:KEY}"}},
        "opencode",
    )
    assert remote.entry is not None
    assert remote.entry.transport == "http"
    assert remote.entry.headers["X-Key"] == "${KEY}"


def test_unknown_decoder_key_has_clear_error() -> None:
    with pytest.raises(ValueError, match="unknown MCP decoder key"):
        bundled_decoder("future")


def test_decoder_imports_with_sdk_only_modules(tmp_path: Path) -> None:
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
            "from skill_hub.infrastructure.harnesses.harness_bundled_mcp import decode_native; "
            "r=decode_native({'command':'node'}, 'claude'); "
            "assert r.entry.command == 'node'",
        ],
        cwd=tmp_path,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr


def test_malformed_bracketed_url_retains_legacy_totality_reason():
    from skill_hub.domain.mcp import mcp_spec

    native = {"type": "http", "url": "http://[bad"}
    assert decode_native(native, "claude").reason == "unknown_shape"
    assert mcp_spec.normalize_native(native).reason == "unknown_shape"


def test_normalize_native_uses_an_explicit_decoder():
    from skill_hub.domain.mcp import mcp_spec

    class Decoder:
        def __init__(self):
            self.seen = []

        def decode(self, native):
            self.seen.append(native)
            return McpNativeDecodeResult(
                entry=McpDecodedEntry("fixture", (), {}, None, "stdio", None, {}, None)
            )

    decoder = Decoder()
    result = mcp_spec.normalize_native(
        {"command": "ignored"}, name="fixture", decoder=decoder
    )
    assert result.spec is not None and result.spec.command == "fixture"
    assert decoder.seen == [{"command": "ignored"}]
