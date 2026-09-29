"""The permissions sync stream: registry block canonicalisation, the duplicate
detector, the managed-before snapshot and the per-scope adapter dispatch.

Cut verbatim out of hub.py (wave 23e of AUDIT.md). Not a leaf:
`_run_permissions_stream` reads `project_sync_skip_reason` (hub.py until wave
23g) and `_project_files_have_global_duplicates` (skill_hub.entrypoints.cli.permissions,
re-exported by hub.py) through a function-local `import hub` — call-time
reads, so a `hub.<name>` stub still lands. Module scope imports hub_core only;
the `permissions` / `permission_adapters` imports stay function-local as they
were. hub.py re-imports every name so `hub.<name>` keeps resolving — the
`monkeypatch.setattr(hub, "_run_permissions_stream", …)` stubs keep landing
because the only caller, `_cmd_sync_body`, stays in hub.py, and
hub_cli/permissions.py + hub_cli/bootstrap.py read seven of these names as
`hub.<name>`.

Stub visibility: a call from one function here to another resolves through
this module, so `monkeypatch.setattr(hub, "<name>", …)` no longer reaches it.
No test stubs any of the nine today; one that needs to patches
`permissions_stream.<name>`.
"""

import json
from pathlib import Path
from typing import Optional

from skill_hub.hub_core import BOLD, CYAN, DIM, GREEN, RED, YELLOW, c, expand


def _operation_harness_ids(operation_context, installed=None) -> set[str]:
    if operation_context is not None:
        return set(operation_context.installed_harness_ids or ())
    return set(installed or ())


def _operation_permission_key(operation_context, harness_id: str):
    if operation_context is not None:
        layout = operation_context.layout(harness_id)
        return layout.permission_adapter_key if layout is not None else None
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    harness = _harnesses.HARNESSES.get(harness_id)
    return harness.permission_adapter_key if harness is not None else None


def _operation_harness_label(operation_context, harness_id: str) -> str:
    if operation_context is not None:
        return harness_id
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    harness = _harnesses.HARNESSES.get(harness_id)
    return harness.label if harness is not None else harness_id


def _operation_effective_harnesses(
    project_cfg, registry, operation_context, installed
):
    if operation_context is not None and hasattr(operation_context, "effective_harness_ids"):
        return set(operation_context.effective_harness_ids(project_cfg, registry))
    requested = set(registry.get("harnesses_global") or []) | set(
        project_cfg.get("harnesses") or []
    )
    available = (
        set(operation_context.installed_harness_ids or ())
        if operation_context is not None
        else set(installed)
    )
    if operation_context is None:
        from skill_hub.infrastructure.harnesses import harnesses as _harnesses

        return _harnesses.resolve_effective(project_cfg, registry, installed=available)
    return {
        harness_id
        for harness_id in requested & available
        if _operation_permission_key(operation_context, harness_id) is not None
    }


def _requested_worktree_harnesses(project_cfg, registry) -> set[str]:
    return set(registry.get("harnesses_global") or []) | set(project_cfg.get("harnesses") or [])


def _directory_contributions(project_cfg, personal, harness_id):
    from skill_hub.domain.permissions.permission_adapter_base import DirectoryContribution

    block = project_cfg.get("permissions_local" if personal else "permissions") or {}
    out = []
    dirs = tuple(dict.fromkeys(str(p) for p in (block.get("additional_dirs") or []) if str(p)))
    if dirs:
        out.append(DirectoryContribution("generic:personal" if personal else "generic:shared", dirs))
    if not personal:
        wt = block.get("worktree_access") or {}
        if wt.get("enabled") and wt.get("path"):
            out.append(DirectoryContribution("worktree", (str(wt["path"]),)))
    return tuple(out)


def _sync_project_directories(
    project_name,
    project_cfg,
    project_path,
    registry,
    installed,
    report,
    operation_context=None,
):
    from skill_hub.domain.permissions.permission_adapter_base import WorktreeAccessStatus
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    statuses = []
    available_installed = (
        set(operation_context.installed_harness_ids or ())
        if operation_context is not None
        else set(installed)
    )
    for h_id in sorted(_requested_worktree_harnesses(project_cfg, registry)):
        permission_key = _operation_permission_key(operation_context, h_id)
        unmanaged = set((project_cfg.get("permissions") or {}).get("_unmanaged") or []) | set(
            (registry.get("permissions_global") or {}).get("_unmanaged") or []
        )
        if h_id in unmanaged:
            statuses.append(
                WorktreeAccessStatus(
                    h_id,
                    "unmanaged",
                    "not_applicable",
                    None,
                    reason_code="UNMANAGED_HARNESS",
                    reason="This harness is unmanaged for this project.",
                )
            )
            continue
        if h_id not in available_installed:
            statuses.append(WorktreeAccessStatus(h_id, "not_installed", "not_applicable", None))
            continue
        if permission_key not in {"claude", "codex"}:
            statuses.append(
                WorktreeAccessStatus(
                    h_id,
                    "unsupported",
                    "not_applicable",
                    None,
                    reason_code="UNSUPPORTED_HARNESS",
                    reason="This harness does not support project directory grants.",
                )
            )
            continue
        adapter = pa.select_permission_adapter(operation_context, h_id).adapter
        if adapter is None:
            continue
        from skill_hub.domain.permissions.permissions import ProjectScope

        shared_scope = ProjectScope(name=project_name, path=str(project_path))
        shared_contributions = _directory_contributions(project_cfg, False, h_id)
        if permission_key == "claude":
            shared_contributions = tuple(c for c in shared_contributions if c.id == "generic:shared")
        shared_plan = adapter.plan_directories(shared_scope, shared_contributions, h_id)
        shared_status = adapter.apply_directories(shared_scope, shared_plan, h_id)
        if permission_key == "claude":
            personal_scope = ProjectScope(name=project_name, path=str(project_path), personal=True)
            personal_contributions = _directory_contributions(project_cfg, True, h_id) + tuple(
                c for c in _directory_contributions(project_cfg, False, h_id) if c.id == "worktree"
            )
            personal_plan = adapter.plan_directories(personal_scope, personal_contributions, h_id)
            personal_status = adapter.apply_directories(personal_scope, personal_plan, h_id)
            status = personal_status if personal_status.config_state != "unmanaged" else shared_status
            if shared_status.config_state == "failed":
                status = shared_status
        else:
            status = shared_status
        statuses.append(status)
    requested_worktree_path = (
        ((project_cfg.get("permissions") or {}).get("worktree_access") or {}).get("path")
        if ((project_cfg.get("permissions") or {}).get("worktree_access") or {}).get("enabled")
        else None
    )
    if report is not None:
        report.setdefault("projects", {}).setdefault(project_name, {})["worktree_access"] = {
            "requested_path": requested_worktree_path,
            "missing_parent": bool(requested_worktree_path and not Path(str(requested_worktree_path)).exists()),
            "harnesses": [s.__dict__ for s in statuses],
        }
        failures = [s for s in statuses if s.config_state == "failed"]
        if failures:
            report.setdefault("global", {}).setdefault("permissions", {}).setdefault("errors", []).extend(
                {"stage": "directories", "message": s.reason or s.reason_code or "directory reconciliation failed"}
                for s in failures
            )
    return statuses


def _cleanup_project_worktree_access(old_scope, harness_ids, operation_context=None):
    from skill_hub.domain.permissions.permission_adapter_base import apply_directory_cleanup, plan_directory_cleanup
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    out = []
    for h_id in harness_ids:
        adapter = pa.select_permission_adapter(operation_context, h_id).adapter
        if adapter is None or not hasattr(adapter, "directory_cleanup_endpoint"):
            continue
        scopes = [old_scope]
        if h_id == "claude-code":
            from skill_hub.domain.permissions.permissions import ProjectScope

            scopes.append(ProjectScope(old_scope.name, old_scope.path, personal=True))
        for scope in scopes:
            out.append(apply_directory_cleanup(adapter, plan_directory_cleanup(adapter, scope, h_id)))
    return out


def _cleanup_orphaned_directory_ledgers(registry, installed, operation_context=None):
    from skill_hub.domain.permissions import permissions as _permissions
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    projects = registry.get("projects") or {}
    root = _permissions._state_root()
    results = []
    if not root.exists():
        return results
    for harness_dir in root.iterdir():
        if not harness_dir.is_dir():
            continue
        harness_id = harness_dir.name
        for sidecar in harness_dir.glob("directory-v1-*.managed.json"):
            try:
                state = _permissions.SidecarState.from_dict(json.loads(sidecar.read_text()))
                identity = _permissions.DirectoryLedgerIdentity.from_dict(state.directory_ledger["identity"])
            except (OSError, ValueError, json.JSONDecodeError, KeyError, TypeError) as exc:
                from skill_hub.domain.permissions.permission_adapter_base import WorktreeAccessStatus

                results.append(
                    WorktreeAccessStatus(
                        harness_id,
                        "failed",
                        "not_applicable",
                        str(sidecar),
                        reason_code="DIRECTORY_LEDGER_INVALID",
                        reason=str(exc),
                    )
                )
                continue
            expected_sidecar = _permissions.directory_sidecar_path(harness_id, identity)
            if expected_sidecar.resolve(strict=False) != sidecar.resolve(strict=False):
                from skill_hub.domain.permissions.permission_adapter_base import WorktreeAccessStatus

                results.append(
                    WorktreeAccessStatus(
                        harness_id,
                        "failed",
                        "not_applicable",
                        str(sidecar),
                        reason_code="DIRECTORY_LEDGER_INVALID",
                        reason="directory ledger filename does not match its identity",
                    )
                )
                continue
            if identity.scope_kind not in {"project", "global"} or identity.harness != harness_id:
                from skill_hub.domain.permissions.permission_adapter_base import WorktreeAccessStatus

                results.append(
                    WorktreeAccessStatus(
                        harness_id,
                        "failed",
                        "not_applicable",
                        str(sidecar),
                        reason_code="DIRECTORY_LEDGER_INVALID",
                        reason="directory identity is not a project identity",
                    )
                )
                continue
            if identity.scope_kind == "global":
                # The global pass handles valid global ledgers, including an
                # empty desired request. The project orphan sweep must not
                # report or mutate them.
                continue
            name = identity.project_name
            project_path = Path(identity.project_path or "")
            cfg = projects.get(name)
            if isinstance(cfg, dict):
                requested = set(registry.get("harnesses_global") or []) | set(cfg.get("harnesses") or [])
                current_path = Path(str(cfg.get("path", ""))).expanduser().resolve(strict=False)
                if harness_id in requested and current_path == project_path:
                    continue
            adapter = pa.select_permission_adapter(operation_context, harness_id).adapter
            if adapter is None:
                continue
            scope = _permissions.ProjectScope(name=name, path=str(project_path), personal=identity.personal)
            from skill_hub.domain.permissions.permission_adapter_base import (
                apply_directory_cleanup,
                plan_directory_cleanup,
            )

            plan = plan_directory_cleanup(adapter, scope, harness_id)
            result = apply_directory_cleanup(adapter, plan)
            results.append(result)
    return results


# ─────────────────────────────────────────────────────────────────────────────
# Permissions sync stream
# ─────────────────────────────────────────────────────────────────────────────


def _serialize_perms_block(perms) -> dict:
    """Convert a NormalizedPermissions back to a plain registry block (no origin).

    `NormalizedPermissions.from_block()` canonicalizes duplicate rules/hooks, so
    serializing a parsed block also acts as the registry cleanup path for older
    duplicate imports.
    """

    def rule_dict(r):
        out = {"pattern": r.pattern, "kind": r.kind}
        if r.harnesses is not None:
            out["harnesses"] = list(r.harnesses)
        return out

    def hook_dict(h):
        out = {"event": h.event, "matcher": h.matcher, "command": h.command}
        if h.harnesses is not None:
            out["harnesses"] = list(h.harnesses)
        return out

    block: dict = {}

    def dedupe_rules(rules):
        seen = set()
        out = []
        for r in rules:
            harnesses = None if r.harnesses is None else tuple(sorted(str(h) for h in r.harnesses))
            key = (r.kind, r.pattern, harnesses)
            if key in seen:
                continue
            seen.add(key)
            out.append(r)
        return out

    def dedupe_hooks(hooks):
        seen = set()
        out = []
        for h in hooks:
            harnesses = None if h.harnesses is None else tuple(sorted(str(v) for v in h.harnesses))
            key = (h.event, h.matcher, h.command, harnesses)
            if key in seen:
                continue
            seen.add(key)
            out.append(h)
        return out

    allow = dedupe_rules(perms.allow)
    deny = dedupe_rules(perms.deny)
    ask = dedupe_rules(perms.ask)
    hooks = dedupe_hooks(perms.hooks)
    if allow:
        block["allow"] = [rule_dict(r) for r in allow]
    if deny:
        block["deny"] = [rule_dict(r) for r in deny]
    if ask:
        block["ask"] = [rule_dict(r) for r in ask]
    if hooks:
        block["hooks"] = [hook_dict(h) for h in hooks]
    if perms.sandbox_mode is not None:
        block["sandbox_mode"] = perms.sandbox_mode
    if perms.approval_policy is not None:
        block["approval_policy"] = perms.approval_policy
    if perms.project_trust is not None:
        block["project_trust"] = perms.project_trust
    if perms.additional_dirs:
        block["additional_dirs"] = list(perms.additional_dirs)
    if perms.extras:
        block["extras"] = dict(perms.extras)
    if perms.worktree_access is not None:
        block["worktree_access"] = dict(perms.worktree_access)
    return block


def _canonicalize_permissions_block(block) -> tuple[dict, bool]:
    """Return a deduped canonical permissions block and whether it changed."""
    from skill_hub.domain.permissions.permissions import NormalizedPermissions

    current = block if isinstance(block, dict) else {}
    canonical = _serialize_perms_block(NormalizedPermissions.from_block(current))
    unmanaged = list(current.get("_unmanaged") or [])
    if unmanaged:
        canonical["_unmanaged"] = unmanaged
    return canonical, canonical != current


def _permissions_duplicate_count(block) -> int:
    current = block if isinstance(block, dict) else {}
    canonical, _changed = _canonicalize_permissions_block(current)
    before = sum(len(current.get(k) or []) for k in ("allow", "deny", "ask", "hooks"))
    after = sum(len(canonical.get(k) or []) for k in ("allow", "deny", "ask", "hooks"))
    return max(0, before - after)


def _dedupe_registry_permissions(registry: dict) -> bool:
    """Collapse duplicate permission entries in global and project blocks."""
    mutated = False
    canonical, changed = _canonicalize_permissions_block(registry.get("permissions_global") or {})
    if changed:
        registry["permissions_global"] = canonical
        mutated = True
    for proj_cfg in (registry.get("projects") or {}).values():
        if not isinstance(proj_cfg, dict):
            continue
        canonical, changed = _canonicalize_permissions_block(proj_cfg.get("permissions") or {})
        if changed:
            proj_cfg["permissions"] = canonical
            mutated = True
    return mutated


def _has_any_managed_perms(block) -> bool:
    if not block:
        return False
    if not isinstance(block, dict):
        return False
    for key in ("allow", "deny", "ask", "hooks", "additional_dirs"):
        if block.get(key):
            return True
    for key in ("sandbox_mode", "approval_policy", "project_trust"):
        if block.get(key) is not None:
            return True
    if block.get("extras"):
        return True
    if block.get("worktree_access"):
        return True
    return False


def _unmanaged_list(block) -> list:
    if not isinstance(block, dict):
        return []
    return list(block.get("_unmanaged") or [])


def _scope_managed_before(harness_id: str, scope) -> bool:
    """Whether hub has previously written managed permissions for (harness, scope).

    Distinguishes genuine first-contact adoption from a deliberate registry-side
    delete. Once any sidecar (primary OR rules-kind) exists, an empty registry
    block is a deliberate delete — not re-imported. This prevents the rules-only
    Codex case (rules sidecar exists but no config sidecar) from boomeranging.
    """
    from skill_hub.domain.permissions import permissions as _perms

    return (
        _perms.sidecar_path(harness_id, scope).exists() or _perms.sidecar_path(harness_id, scope, kind="rules").exists()
    )


def _run_permissions_stream(
    registry: dict,
    projects: dict,
    installed: set[str],
    _harnesses,
    report: Optional[dict] = None,
    doctor_targets: Optional[list] = None,
    operation_context=None,
) -> int:
    """Permissions sync stream — global pass + per-project pass.

    The doctor rollup is NO LONGER run here (hooks-surface task 2.4): it was
    lifted to `_run_doctor_rollup`, a shared post-streams stage covering BOTH the
    permissions and the hooks streams. This function collects its risk-scan
    targets into the caller-provided `doctor_targets` list (tuples of
    `(scope_label, harness_id, NormalizedPermissions)`) and returns a non-zero
    exit code ONLY when an adapter errored. Per-(scope, harness) errors do not
    stop the stream.
    """
    import hub

    perm_errors: list[dict] = []
    active_installed = (
        _operation_harness_ids(operation_context, installed)
        if operation_context is not None
        else set(installed)
    )

    orphan_statuses = _cleanup_orphaned_directory_ledgers(
        registry, active_installed, operation_context
    )

    def _perm_err(stage: str, message: str) -> None:
        perm_errors.append({"stage": stage, "message": message})

    from skill_hub.domain.permissions.permissions import (
        GlobalScope,
        NormalizedPermissions,
        ProjectScope,
        resolve_effective,
        resolve_project_local_own,
        resolve_project_own,
    )
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    print(f"\n{c('Permissions:', BOLD)}")

    if _dedupe_registry_permissions(registry):
        print(f"  {c('↧', CYAN)} collapsed duplicate permission rules in registry")

    any_error = False
    if any(s.config_state == "failed" for s in orphan_statuses):
        any_error = True
        perm_errors.extend(
            {"stage": "orphan-directories", "message": s.reason or s.reason_code}
            for s in orphan_statuses
            if s.config_state == "failed"
        )
    if doctor_targets is None:
        doctor_targets = []
    blocked_global_harnesses: list[str] = []

    # ── Global pass ────────────────────────────────────────────────────────
    global_perms_block = registry.get("permissions_global") or {}
    if global_perms_block.get("worktree_access") is not None:
        print("  worktree_access is project-only; global permissions were not changed")
        global_perms_block = {k: v for k, v in global_perms_block.items() if k != "worktree_access"}
    global_perms = NormalizedPermissions.from_block(global_perms_block)
    # Attach origin GLOBAL for everything so doctor finds them with provenance.
    for r in global_perms.allow + global_perms.deny + global_perms.ask:
        r.origin = "global"
    for h in global_perms.hooks:
        h.origin = "global"

    for h_id in sorted(active_installed):
        permission_key = _operation_permission_key(operation_context, h_id)
        if permission_key is None:
            continue
        label = _operation_harness_label(operation_context, h_id)
        if h_id in _unmanaged_list(global_perms_block):
            print(f"  {c('·', DIM)} global  [{label}] unmanaged — skipped")
            continue
        adapter = pa.select_permission_adapter(operation_context, h_id).adapter
        if adapter is None:
            continue
        scope = GlobalScope()

        from skill_hub.domain.permissions.permissions import DirectoryLedgerIdentity, directory_sidecar_path

        directory_ledger_exists = directory_sidecar_path(h_id, DirectoryLedgerIdentity.from_scope(scope, h_id)).exists()
        if (global_perms.additional_dirs or directory_ledger_exists) and hasattr(adapter, "plan_directories"):
            from skill_hub.domain.permissions.permission_adapter_base import DirectoryContribution

            dplan = adapter.plan_directories(
                scope,
                (DirectoryContribution("generic:global", tuple(global_perms.additional_dirs)),),
                h_id,
            )
            dstatus = adapter.apply_directories(scope, dplan, h_id)
            if dstatus.config_state == "failed":
                any_error = True
                _perm_err(
                    "permissions",
                    f"global [{label}] directory apply failed: {dstatus.reason or dstatus.reason_code}",
                )

        managed = _has_any_managed_perms(global_perms_block)
        try:
            if not managed and not _scope_managed_before(h_id, scope):
                discovered = adapter.discover_existing(scope, h_id)
                if _discovered_has_anything(discovered):
                    # AdoptionRequired: block this (scope, harness) only.
                    backup_dir = pa._backups_root() / h_id / scope.slug
                    print(
                        f"  {c('!', YELLOW)} global  [{label}] "
                        f"AdoptionRequired — pre-existing permissions detected; "
                        f"run: hub permissions adopt --global --harness {h_id} --action import"
                    )
                    blocked_global_harnesses.append(h_id)
                    continue

            try:
                import copy

                translate_perms = copy.copy(global_perms)
                translate_perms.additional_dirs = []
                result = adapter.translate(translate_perms, scope, h_id)
            except Exception as e:
                print(f"  {c('✗', RED)} global  [{label}] translate failed: {e}")
                any_error = True
                _perm_err("permissions", f"global [{label}] translate failed: {e}")
                continue

            writes_count = 0
            for write in result.writes:
                try:
                    if adapter.apply(scope, write, h_id):
                        writes_count += 1
                except Exception as e:
                    print(f"  {c('✗', RED)} global  [{label}] apply failed: {e}")
                    any_error = True
                    _perm_err("permissions", f"global [{label}] apply failed: {e}")

            if writes_count == 0 and not result.skipped:
                print(f"  {c('·', DIM)} global  [{label}] no rules to write")
            else:
                print(f"  {c('✓', GREEN)} global  [{label}] writes={writes_count} skips={len(result.skipped)}")
            for w in getattr(result, "warnings", []) or []:
                print(f"  {c('!', YELLOW)} global  [{label}] {w}")

            doctor_targets.append(("global", h_id, global_perms))
        except Exception as e:
            print(f"  {c('✗', RED)} global  [{label}] {e}")
            any_error = True
            _perm_err("permissions", f"global [{label}] {e}")

    # ── Per-project pass ──────────────────────────────────────────────────
    for proj_name, proj_cfg in projects.items():
        # A project whose path is not on this machine must not be written to:
        # the Codex adapter would auto-grant `trust_level = "trusted"` on a path
        # that does not exist yet, pre-trusting whatever gets checked out there.
        quarantine = hub.project_sync_skip_reason(proj_cfg)
        if quarantine:
            print(f"  {c('!', YELLOW)} {proj_name}  skipped — {quarantine}")
            continue
        proj_path = expand(proj_cfg["path"])
        effective = _operation_effective_harnesses(
            proj_cfg, registry, operation_context, installed
        )
        if not effective:
            directory_statuses = _sync_project_directories(
                proj_name, proj_cfg, proj_path, registry, active_installed, report, operation_context
            )
            any_error = any_error or any(s.config_state == "failed" for s in directory_statuses)
            continue
        directory_statuses = _sync_project_directories(
            proj_name, proj_cfg, proj_path, registry, active_installed, report, operation_context
        )
        any_error = any_error or any(s.config_state == "failed" for s in directory_statuses)
        proj_perms_block = proj_cfg.get("permissions") or {}
        local_block_for_scope = proj_cfg.get("permissions_local") or {}
        if local_block_for_scope.get("worktree_access") is not None:
            print(f"  {proj_name} personal worktree_access ignored; project scope required")
            local_block_for_scope = {k: v for k, v in local_block_for_scope.items() if k != "worktree_access"}
        for h_id in sorted(effective):
            permission_key = _operation_permission_key(operation_context, h_id)
            if permission_key is None:
                continue
            label = _operation_harness_label(operation_context, h_id)
            # Skip if this harness is opted out at project OR global scope.
            if h_id in _unmanaged_list(proj_perms_block) or h_id in _unmanaged_list(global_perms_block):
                print(f"  {c('·', DIM)} {proj_name}  [{label}] unmanaged — skipped")
                continue
            adapter = pa.select_permission_adapter(operation_context, h_id).adapter
            if adapter is None:
                continue
            scope = ProjectScope(name=proj_name, path=str(proj_path))

            try:
                # Auto-import only on genuine first contact: no managed block in
                # the registry AND no sidecar (hub never wrote this scope before).
                # If a sidecar exists, an empty block is a deliberate delete.
                project_managed = _has_any_managed_perms(proj_perms_block)
                if not project_managed and not _scope_managed_before(h_id, scope):
                    discovered = adapter.discover_existing(scope, h_id, project_path=proj_path)
                    if _discovered_has_anything(discovered):
                        target_for_backup = (
                            adapter.target_files(scope, h_id) if hasattr(adapter, "target_files") else None
                        )
                        if target_for_backup and target_for_backup.exists():
                            backup_path = pa._backup_once_per_session(target_for_backup, scope, h_id)
                        else:
                            backup_path = None
                        # Persist discovered into registry as starting point.
                        new_block = _serialize_perms_block(discovered)
                        proj_cfg["permissions"] = {**proj_perms_block, **new_block}
                        proj_perms_block = proj_cfg["permissions"]
                        bp_str = f" (backup: {backup_path})" if backup_path else ""
                        print(
                            f"  {c('↥', CYAN)} {proj_name}  [{label}] "
                            f"auto-imported pre-existing permissions{bp_str}"
                        )

                # Scope-targeted writes: project files receive ONLY the project's
                # own rules. The harness merges user-level + project-level at runtime.
                project_own_perms = resolve_project_own(proj_cfg)
                if hasattr(adapter, "plan_directories"):
                    project_own_perms.additional_dirs = []

                try:
                    result = adapter.translate(project_own_perms, scope, h_id)
                except Exception as e:
                    print(f"  {c('✗', RED)} {proj_name}  [{label}] translate failed: {e}")
                    any_error = True
                    _perm_err(
                        "permissions",
                        f"{proj_name} [{label}] translate failed: {e}",
                    )
                    continue

                writes_count = 0
                for write in result.writes:
                    try:
                        if adapter.apply(scope, write, h_id):
                            writes_count += 1
                    except Exception as e:
                        print(f"  {c('✗', RED)} {proj_name}  [{label}] apply failed: {e}")
                        any_error = True
                        _perm_err(
                            "permissions",
                            f"{proj_name} [{label}] apply failed: {e}",
                        )

                if writes_count == 0 and not result.skipped:
                    print(f"  {c('·', DIM)} {proj_name}  [{label}] no rules to write")
                else:
                    print(
                        f"  {c('✓', GREEN)} {proj_name}  [{label}] "
                        f"writes={writes_count} skips={len(result.skipped)}"
                    )
                for w in getattr(result, "warnings", []) or []:
                    print(f"  {c('!', YELLOW)} {proj_name}  [{label}] {w}")

                # ── Personal per-project tier (claude-family only) ──────────
                # A `permissions_local` block holds PERSONAL rules that target
                # the harness's gitignored `.claude/settings.local.json` instead
                # of the committed `.claude/settings.json`. Scope-targeted: the
                # local file gets ONLY this project's personal block — never the
                # shared/global rules. Codex/opencode have no committed-vs-
                # personal split in this model, so they are skipped.
                local_block = proj_cfg.get("permissions_local") or {}
                local_scope = ProjectScope(name=proj_name, path=str(proj_path), personal=True)
                from skill_hub.domain.permissions.permissions import DirectoryLedgerIdentity, directory_sidecar_path

                local_directory_ledger = directory_sidecar_path(
                    h_id, DirectoryLedgerIdentity.from_scope(local_scope, h_id)
                ).exists()
                if permission_key != "claude":
                    if _has_any_managed_perms(local_block):
                        print(
                            f"  {c('·', DIM)} {proj_name}  [{label}] "
                            f"personal tier skipped — no committed-vs-personal "
                            f"split for this harness"
                        )
                # Write when the block has rules, OR when it is now empty but a
                # personal sidecar from a prior sync exists (so removing the block
                # strips the stale entries from settings.local.json).
                elif (
                    _has_any_managed_perms(local_block)
                    or _scope_managed_before(h_id, local_scope)
                    or local_directory_ledger
                ):
                    project_local_perms = resolve_project_local_own(proj_cfg)
                    if hasattr(adapter, "plan_directories"):
                        project_local_perms.additional_dirs = []
                    try:
                        local_result = adapter.translate(project_local_perms, local_scope, h_id)
                    except Exception as e:
                        print(f"  {c('✗', RED)} {proj_name}  [{label}] personal translate failed: {e}")
                        any_error = True
                        _perm_err(
                            "permissions",
                            f"{proj_name} [{label}] personal translate failed: {e}",
                        )
                        local_result = None
                    if local_result is not None:
                        local_writes = 0
                        for write in local_result.writes:
                            try:
                                if adapter.apply(local_scope, write, h_id):
                                    local_writes += 1
                            except Exception as e:
                                print(f"  {c('✗', RED)} {proj_name}  [{label}] personal apply failed: {e}")
                                any_error = True
                                _perm_err(
                                    "permissions",
                                    f"{proj_name} [{label}] personal apply failed: {e}",
                                )
                        print(
                            f"  {c('✓', GREEN)} {proj_name}  [{label}] "
                            f"personal writes={local_writes} "
                            f"skips={len(local_result.skipped)}"
                        )
                        doctor_targets.append((f"project-local:{proj_name}", h_id, project_local_perms))

                # Doctor uses the full effective view (global + project) to detect
                # the complete risk surface for this project.
                effective_perms = resolve_effective(proj_cfg, registry)
                doctor_targets.append((f"project:{proj_name}", h_id, effective_perms))
            except Exception as e:
                print(f"  {c('✗', RED)} {proj_name}  [{label}] {e}")
                any_error = True
                _perm_err("permissions", f"{proj_name} [{label}] {e}")

    # Doctor rollup lifted OUT to `_run_doctor_rollup` (shared post-streams stage
    # covering permissions AND hooks). Targets were accumulated into
    # `doctor_targets` above.

    if blocked_global_harnesses:
        # Surface a clear summary at the tail
        ids = ", ".join(blocked_global_harnesses)
        print(
            f"\n  {c('!', YELLOW)} global permissions blocked for: {ids} — "
            f"resolve via `hub permissions adopt --global --action import`"
        )

    # First-post-upgrade detection (D2): project native files copied from a
    # pre-scope-targeting install may still carry global-sourced duplicates.
    # Detection is non-blocking; the user runs the migration explicitly.
    if hub._project_files_have_global_duplicates(registry, operation_context):
        print(
            f"\n  {c('!', YELLOW)} project files still contain global-sourced "
            f"duplicate rules — preview/remove with "
            f"`hub permissions migrate-scope` (add --apply to commit)"
        )

    # Write-error exit code only; danger findings are decided by the shared
    # doctor rollup now.
    rc = 1 if any_error else 0
    if report is not None:
        prior_errors = report.get("global", {}).get("permissions", {}).get("errors", [])
        report["global"]["permissions"] = {
            "ok": rc == 0 and not prior_errors,
            "errors": list(prior_errors) + perm_errors,
        }
        if operation_context is not None:
            report["global"]["permissions"]["routes"] = {
                h_id: {
                    "mode": operation_context.route(h_id, "permissions").mode,
                    "status": operation_context.route(h_id, "permissions").status,
                    "reason": operation_context.route(h_id, "permissions").reason,
                }
                for h_id in sorted(operation_context.harness_ids)
            }
    return rc


def _discovered_has_anything(perms) -> bool:
    return bool(
        perms.allow
        or perms.deny
        or perms.ask
        or perms.hooks
        or perms.additional_dirs
        or perms.sandbox_mode
        or perms.approval_policy
        or perms.project_trust is not None
        or perms.extras
    )
