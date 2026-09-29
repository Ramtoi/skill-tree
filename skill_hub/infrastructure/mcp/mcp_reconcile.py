"""Discover MCP servers already configured natively and classify them for
`hub mcp reconcile` (plans/D.md, wave D).

A leaf module: at MODULE SCOPE this imports stdlib, `mcp_spec`, `hub_core`,
`permissions` (for the project-sidecar reader — INTERFACES §1 "sidecar
representative harness"), `harnesses`, and (since wave E3 rev 2, for the
`name_taken` folder-collision check in `classify`) `skill_meta` only. It
NEVER imports `hub` or `hub_cli` — `tests/test_hub_split_guard.py::LEAF_SIBLINGS`
enforces this by scanning the whole file text, not just module scope, so no
function may do `import hub` either. This module opens no file for writing —
it only reads.

Wave E3 rev 2 (`plans/E3.md` §2.1-§2.3, `plans/E3.edge-cases.md`) hardens
discovery: every `_discover_*` function calls the selected decoder through
`mcp_spec.normalize_native` (never raises — D-A closed, no per-entry
try/except needed any more), `classify` groups candidates by the CASE-FOLDED SLUG
(`mcp_spec.slugify_server_name`) instead of the raw native name, every row
gains an `import_name` field, and `invalid_name`/`name_taken:<slug>` are
decided here (not only at apply time).

Two entry points, exactly INTERFACES.md §3/§1:

    discover_native(scope_kind, project_cfg, registry, installed,
                     harness_filter=None) -> list[DiscoveredMcp]
    classify(discovered, registry, managed_names) -> list[dict]   # <candidate row>

plus `managed_names(...)`, the reader `hub_cli/mcp.py::cmd_mcp_reconcile` calls
before `classify` to know which discovered names are already sidecar-claimed.

Classification vocabulary (plans/D.md §2, incl. the W1 deferred `stale` status):

    already_managed  — registered as an mcp-server AND sidecar-claimed here.
    stale            — registered as an mcp-server, found natively, NOT
                        sidecar-claimed, and NOT active at this scope (a
                        disabled source, an unequipped server). `remove` is
                        the only decision that applies to it.
    unsupported      — cannot become a registry spec (see `UNSUPPORTED_REASONS`).
    conflict         — divergent specs across harnesses, OR a registered
                        (but unclaimed) entry whose spec disagrees with (or
                        merely exists alongside) what was found natively
                        (F5 — carries the `unclaimed_native_entry` warning and
                        a `{"harness": "registry", "spec": ...}` option; an
                        `import` against that option claims ownership without
                        re-registering).
    new              — everything else. Identical spec across harnesses
                        collapses into one candidate with several `sources`.

Per-harness native shapes hub cannot represent are translated by the selected
SDK decoder before the host bridge restores `McpServerSpec`: Codex's
`auth = "oauth"` value and `http_headers_helper` key, OpenCode's own
`{"type": "local"|"remote", ...}` entries, and Claude's
`oauth`/`headersHelper` forms all retain their refusal reasons.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from skill_hub.domain.mcp import mcp_spec
from skill_hub.domain.permissions import permissions
from skill_hub.domain.skills import skill_meta
from skill_hub.hub_core import _tomlkit_missing, data_home, expand
from skill_hub.infrastructure.harnesses import harnesses

if TYPE_CHECKING:  # pragma: no cover - typing only
    from skill_hub.application.harnesses.harness_operation_context import OperationAdapterContext

# ─────────────────────────────────────────────────────────────────────────────
# Vocabulary
# ─────────────────────────────────────────────────────────────────────────────

#: INTERFACES §3 "unsupported reason vocabulary" — closed set. Every reason
#: `discover_native`/`classify` can emit is one of these (case 22 pins this).
UNSUPPORTED_REASONS = frozenset(
    {
        "ws_transport",
        "oauth_block",
        "headers_helper",
        "unknown_shape",
        "local_scope_unregistered_project",
        "no_global_target",
        # E3 rev 2 (plans/E3.md §2.1/§2.2, edge-cases.md §2 "closed reason set")
        "invalid_name",
        "name_taken",
        "unknown_transport",
        "transport_conflict",
        "no_endpoint",
        "malformed_url",
        "unsupported_url_scheme",
        "malformed_field",
        "duplicate_header",
        "disabled_upstream",
        "unreadable_file",
    }
)

_CLAUDE_FAMILY_IDS = ("claude-code", "pi")


# ─────────────────────────────────────────────────────────────────────────────
# DiscoveredMcp
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class DiscoveredMcp:
    name: str
    harness: str  # claude-code | codex | pi | opencode
    scope: str  # "user" | "local" | "project" | "global"
    file: str  # absolute path
    project: Optional[str]  # set for scope "local"/"project"
    native: dict  # the raw entry as read
    spec: Optional[mcp_spec.McpServerSpec]  # None when unsupported
    reason: Optional[str]  # the unsupported reason (`<reason>` or `<reason>:<detail>`)
    warnings: list[str] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# Small pure helpers duplicated on purpose (leaf contract — see module docstring)
# ─────────────────────────────────────────────────────────────────────────────


def _resolve_project_skills(proj_cfg: dict, registry: dict) -> list:
    """Mirrors `sync_engine.resolve_project_skills` exactly. Duplicated here
    (not imported) so this module never needs anything beyond `hub_core` +
    `mcp_spec` + `permissions` + `harnesses` at module scope."""
    bundles_cfg = registry.get("bundles", {})
    global_bundle_skills = []
    for cfg in bundles_cfg.values():
        scope = cfg.get("scope") or "project-specific"
        if scope == "global":
            global_bundle_skills.extend(cfg.get("skills", []))

    proj_bundles = proj_cfg.get("bundles", [])
    project_bundle_skills = []
    for b in proj_bundles:
        project_bundle_skills.extend(bundles_cfg.get(b, {}).get("skills", []))

    all_skills = global_bundle_skills + project_bundle_skills + proj_cfg.get("enabled", [])
    return list(dict.fromkeys(all_skills))


def _project_name_for(registry: dict, project_cfg: dict) -> Optional[str]:
    for name, cfg in (registry.get("projects") or {}).items():
        if cfg is project_cfg:
            return name
    try:
        target = expand(project_cfg.get("path", "."))
    except OSError:
        return None
    for name, cfg in (registry.get("projects") or {}).items():
        try:
            if expand(cfg.get("path", ".")) == target:
                return name
        except OSError:
            continue
    return None


def _claude_family_harness(
    targets: set, operation_context: Optional["OperationAdapterContext"] = None
) -> Optional[str]:
    if operation_context is not None:
        for harness_id in ("claude-code", "pi"):
            if harness_id in targets:
                layout = operation_context.layout(harness_id)
                if layout is not None and layout.mcp_adapter_key == "claude":
                    return harness_id
        return None
    if "claude-code" in targets:
        return "claude-code"
    if "pi" in targets:
        return "pi"
    return None


def _claude_json_path(
    operation_context: Optional["OperationAdapterContext"] = None,
) -> Optional[Path]:
    if operation_context is not None:
        for harness_id in ("claude-code", "pi"):
            layout = operation_context.layout(harness_id)
            if (
                layout is not None
                and layout.mcp_adapter_key == "claude"
                and layout.global_mcp_config is not None
            ):
                return layout.global_mcp_config
        return None
    h = harnesses.HARNESSES.get("claude-code")
    cfg = h.global_mcp_config if h is not None else None
    return expand(str(cfg)) if cfg is not None else expand("~/.claude.json")


def _unreadable_row(path: Path, harness: str, scope: str, project: Optional[str]) -> DiscoveredMcp:
    """One synthetic `unsupported/unreadable_file` row named after the
    file's basename — so the band can say WHICH file it could not read,
    rather than the whole discovery pass silently returning nothing for it
    (catalogue S14).

    N1: named `unreadable:<basename>`, not the bare basename — `classify`
    slugifies every row's `name` (`import_name`), and a bare `.claude.json`
    collapsed to `claude-json`, indistinguishable from a real server
    registered under that name. `sources[].file` already carries the real
    path; `sources[].name` carries this same `unreadable:<basename>` string
    verbatim (`_sources_view` never slugifies it), so a caller reading the
    CANDIDATE — not the raw `DiscoveredMcp` — still gets both an honest
    identity and the exact file."""
    return DiscoveredMcp(
        name=f"unreadable:{path.name}",
        harness=harness,
        scope=scope,
        file=str(path),
        project=project,
        native={},
        spec=None,
        reason="unreadable_file",
        warnings=[],
    )


def _load_json(path: Path) -> Optional[dict]:
    """BOM-tolerant (catalogue S08): `utf-8-sig` strips a leading `﻿`
    if present and behaves exactly like `utf-8` when there is none."""
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"  ! cannot parse {path}: {e} — skipping MCP discovery for this file", file=sys.stderr)
        return None


def _load_json_or_unreadable(
    path: Path, harness: str, scope: str, project: Optional[str]
) -> tuple[Optional[dict], list[DiscoveredMcp]]:
    """`_load_json`, plus a one-row `unreadable_file` candidate (S14) when the
    file EXISTS but could not be parsed — distinct from simply not existing,
    which stays silent."""
    if not path.exists():
        return None, []
    data = _load_json(path)
    if data is None:
        return None, [_unreadable_row(path, harness, scope, project)]
    return data, []


def _load_toml(path: Path) -> Optional[dict]:
    if not path.exists():
        return None
    if _tomlkit_missing():
        return None
    import tomlkit

    try:
        doc = tomlkit.parse(path.read_text(encoding="utf-8-sig"))
    except Exception as e:
        print(f"  ! cannot parse {path}: {e} — skipping MCP discovery for this file", file=sys.stderr)
        return None
    try:
        return doc.unwrap()
    except Exception as e:
        print(f"  ! cannot unwrap {path}: {e} — skipping MCP discovery for this file", file=sys.stderr)
        return None


def _load_toml_or_unreadable(
    path: Path, harness: str, scope: str, project: Optional[str]
) -> tuple[Optional[dict], list[DiscoveredMcp]]:
    if not path.exists():
        return None, []
    if _tomlkit_missing():
        # N2: §2.1 names "a codex file with tomlkit missing" as an
        # `unreadable_file` case — this used to return an empty row list,
        # silently indistinguishable from "the file does not exist".
        return None, [_unreadable_row(path, harness, scope, project)]
    data = _load_toml(path)
    if data is None:
        return None, [_unreadable_row(path, harness, scope, project)]
    return data, []


# ─────────────────────────────────────────────────────────────────────────────
# Per-harness shape normalization — pre-checks `parse_native` cannot do on its
# own (it only knows the generic/Claude shape), then a translation into that
# generic shape so every native entry is still ultimately parsed by
# `mcp_spec.parse_native` (INTERFACES §2 "approach").
# ─────────────────────────────────────────────────────────────────────────────


def _normalize_native(
    obj: object,
    *,
    name: str,
    adapter_key: str,
    harness_id: str,
    operation_context: Optional["OperationAdapterContext"] = None,
) -> mcp_spec.NativeNormalization:
    """Decode via the captured MCP route while preserving the baseline codec."""
    if operation_context is not None:
        route = operation_context.route(harness_id, "mcp")
        layout = operation_context.layout(harness_id)
        if (
            layout is None
            or route.mode != "legacy_shadow"
            or route.status != "shadow"
            or (route.adapter_key or layout.mcp_adapter_key) != adapter_key
        ):
            return mcp_spec.NativeNormalization(None, "unavailable_route", [])
    return mcp_spec.normalize_native(obj, name=name, adapter_key=adapter_key)


def _discover_claude_like(
    name: str,
    harness_id: str,
    scope: str,
    file: Path,
    project: Optional[str],
    obj: object,
    operation_context: Optional["OperationAdapterContext"] = None,
) -> DiscoveredMcp:
    """Decode a Claude-family entry while retaining its original payload."""
    native = obj if isinstance(obj, dict) else {}
    result = _normalize_native(
        obj, name=name, adapter_key="claude", harness_id=harness_id,
        operation_context=operation_context,
    )
    return DiscoveredMcp(
        name,
        harness_id,
        scope,
        str(file),
        project,
        native,
        result.spec,
        result.reason,
        result.warnings,
    )


def _discover_codex_entry(
    name: str,
    scope: str,
    file: Path,
    project: Optional[str],
    obj: object,
    operation_context: Optional["OperationAdapterContext"] = None,
) -> DiscoveredMcp:
    """Decode a Codex entry while retaining its original payload."""
    native = dict(obj) if isinstance(obj, dict) else {}
    result = _normalize_native(
        obj, name=name, adapter_key="codex", harness_id="codex",
        operation_context=operation_context,
    )
    return DiscoveredMcp(
        name, "codex", scope, str(file), project, native, result.spec, result.reason, result.warnings
    )


def _discover_opencode_entry(
    name: str,
    scope: str,
    file: Path,
    project: Optional[str],
    obj: object,
    operation_context: Optional["OperationAdapterContext"] = None,
) -> DiscoveredMcp:
    """Decode an OpenCode entry while retaining its original payload."""
    native = obj if isinstance(obj, dict) else {}
    result = _normalize_native(
        obj, name=name, adapter_key="opencode", harness_id="opencode",
        operation_context=operation_context,
    )
    return DiscoveredMcp(
        name, "opencode", scope, str(file), project, native, result.spec, result.reason, result.warnings
    )


# ─────────────────────────────────────────────────────────────────────────────
# Readers — one per native shape (plans/D.md §2 table). Reading only.
# ─────────────────────────────────────────────────────────────────────────────


def _read_claude_user(
    targets: set, operation_context: Optional["OperationAdapterContext"] = None
) -> list[DiscoveredMcp]:
    h_id = _claude_family_harness(targets, operation_context)
    if h_id is None:
        return []
    path = _claude_json_path(operation_context)
    if path is None:
        return []
    # N3: `_read_claude_local_unregistered` shares this file (both run in
    # the SAME global discovery pass) and ALSO surfaces `unreadable_file`
    # now — that reads as a double report only if the two land as separate
    # band rows, but `_unreadable_row` names both `unreadable:<basename>`
    # (same file → same slug), so `classify` merges them into ONE candidate
    # with two `sources[]` entries instead.
    data, unreadable = _load_json_or_unreadable(path, h_id, "user", None)
    if data is None:
        return unreadable
    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        return []
    return [
        _discover_claude_like(
            name, h_id, "user", path, None, obj, operation_context
        )
        for name, obj in servers.items()
    ]


def _read_claude_local_for_project(
    project_name: Optional[str],
    proj_root: Path,
    targets: set,
    operation_context: Optional["OperationAdapterContext"] = None,
) -> list[DiscoveredMcp]:
    h_id = _claude_family_harness(targets, operation_context)
    if h_id is None:
        return []
    path = _claude_json_path(operation_context)
    if path is None:
        return []
    # N3: at PROJECT scope this is the ONLY reader of ~/.claude.json in the
    # discovery pass (unlike global scope, where `_read_claude_user` already
    # covers the same file) — it must surface `unreadable_file` itself, or
    # a broken `~/.claude.json` silently hides every project-local server.
    data, unreadable = _load_json_or_unreadable(path, h_id, "local", project_name)
    if data is None:
        return unreadable
    projects_block = data.get("projects")
    if not isinstance(projects_block, dict):
        return []
    out: list[DiscoveredMcp] = []
    for abs_path, proj_block in projects_block.items():
        if not isinstance(proj_block, dict):
            continue
        try:
            if expand(abs_path) != proj_root:
                continue
        except OSError:
            continue
        servers = proj_block.get("mcpServers")
        if not isinstance(servers, dict):
            continue
        for name, obj in servers.items():
            out.append(
                _discover_claude_like(
                    name, h_id, "local", path, project_name, obj, operation_context
                )
            )
    return out


def _read_claude_local_unregistered(
    registry: dict,
    targets: set,
    operation_context: Optional["OperationAdapterContext"] = None,
) -> list[DiscoveredMcp]:
    h_id = _claude_family_harness(targets, operation_context)
    if h_id is None:
        return []
    path = _claude_json_path(operation_context)
    if path is None:
        return []
    # N3: see the matching comment on `_read_claude_user` — surfacing
    # `unreadable_file` here too is safe (classify merges it with that
    # reader's identically-named row) and closes the coverage gap.
    data, unreadable = _load_json_or_unreadable(path, h_id, "local", None)
    if data is None:
        return unreadable
    projects_block = data.get("projects")
    if not isinstance(projects_block, dict):
        return []
    registered_paths = set()
    for cfg in (registry.get("projects") or {}).values():
        try:
            registered_paths.add(expand(cfg.get("path", ".")))
        except OSError:
            continue
    out: list[DiscoveredMcp] = []
    for abs_path, proj_block in projects_block.items():
        if not isinstance(proj_block, dict):
            continue
        servers = proj_block.get("mcpServers")
        if not isinstance(servers, dict) or not servers:
            continue
        try:
            resolved: Optional[Path] = expand(abs_path)
        except OSError:
            resolved = None
        if resolved is not None and resolved in registered_paths:
            continue  # belongs to a registered project — surfaced at project scope
        for name in servers:
            out.append(
                DiscoveredMcp(
                    name=name,
                    harness=h_id,
                    scope="local",
                    file=str(path),
                    project=None,
                    native={},
                    spec=None,
                    reason=f"local_scope_unregistered_project:{abs_path}",
                    warnings=[],
                )
            )
    return out


def _read_claude_project(
    project_name: Optional[str],
    proj_root: Path,
    targets: set,
    operation_context: Optional["OperationAdapterContext"] = None,
) -> list[DiscoveredMcp]:
    h_id = _claude_family_harness(targets, operation_context)
    if h_id is None:
        return []
    path = proj_root / ".mcp.json"
    data, unreadable = _load_json_or_unreadable(path, h_id, "project", project_name)
    if data is None:
        return unreadable
    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        return []
    return [
        _discover_claude_like(
            name, h_id, "project", path, project_name, obj, operation_context
        )
        for name, obj in servers.items()
    ]


def _read_codex(
    scope_kind: str,
    project_name: Optional[str],
    project_root: Optional[Path],
    targets: set,
    operation_context: Optional["OperationAdapterContext"] = None,
) -> list[DiscoveredMcp]:
    if "codex" not in targets:
        return []
    if scope_kind == "global":
        if operation_context is None:
            h = harnesses.HARNESSES.get("codex")
            cfg = h.global_mcp_config if h is not None else None
            path = expand(str(cfg)) if cfg is not None else expand("~/.codex/config.toml")
        else:
            layout = operation_context.layout("codex")
            if layout is None or layout.global_mcp_config is None:
                return []
            path = layout.global_mcp_config
        scope_label = "global"
    else:
        if project_root is None:
            return []
        path = project_root / ".codex" / "config.toml"
        scope_label = "project"
    data, unreadable = _load_toml_or_unreadable(path, "codex", scope_label, project_name)
    if data is None:
        return unreadable
    servers = data.get("mcp_servers")
    if not isinstance(servers, dict):
        return []
    return [
                _discover_codex_entry(
                    name, scope_label, path, project_name, obj, operation_context
                )
                for name, obj in servers.items()
    ]


def _read_opencode_project(
    project_name: Optional[str],
    proj_root: Path,
    targets: set,
    operation_context: Optional["OperationAdapterContext"] = None,
) -> list[DiscoveredMcp]:
    if "opencode" not in targets:
        return []
    path = proj_root / "opencode.json"
    data, unreadable = _load_json_or_unreadable(path, "opencode", "project", project_name)
    if data is None:
        return unreadable
    servers = data.get("mcp")
    if not isinstance(servers, dict):
        return []
    return [
        _discover_opencode_entry(
            name, "project", path, project_name, obj, operation_context
        )
        for name, obj in servers.items()
    ]


def _opencode_global_path(
    operation_context: Optional["OperationAdapterContext"] = None,
) -> Optional[Path]:
    if operation_context is not None:
        layout = operation_context.layout("opencode")
        if layout is None or layout.config_dir is None:
            return None
        return layout.config_dir / "opencode.json"
    return expand("~/.config/opencode/opencode.json")


def _read_opencode_global(
    targets: set, operation_context: Optional["OperationAdapterContext"] = None
) -> list[DiscoveredMcp]:
    """Read but NEVER importable (M7(b)) — hub has no global-MCP writer for
    opencode (`Harness.global_mcp_config` is None), so every entry here is
    `unsupported/no_global_target` regardless of shape."""
    if "opencode" not in targets:
        return []
    path = _opencode_global_path(operation_context)
    if path is None:
        return []
    # N3: this reader used to stay silent on a parse failure — the only one
    # of the four global-scope readers that did.
    data, unreadable = _load_json_or_unreadable(path, "opencode", "global", None)
    if data is None:
        return unreadable
    servers = data.get("mcp")
    if not isinstance(servers, dict):
        return []
    out = []
    for name, obj in servers.items():
        native = obj if isinstance(obj, dict) else {}
        out.append(
            DiscoveredMcp(
                name=name,
                harness="opencode",
                scope="global",
                file=str(path),
                project=None,
                native=native,
                spec=None,
                reason="no_global_target",
                warnings=[],
            )
        )
    return out


# ─────────────────────────────────────────────────────────────────────────────
# discover_native — the entry point (INTERFACES §1 signature)
# ─────────────────────────────────────────────────────────────────────────────


def discover_native(
    scope_kind: str,
    project_cfg: Optional[dict],
    registry: dict,
    installed: set,
    harness_filter: Optional[str] = None,
    operation_context: Optional["OperationAdapterContext"] = None,
) -> list[DiscoveredMcp]:
    if operation_context is None:
        targets = set(installed) if harness_filter is None else ({harness_filter} & set(installed))
    else:
        captured = set(operation_context.installed_harness_ids or ())
        targets = set()
        for harness_id in captured:
            layout = operation_context.layout(harness_id)
            route = operation_context.route(harness_id, "mcp")
            if (
                (harness_filter is None or harness_id == harness_filter)
                and layout is not None
                and layout.mcp_adapter_key is not None
                and route.mode == "legacy_shadow"
                and route.status == "shadow"
            ):
                targets.add(harness_id)
    out: list[DiscoveredMcp] = []

    if scope_kind == "global":
        out.extend(_read_claude_user(targets, operation_context))
        out.extend(_read_codex("global", None, None, targets, operation_context))
        out.extend(_read_opencode_global(targets, operation_context))
        out.extend(_read_claude_local_unregistered(registry, targets, operation_context))
    elif scope_kind == "project" and isinstance(project_cfg, dict):
        project_name = _project_name_for(registry, project_cfg)
        proj_root = expand(project_cfg.get("path", "."))
        out.extend(_read_claude_project(project_name, proj_root, targets, operation_context))
        out.extend(_read_codex("project", project_name, proj_root, targets, operation_context))
        out.extend(_read_opencode_project(project_name, proj_root, targets, operation_context))
        out.extend(_read_claude_local_for_project(project_name, proj_root, targets, operation_context))

    return out


# ─────────────────────────────────────────────────────────────────────────────
# managed_names — wave A's project sidecar (representative-harness rule) +
# the global-MCP sidecars, read directly by path convention (INTERFACES §1).
# ─────────────────────────────────────────────────────────────────────────────


def managed_names(
    scope_kind: str,
    project_name: Optional[str] = None,
    project_root: Optional[Path] = None,
    operation_context: Optional["OperationAdapterContext"] = None,
) -> set:
    if scope_kind == "global":
        names: set = set()
        # W2: "pi" joins the loop — a claude-family global claim is written
        # under whichever id was the representative harness for that
        # discovery run (claude-code when installed, else pi), so the reader
        # must check both, symmetric with the project-scope path below.
        global_target_ids: tuple[str, ...]
        if operation_context is None:
            global_target_ids = ("claude-code", "pi", "codex", "opencode")
            sidecar_root = data_home()
        else:
            captured_ids: list[str] = []
            for harness_id in sorted(set(operation_context.installed_harness_ids or ())):
                layout = operation_context.layout(harness_id)
                route = operation_context.route(harness_id, "mcp")
                if (
                    layout is not None
                    and layout.mcp_adapter_key is not None
                    and layout.global_mcp_config is not None
                    and route.mode == "legacy_shadow"
                    and route.status == "shadow"
                ):
                    captured_ids.append(harness_id)
            global_target_ids = tuple(captured_ids)
            sidecar_root = Path(operation_context.data_home)
        for h_id in global_target_ids:
            path = sidecar_root / "state" / h_id / "global-mcp.managed.json"
            if not path.exists():
                continue
            try:
                raw = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(raw, list):
                names |= {str(x) for x in raw}
        return names

    if not project_name or project_root is None:
        return set()

    scope = permissions.ProjectScope(name=project_name, path=str(project_root))
    names = set()
    if operation_context is None:
        project_target_ids = set(_CLAUDE_FAMILY_IDS) | {"codex", "opencode"}
    else:
        project_target_ids = set()
        for harness_id in set(operation_context.installed_harness_ids or ()):
            layout = operation_context.layout(harness_id)
            route = operation_context.route(harness_id, "mcp")
            if (
                layout is not None
                and layout.mcp_adapter_key is not None
                and route.mode == "legacy_shadow"
                and route.status == "shadow"
            ):
                project_target_ids.add(harness_id)
    for h_id in _CLAUDE_FAMILY_IDS:
        if h_id not in project_target_ids:
            continue
        sc = permissions.read_sidecar(h_id, scope, kind="mcp")
        if sc is not None:
            names |= set(sc.managed_keys)
            break
    for h_id in ("codex", "opencode"):
        if h_id not in project_target_ids:
            continue
        sc = permissions.read_sidecar(h_id, scope, kind="mcp")
        if sc is not None:
            names |= set(sc.managed_keys)
    return names


# ─────────────────────────────────────────────────────────────────────────────
# classify — the four (+ deferred `stale`) statuses (INTERFACES §1 signature)
# ─────────────────────────────────────────────────────────────────────────────


#: Container keys any of the four harnesses' native shapes hold a literal
#: header/env value under — redacted wherever a flagged key appears in one.
_REDACT_CONTAINERS = ("headers", "env", "environment", "http_headers")

_REDACTED = "<redacted>"


def _redact_url(url: object, *, flagged_params: Optional[set] = None) -> object:
    """Thin delegator over `mcp_spec.redact_url_secrets` (plans/G.md §5.11 —
    promoted so `mcp_reconcile`, `backup.py`, and `mcp_catalog` share ONE
    implementation instead of three copies). Kept under its original name so
    every existing caller and test in this module needs no change."""
    return mcp_spec.redact_url_secrets(url, flagged_params=flagged_params)


def _redact_copy(payload: dict, secret_keys: list[str]) -> dict:
    """A shallow copy of `payload` with every value under a `_REDACT_CONTAINERS`
    key that `secret_keys` flags replaced by a placeholder, AND every flagged
    `url.query:<param>` value rewritten in the `url` string itself (F4/case
    18, widened by C3) — the discovery payload never carries a literal secret
    value, only the key/param name."""
    if not secret_keys or not isinstance(payload, dict):
        return payload
    bare_keys = {
        k.split(":", 1)[-1]
        for k in secret_keys
        if not k.startswith("url.query:") and k != "url.userinfo"
    }
    query_params = {k.split(":", 1)[1] for k in secret_keys if k.startswith("url.query:")}
    has_userinfo = "url.userinfo" in secret_keys
    out = dict(payload)
    for container_key in _REDACT_CONTAINERS:
        container = out.get(container_key)
        if isinstance(container, dict):
            new_container = dict(container)
            changed = False
            for k in bare_keys:
                if k in new_container and isinstance(new_container[k], str):
                    new_container[k] = _REDACTED
                    changed = True
            if changed:
                out[container_key] = new_container
    if (query_params or has_userinfo) and "url" in out:
        redacted_url = _redact_url(out["url"], flagged_params=query_params)
        if redacted_url != out["url"]:
            out["url"] = redacted_url
    return out


def _redact_native_blind(native: dict) -> dict:
    """The redaction path for an `unsupported` row (C3): there is no `spec`
    to run `secret_keys_in_spec` against (parsing failed or was refused
    before a spec ever existed), so this scans the raw native dict's own
    `_REDACT_CONTAINERS` keys and `url` query string directly with
    `mcp_spec.looks_like_secret` — a `ws`/`oauth`/`headers_helper` entry with
    a literal `Authorization` header must not ship it whole just because hub
    could not otherwise represent the server."""
    if not isinstance(native, dict):
        return native
    out = dict(native)
    for container_key in _REDACT_CONTAINERS:
        container = out.get(container_key)
        if isinstance(container, dict):
            new_container = dict(container)
            changed = False
            for k, v in container.items():
                if isinstance(v, str) and mcp_spec.looks_like_secret(k, v):
                    new_container[k] = _REDACTED
                    changed = True
            if changed:
                out[container_key] = new_container
    if "url" in out:
        redacted_url = _redact_url(out["url"])
        if redacted_url != out["url"]:
            out["url"] = redacted_url
    return out


def _sources_view(entries: list[DiscoveredMcp]) -> list[dict]:
    out = []
    for e in entries:
        if e.spec is not None:
            native = _redact_copy(e.native, mcp_spec.secret_keys_in_spec(e.spec))
        else:
            native = _redact_native_blind(e.native)
        out.append(
            {
                "harness": e.harness,
                "file": e.file,
                "scope": e.scope,
                # E3 rev 2 §4: the native key VERBATIM (pre-slugify) — the
                # row's own "name"/"import_name" are now the resolved slug,
                # which can differ per-source before a rename decides one.
                "name": e.name,
                "native": native,
            }
        )
    return out


def _row(
    name: str,
    status: str,
    spec: Optional[dict],
    entries: list[DiscoveredMcp],
    options: list[dict],
    reason: Optional[str],
    warnings: list[str],
    *,
    import_name: Optional[str],
) -> dict:
    return {
        "name": name,
        "import_name": import_name,
        "status": status,
        "spec": spec,
        "sources": _sources_view(entries),
        "options": options,
        "reason": reason,
        "warnings": warnings,
    }


#: Per-entry `.scope` labels that mean "this is a global-scope_kind discovery"
#: — Claude's own vocabulary calls its top-level `mcpServers` "user" (not
#: "global"), so a plain `== "global"` check missed it (W1/S4).
_GLOBAL_SCOPE_LABELS = frozenset({"global", "user"})


def _no_global_writer(
    e: DiscoveredMcp,
    operation_context: Optional["OperationAdapterContext"] = None,
) -> bool:
    if e.scope not in _GLOBAL_SCOPE_LABELS:
        return False
    if operation_context is not None:
        layout = operation_context.layout(e.harness)
        return layout is None or layout.global_mcp_config is None
    h = harnesses.HARNESSES.get(e.harness)
    return h is None or h.global_mcp_config is None


def _is_active(name: str, entries: list[DiscoveredMcp], registry: dict) -> bool:
    scopes = {e.scope for e in entries}
    if scopes & _GLOBAL_SCOPE_LABELS:
        skills = registry.get("skills") or {}
        return (skills.get(name) or {}).get("scope") == "global"
    project_name = next((e.project for e in entries if e.project), None)
    if not project_name:
        return True  # cannot determine — never misreport as stale
    proj_cfg = (registry.get("projects") or {}).get(project_name)
    if not isinstance(proj_cfg, dict):
        return True
    return name in _resolve_project_skills(proj_cfg, registry)


def _literal_secret_warnings(entries: list[DiscoveredMcp]) -> list[str]:
    out: list[str] = []
    for e in entries:
        if e.spec is None:
            continue
        for k in mcp_spec.secret_keys_in_spec(e.spec):
            tag = f"literal_secret:{k}"
            if tag not in out:
                out.append(tag)
    return out


def _unique_blocks(entries: list[DiscoveredMcp]) -> list[tuple]:
    seen: list[tuple] = []
    for e in entries:
        assert e.spec is not None
        block = mcp_spec.spec_to_registry_block(e.spec)
        if not any(block == b for b, _e in seen):
            seen.append((block, e))
    return seen


def _folder_collision(slug: str) -> bool:
    """A leftover `mcp-servers/<slug>/` dir (an archived skill, a crash mid
    -registration) that is NOT the registry key itself — a row status, not
    a mid-transaction exit (grill finding 7; catalogue N14)."""
    try:
        return (skill_meta.hub_mcp_servers_dir() / slug).exists()
    except OSError:
        return False


def _classify_one(
    display_name: str,
    import_name: Optional[str],
    entries: list[DiscoveredMcp],
    registry: dict,
    managed: set,
    operation_context: Optional["OperationAdapterContext"] = None,
) -> dict:
    """`display_name` is the group's identity for an unslugifiable name (the
    raw native key, sorted-first when several share it); `import_name` is
    `None` in that case (E3 rev 2 §2.2: `invalid_name`) or the resolved slug
    otherwise, in which case it is ALSO used as `display_name`/the row's
    `"name"` — the registry key this candidate would use."""
    if import_name is None:
        return _row(display_name, "unsupported", None, entries, [], "invalid_name", [], import_name=None)

    name = import_name
    skills = registry.get("skills") or {}
    registry_entry = skills.get(name)
    is_registered_mcp = isinstance(registry_entry, dict) and registry_entry.get("type") == "mcp-server"

    # N14: the slug is an existing registry key of a DIFFERENT (non-MCP)
    # entry — decided HERE, not only at apply (grill finding 7).
    if registry_entry is not None and not is_registered_mcp:
        return _row(name, "unsupported", None, entries, [], f"name_taken:{name}", [], import_name=name)
    if registry_entry is None and _folder_collision(name):
        return _row(name, "unsupported", None, entries, [], f"name_taken:{name}", [], import_name=name)

    base_warnings = sorted({f"renamed_from:{e.name}" for e in entries if e.name != name})
    if len(name) > 64:
        base_warnings.append("name_long")

    if is_registered_mcp and name in managed:
        return _row(name, "already_managed", None, entries, [], None, base_warnings, import_name=name)

    # unsupported outranks stale (S3): a registered-but-inactive entry that is
    # ALSO a shape hub cannot represent (ws/oauth/headers_helper/no_global_target)
    # must say why it can never come back, not just that it is inactive here.
    if entries and all(_no_global_writer(e, operation_context) for e in entries):
        return _row(name, "unsupported", None, entries, [], "no_global_target", [], import_name=name)

    supported = [e for e in entries if e.spec is not None]
    if not supported:
        return _row(name, "unsupported", None, entries, [], entries[0].reason, [], import_name=name)

    if is_registered_mcp and not _is_active(name, entries, registry):
        return _row(name, "stale", None, entries, [], None, base_warnings, import_name=name)

    # C1: union every source entry's OWN `normalize_native` repair warnings
    # into the row — these used to be written at discovery time and read
    # NOWHERE, so the band never told a user "hub split your command" or
    # "cwd is not absolute" even though the normaliser had already computed
    # exactly that sentence. Deduped, stable (sorted) order.
    entry_warnings = sorted({w for e in entries for w in e.warnings})
    warnings = _literal_secret_warnings(supported) + base_warnings + entry_warnings
    blocks_seen = _unique_blocks(supported)

    registry_block: Optional[dict] = None
    if is_registered_mcp and isinstance(registry_entry, dict):
        registry_spec = mcp_spec.raw_spec_from_registry(name, registry_entry)
        registry_block = mcp_spec.spec_to_registry_block(registry_spec)

    conflict = len(blocks_seen) > 1 or (
        registry_block is not None and not any(b == registry_block for b, _e in blocks_seen)
    )

    if conflict:
        # W4: two entries can share a harness (Claude local vs. project) —
        # the option row also carries `scope`/`file` so a decision can
        # disambiguate which one it means.
        options = [
            {
                "harness": e.harness,
                "scope": e.scope,
                "file": e.file,
                "spec": _redact_copy(b, mcp_spec.secret_keys_in_spec(e.spec)),
            }
            for b, e in blocks_seen
        ]
        if registry_block is not None:
            options.append(
                {"harness": "registry", "scope": None, "file": None, "spec": registry_block}
            )
            if "unclaimed_native_entry" not in warnings:
                warnings = warnings + ["unclaimed_native_entry"]
        return _row(name, "conflict", None, entries, options, None, warnings, import_name=name)

    only_block, only_entry = blocks_seen[0]

    # E3 rev 2 §2.2/N15: a registered MCP skill whose block MATCHES — even
    # when no sidecar exists yet — is `already_managed`, not `new`; the
    # apply's `claim_only` path writes the missing sidecar instead of
    # silently no-op'ing (so the row cannot keep reappearing).
    if is_registered_mcp and registry_block is not None and only_block == registry_block:
        return _row(name, "already_managed", None, entries, [], None, warnings, import_name=name)

    redacted_spec = _redact_copy(only_block, mcp_spec.secret_keys_in_spec(only_entry.spec))
    return _row(name, "new", redacted_spec, entries, [], None, warnings, import_name=name)


def classify(
    discovered: list[DiscoveredMcp],
    registry: dict,
    managed_names: set,
    operation_context: Optional["OperationAdapterContext"] = None,
) -> list[dict]:
    """Groups by the CASE-FOLDED SLUG (E3 rev 2 §2.2/N16), so `Sanity`
    (Claude) and `sanity` (Codex) become ONE candidate. An unslugifiable raw
    name (`invalid_name`) groups by its own literal string instead — each
    distinct unusable name stays its own row (catalogue N07-N12)."""
    groups: dict[tuple[str, str], list[DiscoveredMcp]] = {}
    for d in discovered:
        slug = mcp_spec.slugify_server_name(d.name)
        key = ("valid", slug) if slug is not None else ("invalid", d.name)
        groups.setdefault(key, []).append(d)

    rows: list[dict] = []
    for key in sorted(groups):
        kind, ident = key
        entries = groups[key]
        if kind == "invalid":
            rows.append(
                _classify_one(
                    ident, None, entries, registry, managed_names, operation_context
                )
            )
        else:
            rows.append(
                _classify_one(
                    ident, ident, entries, registry, managed_names, operation_context
                )
            )
    return rows
