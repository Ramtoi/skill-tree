"""`hub source` — external skill source management (git checkouts, discovery,
conflict decisions, add/check/sync/remove/duplicate).

A "source" is the origin of one or more skills — a git checkout cached at
`<data_home>/sources/<id>/worktree/`. This module owns the CLI surface, the
`source add git` flow (`cmd_source_add_git`, `_do_source_add_clone_and_report`)
and the conflict-decision vocabulary. The registry data model —
`source_worktree_dir`, the `SOURCE_STATUS_*` vocabulary, the read-only
accessors and the source-linked-bundles reconciliation — lives in the leaf
`sources.py` (wave 18a of AUDIT.md) and is reached here through `hub.<name>`;
the git-source discovery primitives (`parse_git_url` … `discover_candidates`,
`classify_candidates`, `build_source_skill_entry`, `_git_clone`) joined that
leaf in wave 18b and are re-imported at the top of this file so `hub.<name>`
keeps resolving for tests.

`hub source restore` is likewise NOT handled here — it shares machinery with
the general `hub restore` system and stays a hub.py-only command; this
module's `dispatch()` forwards to `hub.cmd_source_restore` for that one verb.

Carved out of `hub.py` (S5 slice C) — see `hub_cli/__init__.py` for the
module contract this file implements (`NAME`, `register`, `dispatch`).
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Optional

import yaml

# `load_registry`/`save_registry` are called through the `hub_core.` module
# attribute (`hub_core.load_registry(...)`, not a value-imported name) because
# a value import snapshots the function object at module-load time: a test's
# `monkeypatch.setattr(hub, "save_registry", ...)` forwards through the
# `_HubFacade` to rebind `hub_core.save_registry` itself (see hub.py's
# `_HubFacade`), and a call site that already captured the original object
# would never see that rebind. Attribute access re-resolves on every call, so
# it always observes the current (possibly patched) binding. Everything else
# imported below is either immutable (colours, regexes) or itself a decorator
# applied once at import time, so a value import is safe for those.
from skill_hub import hub_core
from skill_hub.hub_core import (
    _GIT_NONINTERACTIVE_ENV,
    BOLD,
    GREEN,
    RED,
    SLUG_RE,
    YELLOW,
    _now_iso,
    _run_git,
    bundle_scope,
    c,
    collapse_home,
    data_home_lock,
    fail,
    registry_mutation,
    validate_slug,
)
from skill_hub.infrastructure.registry.sources import (  # noqa: F401  — re-exported: hub.py's bottom block and tests/test_source_add.py read them via skill_hub.entrypoints.cli.source
    GIT_DEFAULT_DEPTH,
    MAX_SCAN_DEPTH,
    _candidate_for_dir,
    _git_clone,
    build_source_skill_entry,
    candidate_counts,
    classify_candidates,
    derive_source_id_from_url,
    discover_candidates,
    normalize_scanned_path,
    parse_git_url,
    resolve_source_scan_path,
    strip_trailing_skill_md,
)

NAME = "source"

p_source = None
p_src_add = None
p_src_restore = None


def register(sub) -> None:
    global p_source, p_src_add, p_src_restore

    # source (external skill sources)
    p_source = sub.add_parser("source", help="Manage external skill sources")
    source_sub = p_source.add_subparsers(dest="source_cmd")
    p_src_list = source_sub.add_parser(
        "list", help="List sources (built-in + configured)"
    )
    p_src_list.add_argument("--json", action="store_true", help="Emit JSON")
    p_src_status = source_sub.add_parser(
        "status", help="Show detailed status for one source"
    )
    p_src_status.add_argument("id", help="Source id")
    p_src_status.add_argument("--json", action="store_true", help="Emit JSON")
    p_src_edit = source_sub.add_parser(
        "edit",
        help="Rename a source or curate which upstream skills it follows "
        "(the id is immutable)",
    )
    p_src_edit.add_argument("id", help="Source id")
    p_src_edit.add_argument("--name", help="New display name")
    p_src_edit.add_argument(
        "--include",
        help=(
            "Comma-separated upstream skill names this source may register; "
            "later syncs skip everything else"
        ),
    )
    p_src_edit.add_argument(
        "--include-all",
        dest="include_all",
        action="store_true",
        help="Clear the include filter (follow every upstream skill again)",
    )
    p_src_edit.add_argument("--json", action="store_true", help="Emit JSON")

    p_src_disable = source_sub.add_parser(
        "disable",
        help="Stop syncing a source's skills (they stay registered and equipped)",
    )
    p_src_disable.add_argument("id", help="Source id")
    p_src_disable.add_argument("--json", action="store_true", help="Emit JSON")

    p_src_enable = source_sub.add_parser(
        "enable", help="Resume syncing a source's skills"
    )
    p_src_enable.add_argument("id", help="Source id")
    p_src_enable.add_argument("--json", action="store_true", help="Emit JSON")

    p_src_add = source_sub.add_parser("add", help="Add a new source")
    src_add_sub = p_src_add.add_subparsers(dest="source_type")
    p_src_add_git = src_add_sub.add_parser("git", help="Add a Git repository source")
    p_src_add_git.add_argument("url", help="Git URL (SSH or HTTPS)")
    p_src_add_git.add_argument(
        "--id", help="Source id slug (default: derived from URL)"
    )
    p_src_add_git.add_argument("--name", help="Display name (default: source id)")
    p_src_add_git.add_argument("--branch", help="Branch (default: remote default)")
    p_src_add_git.add_argument(
        "--path",
        default=None,
        help=(
            "Repo-relative subdirectory to scan. Wins over a subpath carried by "
            "a deep tree/blob URL; omit to use the URL's subpath"
        ),
    )
    p_src_add_git.add_argument(
        "--dry-run",
        action="store_true",
        help="Clone to temp, return preview, no registry mutation",
    )
    p_src_add_git.add_argument(
        "--decisions-stdin",
        dest="decisions_stdin",
        action="store_true",
        help=(
            "Read per-conflict decisions from stdin as "
            '{"decisions": {"<name>": "skip"|"replace"|"suffix"}, '
            '"selected_new": ["<name>", ...]} (apply only). '
            "`selected_new` is optional; absent ⇒ every NEW candidate is imported"
        ),
    )
    p_src_add_git.add_argument("--json", action="store_true", help="Emit JSON")

    p_src_check = source_sub.add_parser(
        "check", help="Fetch and compare refs without mutating skill files"
    )
    p_src_check.add_argument("id", help="Source id")
    p_src_check.add_argument("--json", action="store_true", help="Emit JSON")

    p_src_sync = source_sub.add_parser(
        "sync", help="Pull configured branch, rescan candidates, update metadata"
    )
    p_src_sync.add_argument("id", help="Source id")
    p_src_sync.add_argument("--json", action="store_true", help="Emit JSON")

    p_src_restore = source_sub.add_parser(
        "restore",
        help="Re-clone a git source whose cache is missing (the recovery path "
        "after a restore — `source sync` fails outright on a missing cache)",
    )
    p_src_restore.add_argument("id", nargs="?", help="Source id")
    p_src_restore.add_argument(
        "--all", action="store_true", help="Restore every registered git source"
    )
    p_src_restore.add_argument("--json", action="store_true", help="Emit JSON")

    p_src_remove = source_sub.add_parser(
        "remove", help="Remove a source (preview with --dry-run before applying)"
    )
    p_src_remove.add_argument("id", help="Source id")
    p_src_remove.add_argument(
        "--dry-run", action="store_true", help="Preview impact without mutating"
    )
    p_src_remove.add_argument(
        "--mode",
        choices=["unequip", "keep-local"],
        help="Apply mode: 'unequip' removes everything; 'keep-local' converts owned skills to local copies",
    )
    p_src_remove.add_argument("--json", action="store_true", help="Emit JSON")

    p_src_dup = source_sub.add_parser(
        "duplicate",
        help="Duplicate an external/starter skill into a local editable copy",
    )
    p_src_dup.add_argument("name", help="Existing managed skill name")
    p_src_dup.add_argument(
        "--as", dest="new_name", help="New local slug (default: <name>-local)"
    )
    p_src_dup.add_argument("--json", action="store_true", help="Emit JSON")

    p_src_dropped = source_sub.add_parser(
        "dropped",
        help="List skills upstream has renamed or deleted (source_missing) — read-only",
    )
    p_src_dropped.add_argument(
        "id", nargs="?", help="Limit to one source id (default: every source)"
    )
    p_src_dropped.add_argument("--skill", help="Limit to one skill name")
    p_src_dropped.add_argument(
        "--content",
        action="store_true",
        help="Include the skill's last-known SKILL.md body (skill_md)",
    )
    p_src_dropped.add_argument("--json", action="store_true", help="Emit JSON")

    p_src_recover = source_sub.add_parser(
        "recover",
        help="Keep as local: restore a dropped-upstream skill's last-known "
        "content into the data home as a managed:local skill",
    )
    p_src_recover.add_argument("name", help="Registered skill name (must be source_missing)")
    p_src_recover.add_argument("--json", action="store_true", help="Emit JSON")



def dispatch(args) -> None:
    sc = getattr(args, "source_cmd", None)
    if sc == "list":
        cmd_source_list(args)
    elif sc == "status":
        cmd_source_status(args)
    elif sc == "edit":
        cmd_source_edit(args)
    elif sc == "disable":
        cmd_source_disable(args)
    elif sc == "enable":
        cmd_source_enable(args)
    elif sc == "add":
        if args.source_type == "git":
            cmd_source_add_git(args)
        else:
            p_src_add.print_help()
    elif sc == "check":
        cmd_source_check(args)
    elif sc == "sync":
        cmd_source_sync(args)
    elif sc == "restore":
        # `hub source restore` shares machinery with the general `hub restore`
        # system and stays defined in hub.py — see the module docstring.
        import hub

        if not getattr(args, "id", None) and not getattr(args, "all", False):
            p_src_restore.print_help()
        else:
            hub.cmd_source_restore(args)
    elif sc == "remove":
        cmd_source_remove(args)
    elif sc == "duplicate":
        cmd_source_duplicate(args)
    elif sc == "dropped":
        cmd_source_dropped(args)
    elif sc == "recover":
        cmd_source_recover(args)
    else:
        p_source.print_help()


def get_source(registry: dict, source_id: str) -> Optional[dict]:
    """Return a single source view (built-in or configured), or None."""
    import hub
    for entry in hub.list_sources(registry):
        if entry["id"] == source_id:
            return entry
    return None


# ─────────────────────────────────────────────────────────────────────────────
# `hub source` commands (read-only inspection — write commands land in §2/§3)
# ─────────────────────────────────────────────────────────────────────────────


def _fmt_iso_display(value: Optional[str]) -> str:
    return value if value else "—"


def cmd_source_list(args):
    import hub
    registry = hub_core.load_registry()
    errors = hub.validate_sources_registry(registry)
    sources = hub.list_sources(registry)
    payload = {"sources": sources, "errors": errors}
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2, sort_keys=False))
        return

    for err in errors:
        print(f"{c('!', YELLOW)} {err}", file=sys.stderr)
    if not sources:
        print("No sources configured.")
        return
    header = f"{'ID':24} {'TYPE':10} {'NAME':24} {'STATUS':18} SKILLS"
    print(c(header, BOLD))
    for s in sources:
        sid = s["id"]
        stype = s["type"]
        name = s.get("name") or sid
        status = s.get("status") or "—"
        if not s.get("enabled", True):
            status = f"{status} (off)"
        count = s.get("skill_count", 0)
        print(f"{sid:24} {stype:10} {name:24} {status:18} {count}")


def cmd_source_status(args):
    import hub
    registry = hub_core.load_registry()
    errors = hub.validate_sources_registry(registry)
    sid = args.id
    entry = get_source(registry, sid)
    payload = {"source": entry, "skills": [], "errors": errors}
    if entry is None:
        payload["error"] = f"source '{sid}' not found"
        if getattr(args, "json", False):
            print(json.dumps(payload, indent=2, sort_keys=False))
            return
        print(payload["error"], file=sys.stderr)
        sys.exit(1)
    payload["skills"] = hub.imported_skills_for_source(registry, sid)
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2, sort_keys=False))
        return

    name = entry.get("name") or sid
    off = "" if entry.get("enabled", True) else c("  [disabled]", YELLOW)
    print(
        f"{c(name, BOLD)} ({sid})  type={entry['type']}  "
        f"status={entry.get('status') or '—'}{off}"
    )
    if entry["type"] == "git":
        print(f"  url:           {entry.get('url') or '—'}")
        print(f"  branch:        {entry.get('branch') or '—'}")
        print(f"  path:          {entry.get('path') or '/'}")
        print(f"  current_ref:   {entry.get('current_ref') or '—'}")
        print(f"  remote_ref:    {entry.get('remote_ref') or '—'}")
        print(f"  last_checked:  {_fmt_iso_display(entry.get('last_checked_at'))}")
        print(f"  last_synced:   {_fmt_iso_display(entry.get('last_synced_at'))}")
        if entry.get("error"):
            print(f"  {c('error', RED)}:         {entry['error']}")
    print(f"  managed skills: {len(payload['skills'])}")
    for s in payload["skills"]:
        print(f"    - {s['name']}  ({s.get('scope') or '—'})")


def _fail_source_manage(args, message: str, **extra) -> None:
    """Uniform error exit for `source edit|disable|enable` (JSON-aware)."""
    if getattr(args, "json", False):
        payload = {"source": None, "errors": [message]}
        payload.update(extra)
        print(json.dumps(payload, indent=2))
    else:
        print(f"{c('error', RED)}: {message}", file=sys.stderr)
    sys.exit(1)


def _require_manageable_source(registry: dict, source_id: str, args) -> dict:
    """Return the raw `sources:<id>` dict, or exit with a friendly error.

    Built-ins (local / starter) are synthesized views, not registry entries —
    there is nothing to rename or switch off, so they are refused outright.
    """
    import hub
    if source_id in hub.BUILT_IN_SOURCE_IDS:
        _fail_source_manage(
            args, f"source '{source_id}' is built-in and cannot be modified"
        )
    sources = registry.get("sources") if isinstance(registry, dict) else None
    if not isinstance(sources, dict) or source_id not in sources:
        _fail_source_manage(args, f"source '{source_id}' not found")
    cfg = sources[source_id]
    if not isinstance(cfg, dict):
        _fail_source_manage(args, f"source '{source_id}' has invalid configuration")
    return cfg


def _source_impact(registry: dict, source_id: str) -> dict:
    """Which skills / bundles / projects a source's artifacts reach.

    Same walk as `_source_remove_impact` (owned skills → bundles holding them →
    projects equipping them directly, through those bundles, or through a
    global-scope bundle that auto-applies everywhere), flattened to plain name
    lists for the disable/enable payload so the UI can keep the user in the loop.
    """
    import hub
    owned = [s["name"] for s in hub.imported_skills_for_source(registry, source_id)]
    owned_set = set(owned)

    bundles_block = registry.get("bundles") if isinstance(registry, dict) else None
    bundles: list[str] = []
    global_bundle_hit = False
    if isinstance(bundles_block, dict):
        for bname, bcfg in bundles_block.items():
            if not isinstance(bcfg, dict):
                continue
            if not any(s in owned_set for s in bcfg.get("skills") or []):
                continue
            bundles.append(bname)
            if bundle_scope(bcfg) == "global":
                global_bundle_hit = True

    bundle_set = set(bundles)
    projects_block = registry.get("projects") if isinstance(registry, dict) else None
    projects: list[str] = []
    if isinstance(projects_block, dict):
        for pname, pcfg in projects_block.items():
            if not isinstance(pcfg, dict):
                continue
            direct = any(s in owned_set for s in pcfg.get("enabled") or [])
            via = any(b in bundle_set for b in pcfg.get("bundles") or [])
            if direct or via or global_bundle_hit:
                projects.append(pname)

    return {"skills": owned, "bundles": bundles, "projects": projects}


@registry_mutation("source-edit")
def cmd_source_edit(args):
    """`hub source edit <id> [--name <label>] [--include a,b | --include-all]`.

    Cosmetic + curation only: the id stays the identity used by `origin.source`,
    ownership inference, and the caches, so no sync is needed. Setting an
    `include` filter is forward-looking — it decides which upstream skills a
    LATER `source sync` may register, and never retro-archives anything the
    source already owns.
    """
    source_id = args.id
    registry = hub_core.load_registry()
    cfg = _require_manageable_source(registry, source_id, args)

    raw_name = getattr(args, "name", None)
    raw_include = getattr(args, "include", None)
    include_all = bool(getattr(args, "include_all", False))
    if raw_name is None and raw_include is None and not include_all:
        _fail_source_manage(args, "nothing to change: pass --name, --include or --include-all")
    if raw_include is not None and include_all:
        _fail_source_manage(args, "--include and --include-all are mutually exclusive")

    new_name = None
    if raw_name is not None:
        new_name = raw_name.strip()
        if not new_name:
            _fail_source_manage(args, "--name must not be empty")

    include_names: Optional[list[str]] = None
    if raw_include is not None:
        include_names = [part.strip() for part in raw_include.split(",") if part.strip()]
        if not include_names:
            _fail_source_manage(
                args, "--include needs at least one skill name (use --include-all to clear)"
            )
        bad = sorted({n for n in include_names if not SLUG_RE.match(n)})
        if bad:
            _fail_source_manage(
                args,
                f"invalid skill name(s) in --include: {', '.join(bad)} "
                f"(expected {SLUG_RE.pattern})",
            )
        include_names = sorted(set(include_names))

    if new_name is not None:
        cfg["name"] = new_name
    if include_names is not None:
        cfg["include"] = include_names
    elif include_all:
        cfg.pop("include", None)
    hub_core.save_registry(registry)
    entry = get_source(registry, source_id)

    if getattr(args, "json", False):
        print(json.dumps({"source": entry, "errors": []}, indent=2))
        return
    if new_name is not None:
        print(f"{c('✓', GREEN)} renamed source '{source_id}' → {new_name}")
    if include_names is not None:
        print(
            f"{c('✓', GREEN)} source '{source_id}' now follows "
            f"{len(include_names)} upstream skill(s): {', '.join(include_names)}"
        )
    elif include_all:
        print(f"{c('✓', GREEN)} source '{source_id}' now follows every upstream skill")


def _set_source_enabled(args, enabled: bool) -> None:
    """Shared body of `hub source enable|disable` — flip the flag, then sync.

    The registry's skills / bundles / projects are NEVER touched: disabling only
    writes `enabled: false` on the source entry, and the sync passes read that
    flag to treat the source's skills as inactive. Re-enabling restores every
    link because nothing was unequipped. Idempotent — a no-op skips the sync.
    """
    import hub
    source_id = args.id
    registry = hub_core.load_registry()
    cfg = _require_manageable_source(registry, source_id, args)
    changed = hub.source_enabled(cfg) != enabled
    if changed:
        if enabled:
            cfg.pop("enabled", None)  # absent ⇒ enabled
        else:
            cfg["enabled"] = False
        hub_core.save_registry(registry)

    impact = _source_impact(registry, source_id)
    entry = get_source(registry, source_id)

    if getattr(args, "json", False):
        # Payload FIRST, on ONE line — the auto-sync below shares this stdout.
        print(
            json.dumps(
                {
                    "source": entry,
                    "enabled": enabled,
                    "changed": changed,
                    "impact": impact,
                }
            )
        )
        sys.stdout.flush()
    else:
        state = "enabled" if enabled else "disabled"
        suffix = "" if changed else " (already)"
        print(f"{c('✓', GREEN)} source '{source_id}' {state}{suffix}")
        if not enabled and impact["skills"]:
            print(
                f"  {len(impact['skills'])} skills stay registered but are not "
                f"synced while disabled"
            )
        if impact["bundles"]:
            print(f"  bundles:  {', '.join(impact['bundles'])}")
        if impact["projects"]:
            print(f"  projects: {', '.join(impact['projects'])}")

    if changed:
        hub._auto_sync()


@registry_mutation("source-disable")
def cmd_source_disable(args):
    """`hub source disable <id>` — stop syncing a source's skills (reversible)."""
    _set_source_enabled(args, False)


@registry_mutation("source-enable")
def cmd_source_enable(args):
    """`hub source enable <id>` — resume syncing a source's skills."""
    _set_source_enabled(args, True)


FIRST_DEDUP_SUFFIX = 2  # "-2" is the first generated suffix: base, base-2, base-3, …
# The source-import conflict-decision vocabulary (CLI --decisions-stdin contract).
CONFLICT_DECISION_ACTIONS = ("skip", "replace", "suffix")


def _dedup_suffix_name(base: str, skills_block: dict) -> str:
    """Return the first free ``<base>-N`` not present in ``skills_block``."""
    i = FIRST_DEDUP_SUFFIX
    while f"{base}-{i}" in skills_block:
        i += 1
    return f"{base}-{i}"


def _fail_source_apply(args, message: str, clone_dest: Path):
    """Abort a source-add apply cleanly (no partial write): drop the clone cache,
    emit the error via the caller's JSON/plain channel, and exit non-zero."""
    payload = {"ok": False, "error": message}
    try:
        if clone_dest.exists():
            shutil.rmtree(clone_dest, ignore_errors=True)
    except OSError:
        pass
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
    else:
        print(f"{c('error', RED)}: {message}", file=sys.stderr)
    sys.exit(1)


def cmd_source_add_git(args):
    """``hub source add git <url> [...]`` — clone, scan, optionally register."""
    import hub
    parsed_url = parse_git_url(args.url)
    clone_url = parsed_url["clone_url"]
    branch = args.branch or parsed_url["branch"]
    url_subpath = parsed_url["path"] or ""
    raw_path = resolve_source_scan_path(url_subpath, getattr(args, "path", None))
    source_id = args.id or derive_source_id_from_url(clone_url)
    hub.validate_source_id(source_id)

    # Subpath safety: validate the configured subdir is repo-relative before clone.
    if raw_path:
        try:
            hub.normalize_subpath_within(Path("/__placeholder_root__"), raw_path)
        except ValueError as exc:
            payload = {"ok": False, "error": str(exc)}
            if getattr(args, "json", False):
                print(json.dumps(payload, indent=2))
            else:
                print(f"{c('error', RED)}: {exc}", file=sys.stderr)
            sys.exit(1)

    def _reject_existing(registry: dict) -> bool:
        """Emit the collision error if ``source_id`` is already configured.
        Returns True when it printed + should short-circuit the caller."""
        existing = registry.get("sources") if isinstance(registry, dict) else None
        if isinstance(existing, dict) and source_id in existing:
            payload = {"ok": False, "error": f"source '{source_id}' already exists"}
            if getattr(args, "json", False):
                print(json.dumps(payload, indent=2))
            else:
                print(payload["error"], file=sys.stderr)
            return True
        return False

    if args.dry_run:
        registry = hub._read_registry_optional()
        # Fail the preview up front instead of cloning and then failing at apply.
        if _reject_existing(registry):
            sys.exit(1)
        stage_root = Path(tempfile.mkdtemp(prefix=f"skill-hub-src-{source_id}-"))
        clone_dest = stage_root / "worktree"
        try:
            _do_source_add_clone_and_report(
                args=args,
                source_id=source_id,
                clone_url=clone_url,
                branch=branch,
                raw_path=raw_path,
                url_subpath=url_subpath,
                clone_dest=clone_dest,
                registry=registry,
                apply=False,
            )
        finally:
            shutil.rmtree(stage_root, ignore_errors=True)
        return

    with data_home_lock():
        registry = hub_core.load_registry()
        if _reject_existing(registry):
            sys.exit(1)
        cache_root = hub.source_cache_dir(source_id)
        cache_root.mkdir(parents=True, exist_ok=True)
        clone_dest = cache_root / "worktree"
        if clone_dest.exists():
            shutil.rmtree(clone_dest)
        registered = _do_source_add_clone_and_report(
            args=args,
            source_id=source_id,
            clone_url=clone_url,
            branch=branch,
            raw_path=raw_path,
            url_subpath=url_subpath,
            clone_dest=clone_dest,
            registry=registry,
            apply=True,
        )
        # Payload/human output is already on stdout above; the app's
        # `source_add_apply` bridge parses the WHOLE stdout as one JSON
        # document, so the sync stream's chatter is redirected to stderr —
        # stdout stays byte-identical to before this wave (plans/1.md #5).
        if registered:
            with contextlib.redirect_stdout(sys.stderr):
                hub._auto_sync_tail()


def _scan_base_hint(checkout: Path, url_subpath: str, raw_path: str) -> Optional[str]:
    """Suggest ``<url_subpath>/<raw_path>`` when THAT exists in the checkout.

    Covers the common mistake of typing a path relative to the deep URL's
    subpath instead of relative to the repo root.
    """
    import hub
    if not url_subpath or not raw_path or raw_path == url_subpath:
        return None
    composed = f"{url_subpath.strip('/')}/{raw_path.strip('/')}"
    try:
        candidate = hub.normalize_subpath_within(checkout, composed)
    except ValueError:
        return None
    return composed if candidate.is_dir() else None


def _fail_source_scan_path(
    args,
    *,
    clone_dest: Path,
    raw_path: str,
    hint_path: Optional[str],
    is_file: bool = False,
) -> None:
    """Abort a source add whose scan base is not a directory in the checkout.

    A missing base used to be indistinguishable from "no skills here" (both
    rendered as four zeros); it is an error with its own code so callers can
    offer the fix instead of showing an empty preview. A path that resolves to
    a FILE says so — telling someone a file they can see "does not exist"
    sends them looking for the wrong problem.
    """
    if is_file:
        message = f"path '{raw_path}' is not a directory"
    else:
        message = f"path '{raw_path}' does not exist in the repository"
    if hint_path:
        message += f" — did you mean '{hint_path}'?"
    payload = {
        "ok": False,
        "error": "path_not_found",
        "message": message,
        "scanned_path": normalize_scanned_path(raw_path),
    }
    if hint_path:
        payload["hint_path"] = hint_path
    shutil.rmtree(clone_dest, ignore_errors=True)
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
    else:
        print(f"{c('error', RED)}: {message}", file=sys.stderr)
    sys.exit(1)


def _do_source_add_clone_and_report(
    *,
    args,
    source_id: str,
    clone_url: str,
    branch: Optional[str],
    raw_path: str,
    url_subpath: str = "",
    clone_dest: Path,
    registry: dict,
    apply: bool,
) -> bool:
    """Shared body for dry-run preview and apply. Caller owns lock + cleanup.

    Returns True when the apply path reached `hub_core.save_registry` (i.e. a
    registry write actually happened) and False for every other return —
    the preview branch, in particular — so the caller knows whether an
    auto-sync tail is warranted.
    """
    import hub
    clone = _git_clone(clone_url, branch, clone_dest)
    if not clone["ok"]:
        payload = {"ok": False, "error": clone["error"]}
        if apply and clone_dest.exists():
            shutil.rmtree(clone_dest, ignore_errors=True)
        if getattr(args, "json", False):
            print(json.dumps(payload, indent=2))
        else:
            print(f"{c('error', RED)}: {clone['error']}", file=sys.stderr)
        sys.exit(1)

    # The scan base must exist BEFORE classification: `discover_candidates`
    # returns [] for a missing base, which would otherwise read as an honest
    # "this subtree has no skills".
    try:
        scan_base = hub.normalize_subpath_within(clone_dest, raw_path or "")
    except ValueError:
        scan_base = None
    if scan_base is None or not scan_base.is_dir():
        _fail_source_scan_path(
            args,
            clone_dest=clone_dest,
            raw_path=raw_path or "",
            hint_path=_scan_base_hint(clone_dest, url_subpath, raw_path or ""),
            is_file=scan_base is not None and scan_base.is_file(),
        )

    candidates = discover_candidates(clone_dest, raw_path or "")
    classified = classify_candidates(candidates, registry, source_id)
    counts = candidate_counts(classified)

    source_meta = {
        "type": "git",
        "name": args.name or source_id,
        "url": clone_url,
        "branch": branch,
        "path": raw_path or "",
        "auth": "system-git",
        "cache": str(clone_dest),
        "current_ref": clone["ref"],
        "remote_ref": None,
        "status": hub.SOURCE_STATUS_UP_TO_DATE,
        "last_checked_at": _now_iso(),
        "last_synced_at": _now_iso() if apply else None,
        "error": None,
    }

    if not apply:
        payload = {
            "ok": True,
            "preview": True,
            "source": {"id": source_id, **source_meta},
            "scanned_path": normalize_scanned_path(raw_path),
            "candidates": classified,
            "counts": counts,
        }
        if getattr(args, "json", False):
            print(json.dumps(payload, indent=2))
        else:
            print(
                f"preview '{source_id}' at "
                f"'{normalize_scanned_path(raw_path) or '<repo root>'}': "
                f"new={counts['new']} conflicts={counts['conflicts']} "
                f"imported={counts['imported']} invalid={counts['invalid']}"
            )
            for cand in classified:
                print(
                    f"  [{cand['category']:8}] {cand['name']}  ({cand.get('origin_path', '')})"
                )
        return False

    sources_block = registry.setdefault("sources", {})
    sources_block[source_id] = source_meta
    skills_block = registry.setdefault("skills", {})

    # Per-conflict decisions channel (D7). Only read stdin when the flag is set;
    # absent ⇒ empty map ⇒ every CONFLICT candidate defaults to skip (the legacy
    # behavior). Unknown actions are rejected up front, BEFORE any staging, so a
    # malformed decision can never produce a partial `save_registry`.
    decisions: dict = {}
    selected_new: Optional[set] = None
    if getattr(args, "decisions_stdin", False):
        try:
            raw_stdin = sys.stdin.read()
            stdin_payload = json.loads(raw_stdin) if raw_stdin.strip() else {}
        except json.JSONDecodeError as exc:
            _fail_source_apply(args, f"invalid decisions JSON: {exc}", clone_dest)
        decisions = (stdin_payload or {}).get("decisions") or {}
        if not isinstance(decisions, dict):
            _fail_source_apply(args, "decisions must be an object", clone_dest)
        for cand_name, action in decisions.items():
            if action not in CONFLICT_DECISION_ACTIONS:
                _fail_source_apply(
                    args,
                    f"unknown decision '{action}' for candidate '{cand_name}' "
                    f"(expected skip|replace|suffix)",
                    clone_dest,
                )

        # Per-skill selection (optional). Absent ⇒ every NEW candidate is
        # imported (the legacy behavior); present ⇒ only the listed ones are.
        # Names outside the discovered NEW set fail closed, BEFORE any staging,
        # so a stale UI selection can never silently import the wrong set.
        raw_selected = (stdin_payload or {}).get("selected_new")
        if raw_selected is not None:
            if not isinstance(raw_selected, list) or any(
                not isinstance(n, str) for n in raw_selected
            ):
                _fail_source_apply(
                    args, "selected_new must be a list of candidate names", clone_dest
                )
            new_names = {
                cand["name"] for cand in classified if cand["category"] == "NEW"
            }
            unknown = sorted({n for n in raw_selected if n not in new_names})
            if unknown:
                _fail_source_apply(
                    args,
                    "unknown selected_new candidate(s): " + ", ".join(unknown),
                    clone_dest,
                )
            selected_new = set(raw_selected)

    def _build_source_entry(cand: dict) -> dict:
        return build_source_skill_entry(
            cand,
            source_id=source_id,
            checkout=clone_dest,
            ref=clone["ref"],
            upstream=clone_url,
        )

    registered: list[str] = []
    skipped: list[dict] = []
    resolved: list[dict] = []
    for cand in classified:
        category = cand["category"]
        name = cand["name"]
        if category == "NEW":
            if selected_new is not None and name not in selected_new:
                skipped.append({"name": name, "reason": "NOT_SELECTED"})
                continue
            skills_block[name] = _build_source_entry(cand)
            registered.append(name)
            continue
        if category == "CONFLICT":
            action = decisions.get(name, "skip")
            if action == "skip":
                skipped.append({"name": name, "reason": "CONFLICT"})
                resolved.append({"name": name, "action": "skip", "final_name": None})
                continue
            if action == "replace":
                skills_block[name] = _build_source_entry(cand)
                registered.append(name)
                resolved.append(
                    {"name": name, "action": "replace", "final_name": name}
                )
                continue
            # suffix — register the source candidate under a de-duplicated name,
            # leaving the existing skill intact.
            final_name = _dedup_suffix_name(name, skills_block)
            skills_block[final_name] = _build_source_entry(cand)
            registered.append(final_name)
            resolved.append(
                {"name": name, "action": "suffix", "final_name": final_name}
            )
            continue
        # IMPORTED / INVALID — never touched.
        skipped.append({"name": name, "reason": category})

    # A curated selection persists as a source-level filter, so `hub source
    # sync` can never silently re-add what was deliberately left behind.
    #
    # ONLY an explicit `selected_new` that leaves some NEW candidate out earns
    # the field. Everything else — no stdin at all, no `selected_new` key, or a
    # selection covering every NEW candidate — writes nothing, so the source
    # keeps following upstream exactly as it did before this feature.
    #
    # What lands in the filter is the union of the chosen NEW names, EVERY
    # conflicting upstream name (whatever its decision), and the names this
    # source already owns. A skipped conflict is "not now", not "never": it must
    # keep re-surfacing in `new_pending` on later syncs the way it always has,
    # which it only can while it is inside the filter. INVALID names are counted
    # nowhere — they cannot be registered by any path, so listing them would
    # only make the filter lie about what the user chose.
    if selected_new is not None:
        new_names = {cand["name"] for cand in classified if cand["category"] == "NEW"}
        if selected_new < new_names:
            keep = set(selected_new)
            keep |= {
                cand["name"]
                for cand in classified
                if cand["category"] in ("CONFLICT", "IMPORTED")
            }
            source_meta["include"] = sorted(keep)

    hub_core.save_registry(registry)

    payload = {
        "ok": True,
        "preview": False,
        "source": {"id": source_id, **source_meta},
        "scanned_path": normalize_scanned_path(raw_path),
        "candidates": classified,
        "counts": counts,
        "registered": registered,
        "skipped": skipped,
        "resolved": resolved,
    }
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
    else:
        print(f"Registered source '{source_id}' with {len(registered)} skills.")
        for name in registered:
            print(f"  + {name}")
        for s in skipped:
            print(f"  - {s['name']} ({s['reason']})")
        if source_meta.get("include") is not None:
            print(
                f"  filter: only {len(source_meta['include'])} of "
                f"{len(classified)} upstream skills will follow this source"
            )
    return True


# ─────────────────────────────────────────────────────────────────────────────
# §3 Source check / sync / remove
#
# Lifecycle commands:
#   hub source check <id>   git fetch + compare refs; mutate status only.
#   hub source sync  <id>   pull configured branch, rescan candidates, update
#                           metadata; classify added/changed/removed; flag
#                           removed-upstream skills as source-missing without
#                           silently deleting them.
#   hub source remove <id>  --dry-run preview blast radius; --mode unequip
#                           tears down everything owned by the source; --mode
#                           keep-local converts owned skills into data-home
#                           local skills before removing the source entry.
#
# Mutation order across all three (design D7): stage filesystem first, acquire
# data-home lock, write registry, then run/prompt sync, then clean caches.
# ─────────────────────────────────────────────────────────────────────────────


def _require_configured_git_source(registry: dict, source_id: str) -> dict:
    """Return the raw registry source dict, or exit with a friendly error."""
    sources = registry.get("sources") if isinstance(registry, dict) else None
    if not isinstance(sources, dict) or source_id not in sources:
        fail(f"source '{source_id}' not found")
    cfg = sources[source_id]
    if not isinstance(cfg, dict):
        fail(f"source '{source_id}' has invalid configuration")
    if (cfg.get("type") or "git") != "git":
        fail(f"source '{source_id}' is not a git source")
    return cfg


def _git_fetch(checkout_dir: Path, branch: Optional[str]) -> dict:
    """Run ``git fetch origin <branch>``. Returns ``{ok, remote_ref, error}``."""
    args = ["fetch", "--quiet", "origin"]
    if branch:
        args.append(branch)
    try:
        res = _run_git(args, cwd=checkout_dir)
    except FileNotFoundError:
        return {"ok": False, "remote_ref": None, "error": "git executable not found"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "remote_ref": None, "error": "git fetch timed out"}
    if res.returncode != 0:
        msg = (res.stderr or res.stdout or "git fetch failed").strip()
        return {"ok": False, "remote_ref": None, "error": msg}
    ref_res = _run_git(["rev-parse", "FETCH_HEAD"], cwd=checkout_dir)
    remote_ref = ref_res.stdout.strip() if ref_res.returncode == 0 else None
    return {"ok": True, "remote_ref": remote_ref, "error": None}


def _git_checkout_fetched(checkout_dir: Path) -> dict:
    """Hard-reset the checkout to ``FETCH_HEAD``. Returns ``{ok, ref, error}``."""
    res = _run_git(["reset", "--hard", "FETCH_HEAD"], cwd=checkout_dir)
    if res.returncode != 0:
        msg = (res.stderr or res.stdout or "git reset failed").strip()
        return {"ok": False, "ref": None, "error": msg}
    ref_res = _run_git(["rev-parse", "HEAD"], cwd=checkout_dir)
    return {
        "ok": True,
        "ref": ref_res.stdout.strip() if ref_res.returncode == 0 else None,
        "error": None,
    }


def cmd_source_check(args):
    """`hub source check <id>` — fetch remote refs, compare, do not mutate skill files."""
    import hub
    source_id = args.id
    with data_home_lock():
        registry = hub_core.load_registry()
        cfg = _require_configured_git_source(registry, source_id)
        checkout = Path(cfg.get("cache") or str(hub.source_worktree_dir(source_id)))
        if not checkout.exists():
            fail(
                f"source '{source_id}' cache missing at {checkout}; run sync to recreate"
            )

        fetch = _git_fetch(checkout, cfg.get("branch"))
        cfg["last_checked_at"] = _now_iso()
        if not fetch["ok"]:
            cfg["status"] = hub.SOURCE_STATUS_ERROR
            cfg["error"] = fetch["error"]
            hub_core.save_registry(registry)
            payload = {"ok": False, "source_id": source_id, "error": fetch["error"]}
            if getattr(args, "json", False):
                print(json.dumps(payload, indent=2))
            else:
                print(f"{c('error', RED)}: {fetch['error']}", file=sys.stderr)
            sys.exit(1)

        current_ref = cfg.get("current_ref")
        remote_ref = fetch["remote_ref"]
        cfg["remote_ref"] = remote_ref
        cfg["error"] = None
        if current_ref and remote_ref and current_ref == remote_ref:
            status = hub.SOURCE_STATUS_UP_TO_DATE
        else:
            status = hub.SOURCE_STATUS_UPDATE_AVAILABLE
        cfg["status"] = status
        hub_core.save_registry(registry)

        payload = {
            "ok": True,
            "source_id": source_id,
            "status": status,
            "current_ref": current_ref,
            "remote_ref": remote_ref,
            "last_checked_at": cfg["last_checked_at"],
        }
        if getattr(args, "json", False):
            print(json.dumps(payload, indent=2))
        else:
            print(
                f"{source_id}: {status} (current {current_ref} → remote {remote_ref})"
            )


def unlink_bundles_from_source(registry: dict, source_id: str) -> list[str]:
    """Drop the `source` link from every bundle following ``source_id``."""
    import hub
    bundles = registry.get("bundles") if isinstance(registry, dict) else None
    unlinked = hub.linked_bundle_names(registry, source_id)
    if isinstance(bundles, dict):
        for name in unlinked:
            bundles[name].pop("source", None)
    return unlinked


@registry_mutation("source-sync")
def cmd_source_sync(args):
    """`hub source sync <id>` — pull, rescan, update metadata, classify deltas.

    A first-class registry mutation: it registers newly-arrived upstream skills
    and rewrites the membership of every bundle that follows the source, so it
    carries the same audit record + outer lock as the other mutating verbs (the
    lock is re-entrant, so the inner `data_home_lock()` stays a no-op).
    """
    import hub
    source_id = args.id
    with data_home_lock():
        registry = hub_core.load_registry()
        cfg = _require_configured_git_source(registry, source_id)
        checkout = Path(cfg.get("cache") or str(hub.source_worktree_dir(source_id)))
        if not checkout.exists():
            fail(f"source '{source_id}' cache missing at {checkout}; remove and re-add")

        fetch = _git_fetch(checkout, cfg.get("branch"))
        if not fetch["ok"]:
            cfg["status"] = hub.SOURCE_STATUS_ERROR
            cfg["error"] = fetch["error"]
            cfg["last_checked_at"] = _now_iso()
            hub_core.save_registry(registry)
            payload = {"ok": False, "source_id": source_id, "error": fetch["error"]}
            if getattr(args, "json", False):
                print(json.dumps(payload))
                sys.stdout.flush()
            else:
                print(f"{c('error', RED)}: {fetch['error']}", file=sys.stderr)
            sys.exit(1)

        co = _git_checkout_fetched(checkout)
        if not co["ok"]:
            cfg["status"] = hub.SOURCE_STATUS_ERROR
            cfg["error"] = co["error"]
            hub_core.save_registry(registry)
            payload = {"ok": False, "source_id": source_id, "error": co["error"]}
            if getattr(args, "json", False):
                print(json.dumps(payload))
                sys.stdout.flush()
            else:
                print(f"{c('error', RED)}: {co['error']}", file=sys.stderr)
            sys.exit(1)

        new_ref = co["ref"]
        raw_path = cfg.get("path") or ""
        upstream_candidates = discover_candidates(checkout, raw_path)
        upstream_by_name = {c["name"]: c for c in upstream_candidates}
        upstream_by_path = {c["origin_path"]: c for c in upstream_candidates}

        skills_block = registry.setdefault("skills", {})
        owned_now = {
            name: scfg
            for name, scfg in skills_block.items()
            if isinstance(scfg, dict)
            and isinstance(scfg.get("origin"), dict)
            and scfg["origin"].get("source") == source_id
        }

        # Match owned skills to upstream candidates by origin path first (the
        # registry key can differ from the frontmatter name, e.g. suffix-registered
        # conflict copies), falling back to name for skills that moved dirs upstream.
        matched: dict[str, dict] = {}
        claimed_ids: set[int] = set()
        for name, scfg in owned_now.items():
            cand = upstream_by_path.get((scfg.get("origin") or {}).get("path"))
            if cand is not None:
                matched[name] = cand
                claimed_ids.add(id(cand))
        for name, scfg in owned_now.items():
            if name in matched:
                continue
            cand = upstream_by_name.get(name)
            if cand is not None and id(cand) not in claimed_ids:
                matched[name] = cand
                claimed_ids.add(id(cand))

        added: list[str] = []
        changed: list[str] = []
        removed: list[str] = []
        unchanged: list[str] = []

        # Update / classify still-present and removed skills.
        for name, scfg in owned_now.items():
            if name in matched:
                cand = matched[name]
                old_desc = scfg.get("description")
                old_version = scfg.get("version")
                old_path = (scfg.get("origin") or {}).get("path")
                if (
                    old_desc != cand.get("description")
                    or old_version != cand.get("version")
                    or old_path != cand["origin_path"]
                ):
                    scfg["description"] = cand.get("description") or ""
                    scfg["version"] = cand.get("version") or "1.0.0"
                    origin = scfg.setdefault("origin", {})
                    origin["source"] = source_id
                    origin["source_type"] = "git"
                    origin["path"] = cand["origin_path"]
                    origin["ref"] = new_ref
                    scfg["source"] = (
                        str(checkout / cand["origin_path"])
                        if cand["origin_path"]
                        else str(checkout)
                    )
                    scfg.pop("source_missing", None)
                    changed.append(name)
                else:
                    origin = scfg.setdefault("origin", {})
                    origin["ref"] = new_ref
                    scfg.pop("source_missing", None)
                    unchanged.append(name)
            else:
                # Removed upstream — do NOT delete. Mark as source-missing for UI resolution.
                scfg["source_missing"] = True
                removed.append(name)

        # Classify upstream-new candidates. NEW ones are REGISTERED with the same
        # entry shape `hub source add` writes; CONFLICT/INVALID are never touched
        # and stay in `new_pending` for explicit UI resolution.
        new_pending: list[dict] = []
        registered: list[str] = []
        excluded: list[str] = []
        # A curated source carries an `include:` filter (written by a subset
        # selection at add time, or by `hub source edit --include`). Candidates
        # outside it are never auto-registered — they are reported instead, so
        # the exclusion is visible rather than a silent no-op. Skills the source
        # ALREADY owns are matched/claimed above and are unaffected.
        #
        # Classify FIRST, filter after: the filter's whole job is to decide what
        # gets auto-registered, and only a NEW candidate is ever auto-registered.
        # A CONFLICT still needs explicit resolution and an INVALID name still
        # needs reporting, so both keep flowing to `new_pending` untouched —
        # gating before classification would silence them and mislabel an
        # unusable name as a deliberate exclusion.
        include = hub.source_include_names(cfg)
        for cand in upstream_candidates:
            if id(cand) in claimed_ids or cand["name"] in owned_now:
                continue
            # Reuse classification against current registry (might collide with local skills).
            classified = classify_candidates([cand], registry, source_id)[0]
            if classified["category"] == "NEW":
                if include is not None and cand["name"] not in include:
                    excluded.append(cand["name"])
                    continue
                skills_block[cand["name"]] = build_source_skill_entry(
                    cand,
                    source_id=source_id,
                    checkout=checkout,
                    ref=new_ref,
                    upstream=cfg.get("url"),
                )
                registered.append(cand["name"])
                added.append(cand["name"])
                continue
            new_pending.append(classified)

        # Linked bundles follow the source: reconcile their membership against
        # what the source owns now (post-registration, post source_missing flags).
        bundle_updates = hub.reconcile_linked_bundles(registry, source_id)

        cfg["current_ref"] = new_ref
        cfg["remote_ref"] = fetch["remote_ref"]
        cfg["status"] = hub.SOURCE_STATUS_UP_TO_DATE
        cfg["error"] = None
        cfg["last_checked_at"] = _now_iso()
        cfg["last_synced_at"] = _now_iso()
        hub_core.save_registry(registry)

        payload = {
            "ok": True,
            "source_id": source_id,
            "ref": new_ref,
            "added": added,
            "changed": changed,
            "removed_upstream": removed,
            "unchanged": unchanged,
            "new_pending": new_pending,
            "excluded": excluded,
            "bundle_updates": bundle_updates,
            "needs_hub_sync": bool(changed or removed or registered or bundle_updates),
        }
        # Payload FIRST, on ONE line: the auto-sync below writes chatter to the
        # same stdout, so consumers must be able to read the first line and stop.
        if getattr(args, "json", False):
            print(json.dumps(payload))
        else:
            print(f"synced '{source_id}' → {new_ref}")
            print(f"  +new      {added}")
            print(f"  ~changed  {changed}")
            print(f"  -removed  {removed}")
            if excluded:
                print(f"  ⊘excluded {excluded} (not in this source's include filter)")
            for upd in bundle_updates:
                print(
                    f"  ⇄ bundle {upd['bundle']}: +{upd['added']} -{upd['removed']}"
                )
        sys.stdout.flush()

        # Registrations and linked-bundle membership changes alter the loadout,
        # so they must reach project symlinks without a manual `hub sync` —
        # same convention every other registry mutation follows.
        if registered or bundle_updates:
            hub._auto_sync()


def _source_remove_impact(registry: dict, source_id: str) -> dict:
    """Compute blast-radius preview for a source removal."""
    import hub
    skills_block = registry.get("skills") or {}
    owned = []
    if isinstance(skills_block, dict):
        for name, scfg in skills_block.items():
            if not isinstance(scfg, dict):
                continue
            origin = scfg.get("origin") if isinstance(scfg.get("origin"), dict) else {}
            if origin.get("source") == source_id:
                owned.append(name)

    owned_set = set(owned)
    bundles_block = registry.get("bundles") if isinstance(registry, dict) else None
    affected_bundles: list[dict] = []
    if isinstance(bundles_block, dict):
        for bname, bcfg in bundles_block.items():
            if not isinstance(bcfg, dict):
                continue
            bskills = bcfg.get("skills") or []
            hit = [s for s in bskills if s in owned_set]
            if hit:
                affected_bundles.append({"name": bname, "skills": hit})

    projects_block = registry.get("projects") if isinstance(registry, dict) else None
    affected_projects: list[dict] = []
    if isinstance(projects_block, dict):
        bundles_for_lookup = bundles_block or {}
        for pname, pcfg in projects_block.items():
            if not isinstance(pcfg, dict):
                continue
            enabled = [s for s in (pcfg.get("enabled") or []) if s in owned_set]
            via_bundles: list[dict] = []
            for bname in pcfg.get("bundles") or []:
                bdef = (
                    bundles_for_lookup.get(bname)
                    if isinstance(bundles_for_lookup, dict)
                    else None
                )
                if isinstance(bdef, dict):
                    bhit = [s for s in (bdef.get("skills") or []) if s in owned_set]
                    if bhit:
                        via_bundles.append({"bundle": bname, "skills": bhit})
            if enabled or via_bundles:
                affected_projects.append(
                    {
                        "name": pname,
                        "enabled": enabled,
                        "via_bundles": via_bundles,
                    }
                )

    return {
        "source_id": source_id,
        "owned_skills": owned,
        "affected_bundles": affected_bundles,
        "affected_projects": affected_projects,
        "unlinked_bundles": hub.linked_bundle_names(registry, source_id),
        "generated_links_refresh": [p["name"] for p in affected_projects],
    }


def _apply_source_remove_unequip(
    registry: dict, source_id: str, owned: list[str]
) -> None:
    """In-place mutation: drop owned skills + scrub bundles/projects + drop source."""
    from skill_hub.infrastructure.mcp import mcp_probe

    unlink_bundles_from_source(registry, source_id)
    skills_block = registry.get("skills") or {}
    for name in owned:
        cfg = skills_block.get(name)
        if isinstance(cfg, dict) and cfg.get("type") == "mcp-server":
            # plans/G.md §5.13: every removal path deletes the capability
            # catalogue AND the probe-cache row together, so a summary can
            # never outlive the server it described. This path pops the skill
            # directly instead of going through `cmd_archive`, so it needs its
            # own call. §5.13 originally misnamed this path a `source_missing`
            # drop; `source_missing` is only a FLAG on a still-registered
            # skill (`hub source dropped` is read-only and `recover` KEEPS the
            # skill). Removing the SOURCE is what actually deletes an owned
            # server.
            mcp_probe.forget_server(name)
        skills_block.pop(name, None)
    bundles_block = registry.get("bundles") or {}
    if isinstance(bundles_block, dict):
        for bcfg in bundles_block.values():
            if not isinstance(bcfg, dict):
                continue
            bskills = bcfg.get("skills") or []
            bcfg["skills"] = [s for s in bskills if s not in owned]
    projects_block = registry.get("projects") or {}
    if isinstance(projects_block, dict):
        for pcfg in projects_block.values():
            if not isinstance(pcfg, dict):
                continue
            enabled = pcfg.get("enabled") or []
            pcfg["enabled"] = [s for s in enabled if s not in owned]
    sources_block = registry.get("sources") or {}
    if isinstance(sources_block, dict):
        sources_block.pop(source_id, None)


def _keep_local_src(scfg: dict, checkout: Path) -> Path:
    """Where an owned skill's files live inside the source checkout."""
    origin = scfg.get("origin") if isinstance(scfg.get("origin"), dict) else {}
    rel = origin.get("path") or ""
    return checkout / rel if rel else checkout


def _precheck_keep_local_names(
    skills_block: dict, owned: list[str], checkout: Path
) -> None:
    """Refuse the whole keep-local BEFORE copying anything when some skill's
    SKILL.md cannot be made to agree with its registry key.

    A suffix-registered skill (`qa-2` whose upstream says `name: qa`) is legal
    only while its files stay source-managed — the sync path patches the name
    into a rename VARIANT and never touches the checkout. Copying it into
    `skills/` makes it hub-owned, where a key/name mismatch is the fatal
    `validate_registry_skills` error with no escape hatch. So the copy must
    rewrite the name, and a file whose name line cannot be rewritten must stop
    the operation while everything is still intact (the checkout is deleted only
    after this returns).
    """
    import hub
    blockers: list[str] = []
    for name in owned:
        scfg = skills_block.get(name)
        if not isinstance(scfg, dict) or scfg.get("type") == "mcp-server":
            continue
        src = _keep_local_src(scfg, checkout)
        skill_md = src / "SKILL.md"
        if not skill_md.is_file():
            continue
        try:
            text = skill_md.read_text()
        except OSError as exc:
            blockers.append(f"{name}: cannot read {skill_md} ({exc})")
            continue
        meta = hub.parse_frontmatter_text(text)
        upstream = str((meta or {}).get("name") or "").strip()
        if not upstream or upstream == name:
            continue
        if hub.rewrite_frontmatter_name(text, name) is None:
            blockers.append(
                f"{name}: upstream SKILL.md declares '{upstream}' and its "
                f"`name:` line cannot be rewritten ({skill_md})"
            )
    if blockers:
        fail(
            "keep-local would leave the registry unsyncable — a hub-owned skill "
            "whose SKILL.md name disagrees with its key fails validation:\n  - "
            + "\n  - ".join(blockers)
            + "\n\nFix the file(s), or re-run with `--mode unequip`. "
            "Nothing was changed."
        )


def _apply_source_remove_keep_local(
    registry: dict, source_id: str, owned: list[str], checkout: Path
) -> list[dict]:
    """Copy owned skills into data-home/skills/ and repoint registry entries.

    Returns a list of {"name", "new_path"} actions that were performed.
    """
    import hub
    # The bundles keep their membership, but nothing manages it any more.
    unlink_bundles_from_source(registry, source_id)
    skills_block = registry.get("skills") or {}
    moves: list[dict] = []
    data_skills = hub.hub_skills_dir()
    data_skills.mkdir(parents=True, exist_ok=True)
    _precheck_keep_local_names(skills_block, owned, checkout)
    for name in owned:
        scfg = skills_block.get(name)
        if not isinstance(scfg, dict):
            continue
        origin = scfg.get("origin") if isinstance(scfg.get("origin"), dict) else {}
        rel = origin.get("path") or ""
        src = checkout / rel if rel else checkout
        if not src.exists():
            # Source missing — leave the entry alone but clear origin and mark local.
            scfg["managed"] = "local"
            scfg.pop("origin", None)
            moves.append(
                {
                    "name": name,
                    "new_path": str(scfg.get("source")),
                    "warning": "source missing; metadata preserved but no copy",
                }
            )
            continue
        dest = data_skills / name
        if dest.exists():
            # Collision: skip the copy, but still clear origin so the entry no
            # longer claims external ownership. Caller can resolve manually.
            scfg["managed"] = "local"
            scfg.pop("origin", None)
            scfg.pop("source_missing", None)
            moves.append(
                {
                    "name": name,
                    "new_path": str(dest),
                    "warning": "destination already exists; kept existing",
                }
            )
            continue
        shutil.copytree(src, dest, symlinks=True)
        # The copy is now HUB-OWNED, so its frontmatter name must equal the
        # registry key (the rename-variant escape hatch only exists for
        # source-managed files). Pre-checked above; still fail-closed here.
        rename_warning = _align_copied_skill_name(dest, name)
        if rename_warning is not None:
            shutil.rmtree(dest, ignore_errors=True)
            moves.append(
                {"name": name, "new_path": str(src), "warning": rename_warning}
            )
            continue
        scfg["source"] = str(dest)
        scfg["managed"] = "local"
        scfg.pop("origin", None)
        scfg.pop("source_missing", None)
        moves.append({"name": name, "new_path": str(dest)})
    sources_block = registry.get("sources") or {}
    if isinstance(sources_block, dict):
        sources_block.pop(source_id, None)
    return moves


def _align_copied_skill_name(dest: Path, name: str) -> Optional[str]:
    """Make a freshly copied skill's SKILL.md declare `name`. None on success,
    else a warning string (the caller undoes the copy)."""
    import hub
    skill_md = dest / "SKILL.md"
    if not skill_md.is_file():
        return None
    try:
        text = skill_md.read_text()
    except OSError as exc:
        return f"could not read the copied SKILL.md ({exc}); keep-local skipped"
    meta = hub.parse_frontmatter_text(text)
    upstream = str((meta or {}).get("name") or "").strip()
    if not upstream or upstream == name:
        return None
    rewritten = hub.rewrite_frontmatter_name(text, name)
    if rewritten is None:
        return (
            f"SKILL.md declares '{upstream}' and its `name:` line cannot be "
            f"rewritten to '{name}'; keep-local skipped for this skill"
        )
    try:
        skill_md.write_text(rewritten)
    except OSError as exc:
        return f"could not rewrite the copied SKILL.md ({exc}); keep-local skipped"
    return None


def cmd_source_remove(args):
    """`hub source remove <id>` — dry-run preview, or apply unequip / keep-local."""
    import hub
    source_id = args.id
    with data_home_lock():
        registry = hub_core.load_registry()
        _require_configured_git_source(registry, source_id)
        impact = _source_remove_impact(registry, source_id)

        if args.dry_run:
            payload = {"ok": True, "preview": True, "impact": impact}
            if getattr(args, "json", False):
                print(json.dumps(payload, indent=2))
            else:
                print(f"would remove source '{source_id}':")
                print(f"  owned skills:    {impact['owned_skills']}")
                print(
                    f"  bundles:         {[b['name'] for b in impact['affected_bundles']]}"
                )
                if impact["unlinked_bundles"]:
                    print(
                        f"  would unlink:    {impact['unlinked_bundles']} "
                        f"(stop following this source)"
                    )
                print(
                    f"  projects:        {[p['name'] for p in impact['affected_projects']]}"
                )
            return

        mode = args.mode or "unequip"
        if mode not in {"unequip", "keep-local"}:
            fail(f"unknown remove mode '{mode}'. Use 'unequip' or 'keep-local'.")

        cfg = registry["sources"][source_id]
        checkout = Path(cfg.get("cache") or str(hub.source_worktree_dir(source_id)))
        owned = impact["owned_skills"]

        moves: list[dict] = []
        if mode == "keep-local":
            moves = _apply_source_remove_keep_local(
                registry, source_id, owned, checkout
            )
        else:
            _apply_source_remove_unequip(registry, source_id, owned)

        # Atomic mutation order: registry write first; cache deletion only if
        # the registry write succeeded.
        hub_core.save_registry(registry)

        cache_root = hub.source_cache_dir(source_id)
        if cache_root.exists():
            shutil.rmtree(cache_root, ignore_errors=True)

        payload = {
            "ok": True,
            "preview": False,
            "mode": mode,
            "impact": impact,
            "moves": moves,
            "needs_hub_sync": True,
        }
        if getattr(args, "json", False):
            print(json.dumps(payload, indent=2))
        else:
            print(f"removed source '{source_id}' (mode={mode})")
            if impact["unlinked_bundles"]:
                print(
                    f"  unlinked bundles: {', '.join(impact['unlinked_bundles'])} "
                    f"(no longer follow this source)"
                )
            for m in moves:
                print(f"  → {m['name']}: {m['new_path']}")


def cmd_source_duplicate(args):
    """`hub source duplicate <skill-name> [--as <new-name>]` — copy an external
    or starter skill into the data-home local skills/ directory and re-register
    it as ``managed: local`` with no origin.

    The original external entry is left intact unless ``--replace`` is passed
    (not implemented in V1; users keep both side-by-side).
    """
    import hub
    source_skill_name = args.name
    new_name = args.new_name or f"{source_skill_name}-local"
    validate_slug(new_name, "new skill name")

    with data_home_lock():
        registry = hub_core.load_registry()
        skills_block = registry.get("skills") or {}
        if source_skill_name not in skills_block:
            fail(f"skill '{source_skill_name}' not found")
        original = skills_block[source_skill_name]
        if not isinstance(original, dict):
            fail(f"skill '{source_skill_name}' has invalid configuration")

        # Only duplicate things that are actually read-only.
        info = hub.infer_skill_ownership(source_skill_name, original)
        if info["managed"] not in {"external", "starter"}:
            fail(
                f"skill '{source_skill_name}' is already managed: {info['managed']}; "
                "duplicate is only valid for external/starter skills"
            )

        if new_name in skills_block:
            fail(f"skill '{new_name}' already exists; pass --as <unique-slug>")

        src = Path(str(original.get("source", ""))).expanduser()
        if not src.exists():
            fail(f"source files missing at {src}; cannot duplicate")

        dest = hub.hub_skills_dir() / new_name
        if dest.exists():
            fail(f"destination already exists: {dest}")
        hub.hub_skills_dir().mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, dest, symlinks=True)

        # Rewrite the SKILL.md frontmatter name so it matches the new registry key.
        skill_md = dest / "SKILL.md"
        if skill_md.exists():
            try:
                text = skill_md.read_text()
                if text.lstrip().startswith("---"):
                    parts = text.split("---", 2)
                    if len(parts) >= 3:
                        meta = yaml.safe_load(parts[1]) or {}
                        if isinstance(meta, dict):
                            meta["name"] = new_name
                            new_front = (
                                yaml.safe_dump(
                                    meta, default_flow_style=False, sort_keys=False
                                ).rstrip()
                                + "\n"
                            )
                            skill_md.write_text(
                                f"---\n{new_front}---\n{parts[2].lstrip(chr(10))}"
                            )
            except (OSError, yaml.YAMLError):
                pass

        skills_block[new_name] = {
            "version": original.get("version") or "1.0.0",
            "description": original.get("description") or "",
            "source": collapse_home(dest),
            "type": original.get("type") or "claude-skill",
            "scope": original.get("scope") or "portable",
            "upstream": None,
            "managed": "local",
        }
        hub_core.save_registry(registry)

        payload = {
            "ok": True,
            "original": source_skill_name,
            "duplicated_as": new_name,
            "new_source_path": str(dest),
        }
        if getattr(args, "json", False):
            print(json.dumps(payload, indent=2))
        else:
            print(f"duplicated '{source_skill_name}' → '{new_name}' at {dest}")




# ─────────────────────────────────────────────────────────────────────────────
# `hub source dropped` / `hub source recover` — dropped-upstream skills
#
# A `source_missing: true` skill is one `hub source sync` noticed upstream no
# longer has. Its `origin.ref` stays pinned to the last commit where it did
# exist (sync only bumps `ref` for a still-present skill), so the content is
# still recoverable from the source checkout as long as that ref is reachable.
# Everything here is read-only except `cmd_source_recover`; `hub archive` /
# `hub unarchive` (in hub.py) cover the "Forget" / undo half.
# ─────────────────────────────────────────────────────────────────────────────


def _dropped_scan_root(scfg: Optional[dict]) -> str:
    """The pathspec `git diff`/`git archive` scan against — the source's own
    `path:` (its configured scan subdirectory), or the repo root."""
    if not isinstance(scfg, dict):
        return "."
    raw = scfg.get("path") or ""
    return raw or "."


def _dropped_checkout_dir(source_id: str, scfg: Optional[dict]) -> Path:
    import hub

    if isinstance(scfg, dict) and scfg.get("cache"):
        return Path(scfg["cache"])
    return hub.source_worktree_dir(source_id)


def _git_commit_time(checkout: Path, ref: str) -> Optional[str]:
    """`git log -1 --format=%cI <ref>` — ISO-8601 commit time, or None on any
    failure (unreachable ref, missing checkout, git not on PATH, timeout).
    Never raises."""
    try:
        res = _run_git(["log", "-1", "--format=%cI", ref, "--"], cwd=checkout, timeout=30)
    except (subprocess.TimeoutExpired, OSError):
        return None
    if res.returncode != 0:
        return None
    out = res.stdout.strip()
    return out or None


# `-M50%` is used for RENAME DETECTION only — git will pair a deleted file
# with any similar-enough added one at that threshold, including two
# genuinely unrelated skills that happen to share boilerplate. A pairing only
# becomes a reported "renamed" successor at/above this similarity; a weaker
# one (still detected, just not trusted) is a "possible_successor" alongside
# a "deleted" reason (see `_dropped_skills_for_registry`).
RENAME_SIMILARITY_THRESHOLD = 70

_RENAME_STATUS_RE = re.compile(r"^R(\d+)$")


def _git_rename_events(
    checkout: Path, ref: str, scan_root: str
) -> Optional[list[tuple[str, str, int]]]:
    """Every rename `git log` records between `ref` (exclusive) and `HEAD`,
    oldest first, restricted to `scan_root`. One call per (source, ref) group.

    PER-COMMIT rename detection — `git log --diff-filter=R -M50% --name-status
    --format=%H <ref>..HEAD` — scores far better than one wide tree diff
    across the whole range (the earlier approach here): content keeps
    drifting between the commit that did the rename and HEAD, and a
    tree-to-tree comparison measures similarity against however far that
    drift has gone, not against the rename itself. On real data, a genuine
    `diagnose` → `diagnosing-bugs` rename scored ~52% as a HEAD-relative tree
    diff but scores 97% at the actual commit that renamed it.

    `--format=%H` interleaves a bare 40-hex-char commit-hash line before each
    commit's renames; it never matches the `R<nn>` status pattern below, so it
    is silently skipped rather than needing separate handling.

    Returns `(old_path, new_path, similarity)` tuples in chronological order
    (renames within one commit keep git's own listed order), or None when git
    could not be run — the caller degrades the whole group to "unknown".
    """
    try:
        res = _run_git(
            [
                "log",
                "--reverse",
                "--diff-filter=R",
                "-M50%",
                "--name-status",
                "--format=%H",
                f"{ref}..HEAD",
                "--",
                scan_root,
            ],
            cwd=checkout,
            timeout=60,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if res.returncode != 0:
        return None
    events: list[tuple[str, str, int]] = []
    for line in res.stdout.splitlines():
        if not line.strip():
            continue
        fields = line.split("\t")
        m = _RENAME_STATUS_RE.match(fields[0])
        if m and len(fields) >= 3:
            events.append((fields[1], fields[2], int(m.group(1))))
    return events


def _follow_rename_chain(
    events: list[tuple[str, str, int]], start_path: str
) -> Optional[tuple[str, int]]:
    """Follow a chronological rename chain starting at `start_path`.

    A skill renamed more than once (`a` → `b` → `c`) needs the FIRST commit
    that renames it for the successor's similarity score (per spec: later
    hops may report a much higher or lower score against an already-renamed
    file, which says nothing about how confident the ORIGINAL rename was) but
    the LAST path in the chain for where the content actually lives now.

    Returns `(final_path, first_hop_similarity)`, or None when `start_path`
    was never the OLD side of any recorded rename — "no rename detected",
    the plain "deleted" case, as opposed to "renamed, and the successor was
    later deleted too" (which the caller detects separately by checking
    whether `final_path` still exists at HEAD).
    """
    current = start_path
    first_hop_score: Optional[int] = None
    search_from = 0
    seen = {current}
    while True:
        hop = next(
            (
                (i, new_path, score)
                for i, (old_path, new_path, score) in enumerate(events[search_from:], start=search_from)
                if old_path == current
            ),
            None,
        )
        if hop is None:
            break
        i, new_path, score = hop
        if first_hop_score is None:
            first_hop_score = score
        if new_path in seen:
            break  # a rename cycle should never happen in real history
        current = new_path
        seen.add(current)
        search_from = i + 1
    if first_hop_score is None:
        return None
    return current, first_hop_score


def _git_cat_file_exists(checkout: Path, ref: str, rel_path: str) -> bool:
    """`git cat-file -e <ref>:<rel_path>` — True iff the blob exists. Never raises."""
    try:
        res = _run_git(["cat-file", "-e", f"{ref}:{rel_path}"], cwd=checkout, timeout=30)
    except (subprocess.TimeoutExpired, OSError):
        return False
    return res.returncode == 0


def _git_show_text(checkout: Path, ref: str, rel_path: str) -> Optional[str]:
    """`git show <ref>:<rel_path>` as text, or None on any failure. Never raises."""
    try:
        res = _run_git(["show", f"{ref}:{rel_path}"], cwd=checkout, timeout=30)
    except (subprocess.TimeoutExpired, OSError):
        return None
    if res.returncode != 0:
        return None
    return res.stdout


def _git_archive_extract(checkout: Path, ref: str, path: str, dest_dir: Path) -> Optional[str]:
    """Extract `<path>` at `<ref>` from `checkout` into `dest_dir`.

    Goes through `git archive` piped into `tarfile` (never a shell pipe, never
    `_run_git`'s text-mode capture) so a binary file in the skill directory
    survives intact, then through `hub._safe_extract` (the same hardened
    extractall the self-updater uses: the 3.12+ "data" filter, or a manual
    path-traversal check on older Python) — a source checkout is a THIRD-PARTY
    repo, and a raw `extractall` trusts every member's path and any symlink it
    contains. `dest_dir` must already be an empty directory dedicated to this
    extraction (never the bare TemporaryDirectory root — see the caller).
    Returns an error string on any failure, else None; never raises — the
    caller (`cmd_source_recover`) turns a non-None return into a clean `fail()`.
    """
    import hub

    env = os.environ.copy()
    env.update(_GIT_NONINTERACTIVE_ENV)
    try:
        proc = subprocess.run(
            ["git", "-C", str(checkout), "archive", "--format=tar", ref, "--", path],
            capture_output=True,
            env=env,
            timeout=120,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        return f"git archive failed: {exc}"
    if proc.returncode != 0:
        return (proc.stderr or b"git archive failed").decode(errors="replace").strip()
    try:
        with tarfile.open(fileobj=io.BytesIO(proc.stdout)) as tar:
            hub._safe_extract(tar, dest_dir)
    except (tarfile.TarError, RuntimeError) as exc:
        return f"could not extract archived content: {exc}"
    return None


def _find_registered_by_origin(skills_block: dict, source_id: Optional[str], path: str) -> Optional[str]:
    """The registry key whose `origin.source`/`origin.path` matches, else None."""
    for name, cfg in skills_block.items():
        if not isinstance(cfg, dict):
            continue
        origin = cfg.get("origin") if isinstance(cfg.get("origin"), dict) else None
        if not origin:
            continue
        if origin.get("source") == source_id and origin.get("path") == path:
            return name
    return None


def _dropped_equipped(registry: dict, name: str) -> dict:
    """The four equip-model holders (+ invocation overrides folded into
    projects) that still reference a dropped skill's name."""
    import hub

    sites = hub._skill_reference_sites(registry, name)
    projects = sorted(set(sites.get("projects", [])) | set(sites.get("invocation_overrides", [])))
    return {
        "projects": projects,
        "bundles": sites.get("bundles", []),
        "remotes": sites.get("remotes", []),
        "cloud": sites.get("cloud", []),
    }


def _dropped_skills_for_registry(
    registry: dict,
    source_filter: Optional[str],
    skill_filter: Optional[str],
    want_content: bool,
) -> list[dict]:
    import hub

    skills_block = registry.get("skills") if isinstance(registry.get("skills"), dict) else {}
    sources_block = registry.get("sources") if isinstance(registry.get("sources"), dict) else {}

    # Group by (source, ref) — NOT by source alone. A skill's `origin.ref` is
    # "the last commit where it was verified present" (see the module
    # docstring), and different skills in the same source can carry different
    # refs when they were dropped in different sync passes. Picking one
    # "oldest ref in the source" as a shared diff base misclassifies: a skill
    # ADDED upstream after that oldest ref, and later renamed, never appears
    # on the LEFT side of a diff based on that earlier ref, so a real rename
    # reads as a deletion. Grouping by the exact ref instead means every diff
    # call is scoped to a commit where every skill in that call's group is
    # provably present. Simultaneous drops (the common case) still share one
    # ref and cost one diff call; only a source whose drops are spread across
    # several distinct sync passes costs more than one — still bounded by the
    # number of distinct refs, never by the number of skills.
    groups: dict[tuple[Optional[str], Optional[str]], list[str]] = {}
    for name, cfg in skills_block.items():
        if not isinstance(cfg, dict) or not cfg.get("source_missing"):
            continue
        if skill_filter and name != skill_filter:
            continue
        origin = cfg.get("origin") if isinstance(cfg.get("origin"), dict) else {}
        sid = origin.get("source")
        if source_filter and sid != source_filter:
            continue
        ref = origin.get("ref")
        groups.setdefault((sid, ref), []).append(name)

    results: list[dict] = []
    for (sid, ref), names in groups.items():
        scfg = (
            sources_block.get(sid)
            if isinstance(sid, str) and isinstance(sources_block, dict)
            else None
        )
        checkout = _dropped_checkout_dir(sid, scfg) if isinstance(sid, str) else None
        checkout_exists = bool(checkout is not None and checkout.exists())
        scan_root = _dropped_scan_root(scfg)
        source_name = (scfg.get("name") if isinstance(scfg, dict) else None) or sid

        last_seen_at = _git_commit_time(checkout, ref) if (checkout_exists and ref) else None
        rename_events = (
            _git_rename_events(checkout, ref, scan_root)
            if (checkout_exists and ref and last_seen_at is not None)
            else None
        )

        for name in names:
            cfg = skills_block[name]
            origin = cfg.get("origin") if isinstance(cfg.get("origin"), dict) else {}
            path = origin.get("path") or ""

            entry: dict = {
                "name": name,
                "source": sid,
                "source_name": source_name,
                "path": path,
                "ref": ref,
                "ref_short": ref[:7] if isinstance(ref, str) else None,
                "last_seen_at": None,
                "reason": "unknown",
                "successor": None,
                "possible_successor": None,
                "equipped": _dropped_equipped(registry, name),
                "recoverable": False,
                "skill_md": None,
            }

            if not checkout_exists or not ref:
                results.append(entry)
                continue

            skill_md_rel = f"{path}/SKILL.md" if path else "SKILL.md"
            entry["last_seen_at"] = last_seen_at
            entry["recoverable"] = _git_cat_file_exists(checkout, ref, skill_md_rel)

            if rename_events is None or last_seen_at is None:
                # git could not be trusted for this ref — degrade to
                # "unknown" rather than guessing renamed/deleted.
                results.append(entry)
                continue

            chain = _follow_rename_chain(rename_events, skill_md_rel)
            if chain is None:
                entry["reason"] = "deleted"
            else:
                final_path, score = chain
                if not _git_cat_file_exists(checkout, "HEAD", final_path):
                    # Renamed at least once, but whatever it became was
                    # itself deleted later — there is no live successor to
                    # point at, confirmed or otherwise.
                    entry["reason"] = "deleted"
                else:
                    parent = Path(final_path).parent
                    # "" (not ".") is this codebase's spelling of "repo
                    # root" — matches `origin.path`'s own convention.
                    successor_dir = "" if str(parent) == "." else str(parent)
                    successor_name = None
                    text = _git_show_text(checkout, "HEAD", final_path)
                    if text:
                        meta = hub.parse_frontmatter_text(text)
                        if isinstance(meta, dict) and meta.get("name"):
                            successor_name = str(meta["name"]).strip()
                    if not successor_name:
                        # A SKILL.md that moved to the repo root has no
                        # dirname to fall back to (Path("").name == "") —
                        # name it after the source instead of showing "".
                        successor_name = Path(successor_dir).name or source_name or sid or "unknown"
                    successor = {
                        "path": successor_dir,
                        "name": successor_name,
                        "registered_as": _find_registered_by_origin(skills_block, sid, successor_dir),
                        "similarity": score,
                    }
                    if score >= RENAME_SIMILARITY_THRESHOLD:
                        entry["reason"] = "renamed"
                        entry["successor"] = successor
                    else:
                        # Detected, but too weak a pairing to trust — likely
                        # two unrelated skills, not a rename. A hint, not a
                        # fact.
                        entry["reason"] = "deleted"
                        entry["possible_successor"] = successor

            if want_content:
                entry["skill_md"] = _git_show_text(checkout, ref, skill_md_rel)

            results.append(entry)

    results.sort(key=lambda e: e["name"])
    return results


def cmd_source_dropped(args):
    """`hub source dropped [SOURCE_ID] [--skill NAME] [--content] [--json]` —
    read-only listing of every `source_missing` skill, classified renamed /
    deleted / unknown. Never mutates, never syncs."""
    registry = hub_core.load_registry()
    source_filter = getattr(args, "id", None)
    skill_filter = getattr(args, "skill", None)
    want_content = bool(getattr(args, "content", False))

    skills = _dropped_skills_for_registry(registry, source_filter, skill_filter, want_content)
    payload = {"ok": True, "skills": skills}
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2, sort_keys=False))
        return

    if not skills:
        print("No dropped-upstream skills.")
        return
    header = f"{'NAME':24} {'SOURCE':16} {'REASON':10} SUCCESSOR"
    print(c(header, BOLD))
    for s in skills:
        successor = s.get("successor") or s.get("possible_successor") or {}
        successor_label = successor.get("name") or "—"
        if successor.get("registered_as"):
            successor_label = f"{successor_label} (registered as {successor['registered_as']})"
        elif s.get("possible_successor") and not s.get("successor"):
            successor_label = f"{successor_label} ({successor['similarity']}% similar, unconfirmed)"
        print(f"{s['name']:24} {str(s.get('source') or '—'):16} {s['reason']:10} {successor_label}")


@registry_mutation("source-recover")
def cmd_source_recover(args):
    """`hub source recover <name>` — Keep as local: restore a dropped-upstream
    skill's pinned-ref content into `<data_home>/skills/<name>` as a
    `managed: local` skill. Same entry shape as `cmd_source_duplicate`."""
    import hub

    name = args.name
    with data_home_lock():
        registry = hub_core.load_registry()
        skills_block = registry.get("skills") or {}
        if name not in skills_block:
            fail(f"skill '{name}' not found")
        cfg = skills_block[name]
        if not isinstance(cfg, dict):
            fail(f"skill '{name}' has invalid configuration")
        if not cfg.get("source_missing"):
            fail(f"skill '{name}' is not dropped upstream (source_missing is not set)")

        origin = cfg.get("origin") if isinstance(cfg.get("origin"), dict) else {}
        source_id = origin.get("source")
        ref = origin.get("ref")
        path = origin.get("path") or ""
        if not source_id or not ref:
            fail(f"skill '{name}' has no recoverable origin (missing source/ref)")

        sources_block = registry.get("sources") or {}
        scfg = sources_block.get(source_id) if isinstance(sources_block, dict) else None
        checkout = _dropped_checkout_dir(source_id, scfg)
        if not checkout.exists():
            fail(f"source '{source_id}' checkout is missing at {checkout}; cannot recover")

        rel_skill_md = f"{path}/SKILL.md" if path else "SKILL.md"
        if not _git_cat_file_exists(checkout, ref, rel_skill_md):
            fail(f"skill '{name}' is not recoverable — {rel_skill_md} is gone at {ref[:7]}")

        dest = hub.hub_skills_dir() / name
        if dest.exists():
            fail(f"destination already exists: {dest}")

        with tempfile.TemporaryDirectory() as tmp:
            # A dedicated subdirectory, never the bare TemporaryDirectory root:
            # a repo-root skill (`path == ""`) would otherwise have `extracted
            # == tmp_path`, and moving that out from under the `with` block
            # yanks away the very directory the context manager expects to
            # clean up on exit.
            extract_root = Path(tmp) / "extracted"
            extract_root.mkdir()
            archive_path = path or "."
            err = _git_archive_extract(checkout, ref, archive_path, extract_root)
            if err:
                fail(f"could not recover '{name}': {err}")
            extracted = extract_root / path if path else extract_root
            if not extracted.is_dir():
                fail(f"could not recover '{name}': extracted content missing at {extracted}")
            hub.hub_skills_dir().mkdir(parents=True, exist_ok=True)
            shutil.move(str(extracted), str(dest))

        # `dest` is now hub-owned, so its frontmatter name must equal the
        # registry key — fail-closed, undoing the copy (mirrors keep-local).
        rename_warning = _align_copied_skill_name(dest, name)
        if rename_warning is not None:
            shutil.rmtree(dest, ignore_errors=True)
            fail(f"could not recover '{name}': {rename_warning}")

        cfg["version"] = cfg.get("version") or "1.0.0"
        cfg["description"] = cfg.get("description") or ""
        cfg["source"] = collapse_home(dest)
        cfg["type"] = cfg.get("type") or "claude-skill"
        cfg["scope"] = cfg.get("scope") or "portable"
        cfg["upstream"] = None
        cfg["managed"] = "local"
        cfg.pop("origin", None)
        cfg.pop("source_missing", None)

        hub_core.save_registry(registry)

        payload = {"ok": True, "name": name, "path": str(dest), "ref": ref, "source": source_id}
        if getattr(args, "json", False):
            print(json.dumps(payload, indent=2))
        else:
            print(f"recovered '{name}' as local at {dest}")

        hub._auto_sync()
