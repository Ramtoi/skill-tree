"""Merge-preserving edits of a `mcp_servers:` mapping inside a YAML document.

Hermes keeps MCP servers under a top-level `mcp_servers:` key in its
`config.yaml`. The connector must add/update/remove only Hub-owned server keys
while leaving every other key — AND every comment, blank line, key order, and
scalar quoting style — of the document byte-stable. This is the same
merge-preserving discipline the existing MCP/permission adapters apply to
JSON/TOML, extended to YAML.

Backend policy (D14 — upgrade-safe, never reformat the user's config):
  * **WRITES** (`merge_mcp_servers`) require `ruamel.yaml` for a true round-trip
    that preserves comments + formatting. If ruamel is NOT importable the write
    **FAILS CLOSED** — it raises `YamlBackendUnavailable` rather than falling
    back to a lossy PyYAML re-serialization that would strip every comment and
    reformat the whole file. The sync pass treats a connector error
    non-fatally, so skills still push; only the (now-skipped) config edit is
    reported with a warning. Silent reformatting is strictly worse than a
    skipped edit.
  * **READS** (`read_mcp_servers`) only need the parsed data, so they may use
    `ruamel.yaml` when present and fall back to PyYAML otherwise.

ruamel is configured for maximum fidelity: `preserve_quotes=True`, a very wide
`width` so long scalars are never re-wrapped, `allow_unicode=True` so unicode
(e.g. ◕‿◕ / 🔥) stays LITERAL rather than `\\uXXXX`-escaped, and indentation
matching typical config (mapping=2, sequence=4, offset=2) so a no-op round-trip
is a minimal/zero diff.

Only the `mcp_servers` mapping is treated as hub-owned. The set of hub-owned
*entries* within it is the caller's responsibility (driven by the ownership
sidecar) — `merge_mcp_servers` replaces the named keys and deletes the named
removals, never touching sibling keys.
"""

from __future__ import annotations

import io
from typing import Optional

MCP_KEY = "mcp_servers"

# Round-trip emitter fidelity knobs (see module docstring).
_YAML_WIDTH = 4096  # effectively never re-wrap long scalars


class YamlBackendUnavailable(RuntimeError):
    """The required YAML backend is not importable.

    For WRITES this means `ruamel.yaml` could not be imported — the write is
    refused (fail-closed) rather than silently reformatting via PyYAML.
    For READS it means neither ruamel.yaml nor PyYAML is available.
    """


def _load_ruamel():
    """Return ruamel.yaml's `YAML` class, or None if it cannot be imported.

    ruamel works pure-Python; the optional `ruamel.yaml.clib` C-extension is not
    required (and is stripped from the vendored bundle), so its absence must not
    prevent import.
    """
    try:
        from ruamel.yaml import YAML  # type: ignore

        return YAML
    except Exception:
        return None


def _load_pyyaml():
    # hub.py prepends the vendored copy to sys.path at its import, so by the time
    # any connector runs inside the CLI, `import yaml` resolves to the bundled
    # PyYAML. We import lazily here so this module stays importable standalone.
    try:
        import yaml  # type: ignore

        return yaml
    except Exception:
        return None


def _ruamel_writer():
    """Build a fidelity-configured ruamel `YAML()` for round-trip WRITES.

    Raises `YamlBackendUnavailable` if ruamel is not importable — callers on the
    write path must fail closed rather than reformat the document.
    """
    yaml_cls = _load_ruamel()
    if yaml_cls is None:
        raise YamlBackendUnavailable(
            "ruamel.yaml is required for comment- and format-preserving YAML "
            "writes but is not importable; refusing to fall back to a lossy "
            "PyYAML re-serialization (would strip comments + reformat the file). "
            "Vendor or install ruamel.yaml."
        )
    yaml = yaml_cls()  # round-trip ("rt") mode is ruamel's default.
    yaml.preserve_quotes = True
    yaml.width = _YAML_WIDTH
    yaml.allow_unicode = True  # emit unicode literally, never \\uXXXX
    # Indentation matching typical config so a no-op round-trip is minimal-diff.
    yaml.indent(mapping=2, sequence=4, offset=2)
    return yaml


def merge_mcp_servers(
    doc_text: str,
    *,
    upserts: Optional[dict] = None,
    removals: Optional[set[str]] = None,
) -> str:
    """Return `doc_text` with the `mcp_servers` map merged (ruamel round-trip).

    `upserts` keys are set to their given values (added or replaced); `removals`
    names are deleted from `mcp_servers`. Every other top-level key — and every
    `mcp_servers` entry not named, every comment, blank line, key order and
    quoting style — is preserved. An empty/whitespace `doc_text` is treated as
    an empty document.

    FAILS CLOSED (`YamlBackendUnavailable`) if ruamel.yaml is unavailable — it
    never falls back to a comment-stripping PyYAML write.
    """
    upserts = dict(upserts or {})
    removals = set(removals or set())

    yaml = _ruamel_writer()
    data = yaml.load(doc_text) if doc_text.strip() else None
    if data is None:
        data = {}
    servers = data.get(MCP_KEY)
    if servers is None:
        servers = {}
        data[MCP_KEY] = servers
    for name, spec in upserts.items():
        servers[name] = spec
    for name in removals:
        if name in servers:
            del servers[name]
    buf = io.StringIO()
    yaml.dump(data, buf)
    return buf.getvalue()


def merge_external_dir(doc_text: str, dir_path: str) -> str:
    """Ensure `dir_path` is in `skills.external_dirs` (ruamel round-trip).

    Merge-preserving: only the `skills.external_dirs` list is touched; every
    other config key, comment and format survives. Idempotent (no-op when the
    path is already present). FAILS CLOSED if ruamel.yaml is unavailable.
    """
    yaml = _ruamel_writer()
    data = yaml.load(doc_text) if doc_text.strip() else None
    if data is None:
        data = {}
    skills = data.get("skills")
    if skills is None:
        skills = {}
        data["skills"] = skills
    ext = skills.get("external_dirs")
    if ext is None:
        ext = []
        skills["external_dirs"] = ext
    if dir_path not in list(ext):
        ext.append(dir_path)
    buf = io.StringIO()
    yaml.dump(data, buf)
    return buf.getvalue()


def _read_data(doc_text: str):
    """Parse `doc_text` to plain data — ruamel if present, else PyYAML.

    Reads do not reformat anything, so the lossy-but-correct PyYAML parser is an
    acceptable fallback here (unlike writes).
    """
    if not doc_text.strip():
        return None
    yaml_cls = _load_ruamel()
    if yaml_cls is not None:
        return yaml_cls(typ="safe").load(doc_text)
    pyyaml = _load_pyyaml()
    if pyyaml is None:
        raise YamlBackendUnavailable(
            "no YAML backend available (need ruamel.yaml or PyYAML) to read"
        )
    return pyyaml.safe_load(doc_text)


def read_mcp_servers(doc_text: str) -> dict:
    """Parse and return the `mcp_servers` mapping (empty dict if absent)."""
    data = _read_data(doc_text)
    if not isinstance(data, dict):
        return {}
    servers = data.get(MCP_KEY)
    return dict(servers) if isinstance(servers, dict) else {}


def read_external_dirs(doc_text: str) -> list:
    """Return `skills.external_dirs` (empty list if absent)."""
    data = _read_data(doc_text)
    if not isinstance(data, dict):
        return []
    skills = data.get("skills")
    if not isinstance(skills, dict):
        return []
    ext = skills.get("external_dirs")
    return list(ext) if isinstance(ext, list) else []
