#!/usr/bin/env python3
"""
skill-hub — in-process control-plane MCP server (raw JSON-RPC 2.0 over stdio).

Exposes a curated set of Skill Hub control-plane tools by calling hub.py's
`cmd_*` functions in-process. WRITE access is limited to skills + bundles +
snippets + sync; permissions/harness are READ-ONLY. There are intentionally NO
permission/harness WRITE tools.

Snippet body input: tools that take a `body` accept the markdown text directly.
A literal "-" (which the CLI treats as "read stdin") is rejected, since stdin
here is the JSON-RPC channel.

Correctness contract (see the cmd_* functions in hub.py):
  * cmd_* print() to stdout — which is our JSON-RPC channel — so every call is
    wrapped in contextlib.redirect_stdout (and redirect_stderr) into a buffer.
  * cmd_* call hub.fail() -> sys.exit(1) on error, so every call catches
    SystemExit and turns it into a structured {ok:false} result.
  * The registry_mutation decorator on the mutating cmd_* already takes the
    re-entrant data-home lock and writes an audit record, so this server adds
    no locking/auditing of its own.
"""

import argparse
import contextlib
import io
import json
import os
import sys
import traceback

# Locate hub for import (also wires up vendored deps).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import hub  # noqa: E402

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "skill-hub"
SERVER_VERSION = "1.0.0"


# ─────────────────────────────────────────────────────────────────────────────
# cmd_* invocation harness
# ─────────────────────────────────────────────────────────────────────────────


def _run_capture(fn, ns):
    """Run a hub cmd_* with stdout/stderr captured separately and SystemExit trapped.

    Returns (ok, stdout, stderr, error). `ok` is False when the command exited
    non-zero (hub.fail / sys.exit) or raised. Keeping stdout and stderr separate
    lets JSON-emitting callers parse stdout alone — a stray stderr warning on an
    otherwise-successful call must not corrupt the parse.
    """
    out = io.StringIO()
    err = io.StringIO()
    error = None
    ok = True
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            fn(ns)
    except SystemExit as e:
        code = e.code
        if isinstance(code, int):
            ok = code == 0
        else:
            ok = code is None
        if not ok:
            error = "command exited with a non-zero status"
    except Exception as e:  # noqa: BLE001 — never let a cmd crash the server
        ok = False
        error = f"{type(e).__name__}: {e}"
        err.write(traceback.format_exc())
    return ok, out.getvalue(), err.getvalue(), error


def _call_cmd(fn, ns):
    """Run a hub cmd_* and return (ok, output, error) with stdout+stderr merged.

    `ok` is False when the command exited non-zero (hub.fail / sys.exit) or raised.
    """
    ok, stdout_text, stderr_text, error = _run_capture(fn, ns)
    captured = stdout_text
    if stderr_text:
        captured = (captured + "\n" + stderr_text) if captured else stderr_text
    if not ok and error is None:
        error = "command failed"
    # Prefer the human output as the error detail when we only have a generic msg.
    if not ok and captured.strip():
        error = captured.strip().splitlines()[-1] if not error else error
    return ok, captured.strip(), error


def _result(ok, result=None, output="", error=None):
    """Pack the standard tool result payload."""
    return {"ok": ok, "result": result, "output": output, "error": error}


def _call_cmd_json(fn, ns):
    """Run a cmd_* with ns.json=True and parse its stdout as the structured result.

    Many cmd_* functions emit a single JSON document on their `--json` path. We
    set it, run the command, and parse its stdout into the `result` field.
    Returns (ok, result, output, error); `result` is None when the command
    failed or its output wasn't parseable JSON (the raw text is still returned
    in `output`).
    """
    ns.json = True
    ok, stdout_text, stderr_text, error = _run_capture(fn, ns)
    if not ok:
        captured = stdout_text
        if stderr_text:
            captured = (captured + "\n" + stderr_text) if captured else stderr_text
        captured = captured.strip()
        if error is None:
            error = "command failed"
        # Prefer the human message (hub.fail prints to stdout) over the generic one.
        if captured and error == "command exited with a non-zero status":
            error = captured.splitlines()[-1]
        return False, None, captured, error
    # Parse stdout ALONE — a stray stderr warning (deprecation notices, unknown
    # harness ids) must not corrupt the JSON document the cmd printed to stdout.
    try:
        return True, json.loads(stdout_text), stdout_text.strip(), None
    except (ValueError, TypeError):
        # Succeeded but didn't emit clean JSON — hand back the raw text.
        return True, None, stdout_text.strip(), None


# ─────────────────────────────────────────────────────────────────────────────
# WRITE tools (skills + bundles only)
# ─────────────────────────────────────────────────────────────────────────────


def tool_skill_create(args):
    name = args.get("name")
    if not name:
        return _result(False, error="missing required argument 'name'")
    scope = args.get("scope") or "project-specific"
    ns = argparse.Namespace(
        kind="skill", name=name, scope=scope, description=None, type=None
    )
    ok, output, error = _call_cmd(hub.cmd_new, ns)
    if not ok:
        return _result(False, output=output, error=error)
    # cmd_new defaults scope to "portable" when unset, so always set_meta to honor
    # the requested (default project-specific) scope.
    meta_ns = argparse.Namespace(
        name=name,
        scope=scope,
        description=None,
        harnesses=None,
        version=None,
        upstream=None,
    )
    ok2, output2, error2 = _call_cmd(hub.cmd_set_meta, meta_ns)
    combined = (output + ("\n" + output2 if output2 else "")).strip()
    if not ok2:
        return _result(False, output=combined, error=error2)
    return _result(True, {"name": name, "scope": scope}, combined)


def tool_skill_set_meta(args):
    skill = args.get("skill")
    if not skill:
        return _result(False, error="missing required argument 'skill'")
    ns = argparse.Namespace(
        name=skill,
        scope=args.get("scope"),
        description=args.get("description"),
        harnesses=args.get("harnesses"),
        version=args.get("version"),
        upstream=args.get("upstream"),
    )
    ok, output, error = _call_cmd(hub.cmd_set_meta, ns)
    return _result(ok, {"skill": skill} if ok else None, output, error)


def tool_skill_rename(args):
    old_name = args.get("old_name")
    new_name = args.get("new_name")
    if not old_name or not new_name:
        return _result(False, error="missing required argument 'old_name'/'new_name'")
    dry_run = bool(args.get("dry_run", False))
    ns = argparse.Namespace(old_name=old_name, new_name=new_name, dry_run=dry_run)
    ok, output, error = _call_cmd(hub.cmd_rename, ns)
    return _result(
        ok,
        {"old_name": old_name, "new_name": new_name, "dry_run": dry_run} if ok else None,
        output,
        error,
    )


def tool_skill_archive(args):
    skill = args.get("skill")
    if not skill:
        return _result(False, error="missing required argument 'skill'")
    confirm = bool(args.get("confirm", False))
    dry_run = bool(args.get("dry_run", False))
    effective_dry_run = dry_run or (not confirm)
    ns = argparse.Namespace(skill=skill, dry_run=effective_dry_run)
    ok, output, error = _call_cmd(hub.cmd_archive, ns)
    applied = ok and (confirm and not dry_run)
    return _result(
        ok,
        {"skill": skill, "applied": applied} if ok else None,
        output,
        error,
    )


def tool_skill_enable(args):
    skill = args.get("skill")
    project = args.get("project")
    if not skill or not project:
        return _result(False, error="missing required argument 'skill'/'project'")
    ns = argparse.Namespace(skill=skill, project=project)
    ok, output, error = _call_cmd(hub.cmd_enable, ns)
    return _result(ok, {"skill": skill, "project": project} if ok else None, output, error)


def tool_skill_disable(args):
    skill = args.get("skill")
    project = args.get("project")
    if not skill or not project:
        return _result(False, error="missing required argument 'skill'/'project'")
    ns = argparse.Namespace(skill=skill, project=project)
    ok, output, error = _call_cmd(hub.cmd_disable, ns)
    return _result(ok, {"skill": skill, "project": project} if ok else None, output, error)


def tool_skill_import_project(args):
    name = args.get("name")
    project = args.get("project")
    if not name or not project:
        return _result(False, error="missing required argument 'name'/'project'")
    ns = argparse.Namespace(name=name, project=project)
    ok, output, error = _call_cmd(hub.cmd_project_import_skill, ns)
    return _result(ok, {"name": name, "project": project} if ok else None, output, error)


def tool_bundle_new(args):
    name = args.get("name")
    if not name:
        return _result(False, error="missing required argument 'name'")
    ns = argparse.Namespace(
        bundle_name=name,
        skills=args.get("skills") or "",
        description=args.get("description"),
        icon=args.get("icon"),
        scope=args.get("scope"),
    )
    ok, output, error = _call_cmd(hub.cmd_bundle_new, ns)
    return _result(ok, {"name": name} if ok else None, output, error)


def tool_bundle_update(args):
    name = args.get("name")
    if not name:
        return _result(False, error="missing required argument 'name'")
    ns = argparse.Namespace(
        bundle_name=name,
        skills=args.get("skills"),
        description=args.get("description"),
        icon=args.get("icon"),
        scope=args.get("scope"),
    )
    ok, output, error = _call_cmd(hub.cmd_bundle_update, ns)
    return _result(ok, {"name": name} if ok else None, output, error)


def tool_bundle_delete(args):
    name = args.get("name")
    if not name:
        return _result(False, error="missing required argument 'name'")
    confirm = bool(args.get("confirm", False))
    dry_run = bool(args.get("dry_run", False))
    effective_dry_run = dry_run or (not confirm)
    ns = argparse.Namespace(bundle_name=name, dry_run=effective_dry_run)
    ok, output, error = _call_cmd(hub.cmd_bundle_delete, ns)
    applied = ok and (confirm and not dry_run)
    return _result(ok, {"name": name, "applied": applied} if ok else None, output, error)


def tool_bundle_apply(args):
    name = args.get("name")
    project = args.get("project")
    if not name or not project:
        return _result(False, error="missing required argument 'name'/'project'")
    ns = argparse.Namespace(bundle_name=name, project=project)
    ok, output, error = _call_cmd(hub.cmd_bundle_apply, ns)
    return _result(ok, {"name": name, "project": project} if ok else None, output, error)


def tool_bundle_remove(args):
    name = args.get("name")
    project = args.get("project")
    if not name or not project:
        return _result(False, error="missing required argument 'name'/'project'")
    ns = argparse.Namespace(bundle_name=name, project=project)
    ok, output, error = _call_cmd(hub.cmd_bundle_remove, ns)
    return _result(ok, {"name": name, "project": project} if ok else None, output, error)


def tool_sync(args):
    ns = argparse.Namespace(skip_permissions=False)
    ok, output, error = _call_cmd(hub.cmd_sync, ns)
    return _result(ok, {"synced": ok}, output, error)


# ─────────────────────────────────────────────────────────────────────────────
# WRITE/READ tools — snippets (reusable agent-doc instruction blocks)
# ─────────────────────────────────────────────────────────────────────────────


def _reject_stdin_body(args):
    """A literal '-' body would make cmd_* read stdin — our JSON-RPC channel.

    Returns an error result if the caller passed '-', else None.
    """
    if args.get("body") == "-":
        return _result(
            False,
            error="body '-' is not supported over MCP (it would read stdin); "
            "pass the markdown text directly",
        )
    return None


def tool_snippet_new(args):
    name = args.get("name")
    if not name:
        return _result(False, error="missing required argument 'name'")
    bad = _reject_stdin_body(args)
    if bad:
        return bad
    ns = argparse.Namespace(
        name=name,
        description=args.get("description"),
        tags=args.get("tags"),
        body=args.get("body"),
        body_file=None,
    )
    ok, result, output, error = _call_cmd_json(hub.cmd_snippet_new, ns)
    return _result(ok, result, output, error)


def tool_snippet_edit(args):
    name = args.get("name")
    if not name:
        return _result(False, error="missing required argument 'name'")
    bad = _reject_stdin_body(args)
    if bad:
        return bad
    ns = argparse.Namespace(
        name=name,
        description=args.get("description"),
        tags=args.get("tags"),
        body=args.get("body"),
        body_file=None,
    )
    ok, result, output, error = _call_cmd_json(hub.cmd_snippet_edit, ns)
    return _result(ok, result, output, error)


def tool_snippet_apply(args):
    name = args.get("name")
    project = args.get("project")
    if not name or not project:
        return _result(False, error="missing required argument 'name'/'project'")
    ns = argparse.Namespace(name=name, project=project, file=args.get("file"))
    ok, result, output, error = _call_cmd_json(hub.cmd_snippet_apply, ns)
    return _result(ok, result, output, error)


def tool_snippet_remove(args):
    name = args.get("name")
    project = args.get("project")
    if not name or not project:
        return _result(False, error="missing required argument 'name'/'project'")
    ns = argparse.Namespace(
        name=name,
        project=project,
        file=args.get("file"),
        force=bool(args.get("force", False)),
    )
    ok, result, output, error = _call_cmd_json(hub.cmd_snippet_remove, ns)
    return _result(ok, result, output, error)


def tool_snippet_update(args):
    name = args.get("name")
    if not name:
        return _result(False, error="missing required argument 'name'")
    ns = argparse.Namespace(
        name=name,
        project=args.get("project"),
        file=args.get("file"),
        all=bool(args.get("all", False)),
        force=bool(args.get("force", False)),
    )
    ok, result, output, error = _call_cmd_json(hub.cmd_snippet_update, ns)
    return _result(ok, result, output, error)


def tool_snippet_delete(args):
    name = args.get("name")
    if not name:
        return _result(False, error="missing required argument 'name'")
    # Destructive but already scan-guarded: cmd_snippet_delete refuses to delete
    # a snippet still applied to files unless force=True.
    ns = argparse.Namespace(name=name, force=bool(args.get("force", False)))
    ok, result, output, error = _call_cmd_json(hub.cmd_snippet_delete, ns)
    return _result(ok, result, output, error)


def tool_snippet_list(args):
    ns = argparse.Namespace(tag=args.get("tag"), query=args.get("query"))
    ok, result, output, error = _call_cmd_json(hub.cmd_snippet_list, ns)
    return _result(ok, {"snippets": result} if result is not None else None, output, error)


def tool_snippet_show(args):
    name = args.get("name")
    if not name:
        return _result(False, error="missing required argument 'name'")
    ns = argparse.Namespace(name=name)
    ok, result, output, error = _call_cmd_json(hub.cmd_snippet_show, ns)
    return _result(ok, result, output, error)


def tool_snippet_status(args):
    ns = argparse.Namespace(name=args.get("name"), project=args.get("project"))
    ok, result, output, error = _call_cmd_json(hub.cmd_snippet_status, ns)
    return _result(ok, result, output, error)


# ─────────────────────────────────────────────────────────────────────────────
# READ tools (no writes)
# ─────────────────────────────────────────────────────────────────────────────


def _bundles_for_skill(skill_name, registry):
    out = []
    for bname, bcfg in (registry.get("bundles") or {}).items():
        if skill_name in (bcfg.get("skills") or []):
            out.append(bname)
    return out


def tool_skill_list(_args):
    try:
        registry = hub.load_registry()
    except SystemExit as e:
        return _result(False, error=f"could not load registry (exit {e.code})")
    skills = registry.get("skills") or {}
    rows = []
    for name, cfg in skills.items():
        rows.append(
            {
                "name": name,
                "scope": cfg.get("scope"),
                "type": cfg.get("type"),
                "description": cfg.get("description"),
                "version": cfg.get("version"),
                "bundles": _bundles_for_skill(name, registry),
            }
        )
    return _result(True, {"skills": rows, "count": len(rows)})


def tool_bundle_list(_args):
    try:
        registry = hub.load_registry()
    except SystemExit as e:
        return _result(False, error=f"could not load registry (exit {e.code})")
    bundles = registry.get("bundles") or {}
    projects = registry.get("projects") or {}
    assigned_map = {name: [] for name in bundles}
    for pname, pcfg in projects.items():
        for b in pcfg.get("bundles") or []:
            if b in assigned_map:
                assigned_map[b].append(pname)
    rows = []
    for name, cfg in bundles.items():
        rows.append(
            {
                "name": name,
                "description": cfg.get("description"),
                "icon": cfg.get("icon"),
                "scope": cfg.get("scope", "project-specific"),
                "skills": cfg.get("skills") or [],
                "assigned_projects": sorted(assigned_map.get(name, [])),
            }
        )
    return _result(True, {"bundles": rows, "count": len(rows)})


def tool_doctor(_args):
    """Read-only permissions risk scan across global + per-project scopes."""
    try:
        import risks
        import permission_adapters as pa
        import harnesses as _harnesses
        from permissions import NormalizedPermissions, resolve_effective

        registry = hub.load_registry()
        installed = _harnesses.detect_installed()

        targets = []
        global_perms = NormalizedPermissions.from_block(
            registry.get("permissions_global")
        )
        for h_id in sorted(installed):
            targets.append(("global", h_id, global_perms))
        for proj_name, proj_cfg in (registry.get("projects") or {}).items():
            eff = resolve_effective(proj_cfg, registry)
            eff_harnesses = _harnesses.resolve_effective(
                proj_cfg, registry, installed=installed
            )
            for h_id in sorted(eff_harnesses):
                targets.append((f"project:{proj_name}", h_id, eff))

        findings = []
        danger = 0
        for scope_label, h_id, perms in targets:
            harness = _harnesses.HARNESSES.get(h_id)
            adapter = (
                pa.get_adapter(harness.permission_adapter_key)
                if (harness and harness.permission_adapter_key)
                else None
            )
            caps = adapter.capabilities() if adapter else set()
            for f in risks.detect_risks(perms, caps):
                findings.append({"scope": scope_label, "harness": h_id, **f.to_dict()})
                if f.severity == "danger":
                    danger += 1
        return _result(True, {"findings": findings, "danger_count": danger})
    except SystemExit as e:
        return _result(False, error=f"doctor failed (exit {e.code})")
    except Exception as e:  # noqa: BLE001
        return _result(False, error=f"{type(e).__name__}: {e}")


def tool_permissions_show(args):
    """Read-only view of registry permission blocks (global or project own)."""
    try:
        from permissions import NormalizedPermissions

        registry = hub.load_registry()
        project = args.get("project")
        if project:
            projects = registry.get("projects") or {}
            if project not in projects:
                return _result(False, error=f"unknown project '{project}'")
            block = projects[project].get("permissions") or {}
            scope = f"project:{project}"
        else:
            block = registry.get("permissions_global") or {}
            scope = "global"
        perms = NormalizedPermissions.from_block(block)
        return _result(True, {"scope": scope, "permissions": perms.to_dict()})
    except SystemExit as e:
        return _result(False, error=f"could not load registry (exit {e.code})")
    except Exception as e:  # noqa: BLE001
        return _result(False, error=f"{type(e).__name__}: {e}")


def tool_harness_list(_args):
    """Read-only harness inventory (installed / on-globally / used-by)."""
    try:
        import harnesses as _harnesses

        registry = hub.load_registry()
        installed = _harnesses.detect_installed()
        on_globally = set(registry.get("harnesses_global") or [])
        used_by = {}
        for proj_name, proj_cfg in (registry.get("projects") or {}).items():
            for h_id in proj_cfg.get("harnesses") or []:
                used_by.setdefault(h_id, []).append(proj_name)
        rows = []
        for h_id, h in sorted(_harnesses.HARNESSES.items()):
            rows.append(
                {
                    "id": h_id,
                    "label": h.label,
                    "installed": h_id in installed,
                    "on_globally": h_id in on_globally,
                    "used_by_projects": sorted(used_by.get(h_id, [])),
                }
            )
        return _result(True, {"harnesses": rows})
    except SystemExit as e:
        return _result(False, error=f"could not load registry (exit {e.code})")
    except Exception as e:  # noqa: BLE001
        return _result(False, error=f"{type(e).__name__}: {e}")


def tool_skill_candidates(args):
    """Read-only discovery of hand-authored, untracked project-local skills.

    Delegates to hub.scan_project_skill_candidates (the same source the CLI
    `hub project scan-skills` reads), optionally filtered to one project.
    """
    try:
        registry = hub.load_registry()
        project = args.get("project")
        if project and project not in (registry.get("projects") or {}):
            return _result(False, error=f"unknown project '{project}'")
        candidates = hub.scan_project_skill_candidates(registry)
        if project:
            candidates = [c for c in candidates if c.get("project") == project]
        rows = [
            {
                "name": cand.get("name"),
                "project": cand.get("project"),
                "path": cand.get("path"),
                "category": cand.get("category"),
                "version": cand.get("version"),
                "description": cand.get("description"),
                "reason": cand.get("reason"),
            }
            for cand in candidates
        ]
        return _result(True, {"candidates": rows, "count": len(rows)})
    except SystemExit as e:
        return _result(False, error=f"could not load registry (exit {e.code})")
    except Exception as e:  # noqa: BLE001
        return _result(False, error=f"{type(e).__name__}: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# Tool registry + MCP schema
# ─────────────────────────────────────────────────────────────────────────────

TOOLS = {
    # WRITE — skills
    "skill_create": (
        tool_skill_create,
        "Scaffold + register a new skill. scope defaults to 'project-specific'.",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Skill slug (a-z0-9-)"},
                "scope": {
                    "type": "string",
                    "enum": ["global", "portable", "project-specific"],
                },
            },
            "required": ["name"],
        },
    ),
    "skill_set_meta": (
        tool_skill_set_meta,
        "Update a skill's registry metadata (scope/description/harnesses/version/upstream).",
        {
            "type": "object",
            "properties": {
                "skill": {"type": "string"},
                "scope": {"type": "string"},
                "description": {"type": "string"},
                "harnesses": {"type": "string", "description": "comma-separated harness ids"},
                "version": {"type": "string"},
                "upstream": {"type": "string"},
            },
            "required": ["skill"],
        },
    ),
    "skill_rename": (
        tool_skill_rename,
        "Rename a skill (dir + registry + project references). dry_run previews.",
        {
            "type": "object",
            "properties": {
                "old_name": {"type": "string"},
                "new_name": {"type": "string"},
                "dry_run": {"type": "boolean", "default": False},
            },
            "required": ["old_name", "new_name"],
        },
    ),
    "skill_archive": (
        tool_skill_archive,
        "DESTRUCTIVE. Archive a skill. Safe-by-default: previews unless confirm=true.",
        {
            "type": "object",
            "properties": {
                "skill": {"type": "string"},
                "confirm": {"type": "boolean", "default": False},
                "dry_run": {"type": "boolean", "default": False},
            },
            "required": ["skill"],
        },
    ),
    "skill_enable": (
        tool_skill_enable,
        "Enable a skill on a project (adds to project.enabled, re-syncs).",
        {
            "type": "object",
            "properties": {
                "skill": {"type": "string"},
                "project": {"type": "string"},
            },
            "required": ["skill", "project"],
        },
    ),
    "skill_disable": (
        tool_skill_disable,
        "Disable a skill on a project (removes from project.enabled, re-syncs).",
        {
            "type": "object",
            "properties": {
                "skill": {"type": "string"},
                "project": {"type": "string"},
            },
            "required": ["skill", "project"],
        },
    ),
    "skill_import_project": (
        tool_skill_import_project,
        "Adopt a hand-authored project-local skill into the hub.",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "project": {"type": "string"},
            },
            "required": ["name", "project"],
        },
    ),
    # WRITE — bundles
    "bundle_new": (
        tool_bundle_new,
        "Create a bundle from a comma-separated skill list.",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "skills": {"type": "string", "description": "comma-separated skill names"},
                "description": {"type": "string"},
                "icon": {"type": "string"},
                "scope": {"type": "string", "enum": ["global", "project-specific"]},
            },
            "required": ["name", "skills"],
        },
    ),
    "bundle_update": (
        tool_bundle_update,
        "Update a bundle's membership/metadata.",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "skills": {"type": "string"},
                "description": {"type": "string"},
                "icon": {"type": "string"},
                "scope": {"type": "string", "enum": ["global", "project-specific"]},
            },
            "required": ["name"],
        },
    ),
    "bundle_delete": (
        tool_bundle_delete,
        "DESTRUCTIVE. Delete a bundle. Safe-by-default: previews unless confirm=true.",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "confirm": {"type": "boolean", "default": False},
                "dry_run": {"type": "boolean", "default": False},
            },
            "required": ["name"],
        },
    ),
    "bundle_apply": (
        tool_bundle_apply,
        "Assign a bundle to a project (creates symlinks).",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "project": {"type": "string"},
            },
            "required": ["name", "project"],
        },
    ),
    "bundle_remove": (
        tool_bundle_remove,
        "Unassign a bundle from a project.",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "project": {"type": "string"},
            },
            "required": ["name", "project"],
        },
    ),
    "sync": (
        tool_sync,
        "Rebuild symlinks/MCP/permissions from the registry (hub sync).",
        {"type": "object", "properties": {}},
    ),
    # WRITE — snippets (reusable agent-doc instruction blocks)
    "snippet_new": (
        tool_snippet_new,
        "Create a snippet in the library. Pass the markdown in 'body' directly "
        "('-' is not supported over MCP).",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "kebab-case name (immutable)"},
                "description": {"type": "string"},
                "tags": {"type": "string", "description": "comma-separated tags"},
                "body": {"type": "string", "description": "markdown body"},
            },
            "required": ["name"],
        },
    ),
    "snippet_edit": (
        tool_snippet_edit,
        "Patch a snippet's description/tags/body. A body change bumps the version "
        "and may leave applied locations outdated (see update).",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "description": {"type": "string"},
                "tags": {"type": "string", "description": "comma-separated; replaces all"},
                "body": {"type": "string", "description": "new markdown body"},
            },
            "required": ["name"],
        },
    ),
    "snippet_apply": (
        tool_snippet_apply,
        "Append a snippet's marker-wrapped block to a project's agent doc "
        "(canonical root by default; 'file' for another project-relative path).",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "project": {"type": "string"},
                "file": {"type": "string", "description": "project-relative doc path"},
            },
            "required": ["name", "project"],
        },
    ),
    "snippet_remove": (
        tool_snippet_remove,
        "Excise a snippet block from a project agent doc. force=true removes even "
        "if the in-file block was edited.",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "project": {"type": "string"},
                "file": {"type": "string"},
                "force": {"type": "boolean", "default": False},
            },
            "required": ["name", "project"],
        },
    ),
    "snippet_update": (
        tool_snippet_update,
        "Refresh applied block(s) to the current library body. Use all=true for "
        "every outdated location, or project (+ optional file) for one.",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "project": {"type": "string"},
                "file": {"type": "string"},
                "all": {"type": "boolean", "default": False},
                "force": {"type": "boolean", "default": False},
            },
            "required": ["name"],
        },
    ),
    "snippet_delete": (
        tool_snippet_delete,
        "DESTRUCTIVE. Delete a snippet definition. Refuses while applied unless "
        "force=true (in which case in-file blocks remain and become orphaned).",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "force": {"type": "boolean", "default": False},
            },
            "required": ["name"],
        },
    ),
    # READ
    "snippet_list": (
        tool_snippet_list,
        "READ-ONLY. List snippets with scan-derived usage roll-ups. Optional "
        "tag/query filters.",
        {
            "type": "object",
            "properties": {
                "tag": {"type": "string"},
                "query": {"type": "string", "description": "match name/description/body"},
            },
        },
    ),
    "snippet_show": (
        tool_snippet_show,
        "READ-ONLY. Show one snippet incl. body, version, and applied locations.",
        {
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
        },
    ),
    "snippet_status": (
        tool_snippet_status,
        "READ-ONLY. Scan registered projects for snippet blocks + their statuses "
        "(applied/modified/outdated/orphaned). Optional name/project filters.",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "project": {"type": "string"},
            },
        },
    ),
    "skill_list": (
        tool_skill_list,
        "READ-ONLY. List all registered skills with scope/type/bundles.",
        {"type": "object", "properties": {}},
    ),
    "bundle_list": (
        tool_bundle_list,
        "READ-ONLY. List all bundles with their skills + assigned projects.",
        {"type": "object", "properties": {}},
    ),
    "doctor": (
        tool_doctor,
        "READ-ONLY. Permissions risk scan across global + project scopes.",
        {"type": "object", "properties": {}},
    ),
    "permissions_show": (
        tool_permissions_show,
        "READ-ONLY. Show the registry permission block (global, or project's own).",
        {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "omit for global scope"}
            },
        },
    ),
    "harness_list": (
        tool_harness_list,
        "READ-ONLY. Harness inventory (installed / on-globally / used-by-projects).",
        {"type": "object", "properties": {}},
    ),
    "skill_candidates": (
        tool_skill_candidates,
        "READ-ONLY. Discover hand-authored, untracked project-local skills "
        "(category NEW|INVALID_NAME). Pair with skill_import_project to adopt one. "
        "Optionally filter by project.",
        {
            "type": "object",
            "properties": {
                "project": {
                    "type": "string",
                    "description": "filter to one project; omit for all projects",
                }
            },
        },
    ),
}


# ─────────────────────────────────────────────────────────────────────────────
# JSON-RPC handlers
# ─────────────────────────────────────────────────────────────────────────────


def handle_initialize(req_id, params):
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "result": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        },
    }


def handle_tools_list(req_id):
    tools = [
        {"name": name, "description": desc, "inputSchema": schema}
        for name, (_fn, desc, schema) in TOOLS.items()
    ]
    return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": tools}}


def handle_tools_call(req_id, params):
    name = params.get("name")
    args = params.get("arguments", {}) or {}
    entry = TOOLS.get(name)
    if entry is None:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Unknown tool: {name}"},
        }
    fn = entry[0]
    try:
        payload = fn(args)
    except Exception as e:  # noqa: BLE001 — never raise out of the loop
        payload = _result(False, error=f"{type(e).__name__}: {e}")
    text = json.dumps(payload)
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "result": {"content": [{"type": "text", "text": text}]},
    }


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = req.get("method")
        req_id = req.get("id")
        params = req.get("params", {}) or {}

        if method == "initialize":
            resp = handle_initialize(req_id, params)
        elif method == "tools/list":
            resp = handle_tools_list(req_id)
        elif method == "tools/call":
            resp = handle_tools_call(req_id, params)
        elif method == "notifications/initialized":
            continue
        else:
            resp = {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"},
            }

        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
