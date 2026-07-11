#!/usr/bin/env python3
"""
skill-tree — in-process control-plane MCP server (raw JSON-RPC 2.0 over stdio).

Exposes a curated, agent-first surface of 17 Skill Hub control-plane tools by
calling hub.py's `cmd_*` functions in-process. WRITE access is limited to
skills + bundles + snippets + sync; harness/permission/remote configuration is
READ-ONLY (surfaced via `inspect`). There are intentionally NO
permission/harness/remote WRITE tools.

Surface (v2):
  READ   : project_list, skill_list, bundle_list, snippet_list,
           skill_candidates, inspect
  WRITE  : skill_create, skill_set_meta, skill_archive, skill_import, equip,
           bundle_save, bundle_delete, sync
  SNIPPET: snippet_save, snippet_place, snippet_delete

Conventions:
  * All list-shaped inputs are JSON arrays; the server joins them to the
    comma-strings the underlying cmd_* expect.
  * Destructive ops (skill_archive, bundle_delete) gate on a single `confirm`
    boolean (default false = preview only).
  * Any tool taking a `project` validates it against the registry first; the
    error ends with "use project_list to discover project names".

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
SERVER_NAME = "skill-tree"
SERVER_VERSION = "2.0.0"


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
# Shared helpers
# ─────────────────────────────────────────────────────────────────────────────


def _load_registry_or_error():
    """Return (registry, None) or (None, error_result)."""
    try:
        return hub.load_registry(), None
    except SystemExit as e:
        return None, _result(False, error=f"could not load registry (exit {e.code})")


def _unknown_project_msg(project):
    return (
        f"unknown project '{project}' — "
        f"use project_list to discover project names"
    )


def _bundles_for_skill(skill_name, registry):
    out = []
    for bname, bcfg in (registry.get("bundles") or {}).items():
        if skill_name in (bcfg.get("skills") or []):
            out.append(bname)
    return out


def _skill_row(name, cfg, registry, active=None):
    row = {
        "name": name,
        "scope": cfg.get("scope"),
        "type": cfg.get("type"),
        "description": cfg.get("description"),
        "version": cfg.get("version"),
        "bundles": _bundles_for_skill(name, registry),
        "harnesses": cfg.get("harnesses"),
        "invocation": hub.skill_invocation(cfg),
    }
    if active is not None:
        row["active"] = active
    return row


def _bundle_row(name, cfg, registry):
    projects = registry.get("projects") or {}
    assigned = sorted(
        pname
        for pname, pcfg in projects.items()
        if name in (pcfg.get("bundles") or [])
    )
    return {
        "name": name,
        "description": cfg.get("description"),
        "icon": cfg.get("icon"),
        "scope": cfg.get("scope", "project-specific"),
        "skills": cfg.get("skills") or [],
        "assigned_projects": assigned,
    }


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


def _join_csv(value):
    """JSON array → comma-string. None passes through; [] → '' (a 'clear' signal)."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return ",".join(str(v) for v in value)


# ─────────────────────────────────────────────────────────────────────────────
# READ tools
# ─────────────────────────────────────────────────────────────────────────────


def tool_project_list(args):
    registry, err = _load_registry_or_error()
    if err:
        return err
    projects = registry.get("projects") or {}
    name = args.get("name")
    if name is not None and name not in projects:
        return _result(False, error=f"unknown project '{name}'")
    try:
        import harnesses as _harnesses

        installed = _harnesses.detect_installed()
    except Exception as e:  # noqa: BLE001
        return _result(False, error=f"{type(e).__name__}: {e}")

    rows = []
    for pname, pcfg in projects.items():
        if name is not None and pname != name:
            continue
        try:
            active = hub.resolve_project_skills(pcfg, registry)
        except Exception:  # noqa: BLE001
            active = []
        try:
            eff = sorted(
                _harnesses.resolve_effective(pcfg, registry, installed=installed)
            )
        except Exception:  # noqa: BLE001
            eff = []
        rows.append(
            {
                "name": pname,
                "path": pcfg.get("path"),
                "bundles": pcfg.get("bundles") or [],
                "enabled": pcfg.get("enabled") or [],
                "active_skills": active,
                "harnesses_effective": eff,
            }
        )
    return _result(True, {"projects": rows, "count": len(rows)})


def tool_skill_list(args):
    registry, err = _load_registry_or_error()
    if err:
        return err
    project = args.get("project")
    active_set = None
    if project is not None:
        projects = registry.get("projects") or {}
        if project not in projects:
            return _result(False, error=_unknown_project_msg(project))
        active_set = set(hub.resolve_project_skills(projects[project], registry))
    skills = registry.get("skills") or {}
    rows = []
    for name, cfg in skills.items():
        active = (name in active_set) if active_set is not None else None
        rows.append(_skill_row(name, cfg, registry, active=active))
    return _result(True, {"skills": rows, "count": len(rows)})


def tool_bundle_list(_args):
    registry, err = _load_registry_or_error()
    if err:
        return err
    bundles = registry.get("bundles") or {}
    rows = [_bundle_row(name, cfg, registry) for name, cfg in bundles.items()]
    return _result(True, {"bundles": rows, "count": len(rows)})


def tool_snippet_list(args):
    name = args.get("name")
    project = args.get("project")
    scan = bool(args.get("scan", False))

    # project or scan → status scan (name may combine as a filter)
    if project is not None or scan:
        if project is not None:
            registry, err = _load_registry_or_error()
            if err:
                return err
            if project not in (registry.get("projects") or {}):
                return _result(False, error=_unknown_project_msg(project))
        ns = argparse.Namespace(name=name, project=project)
        ok, result, output, error = _call_cmd_json(hub.cmd_snippet_status, ns)
        return _result(ok, result, output, error)

    # name → show one snippet
    if name is not None:
        ns = argparse.Namespace(name=name)
        ok, result, output, error = _call_cmd_json(hub.cmd_snippet_show, ns)
        return _result(ok, result, output, error)

    # else → library listing
    ns = argparse.Namespace(tag=args.get("tag"), query=args.get("query"))
    ok, result, output, error = _call_cmd_json(hub.cmd_snippet_list, ns)
    return _result(
        ok, {"snippets": result} if result is not None else None, output, error
    )


def tool_skill_candidates(args):
    """Read-only discovery of hand-authored, untracked project-local skills."""
    registry, err = _load_registry_or_error()
    if err:
        return err
    project = args.get("project")
    if project is not None and project not in (registry.get("projects") or {}):
        return _result(False, error=_unknown_project_msg(project))
    try:
        candidates = hub.scan_project_skill_candidates(registry)
    except SystemExit as e:
        return _result(False, error=f"could not scan candidates (exit {e.code})")
    except Exception as e:  # noqa: BLE001
        return _result(False, error=f"{type(e).__name__}: {e}")
    if project is not None:
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


def _risk_findings(registry, project=None):
    """Compute permission risk findings, optionally scoped to one project."""
    import risks
    import permission_adapters as pa
    import harnesses as _harnesses
    from permissions import NormalizedPermissions, resolve_effective

    installed = _harnesses.detect_installed()
    targets = []
    if project is None:
        global_perms = NormalizedPermissions.from_block(
            registry.get("permissions_global")
        )
        for h_id in sorted(installed):
            targets.append(("global", h_id, global_perms))
        proj_items = list((registry.get("projects") or {}).items())
    else:
        proj_items = [(project, (registry.get("projects") or {})[project])]

    for proj_name, proj_cfg in proj_items:
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
    return {"findings": findings, "danger_count": danger}


def _harness_inventory(registry):
    import harnesses as _harnesses

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
    return rows


def _permissions_view(registry, project=None):
    from permissions import NormalizedPermissions

    if project is not None:
        block = (registry.get("projects") or {})[project].get("permissions") or {}
        scope = f"project:{project}"
    else:
        block = registry.get("permissions_global") or {}
        scope = "global"
    perms = NormalizedPermissions.from_block(block)
    return {"scope": scope, "permissions": perms.to_dict()}


def _agent_docs_view(registry, project=None):
    import agent_docs
    import harnesses as _harnesses

    installed = _harnesses.detect_installed()
    projects = registry.get("projects") or {}
    items = (
        [(project, projects[project])]
        if project is not None
        else list(projects.items())
    )
    out = []
    for pname, pcfg in items:
        status = agent_docs.detect_status(pcfg, registry, installed=installed)
        out.append(
            {
                "project": pname,
                "state": status.get("state"),
                "canonical": status.get("canonical"),
                "derived": status.get("derived"),
                "strategy": status.get("strategy"),
                "reason": status.get("reason"),
                "verdict": status.get("verdict"),
                "flags": status.get("flags"),
                "nested_deviations": status.get("nested_deviations"),
            }
        )
    return out


def tool_inspect(args):
    """Read-only environment/health view (harnesses / permissions / risks / agent-docs)."""
    registry, err = _load_registry_or_error()
    if err:
        return err
    project = args.get("project")
    if project is not None and project not in (registry.get("projects") or {}):
        return _result(False, error=_unknown_project_msg(project))
    section = args.get("section") or "all"
    valid = {"harnesses", "permissions", "risks", "agent_docs", "all"}
    if section not in valid:
        return _result(
            False,
            error=f"invalid section '{section}'; expected one of "
            f"{', '.join(sorted(valid))}",
        )
    want = (
        {"harnesses", "permissions", "risks", "agent_docs"}
        if section == "all"
        else {section}
    )
    result = {}
    try:
        if "harnesses" in want:
            result["harnesses"] = _harness_inventory(registry)
        if "permissions" in want:
            result["permissions"] = _permissions_view(registry, project)
        if "risks" in want:
            result["risks"] = _risk_findings(registry, project)
        if "agent_docs" in want:
            result["agent_docs"] = _agent_docs_view(registry, project)
    except SystemExit as e:
        return _result(False, error=f"inspect failed (exit {e.code})")
    except Exception as e:  # noqa: BLE001
        return _result(False, error=f"{type(e).__name__}: {e}")
    return _result(True, result)


# ─────────────────────────────────────────────────────────────────────────────
# WRITE tools — skills & bundles
# ─────────────────────────────────────────────────────────────────────────────


def tool_skill_create(args):
    name = args.get("name")
    if not name:
        return _result(False, error="missing required argument 'name'")
    scope = args.get("scope") or "project-specific"
    ns = argparse.Namespace(
        kind="skill",
        name=name,
        scope=scope,
        description=args.get("description"),
        type=None,
    )
    ok, output, error = _call_cmd(hub.cmd_new, ns)
    if not ok:
        return _result(False, output=output, error=error)
    registry, _ = _load_registry_or_error()
    row = None
    if registry is not None:
        cfg = (registry.get("skills") or {}).get(name)
        if cfg is not None:
            row = _skill_row(name, cfg, registry)
    return _result(True, row or {"name": name, "scope": scope}, output)


_META_FIELDS = ("scope", "description", "harnesses", "version", "upstream", "invocation")


def tool_skill_set_meta(args):
    skill = args.get("skill")
    if not skill:
        return _result(False, error="missing required argument 'skill'")
    new_name = args.get("new_name")

    if new_name:
        if any(args.get(f) is not None for f in _META_FIELDS):
            return _result(
                False,
                error="cannot combine new_name with other metadata fields "
                "(rename is a standalone operation)",
            )
        dry_run = bool(args.get("dry_run", False))
        ns = argparse.Namespace(old_name=skill, new_name=new_name, dry_run=dry_run)
        ok, output, error = _call_cmd(hub.cmd_rename, ns)
        if not ok:
            return _result(False, output=output, error=error)
        registry, _ = _load_registry_or_error()
        row = None
        if registry is not None and not dry_run:
            cfg = (registry.get("skills") or {}).get(new_name)
            if cfg is not None:
                row = _skill_row(new_name, cfg, registry)
        result = row or {"skill": skill, "new_name": new_name, "dry_run": dry_run}
        return _result(True, result, output)

    ns = argparse.Namespace(
        name=skill,
        scope=args.get("scope"),
        description=args.get("description"),
        harnesses=_join_csv(args.get("harnesses")),
        version=args.get("version"),
        upstream=args.get("upstream"),
        invocation=args.get("invocation"),
    )
    ok, output, error = _call_cmd(hub.cmd_set_meta, ns)
    if not ok:
        return _result(False, output=output, error=error)
    registry, _ = _load_registry_or_error()
    row = None
    if registry is not None:
        cfg = (registry.get("skills") or {}).get(skill)
        if cfg is not None:
            row = _skill_row(skill, cfg, registry)
    return _result(True, row or {"skill": skill}, output)


def tool_skill_archive(args):
    skill = args.get("skill")
    if not skill:
        return _result(False, error="missing required argument 'skill'")
    confirm = bool(args.get("confirm", False))
    ns = argparse.Namespace(skill=skill, dry_run=not confirm)
    ok, output, error = _call_cmd(hub.cmd_archive, ns)
    applied = ok and confirm
    return _result(
        ok,
        {"skill": skill, "applied": applied} if ok else None,
        output,
        error,
    )


def tool_skill_import(args):
    skill = args.get("skill")
    project = args.get("project")
    if not skill or not project:
        return _result(False, error="missing required argument 'skill'/'project'")
    registry, err = _load_registry_or_error()
    if err:
        return err
    if project not in (registry.get("projects") or {}):
        return _result(False, error=_unknown_project_msg(project))
    ns = argparse.Namespace(name=skill, project=project)
    ok, output, error = _call_cmd(hub.cmd_project_import_skill, ns)
    if not ok:
        return _result(False, output=output, error=error)
    registry2, _ = _load_registry_or_error()
    row = None
    if registry2 is not None:
        cfg = (registry2.get("skills") or {}).get(skill)
        if cfg is not None:
            row = _skill_row(skill, cfg, registry2)
    return _result(True, row or {"skill": skill, "project": project}, output)


def tool_equip(args):
    target = args.get("target")
    name = args.get("name")
    project = args.get("project")
    state = args.get("state")
    invocation = args.get("invocation")

    if not target or not name or not project or not state:
        return _result(
            False, error="missing required argument (target/name/project/state)"
        )
    if target not in ("skill", "bundle"):
        return _result(False, error="target must be 'skill' or 'bundle'")
    if state not in ("on", "off"):
        return _result(False, error="state must be 'on' or 'off'")
    if invocation is not None and not (target == "skill" and state == "on"):
        return _result(
            False,
            error="invocation is only valid with target='skill' and state='on'",
        )

    registry, err = _load_registry_or_error()
    if err:
        return err
    if project not in (registry.get("projects") or {}):
        return _result(False, error=_unknown_project_msg(project))

    if target == "skill":
        ns = argparse.Namespace(skill=name, project=project)
        fn = hub.cmd_enable if state == "on" else hub.cmd_disable
        ok, output, error = _call_cmd(fn, ns)
    else:
        ns = argparse.Namespace(bundle_name=name, project=project)
        fn = hub.cmd_bundle_apply if state == "on" else hub.cmd_bundle_remove
        ok, output, error = _call_cmd(fn, ns)

    if not ok:
        return _result(False, output=output, error=error)

    result = {"target": target, "name": name, "project": project, "state": state}

    if invocation is not None:
        inv_ns = argparse.Namespace(name=project, skill=name, mode=invocation)
        ok2, output2, error2 = _call_cmd(hub.cmd_project_invocation, inv_ns)
        combined = (output + ("\n" + output2 if output2 else "")).strip()
        if not ok2:
            return _result(False, output=combined, error=error2)
        result["invocation"] = invocation
        return _result(True, result, combined)

    return _result(True, result, output)


def tool_bundle_save(args):
    name = args.get("name")
    if not name:
        return _result(False, error="missing required argument 'name'")
    registry, err = _load_registry_or_error()
    if err:
        return err
    exists = name in (registry.get("bundles") or {})
    skills_csv = _join_csv(args.get("skills"))

    if exists:
        ns = argparse.Namespace(
            bundle_name=name,
            skills=skills_csv,
            description=args.get("description"),
            icon=args.get("icon"),
            scope=args.get("scope"),
        )
        ok, output, error = _call_cmd(hub.cmd_bundle_update, ns)
    else:
        if not args.get("skills"):
            return _result(
                False,
                error="creating a new bundle requires a non-empty 'skills' array",
            )
        ns = argparse.Namespace(
            bundle_name=name,
            skills=skills_csv,
            description=args.get("description"),
            icon=args.get("icon"),
            scope=args.get("scope"),
        )
        ok, output, error = _call_cmd(hub.cmd_bundle_new, ns)

    if not ok:
        return _result(False, output=output, error=error)
    registry2, _ = _load_registry_or_error()
    row = None
    if registry2 is not None:
        cfg = (registry2.get("bundles") or {}).get(name)
        if cfg is not None:
            row = _bundle_row(name, cfg, registry2)
    return _result(True, row or {"name": name}, output)


def tool_bundle_delete(args):
    name = args.get("name")
    if not name:
        return _result(False, error="missing required argument 'name'")
    confirm = bool(args.get("confirm", False))
    ns = argparse.Namespace(bundle_name=name, dry_run=not confirm)
    ok, output, error = _call_cmd(hub.cmd_bundle_delete, ns)
    applied = ok and confirm
    return _result(ok, {"name": name, "applied": applied} if ok else None, output, error)


def tool_sync(_args):
    ns = argparse.Namespace(
        skip_permissions=False, skip_remotes=False, strict_remotes=False
    )
    ok, output, error = _call_cmd(hub.cmd_sync, ns)
    report = None
    try:
        report_path = hub.data_home() / "state" / "sync-report.json"
        if report_path.is_file():
            report = json.loads(report_path.read_text())
    except Exception:  # noqa: BLE001 — report is best-effort
        report = None
    return _result(ok, report if report is not None else {"synced": ok}, output, error)


# ─────────────────────────────────────────────────────────────────────────────
# WRITE tools — snippets (reusable agent-doc instruction blocks)
# ─────────────────────────────────────────────────────────────────────────────


def _snippet_exists(name):
    try:
        import snippets as _snippets

        sdir = _snippets.snippets_dir(hub.data_home())
        return name in _snippets.library_by_name(sdir)
    except Exception:  # noqa: BLE001
        return False


def tool_snippet_save(args):
    name = args.get("name")
    if not name:
        return _result(False, error="missing required argument 'name'")
    bad = _reject_stdin_body(args)
    if bad:
        return bad
    ns = argparse.Namespace(
        name=name,
        description=args.get("description"),
        tags=_join_csv(args.get("tags")),
        body=args.get("body"),
        body_file=None,
    )
    fn = hub.cmd_snippet_edit if _snippet_exists(name) else hub.cmd_snippet_new
    ok, result, output, error = _call_cmd_json(fn, ns)
    return _result(ok, result, output, error)


def tool_snippet_place(args):
    op = args.get("op")
    name = args.get("name")
    if not op:
        return _result(False, error="missing required argument 'op'")
    if not name:
        return _result(False, error="missing required argument 'name'")
    if op not in ("apply", "remove", "refresh"):
        return _result(False, error="op must be one of: apply, remove, refresh")

    project = args.get("project")
    file = args.get("file")

    if op in ("apply", "remove") and not project:
        return _result(False, error=f"op={op} requires a 'project'")

    if project is not None:
        registry, err = _load_registry_or_error()
        if err:
            return err
        if project not in (registry.get("projects") or {}):
            return _result(False, error=_unknown_project_msg(project))

    if op == "apply":
        ns = argparse.Namespace(name=name, project=project, file=file)
        ok, result, output, error = _call_cmd_json(hub.cmd_snippet_apply, ns)
    elif op == "remove":
        ns = argparse.Namespace(
            name=name,
            project=project,
            file=file,
            force=bool(args.get("force", False)),
        )
        ok, result, output, error = _call_cmd_json(hub.cmd_snippet_remove, ns)
    else:  # refresh
        ns = argparse.Namespace(
            name=name,
            project=project,
            file=file,
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


# ─────────────────────────────────────────────────────────────────────────────
# Tool registry + MCP schema
# ─────────────────────────────────────────────────────────────────────────────

TOOLS = {
    # ── READ ──────────────────────────────────────────────────────────────
    "project_list": (
        tool_project_list,
        "READ-ONLY. List every registered project with its filesystem path, "
        "assigned bundles, directly-enabled skills, the full set of currently-active "
        "skills (bundles ∪ enabled), and effective harnesses. Call this FIRST whenever "
        "you need a valid `project` value — most write tools (`equip`, `snippet_place`, "
        "`skill_import`) require an exact project name, and this is the only way to "
        "discover them. Registry-only and fast (no filesystem scan).",
        {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "filter to one project; omit for all",
                }
            },
        },
    ),
    "skill_list": (
        tool_skill_list,
        "READ-ONLY. List all registered skills with scope, type, description, "
        "version, bundle membership, harness affinity, and invocation mode. Pass "
        "`project` to also mark which skills are currently active on that project. "
        "Use to discover skill names before `equip`, `skill_set_meta`, or `bundle_save`.",
        {
            "type": "object",
            "properties": {
                "project": {
                    "type": "string",
                    "description": "annotate each skill with active/inactive on this project",
                }
            },
        },
    ),
    "bundle_list": (
        tool_bundle_list,
        "READ-ONLY. List all bundles with description, icon, scope, ordered skill "
        "membership, and the projects each is assigned to. Use before "
        "`equip target=bundle` or `bundle_save`.",
        {"type": "object", "properties": {}},
    ),
    "snippet_list": (
        tool_snippet_list,
        "READ-ONLY. Inspect reusable agent-doc instruction snippets. With no args: "
        "list every snippet with scan-derived usage roll-ups. With `name`: return that "
        "snippet's full body, version, and applied locations. With `project` (or "
        "`scan=true`): scan registered project docs for placed blocks and their "
        "per-location status (applied/modified/outdated/orphaned + damaged markers).",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "project": {"type": "string"},
                "tag": {"type": "string"},
                "query": {
                    "type": "string",
                    "description": "match name/description/body",
                },
                "scan": {
                    "type": "boolean",
                    "default": False,
                    "description": "scan all projects for placed blocks",
                },
            },
        },
    ),
    "skill_candidates": (
        tool_skill_candidates,
        "READ-ONLY. Discover hand-authored, untracked skills sitting in a project's "
        "`.claude/skills/` (or `.agents/skills/`) that the hub does not yet manage "
        "(category NEW = importable, INVALID_NAME = bad slug). Pair with `skill_import` "
        "to adopt one. Optionally filter to one project. Involves a filesystem scan, so "
        "call it deliberately, not on every turn.",
        {
            "type": "object",
            "properties": {"project": {"type": "string"}},
        },
    ),
    "inspect": (
        tool_inspect,
        "READ-ONLY environment/health view. Returns the harness inventory (installed / "
        "on-globally / used-by-projects), the registry permission blocks, a permissions "
        "risk scan (danger findings), and canonical-root agent-doc status per project. "
        "All read-only — the hub never writes permissions or harness config via MCP. "
        "Pass `project` to scope permissions + agent-docs to one project; omit for "
        "global + all projects. Check `agent_docs` state before `snippet_place` so you "
        "know which root file a block will land in.",
        {
            "type": "object",
            "properties": {
                "project": {"type": "string"},
                "section": {
                    "type": "string",
                    "enum": ["harnesses", "permissions", "risks", "agent_docs", "all"],
                    "default": "all",
                },
            },
        },
    ),
    # ── WRITE: skills & bundles ───────────────────────────────────────────
    "skill_create": (
        tool_skill_create,
        "Scaffold and register a new skill (writes a SKILL.md template + registry "
        "entry). `scope` defaults to `project-specific`. Optionally set `description`. "
        "After creating, edit the skill files, then `equip` it onto a project. Returns "
        "the new skill's registry state.",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Skill slug (a-z0-9-)"},
                "scope": {
                    "type": "string",
                    "enum": ["global", "portable", "project-specific"],
                    "default": "project-specific",
                },
                "description": {"type": "string"},
            },
            "required": ["name"],
        },
    ),
    "skill_set_meta": (
        tool_skill_set_meta,
        "Update a skill's registry metadata: scope, description, harness affinity "
        "(array of harness ids; empty array clears it back to all-effective), version, "
        "upstream, and library invocation mode (`auto`/`user-only`/`model-only` — "
        "rewrites SKILL.md frontmatter; not valid for mcp-server skills). Pass "
        "`new_name` to rename the skill (dir + registry + all project references; "
        "`dry_run` previews the rename). Renaming cannot be combined with other "
        "metadata fields in one call. Returns the resulting skill state.",
        {
            "type": "object",
            "properties": {
                "skill": {"type": "string"},
                "new_name": {"type": "string"},
                "dry_run": {
                    "type": "boolean",
                    "default": False,
                    "description": "rename preview only",
                },
                "scope": {"type": "string"},
                "description": {"type": "string"},
                "harnesses": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "harness-id affinity; [] clears",
                },
                "version": {"type": "string"},
                "upstream": {"type": "string"},
                "invocation": {
                    "type": "string",
                    "enum": ["auto", "user-only", "model-only"],
                },
            },
            "required": ["skill"],
        },
    ),
    "skill_archive": (
        tool_skill_archive,
        "DESTRUCTIVE. Archive a skill (removes it from the registry + active projects). "
        "Safe by default: previews the effect unless `confirm=true`. Returns whether it "
        "was actually applied.",
        {
            "type": "object",
            "properties": {
                "skill": {"type": "string"},
                "confirm": {
                    "type": "boolean",
                    "default": False,
                    "description": "true actually archives; false previews",
                },
            },
            "required": ["skill"],
        },
    ),
    "skill_import": (
        tool_skill_import,
        "Adopt a hand-authored, untracked project-local skill into the hub: copies it "
        "into the data home, registers it (`scope: project-specific`), enables it on the "
        "project, and re-syncs so it becomes a managed symlink. Discover candidates "
        "first with `skill_candidates`. Returns the adopted skill's state.",
        {
            "type": "object",
            "properties": {
                "skill": {
                    "type": "string",
                    "description": "candidate skill name from skill_candidates",
                },
                "project": {"type": "string"},
            },
            "required": ["skill", "project"],
        },
    ),
    "equip": (
        tool_equip,
        "Turn a skill or bundle on or off for a project, re-syncing symlinks. "
        "`target=skill` toggles the project's directly-enabled list; `target=bundle` "
        "assigns/unassigns the bundle. Use `project_list` to find the project, "
        "`skill_list`/`bundle_list` to find the name. When equipping a skill "
        "(`target=skill, state=on`), optionally set `invocation` to establish a "
        "per-project invocation override (`auto`/`user-only`/`model-only`, or `inherit` "
        "to clear it) — overrides are inert for `scope:global` skills. Returns the "
        "resulting equip state.",
        {
            "type": "object",
            "properties": {
                "target": {"type": "string", "enum": ["skill", "bundle"]},
                "name": {"type": "string"},
                "project": {"type": "string"},
                "state": {"type": "string", "enum": ["on", "off"]},
                "invocation": {
                    "type": "string",
                    "enum": ["auto", "user-only", "model-only", "inherit"],
                    "description": "skill+on only: per-project invocation override",
                },
            },
            "required": ["target", "name", "project", "state"],
        },
    ),
    "bundle_save": (
        tool_bundle_save,
        "Create or update a bundle (upsert by `name`). `skills` is an ordered array — "
        "its order is preserved and drives the bundle's card order. Omit a field on "
        "update to leave it unchanged; pass `skills` to replace membership wholesale. "
        "`scope: global` bundles auto-apply to every project. Returns the saved bundle "
        "state.",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "skills": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "ordered skill names; replaces membership",
                },
                "description": {"type": "string"},
                "icon": {"type": "string"},
                "scope": {
                    "type": "string",
                    "enum": ["global", "project-specific"],
                },
            },
            "required": ["name"],
        },
    ),
    "bundle_delete": (
        tool_bundle_delete,
        "DESTRUCTIVE. Delete a bundle and unassign it from all projects. Safe by "
        "default: previews unless `confirm=true`. Returns whether it was applied.",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "confirm": {"type": "boolean", "default": False},
            },
            "required": ["name"],
        },
    ),
    "sync": (
        tool_sync,
        "Rebuild all symlinks, MCP config, and permission files from the registry "
        "(runs the full `hub sync`, including the permissions stream + doctor rollup; "
        "remote push happens on explicit sync). Most write tools already auto-sync, so "
        "call this mainly to force a full reconcile or after external edits. Returns "
        "the sync report summary (per-project writes / errors / affinity-skips).",
        {"type": "object", "properties": {}},
    ),
    # ── WRITE: snippets ───────────────────────────────────────────────────
    "snippet_save": (
        tool_snippet_save,
        "Create or update a reusable agent-doc instruction snippet in the library "
        "(upsert by `name`; the name is immutable once created). Pass the markdown text "
        "directly in `body` (a literal `-` is rejected — it would read stdin). `tags` is "
        "an array and replaces all tags on update. A body change bumps the version and "
        "can leave applied locations outdated — refresh them with `snippet_place "
        "op=refresh`. Returns the saved snippet incl. version.",
        {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "kebab-case, immutable",
                },
                "description": {"type": "string"},
                "tags": {"type": "array", "items": {"type": "string"}},
                "body": {"type": "string"},
            },
            "required": ["name"],
        },
    ),
    "snippet_place": (
        tool_snippet_place,
        "Manage a snippet's placement in a project's agent doc. `op=apply` appends the "
        "marker-wrapped block to the canonical root (or `file` for another "
        "project-relative path); `op=remove` excises it (`force=true` even if the "
        "in-file block was edited); `op=refresh` updates placed block(s) to the current "
        "library body — set `all=true` to refresh every outdated location, or give "
        "`project` (+ optional `file`) for one. Check placement/status first with "
        "`snippet_list`. Returns the affected location(s).",
        {
            "type": "object",
            "properties": {
                "op": {"type": "string", "enum": ["apply", "remove", "refresh"]},
                "name": {"type": "string"},
                "project": {
                    "type": "string",
                    "description": "required for apply/remove and single-file refresh",
                },
                "file": {
                    "type": "string",
                    "description": "project-relative doc path (default: canonical root)",
                },
                "all": {
                    "type": "boolean",
                    "default": False,
                    "description": "refresh: every outdated location",
                },
                "force": {
                    "type": "boolean",
                    "default": False,
                    "description": "remove/refresh: proceed despite in-file edits",
                },
            },
            "required": ["op", "name"],
        },
    ),
    "snippet_delete": (
        tool_snippet_delete,
        "DESTRUCTIVE. Delete a snippet definition from the library. Refuses while it is "
        "still applied to any project doc unless `force=true` (in which case the in-file "
        "blocks remain and become orphaned). Remove placements first with `snippet_place "
        "op=remove`. Returns the deleted name.",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "force": {"type": "boolean", "default": False},
            },
            "required": ["name"],
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
