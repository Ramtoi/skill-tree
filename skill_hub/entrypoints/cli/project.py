"""`hub project` — register, remove, and inspect Skill Hub projects.

Project lifecycle (add/remove/edit-path/rename), the hub-owned-artifact
cleanup a removal or a path move must perform, and the read-only per-project
inspectors (harnesses, invocation overrides, agent-docs prefs, project-local
skill discovery + adoption). All the storage model lives in the registry
(`registry["projects"]`); these handlers are marshalling + output only.

Carved out of `hub.py` — see `hub_cli/__init__.py` for the module contract
this file implements (`NAME`, `register`, `dispatch`).
"""

from __future__ import annotations

import json
import shutil
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional

from skill_hub import hub_core
from skill_hub.application.projects import worktree_defaults
from skill_hub.hub_core import (
    BOLD,
    CYAN,
    DIM,
    GREEN,
    RED,
    YELLOW,
    c,
    collapse_home,
    data_home,
    data_home_lock,
    expand,
    fail,
    registry_mutation,
    validate_slug,
)

NAME = "project"

p_proj = None


def _ensure_operation_context(args):
    """Capture native participants once for a project lifecycle command."""
    context = getattr(args, "_operation_context", None)
    if context is not None:
        return context
    from skill_hub.application.harnesses.harness_operation_context import WORKFLOW_FEATURES, build_operation_context
    from skill_hub.domain.harnesses.harness_adapter_api import SDK_VERSION, Version
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    context = build_operation_context(
        hub_core.data_home(),
        tuple(sorted(_harnesses.HARNESSES)),
        requested_features=WORKFLOW_FEATURES,
        installed_harness_ids=tuple(sorted(_harnesses.detect_installed())),
        host_version=Version.parse(hub_core.hub_version()),
        sdk_version=SDK_VERSION,
    )
    args._operation_context = context
    return context


def register(sub) -> None:
    global p_proj
    import hub

    # project
    p_proj = sub.add_parser("project", help="Manage projects")
    proj_sub = p_proj.add_subparsers(dest="project_cmd")
    p_proj_add = proj_sub.add_parser("add", help="Register a new project")
    p_proj_add.add_argument("name", help="Project name")
    p_proj_add.add_argument("path", help="Absolute path to project")
    p_proj_remove = proj_sub.add_parser("remove", help="Remove a registered project (cleans hub-owned artifacts)")
    p_proj_remove.add_argument("name", help="Project name")
    p_proj_remove.add_argument("--dry-run", action="store_true", help="Print the removal plan without applying")
    p_proj_remove.add_argument("--json", action="store_true", help="Emit dry-run plan as JSON")
    p_proj_edit = proj_sub.add_parser("edit-path", help="Change a registered project's filesystem location")
    p_proj_edit.add_argument("name", help="Project name")
    p_proj_edit.add_argument("new_path", help="New absolute path")
    p_proj_rename = proj_sub.add_parser("rename", help="Rename a registered project (path and settings stay)")
    p_proj_rename.add_argument("name", help="Current project name")
    p_proj_rename.add_argument("new_name", help="New project name (slug)")
    p_proj_h = proj_sub.add_parser(
        "harnesses",
        help="Show or mutate a project's harness list",
    )
    p_proj_h.add_argument("name", help="Project name")
    p_proj_h.add_argument("--add", help="Comma-separated harness ids to add")
    p_proj_h.add_argument("--remove", help="Comma-separated harness ids to remove")
    p_proj_inv = proj_sub.add_parser(
        "invocation",
        help="Show or set per-skill invocation overrides for a project",
    )
    p_proj_inv.add_argument("name", help="Project name")
    p_proj_inv.add_argument("--skill", help="Skill to override")
    p_proj_inv.add_argument(
        "--mode",
        choices=list(hub.PROJECT_INVOCATION_MODES),
        help="Override mode (inherit clears the override)",
    )
    p_proj_inv.add_argument("--json", action="store_true", help="Emit JSON")
    p_proj_docs = proj_sub.add_parser("agent-docs", help="Show Agent Docs preferences (read-only)")
    p_proj_docs.add_argument("name", help="Project name")

    p_proj_import = proj_sub.add_parser(
        "import-skill",
        help="Adopt a hand-authored project-local skill into the hub",
    )
    p_proj_import.add_argument("name", help="Skill name (its SKILL.md `name:`) to import")
    p_proj_import.add_argument("--project", required=True, help="Project the skill currently lives in")

    p_proj_scan = proj_sub.add_parser(
        "scan-skills",
        help="List hand-authored project-local skills not yet adopted (read-only)",
    )
    p_proj_scan.add_argument("--project", help="Limit to one registered project by name")
    p_proj_scan.add_argument("--json", action="store_true", help="Emit JSON list")

    p_proj_analytics = proj_sub.add_parser(
        "analytics",
        help="Show or mutate a project's usage-analytics verify-prefix field",
    )
    p_proj_analytics.add_argument("name", help="Project name")
    p_proj_analytics.add_argument(
        "--verify-prefixes",
        dest="verify_prefixes",
        default=None,
        help=(
            "Comma-separated Bash prefixes counted as 'verify' for this project "
            "(replaces the whole list; an empty string clears it)"
        ),
    )
    p_proj_analytics.add_argument(
        "--add-verify-prefix",
        dest="add_verify_prefix",
        action="append",
        default=None,
        help="Append one verify prefix (repeatable)",
    )
    p_proj_analytics.add_argument("--json", action="store_true", help="Emit JSON")

    p_proj_wt = proj_sub.add_parser(
        "worktree-defaults", help="Show or set defaults for newly registered projects"
    )
    wt_sub = p_proj_wt.add_subparsers(dest="worktree_defaults_cmd")
    p_wt_show = wt_sub.add_parser("show", help="Show effective worktree defaults")
    p_wt_show.add_argument("--json", action="store_true", help="Emit JSON")
    p_wt_set = wt_sub.add_parser("set", help="Set defaults for new projects")
    p_wt_set.add_argument("--config-json", dest="config_json", required=True)
    p_wt_set.add_argument("--json", action="store_true", help="Emit JSON")
    p_wt_preview = wt_sub.add_parser("preview", help="Resolve a new project's worktree directory")
    p_wt_preview.add_argument("--name", required=True, help="New project name")
    p_wt_preview.add_argument("--path", required=True, help="Absolute project path")
    p_wt_preview.add_argument("--config-json", dest="config_json")
    p_wt_preview.add_argument("--json", action="store_true", help="Emit JSON")

    repository = proj_sub.add_parser("repository", help="Optional Git repository association")
    repo_sub = repository.add_subparsers(dest="repository_cmd", required=True)
    for verb in ("show", "inspect", "set", "clear"):
        command = repo_sub.add_parser(verb, help=f"{verb.title()} a project's repository association")
        command.add_argument("name", help="Registered project")
        command.add_argument("--json", dest="json", action="store_true", help="Emit JSON")
        if verb in ("inspect", "set"):
            command.add_argument("--remote", dest="repository_remote", default="origin")
    discover = repo_sub.add_parser("discover", help="Find checkouts inside selected roots (read-only)")
    discover.add_argument("--root", dest="repository_roots", action="append", required=True)
    discover.add_argument("--json", dest="json", action="store_true", help="Emit JSON")


def dispatch(args) -> None:
    if args.project_cmd == "add":
        cmd_project_add(args)
    elif args.project_cmd == "remove":
        cmd_project_remove(args)
    elif args.project_cmd == "edit-path":
        cmd_project_edit_path(args)
    elif args.project_cmd == "rename":
        cmd_project_rename(args)
    elif args.project_cmd == "harnesses":
        cmd_project_harnesses(args)
    elif args.project_cmd == "invocation":
        cmd_project_invocation(args)
    elif args.project_cmd == "agent-docs":
        cmd_project_agent_docs(args)
    elif args.project_cmd == "import-skill":
        cmd_project_import_skill(args)
    elif args.project_cmd == "scan-skills":
        cmd_project_scan_skills(args)
    elif args.project_cmd == "analytics":
        cmd_project_analytics(args)
    elif args.project_cmd == "repository":
        cmd_project_repository(args)
    elif args.project_cmd == "worktree-defaults":
        if args.worktree_defaults_cmd == "show":
            cmd_project_worktree_defaults_show(args)
        elif args.worktree_defaults_cmd == "set":
            cmd_project_worktree_defaults_set(args)
        elif args.worktree_defaults_cmd == "preview":
            cmd_project_worktree_defaults_preview(args)
        else:
            p_proj.print_help()
    else:
        p_proj.print_help()


# ─────────────────────────────────────────────────────────────────────────────
# hub project add/remove
# ─────────────────────────────────────────────────────────────────────────────

def _repository_reply(args, *, mutate=False):
    import hub
    from skill_hub.infrastructure.registry import project_repository as repositories

    verb = args.repository_cmd
    if verb == "discover":
        result = repositories.discover_checkouts([Path(p) for p in args.repository_roots])
        return {"ok": True, "project": None, "repository": None, "error": None, **asdict(result)}
    registry = hub._read_registry_optional()
    cfg = (registry.get("projects") or {}).get(args.name)
    if not isinstance(cfg, dict):
        raise repositories.RepositoryError("Unknown project.", code="unknown_project")
    saved = cfg.get("repository")
    inspection = None
    association = None
    if verb in ("inspect", "set"):
        inspection = repositories.inspect_project_repository(
            Path(cfg["path"]).expanduser(), remote=args.repository_remote
        )
        association = inspection.association
    elif verb == "show" and saved is not None:
        association = repositories.validate_repository_association(saved)
    if mutate:
        updated = asdict(association) if association is not None else None
        if updated != saved:
            if updated is None:
                cfg.pop("repository", None)
            else:
                cfg["repository"] = updated
            # Optional remote integration cannot turn metadata editing into a
            # network operation. It invalidates only saved controller evidence.
            from skill_hub.infrastructure.registry import loadout_bindings

            loadout_bindings.invalidate_source(
                registry, args.name,
                "source_repository_cleared" if updated is None else "source_repository_changed",
                repository_only=True,
            )
            hub_core.save_registry(registry)
    return {
        "ok": True, "project": args.name,
        "repository": asdict(association) if association is not None else None,
        "inspection": asdict(inspection) if inspection is not None else None,
        "error": None,
    }


@registry_mutation("project-repository")
def _mutate_project_repository(args):
    return _repository_reply(args, mutate=True)


def cmd_project_repository(args):
    """Repository reads are optional; metadata writes never invoke sync."""
    from skill_hub.infrastructure.registry import project_repository as repositories

    mutation = args.repository_cmd in {"set", "clear"}
    try:
        reply = _mutate_project_repository(args) if mutation else _repository_reply(args)
    except repositories.RepositoryError as exc:
        reply = {
            "ok": False, "project": getattr(args, "name", None), "repository": None,
            "error": {"code": exc.code, "message": str(exc), "field": exc.field},
        }
    if args.json:
        print(json.dumps(reply, indent=2))
    elif reply["ok"]:
        print(json.dumps(reply, indent=2))
    else:
        print(reply["error"]["message"], file=sys.stderr)
    if not reply["ok"] and (mutation or not args.json):
        raise SystemExit(1)


def cmd_project_scan_skills(args):
    """List hand-authored project-local skills not yet adopted (read-only).

    The sanctioned discovery surface over `scan_project_skill_candidates`,
    consumed by the control-plane MCP `skill_candidates` tool and the app's
    per-project candidate section. Optional `--project` filters to one project.
    Never mutates; exits 0 even when nothing is found.
    """
    import hub

    operation_context = _ensure_operation_context(args)

    registry = hub._read_registry_optional()
    project = getattr(args, "project", None)
    if project and project not in (registry.get("projects") or {}):
        msg = f"Unknown project '{project}'"
        if getattr(args, "json", False):
            print(json.dumps({"error": msg}))
        else:
            print(f"{c('!', RED)} {msg}")
        sys.exit(1)

    candidates = hub.scan_project_skill_candidates(
        registry, operation_context=operation_context
    )
    if project:
        candidates = [c for c in candidates if c.get("project") == project]

    if getattr(args, "json", False):
        print(json.dumps(candidates))
        return

    if not candidates:
        scope = f" in {project}" if project else ""
        print(f"{c('·', DIM)} no un-adopted project-local skills{scope}")
        return
    for cand in candidates:
        tag = c("NEW", GREEN) if cand["category"] == "NEW" else c("INVALID", YELLOW)
        print(f"  {tag}  {cand['name']}  ({cand['project']})  {cand['path']}")
        if cand.get("reason"):
            print(f"        → {cand['reason']}")


@registry_mutation("project-import-skill")
def cmd_project_import_skill(args):
    """Adopt a hand-authored project-local skill into the hub.

    Copies the project's skill dir into data_home/skills/<name>, registers it,
    enables it on the project, then removes the original (only after a verified
    copy + registry write — the original is never at risk before the copy
    succeeds). The command ends with `hub._auto_sync_tail()`, which re-creates
    the managed symlink in the same run — no manual `hub sync` needed.
    """
    import hub

    operation_context = _ensure_operation_context(args)

    registry = hub_core.load_registry()
    projects = registry.get("projects") or {}
    proj_name = args.project
    name = args.name

    if proj_name not in projects:
        fail(f"Unknown project: {proj_name}")
    proj_cfg = projects[proj_name]

    cands = [
        cand
        for cand in hub.scan_project_skill_candidates(
            registry, operation_context=operation_context
        )
        if cand["project"] == proj_name and cand["name"] == name
    ]
    if not cands:
        skills = registry.get("skills") or {}
        if name in skills:
            fail(f"'{name}' is already a registered skill (source: {skills[name].get('source')}). Nothing to import.")
        fail(
            f"No untracked skill named '{name}' found in project '{proj_name}'. "
            f"Run `hub sync` to see detected project-local skills."
        )
    cand = cands[0]
    if cand["category"] == "INVALID_NAME":
        fail(
            f"'{name}' has an invalid skill name (must match ^[a-z0-9-]+$). "
            f"Rename the directory and its SKILL.md `name:` first."
        )

    source_path = Path(cand["path"])
    dest = hub.hub_skills_dir() / name
    if dest.exists():
        fail(f"{dest} already exists — refusing to overwrite. Resolve the collision manually.")

    # 1. Copy into data home, then verify before touching the original.
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source_path, dest, symlinks=True, dirs_exist_ok=False)
    if not (dest / "SKILL.md").exists():
        shutil.rmtree(dest, ignore_errors=True)
        fail("Copy verification failed; aborted (original left untouched).")

    # 2. Register + enable, then persist.
    skills = registry.setdefault("skills", {})
    skills[name] = {
        "version": cand.get("version") or "1.0.0",
        "description": cand.get("description") or "",
        "source": collapse_home(dest),
        "type": "claude-skill",
        "scope": "project-specific",
        "upstream": None,
    }
    enabled = proj_cfg.setdefault("enabled", [])
    if name not in enabled:
        enabled.append(name)
    hub_core.save_registry(registry)

    # 3. Remove the original real dir — it is now safely adopted. (If this
    #    fails, the next `hub sync` backs it up via ensure_symlink anyway.)
    try:
        shutil.rmtree(source_path)
    except OSError as e:
        print(f"  {c('!', YELLOW)} adopted, but could not remove original {source_path}: {e}")
        print("    (next `hub sync` will back it up automatically)")

    print(f"  {c('✓', GREEN)} adopted {name} into the hub ({collapse_home(dest)})")
    print(f"  {c('✓', GREEN)} enabled {name} on project {proj_name}")

    # Registry write is already durable; a sync-stream failure past this point
    # must never surface as an import failure. No redirect here (unlike
    # `hub skill import` / `hub source add git`): this command has no `--json`
    # contract, so the sync chatter stays on stdout where a human expects it.
    # `_auto_sync_tail()` reports whether it came back clean — a swallowed
    # rc 1/2 is not a synced skill, so the "✓" line is gated on it rather
    # than printed unconditionally.
    # Keep discovery and the trailing reconciliation on the same captured
    # operation snapshot.  The helper accepts the keyword in this workflow
    # branch while retaining its no-argument compatibility API elsewhere.
    synced = hub._auto_sync_tail(operation_context=operation_context)
    if synced:
        print(f"  {c('✓', GREEN)} synced — linked into your project")
    else:
        print(f"  {c('!', YELLOW)} adopted, but the trailing sync did not finish cleanly — see the warning above")


@registry_mutation("project-add")
def cmd_project_add(args):
    registry = hub_core.load_registry()
    projects = registry.get("projects", {})

    name = args.name
    validate_slug(name, label="project name")
    raw_path = Path(args.path).expanduser()
    if not raw_path.exists() or not raw_path.is_dir():
        fail(f"Path does not exist or is not a directory: {raw_path}")
    resolved = str(raw_path.resolve())

    if name in projects:
        print(f"Project '{name}' already registered at {projects[name]['path']}")
        return
    for other_name, other_cfg in projects.items():
        if Path(other_cfg["path"]).expanduser().resolve() == raw_path.resolve():
            fail(f"Path already used by project '{other_name}'")

    defaults = worktree_defaults.effective(registry)
    projects[name] = {
        "path": resolved,
        "enabled": [],
        "bundles": [],
        "permissions": worktree_defaults.project_permissions(
            defaults, name=name, project_path=resolved
        ),
    }
    registry["projects"] = projects
    hub_core.save_registry(registry)
    print(f"{c('✓', GREEN)} registered project '{name}' at {resolved}")
    print(f"  use 'hub enable <skill> --project {name}' to activate skills")



def _worktree_defaults_envelope(
    *,
    registry: dict,
    preview: Optional[dict] = None,
    defaults: Optional[dict] = None,
) -> dict[str, Any]:
    return {
        "ok": True,
        "defaults": defaults if defaults is not None else worktree_defaults.effective(registry),
        "configured": "worktree_defaults" in registry,
        "preview": preview,
        "error": None,
    }


def _worktree_defaults_error(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, worktree_defaults.WorktreeDefaultsError):
        return {
            "code": exc.code,
            "message": str(exc),
            "field": exc.field,
        }
    return {"code": "invalid_config", "message": str(exc), "field": None}


def _emit_worktree_defaults_error(args, exc: Exception, *, read_only: bool = False) -> None:
    payload = {
        "ok": False,
        "defaults": None,
        "configured": False,
        "preview": None,
        "error": _worktree_defaults_error(exc),
    }
    if getattr(args, "json", False):
        print(json.dumps(payload))
    else:
        print(str(exc))
    if not read_only:
        raise SystemExit(1)


def _parse_worktree_config(args) -> dict:
    try:
        parsed = json.loads(args.config_json)
    except (TypeError, json.JSONDecodeError) as exc:
        raise worktree_defaults.WorktreeDefaultsError(
            "config-json must contain a JSON object", code="invalid_json"
        ) from exc
    return worktree_defaults.normalize(parsed)


def cmd_project_worktree_defaults_show(args):
    registry = hub_core.load_registry()
    try:
        print(json.dumps(_worktree_defaults_envelope(registry=registry)))
    except Exception as exc:
        _emit_worktree_defaults_error(args, exc, read_only=True)


@registry_mutation("project-worktree-defaults-set")
def cmd_project_worktree_defaults_set(args):
    registry = hub_core.load_registry()
    try:
        defaults = _parse_worktree_config(args)
    except Exception as exc:
        _emit_worktree_defaults_error(args, exc)
    registry["worktree_defaults"] = defaults
    hub_core.save_registry(registry)
    print(json.dumps(_worktree_defaults_envelope(registry=registry, defaults=defaults)))


def cmd_project_worktree_defaults_preview(args):
    registry = hub_core.load_registry()
    try:
        defaults = (
            _parse_worktree_config(args)
            if args.config_json is not None
            else worktree_defaults.effective(registry)
        )
        preview = worktree_defaults.resolve(
            defaults, name=args.name, project_path=args.path
        )
        print(json.dumps(_worktree_defaults_envelope(registry=registry, preview=preview, defaults=defaults)))
    except Exception as exc:
        _emit_worktree_defaults_error(args, exc, read_only=True)

def _operation_owned_link(link: Path, operation_context) -> bool:
    """Apply link ownership against the operation's captured data home."""
    import hub

    if operation_context is None:
        return hub.is_hub_owned_link(link)
    if not link.is_symlink():
        return False
    target = hub.link_target_abs(link)
    if target is None:
        return False
    try:
        from skill_hub.infrastructure.filesystem import sync_links

        data_root = Path(operation_context.data_home)
        for subtree in sync_links.HUB_LINKED_SUBTREES:
            if sync_links._is_under_owned_root(Path(target), data_root / subtree):
                return True
    except (OSError, RuntimeError, ValueError):
        return False
    return False


def _operation_project_skill_dirs(proj_path: Path, operation_context) -> tuple[Path, ...]:
    """Return unique project skill directories from available captured routes."""
    if operation_context is None:
        return (proj_path / ".claude" / "skills", proj_path / ".agents" / "skills")
    dirs: dict[Path, list[Any]] = {}
    for harness_id, layout in operation_context.layouts.items():
        route = operation_context.route(harness_id, "skills")
        path = proj_path / Path(layout.project_skills_dir)
        dirs.setdefault(path, []).append(route)
    return tuple(
        path
        for path, routes in dirs.items()
        if routes
        and all(
            route.status == "shadow" and route.mode == "legacy_shadow"
            for route in routes
        )
    )



def clean_project_artifacts(
    proj_path: Path,
    registry: dict,
    dry_run: bool = False,
    project_name: Optional[str] = None,
    operation_context=None,
) -> dict:
    """Plan/execute removal of hub-owned artifacts in a project directory.

    Returns a dict with the same shape whether dry-run or applied.
    Uses os.readlink (literal target) to decide ownership — NOT Path.resolve.

    When ``project_name`` is given, also strips this project's native HOOK entries
    (settings.local.json hooks) and deletes its hooks-kind sidecars — mirroring how
    permission sidecars are handled for the same lifecycle events. The registry
    hook attach lists (``projects.<n>.hooks`` / ``hook_settings``) are dropped by
    the caller when it removes the whole project block.
    """
    import hub
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    if operation_context is None:
        from skill_hub.application.harnesses.harness_operation_context import WORKFLOW_FEATURES, build_operation_context

        operation_context = build_operation_context(
            hub_core.data_home(),
            tuple(sorted(_harnesses.HARNESSES)),
            requested_features=WORKFLOW_FEATURES,
            installed_harness_ids=tuple(sorted(_harnesses.detect_installed())),
        )

    plan: dict[str, Any] = {
        "removed_symlinks": [],
        "removed_mcp_entries": [],
        "removed_empty_dirs": [],
        "removed_hook_sidecars": [],
        "removed_worktree_access": [],
        "worktree_access_failures": [],
        "warnings": [],
    }

    project = (registry.get("projects") or {}).get(project_name) or {}
    if project.get("path_unresolved"):
        plan["warnings"].append("No local directory attached; historical path left unchanged.")
        return plan

    if project_name:
        from skill_hub.application.sync.permissions_stream import _cleanup_project_worktree_access
        from skill_hub.domain.permissions.permissions import ProjectScope

        scope = ProjectScope(name=project_name, path=str(proj_path))
        harness_ids = set((registry.get("harnesses_global") or [])) | set(
            (registry.get("projects", {}).get(project_name, {}).get("harnesses") or [])
        )
        if dry_run:
            from skill_hub.domain.permissions.permission_adapter_base import plan_directory_cleanup
            from skill_hub.infrastructure.permissions import permission_adapters as pa

            statuses = []
            for harness_id in harness_ids:
                adapter = pa.select_permission_adapter(operation_context, harness_id).adapter
                if adapter is None:
                    continue
                scopes = [scope]
                if harness_id == "claude-code":
                    scopes.append(ProjectScope(project_name, str(proj_path), personal=True))
                for candidate_scope in scopes:
                    statuses.append(plan_directory_cleanup(adapter, candidate_scope, harness_id).status)
        else:
            statuses = _cleanup_project_worktree_access(scope, harness_ids, operation_context)
        for status in statuses:
            if status.config_state == "removed":
                plan["removed_worktree_access"].append(status.__dict__)
            elif status.config_state == "failed":
                plan["worktree_access_failures"].append(status.__dict__)

    if not proj_path.exists():
        plan["warnings"].append(f"project path no longer exists: {proj_path}")
        return plan

    for skills_dir in _operation_project_skill_dirs(proj_path, operation_context):
        if not skills_dir.exists() or skills_dir.is_symlink():
            continue
        try:
            entries = list(skills_dir.iterdir())
        except OSError as e:
            plan["warnings"].append(f"cannot list {skills_dir}: {e}")
            continue
        for entry in entries:
            if not entry.is_symlink():
                continue
            # ONE ownership rule for every sweep (`is_hub_owned_link`). The old
            # local check accepted only `<data>/skills/` + `<data>/mcp-servers/`,
            # so it walked past links into a generated variant dir
            # (`state/skill_variants/<key>@renamed`, `@<mode>`) or a source
            # checkout (`sources/<id>/worktree/…`) and left them dangling once
            # the next sync collected the variant.
            if _operation_owned_link(entry, operation_context):
                plan["removed_symlinks"].append(str(entry))
                if not dry_run:
                    try:
                        entry.unlink()
                    except OSError as e:
                        plan["warnings"].append(f"could not delete {entry}: {e}")
            else:
                plan["warnings"].append(
                    f"left in place (another install owns it): {entry} → {hub.link_target_abs(entry)}"
                )
        # Empty-dir cleanup
        try:
            if not any(skills_dir.iterdir()):
                plan["removed_empty_dirs"].append(str(skills_dir))
                if not dry_run:
                    try:
                        skills_dir.rmdir()
                    except OSError as e:
                        plan["warnings"].append(f"could not rmdir {skills_dir}: {e}")
        except OSError:
            pass

    # Command-only invocation has a separate ownership root from skill links.
    from skill_hub.infrastructure.harnesses.opencode_invocation import owned_command_links

    try:
        invocation_route = (
            operation_context.route("opencode", "invocation")
            if operation_context is not None
            else None
        )
        if (
            operation_context is not None
            and (
                invocation_route is None
                or invocation_route.status == "unavailable"
                or operation_context.opencode_paths is None
            )
        ):
            command_links = []
        else:
            native_paths = (
                operation_context.opencode_paths
                if operation_context is not None
                else None
            )
            command_links = owned_command_links(proj_path, native_paths=native_paths)
        for link in command_links:
            plan["removed_symlinks"].append(str(link))
            if not dry_run:
                link.unlink()
    except OSError as exc:
        plan["warnings"].append(f"could not clean invocation commands: {exc}")

    # MCP cleanup is ownership-gated by the selected adapter.  A project
    # lifecycle operation always has a project name, so the adapter can read
    # its sidecar and verify the recorded value before removing anything.
    registered_mcps = {
        n
        for n, cfg in (registry.get("skills") or {}).items()
        if cfg.get("type") == "mcp-server"
    }
    if project_name and operation_context is not None:
        from skill_hub.application.sync import mcp_sync
        from skill_hub.infrastructure.mcp import mcp_adapters

        project_cfg = (registry.get("projects") or {}).get(project_name, {})
        effective = mcp_sync._context_effective_harnesses(
            project_cfg, registry, operation_context
        )
        adapter_groups: dict[str, set[str]] = {}
        for harness_id in effective:
            adapter_key = mcp_sync._context_adapter_key(operation_context, harness_id)
            if adapter_key is not None:
                adapter_groups.setdefault(adapter_key, set()).add(harness_id)
        for adapter_key, harness_ids in sorted(adapter_groups.items()):
            representative = mcp_sync._representative_harness(
                adapter_key, harness_ids, operation_context
            )
            if representative is None:
                continue
            mcp_adapter = mcp_adapters.select_mcp_adapter(
                operation_context, representative
            )
            if mcp_adapter is None:
                continue
            result = mcp_adapter.remove(
                proj_path,
                registered_mcps,
                harness_id=representative,
                project_name=project_name,
                dry_run=dry_run,
                data_home_path=Path(operation_context.data_home) if operation_context is not None else None,
            )
            for name in sorted(result.removed):
                target = result.target or proj_path
                plan["removed_mcp_entries"].append(
                    {"file": str(target), "name": name}
                )
    else:
        # No project identity means no sidecar scope.  Keep every native MCP
        # entry intact rather than deriving ownership from a registry name.
        pass

    # Hook cleanup — strip this project's native hook entries + hooks-kind
    # sidecars for every known hook-capable harness (mirrors permission sidecar
    # handling for the same lifecycle events). Requires the project NAME to build
    # the ProjectScope; the sidecar slug is name-based (path-independent).
    if project_name:
        from skill_hub.domain.permissions.permissions import ProjectScope, read_sidecar
        from skill_hub.infrastructure.hooks import hook_adapters

        scope = ProjectScope(name=project_name, path=str(proj_path))
        hook_harness_ids = (
            operation_context.harness_ids
            if operation_context is not None
            else tuple(_harnesses.HARNESSES)
        )
        for h_id in hook_harness_ids:
            adapter = hook_adapters.select_hook_adapter(operation_context, h_id).adapter
            if adapter is None:
                continue
            sc = read_sidecar(
                h_id, scope, "hooks",
                data_home_path=Path(operation_context.data_home) if operation_context is not None else None,
            )
            if sc is None:
                continue
            plan["removed_hook_sidecars"].append({"harness": h_id, "file": sc.file})
            if not dry_run:
                try:
                    adapter.cleanup(
                        scope,
                        h_id,
                        data_home_path=(
                            Path(operation_context.data_home)
                            if operation_context is not None
                            else None
                        ),
                    )
                except Exception as e:  # pragma: no cover - defensive
                    plan["warnings"].append(f"could not clean {h_id} hooks for {project_name}: {e}")

    return plan


@registry_mutation("project-remove")
def cmd_project_remove(args):
    operation_context = _ensure_operation_context(args)
    registry = hub_core.load_registry()
    projects = registry.get("projects", {})
    name = args.name

    if name not in projects:
        fail(f"Unknown project '{name}'.")

    dry_run = getattr(args, "dry_run", False)
    json_out = getattr(args, "json", False)
    proj_path = expand(projects[name]["path"])

    from skill_hub.infrastructure.registry import loadout_bindings

    references = loadout_bindings.source_references(registry, name)
    if references:
        if dry_run and json_out:
            print(json.dumps({
                "project": name, "project_path": str(proj_path), "blocked": True,
                "bindings": references, "removed_symlinks": [], "removed_mcp_entries": [],
                "removed_empty_dirs": [], "warnings": ["Unbind remote checkouts before removing this project."],
            }))
            return
        fail("Unbind remote checkouts before removing this project.")

    if dry_run:
        plan = clean_project_artifacts(
            proj_path, registry, dry_run=True, project_name=name,
            operation_context=operation_context,
        )
        plan["project"] = name
        plan["project_path"] = str(proj_path)
        # W-2: the real run deprovisions every ships_with companion this
        # project's ledger claims (see below) — the dry-run must say so too,
        # read-only, straight off the ledger (no mutation).
        from skill_hub.domain.skills import ships_with

        plan["companions"] = {
            skill_name: {
                "hooks": list(entry.get("hooks") or []),
                "agents": list(entry.get("agents") or []),
                "permissions": list(entry.get("permissions") or []),
            }
            for skill_name, entry in ships_with.ledger(projects[name]).items()
        }
        if json_out:
            print(json.dumps(plan, indent=2))
        else:
            print(f"\n{c('Plan for `hub project remove ' + name + '`:', BOLD)}")
            print(f"  Project path: {proj_path}")
            for sl in plan["removed_symlinks"]:
                print(f"  {c('-', RED)} symlink: {sl}")
            for me in plan["removed_mcp_entries"]:
                print(f"  {c('-', RED)} mcp entry {me['name']} in {me['file']}")
            for hs in plan["removed_hook_sidecars"]:
                print(f"  {c('-', RED)} hooks: {hs['harness']} ({hs['file']})")
            for d in plan["removed_empty_dirs"]:
                print(f"  {c('-', RED)} empty dir: {d}")
            for skill_name, comp in plan["companions"].items():
                for kind in ("hooks", "agents", "permissions"):
                    for item in comp.get(kind, []):
                        label = item if isinstance(item, str) else item.get("pattern")
                        print(f"  {c('-', RED)} companion ({skill_name}) {kind[:-1]}: {label}")
            for w in plan["warnings"]:
                print(f"  {c('!', YELLOW)} {w}")
        return

    with data_home_lock():
        plan = clean_project_artifacts(
            proj_path, registry, dry_run=False, project_name=name,
            operation_context=operation_context,
        )
        for sl in plan["removed_symlinks"]:
            print(f"  {c('✗', RED)} removed {sl}")
        for me in plan["removed_mcp_entries"]:
            print(f"  {c('✗', RED)} removed mcp entry {me['name']} from {me['file']}")
        for hs in plan["removed_hook_sidecars"]:
            print(f"  {c('✗', RED)} removed {hs['harness']} hooks for '{name}'")
        for w in plan["warnings"]:
            print(f"  {c('!', YELLOW)} {w}")

        # ships_with lifecycle (plan 1 W3): every companion this project's
        # own ledger claims (agents/hooks/permission rules) is deprovisioned
        # BEFORE the project block is dropped — otherwise a shared user-scope
        # agent, a hook definition, or a committed permission rule would be
        # stranded with no ledger left to reclaim it.
        from skill_hub.domain.skills import ships_with
        from skill_hub.entrypoints.cli.skill import _remove_companions

        for skill_name in list(ships_with.ledger(projects[name]).keys()):
            removed = _remove_companions(
                registry, skill_name, name, operation_context=operation_context
            )
            for kind in ("agents", "hooks", "permissions"):
                for item in removed.get(kind, []):
                    label = item if isinstance(item, str) else item.get("pattern")
                    print(f"  {c('✗', RED)} removed {kind[:-1]} companion: {label}")

        del projects[name]
        registry["projects"] = projects
        hub_core.save_registry(registry)
    print(f"{c('✓', GREEN)} removed project '{name}' from registry.")


@registry_mutation("project-edit-path")
def cmd_project_edit_path(args):
    operation_context = _ensure_operation_context(args)
    import hub

    registry = hub_core.load_registry()
    projects = registry.get("projects", {})
    name = args.name

    if name not in projects:
        fail(f"Unknown project '{name}'.")

    new_path = Path(args.new_path).expanduser()
    if not new_path.exists() or not new_path.is_dir():
        fail(f"New path does not exist or is not a directory: {new_path}")
    new_resolved = new_path.resolve()

    for other_name, other_cfg in projects.items():
        if other_name == name:
            continue
        if Path(other_cfg["path"]).expanduser().resolve() == new_resolved:
            fail(f"Path already used by project '{other_name}'")

    old_path = expand(projects[name]["path"])

    with data_home_lock():
        # Best-effort cleanup of old path (incl. this project's hook artifacts;
        # the next sync re-creates them at the new path).
        plan = clean_project_artifacts(
            old_path, registry, dry_run=False, project_name=name,
            operation_context=operation_context,
        )
        for sl in plan["removed_symlinks"]:
            print(f"  {c('✗', RED)} removed {sl}")
        for hs in plan["removed_hook_sidecars"]:
            print(f"  {c('✗', RED)} removed {hs['harness']} hooks for '{name}'")
        for w in plan["warnings"]:
            print(f"  {c('!', YELLOW)} {w}")
        projects[name]["path"] = str(new_resolved)
        if old_path.resolve() != new_resolved:
            from skill_hub.infrastructure.registry import loadout_bindings

            loadout_bindings.invalidate_source(registry, name, "source_path_changed")
        # The new path was validated to be an existing directory above, so the
        # restore-time quarantine no longer applies. Clearing it here is what
        # makes `project_sync_skip_reason`'s promise ("Cleared by `hub project
        # edit-path`") true and what makes the restore report's advice actually
        # work: without it a restored project stayed skipped by every sync
        # FOREVER, no matter where it was re-pointed, and nothing said why.
        was_quarantined = bool(projects[name].pop("path_unresolved", False))
        hub_core.save_registry(registry)
        print(f"  {c('✓', GREEN)} updated path: {old_path} → {new_resolved}")
        if was_quarantined:
            print(
                f"  {c('✓', GREEN)} cleared the restore quarantine "
                f"(path_unresolved) — sync writes to this project again"
            )

    # The path write above is already durable. A downstream sync-stream
    # failure (e.g. skill sources still missing after a restore, F3) must
    # never unwind or mask that success: `hub._auto_sync()` bare `sys.exit`s
    # on stream write errors (rc 1) or doctor danger findings (rc 2), and
    # `@registry_mutation` re-raises any non-2 code without an audit record,
    # which used to make the whole command look like it failed — a false
    # "couldn't update path" for a path that WAS saved. `_auto_sync_tail()`
    # absorbs that SystemExit and reports whether the trailing sync came
    # back clean instead.
    synced = hub._auto_sync_tail(operation_context=operation_context)
    if not synced:
        print(
            f"  {c('!', YELLOW)} path saved, but the trailing sync did not "
            f"finish cleanly — see the warning above"
        )


def _project_state_file_renames(old: str, new: str) -> list[tuple[Path, Path]]:
    """Every name-keyed sidecar under ``state/`` that belongs to project ``old``,
    paired with its path under the new name.

    The per-scope slug is ``project-<name>`` (``ProjectScope.slug``), with a
    ``-local`` sub-tier, and it prefixes the permission / hooks / rules managed
    sidecars (``state/<harness>/``), the reconcile kept-decisions store
    (``state/reconcile/``) and the lsp-report config
    (``state/hooks/lsp-report.<slug>.json``). Only those directories are
    walked, one level deep: a remote's ownership sidecar (``state/remote_<id>/``)
    is keyed by artifact name and a file there that happens to start with
    ``project-`` is not ours to touch. Backups under ``_hub-backups/`` are
    history and keep their old name.
    """
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    root = data_home() / "state"
    if not root.is_dir():
        return []
    prefixes = (
        (f"project-{old}.", f"project-{new}."),
        (f"project-{old}-local.", f"project-{new}-local."),
        (f"lsp-report.project-{old}.", f"lsp-report.project-{new}."),
        (f"lsp-report.project-{old}-local.", f"lsp-report.project-{new}-local."),
    )
    slug_dirs = sorted({*_harnesses.HARNESSES, "reconcile", "hooks"})
    moves: list[tuple[Path, Path]] = []
    for sub in (root / d for d in slug_dirs):
        if not sub.is_dir():
            continue
        for f in sorted(p for p in sub.iterdir() if p.is_file()):
            for old_prefix, new_prefix in prefixes:
                if f.name.startswith(old_prefix):
                    moves.append((f, sub / (new_prefix + f.name[len(old_prefix) :])))
                    break
    return moves


@registry_mutation("project-rename")
def cmd_project_rename(args):
    """Rename a registered project. The path and every setting move with the
    key; name-keyed sidecars under ``state/`` follow so the next sync still
    knows which native-file keys it manages."""
    import hub

    operation_context = _ensure_operation_context(args)

    registry = hub_core.load_registry()
    projects = registry.get("projects", {})
    old_name = args.name
    new_name = args.new_name

    if old_name not in projects:
        fail(f"Unknown project '{old_name}'.")
    validate_slug(new_name, label="project name")
    if new_name == old_name:
        print(f"Project '{old_name}' already has that name.")
        return
    if new_name in projects:
        fail(f"Project '{new_name}' already exists.")

    moves = _project_state_file_renames(old_name, new_name)
    for _src, dst in moves:
        if dst.exists():
            fail(f"State file already exists for '{new_name}': {dst}")

    with data_home_lock():
        registry["projects"] = {(new_name if k == old_name else k): v for k, v in projects.items()}
        from skill_hub.infrastructure.registry import loadout_bindings

        loadout_bindings.rename_source(registry, old_name, new_name)
        hub_core.save_registry(registry)
        for src, dst in moves:
            src.rename(dst)
            print(f"  {c('→', CYAN)} moved {src.name} → {dst.name}")
        print(f"{c('✓', GREEN)} renamed project '{old_name}' → '{new_name}'")

    hub._auto_sync(operation_context=operation_context)


def cmd_project_agent_docs(args):
    """Show a project's Agent Docs preferences (read-only)."""
    registry = hub_core.load_registry()
    projects = registry.get("projects") or {}
    name = args.name
    if name not in projects:
        fail(f"Unknown project '{name}'.")

    from skill_hub.infrastructure.filesystem import agent_docs

    prefs = dict(projects[name].get("agent_docs") or {})
    # The legacy suggest_companion_links preference is no longer honored; drop
    # it from the display (a residual key in the registry is tolerated).
    prefs.pop("suggest_companion_links", None)
    prefs["effective_strategy"] = agent_docs.resolve_strategy(projects[name], registry)
    print(json.dumps(prefs, indent=2, sort_keys=True))


def cmd_project_harnesses(args):
    """Show or mutate a project's per-project `harnesses` list."""
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    operation_context = _ensure_operation_context(args)
    registry = hub_core.load_registry()
    projects = registry.get("projects") or {}
    name = args.name
    if name not in projects:
        fail(f"Unknown project '{name}'.")
    proj_cfg = projects[name]

    add = getattr(args, "add", None)
    remove = getattr(args, "remove", None)

    if add is None and remove is None:
        # Show
        global_set = set(registry.get("harnesses_global") or [])
        project_set = set(proj_cfg.get("harnesses") or [])
        installed = set(operation_context.installed_harness_ids or ())
        effective = operation_context.effective_harness_ids(proj_cfg, registry)
        print(f"\n{c(f'Project: {name}', BOLD)}")
        print(f"  global    : {sorted(global_set) or '(none)'}")
        print(f"  project   : {sorted(project_set) or '(none)'}")
        print(f"  effective : {sorted(effective) or '(none)'}")
        print()
        return

    with data_home_lock():
        registry = hub_core.load_registry()
        proj_cfg = registry["projects"][name]
        current = list(proj_cfg.get("harnesses") or [])
        if add:
            for h_id in [v.strip() for v in add.split(",") if v.strip()]:
                if h_id not in _harnesses.HARNESSES:
                    print(
                        f"  {c('!', YELLOW)} unknown harness id '{h_id}' — adding anyway (forward-compat)",
                        file=sys.stderr,
                    )
                if h_id not in current:
                    current.append(h_id)
        if remove:
            for h_id in [v.strip() for v in remove.split(",") if v.strip()]:
                current = [v for v in current if v != h_id]
        proj_cfg["harnesses"] = current
        hub_core.save_registry(registry)
        print(f"{c('✓', GREEN)} project '{name}' harnesses: {current}")
    import hub

    hub._auto_sync(operation_context=operation_context)


def cmd_project_invocation(args):
    """Show or mutate a project's per-skill invocation overrides.

    No flags → table of active claude-skills (library mode / override /
    effective) plus any inert overrides. `--skill S --mode M` sets an override
    (`inherit` clears it). Overrides are gated to project-synced scopes —
    a `scope: global` skill lives at the user level, which Claude Code lets
    win over any project-level copy, so an override could never take effect.
    """
    import hub
    from skill_hub.entrypoints.cli.skill import invocation_status

    operation_context = _ensure_operation_context(args)
    read_only = getattr(args, "skill", None) is None and getattr(args, "mode", None) is None
    registry = hub._read_registry_optional() if read_only else hub_core.load_registry()
    projects = registry.get("projects") or {}
    name = args.name
    if name not in projects:
        fail(f"Unknown project '{name}'.")
    proj_cfg = projects[name]
    skills = registry.get("skills") or {}

    skill = getattr(args, "skill", None)
    mode = getattr(args, "mode", None)

    if skill is None and mode is None:
        overrides = proj_cfg.get("invocation_overrides") or {}
        active = [
            n
            for n in hub.resolve_project_skills(proj_cfg, registry)
            if skills.get(n, {}).get("type") != "mcp-server" and n in skills
        ]
        rows = []
        for n in active:
            cfg = skills[n]
            library = hub.skill_invocation(cfg)
            override = overrides.get(n)
            gated = cfg.get("scope", "portable") == "global" and override is not None
            effective_mode = override if (override and not gated) else library
            rows.append(
                {
                    "skill": n,
                    "scope": cfg.get("scope", "portable"),
                    "library": library,
                    "override": override,
                    "effective": effective_mode,
                    "inert": gated,
                    "outcomes": invocation_status(
                        registry, n, name, operation_context=operation_context
                    )["outcomes"],
                }
            )
        stale = sorted(set(overrides) - set(active))
        if getattr(args, "json", False):
            print(
                json.dumps(
                    {"project": name, "skills": rows, "stale_overrides": stale},
                    indent=2,
                )
            )
            return
        print(f"\n{c(f'Project: {name}', BOLD)}")
        header = f"  {'SKILL':<28} {'SCOPE':<18} {'LIBRARY':<11} {'OVERRIDE':<11} EFFECTIVE"
        print(c(header, BOLD))
        for r in rows:
            note = c("  (inert: scope global)", YELLOW) if r["inert"] else ""
            print(
                f"  {r['skill']:<28} {r['scope']:<18} {r['library']:<11} "
                f"{r['override'] or '—':<11} {r['effective']}{note}"
            )
        for s in stale:
            print(f"  {c('!', YELLOW)} override '{overrides[s]}' for '{s}' is inert (skill not active on this project)")
        print()
        return

    if skill is None or mode is None:
        fail("--skill and --mode must be used together.")

    if skill not in skills:
        fail(f"Unknown skill '{skill}'.")
    cfg = skills[skill]

    with data_home_lock():
        registry = hub_core.load_registry()
        proj_cfg = registry["projects"][name]
        overrides = proj_cfg.get("invocation_overrides") or {}

        if mode == "inherit":
            if skill not in overrides:
                print(f"No invocation override for '{skill}' on '{name}'.")
                return
            del overrides[skill]
            if overrides:
                proj_cfg["invocation_overrides"] = overrides
            else:
                proj_cfg.pop("invocation_overrides", None)
            hub_core.save_registry(registry)
            print(f"{c('✓', GREEN)} '{skill}' on '{name}' inherits the library mode again")
        else:
            if mode not in hub.VALID_INVOCATIONS:
                fail(f"Invalid mode '{mode}'. Expected one of: {', '.join(hub.VALID_INVOCATIONS)}, inherit.")
            if cfg.get("type") == "mcp-server":
                fail("Invocation overrides apply to claude-skills only.")
            if cfg.get("scope", "portable") == "global":
                fail(
                    f"'{skill}' has scope: global — it lives at the user level, and "
                    f"Claude Code gives user-level skills precedence over project-level "
                    f"copies, so a per-project override could never take effect. "
                    f"Change the skill's library default instead: "
                    f"hub set-meta {skill} --invocation {mode}"
                )
            active = hub.resolve_project_skills(proj_cfg, registry)
            if skill not in active:
                print(
                    f"  {c('!', YELLOW)} '{skill}' is not active on '{name}' — the "
                    f"override is stored but inert until the skill is equipped",
                    file=sys.stderr,
                )
            if overrides.get(skill) == mode:
                print(f"'{skill}' on '{name}' is already overridden to {mode}.")
                return
            overrides[skill] = mode
            proj_cfg["invocation_overrides"] = overrides
            hub_core.save_registry(registry)
            print(f"{c('✓', GREEN)} '{skill}' on '{name}': invocation override → {mode}")

    hub._auto_sync(operation_context=operation_context)


# ─────────────────────────────────────────────────────────────────────────────
# hub project analytics (usage-loadout-analytics design D7)
# ─────────────────────────────────────────────────────────────────────────────


def cmd_project_analytics(args) -> None:
    """Show or mutate a project's `analytics.verify_prefixes` field — the
    extra Bash-command prefixes `usage_classify.classify_tool` counts as
    'verify' for this project only (design D4/D7).

    No flag: print the project's `verify_prefixes`, `--json` supported. The
    read path saves nothing and does not auto-sync (design D7, G24).
    `--verify-prefixes` replaces the whole list (an empty string clears it);
    `--add-verify-prefix` appends one entry (repeatable). Only those two
    mutating flags run under `registry_mutation` and auto-sync.
    """
    name = args.name
    replace = getattr(args, "verify_prefixes", None)
    additions = getattr(args, "add_verify_prefix", None) or []

    if replace is None and not additions:
        registry = hub_core.load_registry()
        projects = registry.get("projects") or {}
        if name not in projects:
            fail(f"Unknown project '{name}'.")
        prefixes = list((projects[name].get("analytics") or {}).get("verify_prefixes") or [])
        if getattr(args, "json", False):
            print(json.dumps({"project": name, "verify_prefixes": prefixes}, indent=2))
            return
        print(f"\n{c(f'Project: {name}', BOLD)}")
        if prefixes:
            for prefix in prefixes:
                print(f"  {prefix}")
        else:
            print(c("  (none)", DIM))
        print()
        return

    _project_analytics_set(args)


@registry_mutation("project-analytics")
def _project_analytics_set(args) -> None:
    import hub

    operation_context = _ensure_operation_context(args)
    name = args.name
    registry = hub_core.load_registry()
    projects = registry.get("projects") or {}
    if name not in projects:
        fail(f"Unknown project '{name}'.")
    proj_cfg = projects[name]
    analytics_cfg = dict(proj_cfg.get("analytics") or {})
    prefixes = list(analytics_cfg.get("verify_prefixes") or [])

    replace = getattr(args, "verify_prefixes", None)
    if replace is not None:
        prefixes = [v.strip() for v in replace.split(",") if v.strip()] if replace else []
    for item in getattr(args, "add_verify_prefix", None) or []:
        if item not in prefixes:
            prefixes.append(item)

    if prefixes:
        analytics_cfg["verify_prefixes"] = prefixes
        proj_cfg["analytics"] = analytics_cfg
    else:
        proj_cfg.pop("analytics", None)
    hub_core.save_registry(registry)
    print(f"{c('✓', GREEN)} project '{name}' analytics.verify_prefixes: {prefixes}")
    hub._auto_sync(operation_context=operation_context)
