"""Comment/format-preserving edits of `[mcp_servers.<name>]` tables in a TOML doc.

Codex keeps MCP servers under top-level `[mcp_servers.<name>]` tables in its
`config.toml`. A connector must add/update/remove only Hub-owned server tables
while leaving every other table, comment, blank line, key order, and quoting
style of the document byte-stable. This is the same merge-preserving discipline
the existing `mcp_adapters.CodexMcpAdapter` applies to a project root, but here
the helper operates on **arbitrary file content** (a `doc_text` string) so the
remote connector can read a box's `config.toml`, merge, and write it back —
exactly parallel to `yaml_mcp.merge_mcp_servers`.

Backend policy (mirrors `yaml_mcp`, upgrade-safe — never reformat the user's
config):
  * **WRITES** (`merge_mcp_servers`) require `tomlkit` for a comment-preserving
    round-trip. tomlkit is a vendored dependency (see `mcp_adapters`), so its
    absence is exceptional; if it is NOT importable the write **FAILS CLOSED**
    (`TomlBackendUnavailable`) rather than falling back to a lossy re-serializer
    that would strip every comment and reformat the file. A connector treats the
    error non-fatally (skills still push; only the config edit is reported).
  * **READS** (`read_mcp_servers`) only need the parsed data; tomlkit parses
    losslessly, so reads use it too (no second backend needed — TOML has no
    stdlib reader before 3.11's `tomllib`, and tomlkit is always vendored).

Only the `mcp_servers` table is treated as hub-owned. The set of hub-owned
*entries* within it is the caller's responsibility (driven by the ownership
sidecar) — `merge_mcp_servers` replaces the named keys and deletes the named
removals, never touching sibling keys or tables.
"""

from __future__ import annotations

from typing import Optional

MCP_KEY = "mcp_servers"


class TomlBackendUnavailable(RuntimeError):
    """`tomlkit` could not be imported.

    For WRITES this means the comment-preserving round-trip is impossible — the
    write is refused (fail-closed) rather than silently reformatting. For READS
    it means no parser is available.
    """


def _load_tomlkit():
    """Return the `tomlkit` module, or None if it cannot be imported.

    hub.py prepends the vendored copy to sys.path at its import, so by the time
    any connector runs inside the CLI `import tomlkit` resolves to the bundled
    copy. We import lazily here so this module stays importable standalone.
    """
    try:
        import tomlkit  # type: ignore

        return tomlkit
    except Exception:
        return None


def _spec_to_table(tomlkit, spec: dict):
    """Build a `[mcp_servers.<name>]` table from a hub MCP spec dict.

    Mirrors `mcp_adapters.CodexMcpAdapter._spec_to_table`: emits `command`,
    `args`, `env` (and an optional `cwd`) so a server written here is shaped
    identically to one the local Codex adapter would write.
    """
    table = tomlkit.table()
    table.add("command", spec.get("command", ""))
    table.add("args", list(spec.get("args", [])))
    table.add("env", dict(spec.get("env", {})))
    cwd = spec.get("cwd")
    if cwd is not None:
        table.add("cwd", cwd)
    return table


def merge_mcp_servers(
    doc_text: str,
    *,
    upserts: Optional[dict] = None,
    removals: Optional[set] = None,
) -> str:
    """Return `doc_text` with the `mcp_servers` tables merged (tomlkit round-trip).

    `upserts` maps server-name → spec dict (added or replaced); `removals` names
    are deleted from `mcp_servers`. Every other table — and every `mcp_servers`
    entry not named, every comment, blank line, key order and quoting style — is
    preserved. An empty/whitespace `doc_text` is treated as an empty document.

    FAILS CLOSED (`TomlBackendUnavailable`) if tomlkit is unavailable — it never
    falls back to a comment-stripping write.
    """
    upserts = dict(upserts or {})
    removals = set(removals or set())

    tomlkit = _load_tomlkit()
    if tomlkit is None:
        raise TomlBackendUnavailable(
            "tomlkit is required for comment- and format-preserving TOML writes "
            "but is not importable; refusing to fall back to a lossy "
            "re-serialization (would strip comments + reformat the file). "
            "Vendor or install tomlkit."
        )

    doc = tomlkit.parse(doc_text) if doc_text.strip() else tomlkit.document()
    servers = doc.get(MCP_KEY)
    if servers is None:
        servers = tomlkit.table()
        doc.add(MCP_KEY, servers)
    for name, spec in upserts.items():
        servers[name] = _spec_to_table(tomlkit, spec)
    for name in removals:
        if name in servers:
            del servers[name]
    return tomlkit.dumps(doc)


def read_mcp_servers(doc_text: str) -> dict:
    """Parse and return the `mcp_servers` mapping as plain data (empty if absent).

    Returns a plain `dict` of `name → spec dict` (tomlkit containers unwrapped to
    builtin types) so callers can hash/compare them without tomlkit's wrapper
    objects leaking into the connector. Raises `TomlBackendUnavailable` if no
    parser is available; an unparseable document raises (caller decides how to
    treat a malformed remote config).
    """
    if not doc_text.strip():
        return {}
    tomlkit = _load_tomlkit()
    if tomlkit is None:
        raise TomlBackendUnavailable(
            "no TOML backend available (need tomlkit) to read mcp_servers"
        )
    doc = tomlkit.parse(doc_text)
    servers = doc.get(MCP_KEY)
    if servers is None:
        return {}
    return _unwrap(servers)


def _unwrap(value):
    """Recursively convert tomlkit containers into builtin dict/list/scalars."""
    # tomlkit tables/inline-tables behave like mappings; arrays like sequences.
    if hasattr(value, "items") and not isinstance(value, (str, bytes)):
        return {str(k): _unwrap(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_unwrap(v) for v in value]
    # Unwrap tomlkit scalar wrappers (Integer/String/etc.) to their python value.
    try:
        from tomlkit.items import Item  # type: ignore

        if isinstance(value, Item) and hasattr(value, "unwrap"):
            return value.unwrap()
    except Exception:
        pass
    return value
