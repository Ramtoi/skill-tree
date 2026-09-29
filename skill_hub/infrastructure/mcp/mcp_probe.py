"""MCP liveness probe — stdio/http handshake, the login-shell env snapshot,
the on-disk probe cache, and (plans/G.md, wave G1) the capability catalogue
fetch folded into the same handshake.

`hub mcp check` is the only thing that spawns a subprocess or opens a network
connection for an MCP server (plans/C.md §2 truth 3: "does the server
answer?"). `hub sync` never calls anything in this module for that purpose —
`mcp_delivery.doctor_findings`'s `MCP_PROBE_STALE` reads the on-disk cache
only, never `probe`/`probe_all`.

A leaf: at module scope this imports stdlib + `mcp_spec` + `hub_core` +
`mcp_catalog` only — never `hub` (`tests/test_hub_split_guard.py::LEAF_SIBLINGS`
enforces this).

### `${VAR}` resolution (M5)

The app launches `hub` from Tauri, so the child inherits the GUI (launchd)
environment, not the user's shell rc — every token exported only in
`.zshrc`/`.bashrc` is invisible there. `resolved_env()` therefore reads, in
order: (1) the hub process environment, then (2) a once-per-process snapshot
of the user's login shell (`[$SHELL, "-lic", "env -0"]`, 3s timeout, cached in
a module global). A snapshot failure (no `$SHELL`, non-zero exit, timeout) is
not an error — the snapshot is empty and `from_shell_ok` is False, and the
probe still runs against the process env alone.

### The probe cache

`<data_home>/state/mcp/probes.json` = `{"schema_version": 1, "probes": {name:
<probe row>}}`. `read_probe_cache()` returns just the inner `probes` mapping;
a corrupt file warns to stderr and reads as empty rather than raising.

### The capability catalogue (plans/G.md, rev 3 §11)

**The load-bearing rule:** a catalogue fetch can never change the probe
`state`. Liveness stays exactly `initialize` + `tools/list`. Concretely: once
the `tools/list` result is in hand, `_probe_stdio`/`_probe_http` have exactly
ONE exit and it is the `ok` row — every catalogue call (`resources/list`,
`resources/templates/list`, `prompts/list`, and continued pagination of any
of the four) is wrapped so a write failure, a read failure, a deadline hit, a
JSON error, and a JSON-RPC error all land in `fetch_errors` and never
`return` early. Every kind is called optimistically (never gated on the
declared `capabilities`, which real servers under-declare): a JSON-RPC
`-32601` (Method not found) means "not offered" — an absence, never an
error.

`PROTOCOL_VERSION` is `2025-06-18` (rev 3), which makes `title`,
`outputSchema`, and `annotations` reachable. Because a sloppy (non-conformant)
server might error instead of downgrading on its own, `initialize` retries
ONCE with `PROTOCOL_VERSION_FALLBACK` ("2024-11-05") on a `protocol_error` —
and ONLY then, and ONLY at `initialize` — so a server that is green today
cannot go red from the bump. The http transport must send
`MCP-Protocol-Version: <negotiated>` on every request after `initialize`
(2025-06-18 requires it); the stdio transport has no such header.

`probe()` returns `(row, record | None)` — the record is never smuggled into
the row (it would land in `probes.json` and ride through `hub mcp show`'s
`last_probe`, which the app reads on every panel mount). `catalog` defaults
to `False`, so every pre-existing caller of `probe()`/`probe_all()` is
unchanged by construction; only `hub mcp check` (never `--all` by default)
passes `catalog=True`. Persisting the record (`mcp_catalog.write_catalog`) is
the CALLER's job, same as `write_probe_cache` today.
"""

from __future__ import annotations

import itertools
import json
import os
import re
import selectors
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Mapping, Optional

from skill_hub import hub_core
from skill_hub.domain.mcp import mcp_spec
from skill_hub.infrastructure.mcp import mcp_catalog

__all__ = [
    "PROBE_STATES",
    "PROTOCOL_VERSION",
    "PROTOCOL_VERSION_FALLBACK",
    "CATALOG_TIMEOUT_S_DEFAULT",
    "resolved_env",
    "probe",
    "probe_all",
    "probe_cache_path",
    "read_probe_cache",
    "write_probe_cache",
    "delete_probe_cache_row",
    "forget_server",
    "cache_age_summary",
]

PROBE_STATES: frozenset = frozenset(
    {"ok", "unresolved_ref", "unreachable", "protocol_error", "timeout", "unsupported"}
)

#: Rev 3 (plans/G.md §11, user-approved 2026-09-07): bumped from 2024-11-05 so
#: `title` (2025-06-18), `outputSchema` (2025-06-18), and `annotations`
#: (2025-03-26) are all reachable. See `_negotiate_*` for the one-retry
#: fallback that keeps this non-regressive.
PROTOCOL_VERSION = "2025-06-18"
#: The ONLY version `initialize` is ever retried with, and ONLY on a
#: `protocol_error` at `initialize` itself (§11.2).
PROTOCOL_VERSION_FALLBACK = "2024-11-05"
#: Whole-catalogue budget default (§5.3) — separate from liveness's
#: `--timeout-s` (default 10). Worst case per server is therefore 25s.
CATALOG_TIMEOUT_S_DEFAULT = 15

_SHELL_SNAPSHOT_TIMEOUT = 3
_STDIO_WAIT_AFTER_KILL = 2
_CACHE_SCHEMA_VERSION = 1
#: A response whose matching `id` never arrives after draining this many
#: lines (notifications, stray non-JSON output, responses to some other
#: request) is treated the same as a deadline hit (§5.1).
MAX_DRAINED_LINES = 50
MAX_HTTP_BYTES = 2_000_000
MAX_HTTP_EVENTS = 50

# ─────────────────────────────────────────────────────────────────────────────
# `${VAR}` / `${VAR:-default}` substitution — the same grammar as
# `mcp_spec._REF_RE`, reimplemented here (mcp_spec exposes `ref_names` for
# extraction, not substitution) so this module stays a stdlib + mcp_spec leaf.
# ─────────────────────────────────────────────────────────────────────────────

_REF_SUB_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")


def _substitute(value: Optional[str], env_map: Mapping[str, str], missing: set) -> Optional[str]:
    """Replace every `${VAR}`/`${VAR:-default}` in `value` from `env_map`.

    A name with no default and not in `env_map` is added to `missing` (the
    literal `${VAR}` text is left in place — irrelevant, since a non-empty
    `missing` short-circuits before anything is used).
    """
    if value is None:
        return None

    def _repl(m: "re.Match") -> str:
        name = m.group(1)
        default = m.group(2)
        if name in env_map:
            return env_map[name]
        if default is not None:
            return default
        missing.add(name)
        return m.group(0)

    return _REF_SUB_RE.sub(_repl, value)


# ─────────────────────────────────────────────────────────────────────────────
# Login-shell env snapshot (M5)
# ─────────────────────────────────────────────────────────────────────────────

#: `(env, ok)` — cached once per process. `None` = not yet attempted.
_SHELL_ENV_CACHE: Optional[tuple] = None


def _snapshot_login_shell_env() -> tuple:
    """`(env, ok)` from `[$SHELL, "-lic", "env -0"]`. Never raises.

    A missing `$SHELL`, a non-zero exit, or a timeout all degrade to an empty
    snapshot with `ok=False` — never an error.
    """
    shell = os.environ.get("SHELL")
    if not shell:
        return {}, False
    try:
        proc = subprocess.run(
            [shell, "-lic", "env -0"],
            capture_output=True,
            timeout=_SHELL_SNAPSHOT_TIMEOUT,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {}, False
    if proc.returncode != 0:
        return {}, False
    env: dict = {}
    raw = proc.stdout.decode("utf-8", errors="replace") if isinstance(proc.stdout, bytes) else str(
        proc.stdout or ""
    )
    for entry in raw.split("\0"):
        if not entry or "=" not in entry:
            continue
        key, _, val = entry.partition("=")
        env[key] = val
    return env, True


def resolved_env(*, from_shell: bool = True) -> tuple:
    """`(env, from_shell_ok)` — the hub process env, with the login-shell
    snapshot filling in any name the process env does not already carry.

    `from_shell=False` skips the snapshot entirely (no subprocess spawned) and
    always reports `ok=False`. The snapshot itself runs at most once per
    process — a second call reuses the cached result.
    """
    global _SHELL_ENV_CACHE

    base = dict(os.environ)
    if not from_shell:
        return base, False

    if _SHELL_ENV_CACHE is None:
        _SHELL_ENV_CACHE = _snapshot_login_shell_env()
    shell_env, ok = _SHELL_ENV_CACHE
    merged = {**shell_env, **base}
    return merged, ok


# ─────────────────────────────────────────────────────────────────────────────
# The row
# ─────────────────────────────────────────────────────────────────────────────


def _row(
    name: str,
    transport: str,
    state: str,
    *,
    tool_count: Optional[int] = None,
    tools=(),
    tool_schemas=(),
    latency_ms: Optional[int] = None,
    protocol_version: Optional[str] = None,
    unresolved_refs=(),
    env_from_shell: bool = True,
    error: Optional[str] = None,
) -> dict:
    return {
        "name": name,
        "transport": transport,
        "state": state,
        "tool_count": tool_count,
        "tools": list(tools),
        "tool_schemas": list(tool_schemas),
        "latency_ms": latency_ms,
        "protocol_version": protocol_version,
        "unresolved_refs": sorted(unresolved_refs),
        "env_from_shell": env_from_shell,
        "error": error,
        "checked_at": hub_core._now_iso(),
    }


def _tool_names(result_obj: object) -> list:
    tools = result_obj.get("tools") if isinstance(result_obj, dict) else None
    if not isinstance(tools, list):
        return []
    return [t.get("name") for t in tools if isinstance(t, dict) and t.get("name")]


def _tool_schemas(result_obj: object) -> list:
    """Full `tools/list` rows (name, description, inputSchema), for the
    footprint composer's MCP-schema part. Reads the same `result_obj` as
    `_tool_names`, so a tool with no name is dropped from both lists."""
    tools = result_obj.get("tools") if isinstance(result_obj, dict) else None
    if not isinstance(tools, list):
        return []
    out = []
    for t in tools:
        if not isinstance(t, dict) or not t.get("name"):
            continue
        out.append(
            {
                "name": t.get("name"),
                "description": t.get("description"),
                "inputSchema": t.get("inputSchema"),
            }
        )
    return out


def _client_info() -> dict:
    return {"name": "skill-hub", "version": hub_core.hub_version()}


def _initialize_request(req_id: int, protocol_version: str) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "method": "initialize",
        "params": {
            "protocolVersion": protocol_version,
            "capabilities": {},
            "clientInfo": _client_info(),
        },
    }


def _list_request(req_id: int, method: str, cursor: Optional[str] = None) -> dict:
    params = {"cursor": cursor} if cursor else {}
    return {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}


def _tools_list_request(req_id: int) -> dict:
    return _list_request(req_id, "tools/list")


# ─────────────────────────────────────────────────────────────────────────────
# The catalogue — kind/method/item-key table + pagination + assembly, shared
# by both transports. Only the per-transport `call_fn` differs.
# ─────────────────────────────────────────────────────────────────────────────

#: `(record key, JSON-RPC method, wire result key)` — the three ADDED
#: methods (plans/G.md §5.4). `tools/list` is handled separately because its
#: first page is already in hand from the liveness step.
_CATALOG_KIND_SPECS = (
    ("resources", "resources/list", "resources"),
    ("resource_templates", "resources/templates/list", "resourceTemplates"),
    ("prompts", "prompts/list", "prompts"),
)

#: Sentinel `call_fn` error meaning "the server answered -32601 for this
#: method" — an absence, never a `fetch_errors` entry (plans/G.md §5.4).
_NOT_OFFERED = "not_offered"


def _fetch_paginated(call_fn: Callable, item_key: str, *, first_page: object = None) -> tuple:
    """`(items, truncated, error)` for one paginated list method.

    `call_fn(cursor) -> (result | None, error | None)`, where `error` is
    `_NOT_OFFERED`, another error string, or `None` on success. Pagination
    stops on `items >= mcp_catalog.ITEM_LIMIT` OR `pages >=
    mcp_catalog.PAGE_LIMIT` (plans/G.md §5.6 — `PAGE_LIMIT` alone bounds
    nothing: one item per page hits `ITEM_LIMIT` at 500 pages, a thousand
    items on page one blows past it immediately). `first_page`, when given
    (the liveness `tools/list` result), is consumed as page one WITHOUT an
    extra call — `tools/list` is therefore never `_NOT_OFFERED`, matching the
    fact that a probe already in the catalogue phase always has one already.
    """
    items: list = []
    truncated = False
    pages = 0
    cursor: Optional[str] = None
    page_result = first_page

    while True:
        if page_result is None:
            result, err = call_fn(cursor)
            if err == _NOT_OFFERED:
                return items, truncated, (_NOT_OFFERED if pages == 0 else None)
            if err is not None:
                return items, truncated, err
            page_result = result
        pages += 1
        raw_items = page_result.get(item_key) if isinstance(page_result, dict) else None
        if isinstance(raw_items, list):
            items.extend(raw_items)
        if len(items) >= mcp_catalog.ITEM_LIMIT:
            items = items[: mcp_catalog.ITEM_LIMIT]
            truncated = True
            break
        if pages >= mcp_catalog.PAGE_LIMIT:
            if isinstance(page_result, dict) and page_result.get("nextCursor"):
                truncated = True
            break
        cursor = page_result.get("nextCursor") if isinstance(page_result, dict) else None
        if not cursor:
            break
        page_result = None

    return items, truncated, None


def _run_catalog_phase(
    call_fn: Callable,
    first_tools_page: object,
    *,
    name: str,
    transport: str,
    protocol_version: Optional[str],
    protocol_fallback: bool,
    init_result: object,
) -> dict:
    """Call all three added kinds (plus continued `tools/list` pagination)
    and hand the raw wire objects to `mcp_catalog.build_record`. The ONLY
    thing that differs by transport is `call_fn(method, cursor) -> (result |
    None, error | None)`."""
    tools_items, tools_truncated, tools_err = _fetch_paginated(
        lambda cursor: call_fn("tools/list", cursor), "tools", first_page=first_tools_page
    )
    offered = {"tools": True}
    truncated = {"tools": tools_truncated}
    fetch_errors: list = []
    if tools_err not in (None, _NOT_OFFERED):
        fetch_errors.append({"method": "tools/list", "error": tools_err})

    raw_map: dict = {}
    for kind, method, item_key in _CATALOG_KIND_SPECS:
        items, was_truncated, err = _fetch_paginated(
            lambda cursor, m=method: call_fn(m, cursor), item_key
        )
        raw_map[kind] = items
        truncated[kind] = was_truncated
        if err == _NOT_OFFERED:
            offered[kind] = False
        elif err is not None:
            offered[kind] = False
            fetch_errors.append({"method": method, "error": err})
        else:
            offered[kind] = True

    server_info = init_result.get("serverInfo") if isinstance(init_result, dict) else None
    return mcp_catalog.build_record(
        name=name,
        transport=transport,
        protocol_version=protocol_version,
        protocol_fallback=protocol_fallback,
        server_name=server_info.get("name") if isinstance(server_info, dict) else None,
        server_version=server_info.get("version") if isinstance(server_info, dict) else None,
        server_title=server_info.get("title") if isinstance(server_info, dict) else None,
        instructions=init_result.get("instructions") if isinstance(init_result, dict) else None,
        capabilities=init_result.get("capabilities") if isinstance(init_result, dict) else None,
        raw_tools=tools_items,
        raw_resources=raw_map["resources"],
        raw_resource_templates=raw_map["resource_templates"],
        raw_prompts=raw_map["prompts"],
        offered=offered,
        truncated=truncated,
        fetch_errors=fetch_errors,
    )


# ─────────────────────────────────────────────────────────────────────────────
# stdio handshake
# ─────────────────────────────────────────────────────────────────────────────


def _write_line(proc: "subprocess.Popen", obj: dict) -> bool:
    try:
        assert proc.stdin is not None
        proc.stdin.write(json.dumps(obj) + "\n")
        proc.stdin.flush()
        return True
    except (BrokenPipeError, OSError, ValueError):
        return False


class _LineReader:
    """A buffered, `select()`-driven line reader over a child's stdout.

    `select()` on the raw fd only reports readiness for bytes not yet
    pulled off the OS pipe — it says nothing about lines already sitting in
    a Python-level read buffer. A plain `TextIOWrapper.readline()` after one
    `select()`-gated read can silently swallow a SECOND line the child
    flushed in the same burst (e.g. a notification immediately followed by
    its response, exactly the shape §5.1 exists to correlate), so a
    following `select()` call reports "nothing new" and a real, already-
    buffered line reads as a spurious timeout. This class keeps its own
    byte buffer across calls and only calls `select()` when that buffer has
    no complete line left — reading straight off the raw fd via `os.read`,
    never through `proc.stdout`'s own buffering.
    """

    def __init__(self, proc: "subprocess.Popen") -> None:
        assert proc.stdout is not None
        self._fd = proc.stdout.fileno()
        self._buf = b""
        self._sel = selectors.DefaultSelector()
        self._sel.register(self._fd, selectors.EVENT_READ)
        self._eof = False
        #: Lines that were not JSON-RPC at all, drained while waiting for the
        #: CURRENT response. Reset by every `_read_response` call, so a
        #: startup banner drained before `initialize`'s reply cannot still be
        #: colouring the verdict on a later request. Non-zero at the point of
        #: giving up means the child DID write to stdout and what it wrote was
        #: not MCP — `protocol_error`, not `unreachable`. See
        #: `_no_answer_state`.
        self.non_json_lines = 0

    @property
    def eof(self) -> bool:
        return self._eof

    def readline(self, deadline: float) -> Optional[str]:
        """One line (newline included, decoded as UTF-8), or `None` on
        timeout/EOF. A line still pending at EOF (no trailing `\\n`) is
        returned once, then `None` on every call after."""
        while True:
            nl = self._buf.find(b"\n")
            if nl != -1:
                line = self._buf[: nl + 1]
                self._buf = self._buf[nl + 1 :]
                return line.decode("utf-8", errors="replace")
            if len(self._buf) > MAX_HTTP_BYTES:
                # A server must not hold an unbounded unterminated JSON line
                # in memory while the shared catalogue deadline is running.
                self._buf = b""
                self.non_json_lines += 1
                return None
            if self._eof:
                if self._buf:
                    line = self._buf
                    self._buf = b""
                    return line.decode("utf-8", errors="replace")
                return None
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            events = self._sel.select(timeout=remaining)
            if not events:
                return None
            try:
                chunk = os.read(self._fd, 65536)
            except OSError:
                return None
            if not chunk:
                self._eof = True
                continue
            self._buf += chunk

    def close(self) -> None:
        try:
            self._sel.close()
        except OSError:
            pass


def _read_response(reader: "_LineReader", deadline: float, want_id: int) -> Optional[dict]:
    """Drain lines from `reader` until one is a JSON object whose `id`
    equals `want_id`, discarding everything else — a notification (a
    `"method"` key, no `"id"`), a bare non-JSON line, or a response to some
    OTHER request — all under the same `deadline`, up to `MAX_DRAINED_LINES`
    (plans/G.md §5.1, the load-bearing per-id correlation fix).

    A response whose `id` never turns up is indistinguishable from a plain
    timeout/EOF to every caller: both return `None` here, and the caller
    tells "unreachable" from "timeout" via `proc.poll()`, same as before this
    fix. This means a lone unparseable/garbage line with NO valid response
    ever following it now reads as `unreachable`/`timeout`, not
    `protocol_error` — `protocol_error` is reserved for a well-formed
    JSON-RPC response (right `id`, but an `error` object or no `result`),
    which is the only shape actually worth telling apart from "nothing
    answered".
    """
    reader.non_json_lines = 0
    for _ in range(MAX_DRAINED_LINES):
        line = reader.readline(deadline)
        if line is None:
            return None
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            reader.non_json_lines += 1
            continue
        if not isinstance(msg, dict):
            # Valid JSON, but not a JSON-RPC message object (a bare scalar or
            # a list) — still "spoke, but not MCP".
            reader.non_json_lines += 1
            continue
        if msg.get("id") == want_id:
            return msg
        # A notification (no "id") or a response to a different request:
        # noise under the per-id correlation rule — keep draining.
    return None


def _no_answer_state(proc: "subprocess.Popen", reader: "_LineReader") -> str:
    """The row state when a correlated response never arrived.

    `unreachable` and `timeout` both mean "nothing usable came back", and the
    child's exit status tells them apart. But if the child wrote lines that
    were not JSON-RPC at all *while we were waiting for this very response*,
    we demonstrably DID reach it and it demonstrably did not speak MCP — that
    is `protocol_error`, and saying "could not reach the server" instead
    would be false. The count is per-request (`_read_response` resets it), so
    a startup banner that preceded a perfectly good `initialize` reply does
    not mislabel a genuine `timeout` on a later request.

    This also restores the pre-wave-G verdict for a garbage-emitting server:
    before per-id correlation, an unparseable line at the expected position
    read as `protocol_error` directly. Draining it as noise (§5.1) must not
    silently downgrade that diagnosis.
    """
    if reader.non_json_lines:
        return "protocol_error"
    # Pipe EOF can precede the process becoming waitable.
    return "unreachable" if reader.eof or proc.poll() is not None else "timeout"


def _stop_process(proc: "subprocess.Popen") -> None:
    """Kill + reap `proc`. Never leaves a child behind, whatever the exit path."""
    if proc.poll() is None:
        try:
            proc.kill()
        except OSError:
            pass
    try:
        proc.wait(timeout=_STDIO_WAIT_AFTER_KILL)
    except subprocess.TimeoutExpired:
        pass


def _stdio_negotiate(
    proc: "subprocess.Popen",
    reader: "_LineReader",
    deadline: float,
    ids: "itertools.count",
    env_from_shell_ok: bool,
    name: str,
    transport: str,
) -> tuple:
    """`(init_result, protocol_version, protocol_fallback, err_row | None)`.

    On a `protocol_error` at `initialize` — a well-formed response with the
    right `id` but no `result` — retries ONCE with
    `PROTOCOL_VERSION_FALLBACK` (§11.2). No other failure (a write failure, a
    timeout, an EOF) retries."""
    req_id = next(ids)
    if not _write_line(proc, _initialize_request(req_id, PROTOCOL_VERSION)):
        return None, None, False, _row(name, transport, "unreachable", env_from_shell=env_from_shell_ok)
    msg = _read_response(reader, deadline, req_id)
    if msg is None:
        state = _no_answer_state(proc, reader)
        return None, None, False, _row(name, transport, state, env_from_shell=env_from_shell_ok)
    if "result" in msg:
        result = msg.get("result")
        pv = result.get("protocolVersion") if isinstance(result, dict) else None
        return result, pv, False, None

    # protocol_error at `initialize` — retry once with the fallback version.
    fallback_id = next(ids)
    if not _write_line(proc, _initialize_request(fallback_id, PROTOCOL_VERSION_FALLBACK)):
        return None, None, False, _row(name, transport, "unreachable", env_from_shell=env_from_shell_ok)
    msg2 = _read_response(reader, deadline, fallback_id)
    if msg2 is None:
        state = _no_answer_state(proc, reader)
        return None, None, False, _row(name, transport, state, env_from_shell=env_from_shell_ok)
    if "result" in msg2:
        result = msg2.get("result")
        pv = result.get("protocolVersion") if isinstance(result, dict) else None
        return result, pv, True, None

    err = msg2.get("error")
    return (
        None,
        None,
        False,
        _row(
            name,
            transport,
            "protocol_error",
            env_from_shell=env_from_shell_ok,
            error=str(err) if err is not None else "no result in initialize response",
        ),
    )


def _probe_stdio(
    spec: "mcp_spec.McpServerSpec",
    resolved_spec_env: dict,
    timeout_s: int,
    env_from_shell_ok: bool,
    *,
    catalog: bool = False,
    catalog_timeout_s: int = CATALOG_TIMEOUT_S_DEFAULT,
) -> tuple:
    name = spec.name
    started = time.monotonic()
    deadline = started + timeout_s
    proc_env = {**os.environ, **resolved_spec_env}

    try:
        proc = subprocess.Popen(
            [spec.command, *spec.args],
            env=proc_env,
            cwd=spec.cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    except OSError as exc:
        return (
            _row(name, spec.transport, "unreachable", env_from_shell=env_from_shell_ok, error=str(exc)),
            None,
        )

    ids = itertools.count(1)
    reader = _LineReader(proc)
    try:
        init_result, protocol_version, protocol_fallback, err_row = _stdio_negotiate(
            proc, reader, deadline, ids, env_from_shell_ok, name, spec.transport
        )
        if err_row is not None:
            return err_row, None

        if not _write_line(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"}):
            return _row(name, spec.transport, "unreachable", env_from_shell=env_from_shell_ok), None
        tools_id = next(ids)
        if not _write_line(proc, _tools_list_request(tools_id)):
            return _row(name, spec.transport, "unreachable", env_from_shell=env_from_shell_ok), None

        list_msg = _read_response(reader, deadline, tools_id)
        if list_msg is None:
            state = _no_answer_state(proc, reader)
            return _row(name, spec.transport, state, env_from_shell=env_from_shell_ok), None
        if "result" not in list_msg:
            err = list_msg.get("error")
            return (
                _row(
                    name,
                    spec.transport,
                    "protocol_error",
                    env_from_shell=env_from_shell_ok,
                    error=str(err) if err is not None else "no result in tools/list response",
                ),
                None,
            )

        list_result = list_msg.get("result")
        tool_names = _tool_names(list_result)
        tool_schemas = _tool_schemas(list_result)

        # §4: once the `tools/list` result is in hand, exactly ONE exit
        # follows and it is this `ok` row — every catalogue call below is
        # wrapped so nothing can turn this back into a failure state. Many
        # stdio servers (this repo's own `stdio_ok.py` included) exit right
        # after answering `tools/list`; that must never read as unreachable.
        row = _row(
            name,
            spec.transport,
            "ok",
            tool_count=len(tool_names),
            tools=tool_names,
            tool_schemas=tool_schemas,
            latency_ms=int((time.monotonic() - started) * 1000),
            protocol_version=protocol_version,
            env_from_shell=env_from_shell_ok,
        )

        record = None
        if catalog:
            catalog_deadline = time.monotonic() + max(0.0, catalog_timeout_s)

            def _call(method: str, cursor: Optional[str]) -> tuple:
                req_id = next(ids)
                if not _write_line(proc, _list_request(req_id, method, cursor)):
                    return None, "failed to write request"
                msg = _read_response(reader, catalog_deadline, req_id)
                if msg is None:
                    return None, "timed out waiting for a response"
                if "result" in msg:
                    return msg.get("result"), None
                err = msg.get("error")
                if isinstance(err, dict) and err.get("code") == -32601:
                    return None, _NOT_OFFERED
                return None, str(err) if err is not None else "malformed response"

            try:
                record = _run_catalog_phase(
                    _call,
                    list_result,
                    name=name,
                    transport=spec.transport,
                    protocol_version=protocol_version,
                    protocol_fallback=protocol_fallback,
                    init_result=init_result,
                )
            except Exception as exc:
                record = mcp_catalog.build_record(
                    name=name,
                    transport=spec.transport,
                    protocol_version=protocol_version,
                    protocol_fallback=protocol_fallback,
                    raw_tools=list_result.get("tools", []) if isinstance(list_result, dict) else [],
                    offered={"tools": True},
                    fetch_errors=[{"method": "catalog", "error": str(exc)}],
                )
        return row, record
    finally:
        reader.close()
        _stop_process(proc)


# ─────────────────────────────────────────────────────────────────────────────
# http / sse handshake — urllib only, no new dependency
# ─────────────────────────────────────────────────────────────────────────────


def _read_json_rpc_body(resp, *, want_id: Optional[int], deadline: float) -> object:
    """Incrementally read a bounded JSON/SSE response until `want_id`.

    HTTP response bodies are attacker-controlled: Content-Length is only an
    early rejection, while the incremental byte and monotonic deadline checks
    also cover chunked and persistent SSE responses.
    """
    content_type = ""
    headers = getattr(resp, "headers", None)
    if headers is not None:
        content_type = headers.get("Content-Type", "") or ""
        length = headers.get("Content-Length")
        if length is not None:
            try:
                if int(length) > MAX_HTTP_BYTES:
                    raise ValueError("HTTP response exceeds catalogue byte limit")
            except ValueError as exc:
                if "exceeds" in str(exc):
                    raise
    total = 0
    pending = ""
    decoder = json.JSONDecoder()
    events = 0
    stream = "text/event-stream" in content_type
    while total <= MAX_HTTP_BYTES:
        if time.monotonic() >= deadline:
            raise TimeoutError("catalogue response deadline exceeded")
        compatibility_read = False
        try:
            chunk = resp.read(min(65536, MAX_HTTP_BYTES - total + 1))
        except TypeError:  # small test doubles may only expose read()
            chunk = resp.read()
            compatibility_read = True
        if not chunk:
            break
        if isinstance(chunk, str):
            chunk = chunk.encode("utf-8")
        total += len(chunk)
        if total > MAX_HTTP_BYTES:
            raise ValueError("HTTP response exceeds catalogue byte limit")
        pending += chunk.decode("utf-8", errors="replace")
        candidates = pending.splitlines(keepends=True) if stream else [pending]
        if stream:
            pending = "" if pending.endswith(("\n", "\r")) else candidates.pop()
            for line in candidates:
                if not line.startswith("data:"):
                    continue
                candidates_data = [line[5:].strip()]
                for data in candidates_data:
                    if not data:
                        continue
                    events += 1
                    if events > MAX_HTTP_EVENTS:
                        raise ValueError("too many HTTP catalogue events")
                    page = json.loads(data)
                    if want_id is None or (isinstance(page, dict) and page.get("id") == want_id):
                        return page
        else:
            try:
                page, end = decoder.raw_decode(pending.lstrip())
            except json.JSONDecodeError:
                continue
            pending = pending.lstrip()[end:]
            events += 1
            if events > MAX_HTTP_EVENTS:
                raise ValueError("too many HTTP catalogue events")
            if want_id is None or (isinstance(page, dict) and page.get("id") == want_id):
                return page
            if compatibility_read:
                break
        if compatibility_read:
            break
    raise ValueError("no correlated HTTP JSON-RPC response")


def _http_error_message(exc: BaseException) -> str:
    """A short, uniform message for any failure `urlopen`/`_read_json_rpc_body`
    can raise — used by the catalogue phase, which never lets one of these
    become an early `return` (§4)."""
    if isinstance(exc, urllib.error.HTTPError):
        return f"HTTP {exc.code}"
    if isinstance(exc, urllib.error.URLError):
        reason = exc.reason
        return "timeout" if isinstance(reason, TimeoutError) else str(reason)
    if isinstance(exc, socket.timeout):
        return "timeout"
    return str(exc)


def _probe_http(
    spec: "mcp_spec.McpServerSpec",
    resolved_url: Optional[str],
    resolved_headers: dict,
    timeout_s: int,
    env_from_shell_ok: bool,
    *,
    catalog: bool = False,
    catalog_timeout_s: int = CATALOG_TIMEOUT_S_DEFAULT,
) -> tuple:
    name = spec.name
    transport = spec.transport
    if not resolved_url:
        return (
            _row(name, transport, "unsupported", env_from_shell=env_from_shell_ok, error="no url"),
            None,
        )

    started = time.monotonic()
    session_id: Optional[str] = None
    ids = itertools.count(1)

    def _post(
        body: dict,
        *,
        extra_headers: Optional[dict] = None,
        timeout: Optional[float] = None,
        expect_response: bool = True,
        expected_id: Optional[int] = None,
    ) -> object:
        nonlocal session_id
        headers = dict(resolved_headers)
        headers["Content-Type"] = "application/json"
        headers["Accept"] = "application/json, text/event-stream"
        if session_id:
            headers["Mcp-Session-Id"] = session_id
        if extra_headers:
            headers.update(extra_headers)
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(resolved_url, data=data, headers=headers, method="POST")
        resp = urllib.request.urlopen(req, timeout=timeout if timeout is not None else timeout_s)
        resp_headers = getattr(resp, "headers", None)
        new_session = resp_headers.get("Mcp-Session-Id") if resp_headers is not None else None
        if new_session:
            session_id = new_session
        if not expect_response:
            # A notification (e.g. `notifications/initialized`) carries no
            # JSON-RPC response — a conformant server may answer 202 with an
            # EMPTY body. Drain it and stop: feeding an empty/non-JSON body
            # to `_read_json_rpc_body` would raise `JSONDecodeError` and this
            # notification would wrongly read as a `protocol_error`.
            try:
                _read_json_rpc_body(resp, want_id=None, deadline=time.monotonic() + (timeout or timeout_s))
            except (OSError, ValueError, TimeoutError):
                pass
            return None
        return _read_json_rpc_body(
            resp,
            want_id=expected_id,
            deadline=time.monotonic() + (timeout or timeout_s),
        )

    def _do(
        body: dict,
        *,
        what: str,
        extra_headers: Optional[dict] = None,
        expect_response: bool = True,
        expected_id: Optional[int] = None,
    ):
        try:
            return _post(
                body,
                extra_headers=extra_headers,
                expect_response=expect_response,
                expected_id=expected_id,
            ), None
        except socket.timeout:
            return None, _row(name, transport, "timeout", env_from_shell=env_from_shell_ok)
        except urllib.error.HTTPError as exc:
            return None, _row(
                name,
                transport,
                "unreachable",
                env_from_shell=env_from_shell_ok,
                error=f"HTTP {exc.code}",
            )
        except urllib.error.URLError as exc:
            # S-5: `socket.timeout` IS `TimeoutError` on 3.10+, and a connect
            # timeout can arrive wrapped as `URLError(TimeoutError(...))`
            # rather than a bare `socket.timeout` — unwrap it so it still
            # lands as `timeout`, not `unreachable`.
            if isinstance(exc.reason, TimeoutError):
                return None, _row(name, transport, "timeout", env_from_shell=env_from_shell_ok)
            return None, _row(
                name,
                transport,
                "unreachable",
                env_from_shell=env_from_shell_ok,
                error=str(exc.reason),
            )
        except json.JSONDecodeError:
            return None, _row(
                name,
                transport,
                "protocol_error",
                env_from_shell=env_from_shell_ok,
                error=f"malformed {what} response",
            )
        except TimeoutError:
            return None, _row(name, transport, "timeout", env_from_shell=env_from_shell_ok)
        except ValueError as exc:
            return None, _row(
                name,
                transport,
                "protocol_error",
                env_from_shell=env_from_shell_ok,
                error=str(exc),
            )
        except OSError as exc:
            return None, _row(
                name, transport, "unreachable", env_from_shell=env_from_shell_ok, error=str(exc)
            )

    # ── negotiate, with the ONE fallback retry (§11.2) ──
    init_id = next(ids)
    init_resp, err_row = _do(
        _initialize_request(init_id, PROTOCOL_VERSION), what="initialize", expected_id=init_id
    )
    if err_row is not None:
        return err_row, None

    protocol_fallback = False
    if not isinstance(init_resp, dict) or "result" not in init_resp:
        fallback_id = next(ids)
        init_resp2, err_row2 = _do(
            _initialize_request(fallback_id, PROTOCOL_VERSION_FALLBACK),
            what="initialize",
            expected_id=fallback_id,
        )
        if err_row2 is not None:
            return err_row2, None
        if not isinstance(init_resp2, dict) or "result" not in init_resp2:
            err = init_resp2.get("error") if isinstance(init_resp2, dict) else None
            return (
                _row(
                    name,
                    transport,
                    "protocol_error",
                    env_from_shell=env_from_shell_ok,
                    error=str(err) if err is not None else "no result in initialize response",
                ),
                None,
            )
        init_resp = init_resp2
        protocol_fallback = True

    result = init_resp.get("result")
    protocol_version = result.get("protocolVersion") if isinstance(result, dict) else None
    negotiated = protocol_version or (
        PROTOCOL_VERSION_FALLBACK if protocol_fallback else PROTOCOL_VERSION
    )

    # ── notifications/initialized (rev 2 §5.2 — http never sent this before) ──
    _, notify_err = _do(
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        what="notifications/initialized",
        extra_headers={"MCP-Protocol-Version": negotiated},
        expect_response=False,
    )
    if notify_err is not None:
        return notify_err, None

    # ── tools/list — 2025-06-18 requires `MCP-Protocol-Version` on every
    # post-init request (§11.3); `_probe_http` already sends `Mcp-Session-Id`.
    version_header = {"MCP-Protocol-Version": negotiated}
    list_id = next(ids)
    list_resp, err_row = _do(
        _tools_list_request(list_id),
        what="tools/list",
        extra_headers=version_header,
        expected_id=list_id,
    )
    if err_row is not None:
        return err_row, None
    if not isinstance(list_resp, dict) or "result" not in list_resp:
        err = list_resp.get("error") if isinstance(list_resp, dict) else None
        return (
            _row(
                name,
                transport,
                "protocol_error",
                env_from_shell=env_from_shell_ok,
                error=str(err) if err is not None else "no result in tools/list response",
            ),
            None,
        )

    list_result = list_resp.get("result")
    tool_names = _tool_names(list_result)
    tool_schemas = _tool_schemas(list_result)

    # §4: once the `tools/list` result is in hand, exactly ONE exit follows.
    row = _row(
        name,
        transport,
        "ok",
        tool_count=len(tool_names),
        tools=tool_names,
        tool_schemas=tool_schemas,
        latency_ms=int((time.monotonic() - started) * 1000),
        protocol_version=protocol_version,
        env_from_shell=env_from_shell_ok,
    )

    record = None
    if catalog:
        catalog_deadline = time.monotonic() + max(0.0, catalog_timeout_s)

        def _call(method: str, cursor: Optional[str]) -> tuple:
            req_id = next(ids)
            body = _list_request(req_id, method, cursor)
            remaining = catalog_deadline - time.monotonic()
            bounded_timeout = max(0.1, min(timeout_s, remaining))
            try:
                page = _post(
                    body,
                    extra_headers={"MCP-Protocol-Version": negotiated},
                    timeout=bounded_timeout,
                    expected_id=req_id,
                )
            except Exception as exc:  # every failure here becomes a fetch_errors entry (§4)
                return None, _http_error_message(exc)
            if not isinstance(page, dict):
                return None, f"malformed {method} response"
            if "result" in page:
                return page["result"], None
            err = page.get("error")
            if isinstance(err, dict) and err.get("code") == -32601:
                return None, _NOT_OFFERED
            return None, str(err) if err is not None else f"no result in {method} response"

        try:
            record = _run_catalog_phase(
                _call,
                list_result,
                name=name,
                transport=transport,
                protocol_version=negotiated,
                protocol_fallback=protocol_fallback,
                init_result=init_resp.get("result"),
            )
        except Exception as exc:
            record = mcp_catalog.build_record(
                name=name,
                transport=transport,
                protocol_version=negotiated,
                protocol_fallback=protocol_fallback,
                raw_tools=list_result.get("tools", []) if isinstance(list_result, dict) else [],
                offered={"tools": True},
                fetch_errors=[{"method": "catalog", "error": str(exc)}],
            )
    return row, record


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────


def _spec_ref_sources(spec: "mcp_spec.McpServerSpec") -> list:
    """Every string value a `${VAR}` reference may appear in: env values,
    header values, and the url."""
    values = list(spec.env.values()) + list(spec.headers.values())
    if spec.url:
        values.append(spec.url)
    return values


def probe(
    spec: "mcp_spec.McpServerSpec",
    *,
    timeout_s: int = 10,
    env: Optional[Mapping[str, str]] = None,
    from_shell: bool = True,
    catalog: bool = False,
    catalog_timeout_s: int = CATALOG_TIMEOUT_S_DEFAULT,
) -> tuple:
    """Probe one MCP server. Never raises — every failure mode is a row.

    Returns `(row, record | None)` — `record` is the `<catalog record>`
    (plans/G.md §5.8) when `catalog=True` AND the probe reached `ok`;
    `None` otherwise. `catalog` defaults to `False` so every pre-existing
    caller is unchanged by construction (plans/G.md §5.12).

    Resolves every `${VAR}` in `env`/`headers`/`url` first; any name missing
    from the resolved environment short-circuits to `state: "unresolved_ref"`
    with **no subprocess spawned and no request sent**.

    `env`, when given, is used directly as the resolved lookup map (skipping
    `resolved_env()` entirely — the seam the probe's own tests use to avoid
    ever touching the real environment or a real login shell).
    """
    if env is not None:
        env_map = dict(env)
        env_from_shell_ok = from_shell
    else:
        env_map, env_from_shell_ok = resolved_env(from_shell=from_shell)

    missing: set = set()
    for value in _spec_ref_sources(spec):
        _substitute(value, env_map, missing)
    if missing:
        return (
            _row(
                spec.name,
                spec.transport,
                "unresolved_ref",
                unresolved_refs=missing,
                env_from_shell=env_from_shell_ok,
            ),
            None,
        )

    resolved_spec_env = {k: _substitute(v, env_map, set()) for k, v in spec.env.items()}
    resolved_headers = {k: _substitute(v, env_map, set()) for k, v in spec.headers.items()}
    resolved_url = _substitute(spec.url, env_map, set()) if spec.url else spec.url

    if spec.transport == "stdio":
        if not spec.command:
            return (
                _row(
                    spec.name,
                    spec.transport,
                    "unsupported",
                    env_from_shell=env_from_shell_ok,
                    error="no command",
                ),
                None,
            )
        return _probe_stdio(
            spec,
            resolved_spec_env,
            timeout_s,
            env_from_shell_ok,
            catalog=catalog,
            catalog_timeout_s=catalog_timeout_s,
        )

    if spec.transport in ("http", "sse"):
        return _probe_http(
            spec,
            resolved_url,
            resolved_headers,
            timeout_s,
            env_from_shell_ok,
            catalog=catalog,
            catalog_timeout_s=catalog_timeout_s,
        )

    return _row(spec.name, spec.transport, "unsupported", env_from_shell=env_from_shell_ok), None


def probe_all(
    registry: dict,
    *,
    timeout_s: int = 10,
    from_shell: bool = True,
    spec_for: Callable = mcp_spec.raw_spec_from_registry,
    catalog: bool = False,
    catalog_timeout_s: int = CATALOG_TIMEOUT_S_DEFAULT,
) -> list:
    """Probe every registered `type: mcp-server` skill, sequentially.

    `spec_for(name, cfg) -> McpServerSpec` builds each spec — it defaults to
    `mcp_spec.raw_spec_from_registry` (no `{source}` expansion; this module
    cannot import `skill_meta` and stay a leaf), but a caller that already
    has the expanded spec builder (`skill_hub.entrypoints.cli.mcp._mcp_delivery_spec`) may pass
    it here (W-4), so `hub mcp check <name>` and `hub mcp check --all` probe
    the same bytes for a source-backed server. `from_shell` (W-3) forwards to
    every `probe()` call — `--no-env-from-shell` on the CLI must reach the
    sweep, not just the single-name path.

    Writes each row to the cache as it goes, and — when `catalog=True` and a
    record came back — writes the catalogue too (`hub mcp check --all
    --catalog`, opt-in per plans/G.md §5.3: `--all` defaults to
    `--no-catalog`). Returns the rows in registry (name-sorted) order.
    """
    rows: list = []
    skills = registry.get("skills") if isinstance(registry, dict) else None
    if not isinstance(skills, dict):
        return rows
    for name in sorted(skills):
        cfg = skills[name]
        if not isinstance(cfg, dict) or cfg.get("type") != "mcp-server":
            continue
        spec = spec_for(name, cfg)
        row, record = probe(
            spec,
            timeout_s=timeout_s,
            from_shell=from_shell,
            catalog=catalog,
            catalog_timeout_s=catalog_timeout_s,
        )
        write_probe_cache(name, row)
        if catalog and record is not None:
            mcp_catalog.write_catalog(name, record)
        rows.append(row)
    return rows


# ─────────────────────────────────────────────────────────────────────────────
# The cache — `<data_home>/state/mcp/probes.json`
# ─────────────────────────────────────────────────────────────────────────────


def probe_cache_path() -> Path:
    return hub_core.data_home() / "state" / "mcp" / "probes.json"


def _read_cache_file() -> dict:
    empty = {"schema_version": _CACHE_SCHEMA_VERSION, "probes": {}}
    path = probe_cache_path()
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return empty
    except (UnicodeDecodeError, ValueError):
        # C-1: a non-UTF-8 (e.g. binary garbage) file raises here, not below —
        # `json.JSONDecodeError` alone does not cover this shape, and the
        # module contract ("corrupt = warn + treat as empty, never raise")
        # must hold for it too.
        print(f"warning: corrupt MCP probe cache at {path}; treating as empty", file=sys.stderr)
        return empty
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        print(f"warning: corrupt MCP probe cache at {path}; treating as empty", file=sys.stderr)
        return empty
    if not isinstance(data, dict) or not isinstance(data.get("probes"), dict):
        return empty
    return data


def read_probe_cache() -> dict:
    """`{name: <probe row>}` — never raises; a corrupt file warns and reads
    as empty."""
    return dict(_read_cache_file().get("probes") or {})


def write_probe_cache(name: str, row: dict) -> None:
    """Upsert one server's row into the cache. Atomic (sibling temp + replace)."""
    path = probe_cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = _read_cache_file()
    probes = dict(data.get("probes") or {})
    probes[name] = row
    payload = {"schema_version": _CACHE_SCHEMA_VERSION, "probes": probes}
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def delete_probe_cache_row(name: str) -> None:
    """Remove one server's row from the probe cache, if present. Idempotent;
    never raises."""
    data = _read_cache_file()
    probes = dict(data.get("probes") or {})
    if name not in probes:
        return
    del probes[name]
    path = probe_cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"schema_version": _CACHE_SCHEMA_VERSION, "probes": probes}
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def forget_server(name: str) -> None:
    """Delete BOTH the probe-cache row and the catalogue file for `name` —
    the one hook every removal path calls (plans/G.md §5.13:
    `hub_cli/archive.py::cmd_archive`, `hub mcp reconcile --apply`'s `remove`
    decision, and a `source_missing` drop), so a stale summary can never
    outlive the server it described."""
    delete_probe_cache_row(name)
    mcp_catalog.delete_catalog(name)


def cache_age_summary(cache: dict, *, stale_days: int = 7) -> tuple:
    """`(never_checked, stale)` counts over a `{name: row}` cache mapping.

    A row with no `checked_at` (or that isn't a dict at all) counts as never
    checked. A row whose `checked_at` is older than `stale_days` counts as
    stale. A row checked within `stale_days` counts as neither. Never raises
    on a malformed `checked_at` — it degrades to "never checked".
    """
    never_checked = 0
    stale = 0
    now = datetime.now(tz=timezone.utc)
    for row in (cache or {}).values():
        if not isinstance(row, dict):
            never_checked += 1
            continue
        checked_at = row.get("checked_at")
        if not checked_at:
            never_checked += 1
            continue
        try:
            checked_dt = datetime.strptime(checked_at, "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=timezone.utc
            )
        except (ValueError, TypeError):
            never_checked += 1
            continue
        age_days = (now - checked_dt).total_seconds() / 86400
        if age_days > stale_days:
            stale += 1
    return never_checked, stale
