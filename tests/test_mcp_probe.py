"""Tests for `mcp_probe.py` — the stdio/http handshake, the login-shell env
snapshot, and the on-disk probe cache (plans/C.md §5, cases 23-38).

No test here ever spawns the developer's real login shell: the autouse
`_stub_login_shell` fixture below points `$SHELL` at a fixture stub that
answers `-lic 'env -0'` with nothing, and resets `mcp_probe`'s per-process
snapshot cache before and after every test. A test that needs a *different*
`$SHELL` answer (or none at all) overrides it locally with its own
`monkeypatch.setenv`/`from_shell=False` — always AFTER this fixture has run,
so the override wins.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "mcp_probe"


def _stdio_spec(name, script, **kwargs):
    from skill_hub.domain.mcp import mcp_spec

    return mcp_spec.McpServerSpec(name=name, command=sys.executable, args=[str(script)], **kwargs)


@pytest.fixture(autouse=True)
def _stub_login_shell(monkeypatch):
    """Safety net: no test in this file may run the developer's real login
    shell. Also resets `mcp_probe`'s once-per-process snapshot cache so tests
    don't leak state into each other."""
    from skill_hub.infrastructure.mcp import mcp_probe

    monkeypatch.setenv("SHELL", str(FIXTURES / "fake_shell_empty.sh"))
    monkeypatch.setattr(mcp_probe, "_SHELL_ENV_CACHE", None)
    yield
    monkeypatch.setattr(mcp_probe, "_SHELL_ENV_CACHE", None)


# ─────────────────────────────────────────────────────────────────────────────
# case 23-26: the stdio handshake
# ─────────────────────────────────────────────────────────────────────────────


def test_stdio_probe_ok():
    from skill_hub.infrastructure.mcp import mcp_probe

    spec = _stdio_spec("s", FIXTURES / "stdio_ok.py")
    row, _record = mcp_probe.probe(spec, timeout_s=5, from_shell=False)

    assert row["state"] == "ok"
    assert row["tool_count"] == 2
    assert row["tools"] == ["tool_a", "tool_b"]
    assert row["protocol_version"] == "2024-11-05"
    assert isinstance(row["latency_ms"], int)


def test_stdio_probe_writes_tool_schemas_alongside_tool_names():
    """usage-loadout-analytics D5/D12: `_row` gains `tool_schemas` and both
    stdio and http call sites pass it, while `tools` keeps holding names
    only. `stdio_ok.py`'s two tools carry no description/inputSchema, so
    this only proves the field's shape and its `tools` independence; the
    dedicated `_tool_schemas` test below proves description/inputSchema
    survive intact when the server sends them."""
    from skill_hub.infrastructure.mcp import mcp_probe

    spec = _stdio_spec("s", FIXTURES / "stdio_ok.py")
    row, _record = mcp_probe.probe(spec, timeout_s=5, from_shell=False)

    assert row["tools"] == ["tool_a", "tool_b"]
    assert row["tool_schemas"] == [
        {"name": "tool_a", "description": None, "inputSchema": None},
        {"name": "tool_b", "description": None, "inputSchema": None},
    ]


def test_tool_schemas_preserves_description_and_input_schema():
    """`_tool_schemas` reads the same `tools/list` result as `_tool_names`
    but keeps `description` and `inputSchema` intact, and drops a tool with
    no name exactly like `_tool_names` does."""
    from skill_hub.infrastructure.mcp import mcp_probe

    result = {
        "tools": [
            {
                "name": "read_file",
                "description": "Read a file from disk.",
                "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}},
            },
            {"name": "no_schema"},
            {"description": "dropped — no name"},
            "not-a-dict",
        ]
    }

    assert mcp_probe._tool_schemas(result) == [
        {
            "name": "read_file",
            "description": "Read a file from disk.",
            "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}},
        },
        {"name": "no_schema", "description": None, "inputSchema": None},
    ]
    assert mcp_probe._tool_names(result) == ["read_file", "no_schema"]


def test_stdio_probe_timeout_kills_the_child(monkeypatch):
    from skill_hub.infrastructure.mcp import mcp_probe

    captured = {}
    orig_popen = subprocess.Popen

    def _spy(*args, **kwargs):
        proc = orig_popen(*args, **kwargs)
        captured["proc"] = proc
        return proc

    monkeypatch.setattr(subprocess, "Popen", _spy)

    spec = _stdio_spec("s", FIXTURES / "stdio_sleep.py")
    row, _record = mcp_probe.probe(spec, timeout_s=1, from_shell=False)

    assert row["state"] == "timeout"
    assert "proc" in captured
    assert captured["proc"].poll() is not None, "child was left running (an orphan)"


def test_stdio_probe_stdout_closes_before_process_exit(tmp_data_home, tmp_path, monkeypatch):
    from skill_hub.infrastructure.mcp import mcp_probe

    script = tmp_path / "close_stdout.py"
    script.write_text(
        "import os, sys, time\n"
        "sys.stdin.readline()\n"
        "os.close(sys.stdout.fileno())\n"
        "time.sleep(30)\n"
    )
    processes = []
    popen = subprocess.Popen

    def capture_process(*args, **kwargs):
        process = popen(*args, **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(subprocess, "Popen", capture_process)
    row, _record = mcp_probe.probe(
        _stdio_spec("closed", script), timeout_s=5, from_shell=False
    )

    assert row["state"] == "unreachable"
    assert len(processes) == 1
    assert processes[0].poll() is not None, "child was left running"


def test_stdio_probe_process_exits_immediately():
    from skill_hub.infrastructure.mcp import mcp_probe

    spec = _stdio_spec("s", FIXTURES / "stdio_exit_immediately.py")
    row, _record = mcp_probe.probe(spec, timeout_s=5, from_shell=False)

    assert row["state"] == "unreachable"


def test_stdio_probe_banner_before_valid_response_is_ok():
    """A non-JSON startup banner is drained and does NOT colour the verdict.

    `_LineReader.non_json_lines` is reset by every `_read_response`, so the
    banner counted while waiting for `initialize` cannot make a later
    `timeout` or `unreachable` read as `protocol_error`. Servers that print a
    banner to stdout are common; treating one as "did not speak MCP" would be
    a false diagnosis on a perfectly healthy server."""
    from skill_hub.infrastructure.mcp import mcp_probe

    spec = _stdio_spec("s", FIXTURES / "stdio_banner_then_ok.py")
    row, _record = mcp_probe.probe(spec, timeout_s=5, from_shell=False)

    assert row["state"] == "ok"
    assert row["tool_count"] == 2
    assert row["tools"] == ["alpha", "beta"]


def test_stdio_probe_garbage_response():
    """A server that writes non-JSON to stdout and then dies reads as
    `protocol_error`, NOT `unreachable`.

    Wave G's per-id correlation (plans/G.md §5.1) drains an unparseable line
    as noise instead of failing on it, which on its own would have downgraded
    this case to `unreachable` — i.e. "could not reach the server" about a
    server we demonstrably DID reach and which demonstrably did not speak
    MCP. `_LineReader.non_json_lines` keeps that evidence and
    `_no_answer_state` uses it, restoring the pre-wave-G verdict.

    `protocol_error` also still covers the other shape: a well-formed
    JSON-RPC response carrying an `error` object or no `result` — see
    `test_stdio_probe_error_object_after_correlation`."""
    from skill_hub.infrastructure.mcp import mcp_probe

    spec = _stdio_spec("s", FIXTURES / "stdio_garbage.py")
    row, _record = mcp_probe.probe(spec, timeout_s=5, from_shell=False)

    assert row["state"] == "protocol_error"


# ─────────────────────────────────────────────────────────────────────────────
# case 27: unresolved ${VAR} short-circuits before any spawn/request
# ─────────────────────────────────────────────────────────────────────────────


def test_unresolved_ref_short_circuits(monkeypatch):
    from skill_hub.domain.mcp import mcp_spec
    from skill_hub.infrastructure.mcp import mcp_probe

    def _boom(*args, **kwargs):
        raise AssertionError("must not spawn a subprocess")

    monkeypatch.setattr(subprocess, "Popen", _boom)

    spec = mcp_spec.McpServerSpec(name="s", command="python3", env={"T": "${MISSING}"})
    row, _record = mcp_probe.probe(spec, from_shell=False)

    assert row["state"] == "unresolved_ref"
    assert row["unresolved_refs"] == ["MISSING"]


# ─────────────────────────────────────────────────────────────────────────────
# case 28-31 (M5): the login-shell env snapshot
# ─────────────────────────────────────────────────────────────────────────────


def test_login_shell_env_is_consulted(monkeypatch):
    from skill_hub.domain.mcp import mcp_spec
    from skill_hub.infrastructure.mcp import mcp_probe

    monkeypatch.setenv("SHELL", str(FIXTURES / "fake_shell_my_token.sh"))
    monkeypatch.setattr(mcp_probe, "_SHELL_ENV_CACHE", None)

    spec = mcp_spec.McpServerSpec(
        name="s",
        command=sys.executable,
        args=[str(FIXTURES / "stdio_ok.py")],
        env={"TOKEN": "${MY_TOKEN}"},
    )
    row, _record = mcp_probe.probe(spec, timeout_s=5)

    assert row["state"] == "ok", row
    assert row["env_from_shell"] is True


def test_login_shell_snapshot_failure_degrades(monkeypatch, tmp_path):
    from skill_hub.infrastructure.mcp import mcp_probe

    monkeypatch.setenv("SHELL", str(tmp_path / "does-not-exist"))
    monkeypatch.setattr(mcp_probe, "_SHELL_ENV_CACHE", None)

    env, ok = mcp_probe.resolved_env()
    assert ok is False
    assert env == dict(os.environ)

    spec = _stdio_spec("s", FIXTURES / "stdio_ok.py")
    row, _record = mcp_probe.probe(spec, timeout_s=5)
    assert row["state"] == "ok"
    assert row["env_from_shell"] is False


def test_login_shell_snapshot_is_cached_once_per_process(monkeypatch):
    from skill_hub.infrastructure.mcp import mcp_probe

    monkeypatch.setenv("SHELL", str(FIXTURES / "fake_shell_my_token.sh"))
    monkeypatch.setattr(mcp_probe, "_SHELL_ENV_CACHE", None)

    calls = {"n": 0}
    orig_run = subprocess.run

    def _spy(*args, **kwargs):
        calls["n"] += 1
        return orig_run(*args, **kwargs)

    monkeypatch.setattr(subprocess, "run", _spy)

    mcp_probe.resolved_env()
    mcp_probe.resolved_env()

    assert calls["n"] == 1


def test_no_env_from_shell_flag_skips_the_snapshot(monkeypatch):
    from skill_hub.infrastructure.mcp import mcp_probe

    def _boom(*args, **kwargs):
        raise AssertionError("must not spawn the login-shell snapshot")

    monkeypatch.setattr(subprocess, "run", _boom)

    env, ok = mcp_probe.resolved_env(from_shell=False)
    assert ok is False
    assert env == dict(os.environ)


# ─────────────────────────────────────────────────────────────────────────────
# case 32-33: the http/sse handshake — urllib only, monkeypatched
# ─────────────────────────────────────────────────────────────────────────────


class _FakeHttpResponse:
    def __init__(self, payload: dict, headers: dict | None = None):
        self._payload = json.dumps(payload).encode("utf-8")
        self.headers = headers or {"Content-Type": "application/json"}

    def read(self):
        return self._payload


def test_http_probe_ok(monkeypatch):
    from skill_hub.domain.mcp import mcp_spec
    from skill_hub.infrastructure.mcp import mcp_probe

    captured = []
    responses = [
        {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2024-11-05"}},
        {},  # notifications/initialized's body is never parsed
        {"jsonrpc": "2.0", "id": 2, "result": {"tools": [{"name": "a"}]}},
    ]

    def _fake_urlopen(req, timeout=None):
        captured.append(req)
        return _FakeHttpResponse(responses.pop(0))

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)

    spec = mcp_spec.McpServerSpec(
        name="s",
        transport="http",
        url="https://example.test/mcp",
        headers={"Authorization": "Bearer ${TOK}"},
    )
    row, _record = mcp_probe.probe(spec, env={"TOK": "secret"}, from_shell=False)

    assert row["state"] == "ok"
    assert row["tool_count"] == 1
    assert len(captured) == 3
    assert captured[0].get_header("Authorization") == "Bearer secret"


def test_http_probe_non_2xx(monkeypatch):
    from skill_hub.domain.mcp import mcp_spec
    from skill_hub.infrastructure.mcp import mcp_probe

    def _fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 500, "boom", None, None)

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)

    spec = mcp_spec.McpServerSpec(name="s", transport="http", url="https://example.test/mcp")
    row, _record = mcp_probe.probe(spec, env={}, from_shell=False)

    assert row["state"] == "unreachable"


def test_http_probe_error_object(monkeypatch):
    from skill_hub.domain.mcp import mcp_spec
    from skill_hub.infrastructure.mcp import mcp_probe

    def _fake_urlopen(req, timeout=None):
        return _FakeHttpResponse(
            {"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "nope"}},
            {"jsonrpc": "2.0", "id": 2, "error": {"code": -32000, "message": "nope"}},
        )

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)

    spec = mcp_spec.McpServerSpec(name="s", transport="http", url="https://example.test/mcp")
    row, _record = mcp_probe.probe(spec, env={}, from_shell=False)

    assert row["state"] == "protocol_error"


def test_http_probe_timeout(monkeypatch):
    from skill_hub.domain.mcp import mcp_spec
    from skill_hub.infrastructure.mcp import mcp_probe

    def _fake_urlopen(req, timeout=None):
        raise socket.timeout("timed out")

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)

    spec = mcp_spec.McpServerSpec(name="s", transport="http", url="https://example.test/mcp")
    row, _record = mcp_probe.probe(spec, env={}, from_shell=False)

    assert row["state"] == "timeout"


# ─────────────────────────────────────────────────────────────────────────────
# case 34: the probe cache — roundtrip + corrupt-file handling
# ─────────────────────────────────────────────────────────────────────────────


def test_probe_cache_roundtrip_and_atomicity(tmp_data_home):
    from skill_hub.infrastructure.mcp import mcp_probe

    row_a = {"name": "a", "state": "ok", "checked_at": "2026-01-01T00:00:00Z"}
    row_b = {"name": "b", "state": "timeout", "checked_at": "2026-01-01T00:00:00Z"}
    mcp_probe.write_probe_cache("a", row_a)
    mcp_probe.write_probe_cache("b", row_b)

    cache = mcp_probe.read_probe_cache()
    assert cache["a"] == row_a
    assert cache["b"] == row_b

    path = mcp_probe.probe_cache_path()
    assert path.exists()
    data = json.loads(path.read_text())
    assert data["schema_version"] == 1

    path.write_text("{ not json at all")
    assert mcp_probe.read_probe_cache() == {}


def test_corrupt_binary_probe_cache_reads_as_empty(tmp_data_home):
    """C-1: `Path.read_text(encoding='utf-8')` raises `UnicodeDecodeError` on
    non-UTF-8 bytes, which `OSError`/`json.JSONDecodeError` do not catch. The
    contract ("corrupt = warn + treat as empty, never raise") must hold for
    this shape too, not just a textual-but-invalid JSON file."""
    from skill_hub.infrastructure.mcp import mcp_probe

    path = mcp_probe.probe_cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\xff\xfe binary garbage, not utf-8 at all")

    assert mcp_probe.read_probe_cache() == {}


# ─────────────────────────────────────────────────────────────────────────────
# W-2: a direct unit test for `cache_age_summary` — case 42 (test_mcp_doctor.py)
# monkeypatches this function entirely, so nothing else in the suite drives it.
# ─────────────────────────────────────────────────────────────────────────────


def test_cache_age_summary_classification():
    from skill_hub.infrastructure.mcp import mcp_probe

    now = datetime.now(tz=timezone.utc)
    fresh_iso = (now - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    stale_iso = (now - timedelta(days=9)).strftime("%Y-%m-%dT%H:%M:%SZ")

    cache = {
        "fresh": {"checked_at": fresh_iso},
        "stale": {"checked_at": stale_iso},
        "missing_checked_at": {"state": "ok"},
        "garbage_checked_at": {"checked_at": "not-a-timestamp"},
        "not_a_dict_row": "oops",
    }

    never_checked, stale = mcp_probe.cache_age_summary(cache, stale_days=7)

    # "fresh" counts as neither (checked recently); "stale" is stale; the two
    # malformed rows and the non-dict row all degrade to never-checked.
    assert stale == 1
    assert never_checked == 3


# ─────────────────────────────────────────────────────────────────────────────
# case 35: `hub mcp check --json` payload shape
# ─────────────────────────────────────────────────────────────────────────────


def _seed_registry(tmp_path, registry):
    import yaml

    (tmp_path / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _mcp_registry(name="demo", **mcp_overrides):
    mcp = {"command": sys.executable, "args": [str(FIXTURES / "stdio_ok.py")]}
    mcp.update(mcp_overrides)
    return {
        "version": "1",
        "harnesses_global": [],
        "skills": {
            name: {
                "version": "1.0.0",
                "description": "demo",
                "source": None,
                "type": "mcp-server",
                "scope": "global",
                "upstream": None,
                "mcp": mcp,
            }
        },
        "bundles": {},
        "projects": {},
    }


def test_check_json_payload_shape(tmp_data_home, capsys):
    from argparse import Namespace

    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed_registry(tmp_data_home, _mcp_registry())

    mcp_cli.cmd_mcp_check(
        Namespace(
            name="demo",
            all=False,
            project=None,
            timeout_s=5,
            env_from_shell=False,
            json=True,
        )
    )
    out = capsys.readouterr().out
    payload = json.loads(out)

    for key in (
        "name",
        "transport",
        "state",
        "tool_count",
        "tools",
        "latency_ms",
        "protocol_version",
        "unresolved_refs",
        "env_from_shell",
        "error",
        "checked_at",
        "ok",
    ):
        assert key in payload, f"missing {key!r} in {payload}"
    assert payload["state"] == "ok"
    assert payload["ok"] is True
    assert payload["env_from_shell"] is False


# ─────────────────────────────────────────────────────────────────────────────
# case 36 (m13): --all probes every registered server, sequentially
# ─────────────────────────────────────────────────────────────────────────────


def test_check_all_probes_every_registered_server(tmp_data_home, capsys):
    """W-4: one of the three servers is source-backed (`{source}` in `args`).
    `hub mcp check <name>` and `hub mcp check --all` must agree on it —
    both probe the EXPANDED spec, never the raw wire spec with a literal,
    unresolved `{source}` token (which would spawn nothing and read as
    `unreachable` on the sweep only)."""
    from argparse import Namespace

    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.infrastructure.mcp import mcp_probe

    registry = _mcp_registry("s1")
    registry["skills"]["s2"] = dict(registry["skills"]["s1"])

    source_dir = tmp_data_home / "mcp-servers" / "s3-src"
    source_dir.mkdir(parents=True)
    shutil.copy(FIXTURES / "stdio_ok.py", source_dir / "stdio_ok.py")
    registry["skills"]["s3"] = {
        "version": "1.0.0",
        "description": "demo",
        "source": str(source_dir),
        "type": "mcp-server",
        "scope": "global",
        "upstream": None,
        "mcp": {"command": sys.executable, "args": ["{source}/stdio_ok.py"]},
    }
    _seed_registry(tmp_data_home, registry)

    mcp_cli.cmd_mcp_check(
        Namespace(name="s3", all=False, project=None, timeout_s=5, env_from_shell=False, json=True)
    )
    single = json.loads(capsys.readouterr().out)
    assert single["state"] == "ok", single

    mcp_cli.cmd_mcp_check(
        Namespace(name=None, all=True, project=None, timeout_s=5, env_from_shell=False, json=True)
    )
    all_payload = json.loads(capsys.readouterr().out)
    rows = all_payload["probes"]

    assert len(rows) == 3
    assert {r["name"] for r in rows} == {"s1", "s2", "s3"}
    assert all(r["state"] == "ok" for r in rows), rows

    cache = mcp_probe.read_probe_cache()
    assert set(cache) == {"s1", "s2", "s3"}


# ─────────────────────────────────────────────────────────────────────────────
# case 37: `hub mcp check` never mutates the registry
# ─────────────────────────────────────────────────────────────────────────────


def test_check_does_not_mutate_the_registry(tmp_data_home):
    from argparse import Namespace

    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub import hub_core

    _seed_registry(tmp_data_home, _mcp_registry())
    registry_path = tmp_data_home / "registry.yaml"
    # `hub_core.load_registry()` schema-migrates an older-shaped registry (adds
    # `permissions_global`/`remotes`/etc.) on its FIRST read and saves once —
    # unrelated to `check`, and every read command triggers it equally. Let
    # that happen before capturing `before`, so the byte-diff below is
    # actually about `check`, not this pre-existing one-time migration.
    hub_core.save_registry(hub_core.load_registry())
    before = registry_path.read_text()

    mcp_cli.cmd_mcp_check(
        Namespace(
            name="demo", all=False, project=None, timeout_s=5, env_from_shell=False, json=True
        )
    )

    after = registry_path.read_text()
    assert before == after


# ─────────────────────────────────────────────────────────────────────────────
# case 38: `hub sync` never probes
# ─────────────────────────────────────────────────────────────────────────────


def test_sync_never_probes(tmp_data_home, monkeypatch):
    import argparse
    import dataclasses

    import hub
    from skill_hub.infrastructure.harnesses import harnesses
    from skill_hub.infrastructure.mcp import mcp_probe

    def _forbidden(*args, **kwargs):
        raise AssertionError("hub sync must never call mcp_probe.probe")

    def _forbidden_shell(*args, **kwargs):
        raise AssertionError("hub sync must never spawn the login shell (C-2)")

    monkeypatch.setattr(mcp_probe, "probe", _forbidden)
    # C-2: the doctor leg used to call `mcp_probe.resolved_env()` EAGERLY on
    # every rollup, spawning the login-shell snapshot regardless of whether
    # any server needed it. Proving `probe` is never called is not enough —
    # this proves the snapshot itself never runs either. Reset the cache to
    # a fresh-process "never snapshotted" state first (the autouse
    # `_no_login_shell` net in conftest.py pre-seeds a cached answer, which
    # would otherwise make this proof vacuous — `resolved_env()` would just
    # reuse the cache and never reach `_snapshot_login_shell_env` at all).
    monkeypatch.setattr(mcp_probe, "_SHELL_ENV_CACHE", None)
    monkeypatch.setattr(mcp_probe, "_snapshot_login_shell_env", _forbidden_shell)

    patched = {h_id: dataclasses.replace(h, detect=(lambda: True)) for h_id, h in harnesses.HARNESSES.items()}
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    _seed_registry(
        tmp_data_home,
        {
            "version": "1",
            "harnesses_global": ["claude-code"],
            "skills": {},
            "bundles": {},
            "projects": {},
        },
    )

    hub.cmd_sync(argparse.Namespace())


# ─────────────────────────────────────────────────────────────────────────────
# plans/G.md §5.1 — per-id JSON-RPC correlation (the wave's BLOCKER)
# ─────────────────────────────────────────────────────────────────────────────


def test_stdio_probe_survives_an_interleaved_notification():
    """A notification arriving between a request and its response must not
    be mistaken for the response — pins the correlation fix that made
    position-based reading unsafe once more than one request/response pair
    shares the pipe."""
    from skill_hub.infrastructure.mcp import mcp_probe

    spec = _stdio_spec("s", FIXTURES / "stdio_interleaved_notification.py")
    row, _record = mcp_probe.probe(spec, timeout_s=5, from_shell=False)

    assert row["state"] == "ok", row
    assert row["tools"] == ["tool_a", "tool_b"]


def test_stdio_probe_survives_a_bare_non_json_line():
    """A stray non-JSON line before the real response must be discarded as
    noise, not misread as the response (which would then also misattribute
    the REAL response to the next request)."""
    from skill_hub.infrastructure.mcp import mcp_probe

    spec = _stdio_spec("s", FIXTURES / "stdio_bare_line.py")
    row, _record = mcp_probe.probe(spec, timeout_s=5, from_shell=False)

    assert row["state"] == "ok", row
    assert row["tools"] == ["tool_a"]


# ─────────────────────────────────────────────────────────────────────────────
# plans/G.md §11 rev 3 — the protocol bump + the one-retry fallback
# ─────────────────────────────────────────────────────────────────────────────


def test_protocol_version_constants():
    from skill_hub.infrastructure.mcp import mcp_probe

    assert mcp_probe.PROTOCOL_VERSION == "2025-06-18"
    assert mcp_probe.PROTOCOL_VERSION_FALLBACK == "2024-11-05"


def test_stdio_probe_negotiates_down_when_server_replies_with_an_older_version():
    """`stdio_ok.py` always answers with `2024-11-05` regardless of what we
    asked for — the conformant "downgrade and proceed" path. No retry
    happens (the FIRST attempt already succeeds)."""
    from skill_hub.infrastructure.mcp import mcp_probe

    spec = _stdio_spec("s", FIXTURES / "stdio_ok.py")
    row, record = mcp_probe.probe(spec, timeout_s=5, from_shell=False, catalog=True)

    assert row["state"] == "ok"
    assert row["protocol_version"] == "2024-11-05"
    assert record is not None
    assert record["protocol_fallback"] is False


def test_stdio_probe_falls_back_once_on_a_sloppy_servers_protocol_error():
    """§11.2: a server that ERRORS on `initialize` for `2025-06-18` but
    succeeds when retried with `2024-11-05` must still read `ok` overall,
    with `protocol_fallback: true` recorded in the catalogue."""
    from skill_hub.infrastructure.mcp import mcp_probe

    spec = _stdio_spec("s", FIXTURES / "stdio_negotiate_fallback.py")
    row, record = mcp_probe.probe(spec, timeout_s=5, from_shell=False, catalog=True)

    assert row["state"] == "ok", row
    assert row["protocol_version"] == "2024-11-05"
    assert record is not None
    assert record["protocol_fallback"] is True
    assert record["protocol_version"] == "2024-11-05"


# ─────────────────────────────────────────────────────────────────────────────
# plans/G.md §5.4/§4 — optimistic catalogue probing, the one-exit rule
# ─────────────────────────────────────────────────────────────────────────────


def test_catalog_treats_dash32601_as_not_offered_never_an_error():
    from skill_hub.infrastructure.mcp import mcp_probe

    spec = _stdio_spec("s", FIXTURES / "stdio_catalog_not_offered.py")
    row, record = mcp_probe.probe(spec, timeout_s=5, from_shell=False, catalog=True)

    assert row["state"] == "ok"
    assert record is not None
    assert record["offered"] == {
        "tools": True,
        "resources": False,
        "resource_templates": False,
        "prompts": False,
    }
    assert record["fetch_errors"] == []
    assert record["server_name"] == "demo-server"
    assert record["server_version"] == "1.2.3"
    tool = record["tools"][0]
    assert tool["name"] == "tool_a"
    assert tool["parameters"] == [
        {
            "name": "x",
            "type": "string",
            "required": False,
            "description": None,
            "enum": None,
            "enum_truncated": False,
            "default": None,
            "items_type": None,
        }
    ]


def test_catalog_continues_pagination_from_the_liveness_first_page():
    """`tools/list`'s first page is already in hand from the liveness step
    (no extra call) — pagination continues from its `nextCursor` alone."""
    from skill_hub.infrastructure.mcp import mcp_probe

    spec = _stdio_spec("s", FIXTURES / "stdio_paginated_tools.py")
    row, record = mcp_probe.probe(spec, timeout_s=5, from_shell=False, catalog=True)

    assert row["state"] == "ok"
    assert record is not None
    assert [t["name"] for t in record["tools"]] == ["tool_a", "tool_b"]
    assert record["truncated"]["tools"] is False


def test_catalog_a_server_that_exits_right_after_tools_list_still_reads_ok():
    """The load-bearing §4 rule, pinned directly: `stdio_ok.py` exits right
    after answering `tools/list`. Every subsequent catalogue call must fail
    into `fetch_errors`/`offered: false`, and the row must still be `ok` —
    never flip to `unreachable`."""
    from skill_hub.infrastructure.mcp import mcp_probe

    spec = _stdio_spec("s", FIXTURES / "stdio_ok.py")
    row, record = mcp_probe.probe(spec, timeout_s=5, from_shell=False, catalog=True)

    assert row["state"] == "ok"
    assert record is not None
    assert record["offered"]["resources"] is False
    assert record["offered"]["prompts"] is False


def test_probe_catalog_defaults_to_false_for_every_pre_existing_caller():
    """plans/G.md §5.12: `catalog` defaults to `False`, so a caller that
    never asked for it gets no record, by construction."""
    from skill_hub.infrastructure.mcp import mcp_probe

    spec = _stdio_spec("s", FIXTURES / "stdio_ok.py")
    row, record = mcp_probe.probe(spec, timeout_s=5, from_shell=False)

    assert row["state"] == "ok"
    assert record is None


# ─────────────────────────────────────────────────────────────────────────────
# http: notifications/initialized (§5.2) + MCP-Protocol-Version (§11.3) +
# the fallback retry (§11.2)
# ─────────────────────────────────────────────────────────────────────────────


def test_http_probe_sends_notifications_initialized(monkeypatch):
    from skill_hub.domain.mcp import mcp_spec
    from skill_hub.infrastructure.mcp import mcp_probe

    requests = []
    responses = [
        {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2025-06-18"}},
        None,  # the notification's response body is never parsed
        {"jsonrpc": "2.0", "id": 2, "result": {"tools": [{"name": "a"}]}},
    ]

    def _fake_urlopen(req, timeout=None):
        requests.append(req)
        payload = responses.pop(0)
        if payload is None:
            return _FakeHttpResponse({}, headers={"Content-Type": "application/json"})
        return _FakeHttpResponse(payload)

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)

    spec = mcp_spec.McpServerSpec(name="s", transport="http", url="https://example.test/mcp")
    row, _record = mcp_probe.probe(spec, env={}, from_shell=False)

    assert row["state"] == "ok", row
    assert len(requests) == 3
    methods = [json.loads(r.data)["method"] for r in requests]
    assert methods == ["initialize", "notifications/initialized", "tools/list"]


def test_http_probe_sends_mcp_protocol_version_header_after_init(monkeypatch):
    from skill_hub.domain.mcp import mcp_spec
    from skill_hub.infrastructure.mcp import mcp_probe

    requests = []
    responses = [
        {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2025-06-18"}},
        None,
        {"jsonrpc": "2.0", "id": 2, "result": {"tools": []}},
    ]

    def _fake_urlopen(req, timeout=None):
        requests.append(req)
        payload = responses.pop(0)
        if payload is None:
            return _FakeHttpResponse({}, headers={"Content-Type": "application/json"})
        return _FakeHttpResponse(payload)

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)

    spec = mcp_spec.McpServerSpec(name="s", transport="http", url="https://example.test/mcp")
    row, _record = mcp_probe.probe(spec, env={}, from_shell=False)

    assert row["state"] == "ok", row
    # `initialize` (request 0) never carries the header — it IS the negotiation.
    assert requests[0].get_header("Mcp-protocol-version") is None
    assert requests[1].get_header("Mcp-protocol-version") == "2025-06-18"
    assert requests[2].get_header("Mcp-protocol-version") == "2025-06-18"


def test_http_probe_falls_back_once_on_a_protocol_error_at_initialize(monkeypatch):
    from skill_hub.domain.mcp import mcp_spec
    from skill_hub.infrastructure.mcp import mcp_probe

    # First four calls: initialize (error), initialize retry (ok),
    # notifications/initialized (no body read), tools/list (ok). Anything
    # after that is the catalogue's three added calls — a `-32601` for each
    # keeps the test focused on the fallback, not the catalogue's own shape.
    responses = [
        {"jsonrpc": "2.0", "id": 1, "error": {"code": -32602, "message": "nope"}},
        {"jsonrpc": "2.0", "id": 2, "result": {"protocolVersion": "2024-11-05"}},
        None,
        {"jsonrpc": "2.0", "id": 3, "result": {"tools": [{"name": "a"}]}},
    ]
    not_offered_ids = iter((4, 5, 6))

    def _fake_urlopen(req, timeout=None):
        payload = responses.pop(0) if responses else {
            "jsonrpc": "2.0",
            "id": next(not_offered_ids),
            "error": {"code": -32601, "message": "nope"},
        }
        if payload is None:
            return _FakeHttpResponse({}, headers={"Content-Type": "application/json"})
        return _FakeHttpResponse(payload)

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)

    spec = mcp_spec.McpServerSpec(name="s", transport="http", url="https://example.test/mcp")
    row, record = mcp_probe.probe(spec, env={}, from_shell=False, catalog=True)

    assert row["state"] == "ok", row
    assert row["protocol_version"] == "2024-11-05"
    assert record is not None
    assert record["protocol_fallback"] is True


# ─────────────────────────────────────────────────────────────────────────────
# `hub mcp check`'s catalogue defaults (§5.3, §5.12) + `hub mcp catalog`
# ─────────────────────────────────────────────────────────────────────────────


def test_check_single_name_fetches_catalog_by_default(tmp_data_home, capsys):
    from argparse import Namespace

    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.infrastructure.mcp import mcp_catalog

    _seed_registry(tmp_data_home, _mcp_registry())

    mcp_cli.cmd_mcp_check(
        Namespace(
            name="demo", all=False, project=None, timeout_s=5, env_from_shell=False, json=True
        )
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["state"] == "ok"
    assert "catalog" in payload
    assert mcp_catalog.read_catalog("demo") is not None


def test_check_persists_catalog_summary_for_mcp_show(tmp_data_home, capsys):
    from argparse import Namespace

    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed_registry(tmp_data_home, _mcp_registry())
    mcp_cli.cmd_mcp_check(
        Namespace(name="demo", all=False, project=None, timeout_s=5, env_from_shell=False, json=True)
    )
    capsys.readouterr()
    mcp_cli.cmd_mcp_show(Namespace(name="demo", json=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["last_probe"]["catalog"]["offered"]["tools"] is True


def test_check_no_catalog_flag_skips_and_deletes_stale_catalog(tmp_data_home, capsys):
    from argparse import Namespace

    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.infrastructure.mcp import mcp_catalog

    _seed_registry(tmp_data_home, _mcp_registry())
    mcp_catalog.write_catalog("demo", {"schema_version": 1, "name": "demo", "tools": []})

    mcp_cli.cmd_mcp_check(
        Namespace(
            name="demo",
            all=False,
            project=None,
            timeout_s=5,
            env_from_shell=False,
            catalog=False,
            catalog_timeout_s=15,
            json=True,
        )
    )
    payload = json.loads(capsys.readouterr().out)
    assert "catalog" not in payload or payload.get("catalog") is None
    assert mcp_catalog.read_catalog("demo") is None


def test_check_all_defaults_to_no_catalog(tmp_data_home, capsys):
    """plans/G.md §5.3: `--all` never fetches the catalogue unless
    `--catalog` is explicitly passed — the app never runs `--all`."""
    from argparse import Namespace

    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.infrastructure.mcp import mcp_catalog

    _seed_registry(tmp_data_home, _mcp_registry())

    mcp_cli.cmd_mcp_check(
        Namespace(name=None, all=True, project=None, timeout_s=5, env_from_shell=False, json=True)
    )
    capsys.readouterr()
    assert mcp_catalog.read_catalog("demo") is None


def test_mcp_catalog_command_prints_ok_payload(tmp_data_home, capsys):
    from argparse import Namespace

    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.infrastructure.mcp import mcp_catalog

    _seed_registry(tmp_data_home, _mcp_registry())
    record = {"schema_version": 1, "name": "demo", "tools": [{"name": "a"}]}
    mcp_catalog.write_catalog("demo", record)

    mcp_cli.cmd_mcp_catalog(Namespace(name="demo", json=True, instructions=False))
    payload = json.loads(capsys.readouterr().out)
    assert payload == {"ok": True, "catalog": record}


def test_mcp_catalog_command_fails_closed_when_nothing_fetched(tmp_data_home, capsys):
    from argparse import Namespace

    import skill_hub.entrypoints.cli.mcp as mcp_cli

    _seed_registry(tmp_data_home, _mcp_registry())

    with pytest.raises(SystemExit):
        mcp_cli.cmd_mcp_catalog(Namespace(name="demo", json=True, instructions=False))
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["code"] == "no_catalog"


def test_mcp_catalog_command_never_probes(tmp_data_home, monkeypatch, capsys):
    from argparse import Namespace

    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.infrastructure.mcp import mcp_probe

    _seed_registry(tmp_data_home, _mcp_registry())

    def _forbidden(*args, **kwargs):
        raise AssertionError("hub mcp catalog must never probe")

    monkeypatch.setattr(mcp_probe, "probe", _forbidden)

    with pytest.raises(SystemExit):
        mcp_cli.cmd_mcp_catalog(Namespace(name="demo", json=True, instructions=False))


def test_check_and_catalog_argparse_options_real_parser(tmp_data_home, capsys, monkeypatch):
    """Every new argparse option needs one real `hub.main()` + `sys.argv`
    test — a hand-built `Namespace` cannot see a `dest` collision."""
    import hub

    _seed_registry(tmp_data_home, _mcp_registry())

    monkeypatch.setattr(
        sys, "argv", ["hub", "mcp", "check", "demo", "--no-catalog", "--json"]
    )
    hub.main()
    payload = json.loads(capsys.readouterr().out)
    assert payload["state"] == "ok"
    assert "catalog" not in payload or payload.get("catalog") is None

    monkeypatch.setattr(
        sys,
        "argv",
        ["hub", "mcp", "check", "demo", "--catalog", "--catalog-timeout-s", "3", "--json"],
    )
    hub.main()
    payload2 = json.loads(capsys.readouterr().out)
    assert payload2["state"] == "ok"
    assert payload2.get("catalog") is not None

    monkeypatch.setattr(sys, "argv", ["hub", "mcp", "catalog", "demo", "--json"])
    hub.main()
    payload3 = json.loads(capsys.readouterr().out)
    assert payload3["ok"] is True
    assert "catalog" in payload3


# ─────────────────────────────────────────────────────────────────────────────
# plans/G.md §5.13 — removal paths delete the catalogue + probe row together
# ─────────────────────────────────────────────────────────────────────────────


def test_forget_server_deletes_both_catalog_and_probe_row(tmp_data_home):
    from skill_hub.infrastructure.mcp import mcp_catalog, mcp_probe

    mcp_probe.write_probe_cache("demo", {"name": "demo", "state": "ok", "checked_at": "2026-01-01T00:00:00Z"})
    mcp_catalog.write_catalog("demo", {"schema_version": 1, "name": "demo", "tools": []})

    mcp_probe.forget_server("demo")

    assert "demo" not in mcp_probe.read_probe_cache()
    assert mcp_catalog.read_catalog("demo") is None


def test_forget_server_is_idempotent_when_nothing_exists(tmp_data_home):
    from skill_hub.infrastructure.mcp import mcp_probe

    mcp_probe.forget_server("never-existed")  # must not raise


def test_archive_deletes_catalog_and_probe_row(tmp_data_home, capsys):
    """`hub archive <mcp-server-name>` is one of the three removal hooks
    (plans/G.md §5.13) — it must call `mcp_probe.forget_server`, not just
    remove the registry entry."""
    from argparse import Namespace

    import skill_hub.entrypoints.cli.archive as archive_mod
    from skill_hub.infrastructure.mcp import mcp_catalog, mcp_probe

    registry = _mcp_registry("demo")
    # `cmd_archive` calls `skill_meta.skill_source`, which fails closed on a
    # `None` source (the control-plane shape `_mcp_registry` otherwise
    # produces) — give it a plausible, non-existent path so archiving
    # proceeds without trying to move anything.
    registry["skills"]["demo"]["source"] = str(tmp_data_home / "mcp-servers" / "demo")
    _seed_registry(tmp_data_home, registry)
    mcp_probe.write_probe_cache("demo", {"name": "demo", "state": "ok", "checked_at": "2026-01-01T00:00:00Z"})
    mcp_catalog.write_catalog("demo", {"schema_version": 1, "name": "demo", "tools": []})

    archive_mod.cmd_archive(Namespace(skills=["demo"], dry_run=False, json=False))
    capsys.readouterr()

    assert "demo" not in mcp_probe.read_probe_cache()
    assert mcp_catalog.read_catalog("demo") is None
