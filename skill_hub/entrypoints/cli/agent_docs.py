"""`hub agent-docs` — canonical root strategy and canonical-layout migration.

Carved out of `hub.py` — see `hub_cli/__init__.py` for the module contract
this file implements (`NAME`, `register`, `dispatch`). `_resolve_project_target`
is also called by `hub.py`'s `cmd_snippet_reconcile_content`, which stays in
the monolith and reaches it through the bottom re-export.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from skill_hub import hub_core
from skill_hub.hub_core import (
    BOLD,
    CYAN,
    DIM,
    GREEN,
    RED,
    YELLOW,
    c,
    data_home,
    data_home_lock,
    fail,
)

NAME = "agent-docs"

p_ad = None


def register(sub) -> None:
    global p_ad

    p_ad = sub.add_parser(
        "agent-docs", help="Agent Docs root strategy and canonical migration"
    )
    ad_sub = p_ad.add_subparsers(dest="agent_docs_cmd")
    p_ad_strat = ad_sub.add_parser(
        "strategy", help="Get or set the root-derivation strategy (symlink|import)"
    )
    p_ad_strat.add_argument(
        "--get", action="store_true", help="Print the resolved strategy"
    )
    p_ad_strat.add_argument(
        "--set",
        dest="set_value",
        choices=["symlink", "import"],
        help="Set the strategy (global, or per-project with --project)",
    )
    p_ad_strat.add_argument(
        "--project", help="Target a project's override instead of the global value"
    )
    p_ad_strat.add_argument(
        "--clear",
        action="store_true",
        help="Clear a per-project override (requires --project)",
    )
    p_ad_strat.add_argument("--json", action="store_true", help="Emit JSON")
    for alias in ("fix", "migrate"):
        p_ad_fix = ad_sub.add_parser(
            alias,
            help=(
                "Transactional canonical-layout fix: root promotion/derivation, "
                "opt-in nested promotions, legacy AGENT.md cleanup"
                + (" (alias of fix)" if alias == "migrate" else "")
            ),
        )
        p_ad_fix.add_argument("--project", help="Limit to one project by name")
        p_ad_fix.add_argument(
            "--path", help="Limit to one project by absolute filesystem path"
        )
        p_ad_fix.add_argument(
            "--apply", action="store_true", help="Apply changes (default: dry-run)"
        )
        p_ad_fix.add_argument(
            "--nested",
            help="Opt-in nested promotions: 'all', 'none' (default), or comma-separated dirs",
        )
        p_ad_fix.add_argument(
            "--rename-legacy",
            action="store_true",
            help="Also rename user-authored AGENT.md files to AGENTS.md where the "
            "directory has no other instruction file (backup-first, content preserved)",
        )
        p_ad_fix.add_argument(
            "--commit",
            action="store_true",
            help="After a successful apply, git-commit ONLY the touched files with a "
            "prepared message (opt-in; never pushes; skipped outside a git repo)",
        )
        p_ad_fix.add_argument(
            "--plan-stdin",
            action="store_true",
            help="Apply a previously previewed plan read as JSON from stdin "
            "(requires --apply and a single project; preconditions are re-verified)",
        )
        p_ad_fix.add_argument("--json", action="store_true", help="Emit JSON")
    p_ad_res = ad_sub.add_parser(
        "resolve", help="Resolve a divergent or appended root pair (never merges)"
    )
    p_ad_res.add_argument("--project", help="Project name")
    p_ad_res.add_argument("--path", help="Project by absolute filesystem path")
    p_ad_res.add_argument(
        "--dir", default="", help="Instruction directory relative to the root ('' = root)"
    )
    p_ad_res.add_argument(
        "--op",
        required=True,
        choices=["keep_agents", "keep_claude", "absorb_appendix"],
        help="Resolution operation",
    )
    p_ad_res.add_argument(
        "--commit",
        action="store_true",
        help="After a successful resolution, git-commit ONLY the touched files "
        "with a prepared message (opt-in; never pushes)",
    )
    p_ad_res.add_argument("--json", action="store_true", help="Emit JSON")
    p_ad_policy = ad_sub.add_parser(
        "policy", help="Return canonical root policy for a project path"
    )
    p_ad_policy.add_argument("--project-path", required=True, help="Project root path")
    p_ad_policy.add_argument("--json", action="store_true", help="Emit JSON")
    p_ad_status = ad_sub.add_parser(
        "status",
        help="Read-only canonical-root status (the same data sync's detection pass uses)",
    )
    p_ad_status.add_argument("--project", help="Limit to one project by name")
    p_ad_status.add_argument(
        "--path", help="Limit to one project by absolute filesystem path"
    )
    p_ad_status.add_argument("--json", action="store_true", help="Emit JSON")
    p_ad_publish = ad_sub.add_parser(
        "publish-on-save",
        help="Get or set direct publishing of saved root Agent Docs to origin/main",
    )
    p_ad_publish.add_argument("--project", required=True, help="Project name")
    publish_mode = p_ad_publish.add_mutually_exclusive_group()
    publish_mode.add_argument(
        "--enable", action="store_true", help="Publish saved root Agent Docs"
    )
    publish_mode.add_argument(
        "--disable", action="store_true", help="Keep saves local"
    )
    p_ad_publish.add_argument("--json", action="store_true", help="Emit JSON")
    p_ad_publish_now = ad_sub.add_parser(
        "publish-now",
        help="Publish current root Agent Docs when publish on save is enabled",
    )
    publish_target = p_ad_publish_now.add_mutually_exclusive_group(required=True)
    publish_target.add_argument("--project", help="Project name")
    publish_target.add_argument("--path", help="Project by absolute filesystem path")
    p_ad_publish_now.add_argument(
        "--file",
        action="append",
        dest="files",
        help="Root file saved by the caller (AGENTS.md or CLAUDE.md; repeatable)",
    )
    p_ad_publish_now.add_argument(
        "--expected-hash",
        action="append",
        dest="expected_hashes",
        help="Pre-save fingerprint as FILE=SHA256 (repeatable)",
    )
    p_ad_publish_now.add_argument("--json", action="store_true", help="Emit JSON")


def dispatch(args) -> None:
    if args.agent_docs_cmd == "strategy":
        cmd_agent_docs_strategy(args)
    elif args.agent_docs_cmd in ("fix", "migrate"):
        cmd_agent_docs_fix(args)
    elif args.agent_docs_cmd == "resolve":
        cmd_agent_docs_resolve(args)
    elif args.agent_docs_cmd == "status":
        cmd_agent_docs_status(args)
    elif args.agent_docs_cmd == "publish-on-save":
        cmd_agent_docs_publish_on_save(args)
    elif args.agent_docs_cmd == "publish-now":
        cmd_agent_docs_publish_now(args)
    elif args.agent_docs_cmd == "policy":
        cmd_agent_docs_policy(args)
    elif p_ad is not None:
        p_ad.print_help()


def cmd_agent_docs_strategy(args):
    """Get or set the canonical root-derivation strategy (global or per-project)."""
    from skill_hub.infrastructure.filesystem import agent_docs

    registry = hub_core.load_registry()
    proj_name = getattr(args, "project", None)
    set_value = getattr(args, "set_value", None)
    clear = getattr(args, "clear", False)
    use_json = getattr(args, "json", False)

    if clear and not proj_name:
        fail("--clear requires --project")
    if set_value and clear:
        fail("--set and --clear are mutually exclusive")
    if proj_name and proj_name not in (registry.get("projects") or {}):
        fail(f"Unknown project '{proj_name}'.")

    if set_value or clear:
        with data_home_lock():
            registry = hub_core.load_registry()
            if proj_name:
                proj_cfg = registry["projects"][proj_name]
                ad = proj_cfg.setdefault("agent_docs", {})
                if clear:
                    ad.pop("root_strategy", None)
                    if not ad:
                        proj_cfg.pop("agent_docs", None)
                else:
                    ad["root_strategy"] = set_value
            else:
                registry.setdefault("agent_docs", {})["root_strategy"] = set_value
            hub_core.save_registry(registry)
        registry = hub_core.load_registry()

    glob = (registry.get("agent_docs") or {}).get(
        "root_strategy"
    ) or agent_docs.DEFAULT_STRATEGY
    if proj_name:
        proj = registry["projects"][proj_name]
        override = (proj.get("agent_docs") or {}).get("root_strategy")
        effective = agent_docs.resolve_strategy(proj, registry)
        if use_json:
            print(
                json.dumps(
                    {
                        "project": proj_name,
                        "override": override,
                        "global": glob,
                        "effective": effective,
                    },
                    indent=2,
                )
            )
        else:
            print(
                f"{proj_name}: effective={c(effective, BOLD)} "
                f"(override={override or '—'}, global={glob})"
            )
    else:
        if use_json:
            print(json.dumps({"global": glob}, indent=2))
        else:
            print(f"global agent-docs root_strategy: {c(glob, BOLD)}")


def _resolve_project_target(registry, proj_name, path):
    """Resolve a `--project name` / `--path /abs/path` arg pair to a project name.

    Returns ``None`` when neither is supplied (caller defaults to all projects).
    """
    projects = registry.get("projects") or {}
    if proj_name:
        if proj_name not in projects:
            fail(f"Unknown project '{proj_name}'.")
        return proj_name
    if path:
        try:
            target = Path(path).expanduser().resolve()
        except (OSError, RuntimeError):
            fail(f"Invalid --path: {path}")
        for name, cfg in projects.items():
            try:
                if Path(cfg.get("path", "")).expanduser().resolve() == target:
                    return name
            except (OSError, RuntimeError):
                continue
        fail(f"No registered project matches --path {path}")
    return None


def _docs_operation_context(registry: dict, projects: list[dict], context=None):
    """Capture installed participants once, or reuse the supplied context."""
    if context is not None:
        return context
    from skill_hub.application.harnesses.harness_operation_context import build_operation_context
    from skill_hub.infrastructure.harnesses import harnesses

    ids: set[str] = set(str(h) for h in (registry.get("harnesses_global") or []))
    for project in projects:
        ids.update(str(h) for h in (project.get("harnesses") or []))
    return build_operation_context(
        data_home=data_home(),
        harness_ids=sorted(ids),
        requested_features=("agent_docs",),
        force_refresh=False,
        installed_harness_ids=sorted(harnesses.detect_installed()),
    )


def _effective_docs_ids(registry: dict, project: dict, context) -> set[str]:
    """Apply configured enablement to the captured installed participants."""
    return context.effective_harness_ids(project, registry)


def cmd_agent_docs_policy(args):
    """Read the five-field canonical policy contract for a project path."""
    from skill_hub.infrastructure.filesystem import agent_docs

    registry = hub_core.load_registry()
    try:
        path = Path(args.project_path).expanduser().resolve()
        project = {"path": str(path)}
        for cfg in (registry.get("projects") or {}).values():
            if not isinstance(cfg, dict) or not cfg.get("path"):
                continue
            try:
                matches = Path(cfg["path"]).expanduser().resolve() == path
            except (OSError, RuntimeError):
                continue
            if matches:
                project = cfg
                break
        context = _docs_operation_context(registry, [project], getattr(args, "_operation_context", None))
        policy = agent_docs.resolve_canonical_root(
            project, registry, context=context, effective=_effective_docs_ids(registry, project, context)
        )
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return
    payload = {
        "requires_claude": policy["canonical"] == agent_docs.CLAUDE or policy["derived"] == agent_docs.CLAUDE,
        "requires_agent": policy["canonical"] == agent_docs.CANONICAL,
        "strategy": agent_docs.resolve_strategy(project, registry),
        "claude_harnesses": sorted(h for h in _effective_docs_ids(registry, project, context) if h == "claude-code"),
        "agent_harnesses": sorted(h for h in _effective_docs_ids(registry, project, context) if h != "claude-code"),
    }
    print(json.dumps(payload, indent=2))


def cmd_agent_docs_status(args):
    """Emit canonical-root status for one or all projects (read-only)."""
    from skill_hub.infrastructure.filesystem import agent_docs

    registry = hub_core.load_registry()
    projects = registry.get("projects") or {}
    proj_name = _resolve_project_target(
        registry, getattr(args, "project", None), getattr(args, "path", None)
    )
    use_json = getattr(args, "json", False)
    targets = [proj_name] if proj_name else list(projects.keys())
    context = _docs_operation_context(
        registry, [projects[name] for name in targets], getattr(args, "_operation_context", None)
    )

    results = []
    for name in targets:
        status = agent_docs.detect_status(
            projects[name], registry, context=context,
            effective=_effective_docs_ids(registry, projects[name], context)
        )
        results.append({"project": name, **status})

    if use_json:
        # Single-project callers (Tauri) want a bare object; multi-project want a list.
        payload = results[0] if proj_name else results
        print(json.dumps(payload, indent=2))
        return
    for r in results:
        print(
            f"{r['project']}: {r['state']} "
            f"(canonical={r['canonical']}, derived={r['derived']}, strategy={r['strategy']})"
        )


def cmd_agent_docs_publish_on_save(args):
    """Read or change one project's publish-on-save setting."""
    from skill_hub.infrastructure.filesystem import agent_docs

    project_name = args.project
    registry = hub_core.load_registry()
    projects = registry.get("projects") or {}
    if project_name not in projects:
        fail(f"Unknown project '{project_name}'.")

    if args.enable or args.disable:
        with data_home_lock():
            registry = hub_core.load_registry()
            project = (registry.get("projects") or {}).get(project_name)
            if project is None:
                fail(f"Unknown project '{project_name}'.")
            agent_docs_config = project.setdefault("agent_docs", {})
            if args.enable:
                agent_docs_config["publish_on_save"] = True
            else:
                agent_docs_config.pop("publish_on_save", None)
                if not agent_docs_config:
                    project.pop("agent_docs", None)
            hub_core.save_registry(registry)
        registry = hub_core.load_registry()

    payload = {
        "project": project_name,
        **agent_docs.publish_info(registry["projects"][project_name]),
    }
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        state = "on" if payload["enabled"] else "off"
        print(f"{project_name}: publish on save is {c(state, BOLD)}")


def cmd_agent_docs_publish_now(args):
    """Publish root Agent Docs from one registered project."""
    from skill_hub.infrastructure.filesystem import agent_docs

    registry = hub_core.load_registry()
    project_name = _resolve_project_target(
        registry, getattr(args, "project", None), getattr(args, "path", None)
    )
    if not project_name:
        fail("publish-now requires --project or --path")
    project = registry["projects"][project_name]
    files = list(dict.fromkeys(getattr(args, "files", None) or []))
    if not files:
        context = _docs_operation_context(registry, [project], getattr(args, "_operation_context", None))
        policy = agent_docs.resolve_canonical_root(
            project, registry, context=context,
            effective=_effective_docs_ids(registry, project, context)
        )
        files = [
            name
            for name in (policy.get("canonical"), policy.get("derived"))
            if name and (Path(project["path"]).expanduser() / name).exists()
        ]
    expected_hashes = {}
    for value in getattr(args, "expected_hashes", None) or []:
        name, separator, digest = value.partition("=")
        if not separator or not name or not digest:
            fail("--expected-hash must use FILE=SHA256")
        expected_hashes[name] = digest
    result = agent_docs.publish_saved_root_docs(project, files, expected_hashes)
    payload = {"project": project_name, **result}
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
        return
    color = GREEN if result.get("published") else YELLOW
    print(f"{c('Agent Docs', color)}: {result['message']}")


def cmd_agent_docs_fix(args):
    """Transactional canonical-layout fix (dry-run unless --apply).

    One plan per project: root promotion/derivation/collapse, opt-in nested
    promotions (--nested), legacy AGENT.md cleanup. Apply re-verifies every
    step's precondition fingerprint and aborts whole on any mismatch.
    `hub agent-docs migrate` routes here as an alias.
    """
    from skill_hub.infrastructure.filesystem import agent_docs

    registry = hub_core.load_registry()
    projects = registry.get("projects") or {}
    proj_name = _resolve_project_target(
        registry, getattr(args, "project", None), getattr(args, "path", None)
    )
    do_apply = getattr(args, "apply", False)
    use_json = getattr(args, "json", False)
    nested = getattr(args, "nested", None) or "none"
    rename_legacy = getattr(args, "rename_legacy", False)
    do_commit = getattr(args, "commit", False)
    plan_stdin = getattr(args, "plan_stdin", False)

    targets = [proj_name] if proj_name else list(projects.keys())
    context = _docs_operation_context(
        registry, [projects[name] for name in targets], getattr(args, "_operation_context", None)
    )
    backups_root = data_home() / "_hub-backups"
    state_root = data_home() / "state"

    def select_nested(plan: dict):
        for step in plan["steps"]:
            if not step.get("optional"):
                continue
            # Rename of a user-authored AGENT.md is its own decision, gated on
            # --rename-legacy; --nested only governs nested promotions.
            if step["action"] == "rename_legacy_file":
                step["selected"] = rename_legacy
                continue
            if nested == "all":
                step["selected"] = True
            elif nested != "none":
                step["selected"] = step["dir"] in {
                    d.strip() for d in nested.split(",") if d.strip()
                }

    def maybe_commit(name: str, res: dict) -> dict:
        # Opt-in, after a successful apply. Commit failure is a warning —
        # the filesystem changes stay applied.
        if not do_commit or not res.get("applied") or not res.get("executed"):
            return res
        from pathlib import Path as _P

        root = _P(projects[name]["path"]).expanduser()
        msg = agent_docs.build_commit_message(res["executed"])
        res["commit"] = agent_docs.commit_layout_change(
            root, res.get("touched", []), msg
        )
        return res

    results = []
    if do_apply:
        if plan_stdin:
            if not proj_name:
                fail("--plan-stdin requires --project or --path")
            try:
                plan = json.loads(sys.stdin.read())
            except ValueError as e:
                fail(f"--plan-stdin: invalid JSON ({e})")
            with data_home_lock():
                res = agent_docs.apply_fix(
                    projects[proj_name],
                    registry,
                    proj_name,
                    backups_root,
                    plan,
                    context=context,
                    effective=_effective_docs_ids(registry, projects[proj_name], context),
                )
            results.append({"project": proj_name, **maybe_commit(proj_name, res)})
        else:
            with data_home_lock():
                for name in targets:
                    plan = agent_docs.plan_fix(
                        projects[name], registry, state_root=state_root, context=context,
                        effective=_effective_docs_ids(registry, projects[name], context)
                    )
                    select_nested(plan)
                    res = agent_docs.apply_fix(
                        projects[name], registry, name, backups_root, plan,
                        context=context, effective=_effective_docs_ids(registry, projects[name], context)
                    )
                    results.append({"project": name, **maybe_commit(name, res)})
    else:
        for name in targets:
            plan = agent_docs.plan_fix(
                projects[name], registry, state_root=state_root, context=context,
                effective=_effective_docs_ids(registry, projects[name], context)
            )
            select_nested(plan)
            results.append({"project": name, **plan})

    if use_json:
        # Machine consumers (the Tauri bridge) read `applied`/`error` from the
        # payload; exit 0 so a disk_changed abort still parses as JSON.
        payload = results[0] if proj_name else results
        print(json.dumps(payload, indent=2))
        return

    mode = "applied" if do_apply else "dry-run"
    print(f"\n{c('Agent docs fix', BOLD, CYAN)} ({mode})\n")
    for r in results:
        name = r["project"]
        if do_apply:
            if not r.get("applied"):
                print(
                    f"  {c('!', RED)} {name}: disk changed since preview — nothing executed; re-run to re-plan"
                )
                continue
            if not r.get("executed"):
                print(f"  {c('·', DIM)} {name}: already canonical, nothing to do")
            for ex in r.get("executed", []):
                where = ex["dir"] or "root"
                print(f"  {c('•', GREEN)} {name}: {ex['action']} ({where})")
            for b in r.get("backups", []):
                print(f"      {c('backup', GREEN)} {b}")
            commit = r.get("commit")
            if commit:
                if commit.get("committed"):
                    print(f"      {c('commit', GREEN)} {commit.get('sha')}")
                else:
                    print(
                        f"      {c('commit skipped', YELLOW)} {commit.get('reason')}"
                    )
        else:
            steps = r.get("steps", [])
            if not steps and not r.get("attention") and not r.get("flagged"):
                print(f"  {c('·', DIM)} {name}: already canonical")
            for s in steps:
                marker = (
                    c("•", YELLOW)
                    if s["selected"]
                    else c("◦", DIM)
                )
                opt_flag = (
                    "--rename-legacy"
                    if s["action"] == "rename_legacy_file"
                    else "--nested"
                )
                opt = "" if not s["optional"] else (
                    " (opt-in, selected)"
                    if s["selected"]
                    else f" (opt-in — pass {opt_flag})"
                )
                print(f"  {marker} {name}: {s['details']}{opt}")
        for a in r.get("attention", []):
            print(f"  {c('!', RED)} {name}: {a['details']}")
        for f in r.get("flagged", []):
            print(f"  {c('!', YELLOW)} {name}: {f['path']} — {f['reason']}")
    if not do_apply and any(r.get("steps") for r in results):
        print(f"\n  Re-run with {c('--apply', BOLD)} to perform the selected steps.")


def cmd_agent_docs_resolve(args):
    """Explicit conflict/appendix resolution for a root pair (never merges)."""
    from skill_hub.infrastructure.filesystem import agent_docs

    registry = hub_core.load_registry()
    projects = registry.get("projects") or {}
    proj_name = _resolve_project_target(
        registry, getattr(args, "project", None), getattr(args, "path", None)
    )
    if not proj_name:
        fail("resolve requires --project or --path")
    op = getattr(args, "op", None)
    if op not in agent_docs.RESOLVE_OPS:
        fail(f"--op must be one of: {', '.join(agent_docs.RESOLVE_OPS)}")
    rel_dir = getattr(args, "dir", "") or ""
    project = projects[proj_name]
    context = _docs_operation_context(registry, [project], getattr(args, "_operation_context", None))
    backups_root = data_home() / "_hub-backups"

    with data_home_lock():
        res = agent_docs.resolve_root(
            projects[proj_name],
            registry,
            proj_name,
            backups_root,
            rel_dir=rel_dir,
            op=op,
            context=context,
            effective=_effective_docs_ids(registry, project, context),
        )

    if getattr(args, "commit", False) and res.get("applied"):
        from pathlib import Path as _P

        root = _P(projects[proj_name]["path"]).expanduser()
        msg = agent_docs.build_commit_message([], op=op)
        res["commit"] = agent_docs.commit_layout_change(
            root, res.get("touched", []), msg
        )

    if getattr(args, "json", False):
        print(json.dumps({"project": proj_name, **res}, indent=2))
        return
    if res.get("applied"):
        print(f"{c('✓', GREEN)} {proj_name}: {op} applied ({rel_dir or 'root'})")
        for b in res.get("backups", []):
            print(f"    {c('backup', GREEN)} {b}")
        commit = res.get("commit")
        if commit:
            if commit.get("committed"):
                print(f"    {c('commit', GREEN)} {commit.get('sha')}")
            else:
                print(f"    {c('commit skipped', YELLOW)} {commit.get('reason')}")
    else:
        fail(f"{proj_name}: {res.get('error', 'resolution failed')}")
