"""`hub mcp` — register/edit/inspect MCP servers (plans/B.md wave B, unit B2).

Distinct from two other MCP-adjacent commands that stay untouched here:
`hub new mcp <name>` (`hub_cli/skill.py`) scaffolds a brand-new Python stdio
server with generated code; `hub mcp-control` (`hub_cli/mcp_control.py`)
registers the Skill Hub control-plane server itself. `hub mcp` is the third
job: wiring in a server you ALREADY have — by flags or by pasting its native
JSON — with no server code written.

Carved fresh (not carved OUT of hub.py) — see `hub_cli/__init__.py` for the
module contract this file implements (`NAME`, `register`, `dispatch`).
`mcp_spec` and `skill_meta` are safe module-scope imports (neither imports
`hub`/`hub_cli`, so no import-cycle risk); `hub` itself is imported inside
each function per the package contract, so `hub.<name>` stays monkeypatchable
and `hub.py`'s late `import skill_hub.entrypoints.cli.mcp` (a cycle at parse time) never runs
into a half-built `hub` module at call time — every command only executes
after `hub.py` has finished loading.
"""

from __future__ import annotations

import dataclasses
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Optional

import yaml

from skill_hub import hub_core
from skill_hub.domain.mcp import mcp_spec
from skill_hub.domain.permissions.permission_adapter_base import _atomic_replace, _backup_once_per_session
from skill_hub.domain.skills import skill_meta
from skill_hub.hub_core import (
    BOLD,
    DIM,
    GREEN,
    RED,
    YELLOW,
    append_audit,
    c,
    data_home,
    data_home_lock,
    fail,
    parse_csv,
    registry_mutation,
    validate_slug,
)
from skill_hub.infrastructure.mcp import mcp_adapters, mcp_catalog, mcp_probe, mcp_reconcile

NAME = "mcp"

p_mcp = None

# The BODY only — the frontmatter is rendered separately via `yaml.safe_dump`
# (review W6: a hand-formatted `description: |` block scalar truncates a
# multi-line `--description` after its first line and lets the remainder
# inject arbitrary frontmatter keys).
MCP_ADD_BODY_TEMPLATE = """\
# {title} (MCP Server)

Registered via `hub mcp add` — no server code lives here.

- transport: {transport}
- endpoint: {endpoint}
"""


# ─────────────────────────────────────────────────────────────────────────────
# register / dispatch
# ─────────────────────────────────────────────────────────────────────────────


def _add_spec_flags(parser, *, clearable: bool = False) -> None:
    """Flags shared by `add` and `set` (plans/B.md §4, "same flags" for set).

    `--command` uses `dest="mcp_command"` — the top-level parser's own
    subparsers dest is `"command"` (`hub.py`'s dispatch reads `args.command`
    to route to this slice in the first place), and argparse shares one
    Namespace across every subparser level; a plain `dest="command"` here
    would silently overwrite it (the exact bug `hub_cli/hook.py`'s
    `--command`/`hook_command` rename already works around).
    """
    parser.add_argument(
        "--transport",
        choices=list(mcp_spec.TRANSPORTS) + list(mcp_spec.TRANSPORT_ALIASES),
        help="'streamable-http' is accepted as an alias of 'http'",
    )
    parser.add_argument("--url")
    parser.add_argument(
        "--header",
        action="append",
        metavar="K: V",
        help="Repeatable; 'K: V' or 'K=V'",
    )
    parser.add_argument("--command", dest="mcp_command")
    parser.add_argument(
        "--arg",
        action="append",
        dest="args",
        metavar="A",
        help="Repeatable, one argv element each; a flag-shaped value needs "
        "'=' (--arg=--flag), not a space, or argparse reads it as another option",
    )
    parser.add_argument("--env", action="append", metavar="K=V")
    parser.add_argument("--cwd")
    parser.add_argument("--timeout-ms", type=int, dest="timeout_ms")
    parser.add_argument("--json-stdin", action="store_true", dest="json_stdin")
    parser.add_argument("--scope", choices=sorted(hub_core.VALID_SCOPES))
    parser.add_argument("--project")
    parser.add_argument("--harnesses", help="CSV of harness ids")
    parser.add_argument("--description")
    parser.add_argument("--allow-literal", action="store_true", dest="allow_literal")
    parser.add_argument(
        "--probe",
        action="store_true",
        help="Accepted but inert until `hub mcp check` (wave C)",
    )
    parser.add_argument("--json", action="store_true")
    if clearable:
        parser.add_argument("--clear-headers", action="store_true", dest="clear_headers")
        parser.add_argument("--clear-env", action="store_true", dest="clear_env")
        parser.add_argument(
            "--no-allow-literal",
            action="store_true",
            dest="no_allow_literal",
            help="Clear a previously-set allow_literal_secrets (review S8)",
        )


def register(sub) -> None:
    global p_mcp

    # mcp — register/edit/inspect MCP servers you already have
    p_mcp = sub.add_parser(
        "mcp", help="Register/edit/inspect MCP servers (hub mcp add|set|show|list|remove)"
    )
    mcp_sub = p_mcp.add_subparsers(dest="mcp_cmd")

    p_mcp_add = mcp_sub.add_parser("add", help="Register an MCP server you already have")
    p_mcp_add.add_argument(
        "name",
        nargs="?",
        help="Omit only with a single-key --json-stdin mcpServers wrapper",
    )
    _add_spec_flags(p_mcp_add)

    p_mcp_set = mcp_sub.add_parser("set", help="Edit a registered MCP server")
    p_mcp_set.add_argument("name")
    _add_spec_flags(p_mcp_set, clearable=True)

    p_mcp_show = mcp_sub.add_parser(
        "show", help="Show one MCP server + resolved per-harness rows"
    )
    p_mcp_show.add_argument("name")
    p_mcp_show.add_argument("--json", action="store_true")

    p_mcp_list = mcp_sub.add_parser("list", help="List every registered MCP server")
    p_mcp_list.add_argument("--json", action="store_true")

    p_mcp_remove = mcp_sub.add_parser("remove", help="Archive a registered MCP server")
    p_mcp_remove.add_argument("name")
    p_mcp_remove.add_argument("--yes", action="store_true", help="Confirm the archive")
    p_mcp_remove.add_argument("--json", action="store_true")

    p_mcp_check = mcp_sub.add_parser(
        "check", help="Probe a registered MCP server (or --all) for liveness"
    )
    p_mcp_check.add_argument("name", nargs="?", help="Server name (omit with --all)")
    p_mcp_check.add_argument("--all", action="store_true", help="Probe every registered server")
    p_mcp_check.add_argument("--project", help="Accepted for context; does not change resolution")
    p_mcp_check.add_argument(
        "--timeout-s",
        type=int,
        dest="timeout_s",
        default=10,
        help="Per-request timeout in seconds (default 10; the http path makes two requests)",
    )
    p_mcp_check.add_argument(
        "--env-from-shell",
        dest="env_from_shell",
        action="store_true",
        default=True,
        help="Consult a login-shell env snapshot for ${VAR} refs (default on)",
    )
    p_mcp_check.add_argument(
        "--no-env-from-shell", dest="env_from_shell", action="store_false"
    )
    p_mcp_check.add_argument(
        "--catalog",
        dest="catalog",
        action="store_true",
        default=None,
        help="Fetch the capability catalogue (default: on for a single-name "
        "check, off with --all)",
    )
    p_mcp_check.add_argument("--no-catalog", dest="catalog", action="store_false")
    p_mcp_check.add_argument(
        "--catalog-timeout-s",
        type=int,
        dest="catalog_timeout_s",
        default=mcp_probe.CATALOG_TIMEOUT_S_DEFAULT,
        help=f"Whole-catalogue fetch budget in seconds (default "
        f"{mcp_probe.CATALOG_TIMEOUT_S_DEFAULT}), separate from --timeout-s",
    )
    p_mcp_check.add_argument("--json", action="store_true")

    p_mcp_catalog = mcp_sub.add_parser(
        "catalog", help="Show the last-fetched capability catalogue for a server (never probes)"
    )
    p_mcp_catalog.add_argument("name")
    p_mcp_catalog.add_argument("--json", action="store_true")
    p_mcp_catalog.add_argument(
        "--instructions", action="store_true", help="Also print the server's `instructions` text"
    )

    p_mcp_reconcile = mcp_sub.add_parser(
        "reconcile",
        help="Discover MCP servers already configured natively and adopt them",
    )
    g_reconcile = p_mcp_reconcile.add_mutually_exclusive_group(required=False)
    g_reconcile.add_argument(
        "--global", dest="global_", action="store_true", help="Discover at global scope"
    )
    g_reconcile.add_argument("--project", help="Discover at one project's scope")
    p_mcp_reconcile.add_argument("--harness", help="Limit discovery to a single harness id")
    p_mcp_reconcile.add_argument("--json", action="store_true")
    p_mcp_reconcile.add_argument(
        "--apply", action="store_true",
        help="Apply decisions read from --decisions-stdin (transactional)",
    )
    p_mcp_reconcile.add_argument(
        "--decisions-stdin", action="store_true", dest="decisions_stdin",
        help="Read a {decisions:[...]} JSON payload from stdin (with --apply)",
    )


def dispatch(args) -> None:
    mc = getattr(args, "mcp_cmd", None)
    if mc == "add":
        cmd_mcp_add(args)
    elif mc == "set":
        cmd_mcp_set(args)
    elif mc == "show":
        cmd_mcp_show(args)
    elif mc == "list":
        cmd_mcp_list(args)
    elif mc == "remove":
        cmd_mcp_remove(args)
    elif mc == "check":
        cmd_mcp_check(args)
    elif mc == "catalog":
        cmd_mcp_catalog(args)
    elif mc == "reconcile":
        cmd_mcp_reconcile(args)
    else:
        p_mcp.print_help()


# ─────────────────────────────────────────────────────────────────────────────
# flag / stdin parsing helpers
# ─────────────────────────────────────────────────────────────────────────────


def _parse_header_arg(raw: str) -> tuple[str, str]:
    """'K: V' or 'K=V' — split on whichever separator appears first, so a
    header value that itself contains '=' (a query string, a JWT) still
    splits on the leading ':' when that form is used.

    W1: routed through `_die` (not `hub_core.fail`) so `hub mcp add --json`
    still leaves the module through the ONE JSON-capable exit — and the
    message never echoes `raw` at all: with no ':'/'=' found there IS no key
    half to name, only the VALUE half, which is exactly where a header's
    secret lives (`--header "Bearer sk-…"` has no separator at all)."""
    colon = raw.find(":")
    eq = raw.find("=")
    positions = [i for i in (colon, eq) if i != -1]
    if not positions:
        _die("--header expects 'KEY: VALUE' or 'KEY=VALUE'", code="other")
        raise AssertionError("unreachable")  # pragma: no cover
    idx = min(positions)
    return raw[:idx].strip(), raw[idx + 1 :].strip()


def _parse_env_arg(raw: str) -> tuple[str, str]:
    """W1: see `_parse_header_arg` — same `_die` routing, same never-echo-the
    -value rule (a missing '=' means no key was ever found either)."""
    if "=" not in raw:
        _die("--env expects KEY=VALUE", code="other")
        raise AssertionError("unreachable")  # pragma: no cover
    key, _, value = raw.partition("=")
    return key.strip(), value


def _spec_from_flags(
    name: str, args, *, base: Optional[mcp_spec.McpServerSpec] = None
) -> mcp_spec.McpServerSpec:
    """Build (`add`, `base=None`) or edit (`set`, `base=<current spec>`) an
    `McpServerSpec` from CLI flags. For `set`, an unpassed flag keeps the
    base value; `--header`/`--env` MERGE new keys over the base map (cleared
    first by `--clear-headers`/`--clear-env`); a passed `--arg` REPLACES the
    whole args list (there is no per-element merge for a positional list).

    An explicit `--transport` that DIFFERS from the base spec's transport
    drops the fields the new shape cannot carry (review W4) — switching to
    `stdio` does not resurrect a stale `url`/`headers`, and switching to
    `http`/`sse` does not resurrect a stale `command`/`args`/`env`."""
    explicit_transport = getattr(args, "transport", None)
    if explicit_transport is not None:
        # 'streamable-http' is an accepted INPUT alias of 'http' — never
        # emitted (catalogue T05).
        explicit_transport = mcp_spec.TRANSPORT_ALIASES.get(explicit_transport, explicit_transport)
    transport = explicit_transport if explicit_transport is not None else (
        base.transport if base is not None else "stdio"
    )
    transport_changed = (
        base is not None and explicit_transport is not None and explicit_transport != base.transport
    )
    stdio_base = None if (transport_changed and transport != "stdio") else base
    remote_base = None if (transport_changed and transport == "stdio") else base

    headers = dict(remote_base.headers) if remote_base is not None else {}
    if getattr(args, "clear_headers", False):
        headers = {}
    for raw in getattr(args, "header", None) or []:
        k, v = _parse_header_arg(raw)
        headers[k] = v

    env = dict(stdio_base.env) if stdio_base is not None else {}
    if getattr(args, "clear_env", False):
        env = {}
    for raw in getattr(args, "env", None) or []:
        k, v = _parse_env_arg(raw)
        env[k] = v

    new_args = getattr(args, "args", None)
    arg_values = list(new_args) if new_args else (list(stdio_base.args) if stdio_base is not None else [])

    command = getattr(args, "mcp_command", None)
    if command is None:
        command = stdio_base.command if stdio_base is not None else ""

    url = getattr(args, "url", None)
    if url is None:
        url = remote_base.url if remote_base is not None else None

    cwd = getattr(args, "cwd", None)
    if cwd is None:
        cwd = base.cwd if base is not None else None

    timeout_ms = getattr(args, "timeout_ms", None)
    if timeout_ms is None:
        timeout_ms = base.timeout_ms if base is not None else None

    # `--no-allow-literal` (review S8) forces this off even when the base spec
    # carried it — the one way to clear a flag that otherwise never resets
    # once set, after the user has replaced the literal with a `${VAR}`.
    if getattr(args, "no_allow_literal", False):
        allow_literal_secrets = False
    else:
        allow_literal_secrets = base.allow_literal_secrets if base is not None else False

    return mcp_spec.McpServerSpec(
        name=name,
        command=command,
        args=arg_values,
        env=env,
        cwd=cwd,
        transport=transport,
        url=url,
        headers=headers,
        timeout_ms=timeout_ms,
        allow_literal_secrets=allow_literal_secrets,
    )


def _fail2(message: str) -> None:
    """Like `hub_core.fail`, but exit 2 — reserved for a shape hub cannot
    represent at all (a `ws` server, an unresolvable `mcpServers` wrapper) or
    a literal secret refused at the door (plans/B.md §2)."""
    print(message)
    sys.exit(2)


# ─────────────────────────────────────────────────────────────────────────────
# `_die` — the one fail-closed exit for every JSON-capable path in this
# module (E3 rev 2 §2.5, grill finding 7). `hub_core.fail`/`validate_slug`
# and `_fail2` both print bare text and `sys.exit` directly — neither can be
# wrapped after the fact, so under `--json` stdout would not be JSON (the
# "73 stdout bytes" toast). `_die` replaces every fail-closed call site
# reachable from `cmd_mcp_add`/`cmd_mcp_reconcile` (incl. `_parse_add_stdin`
# and `_reconcile_apply_mcp`) with one mechanism: under `--json` it prints
# EXACTLY one `{"ok": false, "error", "code", "reason"?, "name"?}` object to
# stdout and exits; human mode is unchanged (prints `message`, exits).
#
# `_json_mode` is a module-level flag (not a threaded parameter) set once at
# the top of each JSON-capable command entry point (`cmd_mcp_add`,
# `cmd_mcp_reconcile`) — safe because a `hub` CLI invocation is one process,
# one command, single-threaded, and every nested helper below those two
# entry points is only ever reached from within that same call.
#
# `message` (and therefore the JSON `error` field) must NEVER interpolate a
# native entry, a spec value, or stdin bytes — only names, keys, and
# vocabulary words (grill finding 9); a case plants a token-looking value in
# every add-door refusal branch and asserts it never reaches stdout.
# ─────────────────────────────────────────────────────────────────────────────

#: The closed `code` vocabulary (INTERFACES §3, `mcp_vocabulary.json`
#: `failure_codes`) — pinned by an exhaustiveness test on both sides.
MCP_FAILURE_CODES = frozenset(
    {
        "literal_secret",
        "invalid_name",
        "name_taken",
        "name_collision_in_batch",
        "ambiguous_option",
        "unknown_candidate",
        "invalid_spec",
        "invalid_json",
        "other",
        "no_catalog",
    }
)

_json_mode: bool = False


def _die(
    message: str,
    *,
    code: str,
    reason: Optional[str] = None,
    name: Optional[str] = None,
    exit_code: int = 1,
) -> None:
    if _json_mode:
        payload: dict = {"ok": False, "error": message, "code": code}
        if reason is not None:
            payload["reason"] = reason
        if name is not None:
            payload["name"] = name
        print(json.dumps(payload, indent=2))
    else:
        print(message)
    sys.exit(exit_code)


def _code_for_unsupported_reason(reason: Optional[str]) -> str:
    """W5: a classify-time `unsupported` row's `reason` is a closed-set word
    (2.1/2.2) — `invalid_name` and `name_taken:<slug>` each have their OWN
    `MCP_FAILURE_CODES` entry so a caller can key recovery copy off `code`
    instead of parsing `reason`; every other normaliser word stays
    `invalid_spec` (the catch-all the closed set reserves for that)."""
    if reason == "invalid_name":
        return "invalid_name"
    if reason and reason.startswith("name_taken:"):
        return "name_taken"
    return "invalid_spec"


def _strip_bom(text: str) -> str:
    """Catalogue S08 — a leading `﻿` (BOM) must not fail the parse."""
    return text[1:] if text.startswith("﻿") else text


def _json_loads_with_dup_warning(raw: str) -> tuple[object, list[str]]:
    """`json.loads`, plus a `duplicate_key:<k>` warning (catalogue S09) for
    any key repeated within one object — last value wins, exactly like a
    plain `json.loads` would already do; this only makes it visible."""
    warnings: list[str] = []

    def _hook(pairs: list) -> dict:
        seen: dict = {}
        for k, v in pairs:
            if k in seen:
                warnings.append(f"duplicate_key:{k}")
            seen[k] = v
        return seen

    return json.loads(raw, object_pairs_hook=_hook), warnings


def _parse_add_stdin(
    name_arg: Optional[str],
    *,
    operation_context=None,
) -> tuple[str, mcp_spec.McpServerSpec, list[str]]:
    """`hub mcp add --json-stdin` reader — the FULL native-server shapes
    (INTERFACES §3): the bare `claude mcp add-json` object, or the
    `{"mcpServers": {...}}` wrapper. The wrapper unwrap is this CLI's job;
    `mcp_spec.normalize_native` only ever sees one bare server object.

    Read order (E3 rev 2 §2.1): strip a leading BOM → `json.loads` with
    duplicate-key detection → unwrap AT MOST ONE `mcpServers` level →
    `mcp_spec.slugify_server_name` the resolved name → `normalize_native`
    (every refusal here is `_die`-wrapped, so a paste that carries the same
    73-byte slug bug the reconcile band had is refused identically, not
    silently — catalogue D-C)."""
    raw = _strip_bom(sys.stdin.read())
    try:
        obj, warnings = _json_loads_with_dup_warning(raw)
    except json.JSONDecodeError as e:
        _die(f"invalid JSON on stdin: {e}", code="invalid_json", exit_code=2)
        raise AssertionError("unreachable")  # pragma: no cover
    if not isinstance(obj, dict):
        _die("--json-stdin expects a JSON object", code="invalid_json", exit_code=2)
        raise AssertionError("unreachable")  # pragma: no cover

    servers = obj.get("mcpServers")
    raw_name: str
    if isinstance(servers, dict):
        if "mcpServers" in servers:
            # catalogue S04 — a second wrapper nested one level in.
            _die(
                "the mcpServers wrapper is nested two levels deep — paste the inner object instead",
                code="invalid_json",
                reason="nested_wrapper",
                exit_code=2,
            )
            raise AssertionError("unreachable")  # pragma: no cover
        if not servers:
            # catalogue S03.
            _die(
                "the mcpServers wrapper has no servers in it",
                code="invalid_json",
                reason="empty_wrapper",
                exit_code=2,
            )
            raise AssertionError("unreachable")  # pragma: no cover
        keys = sorted(servers)
        if name_arg:
            if name_arg not in servers:
                _die(
                    f"'{name_arg}' is not a key in mcpServers: {', '.join(keys)}",
                    code="unknown_candidate",
                    exit_code=2,
                )
            raw_name = name_arg
        elif len(servers) == 1:
            raw_name = keys[0]
        else:
            _die(
                "multiple servers in the mcpServers wrapper — pass a name: "
                + ", ".join(keys),
                code="other",
                exit_code=2,
            )
            raise AssertionError("unreachable")  # pragma: no cover
        server_obj = servers[raw_name]
    elif "mcpServers" in obj:
        _die("the mcpServers wrapper must be an object", code="invalid_json", exit_code=2)
        raise AssertionError("unreachable")  # pragma: no cover
    else:
        if not name_arg:
            _die(
                "hub mcp add requires a name (the pasted object has no "
                "mcpServers wrapper)",
                code="other",
                exit_code=2,
            )
            raise AssertionError("unreachable")  # pragma: no cover
        raw_name = name_arg
        server_obj = obj

    slug = mcp_spec.slugify_server_name(raw_name)
    if slug is None:
        # W4/coordinator (N12): `raw_name` is stdin-controlled and may carry
        # a NUL byte, be arbitrarily long, or hold non-printable bytes —
        # never interpolate it raw into an error string or a JSON field.
        bounded_name = mcp_spec._bounded_detail(raw_name)
        _die(
            f"'{bounded_name}' cannot become a skill name even after lowercasing.",
            code="invalid_name",
            name=bounded_name,
            exit_code=2,
        )
        raise AssertionError("unreachable")  # pragma: no cover
    if slug != raw_name:
        warnings.append(f"renamed_from:{raw_name}")
    name = slug

    decoder = None
    if operation_context is not None:
        decoder = mcp_adapters.select_mcp_decoder(operation_context, "claude-code")
        if decoder is None:
            _die(
                "MCP adapter route unavailable",
                code="other",
                reason="unavailable_route",
                exit_code=2,
            )
    result = mcp_spec.normalize_native(
        server_obj,
        name=name,
        adapter_key="claude",
        decoder=decoder,
    )
    if result.spec is None:
        reason = result.reason or "unknown_shape"
        bare = reason.split(":", 1)[0]
        if bare == "ws_transport":
            message = "WebSocket MCP servers are Claude-only; hub cannot deliver one"
        else:
            message = f"cannot import this MCP server ({reason})"
        _die(message, code="invalid_spec", reason=reason, name=name, exit_code=2)
        raise AssertionError("unreachable")  # pragma: no cover
    warnings = warnings + result.warnings
    return name, result.spec, warnings


def _secret_value_for_key(spec: mcp_spec.McpServerSpec, key: str) -> tuple[str, str]:
    """`(bare_key, value)` for one `secret_keys_in_spec()` entry — `key` may
    be a header/env key verbatim, the `url.query:<param>` token, or the
    literal `url.userinfo` token (E3 rev 2 catalogue U01 — no bare
    key/value pair; the whole URL carries the credential)."""
    if key == "url.userinfo":
        return key, spec.url or ""
    if key.startswith("url.query:"):
        param = key.split(":", 1)[1]
        from urllib.parse import parse_qsl, urlsplit

        query = urlsplit(spec.url or "").query
        value = dict(parse_qsl(query, keep_blank_values=True)).get(param, "")
        return param, value
    if key in spec.headers:
        return key, spec.headers[key]
    return key, spec.env.get(key, "")


#: The default hatch sentence for `hub mcp add|set` — a real `--allow-literal`
#: flag on those commands. `hub mcp reconcile` (which has no such flag; its
#: hatches are the `allow_literal`/`replace_with_ref` decision fields, W6)
#: passes its own sentence naming both.
_DEFAULT_LITERAL_HATCH = "Pass --allow-literal to register it as written."


def _fail_on_literal_secret(
    name: str,
    spec: mcp_spec.McpServerSpec,
    secret_keys: list[str],
    hatch: str = _DEFAULT_LITERAL_HATCH,
) -> None:
    """The refusal message never prints the value — only the key, the
    suggested `${VAR}` replacement, and the backup-exclusion sentence
    (plans/B.md M6). Exit 2. `hatch` is the caller-supplied escape-hatch
    sentence (W6) — `hub mcp add|set` and `hub mcp reconcile` each have their
    own door and their own flags/fields."""
    lines = [f"'{name}' looks like it carries a literal secret value:"]
    for key in secret_keys:
        bare_key, value = _secret_value_for_key(spec, key)
        if key == "url.userinfo":
            # E3 rev 2 §2.7: never offered a `${VAR}` replacement — there is
            # no single header/env slot to rewrite, only the whole URL.
            lines.append("  url.userinfo: the URL carries a username and password.")
            continue
        suggestion, var_name = mcp_spec.suggest_ref(name, bare_key, value)
        lines.append(
            f"  {key}: replace with {suggestion} (set {var_name} in your "
            f"environment). It is also excluded from backups."
        )
    lines.append(hatch)
    _die("\n".join(lines), code="literal_secret", name=name, exit_code=2)


# ─────────────────────────────────────────────────────────────────────────────
# the shared registration path (m10) — `cmd_mcp_add` today, wave D's
# `hub mcp reconcile --apply import` tomorrow, with no refactor in between
# ─────────────────────────────────────────────────────────────────────────────


def _register_mcp_skill(
    registry: dict,
    name: str,
    spec: mcp_spec.McpServerSpec,
    *,
    description: str,
    scope: str,
    harnesses: Optional[list[str]] = None,
) -> dict:
    """Create `<mcp-servers>/<name>/SKILL.md` (no `server.py`) + the registry
    entry for a registered-existing MCP server. Mutates `registry["skills"]`
    in place and returns the new entry; it does NOT save the registry — a
    batched caller (reconcile, importing several servers) writes once."""
    validate_slug(name)
    dest = skill_meta.hub_mcp_servers_dir() / name
    if dest.exists():
        fail(f"'{name}' already has a folder at {dest} — remove it or pick another name")
    dest.mkdir(parents=True)
    title = name.replace("-", " ").title()
    endpoint = spec.url if spec.transport in ("http", "sse") else (spec.command or "?")
    frontmatter = yaml.safe_dump(
        {"name": name, "description": description, "type": "mcp-server"},
        sort_keys=False,
        allow_unicode=True,
    )
    body = MCP_ADD_BODY_TEMPLATE.format(title=title, transport=spec.transport, endpoint=endpoint)
    (dest / "SKILL.md").write_text(f"---\n{frontmatter}---\n\n{body}")
    entry: dict = {
        "version": "1.0.0",
        "description": description,
        "source": hub_core.collapse_home(dest),
        "type": "mcp-server",
        "scope": scope,
        "upstream": None,
        "mcp": mcp_spec.spec_to_registry_block(spec),
    }
    if harnesses:
        entry["harnesses"] = harnesses
    registry.setdefault("skills", {})[name] = entry
    return entry


# ─────────────────────────────────────────────────────────────────────────────
# equip / resolved-row helpers (`hub mcp show`, `hub mcp list`)
# ─────────────────────────────────────────────────────────────────────────────


def _mcp_equipped_summary(registry: dict, name: str) -> dict:
    """`projects` counts every resolved-active site — direct `enabled` AND
    via a bundle (`hub.resolve_project_skills`, review S6) — the other three
    stay direct-only (bundles/remotes/cloud have no further indirection to
    expand)."""
    import hub

    projects = sorted(
        p
        for p, cfg in (registry.get("projects") or {}).items()
        if name in hub.resolve_project_skills(cfg, registry)
    )
    bundles = sorted(
        b for b, cfg in (registry.get("bundles") or {}).items() if name in (cfg.get("skills") or [])
    )
    remotes = sorted(
        r for r, cfg in (registry.get("remotes") or {}).items() if name in (cfg.get("enabled") or [])
    )
    cloud = sorted(
        t for t, cfg in (registry.get("cloud") or {}).items() if name in (cfg.get("enabled") or [])
    )
    return {"projects": projects, "bundles": bundles, "remotes": remotes, "cloud": cloud}


def _mcp_equipped_count(registry: dict, name: str) -> int:
    summary = _mcp_equipped_summary(registry, name)
    return len(summary["projects"]) + len(summary["remotes"]) + len(summary["cloud"])


def _mcp_resolved_rows(
    registry: dict,
    name: str,
    entry: dict,
    spec: mcp_spec.McpServerSpec,
    operation_context=None,
) -> list[dict]:
    """One `<resolved row>` (INTERFACES §3) per harness this server could
    reach — every installed harness for `scope: global`, or every effective
    harness of every project that has it equipped otherwise (direct `enabled`
    OR via a bundle, `hub.resolve_project_skills`, review S6). CLI-debugging
    only; nothing in the app reads this."""
    import hub
    from skill_hub.infrastructure.harnesses import harnesses as harnesses_mod

    installed = (
        set(operation_context.installed_harness_ids or ())
        if operation_context is not None
        else harnesses_mod.detect_installed()
    )
    rows: list[dict] = []

    if entry.get("scope") == "global":
        participants = (
            [
                (h_id, operation_context.layout(h_id))
                for h_id in sorted(installed)
                if operation_context.layout(h_id) is not None
            ]
            if operation_context is not None
            else sorted(harnesses_mod.HARNESSES.items())
        )
        for h_id, h in participants:
            if h_id not in installed:
                continue
            if operation_context is None:
                adapter_key = h.mcp_adapter_key
                global_config = h.global_mcp_config
            else:
                route = operation_context.route(h_id, "mcp")
                adapter_key = route.adapter_key or h.mcp_adapter_key
                global_config = h.global_mcp_config
                if route.mode != "legacy_shadow" or route.status != "shadow":
                    adapter_key = None
            if adapter_key is None or global_config is None:
                rows.append(
                    {
                        "harness": h_id,
                        "adapter": adapter_key or "",
                        "scope": "global",
                        "target_file": "",
                        "native": None,
                        "supported": False,
                        "reason": "no_global_target",
                    }
                )
                continue
            native, skip_reasons = (
                mcp_adapters.encode_native(
                    spec,
                    adapter_key,
                    operation_context=operation_context,
                    harness_id=h_id,
                )
                if operation_context is not None
                else mcp_spec.to_native(spec, adapter_key)
            )
            rows.append(
                {
                    "harness": h_id,
                    "adapter": adapter_key,
                    "scope": "global",
                        "target_file": hub_core.collapse_home(hub_core.expand(str(global_config))),
                    "native": native or None,
                    "supported": bool(native) and not skip_reasons,
                    "reason": skip_reasons[0] if skip_reasons else None,
                }
            )
        return rows

    global_ids = set(registry.get("harnesses_global") or [])
    for proj_name, proj_cfg in sorted((registry.get("projects") or {}).items()):
        if name not in hub.resolve_project_skills(proj_cfg, registry):
            continue
        if operation_context is None:
            effective = (global_ids | set(proj_cfg.get("harnesses") or [])) & installed
        else:
            effective = {
                h_id
                for h_id in (global_ids | set(proj_cfg.get("harnesses") or [])) & installed
                if operation_context.layout(h_id) is not None
                and operation_context.route(h_id, "mcp").mode == "legacy_shadow"
                and operation_context.route(h_id, "mcp").status == "shadow"
            }
        proj_root = hub_core.expand(proj_cfg.get("path", "."))
        for h_id in sorted(effective):
            h = (
                operation_context.layout(h_id)
                if operation_context is not None
                else harnesses_mod.HARNESSES.get(h_id)
            )
            if h is None or h.mcp_adapter_key is None:
                continue
            adapter_key = (
                operation_context.route(h_id, "mcp").adapter_key
                or h.mcp_adapter_key
                if operation_context is not None
                else h.mcp_adapter_key
            )
            native, skip_reasons = (
                mcp_adapters.encode_native(
                    spec,
                    adapter_key,
                    operation_context=operation_context,
                    harness_id=h_id,
                )
                if operation_context is not None
                else mcp_spec.to_native(spec, adapter_key)
            )
            if h_id == "codex":
                target = proj_root / ".codex" / "config.toml"
            elif adapter_key == "opencode":
                target = proj_root / "opencode.json"
            else:
                target = proj_root / ".mcp.json"
            rows.append(
                {
                    "harness": h_id,
                    "adapter": adapter_key,
                    "scope": f"project:{proj_name}",
                    "target_file": hub_core.collapse_home(target),
                    "native": native or None,
                    "supported": bool(native) and not skip_reasons,
                    "reason": skip_reasons[0] if skip_reasons else None,
                }
            )
    return rows


def _mcp_delivery_spec(name: str, cfg: dict) -> mcp_spec.McpServerSpec:
    """The EXPANDED spec (`{source}` substituted when `cfg["source"]` is
    truthy) — what a harness actually receives. `to_native` (via
    `_mcp_resolved_rows`) and any displayed `endpoint` must be built from
    this, never from `raw_spec_from_registry` (review W5): the raw spec is
    reserved for the remote-connector wire dict (F1) and the registry `spec`
    field (which is the literal `mcp:` block, not derived from a spec object
    at all)."""
    source = skill_meta.skill_source(cfg) if cfg.get("source") else None
    return mcp_spec.spec_from_registry(name, cfg, source=source)


def _mcp_ref_names_in_spec(spec: mcp_spec.McpServerSpec) -> list[str]:
    return sorted(
        {
            ref
            for value in (*spec.headers.values(), *spec.env.values())
            for ref in mcp_spec.ref_names(value)
        }
    )


def _apply_project_equip(registry: dict, name: str, project: Optional[str]) -> Optional[dict]:
    if not project:
        return None
    projects = registry.get("projects", {})
    if project not in projects:
        fail(f"unknown project '{project}'")
    enabled = projects[project].setdefault("enabled", [])
    if name not in enabled:
        enabled.append(name)
    return {"project": project}


#: Flags that build the `mcp:` block from scratch — `--json-stdin` reads the
#: whole thing (or a merge patch) from stdin instead, so combining it with any
#: of these silently discarded the flag (review S7).
_SPEC_FLAG_LABELS = {
    "transport": "--transport",
    "url": "--url",
    "header": "--header",
    "mcp_command": "--command",
    "args": "--arg",
    "env": "--env",
    "cwd": "--cwd",
    "timeout_ms": "--timeout-ms",
}


def _refuse_json_stdin_with_spec_flags(args) -> None:
    passed = [
        label for field, label in _SPEC_FLAG_LABELS.items() if getattr(args, field, None) is not None
    ]
    if getattr(args, "clear_headers", False):
        passed.append("--clear-headers")
    if getattr(args, "clear_env", False):
        passed.append("--clear-env")
    if passed:
        # W1: routed through `_die` — `passed` is only ever closed-set flag
        # labels (never a flag's VALUE), so it is safe to name verbatim.
        _die(
            "--json-stdin reads the whole spec (or a merge patch) from stdin — "
            f"it cannot be combined with {', '.join(passed)}",
            code="other",
        )


# ─────────────────────────────────────────────────────────────────────────────
# hub mcp add
# ─────────────────────────────────────────────────────────────────────────────


def cmd_mcp_add(args):
    """Parse first, then commit the MCP registration under the data-home lock."""
    global _json_mode
    _json_mode = bool(getattr(args, "json", False))
    try:
        _cmd_mcp_add_impl(args)
    finally:
        _json_mode = False


def _cmd_mcp_add_impl(args):
    operation_context = _mcp_operation_context(args)

    as_json = getattr(args, "json", False)
    name_arg = getattr(args, "name", None)
    renamed_summary: list[dict] = []

    if getattr(args, "json_stdin", False):
        route = operation_context.route("claude-code", "mcp")
        if (
            route.mode != "legacy_shadow"
            or route.status != "shadow"
            or mcp_adapters.select_mcp_adapter(operation_context, "claude-code") is None
        ):
            _die(
                "MCP adapter route unavailable",
                code="other",
                reason="unavailable_route",
                exit_code=2,
            )
        _refuse_json_stdin_with_spec_flags(args)
        name, spec, warnings = _parse_add_stdin(
            name_arg, operation_context=operation_context
        )
        if any(w.startswith("renamed_from:") for w in warnings):
            source = next(w.split(":", 1)[1] for w in warnings if w.startswith("renamed_from:"))
            renamed_summary.append({"from": source, "to": name})
    else:
        if not name_arg:
            _die("hub mcp add requires a name", code="other")
        raw_name = name_arg.strip()
        # E3 rev 2 §2.1: `hub_core.validate_slug` prints bare text and exits
        # before `_die` could wrap it — validated LOCALLY first so that door
        # is unreachable on the JSON path (grill finding 7). A typed name
        # that is not already a slug still REFUSES here (the user typed it),
        # but the message names the slug it would become (D-C).
        slug = mcp_spec.slugify_server_name(raw_name)
        if slug != raw_name:
            hint = f" — did you mean '{slug}'?" if slug else ""
            _die(f"Invalid name '{raw_name}'.{hint}", code="invalid_name", name=raw_name)
        name = raw_name
        spec = _spec_from_flags(name, args)
        warnings = []

    # All input parsing, including stdin, is complete before this lock.
    with data_home_lock():
        before = hub_core._registry_sha()
        try:
            _cmd_mcp_add_commit(
                args,
                operation_context=operation_context,
                parsed=(name, spec, warnings, renamed_summary),
            )
        except SystemExit as exc:
            if exc.code == 2:
                append_audit("mcp-add", args, before, hub_core._registry_sha())
            raise
        append_audit("mcp-add", args, before, hub_core._registry_sha())


def _cmd_mcp_add_commit(args, *, operation_context, parsed):
    import hub

    registry = hub_core.load_registry()
    skills = registry.get("skills", {})
    as_json = getattr(args, "json", False)
    name, spec, warnings, renamed_summary = parsed

    if getattr(args, "allow_literal", False) and not spec.allow_literal_secrets:
        spec = dataclasses.replace(spec, allow_literal_secrets=True)

    if name in skills:
        _die(
            f"'{name}' is already registered. Use `hub mcp set {name}` to edit it.",
            code="name_taken",
            reason=f"name_taken:{name}",
            name=name,
        )
    # E3 rev 2 §2.5 (grill finding 7): a leftover `mcp-servers/<name>/` dir
    # with no registry entry (an archived skill, a crash mid-registration)
    # is ALSO `name_taken` — decided here, not by `_register_mcp_skill`'s
    # own `dest.exists()` refusal (bare `fail()`, unwrappable), which this
    # check makes unreachable.
    if (skill_meta.hub_mcp_servers_dir() / name).exists():
        _die(
            f"'{name}' already has a folder — remove it or pick another name.",
            code="name_taken",
            reason=f"name_taken:{name}",
            name=name,
        )

    new_block = mcp_spec.spec_to_registry_block(spec)
    errors, val_warnings = mcp_spec.validate_mcp_entry(name, {"mcp": new_block})
    warnings = list(warnings) + val_warnings
    if errors:
        _die("; ".join(errors), code="invalid_spec", name=name)

    secret_keys = mcp_spec.secret_keys_in_spec(spec)
    if secret_keys and not spec.allow_literal_secrets:
        _fail_on_literal_secret(name, spec, secret_keys)

    scope = hub_core.parse_scope(getattr(args, "scope", None), default="global")
    description = (
        getattr(args, "description", None) or f"Registered MCP server: {name}"
    ).strip()
    harnesses = (
        hub._validate_harness_affinity(parse_csv(getattr(args, "harnesses", None)), f"skill '{name}'")
        or None
    )

    project = getattr(args, "project", None)
    if project and project not in registry.get("projects", {}):
        _die(f"unknown project '{project}'", code="other")

    entry = _register_mcp_skill(
        registry, name, spec, description=description, scope=scope, harnesses=harnesses
    )
    try:
        equipped = _apply_project_equip(registry, name, project)
        hub_core.save_registry(registry)
    except BaseException:
        shutil.rmtree(skill_meta.hub_mcp_servers_dir() / name, ignore_errors=True)
        raise

    probe_row: Optional[dict] = None
    if getattr(args, "probe", False):
        # After the registry write (plans/C.md §7 step 8): probe the EXPANDED
        # spec (the one a harness would actually receive), same as `hub mcp
        # show`'s `last_probe`.
        probe_spec = _mcp_delivery_spec(name, entry)
        # `catalog` stays False here (plans/G.md §5.12): a registration path
        # must not write a summary pointing at a catalogue file nobody wrote.
        probe_row, _probe_record = mcp_probe.probe(probe_spec)
        mcp_probe.write_probe_cache(name, probe_row)

    dest = skill_meta.hub_mcp_servers_dir() / name
    payload = {
        "ok": True,
        "name": name,
        "created_dir": hub_core.collapse_home(dest),
        "registered": True,
        "equipped": equipped,
        "spec": entry["mcp"],
        "warnings": warnings,
        "probe": probe_row,
    }
    if as_json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"{c('✓', GREEN)} registered MCP server '{name}' ({spec.transport}) → {dest}")
        if equipped:
            print(f"  → equipped on project '{project}'")
        if probe_row is not None:
            _print_probe_row(probe_row)
        for w in warnings:
            print(f"  {c('!', YELLOW)} {w}")
    hub._auto_sync_tail()


# ─────────────────────────────────────────────────────────────────────────────
# hub mcp set --json-stdin — the MCP-specific merge patch (D3)
#
# Deliberately NOT `hooks_model.deep_merge`: that helper's UNION semantics are
# load-bearing for hooks (a hook's settings only ever grow), so it stays
# untouched. `hub mcp set --json-stdin` needs the opposite for the editor
# panel to be able to delete a header/env key or an `${VAR}` at all:
#   - a key ABSENT from the patch is untouched (unchanged from `prior_block`).
#   - a key set to JSON `null` is DELETED — at the top level (e.g. "url":
#     null) or one level down, inside the two nested-dict fields the `mcp:`
#     block ever holds (`headers`, `env`).
#   - a `dict` patch value merges ONE level into an existing `dict` value
#     (only `headers`/`env` are ever dicts in this schema); anything else
#     (a list — `args` — or a scalar) REPLACES the stored value wholesale.
# An emptied `headers`/`env` is kept as `{}` in the merged block (not
# popped) — `mcp_spec.spec_to_registry_block` already omits an empty
# container from what actually gets WRITTEN, so this choice is invisible on
# disk; it is pinned here only so a second merge in the same call is
# deterministic.
# ─────────────────────────────────────────────────────────────────────────────


def _mcp_merge_nested_dict(base: dict, patch: dict) -> dict:
    result = dict(base)
    for key, val in patch.items():
        if val is None:
            result.pop(key, None)
        else:
            result[key] = val
    return result


def _mcp_merge_patch(base: dict, patch: dict) -> tuple[dict, list[str]]:
    """Returns `(merged_block, deleted_top_level_keys)` — the latter is what
    `cmd_mcp_set` uses to turn a validation failure caused by a deliberate
    `null` into a precise, exit-2 message naming the key, rather than the
    generic exit-1 `validate_mcp_entry` error list every other invalid-flags
    shape already gets (unchanged, D3)."""
    result = dict(base)
    deleted_top_level: list[str] = []
    for key, val in (patch or {}).items():
        if val is None:
            result.pop(key, None)
            deleted_top_level.append(key)
        elif isinstance(val, dict) and isinstance(result.get(key), dict):
            result[key] = _mcp_merge_nested_dict(result[key], val)
        else:
            # A list (`args`) replaces wholesale; so does any other scalar.
            result[key] = val
    return result, deleted_top_level


@registry_mutation("mcp-set")
def cmd_mcp_set(args):
    import hub

    registry = hub_core.load_registry()
    skills = registry.get("skills", {})
    name = args.name
    entry = skills.get(name)
    if not isinstance(entry, dict) or entry.get("type") != "mcp-server":
        fail(f"unknown MCP server '{name}'")

    as_json = getattr(args, "json", False)
    prior_block = dict(entry.get("mcp") or {})
    base_spec = mcp_spec.raw_spec_from_registry(name, entry)
    deleted_top_level: list[str] = []
    runtime_carry_source = prior_block

    if getattr(args, "json_stdin", False):
        _refuse_json_stdin_with_spec_flags(args)
        raw = sys.stdin.read()
        try:
            partial = json.loads(raw)
        except json.JSONDecodeError as e:
            _fail2(f"invalid JSON on stdin: {e}")
            raise AssertionError("unreachable")  # pragma: no cover
        if not isinstance(partial, dict):
            _fail2("--json-stdin expects a JSON object (a partial `mcp:` block)")
            raise AssertionError("unreachable")  # pragma: no cover

        # D3: an MCP-specific merge, not `hooks_model.deep_merge` (union-only,
        # load-bearing for hooks) — `null` DELETES a key (top-level or one
        # level into `headers`/`env`), a list (`args`) REPLACES wholesale.
        merged_block, deleted_top_level = _mcp_merge_patch(prior_block, partial)
        spec = mcp_spec.spec_from_registry(name, {"mcp": merged_block})
        warnings: list[str] = []
        # A deleted top-level `runtime` (the one legacy carry-forward key)
        # must not be resurrected from the pre-merge block below.
        runtime_carry_source = merged_block
    else:
        spec = _spec_from_flags(name, args, base=base_spec)
        warnings = []

    if getattr(args, "allow_literal", False) and not spec.allow_literal_secrets:
        spec = dataclasses.replace(spec, allow_literal_secrets=True)

    new_block = mcp_spec.spec_to_registry_block(spec, prior=runtime_carry_source)
    errors, val_warnings = mcp_spec.validate_mcp_entry(name, {"mcp": new_block})
    warnings = warnings + val_warnings
    if errors:
        if deleted_top_level:
            # D3/(d): a deliberate `null` on a top-level key that leaves the
            # spec invalid is a precise, exit-2 refusal naming the key —
            # never the generic exit-1 `validate_mcp_entry` list every other
            # invalid-flags shape still gets, unchanged.
            _fail2(
                f"deleting {', '.join(sorted(deleted_top_level))} leaves "
                f"'{name}' invalid: {'; '.join(errors)}"
            )
        fail("; ".join(errors))

    secret_keys = mcp_spec.secret_keys_in_spec(spec)
    if secret_keys and not spec.allow_literal_secrets:
        _fail_on_literal_secret(name, spec, secret_keys)

    if getattr(args, "description", None) is not None:
        entry["description"] = args.description
    if getattr(args, "scope", None) is not None:
        entry["scope"] = hub_core.parse_scope(args.scope)
    if getattr(args, "harnesses", None) is not None:
        edited_harnesses = hub._validate_harness_affinity(
            parse_csv(args.harnesses), f"skill '{name}'"
        )
        if edited_harnesses:
            entry["harnesses"] = edited_harnesses
        else:
            entry.pop("harnesses", None)

    changed_keys = sorted(
        k for k in set(prior_block) | set(new_block) if prior_block.get(k) != new_block.get(k)
    )

    entry["mcp"] = new_block
    skills[name] = entry

    project = getattr(args, "project", None)
    equipped = _apply_project_equip(registry, name, project)

    hub_core.save_registry(registry)

    payload = {
        "ok": True,
        "name": name,
        "spec": new_block,
        "changed_keys": changed_keys,
        "warnings": warnings,
        "prior_spec": prior_block,
    }
    if as_json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"{c('✓', GREEN)} updated MCP server '{name}'")
        if changed_keys:
            print(f"  changed: {', '.join(changed_keys)}")
        if equipped:
            print(f"  → equipped on project '{project}'")
        for w in warnings:
            print(f"  {c('!', YELLOW)} {w}")
    hub._auto_sync_tail()


# ─────────────────────────────────────────────────────────────────────────────
# hub mcp show / list / remove
# ─────────────────────────────────────────────────────────────────────────────


def _mcp_operation_context(args):
    existing = getattr(args, "_operation_context", None)
    if existing is not None:
        return existing
    from skill_hub.domain.harnesses.harness_adapter_api import SDK_VERSION, Version
    from skill_hub.infrastructure.harnesses import harnesses

    installed = set(harnesses.detect_installed())
    # Claude's MCP source route is a static offline interpretation boundary;
    # retain it in the operation snapshot even when no Claude runtime is
    # installed.  Installed ids still govern delivery participants.
    selected = tuple(sorted(installed | {"claude-code"}))
    from skill_hub.application.harnesses.harness_operation_context import build_operation_context

    context = build_operation_context(
        hub_core.data_home(),
        selected,
        requested_features=("mcp",),
        installed_harness_ids=tuple(sorted(installed)),
        host_version=Version.parse(hub_core.hub_version()),
        sdk_version=SDK_VERSION,
    )
    args._operation_context = context
    return context


def cmd_mcp_show(args):
    registry = hub_core.load_registry()
    skills = registry.get("skills", {})
    name = args.name
    entry = skills.get(name)
    if not isinstance(entry, dict) or entry.get("type") != "mcp-server":
        fail(f"unknown MCP server '{name}'")

    spec = _mcp_delivery_spec(name, entry)
    operation_context = _mcp_operation_context(args)
    block = dict(entry.get("mcp") or {})
    payload = {
        "ok": True,
        "name": name,
        "scope": entry.get("scope", "portable"),
        "description": entry.get("description", ""),
        "harnesses": entry.get("harnesses"),
        "spec": block,
        "secret_refs": _mcp_ref_names_in_spec(spec),
        "literal_secret_keys": mcp_spec.secret_keys_in_spec(spec),
        "equipped": _mcp_equipped_summary(registry, name),
        "resolved": _mcp_resolved_rows(
            registry, name, entry, spec, operation_context
        ),
        "last_probe": mcp_probe.read_probe_cache().get(name),
    }
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
        return

    print(f"\n{c(name, BOLD)}  [{entry.get('scope', 'portable')}]")
    print(f"  transport : {spec.transport}")
    endpoint = spec.url if spec.transport in ("http", "sse") else spec.command
    print(f"  endpoint  : {endpoint or '?'}")
    if payload["literal_secret_keys"]:
        print(f"  {c('!', YELLOW)} literal secret(s): {', '.join(payload['literal_secret_keys'])}")
    for kind, names in payload["equipped"].items():
        if names:
            print(f"  {kind}: {', '.join(names)}")
    for row in payload["resolved"]:
        mark = "✓" if row["supported"] else "—"
        print(f"  {mark} {row['harness']} [{row['scope']}] {row['target_file'] or '(none)'}")


def cmd_mcp_list(args):
    registry = hub_core.load_registry()
    skills = registry.get("skills", {})
    rows = []
    for skill_name, cfg in sorted(skills.items()):
        if not isinstance(cfg, dict) or cfg.get("type") != "mcp-server":
            continue
        spec = _mcp_delivery_spec(skill_name, cfg)
        endpoint = spec.url if spec.transport in ("http", "sse") else spec.command
        rows.append(
            {
                "name": skill_name,
                "transport": spec.transport,
                "scope": cfg.get("scope", "portable"),
                "endpoint": endpoint or "",
                "harnesses": cfg.get("harnesses"),
                "equipped_count": _mcp_equipped_count(registry, skill_name),
                "secret_refs": _mcp_ref_names_in_spec(spec),
                "has_literal_secret": bool(mcp_spec.secret_keys_in_spec(spec)),
            }
        )

    if getattr(args, "json", False):
        print(json.dumps({"ok": True, "servers": rows}, indent=2))
        return

    if not rows:
        print("\nNo MCP servers registered. Create one with `hub mcp add <name> …`.")
        return
    print(f"\n{c('MCP servers', BOLD)}")
    print("─" * 72)
    for r in rows:
        print(
            f"  {c(r['name'], BOLD)} [{r['transport']}]  {r['endpoint']}  "
            f"→ {r['equipped_count']} equipped"
        )


def cmd_mcp_remove(args):
    registry = hub_core.load_registry()
    skills = registry.get("skills", {})
    name = args.name
    entry = skills.get(name)
    if not isinstance(entry, dict) or entry.get("type") != "mcp-server":
        fail(f"unknown MCP server '{name}'")

    if not getattr(args, "yes", False):
        print(f"\n{c('Would archive MCP server', YELLOW)} '{name}':")
        print(
            "  remove from registry.yaml, move its folder to skills/_archive/, "
            "write an undo record"
        )
        print(f"\nRe-run with --yes to apply, or `hub unarchive {name}` afterwards to undo.")
        return

    import skill_hub.entrypoints.cli.archive as archive_mod

    class _RemoveArgs:
        skills = [name]
        dry_run = False
        json = getattr(args, "json", False)

    archive_mod.cmd_archive(_RemoveArgs())


# ─────────────────────────────────────────────────────────────────────────────
# hub mcp check — the live probe (plans/C.md §2 truth 3; wave C, unit C2).
# Read-only: no @registry_mutation, no lock, no auto-sync.
# ─────────────────────────────────────────────────────────────────────────────

_PROBE_STATE_MARK = {
    "ok": ("✓", GREEN),
    "unresolved_ref": ("!", YELLOW),
    "unreachable": ("✗", RED),
    "protocol_error": ("✗", RED),
    "timeout": ("✗", RED),
    "unsupported": ("·", DIM),
}


def _print_probe_row(row: dict) -> None:
    state = row.get("state", "?")
    mark, color = _PROBE_STATE_MARK.get(state, ("·", DIM))
    name = row.get("name", "?")
    print(f"  {c(mark, color)} {name} [{row.get('transport', '?')}] {state}")
    if state == "ok":
        print(f"    tools: {row.get('tool_count')}  latency: {row.get('latency_ms')}ms")
    elif state == "unresolved_ref":
        print(f"    unresolved: {', '.join(row.get('unresolved_refs') or [])}")
    elif row.get("error"):
        print(f"    {row['error']}")
    if row.get("env_from_shell") is False:
        print(f"    {c('·', DIM)} checks can only see variables exported to GUI apps")


def cmd_mcp_check(args) -> None:
    """Read-only: probes one server (or every registered server with
    `--all`), writes each result to the probe cache, and prints/returns it.
    Never mutates the registry, never runs `hub._auto_sync`.

    Catalogue defaults (plans/G.md §5.3, §5.12): a single-name check fetches
    the capability catalogue by default (`--no-catalog` opts out — and
    DELETES any stale catalogue file, so the glance block and the sheet can
    never disagree); `--all` defaults to `--no-catalog` (`--catalog` opts
    in) since the app never runs `--all`. `cmd_mcp_check` is the single
    writer of both the probe row and the catalogue record.
    """
    registry = hub_core.load_registry()
    skills = registry.get("skills", {})
    as_json = getattr(args, "json", False)
    timeout_s = getattr(args, "timeout_s", None) or 10
    from_shell = getattr(args, "env_from_shell", True)
    explicit_catalog = getattr(args, "catalog", None)
    catalog_timeout_s = getattr(args, "catalog_timeout_s", None) or mcp_probe.CATALOG_TIMEOUT_S_DEFAULT

    if getattr(args, "all", False):
        catalog = bool(explicit_catalog) if explicit_catalog is not None else False
        rows = mcp_probe.probe_all(
            registry,
            timeout_s=timeout_s,
            from_shell=from_shell,
            spec_for=_mcp_delivery_spec,
            catalog=catalog,
            catalog_timeout_s=catalog_timeout_s,
        )
        if as_json:
            print(json.dumps({"ok": True, "probes": rows}, indent=2))
        else:
            if not rows:
                print("\nNo MCP servers registered.")
            else:
                print(f"\n{c('MCP probes', BOLD)}")
                for row in rows:
                    _print_probe_row(row)
        return

    name = getattr(args, "name", None)
    if not name:
        fail("hub mcp check requires a name, or pass --all")
    entry = skills.get(name)
    if not isinstance(entry, dict) or entry.get("type") != "mcp-server":
        fail(f"unknown MCP server '{name}'")

    project = getattr(args, "project", None)
    if project and project not in registry.get("projects", {}):
        fail(f"unknown project '{project}'")

    catalog = explicit_catalog if explicit_catalog is not None else True

    spec = _mcp_delivery_spec(name, entry)
    row, record = mcp_probe.probe(
        spec,
        timeout_s=timeout_s,
        from_shell=from_shell,
        catalog=catalog,
        catalog_timeout_s=catalog_timeout_s,
    )
    if record is not None:
        row = dict(row)
        row["catalog"] = mcp_catalog.summarize(record)
        try:
            mcp_catalog.write_catalog(name, record)
        except (OSError, ValueError, TypeError) as exc:
            print(f"warning: could not store MCP catalogue for '{name}': {exc}", file=sys.stderr)
    elif not catalog:
        # `--no-catalog` deletes any stale catalogue so the glance block and
        # the sheet can never disagree with a summary pointing at nothing.
        mcp_catalog.delete_catalog(name)

    mcp_probe.write_probe_cache(name, row)

    payload = dict(row)
    payload["ok"] = row.get("state") == "ok"
    if as_json:
        print(json.dumps(payload, indent=2))
    else:
        _print_probe_row(row)


def cmd_mcp_catalog(args) -> None:
    """`hub mcp catalog <name>` — read-only, NEVER probes: outside
    `@registry_mutation`/`_auto_sync`, exactly as `cmd_mcp_check` is. Prints
    the last-fetched `<catalog record>` for `name`, or a fail-closed
    `{"ok":false,...,"code":"no_catalog"}` when nothing has been fetched yet.
    """
    global _json_mode
    _json_mode = bool(getattr(args, "json", False))
    try:
        _cmd_mcp_catalog_impl(args)
    finally:
        _json_mode = False


def _cmd_mcp_catalog_impl(args) -> None:
    registry = hub_core.load_registry()
    skills = registry.get("skills", {})
    name = args.name
    entry = skills.get(name)
    if not isinstance(entry, dict) or entry.get("type") != "mcp-server":
        fail(f"unknown MCP server '{name}'")

    record = mcp_catalog.read_catalog(name)
    if record is None:
        _die(
            f"no capability catalogue stored for '{name}' — run `hub mcp check {name}` first",
            code="no_catalog",
            name=name,
        )
        return

    if getattr(args, "json", False):
        print(json.dumps({"ok": True, "catalog": record}, indent=2))
        return

    _print_catalog_table(record, show_instructions=getattr(args, "instructions", False))


def _print_catalog_table(record: dict, *, show_instructions: bool = False) -> None:
    name = record.get("name", "?")
    server_name = record.get("server_name")
    server_version = record.get("server_version")
    identity = " ".join(x for x in (server_name, server_version) if x) or "?"
    print(f"\n{c(name, BOLD)}  read {record.get('fetched_at', '?')}")
    print(f"  server    : {identity}")
    print(f"  protocol  : {record.get('protocol_version') or '?'}")
    if record.get("capabilities"):
        print(f"  declared  : {', '.join(record['capabilities'])}")

    for kind, label in (
        ("tools", "TOOLS"),
        ("resources", "RESOURCES"),
        ("resource_templates", "TEMPLATES"),
        ("prompts", "PROMPTS"),
    ):
        items = record.get(kind) or []
        offered = (record.get("offered") or {}).get(kind, False)
        if not offered and not items:
            print(f"\n{c(label, DIM)}  not offered")
            continue
        print(f"\n{c(label, BOLD)} ({len(items)})")
        for item in items:
            item_name = item.get("name") or item.get("uri") or item.get("uri_template") or "?"
            desc = item.get("description")
            line = f"  {item_name}"
            if desc:
                line += f"  — {desc}"
            print(line)

    fetch_errors = record.get("fetch_errors") or []
    if fetch_errors:
        print(f"\n{c('errors', YELLOW)}")
        for err in fetch_errors:
            print(f"  {err.get('method', '?')}: {err.get('error', '?')}")

    if show_instructions and record.get("instructions"):
        print(f"\n{c('instructions', BOLD)}\n  {record['instructions']}")


# ─────────────────────────────────────────────────────────────────────────────
# hub mcp reconcile — discover native servers, classify, adopt (plans/D.md).
# Mirrors `hub permissions reconcile`'s vocabulary/kept-store/transaction.
# ─────────────────────────────────────────────────────────────────────────────


def _mcp_scope(scope_kind: str, proj_name: Optional[str], proj_root: Optional[Path]):
    from skill_hub.domain.permissions.permissions import GlobalScope, ProjectScope

    if scope_kind == "global":
        return GlobalScope()
    return ProjectScope(name=proj_name, path=str(proj_root))


def _mcp_kept_store_path(scope) -> Path:
    return data_home() / "state" / "reconcile" / f"{scope.slug}.mcp.kept.json"


def _load_mcp_kept(scope) -> list[dict]:
    path = _mcp_kept_store_path(scope)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return []
    entries = data.get("kept") if isinstance(data, dict) else None
    return [e for e in (entries or []) if isinstance(e, dict) and e.get("name")]


def _save_mcp_kept(scope, entries: list[dict]) -> None:
    path = _mcp_kept_store_path(scope)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"schema_version": 1, "kept": entries}, indent=2) + "\n")
    os.replace(tmp, path)


def _mcp_kept_names(scope) -> set:
    """W9: `classify` groups candidates by the CASE-FOLDED SLUG, so a row's
    `name` is always a slug — but an entry an OLDER hub (or a hand-edit)
    parked in the kept store can still hold the raw pre-slugify string
    (`Sanity`). Include both the raw stored name and its slugified form so a
    stale-cased entry still suppresses its row."""
    names: set = set()
    for e in _load_mcp_kept(scope):
        raw = e.get("name")
        if not raw:
            continue
        names.add(raw)
        slug = mcp_spec.slugify_server_name(raw)
        if slug:
            names.add(slug)
    return names


def _mcp_kept_display_names(scope) -> list[str]:
    """N9: `_mcp_kept_names` widens to raw ∪ slug for MEMBERSHIP tests only
    (W9) — reporting that set verbatim in the discovery payload lists one
    parked decision under two spellings whenever its stored name still needs
    slugifying. Report each stored entry's CANONICAL name exactly once: its
    slug when it has one, else the raw stored string."""
    names: set = set()
    for e in _load_mcp_kept(scope):
        raw = e.get("name")
        if not raw:
            continue
        names.add(mcp_spec.slugify_server_name(raw) or raw)
    return sorted(names)


def _record_mcp_kept_decisions(scope, decisions: list, by_name: dict) -> tuple[list[str], list[str]]:
    """Persist `keep`/`unkeep` decisions to the kept store (m3 — the exact
    shape `hub_cli/permissions.py:1146-1167` uses, `.mcp` kind suffix).
    Non-transactional by design: it never touches the registry or native
    files. Returns `(kept_now, unkept_now)` — the names this call kept/lifted."""
    entries = _load_mcp_kept(scope)
    existing_names = {e.get("name") for e in entries}
    kept_now: list[str] = []
    unkept_now: list[str] = []
    changed = False
    for d in decisions:
        if not isinstance(d, dict):
            continue
        action = d.get("action")
        name = d.get("name")
        if not name:
            continue
        if action == "keep":
            if name not in existing_names:
                cand = by_name.get(name) or {}
                sources = cand.get("sources") or []
                source_file = sources[0].get("file") if sources else None
                entries.append({"name": name, "source_file": source_file})
                existing_names.add(name)
                changed = True
            kept_now.append(name)
        elif action == "unkeep":
            # W9: match on the slug too — an entry parked before `classify`
            # grouped by slug can still hold the raw pre-slugify name
            # (`Sanity`), which `name` (the candidate's current slug,
            # `sanity`) would otherwise never match.
            target_slug = mcp_spec.slugify_server_name(name)
            before = len(entries)
            entries = [
                e
                for e in entries
                if e.get("name") != name
                and not (target_slug is not None and mcp_spec.slugify_server_name(e.get("name") or "") == target_slug)
            ]
            if len(entries) != before:
                existing_names.discard(name)
                changed = True
            unkept_now.append(name)
    if changed:
        _save_mcp_kept(scope, entries)
    return kept_now, unkept_now


def _scope_mcp_native_files(
    scope_kind: str,
    proj_root: Optional[Path],
    installed: set,
    operation_context=None,
) -> list:
    """Every native file this scope's apply transaction may touch — used to
    snapshot for rollback (mirrors `hub_cli/permissions.py::_scope_native_files`)."""
    from skill_hub.infrastructure.harnesses import harnesses as harnesses_mod

    files: list = []

    def _add(p):
        if p is not None and p not in files:
            files.append(p)

    if scope_kind == "global":
        target_ids = ("claude-code", "codex") if operation_context is None else sorted(installed)
        for h_id in target_ids:
            if h_id not in installed:
                continue
            if operation_context is None:
                h = harnesses_mod.HARNESSES.get(h_id)
                target = h.global_mcp_config if h is not None else None
            else:
                h = operation_context.layout(h_id)
                route = operation_context.route(h_id, "mcp")
                target = (
                    h.global_mcp_config
                    if h is not None
                    and route.mode == "legacy_shadow"
                    and route.status == "shadow"
                    else None
                )
            if target is not None:
                _add(Path(str(target)).expanduser())
    elif proj_root is not None:
        if operation_context is None:
            _add(proj_root / ".mcp.json")
            _add(proj_root / ".codex" / "config.toml")
            _add(proj_root / "opencode.json")
        else:
            keys = {
                operation_context.route(h_id, "mcp").adapter_key
                or operation_context.layout(h_id).mcp_adapter_key
                for h_id in installed
                if operation_context.layout(h_id) is not None
                and operation_context.route(h_id, "mcp").mode == "legacy_shadow"
                and operation_context.route(h_id, "mcp").status == "shadow"
            }
            if "claude" in keys:
                _add(proj_root / ".mcp.json")
            if "codex" in keys:
                _add(proj_root / ".codex" / "config.toml")
            if "opencode" in keys:
                _add(proj_root / "opencode.json")
    return files


def _write_preserving_newline(
    file: Path, existing_text: str, serialized: str, scope, harness_id: str
) -> None:
    """Backup-first + atomic write, preserving the file's existing
    trailing-newline state (C1 — the same pair `mcp_delivery.write_claude_approval`
    uses). `existing_text` must be the bytes read moments earlier; a caller
    that found nothing to change must never reach this function at all."""
    had_trailing_newline = existing_text.endswith("\n")
    if had_trailing_newline and not serialized.endswith("\n"):
        serialized += "\n"
    elif not had_trailing_newline and serialized.endswith("\n"):
        serialized = serialized[:-1]
    _backup_once_per_session(file, scope, harness_id)
    _atomic_replace(file, serialized)


def _remove_one_native_source(
    name: str, harness_id: Optional[str], scope_label: Optional[str], file: Path, scope, errors: list[str]
) -> bool:
    """Delete ONE native entry keyed by `name` from ONE source file. Changes
    NO registry state. Returns `True` ONLY when a key was actually found and
    the file rewritten — W3/W6: a caller must never report `renamed`/
    `removed_native`/`removed` for a source this returns `False` for. C1:
    backup-first (`_backup_once_per_session`) and atomic (`_atomic_replace`),
    preserves the file's existing trailing-newline state, and a failure is
    collected into `errors` (never swallowed by a bare `continue`)."""
    if not file.exists():
        return False
    try:
        if harness_id == "codex":
            if hub_core._tomlkit_missing():
                errors.append(f"{name}: tomlkit not installed — cannot edit {file}")
                return False
            import tomlkit

            existing_text = file.read_text(encoding="utf-8")
            doc = tomlkit.parse(existing_text)
            servers = doc.get("mcp_servers")
            if servers is None or name not in servers:
                return False
            del servers[name]
            _write_preserving_newline(file, existing_text, tomlkit.dumps(doc), scope, harness_id)
            return True
        elif harness_id == "opencode":
            existing_text = file.read_text(encoding="utf-8")
            data = json.loads(existing_text)
            servers = data.get("mcp")
            if not isinstance(servers, dict) or name not in servers:
                return False
            del servers[name]
            _write_preserving_newline(
                file, existing_text, json.dumps(data, indent=2, ensure_ascii=False), scope, harness_id
            )
            return True
        else:  # claude-code / pi
            existing_text = file.read_text(encoding="utf-8")
            data = json.loads(existing_text)
            changed = False
            if scope_label == "local":
                projects_block = data.get("projects")
                if isinstance(projects_block, dict):
                    for pb in projects_block.values():
                        if (
                            isinstance(pb, dict)
                            and isinstance(pb.get("mcpServers"), dict)
                            and name in pb["mcpServers"]
                        ):
                            del pb["mcpServers"][name]
                            changed = True
            else:
                servers = data.get("mcpServers")
                if isinstance(servers, dict) and name in servers:
                    del servers[name]
                    changed = True
            if not changed:
                return False
            _write_preserving_newline(
                file, existing_text, json.dumps(data, indent=2, ensure_ascii=False), scope, harness_id
            )
            return True
    except (OSError, json.JSONDecodeError) as e:
        errors.append(f"{name}: cannot update {file}: {e}")
        return False


def _remove_native_sources_by_own_name(sources: list[dict], scope, errors: list[str]) -> list[dict]:
    """Delete each of `sources` from its native file, by ITS OWN native key
    (`src["name"]`, the verbatim pre-slugify name) — the shape a rename
    needs (E3 rev 2 §2.2: `Sanity` via Claude and `sanity-x` via Codex both
    get deleted by their own literal names, never by one shared resolved
    slug) and the 2.3 "no adapter writes here" removal needs too. W3/W6:
    returns only the sources ACTUALLY removed — a caller building
    `renamed`/`removed_native` must never report one this omits. A source
    that misses (found nothing to delete, no exception raised) gets its own
    line in `errors` so the miss is never silently reported as a removal."""
    removed: list[dict] = []
    for src in sources:
        src_name = src.get("name") or ""
        file = Path(src.get("file", ""))
        before = len(errors)
        ok = _remove_one_native_source(src_name, src.get("harness"), src.get("scope"), file, scope, errors)
        if ok:
            removed.append(src)
        elif len(errors) == before:
            errors.append(f"{src_name}: not found in {file} (nothing removed)")
    return removed


def _mcp_remove_native_entry(name: str, cand: dict, scope, errors: list[str]) -> list[dict]:
    """The `remove` decision (only valid on a `stale` candidate): delete the
    native entry from every source it was found in — by EACH SOURCE'S OWN
    key (W3: `classify` groups by case-folded slug, so a stale candidate's
    sources can carry DIFFERENT native keys — `Sanity` via Claude vs.
    `sanity` via Codex — and deleting by the candidate's own resolved `name`
    silently no-op'd on every source whose real key differed). Returns the
    sources actually removed; a caller must not report `name` as removed
    when this is empty."""
    return _remove_native_sources_by_own_name(cand.get("sources", []), scope, errors)


def _match_discovered_entry(
    name: str,
    discovered: list,
    *,
    harness: Optional[str] = None,
    scope: Optional[str] = None,
    file: Optional[str] = None,
):
    """Match ONE raw `mcp_reconcile.DiscoveredMcp` for `name` by the
    (harness, scope) pair (W4 — a Claude local-vs-project conflict shares a
    harness id, so `scope` is what tells the two apart), with `file` as a
    tiebreaker when more than one still matches. Never reads a `classify()`
    candidate row (whose `spec`/`options[].spec` are redacted, F4/case 18).
    `harness=None` matches the first supported entry for `name` (the
    "new"/single-spec case, where every supported source shares the same
    spec by construction)."""
    candidates = [e for e in discovered if e.name == name and e.spec is not None]
    if harness is not None:
        candidates = [e for e in candidates if e.harness == harness]
    if scope is not None:
        candidates = [e for e in candidates if e.scope == scope]
    if len(candidates) > 1 and file is not None:
        narrowed = [e for e in candidates if e.file == file]
        if narrowed:
            candidates = narrowed
    return candidates[0] if candidates else None


def _source_for_option(
    cand: dict, harness: Optional[str], scope: Optional[str], file: Optional[str]
) -> Optional[dict]:
    """The `cand["sources"]` row (carries the REAL, pre-slugify native
    `.name`, E3 rev 2 §4) matching one `cand["options"]` entry's
    (harness, scope, file) — `options[]` rows themselves carry no native
    name (only `harness`/`scope`/`file`/`spec`)."""
    for src in cand.get("sources", []):
        if src.get("harness") == harness and src.get("scope") == scope and (file is None or src.get("file") == file):
            return src
    return None


def _raw_block_for(
    name: str,
    harness: Optional[str],
    discovered: list,
    *,
    scope: Optional[str] = None,
    file: Optional[str] = None,
) -> Optional[dict]:
    """The REAL (unredacted) `mcp:` block for `name` — re-derived from the raw
    `mcp_reconcile.DiscoveredMcp` list, never from a `classify()` candidate row
    (whose `spec`/`options[].spec` are redacted, F4/case 18)."""
    entry = _match_discovered_entry(name, discovered, harness=harness, scope=scope, file=file)
    return mcp_spec.spec_to_registry_block(entry.spec) if entry is not None else None


def _claim_one_native_entry(
    name: str,
    entry,
    scope_kind: str,
    proj_name: Optional[str],
    proj_root: Optional[Path],
    operation_context=None,
) -> Path:
    """Write the sidecar for ONE live native source of `name` right now,
    recording its CURRENT (real, never redacted) bytes as the managed value —
    so a later `remove` correctly declines to touch a hand-edited entry
    (W3), and the entry reads `already_managed` on the very next `hub mcp
    reconcile`, with no dependency on a following sync's adapter-level
    ownership heuristic. Returns the sidecar path written (C2 — the caller
    snapshots/restores it for rollback)."""
    if scope_kind == "global":
        root = Path(operation_context.data_home) if operation_context is not None else data_home()
        path = root / "state" / entry.harness / "global-mcp.managed.json"
        try:
            existing = json.loads(path.read_text()) if path.exists() else []
        except (OSError, json.JSONDecodeError):
            existing = []
        names = set(existing) | {name} if isinstance(existing, list) else {name}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(sorted(names), indent=2) + "\n")
        return path

    from skill_hub.domain.permissions import permissions as permissions_mod

    harness_id = entry.harness
    scope_obj = permissions_mod.ProjectScope(name=proj_name, path=str(proj_root))
    data_home_path = Path(operation_context.data_home) if operation_context is not None else None
    prior = permissions_mod.read_sidecar(
        harness_id, scope_obj, kind="mcp", data_home_path=data_home_path
    )
    managed_keys = set(prior.managed_keys) if prior is not None else set()
    managed_keys.add(name)
    managed_values = dict(prior.managed_values) if prior is not None else {}
    managed_values[name] = entry.native
    permissions_mod.write_sidecar(
        harness_id,
        scope_obj,
        sorted(managed_keys),
        Path(entry.file),
        kind="mcp",
        managed_values=managed_values,
        data_home_path=data_home_path,
    )
    return permissions_mod.sidecar_path(
        harness_id, scope_obj, kind="mcp", data_home_path=data_home_path
    )


def _claim_sidecar_path_for(
    entry, scope_kind: str, proj_name: Optional[str], proj_root: Optional[Path], operation_context=None
) -> Path:
    """The sidecar path `_claim_one_native_entry` will touch for `entry`,
    computed WITHOUT writing anything — used to add it to the rollback
    snapshot (C2) before the transaction runs."""
    if scope_kind == "global":
        root = Path(operation_context.data_home) if operation_context is not None else data_home()
        return root / "state" / entry.harness / "global-mcp.managed.json"
    from skill_hub.domain.permissions import permissions as permissions_mod

    scope_obj = permissions_mod.ProjectScope(name=proj_name, path=str(proj_root))
    return permissions_mod.sidecar_path(
        entry.harness, scope_obj, kind="mcp",
        data_home_path=Path(operation_context.data_home) if operation_context is not None else None,
    )


def _claim_unclaimed_native_entry(
    name: str,
    discovered: list,
    scope_kind: str,
    proj_name: Optional[str],
    proj_root: Optional[Path],
    native_options: list,
    operation_context=None,
) -> None:
    """F5's "claims ownership" path: claim EVERY native option in
    `native_options` (the `cand["options"]` rows minus the "registry" one) —
    not just the first — since a name can have more than one differing
    native source when cross-harness divergence and a registry mismatch
    happen at the same time."""
    for opt in native_options:
        entry = _match_discovered_entry(
            name, discovered, harness=opt.get("harness"), scope=opt.get("scope"), file=opt.get("file")
        )
        if entry is not None:
            _claim_one_native_entry(name, entry, scope_kind, proj_name, proj_root, operation_context)


def _option_label(o: dict) -> str:
    return f"{o['harness']}/{o['scope']}" if o.get("scope") else str(o["harness"])


def _apply_project_scope_ownership(
    resolved_import_name: str,
    cand: dict,
    chosen_block: dict,
    discovered: list,
    scope_kind: str,
    proj_name: Optional[str],
    proj_root: Optional[Path],
    scope_obj,
    claimed_out: list[dict],
    removed_native_out: list[dict],
    errors: list[str],
    claim_matching: bool = False,
    operation_context=None,
) -> None:
    """The 2.3 scope rule for a NON-renamed import. **Global scope: nothing**
    — the global writers overwrite by name and the tail sync replaces each
    global sidecar with what it wrote, so writing one here would turn a
    no-op into a deletion. **Project scope:** a source copy in a file no
    per-project adapter writes at this scope — today only Claude LOCAL
    (`~/.claude.json` → `projects.<abs>.mcpServers`) — is REMOVED,
    backup-first, winner or loser (a lingering copy there would shadow every
    later hub edit at runtime); every OTHER source whose bytes differ from
    the chosen block (a losing copy in a file that harness's own adapter
    DOES write at this scope) is CLAIMED so the next sync rewrites it. A
    source whose bytes already match the chosen block needs no explicit
    claim for an ordinary import — the ordinary sync/adapter no-sidecar
    auto-adopt path already picks it up next time (kept exactly as it
    worked before this wave).

    `claim_matching` (W11, `import-claim-only` only): that action fires
    exactly when a same-file source's bytes ALREADY equal `chosen_block`
    (that's what `already_managed` means) — so the "skip a matching source"
    rule above would claim NOTHING for it, ever, and the auto-adopt fallback
    only fires when NO sidecar file exists yet. A project whose sidecar
    already exists (and simply omits this name) would then see the row
    reappear on every reconcile forever. `claim_matching=True` claims a
    matching same-file source explicitly instead of skipping it."""
    if scope_kind != "project":
        return
    local_sources = [s for s in cand.get("sources", []) if s.get("scope") == "local"]
    if local_sources:
        # W6: report only what was ACTUALLY removed, not every source named.
        for s in _remove_native_sources_by_own_name(local_sources, scope_obj, errors):
            removed_native_out.append(
                {"harness": s.get("harness"), "scope": s.get("scope"), "file": s.get("file")}
            )
    for src in cand.get("sources", []):
        if src.get("scope") == "local":
            continue
        entry = _match_discovered_entry(
            src.get("name") or resolved_import_name,
            discovered,
            harness=src.get("harness"),
            scope=src.get("scope"),
            file=src.get("file"),
        )
        if entry is None or entry.spec is None:
            continue
        entry_block = mcp_spec.spec_to_registry_block(entry.spec)
        if entry_block == chosen_block and not claim_matching:
            continue
        _claim_one_native_entry(
            resolved_import_name, entry, scope_kind, proj_name, proj_root,
            operation_context,
        )
        claimed_out.append({"harness": entry.harness, "scope": entry.scope, "file": entry.file})


def _reconcile_apply_mcp(
    registry: dict,
    scope_kind: str,
    proj_name: Optional[str],
    proj_root: Optional[Path],
    candidates: list,
    discovered: list,
    decisions: list,
    installed: set,
    operation_context=None,
) -> dict:
    """Apply reconcile decisions as one transaction (copied structurally from
    `hub_cli/permissions.py:1486-1563`): snapshot the registry `skills`/
    `projects` blocks + every native file + sidecar path this scope may
    touch → mutate → `save_registry` → a SCOPE-LIMITED mcp sync (never the
    whole-registry `hub._auto_sync()` — `mcp_sync.sync_mcp_for_project` /
    `mcp_sync._run_global_mcp_dispatch`, the same scope-limited precedent
    `hub_cli/permissions.py`'s `_sync_scope_native` follows, C2) — on ANY
    failure, restore everything from the pre-apply snapshot (incl. removing a
    folder this call created) and re-raise.

    Every decision is validated (and its spec/harness/scope resolved) in a
    first pass, BEFORE any mutation, so a bad decision anywhere in the batch
    leaves nothing written — the fail-closed contract (INTERFACES §3).

    E3 rev 2 (§2.2/§2.3): `as` → the candidate's own `import_name` → its
    `name` resolves the REGISTRY key an import writes under (`resolved_import_name`
    below); two decisions resolving to the same key in one batch fail closed
    (`name_collision_in_batch`); a resolved name that differs from a native
    source's OWN key is a RENAME — every native source is removed, backup
    -first, and the 2.3 scope rule (claim/remove the other copies) does NOT
    also apply to that decision (grill finding 4: the two are mutually
    exclusive)."""
    import copy

    import hub
    from skill_hub.application.sync import mcp_sync

    by_name = {cnd["name"]: cnd for cnd in candidates}
    managed_now = mcp_reconcile.managed_names(
        scope_kind, proj_name, proj_root, operation_context
    )
    scope_obj_for_ownership = _mcp_scope(scope_kind, proj_name, proj_root)
    used_import_names: dict[str, str] = {}

    # ── Pass 1: validate every decision, resolve what an 'import' needs ──
    resolved: list[dict] = []
    for d in decisions:
        if not isinstance(d, dict):
            _die("each reconcile decision must be an object", code="other")
        action = d.get("action")
        name = d.get("name")
        if not name:
            _die("each reconcile decision needs a 'name'", code="other")
        # W12: `name` can still be the raw native key here (an `unsupported`
        # candidate's identity is never slugified) — bound it once so every
        # `_die` below that echoes it back is printable and length-capped,
        # never a raw NUL or an oversized native key. `by_name[name]` and
        # every internal identity use below stay on the real, un-bounded
        # `name` — only what reaches an error message/field is bounded.
        bounded_name = mcp_spec._bounded_detail(name)
        if action not in ("import", "keep", "unkeep", "skip", "remove"):
            _die(f"unknown reconcile decision action: {action!r}", code="other", exit_code=2)
        if name not in by_name:
            _die(
                f"reconcile decision names an unknown candidate: {bounded_name!r}",
                code="unknown_candidate",
                name=bounded_name,
                exit_code=2,
            )
        cand = by_name[name]

        if action in ("keep", "unkeep", "skip"):
            resolved.append({"decision": d, "name": name, "action": action})
            continue

        if action == "remove":
            if cand["status"] != "stale":
                _die(
                    f"'remove' is only valid on a stale candidate "
                    f"('{bounded_name}' is {cand['status']})",
                    code="other",
                    name=bounded_name,
                )
            resolved.append({"decision": d, "name": name, "action": action})
            continue

        # action == "import"
        if cand["status"] == "already_managed":
            # N15: a matching but not-yet-claimed candidate CLAIMS the
            # sidecar it was missing on this import, rather than a pure
            # no-op (which would let the row keep reappearing).
            still_unclaimed = name not in managed_now
            resolved.append(
                {
                    "decision": d,
                    "name": name,
                    "action": "import-claim-only" if still_unclaimed else "import-noop",
                }
            )
            continue
        if cand["status"] == "unsupported":
            _die(
                f"'{bounded_name}' cannot be imported: {cand.get('reason')}",
                code=_code_for_unsupported_reason(cand.get("reason")),
                reason=cand.get("reason"),
                name=bounded_name,
                exit_code=2,
            )
        if cand["status"] == "stale":
            _die(
                f"'{bounded_name}' is stale — only 'remove' or 'keep' apply, not 'import'",
                code="other",
                name=bounded_name,
                exit_code=2,
            )

        harness = d.get("harness")
        registry_claim = False
        block: Optional[dict] = None
        native_options: list[dict] = []

        if cand["status"] == "conflict":
            if not harness:
                opts = ", ".join(_option_label(o) for o in cand["options"])
                _die(
                    f"'{bounded_name}' is a conflict — pass a harness ({opts})",
                    code="ambiguous_option",
                    name=bounded_name,
                    exit_code=2,
                )
            # W4: match on (harness, scope) — a Claude local-vs-project
            # conflict shares a harness id, so scope disambiguates; file is
            # the final tiebreaker.
            scope_sel = d.get("scope")
            file_sel = d.get("file")
            matches = [o for o in cand["options"] if o["harness"] == harness]
            if scope_sel is not None:
                matches = [o for o in matches if o.get("scope") == scope_sel]
            if len(matches) > 1 and file_sel is not None:
                narrowed = [o for o in matches if o.get("file") == file_sel]
                if narrowed:
                    matches = narrowed
            if not matches:
                opts = ", ".join(_option_label(o) for o in cand["options"])
                _die(
                    f"'{bounded_name}': unknown harness/scope '{harness}'/{scope_sel!r} — options: {opts}",
                    code="ambiguous_option",
                    name=bounded_name,
                    exit_code=2,
                )
            if len(matches) > 1:
                opts = ", ".join(f"{_option_label(o)} file={o.get('file')}" for o in matches)
                _die(
                    f"'{bounded_name}': ambiguous option for harness '{harness}' — pass scope/file ({opts})",
                    code="ambiguous_option",
                    name=bounded_name,
                    exit_code=2,
                )
            match = matches[0]
            if harness == "registry":
                # F5: keep the registry's own definition untouched and CLAIM
                # ownership of every DIFFERING native entry as-is (m3/F5 —
                # "an import on it claims ownership ... rather than erroring
                # on a duplicate name"). No registry mutation, no folder, no
                # secret handling (nothing new is being registered). §2.2:
                # `import_name` is INERT on this branch — no rename.
                registry_claim = True
                native_options = [o for o in cand["options"] if o["harness"] != "registry"]
                prior_owner = used_import_names.get(name)
                if prior_owner is not None and prior_owner != name:
                    _die(
                        f"Two servers would both become '{bounded_name}'. Adopt them one at a time.",
                        code="name_collision_in_batch",
                        reason=f"name_collision_in_batch:{bounded_name}",
                        name=bounded_name,
                        exit_code=2,
                    )
                used_import_names[name] = name
                resolved.append(
                    {
                        "decision": d,
                        "name": name,
                        "action": "import",
                        "registry_claim": True,
                        "native_options": native_options,
                        "resolved_import_name": name,
                        "is_renamed": False,
                    }
                )
                continue
            # E3 rev 2: `discovered` entries carry their ORIGINAL native
            # name (`.name`), which now differs from `name` (the resolved
            # slug) whenever the candidate needed slugifying — match via the
            # candidate's OWN `sources[]` entry for this (harness, scope,
            # file) triple to find its real native key first.
            match_src = _source_for_option(cand, harness, match.get("scope"), match.get("file"))
            raw = _raw_block_for(
                (match_src.get("name") if match_src else None) or name,
                harness,
                discovered,
                scope=match.get("scope"),
                file=match.get("file"),
            )
            if raw is None:
                _die(
                    f"'{bounded_name}': no live source found under harness '{harness}'",
                    code="other",
                    name=bounded_name,
                    exit_code=2,
                )
            block = raw
        else:
            first_source = (cand.get("sources") or [None])[0]
            src_name = (first_source or {}).get("name")
            raw = _raw_block_for(src_name or name, None, discovered)
            if raw is None:
                _die(
                    f"'{bounded_name}': no live source found to import from",
                    code="other",
                    name=bounded_name,
                    exit_code=2,
                )
            block = raw

        # E3 rev 2 §2.2: `as` → the candidate's own `import_name` → `name`.
        as_override = d.get("as")
        if as_override is not None:
            as_slug = mcp_spec.slugify_server_name(as_override)
            if as_slug is None or as_slug != as_override:
                # W4: `as` comes off `--decisions-stdin` — bound it the same
                # way a stdin-controlled raw server name is bounded above.
                bounded_as = mcp_spec._bounded_detail(as_override)
                _die(
                    f"'{bounded_as}' cannot become a skill name even after lowercasing.",
                    code="invalid_name",
                    name=bounded_name,
                    exit_code=2,
                )
            resolved_import_name = as_slug
        else:
            resolved_import_name = cand.get("import_name") or name

        # N17 (E3 rev 2 §2.2): two decisions resolving to the same registry
        # key in one batch — refuse before pass 2 touches anything.
        prior_owner = used_import_names.get(resolved_import_name)
        if prior_owner is not None and prior_owner != name:
            _die(
                f"Two servers would both become '{resolved_import_name}'. Adopt them one at a time.",
                code="name_collision_in_batch",
                reason=f"name_collision_in_batch:{resolved_import_name}",
                name=bounded_name,
                exit_code=2,
            )
        used_import_names[resolved_import_name] = name

        spec = mcp_spec.spec_from_registry(resolved_import_name, {"mcp": block})

        # D-B (grill finding, closes the sync-bricking regression): every
        # import block is validated BEFORE it can reach `registry.yaml` —
        # today this is normally already caught by `normalize_native` at
        # discovery time (an invalid shape classifies `unsupported`), but a
        # registry-derived block (the `as`/rename path re-reads via
        # `spec_from_registry`) never passed through that normaliser.
        val_errors, _val_warnings = mcp_spec.validate_mcp_entry(resolved_import_name, {"mcp": block})
        if val_errors:
            _die(
                f"'{bounded_name}' cannot be imported: {'; '.join(val_errors)}",
                code="invalid_spec",
                name=bounded_name,
                exit_code=2,
            )

        secret_keys = mcp_spec.secret_keys_in_spec(spec)
        suggested_ref: Optional[dict] = None
        if secret_keys:
            allow_literal = bool(d.get("allow_literal"))
            replace_with_ref = bool(d.get("replace_with_ref"))
            # E3 rev 2 §2.7: `replace_with_ref` is NEVER offered for a URL
            # carrying `user:pw@` — there is no single header/env slot to
            # rewrite, only the whole URL. `allow_literal` still covers it.
            if allow_literal:
                block = dict(block)
                block["allow_literal_secrets"] = True
                spec = dataclasses.replace(spec, allow_literal_secrets=True)
            elif replace_with_ref and "url.userinfo" not in secret_keys:
                new_block = dict(block)
                headers = dict(new_block.get("headers") or {})
                env = dict(new_block.get("env") or {})
                for key in secret_keys:
                    bare_key, value = _secret_value_for_key(spec, key)
                    new_value, var_name = mcp_spec.suggest_ref(resolved_import_name, bare_key, value)
                    if bare_key in headers:
                        headers[bare_key] = new_value
                    elif bare_key in env:
                        env[bare_key] = new_value
                    # W7: the response names the suggested variable, so the
                    # caller can tell the user what to export. Derived from
                    # the RESOLVED import name (E3 rev 2 §2.1/2.6) so the
                    # registry's own `${VAR}` agrees with the one this
                    # response names, even under an `as` override.
                    suggested_ref = {"name": resolved_import_name, "key": bare_key, "var": var_name}
                if headers:
                    new_block["headers"] = headers
                if env:
                    new_block["env"] = env
                block = new_block
                spec = mcp_spec.spec_from_registry(resolved_import_name, {"mcp": block})
            else:
                # W6: the hatches THIS command has are the two decision
                # fields below — not `--allow-literal` (that flag belongs to
                # `hub mcp add|set`, which this reused message used to name).
                _fail_on_literal_secret(
                    name,
                    spec,
                    secret_keys,
                    hatch=(
                        'Pass "allow_literal": true in the decision to register it as '
                        'written, or "replace_with_ref": true to rewrite it to a ${VAR} '
                        "reference."
                    ),
                )

        # C2/W2/W3: `resolved_import_name` is the registry key an `import`
        # would write under — it is this candidate's OWN key only when it
        # equals `cand["import_name"]` (no `as` override, or an `as` that
        # happens to restate the same slug). Any OTHER case (an explicit
        # `as` pointing somewhere else) must never silently "claim" — that
        # is how an `as` used to overwrite an unrelated registered server
        # (C2). A name already registered under a NON-mcp-server type is
        # never claimable either way. Both refusals are `name_taken`,
        # decided BEFORE any write; a leftover `mcp-servers/<slug>/` folder
        # with no registry entry is the same refusal (W2 — folds the
        # `_register_mcp_skill` `dest.exists()` bare-text exit into this
        # pass-1 check so it can never fire mid-transaction).
        resolved_name_is_own = resolved_import_name == (cand.get("import_name") or name)
        existing_entry = (registry.get("skills") or {}).get(resolved_import_name)
        if existing_entry is not None and (
            existing_entry.get("type") != "mcp-server" or not resolved_name_is_own
        ):
            _die(
                f"'{resolved_import_name}' is already registered — cannot "
                f"import an MCP server under this name",
                code="name_taken",
                reason=f"name_taken:{resolved_import_name}",
                name=bounded_name,
                exit_code=2,
            )
        if existing_entry is None and not resolved_name_is_own:
            try:
                folder_exists = (skill_meta.hub_mcp_servers_dir() / resolved_import_name).exists()
            except OSError:
                folder_exists = False
            if folder_exists:
                _die(
                    f"'{resolved_import_name}' already has a folder under mcp-servers/",
                    code="name_taken",
                    reason=f"name_taken:{resolved_import_name}",
                    name=bounded_name,
                    exit_code=2,
                )
        claim_only = existing_entry is not None
        is_renamed = any((s.get("name") or "") != resolved_import_name for s in cand.get("sources", []))

        resolved.append(
            {
                "decision": d,
                "name": name,
                "action": "import",
                "block": block,
                "spec": spec,
                "claim_only": claim_only,
                "registry_claim": registry_claim,
                "suggested_ref": suggested_ref,
                "resolved_import_name": resolved_import_name,
                "is_renamed": is_renamed,
            }
        )

    # ── Snapshot for rollback (C2; E3 rev 2 widens this to every sidecar
    # ANY import decision may touch — the old `registry_claim`-only
    # condition is DROPPED, grill finding 3) ──
    pre_skills = copy.deepcopy(registry.get("skills") or {})
    pre_projects = copy.deepcopy(registry.get("projects") or {})
    touched_files: set = set(
        _scope_mcp_native_files(
            scope_kind,
            proj_root,
            set(operation_context.installed_harness_ids or ())
            if operation_context is not None
            else installed,
            operation_context,
        )
    )
    for r in resolved:
        cand = by_name[r["name"]]
        for src in cand.get("sources", []):
            if src.get("file"):
                touched_files.add(Path(src["file"]))
        if r["action"] in ("import", "import-claim-only"):
            # C3: widened to BOTH scopes — an F5 `harness: "registry"` claim
            # (registry_claim=True) writes this same sidecar at GLOBAL scope
            # too (`_claim_unclaimed_native_entry`), and a raise in the sync
            # tail must roll that write back exactly like the project-scope
            # one (grill finding 3, the D-review C2 shape reopened here).
            sources_to_check = r.get("native_options") or cand.get("sources", [])
            for opt in sources_to_check:
                entry = _match_discovered_entry(
                    opt.get("name") or r["name"], discovered, harness=opt.get("harness"),
                    scope=opt.get("scope"), file=opt.get("file"),
                )
                if entry is not None:
                    touched_files.add(
                        _claim_sidecar_path_for(entry, scope_kind, proj_name, proj_root, operation_context)
                    )

    snapshots: dict = {}
    for p in touched_files:
        try:
            snapshots[p] = p.read_bytes() if p.exists() else None
        except OSError:
            snapshots[p] = None
    created_dirs: list = []

    imported: list[str] = []
    removed: list[str] = []
    skipped: list[str] = []
    conflicts_resolved = 0
    suggested_refs: list[dict] = []
    renamed: list[dict] = []
    claimed: list[dict] = []
    removed_native: list[dict] = []
    errors: list[str] = []
    scope_obj_for_remove = _mcp_scope(scope_kind, proj_name, proj_root)

    def _rollback():
        registry["skills"] = pre_skills
        registry["projects"] = pre_projects
        try:
            hub_core.save_registry(registry)
        except Exception:
            pass
        for p, data in snapshots.items():
            try:
                if data is None:
                    if p.exists():
                        p.unlink()
                else:
                    p.write_bytes(data)
            except OSError:
                pass
        for d_ in created_dirs:
            shutil.rmtree(d_, ignore_errors=True)

    try:
        for r in resolved:
            name = r["name"]
            action = r["action"]
            cand = by_name[name]
            if action in ("keep", "unkeep"):
                continue
            if action == "skip":
                skipped.append(name)
                continue
            if action == "import-noop":
                skipped.append(name)
                continue
            if action == "import-claim-only":
                # N15: the block already matches — claim the sidecar it was
                # missing so the row cannot reappear next time. W10: this
                # must apply the SAME 2.3 scope rule every other import
                # does, not claim every source unconditionally — a
                # Claude-LOCAL source (`~/.claude.json`) is a file no
                # per-project adapter writes, so claiming it (the old
                # behaviour) wrote a project sidecar pointed at a file the
                # sync tail can never rewrite; it must be REMOVED instead.
                # Global scope claims/removes nothing (2.3), same as
                # `_apply_project_scope_ownership`'s own early return.
                registry_entry = (registry.get("skills") or {}).get(name) or {}
                chosen_block = mcp_spec.spec_to_registry_block(
                    mcp_spec.raw_spec_from_registry(name, registry_entry)
                )
                _apply_project_scope_ownership(
                    name,
                    cand,
                    chosen_block,
                    discovered,
                    scope_kind,
                    proj_name,
                    proj_root,
                    scope_obj_for_ownership,
                    claimed,
                    removed_native,
                    errors,
                    claim_matching=True,
                    operation_context=operation_context,
                )
                imported.append(name)
                continue
            if action == "remove":
                # W3/W6: only report `removed` when a source was ACTUALLY
                # deleted — a miss lands in `errors` instead of a silent
                # false "removed".
                if _mcp_remove_native_entry(name, cand, scope_obj_for_remove, errors):
                    removed.append(name)
                    # plans/G.md §5.13: every removal path deletes the
                    # catalogue AND the probe-cache row together, so a
                    # summary can never outlive its file.
                    mcp_probe.forget_server(name)
                continue

            # action == "import"
            if cand["status"] == "conflict":
                conflicts_resolved += 1

            if r.get("registry_claim"):
                # F5: the registry's own definition is untouched; claim every
                # differing native entry as hub-owned right now (the sidecar
                # write is immediate — it does not wait on "the following
                # sync", which would otherwise see registry != native and
                # leave it 'preserved' again).
                _claim_unclaimed_native_entry(
                    name, discovered, scope_kind, proj_name, proj_root, r.get("native_options", []),
                    operation_context,
                )
                imported.append(name)
                continue

            if r.get("suggested_ref"):
                suggested_refs.append(r["suggested_ref"])

            resolved_import_name = r["resolved_import_name"]
            spec = r["spec"]
            skills = registry.setdefault("skills", {})
            if r["claim_only"] and resolved_import_name in skills:
                entry = skills[resolved_import_name]
                entry["mcp"] = mcp_spec.spec_to_registry_block(spec, prior=entry.get("mcp"))
            else:
                dest = skill_meta.hub_mcp_servers_dir() / resolved_import_name
                _register_mcp_skill(
                    registry,
                    resolved_import_name,
                    spec,
                    description=f"Adopted via hub mcp reconcile: {resolved_import_name}",
                    scope=("global" if scope_kind == "global" else "project-specific"),
                )
                created_dirs.append(dest)

            if scope_kind == "project" and proj_name:
                enabled = registry["projects"][proj_name].setdefault("enabled", [])
                if resolved_import_name not in enabled:
                    enabled.append(resolved_import_name)

            # E3 rev 2 §2.2/§2.3 (grill finding 4 — mutually exclusive): a
            # RENAME removes every native source, by ITS OWN native key,
            # BEFORE the sync tail — no tick ever has both the old and new
            # keys. A non-renamed import applies the 2.3 scope rule instead
            # (claim same-scope losers; remove a Claude-local copy no
            # per-project adapter writes).
            if r["is_renamed"]:
                # W6: `renamed`/`removed_native` report only sources that
                # were ACTUALLY removed, never every source named.
                actually_removed = _remove_native_sources_by_own_name(
                    cand.get("sources", []), scope_obj_for_ownership, errors
                )
                seen_from: set[str] = set()
                for src in actually_removed:
                    src_name = src.get("name") or ""
                    if src_name and src_name != resolved_import_name and src_name not in seen_from:
                        seen_from.add(src_name)
                        renamed.append({"from": src_name, "to": resolved_import_name})
                    removed_native.append(
                        {"harness": src.get("harness"), "scope": src.get("scope"), "file": src.get("file")}
                    )
            else:
                _apply_project_scope_ownership(
                    resolved_import_name,
                    cand,
                    r["block"],
                    discovered,
                    scope_kind,
                    proj_name,
                    proj_root,
                    scope_obj_for_ownership,
                    claimed,
                    removed_native,
                    errors,
                    operation_context=operation_context,
                )

            imported.append(resolved_import_name)

        # W9: a batch of only keep/unkeep/skip/import-noop mutates nothing —
        # skip save_registry AND the sync tail entirely, report synced:false.
        synced = False
        delivery_rows: list[dict] = []
        if any(r["action"] in ("import", "import-claim-only", "remove") for r in resolved):
            hub_core.save_registry(registry)
            # C2: scope-limited sync only — never the whole-registry
            # `hub._auto_sync()`, so a batch here can never touch another
            # project's files (and the rollback snapshot above is complete).
            report = {"projects": {}, "global": {"mcp": {"writes": 0, "removed": 0, "delivery": []}}}
            if operation_context is not None:
                from skill_hub.application.harnesses.harness_operation_context import serialize_operation_context

                report["mcp_operation_context"] = serialize_operation_context(operation_context)
            if scope_kind == "global":
                mcp_sync._run_global_mcp_dispatch(
                    registry, installed, report=report,
                    operation_context=operation_context,
                )
            elif proj_name and proj_root is not None:
                proj_cfg_live = registry["projects"][proj_name]
                active = hub.resolve_project_skills(proj_cfg_live, registry)
                enabled_mcps = [
                    n
                    for n in active
                    if (registry.get("skills") or {}).get(n, {}).get("type") == "mcp-server"
                ]
                mcp_sync.sync_mcp_for_project(
                    proj_root,
                    enabled_mcps,
                    registry,
                    proj_name,
                    report=report,
                    operation_context=operation_context,
                )
            if scope_kind == "global":
                delivery_rows = report["global"]["mcp"]["delivery"]
            elif proj_name:
                delivery_rows = report["projects"].get(proj_name, {}).get("mcp_delivery", [])
            synced = True
    except BaseException:
        _rollback()
        raise

    return {
        "ok": True,
        "imported": imported,
        "removed": removed,
        "kept": [],
        "unkept": [],
        "skipped": skipped,
        "conflicts_resolved": conflicts_resolved,
        "synced": synced,
        "mcp_delivery": delivery_rows,
        "suggested_refs": suggested_refs,
        "renamed": renamed,
        "claimed": claimed,
        "removed_native": removed_native,
        "errors": errors,
    }


def cmd_mcp_reconcile(args) -> None:
    """Thin wrapper: N6 — `_json_mode` is reset on EVERY exit path (success
    included, via `finally`) — `_cmd_mcp_reconcile_impl` (several internal
    `return`s: discovery mode, `--apply` human/JSON) carries the real body
    unchanged; `finally` runs after ANY of them."""
    global _json_mode
    _json_mode = bool(getattr(args, "json", False))
    try:
        _cmd_mcp_reconcile_impl(args)
    finally:
        _json_mode = False


def _cmd_mcp_reconcile_impl(args) -> None:
    """`hub mcp reconcile` — discover MCP servers already configured natively
    (across Claude/pi/codex/opencode) and adopt chosen ones into the registry
    in one transaction. Mirrors `hub permissions reconcile`."""

    json_out = bool(getattr(args, "json", False))

    registry = hub_core.load_registry()

    if getattr(args, "global_", False):
        scope_kind = "global"
        proj_name = None
        project_cfg = None
        proj_root = None
    else:
        proj_name = getattr(args, "project", None)
        if not proj_name:
            _die("specify --global or --project <name>", code="other")
        if proj_name not in registry.get("projects", {}):
            _die(f"unknown project: {proj_name}", code="other")
        project_cfg = registry["projects"][proj_name]
        scope_kind = "project"
        proj_root = hub_core.expand(project_cfg.get("path", "."))

    scope_obj = _mcp_scope(scope_kind, proj_name, proj_root)
    from skill_hub.application.harnesses.harness_operation_context import KNOWN_HARNESSES, serialize_operation_context

    operation_context = _mcp_operation_context(args)
    installed = set(operation_context.installed_harness_ids or ())
    h_filter = getattr(args, "harness", None)
    captured_ids = set(operation_context.installed_harness_ids or ())
    known_harness_ids = set(operation_context.harness_ids) | set(KNOWN_HARNESSES)
    if h_filter is not None and h_filter not in known_harness_ids:
        # S1: a mistyped id silently discovered nothing before this check.
        ids = ", ".join(sorted(known_harness_ids))
        _die(f"unknown harness '{h_filter}' — expected one of: {ids}", code="other")
    elif h_filter is not None and h_filter not in captured_ids:
        # catalogue G02: "discovers nothing, no message" — now says why.
        _die(f"harness '{h_filter}' is not installed", code="other")

    discovered = mcp_reconcile.discover_native(
        scope_kind, project_cfg, registry, installed, h_filter, operation_context
    )
    managed = mcp_reconcile.managed_names(
        scope_kind, proj_name, proj_root, operation_context
    )
    candidates = mcp_reconcile.classify(
        discovered, registry, managed, operation_context
    )
    by_name = {cnd["name"]: cnd for cnd in candidates}

    apply_flag = bool(getattr(args, "apply", False))

    if apply_flag:
        if not getattr(args, "decisions_stdin", False):
            _die("--apply requires --decisions-stdin", code="other")
        try:
            payload = json.loads(sys.stdin.read() or "{}")
        except json.JSONDecodeError as e:
            _die(f"invalid decisions JSON: {e}", code="invalid_json")
        decisions = payload.get("decisions") or []

        with data_home_lock():
            sha_before = hub_core._registry_sha()
            summary = _reconcile_apply_mcp(
                registry, scope_kind, proj_name, proj_root, candidates, discovered, decisions,
                installed, operation_context,
            )
            append_audit(
                "mcp-reconcile-apply",
                args,
                sha_before,
                hub_core._registry_sha(),
                extra={
                    "imported": len(summary["imported"]),
                    "skipped": len(summary["skipped"]),
                },
            )
        kept_now, unkept_now = _record_mcp_kept_decisions(scope_obj, decisions, by_name)
        summary["kept"] = kept_now
        summary["unkept"] = unkept_now
        summary["mcp_operation_context"] = serialize_operation_context(operation_context)

        if json_out:
            print(json.dumps(summary, indent=2))
        else:
            print(
                f"{c('✓', GREEN)} mcp reconcile: {len(summary['imported'])} imported, "
                f"{len(summary['skipped'])} skipped, "
                f"{summary['conflicts_resolved']} conflict(s) resolved"
                + ("" if summary["synced"] else " (nothing to sync)")
            )
            for ref in summary["suggested_refs"]:
                print(f"  → export {ref['var']} for {ref['name']}.{ref['key']}")
            for err in summary["errors"]:
                print(f"  {c('!', YELLOW)} {err}")
        return

    # ── Discovery mode ──
    kept_names = _mcp_kept_names(scope_obj)
    visible = [cnd for cnd in candidates if cnd["name"] not in kept_names]
    view = {
        "ok": True,
        "scope_kind": scope_kind,
        "project": proj_name,
        "candidates": visible,
        "kept": _mcp_kept_display_names(scope_obj),
        "mcp_operation_context": serialize_operation_context(operation_context),
    }
    if json_out:
        print(json.dumps(view, indent=2))
        return

    print(f"\n{c('MCP reconcile — ' + scope_kind, BOLD)}\n")
    if not visible:
        print(f"  {c('·', DIM)} nothing to reconcile")
    for cnd in visible:
        status = cnd["status"]
        if status == "new":
            print(f"  {c('+', GREEN)} {cnd['name']} — new ({len(cnd['sources'])} source(s))")
        elif status == "conflict":
            opts = ", ".join(_option_label(o) for o in cnd["options"])
            print(f"  {c('!', YELLOW)} {cnd['name']} — CONFLICT ({opts})")
        elif status == "unsupported":
            print(f"  {c('×', DIM)} {cnd['name']} — unsupported ({cnd['reason']})")
        elif status == "stale":
            print(f"  {c('·', DIM)} {cnd['name']} — stale (registered, inactive here)")
        elif status == "already_managed":
            print(f"  {c('·', DIM)} {cnd['name']} — already managed")
        if cnd["warnings"]:
            print(f"      warnings: {', '.join(cnd['warnings'])}")
    if kept_names:
        print(f"\n  kept (suppressed): {', '.join(sorted(kept_names))}")
    print("\n  run with --apply --decisions-stdin to import, or --json for machine output")
