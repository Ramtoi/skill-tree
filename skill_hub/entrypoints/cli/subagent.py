"""`hub subagent` — manage sub-agents in place (claude-code, codex).

See `subagents.py` + the claude-subagents-manager change for the model logic;
these handlers marshal args/JSON in and out.

Carved out of `hub.py` — see `hub_cli/__init__.py` for the module contract
this file implements (`NAME`, `register`, `dispatch`).
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Optional

from skill_hub import hub_core
from skill_hub.hub_core import (
    data_home_lock,
    expand,
    fail,
)

NAME = "subagent"

p_sa = None


def register(sub) -> None:
    global p_sa

    p_sa = sub.add_parser("subagent", help="Manage sub-agents in place (claude-code, codex)")
    sa_sub = p_sa.add_subparsers(dest="subagent_cmd")

    def _add_scope_args(p, require_name=False):
        p.add_argument("--scope", choices=["user", "project"], default="user",
                       help="user (~/.claude/agents) or project (<path>/.claude/agents)")
        p.add_argument("--project", help="project name (required for --scope project)")
        p.add_argument("--harness", default="claude-code",
                       help="harness id (claude-code | codex; default claude-code)")
        if require_name:
            p.add_argument("--name", required=True, help="agent name (the `name:` field)")
        p.add_argument("--json", action="store_true", help="Emit JSON (always JSON for subagent)")

    p_sa_list = sa_sub.add_parser("list", help="List sub-agents in a scope")
    _add_scope_args(p_sa_list)

    p_sa_show = sa_sub.add_parser("show", help="Show one sub-agent (safe+advanced+body)")
    _add_scope_args(p_sa_show, require_name=True)

    p_sa_save = sa_sub.add_parser("save", help="Save a sub-agent (JSON payload on stdin)")
    p_sa_save.add_argument("--json", action="store_true", help="Emit JSON")

    p_sa_del = sa_sub.add_parser("delete", help="Delete a sub-agent (backup + strip deny)")
    _add_scope_args(p_sa_del, require_name=True)
    p_sa_del.add_argument("--link-action", dest="link_action",
                          choices=["this", "both"], default="this",
                          help="linked agents: delete only this harness's file "
                               "(unlink the pair) or both twins (default: this)")

    p_sa_dis = sa_sub.add_parser("set-disabled", help="Toggle Agent(<name>) deny entry")
    _add_scope_args(p_sa_dis, require_name=True)
    p_sa_dis.add_argument("--disabled", required=True, choices=["true", "false"],
                          help="true to disable, false to enable")

    p_sa_usage = sa_sub.add_parser("skill-usage", help="Reverse index skill → sub-agents")
    p_sa_usage.add_argument("--json", action="store_true", help="Emit JSON")

    p_sa_attach = sa_sub.add_parser(
        "attachable-skills",
        help="List registry/on-disk skills with attachability for the picker")
    _add_scope_args(p_sa_attach)

    p_sa_link = sa_sub.add_parser(
        "link", help="Link the same-named agent across harnesses (linked twins)")
    p_sa_link.add_argument("--name", required=True, help="agent name (link identity)")
    p_sa_link.add_argument("--scope", choices=["user"], default="user",
                           help="user scope only in this release")
    p_sa_link.add_argument("--harnesses",
                           help="comma-separated harness ids (default: all agent-capable)")
    p_sa_link.add_argument("--copy-from", dest="copy_from",
                           help="when the agent is missing in a harness, project the "
                                "shared core from this harness (model not carried)")
    p_sa_link.add_argument("--json", action="store_true", help="Emit JSON (always JSON)")

    p_sa_unlink = sa_sub.add_parser(
        "unlink", help="Remove the link sidecar entry (files untouched)")
    p_sa_unlink.add_argument("--name", required=True, help="agent name")
    p_sa_unlink.add_argument("--scope", choices=["user"], default="user",
                             help="user scope only in this release")
    p_sa_unlink.add_argument("--json", action="store_true", help="Emit JSON (always JSON)")

    p_sa_lstatus = sa_sub.add_parser(
        "link-status", help="Links (twin-lost + drift) and same-name suggestions")
    p_sa_lstatus.add_argument("--scope", choices=["user"], default="user",
                              help="user scope only in this release")
    p_sa_lstatus.add_argument("--json", action="store_true", help="Emit JSON (always JSON)")

    p_sa_resolve = sa_sub.add_parser(
        "resolve-drift",
        help="Resolve linked-twin drift per field (decisions JSON on stdin)")
    p_sa_resolve.add_argument("--name", required=True, help="agent name")
    p_sa_resolve.add_argument("--scope", choices=["user"], default="user",
                              help="user scope only in this release")
    p_sa_resolve.add_argument("--json", action="store_true", help="Emit JSON (always JSON)")

    p_sa_prov = sa_sub.add_parser(
        "provision-skill",
        help="Provision an attached skill so an agent's skills: reference resolves")
    p_sa_prov.add_argument("--skill", required=True, help="skill name to provision")
    p_sa_prov_scope = p_sa_prov.add_mutually_exclusive_group(required=True)
    p_sa_prov_scope.add_argument(
        "--global", dest="global_scope", action="store_true",
        help="make the skill global (scope: global; every installed harness)")
    p_sa_prov_scope.add_argument(
        "--project", dest="project",
        help="enable + resync the skill for this project")
    p_sa_prov.add_argument("--harness", default="claude-code",
                           help="the agent's harness (affinity + verify target; "
                                "default claude-code)")
    p_sa_prov.add_argument("--widen-affinity", dest="widen_affinity",
                           action="store_true",
                           help="clear a harnesses: restriction that excludes --harness")
    p_sa_prov.add_argument("--json", action="store_true", help="Emit JSON (always JSON)")


def dispatch(args) -> None:
    sc = getattr(args, "subagent_cmd", None)
    if sc == "list":
        cmd_subagent_list(args)
    elif sc == "show":
        cmd_subagent_show(args)
    elif sc == "save":
        cmd_subagent_save(args)
    elif sc == "delete":
        cmd_subagent_delete(args)
    elif sc == "set-disabled":
        cmd_subagent_set_disabled(args)
    elif sc == "skill-usage":
        cmd_subagent_skill_usage(args)
    elif sc == "attachable-skills":
        cmd_subagent_attachable_skills(args)
    elif sc == "link":
        cmd_subagent_link(args)
    elif sc == "unlink":
        cmd_subagent_unlink(args)
    elif sc == "link-status":
        cmd_subagent_link_status(args)
    elif sc == "resolve-drift":
        cmd_subagent_resolve_drift(args)
    elif sc == "provision-skill":
        cmd_subagent_provision_skill(args)
    else:
        p_sa.print_help()


# ─────────────────────────────────────────────────────────────────────────────
# Sub-agents (Claude Code) — see subagents.py + the claude-subagents-manager change
# ─────────────────────────────────────────────────────────────────────────────


def _subagent_registry() -> dict:
    """Registry for path/skill resolution — optional (project scope needs it)."""
    import hub

    return hub._read_registry_optional()


def _subagent_context(registry: dict, harness_ids, *, include_twins: bool = False) -> Any:
    """Build one cache-only context for a sub-agent command."""
    from skill_hub.application.harnesses.harness_operation_context import build_operation_context

    requested_ids = {str(h) for h in harness_ids if h}
    if include_twins:
        from skill_hub.infrastructure.harnesses.subagent_links import agent_capable_harness_ids

        requested_ids.update(agent_capable_harness_ids())
    ids = sorted(requested_ids)
    return build_operation_context(
        data_home=hub_core.data_home(), harness_ids=ids,
        requested_features=("subagents",), force_refresh=False,
        installed_harness_ids=ids,
    )


def cmd_subagent_list(args):
    from skill_hub.infrastructure.harnesses import subagents

    scope = getattr(args, "scope", "user")
    project = getattr(args, "project", None)
    harness = getattr(args, "harness", None) or "claude-code"
    registry = _subagent_registry()
    try:
        result = subagents.list_agents(scope, project, registry, harness,
                                       context=_subagent_context(registry, [harness], include_twins=True))
    except ValueError as e:
        fail(str(e))
        return
    print(json.dumps(result, indent=2, ensure_ascii=False))


def cmd_subagent_show(args):
    from skill_hub.infrastructure.harnesses import subagents

    scope = getattr(args, "scope", "user")
    project = getattr(args, "project", None)
    harness = getattr(args, "harness", None) or "claude-code"
    registry = _subagent_registry()
    try:
        result = subagents.show_agent(args.name, scope, project, registry, harness,
                                      context=_subagent_context(registry, [harness], include_twins=True))
    except ValueError as e:
        fail(str(e))
        return
    print(json.dumps(result, indent=2, ensure_ascii=False))


def cmd_subagent_save(args):
    from skill_hub.infrastructure.harnesses import subagents

    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "errors": [
            {"field": "payload", "level": "error",
             "message": f"invalid JSON payload on stdin: {e}", "value": ""}]}))
        sys.exit(1)
    if not isinstance(payload, dict) or not isinstance(payload.get("safe"), dict):
        print(json.dumps({"ok": False, "errors": [
            {"field": "payload", "level": "error",
             "message": "payload must be an object with a 'safe' object", "value": ""}]}))
        sys.exit(1)
    with data_home_lock():
        try:
            registry = _subagent_registry()
            harness = payload.get("harness") or "claude-code"
            result = subagents.save_agent(
                payload, registry, context=_subagent_context(registry, [harness], include_twins=True))
        except ValueError as e:
            result = {"ok": False, "errors": [
                {"field": "scope", "level": "error", "message": str(e), "value": ""}]}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result.get("ok"):
        sys.exit(1)


def cmd_subagent_delete(args):
    from skill_hub.infrastructure.harnesses import subagents

    scope = getattr(args, "scope", "user")
    project = getattr(args, "project", None)
    harness = getattr(args, "harness", None) or "claude-code"
    link_action = getattr(args, "link_action", None) or "this"
    with data_home_lock():
        try:
            registry = _subagent_registry()
            context_ids = [harness]
            if link_action == "both":
                context_ids = ["claude-code", "codex"]
            result = subagents.delete_agent(
                args.name, scope, project, registry, harness, link_action,
                context=_subagent_context(registry, context_ids))
        except ValueError as e:
            result = {"ok": False, "errors": [
                {"field": "scope", "level": "error", "message": str(e), "value": ""}]}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result.get("ok"):
        sys.exit(1)


def cmd_subagent_set_disabled(args):
    from skill_hub.infrastructure.harnesses import subagents

    scope = getattr(args, "scope", "user")
    project = getattr(args, "project", None)
    disabled = str(getattr(args, "disabled", "")).strip().lower() in ("true", "1", "yes")
    harness = getattr(args, "harness", None) or "claude-code"
    with data_home_lock():
        try:
            registry = _subagent_registry()
            state = subagents.set_disabled(
                args.name, disabled, scope, project, registry, harness,
                context=_subagent_context(registry, [harness]))
        except ValueError as e:
            fail(str(e))
            return
    print(json.dumps({"ok": True, "disabled": state}, indent=2, ensure_ascii=False))


def cmd_subagent_skill_usage(args):
    from skill_hub.infrastructure.harnesses import subagents

    registry = _subagent_registry()
    result = subagents.skill_usage(registry,
                                   context=_subagent_context(registry, ("claude-code", "codex")))
    print(json.dumps(result, indent=2, ensure_ascii=False))


def cmd_subagent_attachable_skills(args):
    from skill_hub.infrastructure.harnesses import subagents

    scope = getattr(args, "scope", "user")
    project = getattr(args, "project", None)
    harness = getattr(args, "harness", None) or "claude-code"
    registry = _subagent_registry()
    try:
        result = subagents.attachable_skills(
            scope, project, registry, harness,
            context=_subagent_context(registry, [harness]))
    except ValueError as e:
        fail(str(e))
        return
    print(json.dumps(result, indent=2, ensure_ascii=False))


def cmd_subagent_link(args):
    """Link the same-named agent across harnesses (linked twins, D3)."""
    from skill_hub.infrastructure.harnesses import subagent_links

    harnesses_arg = getattr(args, "harnesses", None)
    hs = ([h.strip() for h in harnesses_arg.split(",") if h.strip()]
          if harnesses_arg else None)
    with data_home_lock():
        try:
            registry = _subagent_registry()
            result = subagent_links.link_agents(
                args.name, hs, getattr(args, "scope", "user"),
                registry, getattr(args, "copy_from", None),
                context=_subagent_context(registry, hs or ("claude-code", "codex")))
        except ValueError as e:
            result = {"ok": False, "error": str(e)}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result.get("ok"):
        sys.exit(1)


def cmd_subagent_unlink(args):
    """Remove the link sidecar entry; native files untouched."""
    from skill_hub.infrastructure.harnesses import subagent_links

    with data_home_lock():
        try:
            registry = _subagent_registry()
            result = subagent_links.unlink_agents(
                args.name, getattr(args, "scope", "user"),
                context=_subagent_context(registry, ("claude-code", "codex")))
        except ValueError as e:
            result = {"ok": False, "error": str(e)}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result.get("ok"):
        sys.exit(1)


def cmd_subagent_link_status(args):
    """Links (with twin-lost + drift) and same-name suggestions for a scope."""
    from skill_hub.infrastructure.harnesses import subagent_links

    try:
        registry = _subagent_registry()
        result = subagent_links.link_status(getattr(args, "scope", "user"),
                                            registry,
                                            context=_subagent_context(registry, ("claude-code", "codex")))
    except ValueError as e:
        fail(str(e))
        return
    print(json.dumps(result, indent=2, ensure_ascii=False))


def cmd_subagent_resolve_drift(args):
    """Resolve linked-twin drift per field. Decisions JSON on stdin:
    {"decisions": {"description": "codex", ...}} — winner harness id per field."""
    from skill_hub.infrastructure.harnesses import subagent_links

    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False,
                          "error": f"invalid JSON payload on stdin: {e}"}))
        sys.exit(1)
    decisions = payload.get("decisions") if isinstance(payload, dict) else None
    if not isinstance(decisions, dict) or not decisions:
        print(json.dumps({"ok": False,
                          "error": "payload must be an object with a non-empty 'decisions' object"}))
        sys.exit(1)
    with data_home_lock():
        try:
            registry = _subagent_registry()
            result = subagent_links.resolve_drift(
                args.name, getattr(args, "scope", "user"),
                registry, decisions,
                context=_subagent_context(registry, ("claude-code", "codex")))
        except ValueError as e:
            result = {"ok": False, "error": str(e)}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result.get("ok"):
        sys.exit(1)


def _capture_provision_path(path: Path) -> tuple[str, object]:
    """Capture the small amount of state a provisioning link can replace."""
    if path.is_symlink():
        return ("symlink", os.readlink(path))
    if path.is_file():
        return ("file", path.read_bytes())
    if path.exists():
        return ("other", None)
    return ("missing", None)


def _restore_provision_paths(changes: dict[Path, tuple[str, object]]) -> None:
    """Restore only paths touched by this provisioning attempt."""
    for path, (kind, value) in changes.items():
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.exists():
            # A directory at a skill-link path is foreign state. Do not remove
            # it while recovering a failed attempt.
            continue
        if kind == "missing" or kind == "other":
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        if kind == "symlink":
            path.symlink_to(str(value))
        elif kind == "file":
            path.write_bytes(value)  # type: ignore[arg-type]


def _provision_route_available(operation_context: Any, harness_id: str) -> bool:
    """Only legacy-shadow routes may use the native provisioning writer."""
    route_for = getattr(operation_context, "route", None)
    if not callable(route_for):
        return False
    try:
        route = route_for(harness_id, "skills")
    except (OSError, TypeError, ValueError, KeyError):
        return False
    return (
        getattr(route, "status", None) == "shadow"
        and getattr(route, "mode", None) == "legacy_shadow"
    )


def _provision_project_skill(
    proj_cfg: dict, registry: dict, skill_name: str, installed: set[str],
    *, operation_context: Any = None,
) -> dict[Path, tuple[str, object]]:
    """Targeted resync of ONE skill for ONE project: symlink its source into each
    effective harness's project_skills_dir (honoring the skill's `harnesses:`
    affinity). Mirrors the per-skill inner loop of `_sync_project_skills` without
    touching any other skill or running cleanup — so it never disturbs unrelated
    links. No-op if the source is missing."""
    import hub
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    if hub.project_sync_skip_reason(proj_cfg):
        return {}
    skills = registry.get("skills", {})
    cfg = skills[skill_name]
    src = hub.skill_source(cfg)
    if not src.exists():
        return {}
    src = hub.effective_skill_source(skill_name, cfg)
    proj_path = expand(proj_cfg["path"])
    if operation_context is not None:
        effective_for = getattr(operation_context, "effective_harness_ids", None)
        effective = (
            set(effective_for(proj_cfg, registry)) if callable(effective_for)
            else (set(registry.get("harnesses_global") or ())
                  | set(proj_cfg.get("harnesses") or ())) & set(installed)
        )
        effective &= set(installed)
    else:
        effective = _harnesses.resolve_effective(proj_cfg, registry, installed=installed)
    affinity = hub._skill_affinity(cfg)
    targets = effective & affinity if affinity is not None else effective
    blocked_dirs: set[Path] = set()
    if operation_context is not None:
        captured_dirs: dict[Path, set[str]] = {}
        for h_id, captured_layout in operation_context.layouts.items():
            captured_dir = proj_path / Path(str(captured_layout.project_skills_dir))
            captured_dirs.setdefault(captured_dir, set()).add(h_id)
        blocked_dirs = {
            target_dir
            for target_dir, participants in captured_dirs.items()
            if target_dir.is_symlink()
            or any(
                not _provision_route_available(operation_context, h_id)
                for h_id in participants
            )
        }
    target_participants: dict[Path, set[str]] = {}
    for h_id in targets:
        if operation_context is not None:
            layout = operation_context.layout(h_id)
            if layout is None:
                continue
            target_dir = proj_path / Path(str(layout.project_skills_dir))
        else:
            h = _harnesses.HARNESSES[h_id]
            target_dir = proj_path / Path(str(h.project_skills_dir))
        target_participants.setdefault(target_dir, set()).add(h_id)
    target_dirs = {
        target_dir
        for target_dir, participants in target_participants.items()
        if operation_context is None
        or (
            target_dir not in blocked_dirs
            and all(
                _provision_route_available(operation_context, h_id)
                for h_id in participants
            )
        )
    }
    changes: dict[Path, tuple[str, object]] = {}
    try:
        for target_dir in target_dirs:
            # A symlinked project directory may be foreign or shared. Follow
            # neither it nor a foreign real skill directory in place.
            if target_dir.is_symlink():
                continue
            link = target_dir / skill_name
            if link.is_dir() and not link.is_symlink():
                continue
            changes.setdefault(link, _capture_provision_path(link))
            hub.ensure_symlink(link, src)
    except Exception:
        _restore_provision_paths(changes)
        raise
    return changes


def _provision_skill(
    skill_name: str, project: Optional[str], is_global: bool,
    harness_id: str, widen: bool, *, operation_context: Any = None,
) -> dict:
    """Two-phase provisioning (design D5). Runs a TARGETED sync — never bare
    cmd_sync. All guards run BEFORE any mutation; the human sync log is redirected
    to stderr so the caller's JSON stays clean on stdout. Returns
    {ok, skill, mode, path, widened_affinity} or {ok:false, error, ...}."""
    import hub
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    if operation_context is not None:
        installed_ids = set(getattr(operation_context, "installed_harness_ids", ()) or ())
        layout = operation_context.layout(harness_id)
        route_for = getattr(operation_context, "route", None)
        if layout is None or harness_id not in installed_ids or not callable(route_for):
            return {"ok": False, "error": f"harness '{harness_id}' route is unavailable"}
        for feature in ("skills", "subagents"):
            try:
                route = route_for(harness_id, feature)
            except (OSError, TypeError, ValueError, KeyError):
                return {"ok": False, "error": f"harness '{harness_id}' route is unavailable"}
            if (getattr(route, "status", None) != "shadow"
                    or getattr(route, "mode", None) != "legacy_shadow"):
                return {"ok": False, "error": f"harness '{harness_id}' route is unavailable"}
        h = None
    else:
        h = _harnesses.HARNESSES.get(harness_id)
        if h is None:
            return {"ok": False, "error": f"unknown harness '{harness_id}'"}
        if h.agents_dir is None:
            return {"ok": False,
                    "error": f"harness '{harness_id}' does not support sub-agent definitions"}

    with data_home_lock():
        registry = hub_core.load_registry()
        skills = registry.get("skills", {})
        projects = registry.get("projects", {})

        cfg = skills.get(skill_name)
        if cfg is None:
            return {"ok": False,
                    "error": f"unknown skill '{skill_name}' (not in the registry)"}

        # Guard 1 — remote quarantine (hard refuse; no override in this change).
        origin = str(cfg.get("origin") or "")
        if origin.startswith("remote:"):
            remote_id = origin[len("remote:"):] or "?"
            return {"ok": False,
                    "error": (
                        f"skill '{skill_name}' is quarantined (imported from remote "
                        f"'{remote_id}'). Remote-origin skills are held project-specific "
                        f"by design and cannot be provisioned global/project — no override.")}

        if is_global == bool(project):
            return {"ok": False,
                    "error": "provision-skill requires exactly one of --global or --project"}

        # Guard 2 — affinity: a `harnesses:` restriction excluding this agent's
        # harness would make the global/project link dangle. Clear it with
        # --widen-affinity, else refuse.
        affinity = hub._skill_affinity(cfg)
        # Snapshot everything the command may mutate so a failed verification
        # rolls the registry back — provisioning must never persist a
        # half-applied state (a stuck `scope: global` would fan the skill out
        # to every harness on all later syncs; a stuck `enabled` entry and a
        # cleared affinity likewise outlive the reported failure).
        prev_affinity = cfg.get("harnesses")
        prev_scope = cfg.get("scope")
        widened = False
        if affinity is not None and harness_id not in affinity:
            if not widen:
                return {"ok": False,
                        "error": (
                            f"skill '{skill_name}' is restricted to harnesses "
                            f"{sorted(affinity)}, which excludes '{harness_id}'; the "
                            f"provisioned link would dangle. Pass --widen-affinity to "
                            f"clear the restriction."),
                        "affinity": sorted(affinity),
                        "widen_available": True}
            cfg.pop("harnesses", None)  # clear the narrowing entirely
            widened = True

        installed = (
            set(getattr(operation_context, "installed_harness_ids", ()) or ())
            if operation_context is not None else _harnesses.detect_installed()
        )

        def _rollback():
            if prev_affinity is not None:
                cfg["harnesses"] = prev_affinity
            else:
                cfg.pop("harnesses", None)
            if prev_scope is not None:
                cfg["scope"] = prev_scope
            else:
                cfg.pop("scope", None)

        if project is not None:
            pcfg = projects.get(project)
            if pcfg is None:
                return {"ok": False, "error": f"unknown project '{project}'"}
            prev_enabled = list(pcfg.get("enabled") or [])
            enabled = list(prev_enabled)
            if skill_name not in enabled:
                enabled.append(skill_name)
                pcfg["enabled"] = enabled
            hub_core.save_registry(registry)
            project_changes: dict[Path, tuple[str, object]] = {}
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    project_changes = _provision_project_skill(
                        pcfg, registry, skill_name, installed,
                        operation_context=operation_context)
            except Exception as e:
                _rollback()
                pcfg["enabled"] = prev_enabled
                hub_core.save_registry(registry)
                _restore_provision_paths(project_changes)
                return {"ok": False,
                        "error": (f"provisioning failed for '{skill_name}': {e}. "
                                  f"No registry changes were kept.")}
            proj_path = expand(pcfg["path"])
            if operation_context is not None:
                expected = proj_path / Path(str(layout.project_skills_dir)) / skill_name / "SKILL.md"
            else:
                assert h is not None
                expected = proj_path / Path(str(h.project_skills_dir)) / skill_name / "SKILL.md"
            if not expected.exists():
                _rollback()
                pcfg["enabled"] = prev_enabled
                hub_core.save_registry(registry)
                _restore_provision_paths(project_changes)
                return {"ok": False,
                        "error": (
                            f"provisioning did not resolve '{skill_name}' for project "
                            f"'{project}' on harness '{harness_id}' (expected {expected}). "
                            f"Is '{harness_id}' effective for the project? "
                            f"No registry changes were kept.")}
            return {"ok": True, "skill": skill_name, "mode": "project-enable",
                    "path": str(expected), "widened_affinity": widened}

        # Global path: flip scope, re-run ONLY the global-skills pass.
        global_changes: dict[Path, tuple[str, object]] = {}
        layouts = (
            operation_context.layouts.items()
            if operation_context is not None else _harnesses.HARNESSES.items()
        )
        for h_id, hh in layouts:
            if h_id not in installed:
                continue
            if operation_context is not None and not _provision_route_available(
                operation_context, h_id
            ):
                continue
            link = Path(str(hh.global_skills_dir)).expanduser() / skill_name
            global_changes.setdefault(link, _capture_provision_path(link))
        cfg["scope"] = "global"
        hub_core.save_registry(registry)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                hub._sync_global_skills(
                    registry, installed, operation_context=operation_context)
        except Exception as e:
            _rollback()
            hub_core.save_registry(registry)
            _restore_provision_paths(global_changes)
            return {"ok": False,
                    "error": (f"provisioning failed for '{skill_name}': {e}. "
                              f"No registry changes were kept.")}
        if operation_context is not None:
            expected = Path(str(layout.global_skills_dir)) / skill_name / "SKILL.md"
        else:
            assert h is not None
            expected = Path(str(h.global_skills_dir)).expanduser() / skill_name / "SKILL.md"
        if not expected.exists():
            _rollback()
            hub_core.save_registry(registry)
            _restore_provision_paths(global_changes)
            return {"ok": False,
                    "error": (
                        f"provisioning did not resolve '{skill_name}' at {expected} for "
                        f"harness '{harness_id}' (is it installed / admitted by affinity?). "
                        f"No registry changes were kept.")}
        return {"ok": True, "skill": skill_name, "mode": "make-global",
                "path": str(expected), "widened_affinity": widened}


def cmd_subagent_provision_skill(args):
    """Provision an attached skill so a sub-agent's `skills:` reference resolves
    (design D5, phase 2). Project path enables + resyncs the skill for the
    project; global path flips scope to global + re-runs the global-skills pass."""
    skill = args.skill
    project = getattr(args, "project", None)
    is_global = bool(getattr(args, "global_scope", False))
    harness = getattr(args, "harness", None) or "claude-code"
    widen = bool(getattr(args, "widen_affinity", False))
    operation_context = getattr(args, "_operation_context", None)
    if operation_context is None:
        from skill_hub.application.harnesses.harness_operation_context import KNOWN_HARNESSES, build_operation_context
        from skill_hub.infrastructure.harnesses import harnesses as _harnesses

        operation_context = build_operation_context(
            data_home=hub_core.data_home(), harness_ids=KNOWN_HARNESSES,
            requested_features=("subagents", "skills", "invocation"),
            force_refresh=False,
            installed_harness_ids=sorted(_harnesses.detect_installed()),
        )
        args._operation_context = operation_context
    result = _provision_skill(
        skill, project, is_global, harness, widen,
        operation_context=operation_context)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result.get("ok"):
        sys.exit(1)
