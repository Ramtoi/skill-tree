"""`hub harness` — manage harnesses (claude-code, codex, pi, opencode).

Also owns `hub harness doc …` (global-doc sharing between harnesses) and the
`cmd_harnesses_emit_schema` handler behind the separate top-level `harnesses`
parser (that parser itself stays in `hub.py`'s `main()`).

Carved out of `hub.py` — see `hub_cli/__init__.py` for the module contract
this file implements (`NAME`, `register`, `dispatch`).
"""

from __future__ import annotations

import json
import sys

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

NAME = "harness"

p_harness = None
p_hdoc = None


def register(sub) -> None:
    global p_harness, p_hdoc

    # `hub harness ...` — top-level alias for the CLI surface in the spec
    p_harness = sub.add_parser(
        "harness",
        help="Manage harnesses (claude-code, codex, pi, opencode)",
    )
    harness_sub = p_harness.add_subparsers(dest="harness_cmd")
    p_hl = harness_sub.add_parser("list", help="List harnesses with status")
    p_hl.add_argument(
        "--json", action="store_true", help="Emit JSON instead of a table"
    )
    p_hl.add_argument(
        "--probe", action="store_true",
        help="Refresh + include each installed harness's hook-capability verdict/reason",
    )
    p_he = harness_sub.add_parser("enable", help="Add a harness to harnesses_global")
    p_he.add_argument("id", help="Harness id (claude-code | codex | pi | opencode)")
    p_hd = harness_sub.add_parser(
        "disable", help="Remove a harness from harnesses_global"
    )
    p_hd.add_argument("id", help="Harness id (claude-code | codex | pi | opencode)")

    # harness doc — a harness's global instruction doc can follow another's
    # (global-doc-sharing wave B1)
    p_hdoc = harness_sub.add_parser(
        "doc", help="Share a harness's global instructions with another's"
    )
    hdoc_sub = p_hdoc.add_subparsers(dest="harness_doc_cmd")
    p_hdoc_resolve = hdoc_sub.add_parser("resolve", help="Resolve a captured global instruction path")
    p_hdoc_resolve.add_argument("harness")
    p_hdoc_resolve.add_argument("--json", action="store_true")
    p_hdoc_status = hdoc_sub.add_parser(
        "status", help="Show follow/source/broken state for every harness's global doc"
    )
    p_hdoc_status.add_argument("--json", action="store_true")
    p_hdoc_link = hdoc_sub.add_parser(
        "link", help="Make one harness's global doc follow another's"
    )
    p_hdoc_link.add_argument("harness", help="Follower harness id")
    p_hdoc_link.add_argument("--to", required=True, dest="source", help="Source harness id")
    p_hdoc_link.add_argument(
        "--on-conflict",
        choices=["replace", "merge"],
        default=None,
        help="Resolve an existing follower file: replace it, or merge its text into the source",
    )
    p_hdoc_link.add_argument("--json", action="store_true")
    p_hdoc_unlink = hdoc_sub.add_parser(
        "unlink", help="Detach a harness's global doc from what it follows"
    )
    p_hdoc_unlink.add_argument("harness")
    p_hdoc_unlink.add_argument("--json", action="store_true")


def dispatch(args) -> None:
    if args.harness_cmd == "list":
        cmd_harness_list(args)
    elif args.harness_cmd == "enable":
        cmd_harness_enable(args)
    elif args.harness_cmd == "disable":
        cmd_harness_disable(args)
    elif args.harness_cmd == "doc":
        dc = getattr(args, "harness_doc_cmd", None)
        if dc == "resolve":
            cmd_harness_doc_resolve(args)
        elif dc == "status":
            cmd_harness_doc_status(args)
        elif dc == "link":
            cmd_harness_doc_link(args)
        elif dc == "unlink":
            cmd_harness_doc_unlink(args)
        else:
            if p_hdoc is not None:
                p_hdoc.print_help()
    else:
        if p_harness is not None:
            p_harness.print_help()


def cmd_harnesses_emit_schema(_args):
    """Print the harness registry as JSON (consumed by app build.rs)."""
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    print(_harnesses.emit_schema_json())


def _operation_context(args, features, *, refresh=False):
    """Construct once at a command boundary; an existing binding is authoritative."""
    context = getattr(args, "_operation_context", None)
    if context is not None:
        return context
    from skill_hub.application.harnesses.harness_operation_context import build_operation_context
    from skill_hub.domain.harnesses.harness_adapter_api import SDK_VERSION, Version
    from skill_hub.infrastructure.harnesses import harnesses

    context = build_operation_context(
        hub_core.data_home(),
        tuple(sorted(harnesses.HARNESSES)),
        requested_features=features,
        installed_harness_ids=tuple(sorted(harnesses.detect_installed())),
        host_version=Version.parse(hub_core.hub_version()),
        sdk_version=SDK_VERSION,
        needs_selection=refresh,
        force_refresh=refresh,
    )
    args._operation_context = context
    return context


def cmd_harness_list(args):
    """Project one inventory and layout snapshot; --probe explicitly refreshes it."""
    import hub

    json_out = getattr(args, "json", False)
    do_probe = getattr(args, "probe", False)
    registry = hub._read_registry_optional()
    on_globally = set(registry.get("harnesses_global") or [])
    used_by: dict[str, list[str]] = {}
    for proj_name, proj_cfg in (registry.get("projects") or {}).items():
        for h_id in proj_cfg.get("harnesses") or []:
            used_by.setdefault(h_id, []).append(proj_name)
    # A harness on the global switch reaches EVERY registered project — not
    # just the ones that also pin it in `projects.<n>.harnesses` — mirroring
    # the effective-harnesses rule (CLAUDE.md §Data Model:
    # harnesses_global ∪ project.harnesses).
    all_project_names = sorted((registry.get("projects") or {}).keys())

    from skill_hub.application.harnesses.harness_operation_context import observation_payload

    invocation_context = _operation_context(
        args, ("invocation", "hooks", "agent_docs", "subagents"), refresh=do_probe,
    )
    installed = set(invocation_context.installed_harness_ids or ())
    invocation_capabilities = observation_payload(invocation_context.invocation_observations)
    capabilities = observation_payload(invocation_context.hook_observations)

    # Read-only annotation: the ChatGPT DESKTOP app reads `~/.agents/skills`,
    # which the codex harness already writes. Surfacing that here is what stops a
    # user reaching for a cloud target they don't need. One Path.exists(), and the
    # probe is a module attribute so tests can flip it either way.
    #
    # BOTH halves have to be true. The desktop app's presence alone says nothing:
    # if codex is not installed, hub writes no `~/.agents/skills` at all and the
    # annotation would be a flat lie — "already handled" for a path that does not
    # exist is the one failure mode this annotation must never have.
    from skill_hub.infrastructure.filesystem import cloud_targets as _cloud_targets

    codex_also_serves: list[str] = []
    if "codex" in installed and _cloud_targets.chatgpt_desktop_installed():
        codex_also_serves = [_cloud_targets.CHATGPT_DESKTOP_LABEL]

    rows = []
    for h_id, h in sorted(invocation_context.layouts.items()):
        identities = tuple(
            identity for identity in invocation_context.inventory.identities if identity.harness_id == h_id
        )
        identity = (
            identities[0] if len(identities) == 1 and invocation_context.inventory_cache_state == "fresh" else None
        )
        docs_available = invocation_context.route(h_id, "agent_docs").status != "unavailable"
        agents_available = invocation_context.route(h_id, "subagents").status != "unavailable"
        doc = h.doc_target() if docs_available else None
        agent_dir = h.agent_target("user") if agents_available else None
        is_global = h_id in on_globally
        pinned_projects = sorted(used_by.get(h_id, []))
        row = {
            "id": h_id,
            "label": h.label,
            "invocation_capability": invocation_capabilities.get(h_id),
            "path": identity.executable_path if identity is not None else None,
            "version": str(identity.version) if identity is not None and identity.version is not None else None,
            "agents": {
                "supported": agent_dir is not None and h.agent_format is not None,
                "format": h.agent_format if agents_available else None,
                "agents_dir": str(agent_dir) if agent_dir is not None else None,
                "project_agents_dir": (
                    str(h.project_agents_dir)
                    if agents_available and h_id != "codex" and h.project_agents_dir is not None else None
                ),
            },
            "global_doc": str(doc) if doc is not None else None,
            "global_doc_exists": doc.exists() if doc is not None else False,
            "config_dir": str(h.config_dir) if h.config_dir is not None else None,
            "project_skills_dir": str(h.project_skills_dir),
            "operation_context_id": invocation_context.context_id,
            "inventory_cache_state": invocation_context.inventory_cache_state,
            "installed": h_id in installed,
            "on_globally": is_global,
            "used_by_projects": pinned_projects,
            # Every project this harness actually reaches: all of them when
            # on the global switch, else just the pinned ones.
            "effective_projects": (
                all_project_names if is_global else pinned_projects
            ),
        }
        if h_id == "codex" and codex_also_serves:
            row["also_serves"] = list(codex_also_serves)
        if do_probe:
            cap = capabilities.get(h_id)
            row["hook_capability"] = (
                {
                    "verdict": cap.get("verdict"),
                    "reason": cap.get("reason"),
                    "extra": cap.get("extra", {}),
                }
                if cap is not None
                else None
            )
        rows.append(row)

    if json_out:
        print(json.dumps(rows, indent=2))
        return

    print(f"\n{c('Harnesses', BOLD, CYAN)}\n")
    header = f"{'HARNESS':<14}{'INSTALLED':<12}{'GLOBAL':<10}USED BY"
    if do_probe:
        header += f"{'':<2}HOOKS"
    print(c(header, BOLD))
    for row in rows:
        inst = c("✓", GREEN) if row["installed"] else c("✗", DIM)
        glob = c("on", GREEN) if row["on_globally"] else c("off", DIM)
        if row["on_globally"] and row["effective_projects"]:
            used = c("all (global)", GREEN)
            if row["used_by_projects"]:
                used += f" · pinned: {', '.join(row['used_by_projects'])}"
        else:
            used = (
                ", ".join(row["used_by_projects"])
                if row["used_by_projects"]
                else c("(none)", DIM)
            )
        line = f"{row['id']:<14}{inst:<23}{glob:<19}{used}"
        if row.get("also_serves"):
            line += c(f"  (also serves {', '.join(row['also_serves'])})", DIM)
        if do_probe:
            cap = row.get("hook_capability")
            if cap is None:
                hooks_col = c("(not probed)", DIM)
            else:
                colour = GREEN if cap["verdict"] == "supported" else YELLOW
                hooks_col = c(f"{cap['verdict']} — {cap['reason']}", colour)
            line += f"  {hooks_col}"
        print(line)
    print()


def _modify_harnesses_global(action: str, h_id: str) -> None:
    """Add or remove `h_id` from `harnesses_global`. action: 'add' or 'remove'."""
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    if h_id not in _harnesses.HARNESSES:
        fail(f"Unknown harness: {h_id}")
    installed = _harnesses.detect_installed()
    if h_id not in installed:
        print(
            f"  {c('!', YELLOW)} {h_id} is not installed on this machine "
            f"(registry is portable — proceeding anyway)",
            file=sys.stderr,
        )
    with data_home_lock():
        registry = hub_core.load_registry()
        current = list(registry.get("harnesses_global") or [])
        if action == "add":
            if h_id not in current:
                current.append(h_id)
            registry["harnesses_global"] = current
            print(f"{c('✓', GREEN)} enabled '{h_id}' globally")
        else:
            registry["harnesses_global"] = [v for v in current if v != h_id]
            print(f"{c('✓', GREEN)} disabled '{h_id}' globally")
        hub_core.save_registry(registry)


def cmd_harness_enable(args):
    _modify_harnesses_global("add", args.id)


def cmd_harness_disable(args):
    _modify_harnesses_global("remove", args.id)


def _finish_harness_doc_cmd(result: dict, use_json: bool, ok_text: str) -> None:
    """Shared exit-code + output contract for `harness doc link`/`unlink`.

    `--json` always prints the module's dict (success or error) as the ONLY
    thing on stdout — no auto-sync banner follows (a doc link touches no
    registry), so a JS caller can `JSON.parse` the output verbatim. Exit
    codes: 0 success, 2 `conflict` (recoverable — retry with `--on-conflict`),
    1 any other error.
    """
    err = result.get("error")
    if use_json:
        print(json.dumps(result, indent=2))
    elif err:
        print(c(f"✗ {err}", RED), file=sys.stderr)
    else:
        print(f"{c('✓', GREEN)} {ok_text}")
    if err == "conflict":
        sys.exit(2)
    if err:
        sys.exit(1)


def cmd_harness_doc_resolve(args):
    """Return an ID-bound path projection without reading or changing the document."""
    context = _operation_context(args, ("agent_docs",))
    layout = context.layout(args.harness)
    route = context.route(args.harness, "agent_docs")
    path = layout.doc_target() if layout is not None and route.status != "unavailable" else None
    error = None
    if layout is None:
        error = f"Unknown harness: {args.harness}"
    elif route.status == "unavailable":
        error = f"Harness {args.harness} instruction route is unavailable"
    elif path is None:
        error = f"Harness {args.harness} has no user-global instruction file"
    result = {"harness_id": args.harness, "path": str(path) if path is not None else None,
              "error": error, "route": route.mode, "operation_context_id": context.context_id}
    if getattr(args, "json", False):
        print(json.dumps(result))
    elif error:
        fail(error)
    else:
        print(path)


def cmd_harness_doc_status(args):
    """Show every harness's global-doc state (read-only)."""
    from skill_hub.infrastructure.filesystem import global_docs

    rows = global_docs.status(operation_context=_operation_context(args, ("agent_docs",)))
    if getattr(args, "json", False):
        print(json.dumps(rows, indent=2))
        return
    print(f"\n{c('Global instructions', BOLD, CYAN)}\n")
    for row in rows:
        detail = ""
        if row["state"] == "follows":
            detail = f"  → follows {row['follows']}"
        elif row["state"] == "broken":
            detail = f"  → broken (was {row['follows']})" if row["follows"] else "  → broken link"
        elif row["state"] == "source" and row["followers"]:
            detail = f"  (shared with {', '.join(row['followers'])})"
        print(f"{row['harness']:<14}{row['state']:<12}{row['path']}{detail}")
    print()


def cmd_harness_doc_link(args):
    """Make one harness's global doc follow another's."""
    from skill_hub.infrastructure.filesystem import global_docs

    result = global_docs.link(
        args.harness,
        args.source,
        on_conflict=getattr(args, "on_conflict", None),
        backups_root=data_home() / "_hub-backups",
        operation_context=_operation_context(args, ("agent_docs",)),
    )
    use_json = getattr(args, "json", False)
    ok_text = (
        f"{result.get('follower', args.harness)} now follows {result.get('source', args.source)}"
        if result.get("changed")
        else f"{result.get('follower', args.harness)} already follows {result.get('source', args.source)}"
    )
    _finish_harness_doc_cmd(result, use_json, ok_text)


def cmd_harness_doc_unlink(args):
    """Detach a harness's global doc from what it follows."""
    from skill_hub.infrastructure.filesystem import global_docs

    result = global_docs.unlink(
        args.harness, backups_root=data_home() / "_hub-backups",
        operation_context=_operation_context(args, ("agent_docs",)),
    )
    use_json = getattr(args, "json", False)
    ok_text = f"{args.harness} is its own file now ({result.get('bytes', 0)} bytes)"
    _finish_harness_doc_cmd(result, use_json, ok_text)
