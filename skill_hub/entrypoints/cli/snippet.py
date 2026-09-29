"""`hub snippet` — reusable agent-doc instruction blocks (see snippets.py).

A snippet is a named, versioned markdown block that can be applied to (and
later updated or removed from) a project's canonical agent-doc file, marker-
wrapped so the applied copy can be told apart from a modified one. All the
matching/placement/scan logic lives in `snippets.py`; these handlers are
marshalling + output only, plus the `reconcile-content` bridge the native
editor uses as the final writer for supported Agent Doc paths.

Carved out of `hub.py` (S5 slice E) — see `hub_cli/__init__.py` for the
module contract this file implements (`NAME`, `register`, `dispatch`).

`load_registry` is called through the `hub_core.` module attribute
(`hub_core.load_registry(...)`, not a value-imported name) because a value
import snapshots the function object at module-load time: a test's
`monkeypatch.setattr(hub, "load_registry", ...)` forwards through the
`_HubFacade` to rebind `hub_core.load_registry` itself (see hub.py's
`_HubFacade`), and a call site that already captured the original object
would never see that rebind. The other `hub_core` names imported below by
value (colours, `c`, `fail`, `data_home`, `data_home_lock`) are ones no test
patches on `hub`; `data_home` reads its cache through `hub_core`'s own global,
which the facade keeps live. See `hub_cli/__init__.py` for the rule.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Optional

from skill_hub import hub_core
from skill_hub.hub_core import (
    BOLD,
    DIM,
    RED,
    YELLOW,
    c,
    data_home,
    data_home_lock,
    fail,
)

NAME = "snippet"

p_snip = None


def register(sub) -> None:
    global p_snip

    # snippet: reusable agent-doc instruction blocks
    p_snip = sub.add_parser(
        "snippet", help="Reusable agent-doc instruction blocks (apply/remove on doc files)"
    )
    snip_sub = p_snip.add_subparsers(dest="snippet_cmd")
    p_snip_list = snip_sub.add_parser("list", help="List snippets with usage roll-ups")
    p_snip_list.add_argument("--tag", help="Filter by tag")
    p_snip_list.add_argument("--query", help="Match name/description/body (case-insensitive)")
    p_snip_list.add_argument(
        "--no-usage",
        action="store_true",
        help="Skip the project-tree scan; omit `usage` from every row (fast)",
    )
    p_snip_list.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_show = snip_sub.add_parser("show", help="Show one snippet incl. applied locations")
    p_snip_show.add_argument("name", help="Snippet name")
    p_snip_show.add_argument(
        "--no-usage",
        action="store_true",
        help="Skip the project-tree scan; omit `usage` from the payload (fast)",
    )
    p_snip_show.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_new = snip_sub.add_parser("new", help="Create a snippet")
    p_snip_new.add_argument("name", help="Kebab-case snippet name (immutable)")
    p_snip_new.add_argument("--description", help="One-line description")
    p_snip_new.add_argument("--tags", help="Comma-separated tags")
    p_snip_new.add_argument("--body", help="Markdown body ('-' reads stdin)")
    p_snip_new.add_argument("--body-file", help="Read the body from a file")
    p_snip_new.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_edit = snip_sub.add_parser("edit", help="Patch description/tags/body (body change bumps version)")
    p_snip_edit.add_argument("name", help="Snippet name")
    p_snip_edit.add_argument("--description", help="New description")
    p_snip_edit.add_argument("--tags", help="Comma-separated tags (replaces; empty string clears)")
    p_snip_edit.add_argument("--body", help="New markdown body ('-' reads stdin)")
    p_snip_edit.add_argument("--body-file", help="Read the new body from a file")
    p_snip_edit.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_rename = snip_sub.add_parser(
        "rename", help="Rename a snippet and rewrite its marker id in every applied block"
    )
    p_snip_rename.add_argument("old", help="Current snippet name")
    p_snip_rename.add_argument("new", help="New kebab-case snippet name")
    p_snip_rename.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_del = snip_sub.add_parser(
        "delete", help="Delete a snippet definition (scan-guarded while applied)"
    )
    p_snip_del.add_argument("name", help="Snippet name")
    p_snip_del.add_argument(
        "--force",
        action="store_true",
        help="Delete even while applied; in-file blocks remain and become orphaned",
    )
    p_snip_del.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_apply = snip_sub.add_parser(
        "apply", help="Append a snippet block to a project agent doc file"
    )
    p_snip_apply.add_argument("name", help="Snippet name")
    p_snip_apply.add_argument("--project", required=True, help="Registered project name")
    p_snip_apply.add_argument(
        "--file", help="Project-relative agent doc path (default: canonical root)"
    )
    p_snip_apply.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_remove = snip_sub.add_parser(
        "remove", help="Excise a snippet block from a project agent doc file"
    )
    p_snip_remove.add_argument("name", help="Snippet name")
    p_snip_remove.add_argument("--project", required=True, help="Registered project name")
    p_snip_remove.add_argument(
        "--file", help="Project-relative agent doc path (default: canonical root)"
    )
    p_snip_remove.add_argument(
        "--force", action="store_true", help="Remove even if the block was edited in-file"
    )
    p_snip_remove.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_update = snip_sub.add_parser(
        "update", help="Refresh applied block(s) to the current library body"
    )
    p_snip_update.add_argument("name", help="Snippet name")
    p_snip_update.add_argument("--project", help="Registered project name")
    p_snip_update.add_argument(
        "--file", help="Project-relative agent doc path (default: canonical root)"
    )
    p_snip_update.add_argument(
        "--all", action="store_true", help="Refresh every outdated location (skips modified)"
    )
    p_snip_update.add_argument(
        "--force", action="store_true", help="Update even if the block was edited in-file"
    )
    p_snip_update.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_status = snip_sub.add_parser(
        "status", help="Scan registered projects for snippet blocks (read-only)"
    )
    p_snip_status.add_argument("--name", help="Limit to one snippet")
    p_snip_status.add_argument("--project", help="Limit to one project")
    p_snip_status.add_argument("--json", action="store_true", help="Emit JSON")
    p_snip_reconcile = snip_sub.add_parser(
        "reconcile", help="Preview or apply a safe trailing snippet-region repair"
    )
    p_snip_reconcile.add_argument("--project", required=True, help="Registered project name")
    p_snip_reconcile.add_argument("--file", help="Project-relative agent doc path (default: canonical root)")
    p_snip_reconcile.add_argument("--dry-run", action="store_true", help="Preview only (the default)")
    p_snip_reconcile.add_argument("--apply", action="store_true", help="Write the repaired document")
    p_snip_reconcile.add_argument("--json", action="store_true", help="Emit JSON")
    # Private Rust bridge.  The editor buffer is stdin; this command is the
    # final writer for supported Agent Doc paths so Rust never reparses markers.
    p_snip_bridge = snip_sub.add_parser("reconcile-content", help=argparse.SUPPRESS)
    p_snip_bridge.add_argument("--path", required=True)
    p_snip_bridge.add_argument("--file", required=True)
    p_snip_bridge.add_argument("--expected-hash")
    p_snip_bridge.add_argument("--overwrite", action="store_true")
    p_snip_bridge.add_argument("--json", action="store_true")


def dispatch(args) -> None:
    snip_cmd = getattr(args, "snippet_cmd", None)
    if snip_cmd == "list":
        cmd_snippet_list(args)
    elif snip_cmd == "show":
        cmd_snippet_show(args)
    elif snip_cmd == "new":
        cmd_snippet_new(args)
    elif snip_cmd == "edit":
        cmd_snippet_edit(args)
    elif snip_cmd == "rename":
        cmd_snippet_rename(args)
    elif snip_cmd == "delete":
        cmd_snippet_delete(args)
    elif snip_cmd == "apply":
        cmd_snippet_apply(args)
    elif snip_cmd == "remove":
        cmd_snippet_remove(args)
    elif snip_cmd == "update":
        cmd_snippet_update(args)
    elif snip_cmd == "status":
        cmd_snippet_status(args)
    elif snip_cmd == "reconcile":
        if args.apply and args.dry_run:
            fail("--apply and --dry-run are mutually exclusive")
        cmd_snippet_reconcile(args)
    elif snip_cmd == "reconcile-content":
        cmd_snippet_reconcile_content(args)
    else:
        p_snip.print_help()


# ─────────────────────────────────────────────────────────────────────────────
# Snippets — reusable agent-doc instruction blocks (see snippets.py)
# ─────────────────────────────────────────────────────────────────────────────


def _snippet_ctx():
    from skill_hub.infrastructure.filesystem import snippets as _snippets

    registry = hub_core.load_registry()
    sdir = _snippets.snippets_dir(data_home())
    return _snippets, registry, sdir


def _snippet_read_body(args) -> Optional[str]:
    body = getattr(args, "body", None)
    body_file = getattr(args, "body_file", None)
    if body is not None and body_file:
        fail("--body and --body-file are mutually exclusive")
    if body_file:
        p = Path(body_file).expanduser()
        if not p.is_file():
            fail(f"--body-file not found: {body_file}")
        return p.read_text(encoding="utf-8")
    if body == "-":
        return sys.stdin.read()
    return body


def _snippet_installed():
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses

    return _harnesses.detect_installed()


def cmd_snippet_list(args):
    """List snippets with scan-derived usage roll-ups.

    Walks every registered project's agent docs ONCE (not once per snippet):
    `scan_all` is expensive (it reads every AGENTS.md/CLAUDE.md in every
    project), so we group its locations by snippet name up front and roll
    each group up locally with `usage_rollup` instead of re-scanning.
    """
    _snippets, registry, sdir = _snippet_ctx()
    items = _snippets.list_snippets(
        sdir, tag=getattr(args, "tag", None), query=getattr(args, "query", None)
    )
    library = _snippets.library_by_name(sdir)
    no_usage = getattr(args, "no_usage", False)
    rows = []
    if no_usage:
        rows = [s.to_dict(with_body=False) for s in items]
    else:
        grouped: dict[str, list[dict]] = {}
        for loc in _snippets.scan_all(registry, library)["locations"]:
            grouped.setdefault(loc["snippet"], []).append(loc)
        for s in items:
            usage = _snippets.usage_rollup(grouped.get(s.name, []))
            usage.pop("locations", None)
            rows.append({**s.to_dict(with_body=False), "usage": usage})
    if getattr(args, "json", False):
        print(json.dumps(rows, indent=2))
        return
    if not rows:
        print("No snippets. Create one with `hub snippet new <name>`.")
        return
    for r in rows:
        tags = " ".join(f"#{t}" for t in r["tags"])
        pip = ""
        if not no_usage:
            u = r["usage"]
            pip = "unused" if u["count"] == 0 else f"applied to {u['count']} ({u['summary']})"
        print(f"  {c(r['name'], BOLD)} v{r['version']} — {pip} {c(tags, DIM)}")
        if r["description"]:
            print(f"      {c(r['description'], DIM)}")


def cmd_snippet_show(args):
    """Show one snippet incl. body and scan-derived applied locations.

    `--no-usage` skips the project-tree scan entirely (no `usage` key) — the
    editor uses this for the fast initial paint and gets applied locations
    separately from `snippet status --name` (one walk, shared with the panel).
    """
    _snippets, registry, sdir = _snippet_ctx()
    s = _snippets.get_snippet(sdir, args.name)
    if s is None:
        fail(f'No snippet named "{args.name}".')
    no_usage = getattr(args, "no_usage", False)
    usage = None
    if no_usage:
        payload = s.to_dict()
    else:
        library = _snippets.library_by_name(sdir)
        usage = _snippets.snippet_usage(registry, library, s.name)
        payload = {**s.to_dict(), "usage": usage}
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
        return
    print(f"{c(s.name, BOLD)} v{s.version}  {' '.join('#' + t for t in s.tags)}")
    if s.description:
        print(f"  {s.description}")
    if usage is not None:
        for loc in usage["locations"]:
            print(f"  {loc['project']}/{loc['rel']}: {loc['status']}")
    print()
    print(s.body)


def cmd_snippet_new(args):
    """Create a snippet in <data_home>/snippets/."""
    from skill_hub.infrastructure.filesystem import snippets as _snippets

    body = _snippet_read_body(args) or ""
    tags = [t for t in (getattr(args, "tags", None) or "").split(",") if t.strip()]
    with data_home_lock():
        sdir = _snippets.snippets_dir(data_home())
        try:
            s = _snippets.create_snippet(
                sdir,
                args.name,
                description=getattr(args, "description", None) or "",
                tags=tags,
                body=body,
            )
        except _snippets.SnippetError as exc:
            fail(str(exc))
    if getattr(args, "json", False):
        print(json.dumps(s.to_dict(), indent=2))
    else:
        print(f"Created snippet {c(s.name, BOLD)} (v1)")


def cmd_snippet_edit(args):
    """Patch description/tags/body. Body changes bump the version."""
    _snippets, registry, sdir = _snippet_ctx()
    body = _snippet_read_body(args)
    tags_arg = getattr(args, "tags", None)
    tags = (
        [t for t in tags_arg.split(",") if t.strip()] if tags_arg is not None else None
    )
    with data_home_lock():
        try:
            s, body_changed = _snippets.edit_snippet(
                sdir,
                args.name,
                description=getattr(args, "description", None),
                tags=tags,
                body=body,
            )
        except _snippets.SnippetError as exc:
            fail(str(exc))
    outdated = 0
    if body_changed:
        library = _snippets.library_by_name(sdir)
        outdated = sum(
            1
            for loc in _snippets.applied_locations(registry, library, s.name)
            if loc["status"] == "outdated"
        )
    payload = {**s.to_dict(), "body_changed": body_changed, "outdated_locations": outdated}
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
        return
    print(f"Saved {c(s.name, BOLD)} (v{s.version})")
    if body_changed and outdated:
        print(
            f"  {c('!', YELLOW)} {outdated} applied location(s) are now outdated — "
            f"run `hub snippet update {s.name} --all` to propagate."
        )


def cmd_snippet_rename(args):
    """Rename a snippet and rewrite its marker id in every applied block.

    Exits 0 even when some locations land in `errors` — the rename itself
    landed (library file renamed); a location hub could not rewrite simply
    keeps the old marker id and the scan-derived status system reports it as
    orphaned, same honesty contract as every other partial-failure path here.
    """
    _snippets, registry, sdir = _snippet_ctx()
    backups_root = data_home() / "_hub-backups"
    with data_home_lock():
        try:
            res = _snippets.rename_snippet(
                registry,
                sdir,
                backups_root,
                args.old,
                args.new,
                installed=_snippet_installed(),
            )
        except _snippets.SnippetError as exc:
            fail(str(exc))
    if getattr(args, "json", False):
        print(json.dumps(res, indent=2))
        return
    print(f"Renamed {c(args.old, BOLD)} to {c(args.new, BOLD)}")
    for e in res["errors"]:
        print(
            f"  {c('!', YELLOW)} {e['project']}/{e['rel']} — {e['error']} "
            f"(block keeps the old id there — now orphaned)"
        )


def cmd_snippet_delete(args):
    """Delete a snippet definition. Scan-guarded; --force leaves blocks orphaned."""
    _snippets, registry, sdir = _snippet_ctx()
    library = _snippets.library_by_name(sdir)
    if args.name not in library:
        fail(f'No snippet named "{args.name}".')
    locs = _snippets.applied_locations(registry, library, args.name)
    if locs and not getattr(args, "force", False):
        files = ", ".join(f"{l['project']}/{l['rel']}" for l in locs)
        fail(
            f'"{args.name}" is applied to {len(locs)} file(s): {files}\n'
            f"Remove it there first, or re-run with --force to delete the definition "
            f"only (the in-file blocks remain and become orphaned)."
        )
    with data_home_lock():
        try:
            _snippets.delete_snippet(sdir, args.name)
        except _snippets.SnippetError as exc:
            fail(str(exc))
    payload = {
        "deleted": args.name,
        "orphaned_blocks": [
            {"project": l["project"], "rel": l["rel"]} for l in locs
        ],
    }
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
        return
    print(f"Deleted snippet {c(args.name, BOLD)}")
    if locs:
        print(
            f"  {c('!', YELLOW)} {len(locs)} in-file block(s) remain — now orphaned "
            f"(remove via `hub snippet remove` or by hand)."
        )


def cmd_snippet_apply(args):
    """Append a snippet block to a project agent doc file."""
    _snippets, registry, sdir = _snippet_ctx()
    library = _snippets.library_by_name(sdir)
    backups_root = data_home() / "_hub-backups"
    with data_home_lock():
        try:
            res = _snippets.apply_snippet(
                registry,
                library,
                backups_root,
                args.name,
                args.project,
                rel=getattr(args, "file", None),
                installed=_snippet_installed(),
            )
        except _snippets.SnippetError as exc:
            fail(str(exc))
    if getattr(args, "json", False):
        print(json.dumps(res, indent=2))
        return
    where = f"{res['project']}/{res['rel']}"
    extra = " (file created)" if res["created"] else ""
    if res["mirrored"]:
        extra += " (mirrored to " + ", ".join(m["rel"] for m in res["mirrored"]) + ")"
    print(f"Applied {c(args.name, BOLD)} → {where}{extra}")


def cmd_snippet_remove(args):
    """Excise a snippet block from a project agent doc file."""
    _snippets, registry, sdir = _snippet_ctx()
    library = _snippets.library_by_name(sdir)
    backups_root = data_home() / "_hub-backups"
    with data_home_lock():
        try:
            res = _snippets.remove_snippet(
                registry,
                library,
                backups_root,
                args.name,
                args.project,
                rel=getattr(args, "file", None),
                force=getattr(args, "force", False),
                installed=_snippet_installed(),
            )
        except _snippets.SnippetError as exc:
            fail(str(exc))
    if getattr(args, "json", False):
        print(json.dumps(res, indent=2))
        return
    print(f"Removed {c(args.name, BOLD)} from {res['project']}/{res['rel']}")


def cmd_snippet_update(args):
    """Refresh applied block(s) to the current library body."""
    _snippets, registry, sdir = _snippet_ctx()
    library = _snippets.library_by_name(sdir)
    backups_root = data_home() / "_hub-backups"
    use_all = getattr(args, "all", False)
    project = getattr(args, "project", None)
    if use_all and project:
        fail("--all and --project are mutually exclusive")
    if not use_all and not project:
        fail("Specify --project <name> (with optional --file) or --all")
    with data_home_lock():
        try:
            if use_all:
                res = _snippets.update_everywhere(
                    registry,
                    library,
                    backups_root,
                    args.name,
                    installed=_snippet_installed(),
                )
            else:
                res = _snippets.update_snippet_in_file(
                    registry,
                    library,
                    backups_root,
                    args.name,
                    project,
                    rel=getattr(args, "file", None),
                    force=getattr(args, "force", False),
                    installed=_snippet_installed(),
                )
        except _snippets.SnippetError as exc:
            fail(str(exc))
    if getattr(args, "json", False):
        print(json.dumps(res, indent=2))
        return
    if use_all:
        print(
            f"Updated {c(args.name, BOLD)} in {len(res['refreshed'])} location(s)"
        )
        for s in res["skipped"]:
            print(
                f"  {c('!', YELLOW)} skipped {s['project']}/{s['rel']} — modified "
                f"in-file; update it by hand or with --force per file"
            )
    else:
        print(f"Updated {c(args.name, BOLD)} in {res['project']}/{res['rel']}")


def cmd_snippet_status(args):
    """Scan registered projects for snippet blocks; pure read of file content."""
    _snippets, registry, sdir = _snippet_ctx()
    library = _snippets.library_by_name(sdir)
    proj_filter = getattr(args, "project", None)
    name_filter = getattr(args, "name", None)
    projects = registry.get("projects") or {}
    if proj_filter:
        if proj_filter not in projects:
            fail(f"Unknown project '{proj_filter}'.")
        result = _snippets.scan_project(proj_filter, projects[proj_filter], library)
    else:
        result = _snippets.scan_all(registry, library)
    if name_filter:
        result["locations"] = [
            l for l in result["locations"] if l["snippet"] == name_filter
        ]
    if getattr(args, "json", False):
        print(json.dumps(result, indent=2))
        return
    if not result["locations"] and not result["damaged"]:
        print("No snippet blocks found.")
        return
    for loc in result["locations"]:
        print(
            f"  {loc['project']}/{loc['rel']}: {c(loc['snippet'], BOLD)} "
            f"v{loc['version']} — {loc['status']}"
        )
    for d in result["damaged"]:
        print(
            f"  {c('!', RED)} {d['project']}/{d['rel']}:{d['line']} — "
            f"{d['kind']} marker for '{d['name']}' (clean up by hand in the editor)"
        )


def cmd_snippet_reconcile(args):
    """Preview (default) or apply one safe trailing-region repair."""
    _snippets, registry, sdir = _snippet_ctx()
    project = getattr(args, "project", None)
    if not project:
        fail("reconcile requires --project")
    try:
        with data_home_lock():
            result = _snippets.reconcile_snippet_file(
                registry, _snippets.library_by_name(sdir), data_home() / "_hub-backups",
                project, rel=getattr(args, "file", None),
                apply=getattr(args, "apply", False), installed=_snippet_installed(),
            )
    except _snippets.SnippetError as exc:
        fail(str(exc))
    if getattr(args, "json", False):
        print(json.dumps(result, indent=2))
        return
    state = "reconciled" if result["applied"] else "would reconcile" if result["changed"] else "already canonical"
    print(f"{result['project']}/{result['rel']}: {state}")


def cmd_snippet_reconcile_content(args):
    """Private native-editor bridge: reconcile and own the final disk write.

    Unlike public reconciliation this accepts the editor buffer on stdin.  It
    is deliberately limited to registered project agent-doc paths.
    """
    import hub

    _snippets, registry, sdir = _snippet_ctx()
    proj_name = hub._resolve_project_target(registry, None, getattr(args, "path", None))
    if not proj_name:
        fail("reconcile-content requires a registered --path")
    try:
        content = sys.stdin.read()
        target = _snippets.resolve_target(registry, proj_name, args.file, installed=_snippet_installed(), for_apply=True)  # noqa: E501
        if target["exists"]:
            actual = target["path"].read_bytes()
            current_hash = hashlib.sha256(actual).hexdigest()[:32]
            expected = getattr(args, "expected_hash", None)
            if not getattr(args, "overwrite", False) and (not expected or expected != current_hash):
                fail(json.dumps({"kind": "conflict", "current_hash": current_hash, "rel": target["rel"]}))
        result = _snippets.reconcile_snippet_region(content)
        with data_home_lock():
            # Recheck after taking Hub's cross-process lock, then backup and
            # atomically write the authoritative canonical editor buffer.
            if target["exists"] and not getattr(args, "overwrite", False):
                current_hash = hashlib.sha256(target["path"].read_bytes()).hexdigest()[:32]
                if not getattr(args, "expected_hash", None) or getattr(args, "expected_hash") != current_hash:
                    fail(json.dumps({"kind": "conflict", "current_hash": current_hash, "rel": target["rel"]}))
            backup = _snippets._backup_target(target["path"], proj_name, target["rel"], data_home() / "_hub-backups")
            _snippets._atomic_write(target["path"], result["content"])
        print(json.dumps({"content": result["content"], "changed": result["changed"], "placement": result["placement"], "diagnostics": result["diagnostics"], "backup": backup, "rel": target["rel"]}))  # noqa: E501
    except _snippets.SnippetMarkerError as exc:
        fail(json.dumps({
            "kind": "snippet_markers",
            "rel": target["rel"],
            "diagnostics": exc.diagnostics,
        }))
    except _snippets.SnippetError as exc:
        fail(str(exc))
