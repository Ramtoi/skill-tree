"""MCP config sync: per-project MCP dispatch and the global-MCP pass.

Cut verbatim out of hub.py (wave 23b of AUDIT.md). Not a leaf: `sync_mcp_for_project`
and `_run_global_mcp_dispatch` read `_skill_affinity`, which stays in hub.py until wave 23h,
so each does `import hub` as its first statement and calls `hub._skill_affinity` (a call-time
read — a `hub.<name>` stub still lands). Module scope imports hub_core, skill_meta and sources
only. hub.py re-imports every name so `hub.<name>` keeps resolving.

Stub visibility: a call from one function here to another resolves through this module, so
`monkeypatch.setattr(hub, "<name>", …)` no longer reaches it (`sync_mcp_for_project` /
`_run_global_mcp_dispatch` → `_spec_from_skill`; `_run_global_mcp_dispatch` →
`_read_global_mcp_sidecar` / `_write_global_mcp_sidecar` → `_global_mcp_sidecar_path`). No test
stubs any of these today; one that needs to patches `mcp_sync.<name>`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from skill_hub import hub_core
from skill_hub.domain.skills.skill_meta import skill_source
from skill_hub.hub_core import BOLD, DIM, GREEN, RED, YELLOW, c, expand
from skill_hub.infrastructure.registry.sources import skills_from_disabled_sources

if TYPE_CHECKING:  # pragma: no cover - typing only, no runtime import
    from skill_hub.application.harnesses.harness_operation_context import OperationAdapterContext
    from skill_hub.infrastructure.mcp import mcp_adapters

# ─────────────────────────────────────────────────────────────────────────────
# MCP config management
# ─────────────────────────────────────────────────────────────────────────────


def _spec_from_skill(name: str, skill_cfg: dict):
    """Build an McpServerSpec from a registry skill entry.

    A thin wrapper (wave B) over `mcp_spec.spec_from_registry` — the EXPANDED
    reader, fed to every harness write and (later) the liveness probe. Never
    the raw/unexpanded reader: `hub.build_remote_desired_state` calls
    `mcp_spec.raw_spec_from_registry` directly for the remote-connector wire
    dict (F1) and does not go through this function.

    `source` is only needed to substitute the `{source}` placeholder in args
    (an MCP server whose command lives inside the skill dir). An mcp-server with
    an explicit absolute command + args — e.g. the skill-hub control plane — has
    no source dir (`source: null`); resolving it unconditionally crashes sync.
    """
    from skill_hub.domain.mcp import mcp_spec

    source = skill_source(skill_cfg) if skill_cfg.get("source") else None
    return mcp_spec.spec_from_registry(name, skill_cfg, source=source)


def _representative_harness(
    adapter_key: str,
    effective: set[str],
    operation_context: Optional["OperationAdapterContext"] = None,
) -> Optional[str]:
    """The harness id passed to `McpAdapter.write`/`.remove` as the project
    sidecar owner (INTERFACES §1 "sidecar representative harness", m1).

    The shared claude/pi `.mcp.json` adapter writes under `claude-code` when
    it is effective for the project, else under `pi` (`ClaudeMcpAdapter.write`
    then checks BOTH ids on read, so a prior claim under either is honoured
    and migrated to the current representative). Every other adapter key maps
    1:1 onto its own harness id. Returns None when no effective harness
    actually carries this adapter key.
    """
    if operation_context is not None:
        if adapter_key == "claude":
            if "claude-code" in effective:
                return "claude-code"
            if "pi" in effective:
                return "pi"
            return None
        for harness_id in sorted(effective):
            layout = operation_context.layout(harness_id)
            if layout is not None and layout.mcp_adapter_key == adapter_key:
                return harness_id
        return None

    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    if adapter_key == "claude":
        if "claude-code" in effective:
            return "claude-code"
        if "pi" in effective:
            return "pi"
        return None
    for h_id in effective:
        h = _harnesses.HARNESSES.get(h_id)
        if h is not None and h.mcp_adapter_key == adapter_key:
            return h_id
    return None


def _context_effective_harnesses(
    project_cfg: dict,
    registry: dict,
    operation_context: "OperationAdapterContext",
) -> set[str]:
    """Resolve MCP participants from the captured context only.

    The registry still supplies the project's declared affinity, while the
    context supplies the installed participant set and immutable layouts.
    This avoids consulting the mutable ``harnesses.HARNESSES`` table after the
    operation has started.
    """
    declared = set(registry.get("harnesses_global") or []) | set(
        project_cfg.get("harnesses") or []
    )
    installed = set(operation_context.installed_harness_ids or ())
    selected: set[str] = set()
    for harness_id in declared & installed:
        layout = operation_context.layout(harness_id)
        route = operation_context.route(harness_id, "mcp")
        if (
            layout is not None
            and layout.mcp_adapter_key is not None
            and route.mode == "legacy_shadow"
            and route.status == "shadow"
        ):
            selected.add(harness_id)
    return selected


def _context_harness_label(
    operation_context: "OperationAdapterContext", harness_id: str
) -> str:
    layout = operation_context.layout(harness_id)
    return layout.label if layout is not None else harness_id


def _context_adapter_key(
    operation_context: "OperationAdapterContext", harness_id: str
) -> Optional[str]:
    layout = operation_context.layout(harness_id)
    route = operation_context.route(harness_id, "mcp")
    if layout is None or route.mode != "legacy_shadow" or route.status != "shadow":
        return None
    key = route.adapter_key or layout.mcp_adapter_key
    return key if key == layout.mcp_adapter_key else None


def project_has_mcp_target(effective: set[str], operation_context=None) -> bool:
    """True when any of `effective`'s harnesses has an MCP adapter.

    The gate `hub.py` uses to decide whether calling `sync_mcp_for_project` is
    worth it at all — kept here so the caller need not re-derive it (M2: hub.py
    has an 8-line budget for this wave).
    """
    if operation_context is not None:
        return any(_context_adapter_key(operation_context, h_id) is not None for h_id in effective)
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    return any(
        _harnesses.HARNESSES[h_id].mcp_adapter_key
        for h_id in effective
        if h_id in _harnesses.HARNESSES
    )


def sync_mcp_for_project(
    project_path: Path,
    enabled_mcps: list,
    registry: dict,
    project_name: str = "",
    report: Optional[dict] = None,
    operation_context: Optional["OperationAdapterContext"] = None,
) -> dict[str, mcp_adapters.McpProjectWriteResult]:
    """Dispatch MCP writes via per-harness adapters.

    Resolves the project's effective harnesses, intersects each skill's
    optional `harnesses:` affinity, collects (adapter -> [specs]) groups,
    then runs one write per unique adapter. ClaudeMcpAdapter is shared by
    claude-code and pi → effective = {claude-code, pi} produces exactly one
    .mcp.json write, under the representative-harness rule in
    `_representative_harness` (m1).

    Runs — and calls `write()` — even when `enabled_mcps` is empty, for every
    adapter reachable from `effective`, so unequipping a project's last MCP
    server still reaches the writer and removes the entry (plans/A.md §3).

    Warns once per project if `.pi/mcp.json` exists (user override precedence).

    When `report` is given (wave C), delivery rows land in
    `report["projects"][project_name]["mcp_delivery"]` (the caller must have
    already set that key to a dict carrying an `"mcp_delivery": []` list —
    `hub.py`'s per-project sync loop does this before calling in). A
    successful claude-family write is followed by the Claude Code project
    approval write (`enabledMcpjsonServers`); a codex write is followed by a
    read-only project-trust check. Either gate downgrades the affected rows
    to `state="blocked"`.
    """
    import hub
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses
    from skill_hub.infrastructure.mcp import mcp_adapters, mcp_delivery

    skills = registry.get("skills", {})

    # Effective harnesses for this project (find by path match).
    proj_cfg: dict = {}
    for p in registry.get("projects", {}).values():
        try:
            if expand(p["path"]) == project_path.resolve():
                proj_cfg = p
                break
        except OSError:
            continue
    if operation_context is None:
        effective = _harnesses.resolve_effective(proj_cfg, registry)
    else:
        effective = _context_effective_harnesses(proj_cfg, registry, operation_context)
    scope_label = f"project:{project_name}"
    delivery_rows: list = []

    # Every adapter reachable from `effective` must run even with zero specs,
    # so unequipping a project's last server still removes it — and every
    # harness in `effective` that shares an adapter key is a "reach" target
    # for that adapter's rows (a shared .mcp.json reaches claude-code AND pi).
    by_adapter: dict[str, list] = {}
    specs_by_adapter: dict[str, dict[str, object]] = {}
    harness_ids_by_adapter: dict[str, list] = {}
    for h_id in effective:
        if operation_context is None:
            h = _harnesses.HARNESSES.get(h_id)
            adapter_key = h.mcp_adapter_key if h is not None else None
        else:
            adapter_key = _context_adapter_key(operation_context, h_id)
        if adapter_key is None:
            continue
        by_adapter.setdefault(adapter_key, [])
        harness_ids_by_adapter.setdefault(adapter_key, []).append(h_id)

    # Build (adapter_key -> [specs]) groups, applying per-skill affinity. A
    # harness excluded by a skill's own `harnesses:` affinity gets an explicit
    # `skipped/affinity` row — it never reaches `by_adapter` for this server.
    for mcp_name in enabled_mcps:
        if mcp_name not in skills:
            continue
        cfg = skills[mcp_name]
        if cfg.get("type") != "mcp-server":
            continue
        affinity = hub._skill_affinity(cfg)
        target_harnesses = effective & affinity if affinity is not None else effective
        adapter_keys: set[str] = set()
        for h_id in target_harnesses:
            if operation_context is None:
                h = _harnesses.HARNESSES.get(h_id)
                adapter_key = h.mcp_adapter_key if h is not None else None
            else:
                adapter_key = _context_adapter_key(operation_context, h_id)
            if adapter_key is None:
                continue
            adapter_keys.add(adapter_key)
        spec = _spec_from_skill(mcp_name, cfg)
        for key in adapter_keys:
            by_adapter.setdefault(key, []).append(spec)
            specs_by_adapter.setdefault(key, {})[mcp_name] = spec

        if report is not None and affinity is not None:
            for h_id in effective - target_harnesses:
                if operation_context is None:
                    h = _harnesses.HARNESSES.get(h_id)
                    adapter_key = h.mcp_adapter_key if h is not None else None
                else:
                    adapter_key = _context_adapter_key(operation_context, h_id)
                if adapter_key is None:
                    continue
                delivery_rows.append(
                    mcp_delivery.delivery_row(
                        harness=h_id,
                        adapter=adapter_key,
                        scope=scope_label,
                        server=mcp_name,
                        target_file="",
                        state="skipped",
                        reason="affinity",
                        operation_context=operation_context,
                        spec=spec,
                    )
                )

    results: dict[str, mcp_adapters.McpProjectWriteResult] = {}
    for key, specs in by_adapter.items():
        if operation_context is None:
            adapter = mcp_adapters.get_adapter(key)
        else:
            adapter = None
            for h_id in harness_ids_by_adapter.get(key, []):
                selected_adapter = mcp_adapters.select_mcp_adapter(
                    operation_context, h_id
                )
                if selected_adapter is not None:
                    adapter = selected_adapter
                    break
        if adapter is None:
            continue
        harness_id = _representative_harness(key, effective, operation_context)
        if harness_id is None:
            continue
        try:
            result = adapter.write(
                project_path, specs, harness_id=harness_id, project_name=project_name,
                data_home_path=(Path(operation_context.data_home) if operation_context is not None else None),
            )
        except Exception as e:
            print(f"  {c('!', RED)} MCP adapter '{key}' failed: {e}")
            continue
        results[key] = result

        for name in sorted(result.adopted):
            print(f"  {c('·', DIM)} adopted {name} (identical entry, no prior sidecar)")
        for name in sorted(result.preserved):
            print(
                f"  {c('!', YELLOW)} {name} already exists in {result.target} and is "
                f"not hub-managed — left untouched"
            )
        for name in sorted(result.skips):
            for reason in result.skips[name]:
                print(f"  {c('!', YELLOW)} {name}: {key} cannot represent this — {reason}")

        if report is not None:
            rows = mcp_delivery.rows_from_project_result(
                result,
                harness_ids=harness_ids_by_adapter.get(key, [harness_id]),
                adapter=key,
                scope_label=scope_label,
                operation_context=operation_context,
                specs=specs_by_adapter.get(key),
            )

            if key == "claude" and harness_id == "claude-code":
                approval_target = None
                if operation_context is not None:
                    claude_layout = operation_context.layout("claude-code")
                    if claude_layout is not None:
                        approval_decl = claude_layout.permission_project_local_config
                        if approval_decl is not None:
                            approval_target = project_path / approval_decl
                approved_ok, _approval_err = mcp_delivery.write_claude_approval(
                    project_path,
                    project_name,
                    set(result.managed),
                    harness_id,
                    target_path=approval_target,
                )
                if not approved_ok:
                    for row in rows:
                        if (
                            row["harness"] == "claude-code"
                            and row["server"] in result.managed
                            and row["state"] in ("written", "unchanged")
                        ):
                            row["state"] = "blocked"
                            row["reason"] = "claude_project_not_approved"
                            row["detail"] = None
            elif key == "codex":
                trust_layout = (
                    operation_context.layout(harness_id)
                    if operation_context is not None
                    else None
                )
                if not mcp_delivery.codex_project_trust_state(
                    project_path, layout=trust_layout
                ):
                    for row in rows:
                        if (
                            row["harness"] == harness_id
                            and row["server"] in result.managed
                            and row["state"] in ("written", "unchanged")
                        ):
                            row["state"] = "blocked"
                            row["reason"] = "codex_untrusted_project"
                            row["detail"] = None

            delivery_rows.extend(rows)

        if result.aborted:
            continue

        if result.changed or result.adopted:
            parts = []
            if result.added:
                parts.append(f"+{len(result.added)}")
            if result.removed:
                parts.append(f"-{len(result.removed)}")
            if result.adopted:
                parts.append(f"adopted {len(result.adopted)}")
            detail = f" ({', '.join(parts)})" if parts else ""
            print(f"  {c('✓', GREEN)} MCP({key}) → {project_path}{detail}")

    # Override-precedence warning: Pi's optional .pi/mcp.json takes precedence
    # over the .mcp.json we manage. Warn once per project per sync run.
    pi_override = project_path / ".pi" / "mcp.json"
    if pi_override.exists():
        print(
            f"  {c('!', YELLOW)} {pi_override} overrides .mcp.json — "
            f"Skill Hub's MCP servers will be invisible to Pi until that "
            f"file is removed"
        )

    if report is not None:
        proj_rec = report["projects"].setdefault(project_name, {})
        proj_rec.setdefault("mcp_delivery", []).extend(delivery_rows)

    return results


# ─────────────────────────────────────────────────────────────────────────────
# Global MCP dispatch (scope:global mcp-servers → each harness's user-global config)
# ─────────────────────────────────────────────────────────────────────────────


def _global_mcp_sidecar_path(
    harness_id: str, data_home_path: Optional[Path] = None
) -> Path:
    """Sidecar recording the global MCP server names hub manages per harness."""
    root = data_home_path if data_home_path is not None else hub_core.data_home()
    return root / "state" / harness_id / "global-mcp.managed.json"


def _read_global_mcp_sidecar(
    harness_id: str, data_home_path: Optional[Path] = None
) -> Optional[set[str]]:
    """Return the recorded hub-managed names, or None if missing/corrupt.

    None signals "no prior ownership knowledge" — cleanup MUST be a no-op so a
    user-authored server is never deleted on a guess.
    """
    path = _global_mcp_sidecar_path(harness_id, data_home_path)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        print(
            f"  {c('!', YELLOW)} corrupt global-MCP sidecar {path} — "
            f"skipping cleanup for {harness_id} (no server will be removed)",
            file=sys.stderr,
        )
        return None
    if not isinstance(data, list):
        return None
    return {str(x) for x in data}


def _write_global_mcp_sidecar(
    harness_id: str, names: set[str], data_home_path: Optional[Path] = None
) -> None:
    path = _global_mcp_sidecar_path(harness_id, data_home_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(sorted(names), indent=2) + "\n")


def _run_global_mcp_dispatch(
    registry: dict,
    installed: set[str],
    report: Optional[dict] = None,
    operation_context: Optional["OperationAdapterContext"] = None,
) -> None:
    """Write every scope:global mcp-server to each installed harness's
    user-global MCP config. Merge-preserving, backup-first, atomic,
    sidecar-tracked cleanup. Parallel to the global-skills pass.
    """
    import hub
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses
    from skill_hub.infrastructure.mcp import mcp_adapters, mcp_delivery

    print(f"\n{c('Global MCP servers (managed only from hub):', BOLD)}")

    skills = registry.get("skills", {})
    # Collect scope:global mcp-server specs (and their affinity). A server owned
    # by a disabled source is inactive: it is left out of the specs, so the
    # sidecar-scoped cleanup below removes any entry a previous sync wrote.
    inactive = skills_from_disabled_sources(registry)
    global_mcps: list[tuple[str, dict]] = []
    skipped_disabled = 0
    for name, cfg in skills.items():
        if cfg.get("type") != "mcp-server" or cfg.get("scope") != "global":
            continue
        if name in inactive:
            print(f"  {c('·', DIM)} source disabled: {name} ({inactive[name]})")
            skipped_disabled += 1
            continue
        global_mcps.append((name, cfg))

    any_written = False
    participants: list[tuple[str, Any]]
    if operation_context is None:
        participants = list(_harnesses.HARNESSES.items())
        active_installed = set(installed)
    else:
        participants = [
            (harness_id, operation_context.layout(harness_id))
            for harness_id in sorted(set(operation_context.installed_harness_ids or ()))
            if operation_context.layout(harness_id) is not None
            and _context_adapter_key(operation_context, harness_id) is not None
        ]
        active_installed = set(operation_context.installed_harness_ids or ())
    for h_id, h in participants:
        label = h.label if h is not None else h_id
        if operation_context is None:
            adapter_key = h.mcp_adapter_key if h is not None else None
        else:
            adapter_key = _context_adapter_key(operation_context, h_id)
        global_mcp_config = (
            h.global_mcp_config
            if operation_context is None and h is not None
            else h.global_mcp_config
            if h is not None
            else None
        )
        if h_id not in active_installed:
            continue
        if global_mcp_config is None:
            reason = (
                "reads project-local .mcp.json only"
                if h_id == "pi"
                else "project-only MCP adapter (no user-global config)"
            )
            print(f"  {c('·', DIM)} {label} skipped: {reason}")
            if report is not None:
                for name, cfg in global_mcps:
                    affinity = hub._skill_affinity(cfg)
                    if affinity is not None and h_id not in affinity:
                        continue
                    spec = _spec_from_skill(name, cfg) if operation_context is not None else None
                    report["global"]["mcp"]["delivery"].append(
                        mcp_delivery.delivery_row(
                            harness=h_id,
                            adapter=adapter_key or "",
                            scope="global",
                            server=name,
                            target_file="",
                            state="skipped",
                            reason="no_global_target",
                            operation_context=operation_context,
                            spec=spec,
                        )
                    )
            continue
        adapter = (
            mcp_adapters.get_adapter(adapter_key)
            if operation_context is None
            else mcp_adapters.select_mcp_adapter(operation_context, h_id)
        )
        if adapter is None or not hasattr(adapter, "write_global"):
            print(
                f"  {c('·', DIM)} {label} skipped: adapter has no global-write support"
            )
            if report is not None:
                for name, _cfg in global_mcps:
                    spec = _spec_from_skill(name, _cfg) if operation_context is not None else None
                    report["global"]["mcp"]["delivery"].append(
                        mcp_delivery.delivery_row(
                            harness=h_id,
                            adapter=adapter_key or "",
                            scope="global",
                            server=name,
                            target_file="",
                            state="skipped",
                            reason="adapter_missing",
                            operation_context=operation_context,
                            spec=spec,
                        )
                    )
            continue

        # Apply each server's harnesses: affinity.
        specs = []
        specs_by_name: dict[str, object] = {}
        for name, cfg in global_mcps:
            affinity = hub._skill_affinity(cfg)
            if affinity is not None and h_id not in affinity:
                continue
            spec = _spec_from_skill(name, cfg)
            specs.append(spec)
            specs_by_name[name] = spec

        global_path = Path(str(global_mcp_config)).expanduser()
        data_home_path = Path(operation_context.data_home) if operation_context is not None else None
        prior = _read_global_mcp_sidecar(h_id, data_home_path)
        try:
            result = adapter.write_global(global_path, specs, prior, harness_id=h_id)
        except Exception as e:
            print(f"  {c('!', RED)} {label} global MCP write failed: {e}")
            continue

        if result.aborted:
            # File untouched; do NOT rewrite the sidecar (preserve prior claim).
            if report is not None:
                report["global"]["mcp"]["delivery"].extend(
                    mcp_delivery.rows_from_global_result(
                        result, harness_id=h_id, adapter=adapter_key or "", target=global_path,
                        operation_context=operation_context,
                        specs=specs_by_name,
                    )
                )
            continue

        for name in sorted(result.skips):
            for reason in result.skips[name]:
                print(f"  {c('!', YELLOW)} {name}: {label} cannot represent this — {reason}")

        # Record the new ownership set (even on a no-op, to (re)establish the
        # sidecar so future cleanups are scoped).
        _write_global_mcp_sidecar(h_id, result.managed, data_home_path)

        if report is not None:
            report["global"]["mcp"]["writes"] += len(result.added)
            report["global"]["mcp"]["removed"] += len(result.removed)
            report["global"]["mcp"]["delivery"].extend(
                mcp_delivery.rows_from_global_result(
                    result, harness_id=h_id, adapter=adapter_key or "", target=global_path,
                    operation_context=operation_context,
                    specs=specs_by_name,
                )
            )

        if result.changed:
            any_written = True
            parts = []
            if result.added:
                parts.append(f"+{len(result.added)}")
            if result.removed:
                parts.append(f"-{len(result.removed)}")
            detail = f" ({', '.join(parts)})" if parts else ""
            print(f"  {c('✓', GREEN)} {label} → {global_path}{detail}")
        else:
            print(f"  {c('·', DIM)} {label} unchanged ({len(result.managed)} managed)")

    if not global_mcps and not any_written:
        if skipped_disabled:
            print(
                f"  {c('·', DIM)} every scope:global MCP server "
                f"({skipped_disabled}) belongs to a disabled source"
            )
        else:
            print(f"  {c('·', DIM)} no scope:global MCP servers registered")
