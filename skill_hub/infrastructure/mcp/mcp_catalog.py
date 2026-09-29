"""The MCP capability catalogue — the payload (plans/G.md §5.6-5.10).

`mcp_probe.py` stays about the WIRE (the JSON-RPC handshake, pagination,
correlation, the protocol-version fallback); this module owns the PAYLOAD:
the on-disk record shape, JSON-Schema flattening, sanitising server-authored
text, and the one-record-per-server store under
`<data_home>/state/mcp/catalogs/`.

A leaf: at module scope this imports stdlib + `hub_core` + `mcp_spec` only —
never `hub` (`tests/test_hub_split_guard.py::LEAF_SIBLINGS` enforces this).
Pure and synchronous: nothing here spawns a process or opens a socket, so it
is unit-tested directly, with no fixture server needed.

### Why a record can never outlive its file (plans/G.md §5.13)

`delete_catalog` is called from every path that removes an MCP server's
*liveness* row too (`hub_cli/archive.py::cmd_archive`, `hub mcp reconcile
--apply`'s `remove` decision, and — outside this wave's file list — a
`source_missing` drop in `hub_cli/source.py`) via `mcp_probe.forget_server`,
so a stale summary can never survive the server it described.

### Rev 3 — the protocol bump (plans/G.md §11)

`mcp_probe.PROTOCOL_VERSION` moved to `2025-06-18`, which makes `title`
(`Tool`/`Prompt`/`Resource`/`Implementation`), `outputSchema` (`Tool`), and
`annotations` (`Tool`) reachable. Every one of these fields is OPTIONAL in
the wire protocol AND in this record — a caller renders on PRESENCE, never
on a version comparison (§11.4). `annotations` values are `bool | None`,
where `None` means "the server did not declare this" and is distinct from
`False`.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Optional

from skill_hub import hub_core
from skill_hub.domain.mcp import mcp_spec

__all__ = [
    "CATALOG_SCHEMA_VERSION",
    "ITEM_LIMIT",
    "PARAM_LIMIT",
    "PAGE_LIMIT",
    "TEXT_LIMIT",
    "ENUM_LIMIT",
    "BYTES_LIMIT",
    "catalog_dir",
    "catalog_path",
    "read_catalog",
    "write_catalog",
    "delete_catalog",
    "flatten_parameters",
    "sanitize_text",
    "build_record",
    "summarize",
]

# ─────────────────────────────────────────────────────────────────────────────
# Constants (plans/G.md §5.6) — each justified against a measurement of
# `touchpoint` (~55 tools, ~200-char descriptions, ~8 params each ≈ 140 KB).
# ─────────────────────────────────────────────────────────────────────────────

CATALOG_SCHEMA_VERSION = 1
ITEM_LIMIT = 500  # per kind
PARAM_LIMIT = 100  # per tool, then parameters_truncated
PAGE_LIMIT = 20  # pagination stops on items >= ITEM_LIMIT OR pages >= PAGE_LIMIT
TEXT_LIMIT = 2000  # per description / instructions
ENUM_LIMIT = 12  # per parameter
BYTES_LIMIT = 2_000_000  # hard cap on the serialised record; truncate + flag

_KINDS = ("tools", "resources", "resource_templates", "prompts")

# ─────────────────────────────────────────────────────────────────────────────
# The store — `<data_home>/state/mcp/catalogs/<name>.json`
# ─────────────────────────────────────────────────────────────────────────────


def catalog_dir() -> Path:
    return hub_core.data_home() / "state" / "mcp" / "catalogs"


def catalog_path(name: str) -> Path:
    """The catalogue file for `name`. Validates the slug FIRST, before any
    path is built (plans/G.md §5.9 — `hub_cli/archive.py`'s precedent: a
    hand-edited registry key is a live traversal vector, and a
    case-insensitive filesystem collides `Foo`/`foo` onto one file)."""
    hub_core.validate_slug(name, "server name")
    return catalog_dir() / f"{name}.json"


def read_catalog(name: str) -> Optional[dict]:
    """The stored `<catalog record>` for `name`, or `None` if there is none
    or it is corrupt. Never raises."""
    path = catalog_path(name)
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    except (UnicodeDecodeError, ValueError):
        print(f"warning: corrupt MCP catalogue at {path}; treating as absent", file=sys.stderr)
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        print(f"warning: corrupt MCP catalogue at {path}; treating as absent", file=sys.stderr)
        return None
    if not isinstance(data, dict):
        print(f"warning: corrupt MCP catalogue at {path}; treating as absent", file=sys.stderr)
        return None
    return data


def write_catalog(name: str, record: dict) -> None:
    """Atomic write (sibling temp + replace) of one `<catalog record>`."""
    path = catalog_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def delete_catalog(name: str) -> None:
    """Remove `name`'s catalogue file, if any. Idempotent."""
    path = catalog_path(name)
    path.unlink(missing_ok=True)


# ─────────────────────────────────────────────────────────────────────────────
# Sanitising server-authored text (plans/G.md §5.10)
# ─────────────────────────────────────────────────────────────────────────────

_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]")
_NEWLINE_RE = re.compile(r"\r\n|\r|\n")


def sanitize_text(s: object) -> Optional[str]:
    """Strip C0/C1 control characters (except the newlines, handled next),
    collapse every CRLF/CR/LF run to a single space, then bound to
    `TEXT_LIMIT`. `None` for anything that is not a string, or that sanitizes
    down to the empty string (a description of pure control bytes reads the
    same as no description at all).

    Without this, a raw `\\x1b[` rewrites the terminal in the CLI's human
    table (and can hide text there), and an embedded newline breaks its
    column alignment — this repo has already been bitten by an invisible
    control byte in a corpus (a NUL rendered as a space)."""
    if not isinstance(s, str):
        return None
    cleaned = _NEWLINE_RE.sub(" ", s)
    cleaned = _CONTROL_RE.sub("", cleaned)
    if len(cleaned) > TEXT_LIMIT:
        cleaned = cleaned[:TEXT_LIMIT]
    return cleaned or None


def _sanitize_name(value: object) -> str:
    """Like `sanitize_text`, but for a field the record types as a bare
    `str` (never `str | None`) — an unreadable/empty name still needs a
    string, not `None`."""
    if not isinstance(value, str):
        return ""
    return sanitize_text(value) or ""


def _sanitize_uri(value: object) -> str:
    """A `uri`/`uri_template` is server-authored text AND may embed a
    credential (`?token=…`, `user:pw@host`) — sanitize control characters
    first, then run the result through `mcp_spec.redact_url_secrets` (plans/G.md
    §5.11). Always a `str` (never `None`) to match the record schema."""
    if not isinstance(value, str) or value == "":
        return ""
    cleaned = sanitize_text(value)
    if cleaned is None:
        return ""
    redacted = mcp_spec.redact_url_secrets(cleaned)
    return redacted if isinstance(redacted, str) else cleaned


# ─────────────────────────────────────────────────────────────────────────────
# Parameter flattening (plans/G.md §5.7) — top-level `inputSchema.properties`
# only, one level deep.
# ─────────────────────────────────────────────────────────────────────────────


def _derive_type(schema: dict) -> Optional[str]:
    t = schema.get("type")
    if isinstance(t, str):
        return t
    if isinstance(t, list):
        parts = [x for x in t if isinstance(x, str)]
        if parts:
            return "|".join(parts)
    for key in ("anyOf", "oneOf"):
        members = schema.get(key)
        if isinstance(members, list):
            parts = [
                m.get("type")
                for m in members
                if isinstance(m, dict) and isinstance(m.get("type"), str)
            ]
            if parts:
                return "|".join(parts)
    return None


def _flatten_one(name: str, schema: dict, required: bool) -> dict:
    type_str = _derive_type(schema)

    items_type: Optional[str] = None
    if type_str == "array":
        items = schema.get("items")
        if isinstance(items, dict) and isinstance(items.get("type"), str):
            items_type = items["type"]

    enum_out: Optional[list] = None
    enum_truncated = False
    enum_val = schema.get("enum")
    if isinstance(enum_val, list):
        enum_out = enum_val[:ENUM_LIMIT]
        enum_truncated = len(enum_val) > ENUM_LIMIT

    default_out = None
    if "default" in schema:
        dv = schema["default"]
        # Kept INCLUDING falsy scalars (`False`, `0`, `""`) — only a
        # container default is dropped, per plans/G.md §5.7's table.
        if not isinstance(dv, (dict, list)):
            default_out = dv

    description_out = sanitize_text(schema.get("description"))

    return {
        "name": name,
        "type": type_str,
        "required": bool(required),
        "description": description_out,
        "enum": enum_out,
        "enum_truncated": enum_truncated,
        "default": default_out,
        "items_type": items_type,
    }


def flatten_parameters(input_schema: object) -> tuple:
    """`(params, unreadable, truncated)` from a JSON-Schema `inputSchema` (or
    `outputSchema` — same shape). Never raises.

    `unreadable=True` (with `params == []`) when `input_schema` is absent,
    not a dict, or its `properties` is not a dict — this is what lets the UI
    say "declares no readable parameters" instead of the lie "no
    parameters". `truncated=True` when there were more than `PARAM_LIMIT`
    properties (only the first `PARAM_LIMIT`, in declaration order, are
    kept). A `required` entry naming a property that does not exist is
    silently ignored — it flags no output parameter."""
    if not isinstance(input_schema, dict):
        return [], True, False
    properties = input_schema.get("properties")
    if not isinstance(properties, dict):
        return [], True, False

    raw_required = input_schema.get("required")
    required_names = {r for r in raw_required if isinstance(r, str)} if isinstance(raw_required, list) else set()

    keys = list(properties.keys())
    truncated = len(keys) > PARAM_LIMIT
    keys = keys[:PARAM_LIMIT]

    params = []
    for key in keys:
        raw_schema = properties.get(key)
        schema = raw_schema if isinstance(raw_schema, dict) else {}
        params.append(_flatten_one(key, schema, key in required_names))
    return params, False, truncated


# ─────────────────────────────────────────────────────────────────────────────
# Per-item builders (rev 3 §11.5 fields included) — private: `build_record`
# is the only public entry point that assembles a full record.
# ─────────────────────────────────────────────────────────────────────────────

#: Output key -> the MCP wire key it reads (plans/G.md §11.1, ToolAnnotations,
#: protocol revision 2025-03-26).
_ANNOTATION_KEYS = {
    "read_only": "readOnlyHint",
    "destructive": "destructiveHint",
    "idempotent": "idempotentHint",
    "open_world": "openWorldHint",
}


def _build_annotations(raw: object) -> dict:
    """`{read_only, destructive, idempotent, open_world}`, each `bool |
    None` — `None` means the server did not declare that hint, distinct
    from an explicit `False` (plans/G.md §11.5)."""
    ann = raw if isinstance(raw, dict) else {}
    out: dict = {}
    for out_key, wire_key in _ANNOTATION_KEYS.items():
        v = ann.get(wire_key)
        out[out_key] = v if isinstance(v, bool) else None
    return out


def _build_tool(raw: dict) -> dict:
    output_schema = raw.get("outputSchema")
    output_present = isinstance(output_schema, dict)
    if output_present:
        output_params, output_unreadable, _output_truncated = flatten_parameters(output_schema)
    else:
        output_params, output_unreadable = [], False

    params, unreadable, truncated = flatten_parameters(raw.get("inputSchema"))

    return {
        "name": _sanitize_name(raw.get("name")),
        "title": sanitize_text(raw.get("title")),
        "description": sanitize_text(raw.get("description")),
        "parameters": params,
        "schema_unreadable": unreadable,
        "parameters_truncated": truncated,
        "annotations": _build_annotations(raw.get("annotations")),
        "output_parameters": output_params,
        "output_schema_present": output_present,
        "output_schema_unreadable": bool(output_present and output_unreadable),
    }


def _build_resource(raw: dict) -> dict:
    return {
        "uri": _sanitize_uri(raw.get("uri")),
        "name": sanitize_text(raw.get("name")),
        "title": sanitize_text(raw.get("title")),
        "description": sanitize_text(raw.get("description")),
        "mime_type": sanitize_text(raw.get("mimeType")),
    }


def _build_resource_template(raw: dict) -> dict:
    return {
        "uri_template": _sanitize_uri(raw.get("uriTemplate")),
        "name": sanitize_text(raw.get("name")),
        "title": sanitize_text(raw.get("title")),
        "description": sanitize_text(raw.get("description")),
        "mime_type": sanitize_text(raw.get("mimeType")),
    }


def _build_prompt_argument(raw: dict) -> dict:
    return {
        "name": _sanitize_name(raw.get("name")),
        "description": sanitize_text(raw.get("description")),
        "required": bool(raw.get("required", False)),
    }


def _build_prompt(raw: dict) -> dict:
    raw_args = raw.get("arguments")
    args = [
        _build_prompt_argument(a) for a in raw_args if isinstance(a, dict)
    ] if isinstance(raw_args, list) else []
    return {
        "name": _sanitize_name(raw.get("name")),
        "title": sanitize_text(raw.get("title")),
        "description": sanitize_text(raw.get("description")),
        "arguments": args,
    }


# ─────────────────────────────────────────────────────────────────────────────
# The record (plans/G.md §5.8, rev 3 §11.5)
# ─────────────────────────────────────────────────────────────────────────────


def _enforce_bytes_limit(record: dict) -> dict:
    """`BYTES_LIMIT` is a hard cap on the serialised record. Over budget:
    repeatedly drop the LAST item of whichever kind currently holds the most
    items, flagging that kind `truncated` too, until back under budget (or
    every kind is empty). Deterministic and always terminates."""

    def _size(rec: dict) -> int:
        return len(json.dumps(rec).encode("utf-8"))

    if _size(record) <= BYTES_LIMIT:
        return record

    record = dict(record)
    record["truncated"] = dict(record["truncated"])
    for k in _KINDS:
        record[k] = list(record[k])

    budget_iterations = sum(len(record[k]) for k in _KINDS) + 1
    while _size(record) > BYTES_LIMIT and budget_iterations > 0:
        target = max(_KINDS, key=lambda k: len(record[k]))
        if not record[target]:
            break
        record[target].pop()
        record["truncated"][target] = True
        budget_iterations -= 1

    while _size(record) > BYTES_LIMIT:
        changed = False

        def _shrink(value: object) -> object:
            nonlocal changed
            if isinstance(value, str) and value:
                changed = True
                return value[: max(0, len(value) // 2)]
            if isinstance(value, list):
                return [_shrink(item) for item in value]
            if isinstance(value, dict):
                return {key: _shrink(item) for key, item in value.items()}
            return value

        record = _shrink(record)
        if not changed:
            record = {
                "schema_version": CATALOG_SCHEMA_VERSION,
                "name": "",
                "tools": [],
                "resources": [],
                "resource_templates": [],
                "prompts": [],
                "truncated": {k: True for k in _KINDS},
                "bytes_truncated": True,
                "fetch_errors": [],
            }
            break

    record["bytes_truncated"] = True
    return record


def build_record(
    *,
    name: str,
    transport: str,
    protocol_version: Optional[str],
    protocol_fallback: bool,
    server_name: object = None,
    server_version: object = None,
    server_title: object = None,
    instructions: object = None,
    capabilities: object = None,
    raw_tools: Optional[list] = None,
    raw_resources: Optional[list] = None,
    raw_resource_templates: Optional[list] = None,
    raw_prompts: Optional[list] = None,
    offered: Optional[dict] = None,
    truncated: Optional[dict] = None,
    fetch_errors: Optional[list] = None,
) -> dict:
    """Assemble one `<catalog record>` (plans/G.md §5.8, rev 3 §11.5) from
    raw, already-parsed MCP protocol objects. `mcp_probe` hands this
    function the wire's own dicts (a `Tool`, a `Resource`, …) — every
    sanitising/flattening/redacting step happens HERE, once, so the wire
    module stays about correlation and pagination only.

    `capabilities` is the raw `capabilities` object from the `initialize`
    result (or `None`) — only its top-level KEY NAMES are kept (diagnostic
    only, plans/G.md §5.4: stored and printed by the CLI, never rendered in
    the app)."""
    caps_list: list = []
    if isinstance(capabilities, dict):
        caps_list = sorted(
            sanitized
            for k in capabilities.keys()
            if isinstance(k, str)
            for sanitized in [sanitize_text(k)]
            if sanitized is not None
        )

    tools_out = [_build_tool(t) for t in (raw_tools or []) if isinstance(t, dict)]
    resources_out = [_build_resource(r) for r in (raw_resources or []) if isinstance(r, dict)]
    templates_out = [
        _build_resource_template(t) for t in (raw_resource_templates or []) if isinstance(t, dict)
    ]
    prompts_out = [_build_prompt(p) for p in (raw_prompts or []) if isinstance(p, dict)]

    offered_map = offered or {}
    truncated_map = truncated or {}

    record = {
        "schema_version": CATALOG_SCHEMA_VERSION,
        "name": name,
        "fetched_at": hub_core._now_iso(),
        "transport": transport,
        "protocol_version": protocol_version,
        "server_title": sanitize_text(server_title),
        "protocol_fallback": bool(protocol_fallback),
        "server_name": sanitize_text(server_name),
        "server_version": sanitize_text(server_version),
        "instructions": sanitize_text(instructions),
        "capabilities": caps_list,
        "offered": {k: bool(offered_map.get(k, False)) for k in _KINDS},
        "tools": tools_out,
        "resources": resources_out,
        "resource_templates": templates_out,
        "prompts": prompts_out,
        "truncated": {k: bool(truncated_map.get(k, False)) for k in _KINDS},
        "bytes_truncated": False,
        "fetch_errors": [dict(e) for e in (fetch_errors or []) if isinstance(e, dict)],
    }
    return _enforce_bytes_limit(record)


# ─────────────────────────────────────────────────────────────────────────────
# The summary that rides the probe row (plans/G.md §5.12, `<catalog summary>`)
# ─────────────────────────────────────────────────────────────────────────────

#: The JSON-RPC method name each kind's fetch failure is recorded under in
#: `fetch_errors` — how `summarize` computes `unknown`.
_KIND_METHOD = {
    "tools": "tools/list",
    "resources": "resources/list",
    "resource_templates": "resources/templates/list",
    "prompts": "prompts/list",
}


def summarize(record: dict) -> dict:
    """`<catalog summary>` (plans/G.md §5.12) — the small shape that rides
    the probe row as `catalog`, so the glance block needs no second call.
    `unknown` lists kinds whose fetch errored (as opposed to a clean `-32601`
    absence), so the app can render "resources: unknown" instead of the lie
    "0 resources"."""
    fetch_errors = record.get("fetch_errors") or []
    errored_methods = {e.get("method") for e in fetch_errors if isinstance(e, dict)}
    unknown = [k for k in _KINDS if _KIND_METHOD[k] in errored_methods]

    offered = record.get("offered") or {}
    return {
        "tools": len(record.get("tools") or []),
        "resources": len(record.get("resources") or []),
        "resource_templates": len(record.get("resource_templates") or []),
        "prompts": len(record.get("prompts") or []),
        "offered": {k: bool(offered.get(k, False)) for k in _KINDS},
        "unknown": unknown,
        "server_name": record.get("server_name"),
        "server_version": record.get("server_version"),
        "instructions": bool(record.get("instructions")),
        "errors": len(fetch_errors),
    }
