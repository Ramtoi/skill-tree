"""`hub permissions` — the whole CLI: scope/rule/hook CRUD, native-rule
adoption, doctor, scope migration, disable/restore, and presets.

The full `hub permissions` command family moved out of `hub.py`: the scope
resolver, list/show/add/remove, the deprecated `hooks add/remove` aliases, the
legacy `adopt`/`import` discovery-and-reconcile flow, the kept-decisions
store, `reconcile`/`set`/`validate`/`capabilities`, `doctor`, `migrate-scope`,
`disable`, and `presets *`. No verb stays in `hub.py`.

Carved out of `hub.py` (S5 slice E) — see `hub_cli/__init__.py` for the
module contract this file implements (`NAME`, `register`, `dispatch`).
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional

from skill_hub import hub_core
from skill_hub.entrypoints.cli.hook import _hook_attach, _hook_command_arg, _hook_detach, _hook_new
from skill_hub.hub_core import (
    BOLD,
    CYAN,
    DIM,
    GREEN,
    RED,
    SLUG_RE,
    YELLOW,
    _next_imported_hook_name,
    _registry_sha,
    append_audit,
    c,
    data_home,
    data_home_lock,
    expand,
    fail,
    parse_csv,
    registry_mutation,
)
from skill_hub.infrastructure.permissions import permission_adapter_codex

NAME = "permissions"


def _operation_harness_ids(operation_context, *, installed: bool = False) -> set[str]:
    """Use the operation snapshot for native participant selection."""
    if operation_context is not None:
        source = (
            operation_context.installed_harness_ids
            if installed
            else operation_context.harness_ids
        )
        return set(source or ())
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    return (
        set(_harnesses.detect_installed())
        if installed
        else set(_harnesses.HARNESSES)
    )


def _operation_permission_key(operation_context, harness_id: str) -> Optional[str]:
    if operation_context is not None:
        layout = operation_context.layout(harness_id)
        return layout.permission_adapter_key if layout is not None else None
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    harness = _harnesses.HARNESSES.get(harness_id)
    return harness.permission_adapter_key if harness is not None else None


def _operation_effective_harnesses(project: dict, registry: dict, operation_context) -> set[str]:
    if operation_context is not None and hasattr(operation_context, "effective_harness_ids"):
        return set(operation_context.effective_harness_ids(project, registry))
    requested = set(registry.get("harnesses_global") or []) | set(project.get("harnesses") or [])
    installed = _operation_harness_ids(operation_context, installed=True)
    return {
        harness_id
        for harness_id in requested & installed
        if _operation_permission_key(operation_context, harness_id) is not None
    }


def _ensure_operation_context(args):
    """Attach one cache-only context for direct command/facade calls."""
    context = getattr(args, "_operation_context", None)
    if context is not None:
        return context
    from skill_hub.application.harnesses.harness_operation_context import build_operation_context
    from skill_hub.domain.harnesses.harness_adapter_api import SDK_VERSION, Version
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    installed = _operation_harness_ids(None, installed=True)
    context = build_operation_context(
        hub_core.data_home(),
        tuple(sorted(_harnesses.HARNESSES)),
        requested_features=("permissions", "hooks"),
        installed_harness_ids=tuple(sorted(installed)),
        host_version=Version.parse(hub_core.hub_version()),
        sdk_version=SDK_VERSION,
    )
    args._operation_context = context
    return context


p_perm = None
p_perm_hooks = None
p_perm_presets = None


def register(sub) -> None:
    global p_perm, p_perm_hooks, p_perm_presets

    # permissions
    p_perm = sub.add_parser("permissions", help="Manage agent permissions")
    perm_sub = p_perm.add_subparsers(dest="permissions_cmd")

    def _add_scope_args(p):
        g = p.add_mutually_exclusive_group(required=False)
        g.add_argument(
            "--global",
            dest="global_",
            action="store_true",
            help="Operate on permissions_global",
        )
        g.add_argument("--project", help="Operate on a project's permissions")

    def _add_personal_arg(p):
        p.add_argument(
            "--personal",
            action="store_true",
            help="Target the project's PERSONAL (uncommitted) permissions_local "
            "block instead of the committed permissions block (requires --project)",
        )

    p_perm_list = perm_sub.add_parser("list", help="Summary of permissions across scopes")
    p_perm_list.add_argument("--json", action="store_true")

    p_perm_show = perm_sub.add_parser("show", help="Show permissions for a scope")
    _add_scope_args(p_perm_show)
    _add_personal_arg(p_perm_show)
    p_perm_show.add_argument(
        "--effective",
        action="store_true",
        help="Show resolved (global+project) permissions for a project",
    )
    p_perm_show.add_argument("--json", action="store_true")

    p_perm_add = perm_sub.add_parser("add", help="Add a rule")
    _add_scope_args(p_perm_add)
    _add_personal_arg(p_perm_add)
    p_perm_add.add_argument("--kind", required=True, choices=["allow", "deny", "ask"])
    p_perm_add.add_argument("--pattern", required=True)
    p_perm_add.add_argument("--harnesses", help="CSV of harness ids; default = all")

    p_perm_remove = perm_sub.add_parser("remove", help="Remove a rule")
    _add_scope_args(p_perm_remove)
    _add_personal_arg(p_perm_remove)
    p_perm_remove.add_argument("--kind", required=True, choices=["allow", "deny", "ask"])
    p_perm_remove.add_argument("--pattern", required=True)

    p_perm_hooks = perm_sub.add_parser("hooks", help="Manage hooks")
    hooks_sub = p_perm_hooks.add_subparsers(dest="hooks_cmd")
    p_hooks_add = hooks_sub.add_parser("add", help="Add a hook")
    _add_scope_args(p_hooks_add)
    _add_personal_arg(p_hooks_add)
    p_hooks_add.add_argument("--event", required=True)
    p_hooks_add.add_argument("--matcher", required=True)
    # dest avoids colliding with the top-level subparser dest="command".
    p_hooks_add.add_argument("--command", dest="hook_command", required=True)
    p_hooks_add.add_argument("--harnesses", help="CSV of harness ids; default = all")
    p_hooks_remove = hooks_sub.add_parser("remove", help="Remove a hook")
    _add_scope_args(p_hooks_remove)
    _add_personal_arg(p_hooks_remove)
    p_hooks_remove.add_argument("--event", required=True)
    p_hooks_remove.add_argument("--matcher", required=True)
    p_hooks_remove.add_argument("--command", dest="hook_command", required=True)

    p_perm_adopt = perm_sub.add_parser("adopt", help="Adopt pre-existing native permissions into the registry")
    _add_scope_args(p_perm_adopt)
    p_perm_adopt.add_argument("--action", required=True, choices=["import", "replace", "skip"])
    p_perm_adopt.add_argument("--harness", help="Limit to a single harness id")

    p_perm_import = perm_sub.add_parser(
        "import",
        help="Discover + reconcile pre-existing native rules (cross-harness) and "
        "import/keep/drop them with MOVE semantics",
    )
    _add_scope_args(p_perm_import)
    p_perm_import.add_argument("--harness", help="Limit discovery to a single harness id")
    p_perm_import.add_argument("--json", action="store_true", help="Emit the reconciled candidate set as JSON")
    p_perm_import.add_argument(
        "--interactive",
        action="store_true",
        help="Prompt per-rule import/keep/drop on a TTY",
    )
    p_perm_import.add_argument(
        "--apply",
        action="store_true",
        help="Apply decisions read from --decisions-stdin (non-interactive)",
    )
    p_perm_import.add_argument(
        "--decisions-stdin",
        action="store_true",
        help="Read a {decisions:[...]} JSON payload from stdin (with --apply)",
    )

    p_perm_reconcile = perm_sub.add_parser(
        "reconcile",
        help="Unified ingest of pre-existing native rules (subsumes adopt+import): transactional + auto-syncing",
    )
    _add_scope_args(p_perm_reconcile)
    p_perm_reconcile.add_argument("--harness", help="Limit discovery to a single harness id")
    p_perm_reconcile.add_argument("--json", action="store_true", help="Emit candidate set / apply result as JSON")
    p_perm_reconcile.add_argument(
        "--apply",
        action="store_true",
        help="Apply decisions read from --decisions-stdin (transactional)",
    )
    p_perm_reconcile.add_argument(
        "--decisions-stdin",
        action="store_true",
        help="Read a {decisions:[...]} JSON payload from stdin (with --apply)",
    )

    p_perm_doctor = perm_sub.add_parser("doctor", help="Detect risks across all scopes")
    p_perm_doctor.add_argument("--json", action="store_true")

    p_perm_disable = perm_sub.add_parser("disable", help="Disable hub-managed permissions for a scope")
    p_perm_disable.add_argument("--mode", required=True, choices=["restore", "detach"])
    g_dis = p_perm_disable.add_mutually_exclusive_group()
    g_dis.add_argument("--all", action="store_true")
    g_dis.add_argument("--global", dest="global_", action="store_true")
    g_dis.add_argument("--project")
    p_perm_disable.add_argument("--harness", help="Limit to a single harness id")
    p_perm_disable.add_argument("--apply", action="store_true", help="Commit changes (default is dry-run)")
    p_perm_disable.add_argument("--json", action="store_true", help="Emit structured entries as JSON")

    p_perm_migrate_scope = perm_sub.add_parser(
        "migrate-scope",
        help="Strip global-sourced duplicate rules from project native files",
    )
    p_perm_migrate_scope.add_argument("--apply", action="store_true", help="Commit changes (default is dry-run)")
    p_perm_migrate_scope.add_argument("--json", action="store_true", help="Emit structured plan as JSON")

    # Add --json to existing adopt parser (declared above _add_scope_args block)
    p_perm_adopt.add_argument("--json", action="store_true", help="Emit result payload as JSON")

    p_perm_set = perm_sub.add_parser("set", help="Atomic full-block replace of a scope's permissions")
    _add_scope_args(p_perm_set)
    _add_personal_arg(p_perm_set)
    g_set = p_perm_set.add_mutually_exclusive_group(required=True)
    g_set.add_argument(
        "--stdin-json",
        dest="stdin_json",
        action="store_true",
        help="Read NormalizedPermissions JSON payload from stdin",
    )
    g_set.add_argument(
        "--json-file",
        dest="json_file",
        help="Read NormalizedPermissions JSON payload from a file path",
    )

    p_perm_validate = perm_sub.add_parser("validate", help="Validate a (kind, pattern) pair across installed adapters")
    p_perm_validate.add_argument("--kind", required=True, choices=["allow", "deny", "ask"])
    p_perm_validate.add_argument("--pattern", required=True)
    p_perm_validate.add_argument("--json", action="store_true")

    p_perm_capabilities = perm_sub.add_parser(
        "capabilities", help="List PermissionFeature support per installed harness"
    )
    p_perm_capabilities.add_argument("--json", action="store_true")

    # permissions presets
    p_perm_presets = perm_sub.add_parser("presets", help="Manage permission presets (built-in + user-defined)")
    presets_sub = p_perm_presets.add_subparsers(dest="presets_cmd")

    p_presets_list = presets_sub.add_parser("list", help="List built-in and user-defined presets")
    p_presets_list.add_argument("--json", action="store_true")

    p_presets_show = presets_sub.add_parser("show", help="Show all rules in a preset")
    p_presets_show.add_argument("id", help="Preset id")
    p_presets_show.add_argument("--json", action="store_true")

    p_presets_apply = presets_sub.add_parser("apply", help="Stamp a preset's rules into a project's permissions")
    p_presets_apply.add_argument("id", help="Preset id")
    p_presets_apply.add_argument("--project", required=True, help="Project name")
    p_presets_apply.add_argument(
        "--rules",
        help="CSV of patterns to apply (default: all enabled_by_default rules)",
    )
    p_presets_apply.add_argument("--json", action="store_true")

    p_presets_new = presets_sub.add_parser("new", help="Create a user-defined preset (empty rule list)")
    p_presets_new.add_argument("id", help="Preset id (slug)")
    p_presets_new.add_argument("--name", required=True)
    p_presets_new.add_argument("--description", default="")
    p_presets_new.add_argument("--icon", default="📦")
    p_presets_new.add_argument("--category", default="custom")

    p_presets_update = presets_sub.add_parser("update", help="Update a user-defined preset")
    p_presets_update.add_argument("id", help="Preset id")
    p_presets_update.add_argument("--name")
    p_presets_update.add_argument("--description")
    p_presets_update.add_argument("--icon")
    p_presets_update.add_argument(
        "--add-rule",
        dest="add_rule",
        action="append",
        default=[],
        help="Pattern to add (repeatable)",
    )
    p_presets_update.add_argument(
        "--remove-rule",
        dest="remove_rule",
        action="append",
        default=[],
        help="Pattern to remove (repeatable)",
    )

    p_presets_delete = presets_sub.add_parser(
        "delete", help="Delete a user-defined preset (built-ins cannot be deleted)"
    )
    p_presets_delete.add_argument("id", help="Preset id")


def dispatch(args) -> None:
    sub_cmd = getattr(args, "permissions_cmd", None)
    if sub_cmd == "add":
        cmd_permissions_add(args)
        return
    _ensure_operation_context(args)
    if sub_cmd == "list":
        cmd_permissions_list(args)
    elif sub_cmd == "show":
        cmd_permissions_show(args)
    elif sub_cmd == "remove":
        cmd_permissions_remove(args)
    elif sub_cmd == "hooks":
        hc = getattr(args, "hooks_cmd", None)
        if hc == "add":
            cmd_permissions_hooks_add(args)
        elif hc == "remove":
            cmd_permissions_hooks_remove(args)
        else:
            p_perm_hooks.print_help()
    elif sub_cmd == "adopt":
        cmd_permissions_adopt(args)
    elif sub_cmd == "import":
        cmd_permissions_import(args)
    elif sub_cmd == "reconcile":
        cmd_permissions_reconcile(args)
    elif sub_cmd == "doctor":
        cmd_permissions_doctor(args)
    elif sub_cmd == "disable":
        cmd_permissions_disable(args)
    elif sub_cmd == "migrate-scope":
        cmd_permissions_migrate_scope(args)
    elif sub_cmd == "set":
        cmd_permissions_set(args)
    elif sub_cmd == "validate":
        cmd_permissions_validate(args)
    elif sub_cmd == "capabilities":
        cmd_permissions_capabilities(args)
    elif sub_cmd == "presets":
        pc = getattr(args, "presets_cmd", None)
        if pc == "list":
            cmd_permissions_presets_list(args)
        elif pc == "show":
            cmd_permissions_presets_show(args)
        elif pc == "apply":
            cmd_permissions_presets_apply(args)
        elif pc == "new":
            cmd_permissions_presets_new(args)
        elif pc == "update":
            cmd_permissions_presets_update(args)
        elif pc == "delete":
            cmd_permissions_presets_delete(args)
        else:
            p_perm_presets.print_help()
    else:
        p_perm.print_help()


# ─────────────────────────────────────────────────────────────────────────────
# hub permissions ...
# ─────────────────────────────────────────────────────────────────────────────


def _project_native_skip_reason(registry: dict, scope_kind: str, project_name) -> Optional[str]:
    if scope_kind == "global":
        return None
    from skill_hub.application.skills import skill_variants

    return skill_variants.project_sync_skip_reason((registry.get("projects") or {}).get(project_name) or {})


def _perm_scope_from_args(args, registry: dict):
    """Resolve `--global` / `--project <n>` into a (scope, block_setter, label) tuple."""
    from skill_hub.domain.permissions.permissions import GlobalScope, ProjectScope

    if getattr(args, "global_", False):
        return ("global", None, GlobalScope(), "global")
    proj_name = getattr(args, "project", None)
    if not proj_name:
        fail("specify --global or --project <name>")
    if proj_name not in registry.get("projects", {}):
        fail(f"unknown project: {proj_name}")
    proj_cfg = registry["projects"][proj_name]
    proj_path = expand(proj_cfg["path"])
    return (
        "project",
        proj_name,
        ProjectScope(name=proj_name, path=str(proj_path)),
        proj_name,
    )


def _perm_personal_flag(args, scope_kind: str) -> bool:
    """Resolve the `--personal` flag, rejecting it outside project scope.

    Personal (`permissions_local`) is a project-only tier — the global scope has no
    committed/personal split. Returns False when the flag is absent.
    """
    personal = bool(getattr(args, "personal", False))
    if personal and scope_kind != "project":
        fail("--personal requires --project <name> (global has no personal tier)")
    return personal


def _get_perm_block(
    registry: dict,
    scope_kind: str,
    proj_name: Optional[str],
    personal: bool = False,
) -> dict:
    if scope_kind == "global":
        block = registry.setdefault("permissions_global", {})
        return block
    key = "permissions_local" if personal else "permissions"
    return registry["projects"][proj_name].setdefault(key, {})


def cmd_permissions_list(args):
    from skill_hub.domain.diagnostics import risks as _risks
    from skill_hub.domain.permissions.permissions import NormalizedPermissions, resolve_effective

    registry = hub_core.load_registry()
    print(f"\n{c('Permissions overview', BOLD)}\n")
    g = registry.get("permissions_global") or {}
    g_counts = (
        len(g.get("allow") or []),
        len(g.get("deny") or []),
        len(g.get("ask") or []),
        len(g.get("hooks") or []),
    )
    g_risks = len(_risks.detect_risks(NormalizedPermissions.from_block(g), set()))
    unmanaged = ", ".join(g.get("_unmanaged") or []) or "-"
    print(
        f"  global   allow={g_counts[0]}  deny={g_counts[1]}  ask={g_counts[2]}  "
        f"hooks={g_counts[3]}  sandbox={g.get('sandbox_mode') or '-'}  "
        f"approval={g.get('approval_policy') or '-'}  risks={g_risks}  "
        f"unmanaged=[{unmanaged}]"
    )
    for proj_name, proj_cfg in (registry.get("projects") or {}).items():
        b = proj_cfg.get("permissions") or {}
        counts = (
            len(b.get("allow") or []),
            len(b.get("deny") or []),
            len(b.get("ask") or []),
            len(b.get("hooks") or []),
        )
        proj_risks = len(_risks.detect_risks(resolve_effective(proj_cfg, registry), set()))
        unmanaged = ", ".join(b.get("_unmanaged") or []) or "-"
        print(
            f"  {proj_name}  allow={counts[0]}  deny={counts[1]}  ask={counts[2]}  "
            f"hooks={counts[3]}  risks={proj_risks}  unmanaged=[{unmanaged}]"
        )
    print()


def cmd_permissions_show(args):
    _ensure_operation_context(args)
    import hub
    from skill_hub.domain.permissions.permissions import (
        GlobalScope,
        NormalizedPermissions,
        ProjectScope,
        resolve_effective,
    )
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    registry = hub_core.load_registry()
    scope_kind, proj_name, _scope, label = _perm_scope_from_args(args, registry)
    native_skip = _project_native_skip_reason(registry, scope_kind, proj_name)
    effective_mode = bool(getattr(args, "effective", False))
    personal = _perm_personal_flag(args, scope_kind)
    if personal:
        label = f"{label} · personal"

    if scope_kind == "global":
        raw_block = registry.get("permissions_global") or {}
        duplicate_collapsed = hub._permissions_duplicate_count(raw_block)
        perms = NormalizedPermissions.from_block(raw_block)
        for r in perms.allow + perms.deny + perms.ask:
            r.origin = "global"
        for h in perms.hooks:
            h.origin = "global"
        scope_obj = GlobalScope()
    else:
        proj_cfg = registry["projects"][proj_name]
        if effective_mode:
            duplicate_collapsed = 0
            perms = resolve_effective(proj_cfg, registry)
        else:
            block_key = "permissions_local" if personal else "permissions"
            raw_block = proj_cfg.get(block_key) or {}
            duplicate_collapsed = hub._permissions_duplicate_count(raw_block)
            perms = NormalizedPermissions.from_block(raw_block)
            for r in perms.allow + perms.deny + perms.ask:
                r.origin = "project"
            for h in perms.hooks:
                h.origin = "project"
        scope_obj = ProjectScope(name=proj_name, path=str(expand(proj_cfg["path"])))

    # In --effective mode, gather skip reasons per (pattern, kind) and per (event, matcher, command)
    # by running each installed harness's adapter translate() against the resolved perms.
    skip_index: dict[tuple, list[tuple[str, str]]] = {}
    hook_skip_index: dict[tuple, list[tuple[str, str]]] = {}
    if effective_mode and not native_skip:
        installed = _operation_harness_ids(args._operation_context, installed=True)
        for h_id in sorted(installed):
            if _operation_permission_key(args._operation_context, h_id) is None:
                continue
            adapter = pa.select_permission_adapter(args._operation_context, h_id).adapter
            if adapter is None:
                continue
            try:
                tr = adapter.translate(perms, scope_obj, h_id)
            except Exception:
                continue
            for sr in tr.skipped:
                if sr.rule_pattern is not None:
                    key = (sr.rule_pattern, _kind_for_feature(sr.feature))
                    skip_index.setdefault(key, []).append((h_id, sr.reason))
                elif sr.detail and "/" in (sr.detail or ""):
                    hook_skip_index.setdefault(sr.detail, []).append((h_id, sr.reason))

    if getattr(args, "json", False):
        payload = perms.to_dict()
        if duplicate_collapsed:
            payload["duplicate_collapsed"] = duplicate_collapsed
        if scope_kind == "global":
            # Populate adoption_required for unmanaged installed harnesses whose
            # discover_existing() finds rules. Per-project show --json never
            # populates this field — auto-import already runs on sync and is
            # surfaced via the inline banner.
            installed = _operation_harness_ids(args._operation_context, installed=True)
            managed_block = registry.get("permissions_global") or {}
            unmanaged_set = set(managed_block.get("_unmanaged") or [])
            block_has_rules = hub._has_any_managed_perms(managed_block)
            adoption: dict[str, list[dict]] = {}
            for h_id in sorted(installed):
                if _operation_permission_key(args._operation_context, h_id) is None:
                    continue
                # "Managed" = the block has rules AND this harness isn't on the
                # _unmanaged list. When the user explicitly marked the harness
                # _unmanaged, we still want to surface the discovery (per spec).
                managed = block_has_rules and h_id not in unmanaged_set
                if managed:
                    continue
                adapter = pa.select_permission_adapter(args._operation_context, h_id).adapter
                if adapter is None or not hasattr(adapter, "discover_existing"):
                    continue
                try:
                    discovered = adapter.discover_existing(scope_obj, h_id, project_path=None)
                except Exception:
                    continue
                if not hub._discovered_has_anything(discovered):
                    continue
                entries: list[dict] = []
                source_file = None
                if hasattr(adapter, "target_files"):
                    try:
                        tf = adapter.target_files(scope_obj, h_id)
                        source_file = str(tf) if tf else None
                    except Exception:
                        source_file = None
                for kind, rules in (
                    ("allow", discovered.allow),
                    ("deny", discovered.deny),
                    ("ask", discovered.ask),
                ):
                    for r in rules:
                        entries.append(
                            {
                                "pattern": r.pattern,
                                "kind": kind,
                                "source_file": source_file,
                            }
                        )
                if entries:
                    adoption[h_id] = entries
            payload["adoption_required"] = adoption or None
        if not effective_mode and not personal:
            # Divergence summary for the app's chip + staleness notice —
            # cheap (a few file reads + a pure translate), no reconcile run.
            try:
                payload["divergence"] = _permissions_divergence(
                    registry, scope_obj, scope_kind, proj_name, args._operation_context
                )
            except Exception:
                payload["divergence"] = None
            wt = raw_block.get("worktree_access") or {}
            # New registrations freeze the resolved directory in the project
            # record. Older records have no worktree block and retain the
            # historical suggestion for backwards-compatible editing.
            suggestion = str(
                wt.get("path")
                if isinstance(wt, dict) and isinstance(wt.get("path"), str)
                else Path.home() / "Dev" / "worktrees" / str(proj_name)
            )
            payload["worktree_access_suggestion"] = suggestion
            if wt and not native_skip:
                from skill_hub.application.sync.permissions_stream import (
                    _directory_contributions,
                    _requested_worktree_harnesses,
                )

                statuses = []
                for h_id in sorted(_requested_worktree_harnesses(proj_cfg, registry)):
                    permission_key = _operation_permission_key(args._operation_context, h_id)
                    unmanaged = set((raw_block or {}).get("_unmanaged") or []) | set(
                        (registry.get("permissions_global") or {}).get("_unmanaged") or []
                    )
                    if h_id in unmanaged:
                        statuses.append(
                            {
                                "harness": h_id,
                                "config_state": "unmanaged",
                                "runtime_state": "not_applicable",
                                "target_file": None,
                                "requested_path": wt.get("path"),
                                "missing_parent": False,
                                "reason_code": "UNMANAGED_HARNESS",
                                "reason": "This harness is unmanaged for this project.",
                            }
                        )
                        continue
                    if h_id not in _operation_harness_ids(args._operation_context, installed=True):
                        statuses.append(
                            {
                                "harness": h_id,
                                "config_state": "not_installed",
                                "runtime_state": "not_applicable",
                                "target_file": None,
                                "requested_path": wt.get("path"),
                                "missing_parent": False,
                                "reason_code": None,
                                "reason": None,
                            }
                        )
                        continue
                    adapter = (
                        pa.select_permission_adapter(args._operation_context, h_id).adapter
                        if permission_key is not None
                        else None
                    )
                    if adapter is None or not hasattr(adapter, "read_directories"):
                        statuses.append(
                            {
                                "harness": h_id,
                                "config_state": "unsupported",
                                "runtime_state": "not_applicable",
                                "target_file": None,
                                "requested_path": wt.get("path"),
                                "missing_parent": False,
                                "reason_code": "UNSUPPORTED_HARNESS",
                                "reason": "This harness does not support project directory grants.",
                            }
                        )
                        continue
                    contributions = _directory_contributions(proj_cfg, False, h_id)
                    read_scope = scope_obj
                    if permission_key == "claude" and wt.get("enabled"):
                        from skill_hub.domain.permissions.permissions import ProjectScope

                        read_scope = ProjectScope(proj_name, scope_obj.path, personal=True)
                        contributions = _directory_contributions(proj_cfg, True, h_id) + tuple(
                            c for c in contributions if c.id == "worktree"
                        )
                    statuses.append(adapter.read_directories(read_scope, contributions, h_id).__dict__)
                payload["worktree_access_status"] = {
                    "requested_path": wt.get("path"),
                    "missing_parent": bool(wt.get("path") and not Path(str(wt["path"])).exists()),
                    "harnesses": statuses,
                }
        print(json.dumps(payload, indent=2))
        return

    print(f"\n{c(f'Permissions ({label})', BOLD)}")
    if effective_mode:
        print(f"{c('  origin  kind   pattern                  applies to', DIM)}")
    else:
        print(f"{c('  kind   pattern                  applies to', DIM)}")
    for kind, rules in (
        ("allow", perms.allow),
        ("deny", perms.deny),
        ("ask", perms.ask),
    ):
        for r in rules:
            applies = ", ".join(r.harnesses) if r.harnesses else "all"
            if effective_mode:
                print(f"  {r.origin:7s} {kind:6s} {r.pattern:24s} {applies}")
                for h_id, reason in skip_index.get((r.pattern, kind), []):
                    print(f"           {c(f'· skipped on {h_id}: {reason}', DIM)}")
            else:
                print(f"  {kind:6s} {r.pattern:24s} {applies}")
    for h in perms.hooks:
        applies = ", ".join(h.harnesses) if h.harnesses else "all"
        prefix = f"{(h.origin or '-'):7s} " if effective_mode else ""
        print(f"  {prefix}hook   {h.event}/{h.matcher}: {h.command}  {applies}")
        if effective_mode:
            for h_id, reason in hook_skip_index.get(f"{h.event}/{h.matcher}", []):
                print(f"           {c(f'· skipped on {h_id}: {reason}', DIM)}")
    if perms.sandbox_mode is not None:
        print(f"  sandbox_mode = {perms.sandbox_mode}")
    if perms.approval_policy is not None:
        print(f"  approval_policy = {perms.approval_policy}")
    if perms.project_trust is not None:
        print(f"  project_trust = {perms.project_trust}")
    if perms.additional_dirs:
        print(f"  additional_dirs = {perms.additional_dirs}")
    print()


def _kind_for_feature(feature: str) -> str:
    """Map a PermissionFeature value back to a rule kind for skip-index lookup."""
    return {
        "tool_allowlist": "allow",
        "tool_denylist": "deny",
        "tool_ask": "ask",
    }.get(feature, "")


def _validate_pattern_across_adapters(
    pattern: str,
    kind: str,
    *,
    operation_context=None,
    mode: str = "operation",
) -> tuple[bool, str]:
    """Compatibility wrapper around the shared aggregate validator."""
    from skill_hub.domain.permissions.permissions import Rule
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    result = pa.validate_rule_across_adapters(
        Rule(pattern=pattern, kind=kind),
        operation_context=operation_context,
        mode=mode,
    )
    return result.ok, result.error or ""


@registry_mutation("permissions-add")
def cmd_permissions_add(args):
    import hub

    operation_context = _ensure_operation_context(args)
    kind = args.kind
    pattern = args.pattern
    if kind not in {"allow", "deny", "ask"}:
        fail(f"--kind must be allow|deny|ask, got {kind!r}")
    ok, err = _validate_pattern_across_adapters(
        pattern,
        kind,
        operation_context=operation_context,
    )
    if not ok:
        fail(f"pattern {pattern!r} rejected: {err}")

    # Validate the captured route before loading the registry.  Registry
    # loading may migrate and rewrite an older file, so a refused operation
    # must leave host state byte-identical.
    registry = hub_core.load_registry()
    scope_kind, proj_name, _scope, label = _perm_scope_from_args(args, registry)

    personal = _perm_personal_flag(args, scope_kind)
    if personal:
        label = f"{label} · personal"
    block = _get_perm_block(registry, scope_kind, proj_name, personal=personal)
    bucket = list(block.get(kind) or [])
    harnesses = parse_csv(getattr(args, "harnesses", None))
    entry: dict = {"pattern": pattern, "kind": kind}
    if harnesses:
        entry["harnesses"] = harnesses
    # Dedup: (pattern, kind) already present?
    for existing in bucket:
        ex_pat = existing.get("pattern") if isinstance(existing, dict) else str(existing)
        if ex_pat == pattern:
            fail(f"rule already exists for {pattern!r} in {label}")
    bucket.append(entry)
    block[kind] = bucket
    hub_core.save_registry(registry)
    print(f"{c('✓', GREEN)} added {kind} rule {pattern!r} to {label}")
    hub._auto_sync_tail()


@registry_mutation("permissions-remove")
def cmd_permissions_remove(args):
    import hub

    registry = hub_core.load_registry()
    scope_kind, proj_name, _scope, label = _perm_scope_from_args(args, registry)
    kind = args.kind
    pattern = args.pattern
    personal = _perm_personal_flag(args, scope_kind)
    if personal:
        label = f"{label} · personal"
    block = _get_perm_block(registry, scope_kind, proj_name, personal=personal)
    bucket = list(block.get(kind) or [])
    new_bucket = [r for r in bucket if (r.get("pattern") if isinstance(r, dict) else str(r)) != pattern]
    if len(new_bucket) == len(bucket):
        fail(f"no {kind} rule with pattern {pattern!r} in {label}")
    block[kind] = new_bucket
    hub_core.save_registry(registry)
    print(f"{c('✓', GREEN)} removed {kind} rule {pattern!r} from {label}")
    hub._auto_sync_tail()


def _hook_deprecation_notice() -> None:
    print(
        f"  {c('!', YELLOW)} `hub permissions hooks …` is deprecated — hooks now "
        f"live in the hook library. Use `hub hook …` (new/attach/detach/delete).",
        file=sys.stderr,
    )


@registry_mutation("permissions-hooks-add")
def cmd_permissions_hooks_add(args):
    """DEPRECATED thin alias → `hub hook new` + `hub hook attach`.

    Routes the legacy (event, matcher, command) triple into the hook library:
    creates a `imported-hook-<n>` definition and attaches it at the requested
    scope. Kept (with a loud deprecation warning) so existing scripts keep working.
    """
    import hub

    _hook_deprecation_notice()
    registry = hub_core.load_registry()
    scope_kind, proj_name, _scope, label = _perm_scope_from_args(args, registry)
    harnesses = parse_csv(getattr(args, "harnesses", None)) or None
    from skill_hub.domain.hooks import hooks_model

    existing = set(hooks_model.all_definitions(registry).keys())
    name = _next_imported_hook_name(existing)
    _hook_new(
        registry,
        name,
        event=args.event,
        command=_hook_command_arg(args),
        tools=None,
        matcher=args.matcher,
        timeout=None,
        harnesses=harnesses,
    )
    _hook_attach(registry, name, scope_global=(scope_kind == "global"), proj_name=proj_name)
    hub_core.save_registry(registry)
    print(f"{c('✓', GREEN)} created hook '{name}' and attached to {label}")
    hub._auto_sync()


@registry_mutation("permissions-hooks-remove")
def cmd_permissions_hooks_remove(args):
    """DEPRECATED thin alias → `hub hook detach`.

    Finds the library hook whose (event, matcher, command) matches and detaches it
    from the requested scope. No exact match → guidance to use `hub hook detach`.
    """
    import hub

    _hook_deprecation_notice()
    registry = hub_core.load_registry()
    scope_kind, proj_name, _scope, label = _perm_scope_from_args(args, registry)
    from skill_hub.domain.hooks import hooks_model

    defs = hooks_model.all_definitions(registry)
    want_command = _hook_command_arg(args)
    match = None
    for name, d in defs.items():
        if d.event == args.event and d.matcher == args.matcher and d.command == want_command:
            match = name
            break
    if match is None:
        fail(
            f"no library hook matches ({args.event}, {args.matcher}, {want_command}); "
            f"use `hub hook list` then `hub hook detach <name>`"
        )
    if not _hook_detach(registry, match, scope_global=(scope_kind == "global"), proj_name=proj_name):
        fail(f"hook '{match}' was not attached to {label}")
    hub_core.save_registry(registry)
    print(f"{c('✓', GREEN)} detached hook '{match}' from {label}")
    hub._auto_sync()


def _latest_backup_for(harness_id: str, scope) -> Optional[Path]:
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    backup_dir = pa._backups_root() / harness_id / scope.slug
    if not backup_dir.exists():
        return None
    backups = sorted(backup_dir.iterdir())
    return backups[-1] if backups else None


@registry_mutation("permissions-adopt")
def cmd_permissions_adopt(args):
    _ensure_operation_context(args)
    import hub
    from skill_hub.domain.permissions.permissions import GlobalScope, ProjectScope
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    registry = hub_core.load_registry()
    action = args.action
    if action not in {"import", "replace", "skip"}:
        fail(f"--action must be import|replace|skip, got {action!r}")
    json_out = bool(getattr(args, "json", False))

    if getattr(args, "global_", False):
        scope = GlobalScope()
        scope_kind = "global"
        proj_name = None
    else:
        proj_name = getattr(args, "project", None)
        if not proj_name:
            fail("specify --global or --project <name>")
        if proj_name not in registry.get("projects", {}):
            fail(f"unknown project: {proj_name}")
        proj_cfg = registry["projects"][proj_name]
        scope = ProjectScope(name=proj_name, path=str(expand(proj_cfg["path"])))
        scope_kind = "project"

    h_filter = getattr(args, "harness", None)
    installed = _operation_harness_ids(args._operation_context, installed=True)
    targets = sorted(installed if h_filter is None else {h_filter} & installed)
    if not targets:
        fail("no installed harnesses to adopt")

    def _emit_result(imported: int, backup_path: Optional[Path], text_msg: str):
        block_after = (
            registry.get("permissions_global") or {}
            if scope_kind == "global"
            else registry["projects"][proj_name].get("permissions") or {}
        )
        payload = {
            "scope_kind": scope_kind,
            "harness_id": h_filter,
            "action": action,
            "imported": imported,
            "backup_path": str(backup_path) if backup_path else None,
            "unmanaged_after": list(block_after.get("_unmanaged") or []),
        }
        if json_out:
            print(json.dumps(payload, indent=2))
        else:
            print(text_msg)

    block = _get_perm_block(registry, scope_kind, proj_name)
    if action == "skip":
        unmanaged = list(block.get("_unmanaged") or [])
        for h_id in targets:
            if h_id not in unmanaged:
                unmanaged.append(h_id)
        block["_unmanaged"] = unmanaged
        hub_core.save_registry(registry)
        _emit_result(
            0,
            None,
            f"{c('✓', GREEN)} marked {targets} as unmanaged for {scope_kind}",
        )
        return

    discovered_union = []
    for h_id in targets:
        if _operation_permission_key(args._operation_context, h_id) is None:
            continue
        adapter = pa.select_permission_adapter(args._operation_context, h_id).adapter
        if adapter is None:
            continue
        proj_path = Path(scope.path) if isinstance(scope, ProjectScope) else None
        discovered = adapter.discover_existing(scope, h_id, project_path=proj_path)
        if hub._discovered_has_anything(discovered):
            discovered_union.append((h_id, discovered))

    if not discovered_union:
        _emit_result(0, None, f"{c('·', DIM)} nothing to adopt")
        return

    if action == "replace":
        # Clear current block and replace with union of discovered
        keep_unmanaged = block.get("_unmanaged")
        block.clear()
        if keep_unmanaged:
            block["_unmanaged"] = keep_unmanaged

    imported_count = 0
    for h_id, discovered in discovered_union:
        new_block = hub._serialize_perms_block(discovered)
        for key in ("allow", "deny", "ask", "hooks"):
            if key in new_block:
                block.setdefault(key, [])
                block[key].extend(new_block[key])
                imported_count += len(new_block[key])
        for key in ("sandbox_mode", "approval_policy", "project_trust"):
            if key in new_block and block.get(key) is None:
                block[key] = new_block[key]
                imported_count += 1
        if "additional_dirs" in new_block:
            existing = list(block.get("additional_dirs") or [])
            for d in new_block["additional_dirs"]:
                if d not in existing:
                    existing.append(d)
                    imported_count += 1
            block["additional_dirs"] = existing

    # Clear unmanaged flag for these harnesses if present
    if block.get("_unmanaged"):
        block["_unmanaged"] = [h for h in block["_unmanaged"] if h not in targets]
        if not block["_unmanaged"]:
            del block["_unmanaged"]

    hub._dedupe_registry_permissions(registry)
    hub_core.save_registry(registry)
    backup_for_emit = _latest_backup_for(h_filter, scope) if h_filter else None
    _emit_result(
        imported_count,
        backup_for_emit,
        f"{c('✓', GREEN)} adopted permissions from {targets} into {scope_kind}",
    )


def _codex_default_rules_for_scope(scope):
    return permission_adapter_codex._codex_default_rules_target(scope)


def _add_rule_to_block(block: dict, pattern: str, kind: str, harnesses) -> bool:
    """Add a {pattern, kind[, harnesses]} rule into a registry permissions block,
    de-duplicating on (pattern, kind, harnesses). Returns True if added."""
    lst = block.setdefault(kind, [])
    norm_harn = sorted(harnesses) if harnesses else None
    for entry in lst:
        ep = entry.get("pattern") if isinstance(entry, dict) else entry
        eh = entry.get("harnesses") if isinstance(entry, dict) else None
        if ep == pattern and (sorted(eh) if eh else None) == norm_harn:
            return False
    rule: dict = {"pattern": pattern, "kind": kind}
    if norm_harn:
        rule["harnesses"] = norm_harn
    lst.append(rule)
    return True


def _drop_claude_rule(file_path: Path, pattern: str, kind: Optional[str]) -> bool:
    """Remove a user-authored rule pattern from a Claude-shape settings.json."""
    if not file_path.exists():
        return False
    try:
        data = json.loads(file_path.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    perms = data.get("permissions")
    if not isinstance(perms, dict):
        return False
    removed = False
    kinds = [kind] if kind else ["allow", "deny", "ask"]
    for k in kinds:
        lst = perms.get(k)
        if isinstance(lst, list) and pattern in lst:
            perms[k] = [p for p in lst if p != pattern]
            removed = True
    if removed:
        from skill_hub.infrastructure.permissions import permission_adapters as pa

        pa._atomic_replace(file_path, json.dumps(data, indent=2) + "\n")
    return removed


def cmd_permissions_import(args):
    _ensure_operation_context(args)
    """Discover + reconcile pre-existing native rules across harnesses, then
    import/keep/drop them with MOVE semantics (D10/D11/D12)."""
    from skill_hub.domain.permissions.permissions import GlobalScope, ProjectScope
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    registry = hub_core.load_registry()
    json_out = bool(getattr(args, "json", False))

    if getattr(args, "global_", False):
        scope = GlobalScope()
        scope_kind, proj_name = "global", None
    else:
        proj_name = getattr(args, "project", None)
        if not proj_name:
            fail("specify --global or --project <name>")
        if proj_name not in registry.get("projects", {}):
            fail(f"unknown project: {proj_name}")
        proj_cfg = registry["projects"][proj_name]
        scope = ProjectScope(name=proj_name, path=str(expand(proj_cfg["path"])))
        scope_kind = "project"

    if _project_native_skip_reason(registry, scope_kind, proj_name):
        fail("No local directory attached. Attach a directory before importing native permissions.")

    installed = _operation_harness_ids(args._operation_context, installed=True)
    h_filter = getattr(args, "harness", None)
    targets = sorted(installed if h_filter is None else {h_filter} & installed)

    candidates = pa.gather_import_candidates(scope, targets, args._operation_context)
    reconciled = pa.reconcile_candidates(candidates)

    apply_flag = bool(getattr(args, "apply", False))
    interactive = bool(getattr(args, "interactive", False))

    # ── Apply mode: consume a decisions payload from stdin ──
    if apply_flag:
        if not getattr(args, "decisions_stdin", False):
            fail("--apply requires --decisions-stdin")
        try:
            payload = json.loads(sys.stdin.read() or "{}")
        except json.JSONDecodeError as e:
            fail(f"invalid decisions JSON: {e}")
        decisions = payload.get("decisions") or []
        # `import` is a thin alias for `reconcile` (D3): same transactional +
        # auto-syncing apply path.
        summary = _reconcile_apply(
            registry,
            scope,
            scope_kind,
            proj_name,
            decisions,
            installed,
            conflict_patterns={cf["pattern"] for cf in reconciled["conflicts"]},
            operation_context=args._operation_context,
        )
        if json_out:
            print(json.dumps(summary, indent=2))
        else:
            print(
                f"{c('✓', GREEN)} import: {summary['imported']} imported, "
                f"{summary['dropped']} dropped, {summary['kept']} kept"
            )
        return

    # ── Discovery mode: emit (or interactively prompt) the reconciled set ──
    def _candidate_view(reconciled):
        return {
            "scope_kind": scope_kind,
            "project": proj_name,
            "merged": [
                {
                    "pattern": m["pattern"],
                    "kind": m["kind"],
                    "harnesses": m["harnesses"],
                    "sources": [{"harness": s["harness"], "source": s["source"]} for s in m["sources"]],
                }
                for m in reconciled["merged"]
            ],
            "conflicts": [{"pattern": cf["pattern"], "options": cf["options"]} for cf in reconciled["conflicts"]],
            "un_importable": [
                {
                    "source": u.get("source"),
                    "harness": u.get("harness"),
                    "reason": u.get("reason"),
                    "file": u.get("file"),
                }
                for u in reconciled["un_importable"]
            ],
        }

    if json_out:
        print(json.dumps(_candidate_view(reconciled), indent=2))
        return

    if interactive and sys.stdin.isatty():
        decisions = _prompt_import_decisions(reconciled)
        summary = _apply_import_decisions(
            registry, scope, scope_kind, proj_name, decisions, args._operation_context
        )
        hub_core.save_registry(registry)
        print(
            f"\n{c('✓', GREEN)} import: {summary['imported']} imported, "
            f"{summary['dropped']} dropped, {summary['kept']} kept"
        )
        return

    # Plain text summary (non-interactive)
    print(f"\n{c('Permissions import — ' + scope_kind, BOLD)}\n")
    if not (reconciled["merged"] or reconciled["conflicts"] or reconciled["un_importable"]):
        print(f"  {c('·', DIM)} nothing to import")
        return
    for m in reconciled["merged"]:
        srcs = ", ".join(sorted({s["harness"] for s in m["sources"]}))
        print(f"  {c('+', GREEN)} {m['kind']:<5} {m['pattern']}  [{srcs}]")
    for cf in reconciled["conflicts"]:
        opts = "; ".join(f"{k}={','.join(v)}" for k, v in cf["options"].items())
        print(f"  {c('!', YELLOW)} CONFLICT {cf['pattern']}  ({opts})")
    for u in reconciled["un_importable"]:
        print(f"  {c('×', DIM)} un-importable [{u.get('harness')}] {u.get('reason')}")
    print("\n  run with --interactive to choose, or --json for machine output")


def _prompt_import_decisions(reconciled: dict) -> list[dict]:
    decisions: list[dict] = []
    for m in reconciled["merged"]:
        ans = input(f"  {m['kind']} {m['pattern']} — [i]mport / [k]eep / [d]rop? ").strip().lower()
        action = {"i": "import", "k": "keep", "d": "drop"}.get(ans, "keep")
        decisions.append({"pattern": m["pattern"], "kind": m["kind"], "action": action})
    for cf in reconciled["conflicts"]:
        kinds = list(cf["options"].keys())
        prompt = (
            f"  CONFLICT {cf['pattern']} — pick "
            + " / ".join(f"[{k}]" for k in kinds)
            + " / [b]oth (affinity) / [k]eep / [d]rop? "
        )
        ans = input(prompt).strip().lower()
        if ans == "b":
            for k, harns in cf["options"].items():
                decisions.append(
                    {
                        "pattern": cf["pattern"],
                        "kind": k,
                        "harnesses": harns,
                        "action": "import",
                    }
                )
        elif ans in {k[0] for k in kinds}:
            chosen = next(k for k in kinds if k[0] == ans)
            decisions.append(
                {
                    "pattern": cf["pattern"],
                    "kind": chosen,
                    "action": "import",
                }
            )
        elif ans == "d":
            decisions.append({"pattern": cf["pattern"], "action": "drop"})
        # else keep
    return decisions


# ─────────────────────────────────────────────────────────────────────────────
# Reconcile kept-decisions store (permissions-divergence-fixes 5.3b)
#
# "Keep" means "this native rule is not hub's business — stop counting it".
# Machine-local user decisions about machine-local files: deliberately NOT in
# the registry and NOT backed up. Fingerprint = (pattern, kind, source_file),
# so a rule whose kind changes in the native file no longer matches and
# re-surfaces — the situation the user decided about no longer exists.
# ─────────────────────────────────────────────────────────────────────────────


def _kept_store_path(scope) -> Path:
    return data_home() / "state" / "reconcile" / f"{scope.slug}.kept.json"


def _load_kept(scope) -> list[dict]:
    path = _kept_store_path(scope)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return []
    entries = data.get("kept") if isinstance(data, dict) else None
    return [e for e in (entries or []) if isinstance(e, dict) and e.get("pattern")]


def _save_kept(scope, entries: list[dict]) -> None:
    path = _kept_store_path(scope)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"schema_version": 1, "kept": entries}, indent=2) + "\n")
    os.replace(tmp, path)


def _kept_fingerprints(scope) -> set:
    return {(e.get("pattern"), e.get("kind"), e.get("source_file")) for e in _load_kept(scope)}


def _candidate_is_kept(kept: set, pattern: str, kind: str, file: Optional[str]) -> bool:
    return (pattern, kind, file) in kept


def _record_kept_decisions(scope, decisions: list[dict], reconciled: dict) -> None:
    """Persist keep decisions (and lift unkeep ones) after a reconcile apply.

    The store is non-transactional by design: it never touches the registry or
    native files, and a lost keep only means the candidate re-surfaces."""
    kept_entries = _load_kept(scope)
    existing = {(e.get("pattern"), e.get("kind"), e.get("source_file")) for e in kept_entries}
    by_pattern: dict[tuple, list[dict]] = {}
    for m in reconciled.get("merged", []):
        by_pattern[(m["pattern"], m["kind"])] = m.get("sources") or []

    changed = False
    for d in decisions:
        action = d.get("action")
        pattern, kind = d.get("pattern"), d.get("kind")
        if not pattern:
            continue
        if action == "keep":
            for s in by_pattern.get((pattern, kind), []):
                fp = (pattern, kind, s.get("file"))
                if fp not in existing:
                    kept_entries.append(
                        {
                            "pattern": pattern,
                            "kind": kind,
                            "source_file": s.get("file"),
                        }
                    )
                    existing.add(fp)
                    changed = True
        elif action == "unkeep":
            before = len(kept_entries)
            kept_entries = [
                e for e in kept_entries if not (e.get("pattern") == pattern and (kind is None or e.get("kind") == kind))
            ]
            if len(kept_entries) != before:
                existing = {(e.get("pattern"), e.get("kind"), e.get("source_file")) for e in kept_entries}
                changed = True
    if changed:
        _save_kept(scope, kept_entries)


def _permissions_divergence(registry: dict, scope, scope_kind: str, proj_name, operation_context=None):
    """Per-harness divergence summary for the app's Permissions screens:

    - `unmanaged`: reconcile candidates in native files hub does not manage,
      minus rules the user marked kept.
    - `stale`: the scope's current registry block, translated for this harness,
      hashes differently from what the last native write recorded
      (`block_sha256` in the v2 sidecar). None = no hash recorded (pre-v2
      sidecar, or hub never wrote this scope) — unknown, not stale.
    """
    from skill_hub.domain.permissions.permissions import NormalizedPermissions, read_sidecar, resolve_project_own
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    if _project_native_skip_reason(registry, scope_kind, proj_name):
        return None
    installed = _operation_harness_ids(operation_context, installed=True)
    kept = _kept_fingerprints(scope)

    if scope_kind == "global":
        block_perms = NormalizedPermissions.from_block(registry.get("permissions_global") or {})
    else:
        block_perms = resolve_project_own(registry["projects"][proj_name])

    per_harness: dict[str, dict] = {}
    total_unmanaged = 0
    any_stale = False
    any_known = False
    last_written = None
    for h_id in sorted(installed):
        if _operation_permission_key(operation_context, h_id) is None:
            continue
        adapter = pa.select_permission_adapter(operation_context, h_id).adapter
        if adapter is None:
            continue

        # Unique (pattern, kind) pairs, so the chip count matches the number of
        # actionable rows the reconcile drawer will show — a 16x-duplicated
        # rule is ONE decision, not sixteen.
        unmanaged_pairs: set = set()
        if hasattr(adapter, "discover_candidates"):
            try:
                for cand in adapter.discover_candidates(scope, h_id):
                    if not _candidate_is_kept(kept, cand.get("pattern"), cand.get("kind"), cand.get("file")):
                        unmanaged_pairs.add((cand.get("pattern"), cand.get("kind")))
            except Exception:
                pass
        unmanaged = len(unmanaged_pairs)

        stale = None
        sc = read_sidecar(h_id, scope)
        if sc is not None and sc.block_sha256:
            try:
                result = adapter.translate(block_perms, scope, h_id)
                if result.writes:
                    current = pa.permission_block_sha256(result.writes[0].payload)
                    stale = current != sc.block_sha256
            except Exception:
                stale = None
        if sc is not None and sc.written_at:
            if last_written is None or sc.written_at > last_written:
                last_written = sc.written_at

        if stale is not None:
            any_known = True
            any_stale = any_stale or stale
        total_unmanaged += unmanaged
        per_harness[h_id] = {"unmanaged": unmanaged, "stale": stale}

    return {
        "unmanaged_count": total_unmanaged,
        "stale": any_stale if any_known else None,
        "last_written_at": last_written,
        "harnesses": per_harness,
    }


def _excise_from_all_origins(scope, pattern: str, kind: Optional[str], operation_context=None) -> bool:
    """Remove a pattern from every native origin file for the scope.

    Covers: Codex default.rules, Codex skill-hub.rules, Claude/Pi settings.json.
    Returns True if any file was modified.
    """
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    removed = False
    codex_adapter = pa.select_permission_adapter(operation_context, "codex").adapter
    if codex_adapter is not None:
        # Codex user-authored rules (default.rules)
        codex_default = (
            codex_adapter.default_rules_file(scope)
            if hasattr(codex_adapter, "default_rules_file")
            else _codex_default_rules_for_scope(scope)
        )
        if codex_adapter.excise_pattern(codex_default, pattern, kind):
            removed = True
        # Codex hub-generated rules (skill-hub.rules) — also excise so re-syncs
        # don't leave a ghost when the rule is later deleted from the registry.
        codex_skill_hub = (
            codex_adapter.rules_file(scope)
            if hasattr(codex_adapter, "rules_file")
            else permission_adapter_codex._codex_rules_target(scope)
        )
        if codex_adapter.excise_pattern(codex_skill_hub, pattern, kind):
            removed = True
    # Claude-family settings.json (best-effort per installed harness)
    ca = pa.select_permission_adapter(operation_context, "claude-code").adapter
    if ca is not None:
        from skill_hub.domain.permissions.permissions import ProjectScope as _PS

        scopes = [scope]
        # Project scope: the personal file (`.claude/settings.local.json`) is a
        # discovery origin too (Claude Code writes session-accepted rules
        # there), so an import/drop must MOVE-excise it as well.
        if isinstance(scope, _PS) and not scope.personal:
            scopes.append(_PS(name=scope.name, path=scope.path, personal=True))
        for h_id in _operation_harness_ids(operation_context, installed=True) & {
            "claude-code", "pi"
        }:
            if _operation_permission_key(operation_context, h_id) != "claude":
                continue
            for sc in scopes:
                try:
                    tf = ca.target_files(sc, h_id)
                except Exception:
                    continue
                if _drop_claude_rule(tf, pattern, kind):
                    removed = True
    return removed


def _apply_import_decisions(
    registry: dict, scope, scope_kind: str, proj_name, decisions: list[dict], operation_context=None
) -> dict:
    import hub

    block = _get_perm_block(registry, scope_kind, proj_name)

    imported = dropped = kept = 0
    for d in decisions:
        action = d.get("action", "keep")
        pattern = d.get("pattern")
        kind = d.get("kind")
        if not pattern:
            continue
        if action == "keep":
            kept += 1
            continue
        if action == "import":
            if kind and _add_rule_to_block(block, pattern, kind, d.get("harnesses")):
                imported += 1
            # MOVE: excise from every origin so rules never appear as both
            # user-authored and hub-managed after import.
            _excise_from_all_origins(scope, pattern, kind, operation_context)
        elif action == "drop":
            if _excise_from_all_origins(scope, pattern, kind, operation_context):
                dropped += 1

    hub._dedupe_registry_permissions(registry)
    return {"imported": imported, "dropped": dropped, "kept": kept}


def _scope_native_files(scope, scope_kind: str, proj_name, installed: set, operation_context=None) -> list:
    """Every native file the reconcile transaction for `scope` may touch — the
    hub-managed write targets AND the MOVE-excision origins. Used to snapshot for
    rollback. Returns a de-duplicated list of `Path`."""
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    files: list = []

    def _add(p):
        if p is not None and p not in files:
            files.append(p)

    for h_id in sorted(installed):
        permission_key = _operation_permission_key(operation_context, h_id)
        if permission_key is None:
            continue
        adapter = pa.select_permission_adapter(operation_context, h_id).adapter
        if adapter is None:
            continue
        if permission_key == "claude":
            try:
                _add(adapter.target_files(scope, h_id))
            except Exception:
                pass
            # Project scope: the personal file is an excision origin too.
            from skill_hub.domain.permissions.permissions import ProjectScope as _PS

            if isinstance(scope, _PS) and not scope.personal:
                try:
                    _add(adapter.target_files(_PS(name=scope.name, path=scope.path, personal=True), h_id))
                except Exception:
                    pass
        elif permission_key == "codex":
            codex_adapter = adapter
            try:
                _add(adapter.target_files(scope, h_id))  # config.toml
            except Exception:
                pass
            _add(
                codex_adapter.rules_file(scope)
                if hasattr(codex_adapter, "rules_file")
                else permission_adapter_codex._codex_rules_target(scope)
            )  # skill-hub.rules
            _add(
                codex_adapter.default_rules_file(scope)
                if hasattr(codex_adapter, "default_rules_file")
                else _codex_default_rules_for_scope(scope)
            )  # default.rules
    return files


def _sync_scope_native(
    registry: dict, scope, scope_kind: str, proj_name, installed: set, operation_context=None
) -> list:
    """Write native files for a single scope via the adapters — the same path as
    `hub sync`, narrowed to one scope. Global writes the global block; a project
    writes its own block (scope-targeted, D1). Returns the written file paths."""
    import hub
    from skill_hub.domain.permissions.permissions import NormalizedPermissions, resolve_project_own
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    written: list[str] = []
    if _project_native_skip_reason(registry, scope_kind, proj_name):
        return written

    if scope_kind == "global":
        block = registry.get("permissions_global") or {}
        perms = NormalizedPermissions.from_block(block)
        for r in perms.allow + perms.deny + perms.ask:
            r.origin = "global"
        for h in perms.hooks:
            h.origin = "global"
        harness_ids = sorted(installed)
        unmanaged = hub._unmanaged_list(block)
    else:
        proj_cfg = registry["projects"][proj_name]
        perms = resolve_project_own(proj_cfg)
        proj_block = proj_cfg.get("permissions") or {}
        global_block = registry.get("permissions_global") or {}
        effective = _operation_effective_harnesses(
            proj_cfg, registry, operation_context
        )
        harness_ids = sorted(effective)
        unmanaged = set(hub._unmanaged_list(proj_block)) | set(hub._unmanaged_list(global_block))

    for h_id in harness_ids:
        if _operation_permission_key(operation_context, h_id) is None:
            continue
        if h_id in unmanaged:
            continue
        adapter = pa.select_permission_adapter(operation_context, h_id).adapter
        if adapter is None:
            continue
        result = adapter.translate(perms, scope, h_id)
        for write in result.writes:
            if adapter.apply(scope, write, h_id):
                written.append(str(write.target_path))
    return written


def _set_perm_block(registry: dict, scope_kind: str, proj_name, block: dict) -> None:
    if scope_kind == "global":
        registry["permissions_global"] = block
    else:
        registry["projects"][proj_name]["permissions"] = block


def _reconcile_apply(
    registry: dict,
    scope,
    scope_kind: str,
    proj_name,
    decisions: list,
    installed: set,
    conflict_patterns: Optional[set] = None,
    operation_context=None,
) -> dict:
    """Apply reconcile decisions as a single transaction for one scope (D3):

    1. Snapshot the registry block + every native file we may touch.
    2. Mutate the registry block (import/drop/keep) + MOVE-excise origins.
    3. Write the registry, then auto-sync native files for the scope.

    On any failure after the registry write, restore the registry block and every
    native file from its pre-apply snapshot, then re-raise. Returns
    `{imported, dropped, kept, conflicts_resolved, synced_files}`.
    """
    import copy

    if _project_native_skip_reason(registry, scope_kind, proj_name):
        fail("No local directory attached. Attach a directory before importing native permissions.")

    # Record key existence BEFORE _get_perm_block's setdefault materialises an
    # empty block — a rollback must not leave a residual `permissions: {}`.
    if scope_kind == "global":
        block_pre_existed = "permissions_global" in registry
    else:
        block_pre_existed = "permissions" in registry["projects"][proj_name]
    pre_block = copy.deepcopy(_get_perm_block(registry, scope_kind, proj_name))
    touched = _scope_native_files(scope, scope_kind, proj_name, installed, operation_context)
    snapshots: dict = {}
    for p in touched:
        try:
            snapshots[p] = p.read_bytes() if p.exists() else None
        except OSError:
            snapshots[p] = None

    try:
        summary = _apply_import_decisions(
            registry, scope, scope_kind, proj_name, decisions, operation_context
        )
        hub_core.save_registry(registry)
        synced = _sync_scope_native(
            registry, scope, scope_kind, proj_name, installed, operation_context
        )
        summary["synced_files"] = synced
        cps = conflict_patterns or set()
        summary["conflicts_resolved"] = len(
            {d.get("pattern") for d in decisions if d.get("pattern") in cps and d.get("action") == "import"}
        )
        return summary
    except Exception:
        # Roll back registry block then native files to the pre-apply snapshot.
        _set_perm_block(registry, scope_kind, proj_name, pre_block)
        if not block_pre_existed and not pre_block:
            # The block only exists because our setdefault created it — remove
            # it so the rolled-back registry is byte-identical to before.
            if scope_kind == "global":
                registry.pop("permissions_global", None)
            else:
                registry["projects"][proj_name].pop("permissions", None)
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
        raise


def cmd_permissions_reconcile(args):
    _ensure_operation_context(args)
    """`hub permissions reconcile` — unified ingest of pre-existing native rules
    across all installed harnesses for a scope (D3), subsuming `adopt` + `import`.

    Discovery (no `--apply`): emit/print the reconciled candidate set
    (`merged` / `conflicts` / `un_importable`). Apply (`--apply --decisions-stdin`):
    transactional + auto-syncing via `_reconcile_apply`.
    """
    from skill_hub.domain.permissions.permissions import GlobalScope, ProjectScope
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    registry = hub_core.load_registry()
    json_out = bool(getattr(args, "json", False))

    if getattr(args, "global_", False):
        scope = GlobalScope()
        scope_kind, proj_name = "global", None
    else:
        proj_name = getattr(args, "project", None)
        if not proj_name:
            fail("specify --global or --project <name>")
        if proj_name not in registry.get("projects", {}):
            fail(f"unknown project: {proj_name}")
        proj_cfg = registry["projects"][proj_name]
        scope = ProjectScope(name=proj_name, path=str(expand(proj_cfg["path"])))
        scope_kind = "project"

    if _project_native_skip_reason(registry, scope_kind, proj_name):
        fail("No local directory attached. Attach a directory before importing native permissions.")

    installed = _operation_harness_ids(args._operation_context, installed=True)
    h_filter = getattr(args, "harness", None)
    targets = sorted(installed if h_filter is None else {h_filter} & installed)

    candidates = pa.gather_import_candidates(scope, targets, args._operation_context)
    reconciled = pa.reconcile_candidates(candidates)
    conflict_patterns = {cf["pattern"] for cf in reconciled["conflicts"]}

    apply_flag = bool(getattr(args, "apply", False))
    if apply_flag:
        if not getattr(args, "decisions_stdin", False):
            fail("--apply requires --decisions-stdin")
        try:
            payload = json.loads(sys.stdin.read() or "{}")
        except json.JSONDecodeError as e:
            fail(f"invalid decisions JSON: {e}")
        decisions = payload.get("decisions") or []
        # Audited manually (not via @registry_mutation): discovery-only runs
        # must stay silent — the app's divergence chip polls them — so only
        # the apply transaction lands in audit.jsonl, with its counts.
        with data_home_lock():
            sha_before = hub_core._registry_sha()
            summary = _reconcile_apply(
                registry,
                scope,
                scope_kind,
                proj_name,
                decisions,
                installed,
                conflict_patterns=conflict_patterns,
                operation_context=args._operation_context,
            )
            append_audit(
                "permissions-reconcile-apply",
                args,
                sha_before,
                hub_core._registry_sha(),
                extra={
                    "imported": summary["imported"],
                    "dropped": summary["dropped"],
                    "kept": summary["kept"],
                },
            )
        # Kept-decisions store: persist keep / lift unkeep AFTER the
        # transaction — losing one only re-surfaces a candidate.
        _record_kept_decisions(scope, decisions, reconciled)
        if json_out:
            print(json.dumps(summary, indent=2))
        else:
            print(
                f"{c('✓', GREEN)} reconcile: {summary['imported']} imported, "
                f"{summary['dropped']} dropped, {summary['kept']} kept, "
                f"{summary.get('conflicts_resolved', 0)} conflict(s) resolved; "
                f"synced {len(summary.get('synced_files') or [])} file(s)"
            )
        return

    # Discovery view (shared shape with `import` for the unified dialog).
    # `kept` marks candidates the user already decided to leave user-authored
    # (kept store): the app's chip excludes them; the drawer collapses them
    # into a "previously kept" group with an un-keep affordance.
    kept_fps = _kept_fingerprints(scope)
    view = {
        "scope_kind": scope_kind,
        "project": proj_name,
        "merged": [
            {
                "pattern": m["pattern"],
                "kind": m["kind"],
                "harnesses": m["harnesses"],
                "kept": all(_candidate_is_kept(kept_fps, m["pattern"], m["kind"], s.get("file")) for s in m["sources"]),
                "sources": [
                    {"harness": s["harness"], "source": s["source"], "file": s.get("file")} for s in m["sources"]
                ],
            }
            for m in reconciled["merged"]
        ],
        "conflicts": [{"pattern": cf["pattern"], "options": cf["options"]} for cf in reconciled["conflicts"]],
        "un_importable": [
            {"source": u.get("source"), "harness": u.get("harness"), "reason": u.get("reason"), "file": u.get("file")}
            for u in reconciled["un_importable"]
        ],
    }
    if json_out:
        print(json.dumps(view, indent=2))
        return
    print(f"\n{c('Permissions reconcile — ' + scope_kind, BOLD)}\n")
    if not (reconciled["merged"] or reconciled["conflicts"] or reconciled["un_importable"]):
        print(f"  {c('·', DIM)} nothing to reconcile")
        return
    for m in reconciled["merged"]:
        srcs = ", ".join(sorted({s["harness"] for s in m["sources"]}))
        print(f"  {c('+', GREEN)} {m['kind']:<5} {m['pattern']}  [{srcs}]")
    for cf in reconciled["conflicts"]:
        opts = "; ".join(f"{k}={','.join(v)}" for k, v in cf["options"].items())
        print(f"  {c('!', YELLOW)} CONFLICT {cf['pattern']}  ({opts})")
    for u in reconciled["un_importable"]:
        print(f"  {c('×', DIM)} un-importable [{u.get('harness')}] {u.get('reason')}")
    print("\n  apply with --apply --decisions-stdin, or --json for machine output")


def cmd_permissions_set(args):
    """Atomic full-block replace for permissions_global or projects.<n>.permissions.

    NOT `@registry_mutation`: the decorator takes the data-home lock before the
    function body, but this command reads its payload from stdin — a concurrent
    invocation that wins the lock while its caller has not fed stdin yet would
    hold the lock indefinitely (two `permissions set` in flight deadlock). The
    body keeps the original order: read stdin FIRST, then lock for the write;
    the auto-sync tail runs after the lock is released and re-locks per pass.

    Reads a NormalizedPermissions JSON payload from `--stdin-json` or `--json-file`,
    normalises via `NormalizedPermissions.from_block`, diffs against the current
    block, and writes the registry only if the normalised forms differ. The write
    runs under the data-home lock so concurrent invocations serialise.

    A change auto-syncs (like every other registry mutation) so the native
    harness files hold the new rules when the command returns — "Save & apply".
    stdout carries ONLY the JSON payload: the Tauri side parses it strictly, so
    sync chatter is rerouted to stderr, and a sync failure NEVER fails the save
    (the registry write above already landed) — it is carried in `sync_rc`.

    Emits `{"changed": <bool>, "normalized": <dict>, "sync_rc": <int|null>}`
    where `sync_rc` is null when nothing changed, else the sync exit status
    (0 ok, 1 stream write errors, 2 doctor danger findings).
    """
    import hub
    from skill_hub.domain.permissions.permissions import NormalizedPermissions

    stdin_json = bool(getattr(args, "stdin_json", False))
    json_file = getattr(args, "json_file", None)
    if stdin_json == bool(json_file):
        fail("specify exactly one of --stdin-json or --json-file <path>")

    if stdin_json:
        raw = sys.stdin.read()
    else:
        try:
            raw = Path(json_file).read_text()
        except OSError as e:
            fail(f"could not read {json_file}: {e}")
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        fail(f"invalid JSON payload: {e}")
    if payload is not None and not isinstance(payload, dict):
        fail("JSON payload must be an object")

    # Hooks are no longer authored through the permissions engine (hooks-surface):
    # a `hooks` key arriving via `permissions set` (e.g. a stale UI payload) is
    # IGNORED with a warning and never written. Use `hub hook …` to manage hooks.
    if isinstance(payload, dict) and payload.get("hooks"):
        print(
            f"  {c('!', YELLOW)} ignoring `hooks` key in permissions payload — hooks "
            f"are managed via `hub hook …` now, not the permissions engine",
            file=sys.stderr,
        )
    if isinstance(payload, dict):
        payload.pop("hooks", None)

    # NOT @registry_mutation: that decorator locks before the function body,
    # but this command reads stdin — a concurrent invocation would hold the
    # lock while blocked on input. The lock + audit live around the write only.
    with data_home_lock():
        sha_before = _registry_sha()
        registry = hub_core.load_registry()
        scope_kind, proj_name, _scope, _label = _perm_scope_from_args(args, registry)
        personal = _perm_personal_flag(args, scope_kind)

        if (
            isinstance(payload, dict)
            and payload.get("worktree_access") is not None
            and (scope_kind == "global" or personal)
        ):
            fail("worktree_access is supported only in a project's shared permissions")

        if scope_kind == "global":
            current_block = registry.get("permissions_global") or {}
        else:
            block_key = "permissions_local" if personal else "permissions"
            current_block = registry["projects"][proj_name].get(block_key) or {}

        current_norm = NormalizedPermissions.from_block(current_block)
        new_norm = NormalizedPermissions.from_block(payload)

        # Diff via normalised dict representation (the canonical form). Also
        # treat an already-corrupted duplicate block as changed so `set` repairs
        # it even when the submitted normalized payload is otherwise identical.
        current_dict = current_norm.to_dict()
        new_dict = new_norm.to_dict()
        _canonical_current, canonical_current_changed = hub._canonicalize_permissions_block(current_block)
        changed = current_dict != new_dict or canonical_current_changed

        if changed:
            # Build the new block. Preserve `_unmanaged` from the payload if it
            # has any entries; otherwise inherit from the current block so
            # callers can omit it without clearing.
            new_block = hub._serialize_perms_block(new_norm)
            unmanaged = list(new_norm._unmanaged or [])
            if not unmanaged and current_block.get("_unmanaged"):
                # Caller did not provide `_unmanaged`; preserve.
                unmanaged = list(current_block.get("_unmanaged") or [])
            if unmanaged:
                new_block["_unmanaged"] = unmanaged

            if scope_kind == "global":
                registry["permissions_global"] = new_block
            else:
                block_key = "permissions_local" if personal else "permissions"
                registry["projects"][proj_name][block_key] = new_block
            hub_core.save_registry(registry)
            # The `@registry_mutation` decorator is deliberately absent (see
            # the docstring), so its audit half is replicated by hand.
            append_audit("permissions-set", args, sha_before, _registry_sha())

    sync_rc: Optional[int] = None
    sync_report = None
    if changed:
        sync_rc = 0
        try:
            with contextlib.redirect_stdout(sys.stderr):
                sync_report = hub._auto_sync()
        except SystemExit as e:
            # cmd_sync exits 1 on stream write errors, 2 on doctor danger.
            sync_rc = e.code if isinstance(e.code, int) else 1
        except Exception as e:
            sync_rc = 1
            print(f"  {c('!', YELLOW)} auto-sync failed: {e}", file=sys.stderr)

    result_payload = {"changed": changed, "normalized": new_dict, "sync_rc": sync_rc}
    wt = new_dict.get("worktree_access") or {}
    if scope_kind == "project" and not personal:
        result_payload["worktree_access_status"] = (sync_report or {}).get("projects", {}).get(proj_name, {}).get(
            "worktree_access"
        ) or {
            "requested_path": wt.get("path"),
            "missing_parent": bool(wt.get("path") and not Path(str(wt["path"])).exists()),
            "harnesses": [],
        }
    print(json.dumps(result_payload, indent=2))


def cmd_permissions_validate(args):
    """Validate a (kind, pattern) pair across installed adapters.

    Wraps `_validate_pattern_across_adapters`. JSON output: `{ok, error}`.
    """
    pattern = args.pattern
    kind = args.kind
    ok, err = _validate_pattern_across_adapters(pattern, kind, mode="baseline")
    payload = {"ok": ok, "error": None if ok else (err or "invalid")}
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
    else:
        if ok:
            print(f"{c('✓', GREEN)} {kind} {pattern!r} accepted")
        else:
            print(f"{c('✗', RED)} {kind} {pattern!r} rejected: {payload['error']}")
            sys.exit(1)


def cmd_permissions_capabilities(args):
    _ensure_operation_context(args)
    """Emit per-installed-harness PermissionFeature lists.

    Only installed harnesses whose adapter exposes `capabilities()` are listed.
    """
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    installed = _operation_harness_ids(args._operation_context, installed=True)
    out: dict[str, list[str]] = {}
    for h_id in sorted(installed):
        if _operation_permission_key(args._operation_context, h_id) is None:
            continue
        adapter = pa.select_permission_adapter(args._operation_context, h_id).adapter
        if adapter is None or not hasattr(adapter, "capabilities"):
            continue
        try:
            caps = adapter.capabilities()
        except Exception:
            continue
        out[h_id] = sorted(getattr(f, "value", str(f)) for f in caps)
    if getattr(args, "json", False):
        print(json.dumps(out, indent=2))
    else:
        for h_id, feats in out.items():
            print(f"  {h_id}: {', '.join(feats) or '-'}")


def cmd_permissions_doctor(args):
    _ensure_operation_context(args)
    from skill_hub.domain.diagnostics import risks
    from skill_hub.domain.permissions.permissions import (
        GlobalScope,
        NormalizedPermissions,
        ProjectScope,
        read_sidecar,
        resolve_effective,
    )
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    registry = hub_core.load_registry()
    installed = _operation_harness_ids(args._operation_context, installed=True)

    targets: list[tuple[str, str, "NormalizedPermissions", object]] = []
    global_perms = NormalizedPermissions.from_block(registry.get("permissions_global"))
    for r in global_perms.allow + global_perms.deny + global_perms.ask:
        r.origin = "global"
    for h in global_perms.hooks:
        h.origin = "global"
    for h_id in sorted(installed):
        if _operation_permission_key(args._operation_context, h_id) is None:
            continue
        targets.append(("global", h_id, global_perms, GlobalScope()))
    for proj_name, proj_cfg in (registry.get("projects") or {}).items():
        eff = resolve_effective(proj_cfg, registry)
        eff_harnesses = _operation_effective_harnesses(
            proj_cfg, registry, args._operation_context
        )
        scope_obj = ProjectScope(name=proj_name, path=str(expand(proj_cfg["path"])))
        for h_id in sorted(eff_harnesses):
            targets.append((f"project:{proj_name}", h_id, eff, scope_obj))

    all_findings = []
    danger = 0
    for scope_label, h_id, perms, scope_obj in targets:
        adapter = (
            (
                pa.select_permission_adapter(args._operation_context, h_id).adapter
                if _operation_permission_key(args._operation_context, h_id) is not None
                else None
            )
        )
        caps = adapter.capabilities() if adapter else set()
        findings = risks.detect_risks(perms, caps)

        # Native leg — conflicts in the file's ACTUAL content (user-authored
        # rules included) + index drift recorded by the last apply's strip.
        attached = not (isinstance(scope_obj, ProjectScope) and
                        _project_native_skip_reason(registry, "project", scope_obj.name))
        if attached and adapter is not None and hasattr(adapter, "discover_existing"):
            try:
                discovered = adapter.discover_existing(scope_obj, h_id)
                source_file = ""
                if hasattr(adapter, "target_files"):
                    try:
                        source_file = str(adapter.target_files(scope_obj, h_id))
                    except Exception:
                        source_file = ""
                findings.extend(risks.detect_native_conflicts(discovered, perms, source_file))
                findings.extend(risks.detect_sidecar_drift(read_sidecar(h_id, scope_obj)))
            except Exception:
                pass  # native scan is best-effort; registry findings still land

        for f in findings:
            all_findings.append(
                {
                    "scope": scope_label,
                    "harness": h_id,
                    **f.to_dict(),
                }
            )
            if f.severity == "danger":
                danger += 1

    # Backup leg — harness-independent (the backup repo is one per machine, not
    # one per harness), so it reports with an empty harness slot.
    for f in risks.detect_backup_risks(registry.get("backup")):
        all_findings.append({"scope": "backup", "harness": "", **f.to_dict()})
        if f.severity == "danger":
            danger += 1

    if getattr(args, "json", False):
        print(json.dumps({"findings": all_findings, "danger_count": danger}, indent=2))
    else:
        if not all_findings:
            print(f"{c('✓', GREEN)} no risks detected")
        for f in all_findings:
            colour = RED if f["severity"] == "danger" else YELLOW
            icon = "✗" if f["severity"] == "danger" else "!"
            print(f"{c(icon, colour)} {f['scope']}  [{f['harness']}]  {f['code']} ({f['severity']}): {f['detail']}")

    if danger > 0:
        sys.exit(2)


def _rule_keys(block: Optional[dict]) -> set:
    """`(pattern, kind)` set for the allow/deny/ask rules in a permissions block."""
    from skill_hub.domain.permissions.permissions import NormalizedPermissions

    perms = NormalizedPermissions.from_block(block or {})
    keys = set()
    for kind, rules in (
        ("allow", perms.allow),
        ("deny", perms.deny),
        ("ask", perms.ask),
    ):
        for r in rules:
            keys.add((r.pattern, kind))
    return keys


def _build_migrate_scope_plan(
    registry: dict, apply_flag: bool, operation_context=None
) -> list[dict]:
    """De-duplicate global-sourced hub-managed rules out of project native files (D2).

    For each project Claude-family native file (claude-code, pi) that hub manages
    (has a sidecar), find hub-managed `permissions.{allow,deny,ask}[i]` entries
    whose `(pattern, kind)` is present in the **global** block and absent from the
    project's **own** block, and remove them — the global rule reaches the project
    via the harness's user-level file at runtime, so the project copy is a stale
    duplicate. Backup-first; dry-run unless `apply_flag`. Rules the project owns,
    user-authored (non-hub-managed) rules, and entries that don't cleanly resolve
    are left in place and reported.

    Codex is exempt: its project rules file (`skill-hub.rules`) and `config.toml`
    knobs are scope-targeted by construction, so global rules never landed there.

    Returns a list of per-(project, harness) entry dicts:
    `{scope_label, harness_id, target_file, removed[], kept[], ambiguous[],
      backup_path, applied}`.
    """
    import json as _json
    import re as _re

    from skill_hub.domain.permissions.permissions import ProjectScope, read_sidecar, write_sidecar
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    installed = _operation_harness_ids(operation_context, installed=True)
    # Only Claude-family adapters ever copied global rules into project files.
    claude_harnesses = sorted(
        h_id
        for h_id in installed
        if _operation_permission_key(operation_context, h_id) == "claude"
    )

    global_keys = _rule_keys(registry.get("permissions_global"))

    entries: list[dict] = []
    if not global_keys:
        return entries  # nothing global to de-duplicate against

    for proj_name, proj_cfg in (registry.get("projects") or {}).items():
        proj_path = str(expand(proj_cfg["path"]))
        own_keys = _rule_keys(proj_cfg.get("permissions"))
        scope = ProjectScope(name=proj_name, path=proj_path)
        for h_id in claude_harnesses:
            sc = read_sidecar(h_id, scope)
            if sc is None:
                continue  # hub does not manage this (scope, harness)
            target = Path(sc.file)
            if not target.exists():
                continue
            try:
                data = _json.loads(target.read_text())
            except (OSError, _json.JSONDecodeError):
                continue

            # Group hub-managed permission-rule indices by kind (allow/deny/ask).
            managed_by_kind: dict[str, list[int]] = {}
            ambiguous: list[dict] = []
            for key in sc.managed_keys:
                m = _re.match(r"^permissions\.(allow|deny|ask)\[(\d+)\]$", key)
                if not m:
                    continue  # hooks / additionalDirectories — not rule de-dup
                managed_by_kind.setdefault(m.group(1), []).append(int(m.group(2)))

            removed: list[dict] = []
            kept: list[dict] = []
            # Per kind, decide which hub-managed indices to drop.
            remove_idx_by_kind: dict[str, set] = {}
            for kind, idxs in managed_by_kind.items():
                arr = (data.get("permissions") or {}).get(kind)
                if not isinstance(arr, list):
                    for i in idxs:
                        ambiguous.append(
                            {"key": f"permissions.{kind}[{i}]", "reason": "section missing in native file"}
                        )
                    continue
                drop: set = set()
                for i in idxs:
                    if not (0 <= i < len(arr)):
                        ambiguous.append({"key": f"permissions.{kind}[{i}]", "reason": "index out of range"})
                        continue
                    pattern = arr[i]
                    if not isinstance(pattern, str):
                        ambiguous.append({"key": f"permissions.{kind}[{i}]", "reason": "non-string rule value"})
                        continue
                    rkey = (pattern, kind)
                    if rkey in global_keys and rkey not in own_keys:
                        drop.add(i)
                        removed.append({"pattern": pattern, "kind": kind})
                    else:
                        reason = "also in project's own block" if rkey in own_keys else "not a global-sourced rule"
                        kept.append({"pattern": pattern, "kind": kind, "reason": reason})
                if drop:
                    remove_idx_by_kind[kind] = drop

            backup_path: Optional[Path] = None
            applied = False
            if apply_flag and remove_idx_by_kind:
                backup_path = pa._backup_once_per_session(target, scope, h_id)
                # Remove the dropped entries and recompute sidecar managed_keys
                # so surviving hub-managed rules keep correct indices.
                new_managed_keys: list[str] = []
                # Non-rule managed keys (hooks, additionalDirectories) are
                # untouched — different paths, unaffected by rule deletions.
                for key in sc.managed_keys:
                    if not _re.match(r"^permissions\.(allow|deny|ask)\[(\d+)\]$", key):
                        new_managed_keys.append(key)
                for kind, idxs in managed_by_kind.items():
                    drop = remove_idx_by_kind.get(kind, set())
                    arr = (data.get("permissions") or {}).get(kind)
                    if not isinstance(arr, list):
                        continue
                    # Delete dropped indices (reverse) so earlier indices stay valid.
                    for i in sorted(drop, reverse=True):
                        if 0 <= i < len(arr):
                            del arr[i]
                    pa._maybe_prune_empty(data, ("permissions", kind))
                    # Re-index surviving hub-managed indices for this kind.
                    for j in sorted(set(idxs) - drop):
                        shift = sum(1 for d in drop if d < j)
                        new_managed_keys.append(f"permissions.{kind}[{j - shift}]")
                pa._atomic_replace(target, _json.dumps(data, indent=2) + "\n")
                write_sidecar(h_id, scope, new_managed_keys, target)
                applied = True

            if removed or ambiguous:
                entries.append(
                    {
                        "scope_label": proj_name,
                        "harness_id": h_id,
                        "target_file": str(target),
                        "removed": removed,
                        "kept": kept,
                        "ambiguous": ambiguous,
                        "backup_path": str(backup_path) if backup_path else None,
                        "applied": applied,
                    }
                )
    return entries


@registry_mutation("permissions-migrate-scope")
def cmd_permissions_migrate_scope(args):
    """`hub permissions migrate-scope` — strip global-sourced duplicates from
    project native files (D2). Dry-run by default; `--apply` to commit."""
    _ensure_operation_context(args)
    apply_flag = bool(getattr(args, "apply", False))
    json_out = bool(getattr(args, "json", False))

    registry = hub_core.load_registry()
    entries = _build_migrate_scope_plan(registry, apply_flag, args._operation_context)

    if json_out:
        print(json.dumps({"apply": apply_flag, "entries": entries}, indent=2))
        return

    label = "APPLY" if apply_flag else "DRY RUN"
    print(f"\n{c(f'hub permissions migrate-scope — {label}', BOLD)}\n")
    if not entries:
        print(f"  {c('✓', GREEN)} no global-sourced duplicates found in project files\n")
        return
    total_removed = 0
    for e in entries:
        total_removed += len(e["removed"])
        print(f"  {c(e['scope_label'], BOLD)}  [{e['harness_id']}]  {e['target_file']}")
        for r in e["removed"]:
            verb = "removed" if e["applied"] else "would remove"
            print(f"      {c('−', YELLOW)} {verb} {r['kind']}: {r['pattern']}")
        for a in e["ambiguous"]:
            print(f"      {c('?', DIM)} left in place: {a['key']} ({a['reason']})")
        if e["backup_path"]:
            print(f"      {c('backup:', DIM)} {e['backup_path']}")
    print()
    if apply_flag:
        print(f"{c('✓', GREEN, BOLD)} removed {total_removed} duplicate rule(s)\n")
    else:
        msg = f"(dry-run — {total_removed} rule(s) would be removed; pass --apply to commit)"
        print(f"{c(msg, DIM)}\n")


def _project_files_have_global_duplicates(registry: dict, operation_context=None) -> bool:
    """First-post-upgrade detection (D2): True if any project native file still
    contains a hub-managed rule that is global-sourced and not project-owned."""
    try:
        return bool(
            _build_migrate_scope_plan(
                registry, apply_flag=False, operation_context=operation_context
            )
        )
    except Exception:
        return False


def _build_disable_entries(args, registry, mode: str, apply_flag: bool):
    """Resolve `hub permissions disable` targets into a list of structured entry dicts.

    Each entry: `{scope_kind, scope_label, harness_id, target_file, backup_path,
    sidecar_path, action, will_write, applied}` where `action ∈ {"restore",
    "detach", "clear"}`. Mutates `registry` in place when `apply_flag` is True.
    Caller is responsible for `save_registry(registry)` after.
    """
    from skill_hub.domain.permissions.permissions import (
        GlobalScope,
        ProjectScope,
        delete_sidecar,
        read_sidecar,
        sidecar_path,
        write_sidecar,
    )
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    installed = _operation_harness_ids(args._operation_context, installed=True)
    h_filter = getattr(args, "harness", None)

    def harness_ids() -> list[str]:
        ids = sorted(
            h_id
            for h_id in installed
            if _operation_permission_key(args._operation_context, h_id) is not None
        )
        if h_filter:
            ids = [h_id for h_id in ids if h_id == h_filter]
        return ids

    targets: list[tuple[str, Any, list[str]]] = []
    if getattr(args, "all", False):
        targets.append(("global", GlobalScope(), harness_ids()))
        for proj_name, proj_cfg in (registry.get("projects") or {}).items():
            proj_path = str(expand(proj_cfg["path"]))
            targets.append(("project", ProjectScope(name=proj_name, path=proj_path), harness_ids()))
    elif getattr(args, "global_", False):
        targets.append(("global", GlobalScope(), harness_ids()))
    elif getattr(args, "project", None):
        proj_name = args.project
        if proj_name not in registry.get("projects", {}):
            fail(f"unknown project: {proj_name}")
        proj_cfg = registry["projects"][proj_name]
        proj_path = str(expand(proj_cfg["path"]))
        targets.append(("project", ProjectScope(name=proj_name, path=proj_path), harness_ids()))
    else:
        fail("specify --all, --global, or --project <name>")

    entries: list[dict] = []
    for scope_kind, scope, h_ids in targets:
        scope_label = "global" if scope_kind == "global" else scope.name
        for h_id in h_ids:
            adapter = pa.select_permission_adapter(args._operation_context, h_id).adapter
            if adapter is None:
                continue
            sc = read_sidecar(h_id, scope)
            target_file = None
            if hasattr(adapter, "target_files"):
                try:
                    target_file = adapter.target_files(scope, h_id)
                except Exception:
                    target_file = None
            sidecar_loc = sidecar_path(h_id, scope)
            backup_path: Optional[Path] = None
            action: str
            if mode == "restore":
                backup_dir = pa._backups_root() / h_id / scope.slug
                if backup_dir.exists():
                    backups = sorted(backup_dir.iterdir())
                    # Prefer a backup matching the primary target's extension
                    # (Codex backs up both config.toml and skill-hub.rules into
                    # the same dir; restore must not cross-restore them).
                    if target_file is not None:
                        suffixed = [b for b in backups if b.suffix == target_file.suffix]
                        if suffixed:
                            backups = suffixed
                    if backups:
                        backup_path = backups[-1]
                action = "restore"
                rules_sc_present = read_sidecar(h_id, scope, kind="rules") is not None
                has_claim = sc is not None or rules_sc_present
                no_backup = backup_path is None
                # Restore writes when a backup can be reinstated; with no backup
                # we still surgically strip hub-managed keys (incl. Codex
                # trust_level) so registry and native files don't diverge.
                will_write = target_file is not None and (backup_path is not None or has_claim)
            else:
                # detach: drop hub's sidecar claim, leave native files untouched
                action = "detach"
                will_write = False  # native files are NOT written on detach
                no_backup = False

            entry = {
                "scope_kind": scope_kind,
                "scope_label": scope_label,
                "harness_id": h_id,
                "target_file": str(target_file) if target_file else None,
                "backup_path": str(backup_path) if backup_path else None,
                "sidecar_path": str(sidecar_loc),
                "action": action,
                "will_write": bool(will_write),
                "no_backup": bool(no_backup) if mode == "restore" else False,
                "applied": False,
            }

            if apply_flag:
                if mode == "restore":
                    if backup_path is not None and target_file is not None:
                        # Pre-hub backup exists → revert the primary target to
                        # it. Because the backup predates hub, this also drops
                        # any hub-granted trust_level / rule lines naturally.
                        target_file.parent.mkdir(parents=True, exist_ok=True)
                        _shutil_copy_atomic(backup_path, target_file)
                        if sidecar_loc.exists():
                            delete_sidecar(h_id, scope)
                        # Tear down any hub-owned rules file (Codex
                        # skill-hub.rules): it is fully hub-generated, so
                        # restore = delete it.
                        rules_sc = read_sidecar(h_id, scope, kind="rules")
                        if rules_sc is not None:
                            rules_file = Path(rules_sc.file)
                            if rules_file.exists():
                                try:
                                    rules_file.unlink()
                                except OSError:
                                    pass
                            delete_sidecar(h_id, scope, kind="rules")
                    else:
                        # No pre-hub backup — we can't revert to a prior file,
                        # but leaving hub's managed keys (Codex trust_level, hub
                        # rule lines) in place would leave native files and the
                        # registry in disagreement. Surgically strip every
                        # hub-managed key via the adapter's cleanup (which also
                        # removes the hub-owned rules file and its sidecars).
                        try:
                            adapter.cleanup(scope, h_id)
                        except Exception:
                            pass
                        # Belt-and-suspenders: ensure sidecars are gone even if
                        # cleanup found nothing to strip.
                        if sidecar_loc.exists():
                            delete_sidecar(h_id, scope)
                        if read_sidecar(h_id, scope, kind="rules") is not None:
                            delete_sidecar(h_id, scope, kind="rules")
                else:
                    if sc is not None:
                        write_sidecar(h_id, scope, [], target_file or Path(sc.file))
                    delete_sidecar(h_id, scope)

                # Mutate registry: drop block content, mark unmanaged
                if scope_kind == "global":
                    blk = registry.setdefault("permissions_global", {})
                else:
                    blk = registry["projects"][scope.name].setdefault("permissions", {})
                for key in (
                    "allow",
                    "deny",
                    "ask",
                    "hooks",
                    "additional_dirs",
                    "extras",
                    "sandbox_mode",
                    "approval_policy",
                    "project_trust",
                ):
                    blk.pop(key, None)
                unmanaged = list(blk.get("_unmanaged") or [])
                if h_id not in unmanaged:
                    unmanaged.append(h_id)
                blk["_unmanaged"] = unmanaged
                entry["applied"] = True

            entries.append(entry)
    return entries


@registry_mutation("permissions-disable")
def cmd_permissions_disable(args):
    _ensure_operation_context(args)
    mode = args.mode
    if mode not in {"restore", "detach"}:
        fail(f"--mode must be restore|detach, got {mode!r}")
    apply_flag = bool(getattr(args, "apply", False))
    json_out = bool(getattr(args, "json", False))

    registry = hub_core.load_registry()
    entries = _build_disable_entries(args, registry, mode, apply_flag)
    if apply_flag:
        hub_core.save_registry(registry)

    if json_out:
        print(json.dumps({"mode": mode, "apply": apply_flag, "entries": entries}, indent=2))
        return

    label = "DRY RUN" if not apply_flag else "APPLY"
    print(f"\n{c(f'hub permissions disable ({mode}) — {label}', BOLD)}\n")
    for e in entries:
        harness_label = e["harness_id"]
        if e["action"] == "restore":
            if e.get("no_backup"):
                no_backup_note = c(
                    "no pre-hub backup — will strip hub-managed keys (incl. Codex trust) in place",
                    YELLOW,
                )
                print(
                    f"  {e['scope_label']} [{harness_label}]  "
                    f"target={e['target_file']}  {no_backup_note}  "
                    f"sidecar={e['sidecar_path']}"
                )
            else:
                print(
                    f"  {e['scope_label']} [{harness_label}]  "
                    f"target={e['target_file']}  backup={e['backup_path']}  "
                    f"sidecar={e['sidecar_path']}"
                )
        else:
            print(
                f"  {e['scope_label']} [{harness_label}]  "
                f"detach — drop hub claim, leave native files as-is, "
                f"clear registry block, delete sidecar={e['sidecar_path']}"
            )
    if apply_flag:
        print(f"\n{c('✓ disabled', GREEN, BOLD)}\n")
    else:
        print(f"\n{c('(dry-run — pass --apply to commit)', DIM)}\n")


# ─────────────────────────────────────────────────────────────────────────────
# hub permissions presets ...
# ─────────────────────────────────────────────────────────────────────────────


def cmd_permissions_presets_list(args):
    from skill_hub.domain.permissions.permission_presets import all_presets

    registry = hub_core.load_registry()
    presets = all_presets(registry)
    if getattr(args, "json", False):
        print(
            json.dumps(
                [
                    {
                        "id": p.id,
                        "name": p.name,
                        "description": p.description,
                        "icon": p.icon,
                        "category": p.category,
                        "builtin": p.builtin,
                        "rule_count": len(p.rules),
                    }
                    for p in presets
                ],
                indent=2,
            )
        )
        return

    print(f"\n{c('Permission Presets', BOLD)}\n")
    for p in presets:
        label = c("builtin", DIM) if p.builtin else c("custom", CYAN)
        rule_word = "rule" if len(p.rules) == 1 else "rules"
        print(f"  {p.icon} {c(p.id, BOLD)}  ({len(p.rules)} {rule_word}, {label})")
        if p.description:
            print(f"      {c(p.description, DIM)}")
    print()


def cmd_permissions_presets_show(args):
    from skill_hub.domain.permissions.permission_presets import get_preset

    registry = hub_core.load_registry()
    preset = get_preset(args.id, registry)
    if preset is None:
        fail(f"unknown preset: {args.id}")

    if getattr(args, "json", False):
        print(json.dumps(preset.to_dict(), indent=2))
        return

    label = "builtin" if preset.builtin else "custom"
    print(f"\n{preset.icon} {c(preset.name, BOLD)}  {c('(' + label + ')', DIM)}")
    if preset.description:
        print(f"  {c(preset.description, DIM)}")
    print(f"  {c('category:', DIM)} {preset.category}")
    print()
    for r in preset.rules:
        flag = c("default", GREEN) if r.enabled_by_default else c("off", DIM)
        print(f"  [{flag}] {c(r.pattern, BOLD)}  {c(r.kind, DIM)}")
        if r.description:
            print(f"          {c(r.description, DIM)}")
    print()


@registry_mutation("permissions-presets-apply")
def cmd_permissions_presets_apply(args):
    import hub
    from skill_hub.domain.permissions.permission_presets import apply_preset, get_preset

    registry = hub_core.load_registry()
    preset = get_preset(args.id, registry)
    if preset is None:
        fail(f"unknown preset: {args.id}")

    proj_name = args.project
    if proj_name not in (registry.get("projects") or {}):
        fail(f"unknown project: {proj_name}")

    enabled_patterns: Optional[list[str]] = None
    if getattr(args, "rules", None):
        enabled_patterns = parse_csv(args.rules)

    proj_cfg = registry["projects"][proj_name]
    block = proj_cfg.setdefault("permissions", {})
    existing = list(block.get("allow") or [])
    before = len(existing)
    new_allow = apply_preset(preset, enabled_patterns, existing)
    block["allow"] = new_allow
    added = len(new_allow) - before
    hub_core.save_registry(registry)

    if getattr(args, "json", False):
        print(
            json.dumps(
                {
                    "preset": preset.id,
                    "project": proj_name,
                    "added": added,
                    "total": len(new_allow),
                },
                indent=2,
            )
        )
        # Keep stdout a pure JSON payload for strict parsers — the auto-sync
        # chatter goes to stderr.
        with contextlib.redirect_stdout(sys.stderr):
            hub._auto_sync_tail()
    else:
        word = "rule" if added == 1 else "rules"
        print(
            f"{c('✓', GREEN)} applied {c(preset.id, BOLD)} → {c(proj_name, BOLD)}: "
            f"added {added} {word} ({len(new_allow)} total in allow)"
        )
        hub._auto_sync_tail()


def _require_user_preset_id(args_id: str) -> str:
    from skill_hub.domain.permissions.permission_presets import is_builtin

    if is_builtin(args_id):
        fail(f"{args_id!r} is a built-in preset — built-ins cannot be modified or deleted")
    if not SLUG_RE.match(args_id):
        fail(f"preset id must be a slug (lowercase letters, digits, hyphens): {args_id!r}")
    return args_id


def cmd_permissions_presets_new(args):
    preset_id = _require_user_preset_id(args.id)
    registry = hub_core.load_registry()
    block = registry.setdefault("permission_presets", {}) or {}
    if not isinstance(block, dict):
        block = {}
        registry["permission_presets"] = block
    if preset_id in block:
        fail(f"preset already exists: {preset_id}")
    block[preset_id] = {
        "name": args.name,
        "description": args.description or "",
        "icon": args.icon or "📦",
        "category": args.category or "custom",
        "rules": [],
    }
    registry["permission_presets"] = block
    hub_core.save_registry(registry)
    print(f"{c('✓', GREEN)} created preset {c(preset_id, BOLD)}")


def cmd_permissions_presets_update(args):
    preset_id = _require_user_preset_id(args.id)
    registry = hub_core.load_registry()
    block = registry.get("permission_presets") or {}
    if not isinstance(block, dict) or preset_id not in block:
        fail(f"unknown user preset: {preset_id}")
    entry = block[preset_id]
    if not isinstance(entry, dict):
        fail(f"corrupt preset entry for {preset_id}")

    if args.name is not None:
        entry["name"] = args.name
    if args.description is not None:
        entry["description"] = args.description
    if args.icon is not None:
        entry["icon"] = args.icon

    rules = list(entry.get("rules") or [])
    # Index by pattern for add/remove operations.
    by_pattern: dict[str, dict] = {}
    for r in rules:
        if isinstance(r, dict):
            by_pattern[str(r.get("pattern", ""))] = r

    remove_patterns = set(getattr(args, "remove_rule", None) or [])
    for pat in remove_patterns:
        by_pattern.pop(pat, None)

    add_patterns = list(getattr(args, "add_rule", None) or [])
    for pat in add_patterns:
        if pat in by_pattern:
            continue
        by_pattern[pat] = {
            "pattern": pat,
            "kind": "allow",
            "description": "",
            "enabled_by_default": True,
        }

    # Preserve original ordering for kept rules, then append new patterns.
    new_rules: list[dict] = []
    seen: set[str] = set()
    for r in rules:
        if not isinstance(r, dict):
            continue
        pat = str(r.get("pattern", ""))
        if pat in remove_patterns or pat in seen:
            continue
        if pat in by_pattern:
            new_rules.append(by_pattern[pat])
            seen.add(pat)
    for pat in add_patterns:
        if pat in seen:
            continue
        new_rules.append(by_pattern[pat])
        seen.add(pat)

    entry["rules"] = new_rules
    block[preset_id] = entry
    registry["permission_presets"] = block
    hub_core.save_registry(registry)
    print(f"{c('✓', GREEN)} updated preset {c(preset_id, BOLD)} ({len(new_rules)} rules)")


def cmd_permissions_presets_delete(args):
    preset_id = _require_user_preset_id(args.id)
    registry = hub_core.load_registry()
    block = registry.get("permission_presets") or {}
    if not isinstance(block, dict) or preset_id not in block:
        fail(f"unknown user preset: {preset_id}")
    del block[preset_id]
    if not block:
        registry.pop("permission_presets", None)
    else:
        registry["permission_presets"] = block
    hub_core.save_registry(registry)
    print(f"{c('✓', GREEN)} deleted preset {c(preset_id, BOLD)}")


def _shutil_copy_atomic(src: Path, dst: Path) -> None:
    """Copy src → dst atomically by writing to a temp sibling and replacing."""
    import shutil as _sh

    dst.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=dst.name + ".", suffix=".tmp", dir=str(dst.parent))
    try:
        os.close(fd)
        _sh.copy2(src, tmp_name)
        os.replace(tmp_name, dst)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
